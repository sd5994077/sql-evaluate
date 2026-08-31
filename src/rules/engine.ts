import { WHOISACTIVE_COLUMNS } from "../schema";
import type { AnalysisInput, AnalysisReport, BlockingContext, BlockingParticipant, CaptureRecommendation, Confidence, DataQuality, DiagnosticTool, Finding, FindingCapDisclosure, FindingQualification, FindingTimeline, PlanDocument, PlanStatement, RelatedFindingLink, RuleContext, RuleDefinition, Severity, SupplementalEvidenceSource, ThresholdProfileSnapshot, WhoIsActiveRecord } from "../types";
import { parseShowplan } from "../lib/showplan";
import { differenceSeconds, formatDuration, formatNumber, formatTempdbPages, makeId, percentile } from "../lib/utils";
import { REFERENCES } from "./catalog";
import { DEFAULT_THRESHOLD_PROFILE_SNAPSHOT, validateThresholdProfileSnapshotShape } from "./thresholdProfiles";
import { deepAnalysisProfileForFinding } from "../deepAnalysis/profile";

const severityRank: Record<Severity, number> = { Critical: 6, High: 5, Medium: 4, Low: 3, Informational: 2, "Not Evaluated": 1 };
const confidenceRank: Record<Confidence, number> = { High: 3, Medium: 2, Low: 1 };
const specialBlockingOwners: Record<number, { title: string; meaning: string; severity: Severity }> = {
  [-2]: { title: "Orphaned distributed transaction owner (-2) observed", meaning: "The blocking resource is owned by an orphaned distributed transaction.", severity: "Medium" },
  [-3]: { title: "Deferred recovery transaction owner (-3) observed", meaning: "The blocking resource is owned by a deferred recovery transaction.", severity: "Medium" },
  [-4]: { title: "Temporarily unidentified latch owner (-4) observed", meaning: "SQL Server could not identify the latch owner during an internal latch-state transition.", severity: "Informational" },
  [-5]: { title: "Unidentified latch owner (-5) observed", meaning: "SQL Server does not track the owner for this latch type; this value is not a session ID and is not a performance problem by itself.", severity: "Informational" },
};

function finding(ruleId: string, severity: Severity, confidence: Confidence, category: string, title: string, summary: string, overrides: Partial<Finding> = {}): Finding {
  return {
    id: makeId("finding"), ruleId, severity, confidence, category, title, summary,
    explanation: summary, remediation: [], diagnosticTools: [], confidenceReason: `${confidence} confidence based on the supplied evidence.`, limitations: [], relatedFindings: [], evidence: [], references: [], affectedRecordIds: [], affectedPlanIds: [], impact: severityRank[severity], ...overrides,
  };
}

function diagnosticTool(name: string, purpose: string, command?: string, caution?: string): DiagnosticTool {
  return { name, purpose, command, caution };
}

function planContext(statement: PlanStatement): Finding["evidence"] {
  return [{ label: "Statement type", value: statement.statementType }, { label: "Plan evidence", value: statement.isActual ? "Actual plan" : "Estimated plan" }];
}

const SAFE_OPTIMIZER_TOKEN = /^[A-Za-z0-9_.:-]{1,128}$/;
const REDACTED_OPTIMIZER_VALUE = "[redacted optimizer value]";

function optimizerQualificationValue(value: string): string {
  return SAFE_OPTIMIZER_TOKEN.test(value) ? value : REDACTED_OPTIMIZER_VALUE;
}

function planQualifications(statement: PlanStatement, plan: PlanDocument): FindingQualification[] {
  const common = { planId: plan.id, statementId: statement.id };
  const qualifications: FindingQualification[] = [];
  if (statement.compileTimeMs !== null && statement.compileTimeMs !== undefined && Number.isFinite(statement.compileTimeMs) && statement.compileTimeMs >= 0) qualifications.push({ kind: "Compile time", disposition: "Context only", value: `${statement.compileTimeMs} ms`, reason: "Reported by Showplan for this statement; no universal compile-time threshold was evaluated.", ...common });
  if (statement.compileCpuMs !== null && statement.compileCpuMs !== undefined && Number.isFinite(statement.compileCpuMs) && statement.compileCpuMs >= 0) qualifications.push({ kind: "Compile CPU", disposition: "Context only", value: `${statement.compileCpuMs} ms`, reason: "Reported by Showplan for this statement; magnitude alone was not interpreted as CPU pressure.", ...common });
  if (statement.compileMemoryKb !== null && statement.compileMemoryKb !== undefined && Number.isFinite(statement.compileMemoryKb) && statement.compileMemoryKb >= 0) qualifications.push({ kind: "Compile memory", disposition: "Context only", value: `${statement.compileMemoryKb} KB`, reason: "Reported compile memory is context only and is separate from execution workspace memory grants.", ...common });
  if (statement.earlyAbortReason) qualifications.push({ kind: "Optimizer early abort", disposition: "Observed", value: optimizerQualificationValue(statement.earlyAbortReason), reason: "Showplan reported an optimizer early-abort token; its causal significance was not evaluated.", ...common });
  if (statement.optimizationLevel) qualifications.push({ kind: "Optimization level", disposition: "Observed", value: optimizerQualificationValue(statement.optimizationLevel), reason: "Showplan reported an optimization-level token; the value was not ranked or interpreted.", ...common });
  return qualifications;
}

function buildTimeline(metric: string, unit: FindingTimeline["unit"], observations: Array<{ capturedAt: string | null; value: number | null }>): FindingTimeline | undefined {
  const byCapture = new Map<string, number>();
  for (const observation of observations) {
    if (!observation.capturedAt || observation.value === null || !Number.isFinite(observation.value)) continue;
    byCapture.set(observation.capturedAt, Math.max(byCapture.get(observation.capturedAt) ?? Number.NEGATIVE_INFINITY, observation.value));
  }
  const points = [...byCapture.entries()].sort(([left], [right]) => left.localeCompare(right)).slice(-72).map(([capturedAt, value]) => ({ capturedAt, value }));
  if (!points.length) return undefined;
  const firstValue = points[0].value;
  const latestValue = points.at(-1)!.value;
  const direction = points.length === 1 ? "Single observation" : latestValue > firstValue ? "Increasing" : latestValue < firstValue ? "Decreasing" : "Stable";
  return { metric, unit, points, firstValue, latestValue, peakValue: Math.max(...points.map((point) => point.value)), direction };
}

function captureRecommendation(title: string, reason: string, command: string | undefined, expectedEvidence: string[], caution?: string): CaptureRecommendation {
  return { title, reason, command, expectedEvidence, caution };
}

function missingColumns(context: RuleContext, columns: string[]): string[] {
  return columns.filter((column) => !context.presentColumns.has(column));
}

function whoIsActiveCommand(options: string[]): string {
  return `EXEC dbo.sp_WhoIsActive\n    ${options.join(",\n    ")};`;
}

function unavailableCaptureRecommendation(ruleId: string, missing: string[]): CaptureRecommendation {
  const commonReason = `Required evidence was not supplied: ${missing.join(", ")}.`;
  if (ruleId === "WIA-BLOCKING") return captureRecommendation("Capture blocking ownership", commonReason, whoIsActiveCommand(["@get_task_info = 2", "@delta_interval = 5", "@get_locks = 1", "@get_transaction_info = 1", "@get_outer_command = 1", "@find_block_leaders = 1"]), ["Blocking session IDs", "Lock owners and resources", "Open transactions", "Current or outer commands"], "Use the heavier lock and transaction options briefly.");
  if (ruleId === "WIA-WAIT") return captureRecommendation("Capture active waits", commonReason, whoIsActiveCommand(["@get_task_info = 2", "@delta_interval = 5", "@get_plans = 1"]), ["Wait type and duration", "Task-level context", "Per-interval activity", "Execution plans"], "Plan collection adds overhead; keep the sample short.");
  if (ruleId === "WIA-TRANSACTION") return captureRecommendation("Capture transaction ownership", commonReason, whoIsActiveCommand(["@get_transaction_info = 1", "@get_locks = 1", "@get_outer_command = 1", "@find_block_leaders = 1"]), ["Open transaction count", "Transaction start and log activity", "Lock ownership", "Outer command"], "Transaction and lock XML should be collected briefly.");
  return captureRecommendation("Capture rate and plan evidence", commonReason, whoIsActiveCommand(["@get_task_info = 2", "@delta_interval = 5", "@get_plans = 1", "@get_memory_info = 1"]), ["Request duration", "Per-interval CPU and I/O", "Execution plans", "Memory grant context"], "Use the heavier collection options briefly on a busy system.");
}

function commandPreview(value: string | null, maximumLength = 240): string | null {
  const normalized = value?.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.length <= maximumLength ? normalized : `${normalized.slice(0, maximumLength - 1).trimEnd()}…`;
}

function blockingContext(blockerId: string, participants: BlockingParticipant[], blockerRows: WhoIsActiveRecord[], totalBlockedSessions: number, maxChainDepth: number, chainComplete: boolean): BlockingContext {
  const blockedSessionIds = participants
    .filter((participant) => participant.role !== "Root")
    .sort((left, right) => (right.waitDurationMs ?? -1) - (left.waitDurationMs ?? -1) || left.sessionId - right.sessionId)
    .map((participant) => participant.sessionId)
    .slice(0, 5);
  const blocker = [...blockerRows].sort((left, right) => String(right.collectionTime).localeCompare(String(left.collectionTime)) || right.rowNumber - left.rowNumber)[0];
  const sleeping = blocker?.status?.toLowerCase() === "sleeping";
  const command = sleeping ? blocker?.sqlCommand ?? blocker?.sqlText : blocker?.sqlText ?? blocker?.sqlCommand;
  const commandLabel = command ? sleeping ? "Last / outer command" : blocker?.sqlText ? "Current statement" : "Outer command" : null;
  return {
    headBlockerSessionId: Number(blockerId),
    blockedSessionIds,
    totalBlockedSessions,
    status: blocker?.status ?? null,
    databaseName: blocker?.databaseName ?? null,
    openTransactionCount: blocker?.openTranCount ?? null,
    commandLabel,
    commandPreview: commandPreview(command ?? null),
    participants,
    maxChainDepth,
    chainComplete,
  };
}

function times(records: WhoIsActiveRecord[]): { first: string | null; last: string | null; persistence: number } {
  const values = records.map((record) => record.collectionTime).filter((value): value is string => Boolean(value)).sort();
  return { first: values[0] ?? null, last: values.at(-1) ?? null, persistence: differenceSeconds(values[0] ?? null, values.at(-1) ?? null) ?? 0 };
}

function group<T>(values: T[], key: (value: T) => string): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const value of values) {
    const groupKey = key(value);
    const bucket = result.get(groupKey);
    if (bucket) bucket.push(value);
    else result.set(groupKey, [value]);
  }
  return result;
}

function episodeKey(record: WhoIsActiveRecord): string {
  return `${record.sessionId ?? "?"}:${record.requestId ?? 0}:${record.startTime ?? record.loginTime ?? "?"}`;
}

function originalNumber(record: WhoIsActiveRecord, aliases: string[]): number | null {
  const normalized = new Map(Object.entries(record.original).map(([key, value]) => [key.toLowerCase().replace(/[^a-z0-9]+/g, ""), value]));
  for (const alias of aliases) {
    const raw = normalized.get(alias.toLowerCase().replace(/[^a-z0-9]+/g, ""));
    if (raw === undefined || raw === null || String(raw).trim() === "") continue;
    const value = Number(String(raw).replaceAll(",", ""));
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function peakConcurrent(records: WhoIsActiveRecord[]): number {
  return Math.max(0, ...[...group(records, (record) => `${record.sourceId}:${record.collectionTime ?? "unknown"}`).values()].map((rows) => new Set(rows.map((record) => record.sessionId ?? record.id)).size));
}

function statementShape(value: string | null): string {
  return (value ?? "").replace(/N?'(?:''|[^'])*'/g, "?").replace(/\b\d+(?:\.\d+)?\b/g, "?").replace(/\s+/g, " ").trim().toLowerCase();
}

interface BlockingSnapshot {
  sourceId: string;
  collectionTime: string | null;
  rootSessionId: number;
  rows: WhoIsActiveRecord[];
  participants: BlockingParticipant[];
  victimCount: number;
  maxChainDepth: number;
  chainComplete: boolean;
}

function blockingSnapshots(records: WhoIsActiveRecord[]): BlockingSnapshot[] {
  const snapshots: BlockingSnapshot[] = [];
  for (const captureRows of group(records, (record) => `${record.sourceId}:${record.collectionTime ?? "unknown"}`).values()) {
    const bySession = new Map<number, WhoIsActiveRecord>();
    for (const record of captureRows) if (record.sessionId !== null && !bySession.has(record.sessionId)) bySession.set(record.sessionId, record);
    const chains = new Map<number, { paths: number[][]; complete: boolean }>();
    for (const victim of captureRows.filter((record) => record.sessionId !== null && (record.blockingSessionId ?? 0) > 0)) {
      const path = [victim.sessionId!];
      const visited = new Set(path);
      let current = victim.blockingSessionId!;
      let complete = true;
      while (true) {
        if (visited.has(current)) {
          complete = false;
          path.push(current);
          current = Math.min(...visited);
          break;
        }
        path.push(current);
        visited.add(current);
        const parent = bySession.get(current)?.blockingSessionId;
        if ((parent ?? 0) <= 0) break;
        current = parent!;
      }
      const root = current;
      const chain = chains.get(root) ?? { paths: [], complete: true };
      chain.paths.push(path);
      chain.complete &&= complete && bySession.has(root);
      chains.set(root, chain);
    }
    for (const [rootSessionId, chain] of chains) {
      const sessionIds = new Set(chain.paths.flat());
      const parentBySession = new Map<number, number | null>();
      for (const sessionId of sessionIds) parentBySession.set(sessionId, bySession.get(sessionId)?.blockingSessionId ?? null);
      const hasChildren = new Set<number>();
      for (const [sessionId, parent] of parentBySession) if (sessionId !== rootSessionId && parent !== null && sessionIds.has(parent)) hasChildren.add(parent);
      const participants = [...sessionIds].map((sessionId): BlockingParticipant => {
        const record = bySession.get(sessionId);
        return {
          sessionId,
          blockedBySessionId: sessionId === rootSessionId ? null : parentBySession.get(sessionId) ?? null,
          role: sessionId === rootSessionId ? "Root" : hasChildren.has(sessionId) ? "Intermediate" : "Victim",
          status: record?.status ?? null,
          openTransactionCount: record?.openTranCount ?? null,
          waitType: record?.wait?.type ?? null,
          waitDurationMs: record?.wait?.durationMs ?? null,
        };
      }).sort((left, right) => {
        const rank = { Root: 0, Intermediate: 1, Victim: 2 } as const;
        return rank[left.role] - rank[right.role] || left.sessionId - right.sessionId;
      });
      const rootRow = bySession.get(rootSessionId);
      const observedVictims = Math.max(0, participants.length - 1);
      snapshots.push({
        sourceId: captureRows[0].sourceId,
        collectionTime: captureRows[0].collectionTime,
        rootSessionId,
        rows: captureRows.filter((record) => record.sessionId !== null && sessionIds.has(record.sessionId)),
        participants,
        victimCount: Math.max(observedVictims, rootRow?.blockedSessionCount ?? 0),
        maxChainDepth: Math.max(...chain.paths.map((path) => path.length - 1)),
        chainComplete: chain.complete,
      });
    }
  }
  return snapshots;
}

function splitSnapshotsByConsecutiveCapture(snapshots: BlockingSnapshot[], allRecords: WhoIsActiveRecord[]): BlockingSnapshot[][] {
  const order = new Map<string, number>();
  for (const [sourceId, sourceRecords] of group(allRecords, (record) => record.sourceId)) {
    const captureTimes = [...new Set(sourceRecords.map((record) => record.collectionTime).filter((value): value is string => Boolean(value)))].sort();
    captureTimes.forEach((time, index) => order.set(`${sourceId}:${time}`, index));
  }
  const sorted = [...snapshots].sort((left, right) => left.sourceId.localeCompare(right.sourceId) || String(left.collectionTime).localeCompare(String(right.collectionTime)));
  const episodes: BlockingSnapshot[][] = [];
  for (const snapshot of sorted) {
    const previous = episodes.at(-1)?.at(-1);
    const previousIndex = previous?.collectionTime ? order.get(`${previous.sourceId}:${previous.collectionTime}`) : undefined;
    const currentIndex = snapshot.collectionTime ? order.get(`${snapshot.sourceId}:${snapshot.collectionTime}`) : undefined;
    const continues = previous && previous.sourceId === snapshot.sourceId
      && (previousIndex === undefined || currentIndex === undefined || currentIndex - previousIndex <= 1);
    if (!continues) episodes.push([]);
    episodes.at(-1)!.push(snapshot);
  }
  return episodes;
}

const blockingRule: RuleDefinition = {
  id: "WIA-BLOCKING", title: "Blocking chains", category: "Blocking", requiredColumns: ["blocking_session_id"], optionalColumns: ["blocked_session_count", "status", "open_tran_count", "collection_time"],
  description: "Finds blocked requests, head blockers, persistence, and sleeping open transactions.", references: [...REFERENCES.blocking, ...REFERENCES.whoIsActive, ...REFERENCES.blitzWho],
  evaluate(context) {
    const specialFindings = [...group(context.records.filter((record) => (record.blockingSessionId ?? 0) < 0), (record) => String(record.blockingSessionId)).entries()].map(([codeText, records]) => {
      const code = Number(codeText);
      const details = specialBlockingOwners[code] ?? { title: `SQL Server special blocking owner (${code}) observed`, meaning: "SQL Server reported a non-session blocking owner code.", severity: "Informational" as Severity };
      const observation = times(records);
      return finding("WIA-BLOCKING-SPECIAL", details.severity, "High", "Blocking", details.title, `${details.meaning} Observed on ${records.length} request${records.length === 1 ? "" : "s"}.`, {
        explanation: details.meaning,
        confidenceReason: "High confidence because SQL Server reserves negative blocking_session_id values for special owner states rather than user session IDs.",
        limitations: ["Correlate the accompanying wait type and duration before deciding whether the observation is operationally significant."],
        remediation: code === -2 ? ["Locate and resolve the orphaned distributed transaction using approved transaction-management procedures."] : code === -3 ? ["Review database recovery progress and related error-log evidence."] : ["Treat the wait type and duration as the diagnostic signal; do not attempt to kill the negative owner code."],
        evidence: [{ label: "Special owner code", value: codeText }, { label: "Meaning", value: details.meaning }, { label: "Affected requests", value: String(records.length) }],
        references: [...REFERENCES.blockingSessionId, ...this.references],
        affectedRecordIds: records.map((record) => record.id), firstSeen: observation.first, lastSeen: observation.last, persistenceSeconds: observation.persistence, impact: records.length,
      });
    });
    const blockingFindings = [...group(blockingSnapshots(context.records), (snapshot) => `${snapshot.sourceId}:${snapshot.rootSessionId}`).values()].flatMap((rootSnapshots) => splitSnapshotsByConsecutiveCapture(rootSnapshots, context.records).map((episode) => {
      const blockerId = String(episode[0].rootSessionId);
      const episodeRows = episode.flatMap((snapshot) => snapshot.rows);
      const observationKeys = new Set(episode.map((snapshot) => `${snapshot.sourceId}:${snapshot.collectionTime ?? "unknown"}`));
      const blockerRows = episodeRows.filter((record) => String(record.sessionId) === blockerId);
      const observation = times(episodeRows);
      const maxReported = Math.max(0, ...episode.map((snapshot) => snapshot.victimCount));
      const sleepingOpen = blockerRows.some((record) => record.status === "sleeping" && (record.openTranCount ?? 0) > 0);
      const maximumVictimWait = Math.max(0, ...episode.flatMap((snapshot) => snapshot.participants.map((participant) => participant.waitDurationMs ?? 0)));
      const transientLowImpact = maxReported === 1 && observation.persistence === 0 && maximumVictimWait < context.thresholds.blocking.transientVictimWaitMs;
      const severity: Severity = sleepingOpen || maxReported >= context.thresholds.blocking.highVictims || observation.persistence >= context.thresholds.blocking.highPersistenceSeconds ? "High"
        : maxReported >= context.thresholds.blocking.mediumVictims || observation.persistence >= context.thresholds.blocking.mediumPersistenceSeconds ? "Medium" : transientLowImpact ? "Informational" : "Low";
      const observationText = observation.persistence > 0 ? `observed for ${formatDuration(observation.persistence)}` : "observed in one capture";
      const severityReason = sleepingOpen ? "High: sleeping blocker with an open transaction" : maxReported >= context.thresholds.blocking.highVictims ? `High: ${maxReported} blocked sessions (threshold ${context.thresholds.blocking.highVictims})` : `${severity}: blocking scope and persistence`;
      const blockingTimeline = buildTimeline("Blocked sessions", "sessions", episode.map((snapshot) => ({ capturedAt: snapshot.collectionTime, value: snapshot.victimCount })));
      const missing = missingColumns(context, ["locks", "tran_start_time", "query_plan"]);
      if (!context.presentColumns.has("sql_text") && !context.presentColumns.has("sql_command")) missing.push("sql_text or sql_command");
      const busiest = [...episode].sort((left, right) => right.victimCount - left.victimCount || String(right.collectionTime).localeCompare(String(left.collectionTime)))[0];
      const rootRecord = [...blockerRows].sort((left, right) => String(right.collectionTime).localeCompare(String(left.collectionTime)))[0];
      const rootStatus = rootRecord?.status ?? "unknown";
      const rootWait = rootRecord?.wait;
      const maxChainDepth = Math.max(...episode.map((snapshot) => snapshot.maxChainDepth));
      const chainComplete = episode.every((snapshot) => snapshot.chainComplete);
      const transientWaitRecord = episodeRows.find((record) => (record.blockingSessionId ?? 0) > 0 && record.wait);
      const transientWaitDuration = Math.max(maximumVictimWait, transientWaitRecord?.wait?.durationMs ?? 0);
      const findingTitle = transientLowImpact && transientWaitRecord?.wait?.type
        ? `Isolated transient ${transientWaitRecord.wait.type} blocking observation`
        : `Session ${blockerId} is the root blocker`;
      const findingSummary = transientLowImpact
        ? `One downstream session was blocked in one capture; longest reported wait ${formatNumber(transientWaitDuration)} ms.`
        : `${maxReported} downstream session${maxReported === 1 ? "" : "s"} reported across a chain up to ${maxChainDepth} level${maxChainDepth === 1 ? "" : "s"} deep; ${observationText}.`;
      const limitations = [
        observationKeys.size === 1 ? "Only one capture point was supplied, so persistence cannot be confirmed." : null,
        !blockerRows.length ? "The blocker row was not present; the head blocker is inferred from victim rows." : null,
        !chainComplete ? "At least one blocking chain was incomplete or cyclic; the displayed root is the best supported root in the supplied rows." : null,
        missing.length ? `Additional root-cause evidence was not supplied: ${missing.join(", ")}.` : null,
      ].filter((value): value is string => Boolean(value));
      const remediation = sleepingOpen
        ? ["Trace the sleeping root session's transaction owner and application path; confirm whether the transaction should commit or roll back.", "Inspect retained locks and the last or outer command before considering session termination.", "Correct the transaction boundary or error/cancel path that left work open; do not automatically kill the session from this report."]
        : rootStatus === "runnable"
          ? ["Inspect the runnable root blocker's current SQL text and actual plan; it is still competing for CPU while retaining locks.", "Check scheduler pressure and the statement's CPU and I/O deltas before changing indexes or server settings.", "Reduce the statement's transaction duration or work volume, then verify that the blocking fan-out falls."]
          : rootWait
            ? [`The root blocker is waiting on ${rootWait.type}; investigate that ${rootWait.category.toLowerCase()} dependency before tuning or terminating victim sessions.`, "Correlate its SQL text, plan, transaction owner, and retained locks with the wait resource.", "Resolve the root dependency first, then verify that the downstream chain clears."]
            : ["Inspect the root blocker's SQL text, transaction state, retained locks, and application call path.", "Confirm whether the root is active, sleeping, or waiting before choosing a tuning or transaction response.", "Act on the root cause rather than terminating downstream victim sessions."];
      return finding(this.id, severity, blockerRows.length && chainComplete ? "High" : "Medium", this.category, findingTitle, findingSummary, {
        explanation: sleepingOpen ? "The head blocker is sleeping with an open transaction, so locks may remain until the transaction is committed, rolled back, or the session ends." : transientLowImpact ? "One sub-second blocking observation was captured and did not persist. Keep it as context rather than treating it as a sustained incident." : observation.persistence > 0 ? "Sustained blocking reduces concurrency and can lead to timeouts. Investigate the head blocker before acting on victim sessions." : "A wide blocking fan-out can reduce concurrency and trigger timeouts even when only one capture is available. Confirm persistence before intervening.",
        confidenceReason: blockerRows.length && chainComplete ? `High confidence because the root blocker row and ${Math.max(1, busiest.participants.length - 1)} downstream participant${busiest.participants.length - 1 === 1 ? " were" : "s were"} connected through the captured blocking graph.` : blockerRows.length ? "Medium confidence because the blocker row was captured, but at least one observation did not contain the complete path back to the root." : "Medium confidence because victim rows identify the blocking path, but the root blocker row was not supplied.",
        limitations,
        timeline: blockingTimeline,
        nextCapture: captureRecommendation("Confirm the blocking chain", missing.length ? `The current capture is missing ${missing.join(", ")}. Re-capture briefly with the evidence needed to establish ownership and cause.` : observationKeys.size === 1 ? "The evidence is strong but comes from one capture point. Repeat a short delta capture to confirm persistence before intervening." : "Re-capture the same chain during the incident before changing sessions or transaction behavior.", whoIsActiveCommand(["@get_task_info = 2", "@delta_interval = 5", "@get_locks = 1", "@get_transaction_info = 1", "@get_outer_command = 1", "@get_plans = 1", "@find_block_leaders = 1"]), ["Lock ownership and wait resources", "Transaction age and open-transaction state", "Blocker statement or outer command", "An execution plan when available", "A confirmed head-blocking chain"], "Lock XML and plans add collection overhead. Use the heavier options briefly on a busy production server."),
        diagnosticTools: [
          diagnosticTool("First Responder Kit · sp_BlitzWho", "Compare active requests, plans, grants, and blocking context during the same incident.", "EXEC dbo.sp_BlitzWho;"),
        ],
        remediation,
        blockingContext: blockingContext(blockerId, busiest.participants, blockerRows, maxReported, maxChainDepth, chainComplete),
        evidence: [{ label: "Root blocker", value: blockerId }, { label: "Root status", value: rootStatus }, { label: "Root wait", value: rootWait ? `${rootWait.type} · ${rootWait.category}` : "None reported" }, { label: "Blocked sessions", value: String(maxReported) }, { label: "Chain depth", value: String(maxChainDepth) }, { label: "Observed", value: observation.persistence > 0 ? formatDuration(observation.persistence) : "One capture" }, { label: "Severity reason", value: severityReason }, { label: "Sleeping open transaction", value: sleepingOpen ? "Yes" : "No" }],
        references: this.references, affectedRecordIds: [...new Set(episodeRows.map((record) => record.id))], firstSeen: observation.first, lastSeen: observation.last, persistenceSeconds: observation.persistence, impact: maxReported * 10 + maxChainDepth * 5 + observation.persistence,
      });
    }));
    return [...blockingFindings, ...specialFindings];
  },
};

const resourceRule: RuleDefinition = {
  id: "WIA-RESOURCE", title: "Long-running resource consumers", category: "Resources", requiredColumns: ["start_time", "collection_time"], optionalColumns: ["CPU", "reads", "writes", "used_memory", "tempdb_current"],
  description: "Ranks long-running requests by capture-relative CPU, I/O, memory, and tempdb consumption.", references: [...REFERENCES.plans, ...REFERENCES.blitzFirst, ...REFERENCES.blitzCache],
  evaluate(context) {
    const metrics = (record: WhoIsActiveRecord) => [record.cpuMs, record.reads, record.writes, record.usedMemoryPages, record.tempdbCurrentPages].filter((value): value is number => value !== null);
    const captureDistributions = new Map<string, number[][]>();
    for (const record of context.records) {
      const key = `${record.sourceId}:${record.collectionTime ?? "unknown"}`;
      const distributions = captureDistributions.get(key) ?? [[], [], [], [], []];
      [record.cpuMs, record.reads, record.writes, record.usedMemoryPages, record.tempdbCurrentPages]
        .forEach((value, index) => { if (value !== null) distributions[index].push(value); });
      captureDistributions.set(key, distributions);
    }
    const episodes = [...group(context.records.filter((record) => {
      if (["THREADPOOL", "RESOURCE_SEMAPHORE_QUERY_COMPILE"].includes(record.wait?.type.toUpperCase() ?? "")) return false;
      return (record.durationSeconds ?? 0) >= context.thresholds.resources.minimumDurationSeconds && metrics(record).some((value) => Math.abs(value) > 0);
    }), episodeKey).values()];
    return episodes.map((records) => {
      const peakDuration = Math.max(...records.map((record) => record.durationSeconds ?? 0));
      const latest = [...records].sort((a, b) => String(a.collectionTime).localeCompare(String(b.collectionTime))).at(-1)!;
      const values = [latest.cpuMs, latest.reads, latest.writes, latest.usedMemoryPages, latest.tempdbCurrentPages];
      const distributions = captureDistributions.get(`${latest.sourceId}:${latest.collectionTime ?? "unknown"}`) ?? [[], [], [], [], []];
      const peakPercentile = Math.max(...values.map((value, index) => value === null ? 0 : percentile(distributions[index], value)));
      const repeated = new Set(records.map((record) => record.collectionTime).filter(Boolean)).size;
      const resourceTimeline = buildTimeline("Relative resource rank", "percent", records.map((record) => {
        const pointValues = [record.cpuMs, record.reads, record.writes, record.usedMemoryPages, record.tempdbCurrentPages];
        const pointDistributions = captureDistributions.get(`${record.sourceId}:${record.collectionTime ?? "unknown"}`) ?? [[], [], [], [], []];
        return { capturedAt: record.collectionTime, value: Math.max(...pointValues.map((value, index) => value === null ? 0 : percentile(pointDistributions[index], value) * 100)) };
      }));
      let severity: Severity | null = null;
      if (peakDuration >= context.thresholds.resources.highDurationSeconds && peakPercentile >= context.thresholds.resources.highPercentile) severity = "High";
      else if (peakDuration >= context.thresholds.resources.mediumDurationSeconds && peakPercentile >= context.thresholds.resources.mediumPercentile) severity = "Medium";
      else if (peakDuration >= context.thresholds.resources.lowDurationSeconds && peakPercentile >= context.thresholds.resources.highPercentile && repeated >= context.thresholds.resources.lowRepeatedCaptures) severity = "Low";
      if (!severity) return null;
      const observation = times(records);
      const missing = missingColumns(context, ["query_plan"]);
      const limitations = [
        repeated === 1 ? "Only one capture point was supplied, so repeated consumption cannot be confirmed." : null,
        "Resource values are ranked against this capture; server capacity and a normal workload baseline were not supplied.",
        missing.length ? "No execution plan was supplied to connect resource use to operators or estimates." : null,
      ].filter((value): value is string => Boolean(value));
      return finding(this.id, severity, repeated >= context.thresholds.resources.mediumConfidenceCaptures ? "Medium" : "Low", this.category, `Session ${latest.sessionId ?? "unknown"} is a sustained resource outlier`, `Runtime ${formatDuration(peakDuration)}; capture-relative percentile ${(peakPercentile * 100).toFixed(0)} across ${repeated} capture${repeated === 1 ? "" : "s"}.`, {
        explanation: "Resource counters can be cumulative and server capacity is unknown. This finding combines duration, relative rank, and persistence instead of treating a raw counter as a universal threshold.",
        confidenceReason: repeated >= context.thresholds.resources.mediumConfidenceCaptures ? `Medium confidence because the session remained elevated across ${repeated} capture points, but no server baseline was supplied.` : "Low confidence because this is a one-capture, workload-relative outlier without a server baseline.",
        limitations,
        timeline: resourceTimeline,
        nextCapture: captureRecommendation("Measure rates and capture the plan", repeated === 1 ? "Confirm that the same request remains a top consumer and prefer delta values over cumulative totals." : missing.length ? "The resource pattern repeats, but an execution plan is needed to connect it to operators, estimates, or spills." : "Repeat a short delta sample during the slowdown and compare it with a normal window.", whoIsActiveCommand(["@get_task_info = 2", "@delta_interval = 5", "@get_plans = 1", "@get_memory_info = 1"]), ["Per-interval CPU and I/O rates", "Current task and parallel-worker context", "Execution-plan operators and warnings", "Workspace-memory grant context"], "Plans and task details add collection overhead. Keep the diagnostic interval short on a busy server."),
        diagnosticTools: [
          diagnosticTool("First Responder Kit · sp_BlitzFirst", "Sample server waits, file latency, Perfmon counters, and active requests during the slowdown.", "EXEC dbo.sp_BlitzFirst @ExpertMode = 1;"),
          diagnosticTool("First Responder Kit · sp_BlitzCache", "Confirm whether this query is important across the plan cache. Choose the sort matching the observed resource.", "EXEC dbo.sp_BlitzCache @SortOrder = 'CPU';", "Repeat with 'Reads' or 'Writes' only when that resource is the relevant signal."),
        ],
        remediation: ["Review the statement and actual plan when available, and compare delta rates with a normal workload window.", "Check indexing, row estimates, spills, and application batching before changing server-wide settings."],
        evidence: [{ label: "Runtime", value: formatDuration(peakDuration) }, { label: "Relative percentile", value: (peakPercentile * 100).toFixed(0) }, { label: "Captures", value: String(repeated) }, { label: "CPU", value: formatNumber(latest.cpuMs) }, { label: "Reads", value: formatNumber(latest.reads) }, { label: "Tempdb current", value: formatTempdbPages(latest.tempdbCurrentPages) }],
        references: this.references, affectedRecordIds: records.map((record) => record.id), firstSeen: observation.first, lastSeen: observation.last, persistenceSeconds: observation.persistence, impact: peakDuration * peakPercentile,
      });
    }).filter((value): value is Finding => Boolean(value)).sort((a, b) => b.impact - a.impact);
  },
};

function metricValues(source: SupplementalEvidenceSource, metric: string): number[] {
  return source.samples.map((sample) => sample.metrics[metric]).filter((value): value is number => Number.isFinite(value));
}

const schedulerPressureRule: RuleDefinition = {
  id: "WIA-SCHEDULER-PRESSURE", title: "CPU and scheduler pressure", category: "CPU", requiredColumns: ["status", "wait_info", "CPU", "collection_time"], optionalColumns: ["blocking_session_id"],
  description: "Correlates a runnable CPU-consuming request with sustained scheduler-yield waits and rising server scheduler counters.", references: [...REFERENCES.waits, ...REFERENCES.whoIsActive, ...REFERENCES.blitzFirst],
  evaluate(context) {
    const sources = context.supplementalEvidence.filter((source) => source.kind === "Scheduler counters");
    if (!sources.length) return [];
    const rootSessionIds = new Set(blockingSnapshots(context.records).map((snapshot) => snapshot.rootSessionId));
    const candidates = [...group(context.records.filter((record) => record.sessionId !== null
      && rootSessionIds.has(record.sessionId)
      && record.status?.toLowerCase() === "runnable"
      && record.wait?.type.toUpperCase() === "SOS_SCHEDULER_YIELD"), episodeKey).values()]
      .sort((left, right) => right.length - left.length);
    const records = candidates[0];
    if (!records?.length) return [];
    const cpuValues = records.map((record) => record.cpuMs).filter((value): value is number => value !== null && Number.isFinite(value));
    if (cpuValues.length < context.thresholds.waits.corroboratingCaptures || cpuValues.at(-1)! <= cpuValues[0]) return [];
    const source = sources.find((item) => {
      const processor = metricValues(item, "processor_pct_time");
      const signal = metricValues(item, "signal_wait_time_pct");
      const runnable = metricValues(item, "runnable_tasks_count");
      return processor.length >= context.thresholds.waits.corroboratingCaptures
        && signal.length >= context.thresholds.waits.corroboratingCaptures
        && runnable.length >= context.thresholds.waits.corroboratingCaptures
        && processor.at(-1)! > processor[0]
        && signal.at(-1)! > signal[0]
        && runnable.at(-1)! > runnable[0];
    });
    if (!source) return [];
    const processor = metricValues(source, "processor_pct_time");
    const signal = metricValues(source, "signal_wait_time_pct");
    const runnable = metricValues(source, "runnable_tasks_count");
    const sessionId = records[0].sessionId!;
    const observation = times(records);
    return [finding(this.id, "High", "High", this.category, "Sustained CPU and scheduler pressure", `Runnable session ${sessionId} repeatedly yielded to the scheduler while processor use, signal-wait share, and runnable-task count all increased.`, {
      explanation: "The runnable head blocker is actively consuming CPU rather than sleeping or waiting on a lock. Rising server scheduler counters show that its longer lock-holding time is occurring during CPU pressure, making the blocking chain a downstream effect rather than the primary condition.",
      confidenceReason: "High confidence because repeated SOS_SCHEDULER_YIELD observations, increasing request CPU, and three independent rising scheduler counters converge on the same interval.",
      limitations: ["The supplied evidence does not determine whether this statement alone caused the instance-wide CPU pressure or was competing with unrelated concurrent work.", "No actual execution plan was supplied to connect CPU consumption to a specific operator or access path."],
      nextCapture: captureRecommendation("Separate query CPU from instance-wide pressure", "Capture the runnable statement's actual plan and short scheduler deltas during the same interval.", whoIsActiveCommand(["@get_task_info = 2", "@delta_interval = 5", "@get_plans = 1"]), ["Actual plan for the runnable root statement", "Per-scheduler runnable queues", "Signal-wait and CPU deltas", "Concurrent workload attribution"], "Plan collection adds overhead; keep the sample short."),
      remediation: ["Capture and review an actual plan for the runnable root statement before changing indexes or server settings.", "Compare the same scheduler counters with a normal window to separate a query-plan problem from insufficient workload headroom."],
      evidence: [
        { label: "Runnable root session", value: String(sessionId) },
        { label: "Scheduler-yield observations", value: String(records.length) },
        { label: "Request CPU movement", value: `${formatNumber(cpuValues[0])} → ${formatNumber(cpuValues.at(-1)!)} ms` },
        { label: "Processor movement", value: `${formatNumber(processor[0])}% → ${formatNumber(processor.at(-1)!)}%` },
        { label: "Signal-wait movement", value: `${formatNumber(signal[0])}% → ${formatNumber(signal.at(-1)!)}%` },
        { label: "Runnable tasks movement", value: `${formatNumber(runnable[0])} → ${formatNumber(runnable.at(-1)!)}` },
      ],
      references: this.references,
      affectedRecordIds: records.map((record) => record.id),
      firstSeen: observation.first,
      lastSeen: observation.last,
      persistenceSeconds: observation.persistence,
      impact: 250_000 + observation.persistence,
    })];
  },
};

const waitRule: RuleDefinition = {
  id: "WIA-WAIT", title: "Actionable waits", category: "Waits", requiredColumns: ["wait_info"], optionalColumns: ["collection_time", "blocking_session_id"],
  description: "Classifies current request waits and avoids elevating known benign queue waits in isolation.", references: [...REFERENCES.waits, ...REFERENCES.whoIsActive, ...REFERENCES.blitzFirst],
  evaluate(context) {
    const specialTypes = new Set(["THREADPOOL", "RESOURCE_SEMAPHORE_QUERY_COMPILE"]);
    const specialized = [...group(context.records.filter((record) => specialTypes.has(record.wait?.type.toUpperCase() ?? "")), (record) => `${record.sourceId}:${record.wait!.type.toUpperCase()}`).values()].map((records) => {
      const type = records[0].wait!.type.toUpperCase();
      const observation = times(records);
      const captures = new Set(records.map((record) => record.collectionTime).filter(Boolean)).size;
      const concurrent = peakConcurrent(records);
      const maximumWait = Math.max(0, ...records.map((record) => record.wait?.durationMs ?? 0));
      const maximumNativeTaskCount = Math.max(0, ...records.map((record) => record.wait?.taskCount ?? 0));
      const waitTimeline = buildTimeline("Reported wait duration", "milliseconds", records.map((record) => ({ capturedAt: record.collectionTime, value: record.wait?.durationMs ?? null })));
      if (type === "THREADPOOL") {
        const noTaskCount = records.filter((record) => originalNumber(record, ["tasks", "task_count"]) === 0).length;
        const workerSource = context.supplementalEvidence.find((source) => source.kind === "Worker counters");
        const workerCeilingObserved = workerSource?.samples.some((sample) => {
          const active = sample.metrics.active_worker_threads;
          const maximum = sample.metrics.max_worker_threads;
          const queue = sample.metrics.work_queue_count;
          return Number.isFinite(active) && Number.isFinite(maximum) && Number.isFinite(queue) && active >= maximum && queue > 0;
        }) ?? false;
        const activeWorkers = workerSource ? metricValues(workerSource, "active_worker_threads") : [];
        const maxWorkers = workerSource ? metricValues(workerSource, "max_worker_threads") : [];
        const workQueue = workerSource ? metricValues(workerSource, "work_queue_count") : [];
        const high = captures >= context.thresholds.workerExhaustion.highCaptures && concurrent >= context.thresholds.workerExhaustion.highConcurrency;
        const highConfidence = workerCeilingObserved || captures >= context.thresholds.workerExhaustion.highConfidenceCaptures;
        return finding("WIA-WORKER-EXHAUSTION", workerCeilingObserved ? "Critical" : high ? "High" : "Medium", highConfidence ? "High" : "Medium", "Worker threads", "Worker-thread pool exhaustion indicated by persistent THREADPOOL waits", `${records.length} queued request observations span ${captures} captures, with peak visible concurrency ${concurrent}.`, {
          explanation: "THREADPOOL means a request is waiting for an available worker. Repeated observations with growing concurrency are an instance-level availability risk even when an individual wait duration is short.",
          confidenceReason: workerCeilingObserved ? "High confidence because THREADPOOL recurs while supplemental counters show active workers reaching the configured ceiling and the work queue growing." : highConfidence ? "High confidence in worker starvation because THREADPOOL recurs across capture points and concurrent sessions." : "Medium confidence because THREADPOOL is explicit, but persistence needs another sample.",
          limitations: workerCeilingObserved ? ["The evidence confirms worker exhaustion but does not distinguish overlapping jobs, a connection burst, or workers retained by other long-running requests."] : ["The capture establishes worker starvation; configured worker ceiling and work-queue counters are still needed to quantify the server-wide limit."],
          timeline: waitTimeline,
          nextCapture: captureRecommendation("Confirm worker exhaustion", "Correlate THREADPOOL recurrence with the configured worker ceiling and queued work.", "SELECT scheduler_id, current_workers_count, active_workers_count, work_queue_count FROM sys.dm_os_schedulers WHERE status = 'VISIBLE ONLINE';\nSELECT name, value_in_use FROM sys.configurations WHERE name = 'max worker threads';", ["Active and configured worker counts", "Work queue by visible scheduler", "Repeated THREADPOOL requests", "Upstream concurrency source"], "Run briefly during the incident; SQL Evaluate never executes this command."),
          remediation: ["Reduce or gate the incoming concurrency burst after confirming its source.", "Investigate long-lived requests or blocking that may be retaining workers; do not raise max worker threads without workload and platform review."],
          evidence: [{ label: "Wait", value: type }, { label: "Observations", value: String(records.length) }, { label: "Captures", value: String(captures) }, { label: "Peak visible concurrency", value: String(concurrent) }, { label: "Maximum native task count", value: maximumNativeTaskCount ? String(maximumNativeTaskCount) : "Not supplied" }, { label: "Zero-task rows", value: String(noTaskCount) }, { label: "Maximum wait", value: `${formatNumber(maximumWait)} ms` }, { label: "Worker ceiling observed", value: workerCeilingObserved ? "Yes" : "Not supplied" }, ...(workerSource ? [{ label: "Peak active workers", value: formatNumber(Math.max(0, ...activeWorkers)) }, { label: "Configured worker ceiling", value: formatNumber(Math.max(0, ...maxWorkers)) }, { label: "Peak work queue", value: formatNumber(Math.max(0, ...workQueue)) }] : [])],
          references: this.references, affectedRecordIds: records.map((record) => record.id), firstSeen: observation.first, lastSeen: observation.last, persistenceSeconds: observation.persistence, impact: 100_000 + concurrent * 100 + observation.persistence,
        });
      }
      const texts = records.map((record) => record.sqlText).filter((value): value is string => Boolean(value));
      const variants = new Set(texts.map((value) => value.replace(/\s+/g, " ").trim())).size;
      const shapes = new Set(texts.map(statementShape)).size;
      const uncachedPlans = context.plans.flatMap((plan) => plan.statements).filter((statement) => statement.retrievedFromCache === false).length;
      const compileSource = context.supplementalEvidence.find((source) => source.kind === "Compilation counters");
      const compilationRates = compileSource ? metricValues(compileSource, "sql_compilations_per_sec") : [];
      const batchRates = compileSource ? metricValues(compileSource, "batch_requests_per_sec") : [];
      const compileWaiters = compileSource ? metricValues(compileSource, "resource_semaphore_query_compile_waiting_tasks") : [];
      const cacheHit = compileSource ? metricValues(compileSource, "cache_hit_ratio_plan_cache_pct") : [];
      const maximumCompilationRatio = Math.max(0, ...compilationRates.map((value, index) => batchRates[index] > 0 ? value / batchRates[index] : 0));
      const countersCorroborate = Boolean(compileSource && maximumCompilationRatio >= 0.1 && Math.max(0, ...compileWaiters) > 0 && cacheHit.length > 1 && cacheHit.at(-1)! < cacheHit[0]);
      const severity: Severity = captures >= context.thresholds.compilePressure.highCaptures && concurrent >= context.thresholds.compilePressure.highConcurrency ? "High" : "Medium";
      const highConfidence = countersCorroborate || captures >= context.thresholds.compilePressure.highConfidenceCaptures && variants >= context.thresholds.compilePressure.highConfidenceVariants;
      return finding("WIA-COMPILE-PRESSURE", severity, highConfidence ? "High" : "Medium", "Compilation", "Compilation-memory and plan-cache pressure", `${records.length} RESOURCE_SEMAPHORE_QUERY_COMPILE observations span ${captures} captures; ${variants} statement variants reduce to ${shapes} structural shape${shapes === 1 ? "" : "s"}.`, {
        explanation: "RESOURCE_SEMAPHORE_QUERY_COMPILE is a compile-memory semaphore, not an execution memory-grant wait. Repeated literal variants of one statement shape support an ad-hoc compilation-pressure diagnosis.",
        confidenceReason: countersCorroborate ? "High confidence because the compile-specific wait and literal variants are corroborated by a high compilation-to-batch ratio, compile-semaphore waiters, and a falling plan-cache hit ratio." : highConfidence ? "High confidence because the compile-specific wait persists while many literal variants share the same statement shape." : "Medium confidence because the compile-specific wait is explicit but plan-cache attribution needs more evidence.",
        limitations: ["The evidence does not establish whether application parameterization, database parameterization settings, or generated SQL caused the literal variants."],
        timeline: waitTimeline,
        nextCapture: captureRecommendation("Confirm compilation and single-use plan pressure", "Measure compilations relative to batches and inspect the plan cache for single-use ad-hoc plans.", "SELECT counter_name, cntr_value FROM sys.dm_os_performance_counters WHERE object_name LIKE '%:SQL Statistics%' AND counter_name IN ('Batch Requests/sec','SQL Compilations/sec','SQL Re-Compilations/sec');\nSELECT objtype, usecounts, COUNT(*) AS plans, SUM(size_in_bytes) AS bytes FROM sys.dm_exec_cached_plans GROUP BY objtype, usecounts;", ["Compilation-to-batch movement", "Single-use ad-hoc plan count and size", "Cache-hit movement", "Compile-semaphore waiting tasks"], "Take at least two bounded counter samples; these counters require delta interpretation."),
        remediation: ["Confirm the source of literal SQL and prefer parameterized execution where appropriate.", "Evaluate forced parameterization or optimize for ad hoc workloads only after workload-wide testing."],
        evidence: [{ label: "Wait", value: type }, { label: "Observations", value: String(records.length) }, { label: "Captures", value: String(captures) }, { label: "Peak visible concurrency", value: String(concurrent) }, { label: "Maximum native task count", value: maximumNativeTaskCount ? String(maximumNativeTaskCount) : "Not supplied" }, { label: "Statement variants", value: String(variants) }, { label: "Structural shapes", value: String(shapes) }, { label: "Uncached supplied plans", value: String(uncachedPlans) }, { label: "Maximum wait", value: `${formatNumber(maximumWait)} ms` }, { label: "Compile counters corroborate", value: countersCorroborate ? "Yes" : "Not supplied" }, ...(compileSource ? [{ label: "Peak compilation / batch ratio", value: `${formatNumber(maximumCompilationRatio * 100)}%` }, { label: "Peak compile waiters", value: formatNumber(Math.max(0, ...compileWaiters)) }, { label: "Plan-cache hit movement", value: cacheHit.length ? `${formatNumber(cacheHit[0])}% → ${formatNumber(cacheHit.at(-1)!)}%` : "Not supplied" }] : [])],
        references: this.references, affectedRecordIds: records.map((record) => record.id), affectedPlanIds: context.plans.flatMap((plan) => plan.statements.filter((statement) => statement.retrievedFromCache === false).flatMap((statement) => [plan.id, statement.id])), firstSeen: observation.first, lastSeen: observation.last, persistenceSeconds: observation.persistence, impact: 80_000 + concurrent * 100 + observation.persistence,
      });
    });
    const groups = group(context.records.filter((record) => record.wait && !specialTypes.has(record.wait.type.toUpperCase())), (record) => `${record.wait!.type}:${episodeKey(record)}`);
    const generic = [...groups.values()].map((records) => {
      const wait = records[0].wait!;
      const observation = times(records);
      const maxWait = Math.max(...records.map((record) => record.wait?.durationMs ?? 0));
      const benign = wait.category === "Benign / queue" || wait.category === "Parallelism";
      const directImpactEvidence = records.some((record) => (record.blockingSessionId ?? 0) > 0);
      const captureCount = new Set(records.map((record) => record.collectionTime).filter(Boolean)).size;
      const sustained = observation.persistence >= context.thresholds.waits.highPersistenceSeconds || (directImpactEvidence && captureCount >= context.thresholds.waits.corroboratingCaptures);
      if (maxWait <= 0 && !directImpactEvidence) return null;
      if (directImpactEvidence && captureCount === 1 && maxWait < context.thresholds.waits.actionableDurationMs) return null;
      const severity: Severity = benign && !directImpactEvidence ? "Informational" : maxWait >= context.thresholds.waits.actionableDurationMs && sustained ? "High" : maxWait >= context.thresholds.waits.actionableDurationMs ? "Medium" : captureCount === 1 && !directImpactEvidence ? "Informational" : "Low";
      const waitTimeline = buildTimeline("Reported wait duration", "milliseconds", records.map((record) => ({ capturedAt: record.collectionTime, value: record.wait?.durationMs ?? null })));
      const missing = missingColumns(context, ["query_plan"]);
      if (wait.category === "Locking") missing.push(...missingColumns(context, ["locks", "tran_start_time"]));
      if (wait.category === "Memory grant") missing.push(...missingColumns(context, ["memory_info"]));
      const waitOptions = ["@get_task_info = 2", "@delta_interval = 5", "@get_plans = 1"];
      if (wait.category === "Locking") waitOptions.push("@get_locks = 1", "@get_transaction_info = 1", "@get_outer_command = 1", "@find_block_leaders = 1");
      if (wait.category === "Memory grant") waitOptions.push("@get_memory_info = 1");
      const limitations = [
        records.length === 1 ? "Only one wait observation was supplied, so persistence cannot be confirmed." : null,
        !directImpactEvidence && !benign ? "No blocking relationship was captured to corroborate direct impact." : null,
        missing.length ? `Additional wait-cause evidence was not supplied: ${[...new Set(missing)].join(", ")}.` : null,
      ].filter((value): value is string => Boolean(value));
      const mediumConfidence = records.length >= context.thresholds.waits.mediumConfidenceObservations;
      return finding(this.id, severity, mediumConfidence ? "Medium" : "Low", this.category, `${wait.type} wait on session ${records[0].sessionId ?? "unknown"}`, `${wait.category} wait observed ${records.length} time${records.length === 1 ? "" : "s"}; longest reported wait ${formatNumber(maxWait)} ms.`, {
        explanation: benign ? "This wait is commonly expected on its own. It is retained as context and only escalates when persistent or corroborated by another concern." : "Waits identify where a request is stalled, but the cause and resolution depend on the wait family and surrounding evidence.",
        confidenceReason: mediumConfidence ? `Medium confidence because the same ${wait.type} wait was observed ${records.length} times${directImpactEvidence ? " with a captured blocking relationship" : ""}.` : `Low confidence because ${wait.type} was observed once without enough persistence evidence.`,
        limitations,
        timeline: waitTimeline,
        nextCapture: captureRecommendation(`Re-capture the ${wait.category.toLowerCase()} wait`, missing.length ? `The current capture identifies the wait but is missing ${[...new Set(missing)].join(", ")}.` : records.length === 1 ? "Repeat a short delta sample to determine whether the wait persists or was transient." : "Capture the same interval with task and plan context to confirm the resource causing the stall.", whoIsActiveCommand([...new Set(waitOptions)]), wait.category === "Locking" ? ["Wait duration by task", "Lock resources and owners", "Transaction ownership", "Blocker statement and plan"] : wait.category === "Memory grant" ? ["Wait duration by task", "Requested and granted memory", "Plan memory-grant evidence", "Concurrent grant pressure"] : ["Wait duration by task", "Per-interval request activity", "Execution-plan context"], "Use plan, lock, and memory collection options briefly because they add overhead on busy systems."),
        diagnosticTools: [
          diagnosticTool("sp_WhoIsActive", "Capture a short delta sample with task, lock, plan, and memory-grant context.", "EXEC dbo.sp_WhoIsActive @get_task_info = 2, @delta_interval = 5, @get_locks = 1, @get_plans = 1, @get_memory_info = 1;", "Use the heavier collection options briefly on a busy production server."),
          diagnosticTool("First Responder Kit · sp_BlitzFirst", "Determine whether this wait family is significant at the server level during the same interval.", "EXEC dbo.sp_BlitzFirst @ExpertMode = 1;"),
        ],
        remediation: ["Use the linked Microsoft wait reference, then correlate with blocking, query text, plan operators, storage latency, memory grants, or client behavior as appropriate."],
        evidence: [{ label: "Wait", value: wait.type }, { label: "Category", value: wait.category }, { label: "Maximum wait", value: `${formatNumber(maxWait)} ms` }, { label: "Observed", value: formatDuration(observation.persistence) }],
        references: this.references, affectedRecordIds: records.map((record) => record.id), firstSeen: observation.first, lastSeen: observation.last, persistenceSeconds: observation.persistence, impact: maxWait + observation.persistence,
      });
    }).filter((value): value is Finding => Boolean(value)).sort((a, b) => b.impact - a.impact);
    return [...specialized, ...generic];
  },
};

const transactionRule: RuleDefinition = {
  id: "WIA-TRANSACTION", title: "Open transactions", category: "Transactions", requiredColumns: ["open_tran_count"], optionalColumns: ["tran_start_time", "status", "implicit_tran", "blocking_session_id"],
  description: "Finds old or blocking open transactions, including implicit transactions.", references: [...REFERENCES.blocking, ...REFERENCES.whoIsActive, ...REFERENCES.blitzWho],
  evaluate(context) {
    const blockingOwnerSessionIds = new Set(context.records.map((record) => record.blockingSessionId).filter((sessionId): sessionId is number => (sessionId ?? 0) > 0));
    return [...group(context.records.filter((record) => (record.openTranCount ?? 0) > 0), episodeKey).values()].map((records) => {
      const latest = [...records].sort((a, b) => String(a.collectionTime).localeCompare(String(b.collectionTime))).at(-1)!;
      const age = Math.max(...records.map((record) => record.durationSeconds ?? 0));
      const isBlocker = latest.sessionId !== null && blockingOwnerSessionIds.has(latest.sessionId);
      const sleeping = records.some((record) => record.status === "sleeping");
      const transactionAge = Math.max(0, ...records.map((record) => differenceSeconds(record.tranStartTime ?? null, record.collectionTime) ?? 0));
      if (!isBlocker && age < context.thresholds.transactions.mediumAgeSeconds && transactionAge < context.thresholds.transactions.mediumAgeSeconds && !latest.implicitTran) return null;
      const severity: Severity = (sleeping && isBlocker) || age >= context.thresholds.transactions.highAgeSeconds ? "High" : age >= context.thresholds.transactions.mediumAgeSeconds || latest.implicitTran ? "Medium" : "Low";
      const observation = times(records);
      const hasTransactionStart = records.some((record) => Boolean(record.tranStartTime));
      const transactionTimeline = buildTimeline(hasTransactionStart ? "Transaction age" : "Request age proxy", "seconds", records.map((record) => ({ capturedAt: record.collectionTime, value: differenceSeconds(record.tranStartTime ?? null, record.collectionTime) ?? record.durationSeconds })));
      const missing = missingColumns(context, ["tran_start_time", "locks"]);
      if (!context.presentColumns.has("sql_text") && !context.presentColumns.has("sql_command")) missing.push("sql_text or sql_command");
      const limitations = [
        records.length === 1 ? "Only one transaction observation was supplied, so growth or persistence cannot be confirmed." : null,
        !hasTransactionStart ? "Transaction start time was unavailable; request age is shown as a proxy and may understate transaction age." : null,
        missing.length ? `Additional transaction evidence was not supplied: ${missing.join(", ")}.` : null,
      ].filter((value): value is string => Boolean(value));
      return finding(this.id, severity, isBlocker ? "High" : "Medium", this.category, `Session ${latest.sessionId ?? "unknown"} has an open transaction`, `${latest.openTranCount} open transaction${latest.openTranCount === 1 ? "" : "s"}; request age ${formatDuration(age)}.`, {
        explanation: sleeping && isBlocker ? "A sleeping head blocker with an open transaction can retain locks without doing active work." : "Long transactions retain locks and log records longer, increasing contention and recovery pressure.",
        confidenceReason: isBlocker ? "High confidence because the open transaction belongs to a session that is directly blocking other captured requests." : `Medium confidence because an open transaction is present${records.length > 1 ? " across repeated observations" : ""}, but direct blocking impact was not established.`,
        limitations,
        timeline: transactionTimeline,
        nextCapture: captureRecommendation("Establish transaction ownership and impact", missing.length ? `The current capture is missing ${missing.join(", ")}. Re-capture ownership, locks, and the outer command before intervening.` : records.length === 1 ? "Repeat a brief capture to confirm that the transaction remains open and whether it begins blocking other work." : "Re-capture during the incident to verify the transaction owner and current blocking impact.", whoIsActiveCommand(["@get_task_info = 2", "@delta_interval = 5", "@get_transaction_info = 1", "@get_locks = 1", "@get_outer_command = 1", "@find_block_leaders = 1"]), ["Transaction start and log activity", "Lock ownership", "Outer command or current statement", "Blocking-chain membership"], "Lock and transaction XML can be expensive to collect. Use a short interval and follow production access policy."),
        diagnosticTools: [
          diagnosticTool("sp_WhoIsActive", "Establish transaction ownership, locks, outer command, and blocking impact.", "EXEC dbo.sp_WhoIsActive @get_transaction_info = 1, @get_locks = 1, @get_outer_command = 1, @find_block_leaders = 1;"),
          diagnosticTool("First Responder Kit · sp_BlitzWho", "Compare the transaction with other active requests before considering intervention.", "EXEC dbo.sp_BlitzWho;"),
        ],
        remediation: ["Trace the application transaction path and verify commit/rollback behavior; inspect SQL text and locks before taking action.", "Reduce work inside the transaction where safe. Do not automatically kill a session from this report."],
        evidence: [{ label: "Session", value: String(latest.sessionId ?? "Unknown") }, { label: "Open transactions", value: String(latest.openTranCount) }, { label: "Status", value: latest.status ?? "Unknown" }, { label: "Request age", value: formatDuration(age) }, { label: "Head blocker", value: isBlocker ? "Yes" : "No" }],
        references: this.references, affectedRecordIds: records.map((record) => record.id), firstSeen: observation.first, lastSeen: observation.last, persistenceSeconds: observation.persistence, impact: age + (isBlocker ? 10_000 : 0),
      });
    }).filter((value): value is Finding => Boolean(value)).sort((a, b) => b.impact - a.impact);
  },
};

function planFindings(statement: PlanStatement, plan: PlanDocument, context: RuleContext): Finding[] {
  const result: Finding[] = [];
  const refs = REFERENCES.plans;
  const affectedRecordIds = plan.sourceRecordId ? [plan.sourceRecordId] : [];
  const planLimitations = [statement.isActual ? "This plan represents one execution and may vary with different parameters or workload conditions." : "This is estimated plan evidence; runtime row counts, spills, elapsed time, and CPU were not observed."];
  for (const operator of statement.operators) {
    if (operator.actualRows !== null && operator.estimatedRows !== null && operator.actualRows >= context.thresholds.plans.mediumRows) {
      const minimum = Math.max(1, Math.min(operator.actualRows, operator.estimatedRows));
      const maximum = Math.max(operator.actualRows, operator.estimatedRows);
      const ratio = maximum / minimum;
      if (ratio >= context.thresholds.plans.mediumEstimateRatio) {
        const severity: Severity = ratio >= context.thresholds.plans.highEstimateRatio && operator.actualRows >= context.thresholds.plans.highRows ? "High" : "Medium";
        result.push(finding("PLAN-ESTIMATE", severity, "High", "Execution plan", `Row estimate is off by ${formatNumber(ratio)}×`, `${operator.physicalOp} estimated ${formatNumber(operator.estimatedRows)} rows and processed ${formatNumber(operator.actualRows)}.`, { explanation: "Large cardinality-estimation errors can produce poor join types, memory grants, and access paths.", confidenceReason: "High confidence because the actual execution plan contains both estimated and runtime row counts for this operator.", limitations: planLimitations, diagnosticTools: [diagnosticTool("First Responder Kit · sp_BlitzCache", "Confirm workload importance and review parameter, statistics, and plan warnings.", "EXEC dbo.sp_BlitzCache @SortOrder = 'CPU';", "Use @SortOrder = 'Reads' when logical I/O is the stronger signal."), diagnosticTool("Ola Hallengren · IndexOptimize", "Run targeted statistics-only maintenance only after stale statistics are confirmed.", "EXEC dbo.IndexOptimize @Databases = 'YourDatabase', @Indexes = 'YourDatabase.dbo.YourTable', @FragmentationLow = NULL, @FragmentationMedium = NULL, @FragmentationHigh = NULL, @UpdateStatistics = 'ALL', @OnlyModifiedStatistics = 'Y';", "Replace placeholders and use a controlled maintenance window. Do not rebuild broadly because one estimate is wrong.")], remediation: ["Verify statistics freshness and data skew; check predicates, parameter sensitivity, implicit conversions, and table-variable estimates.", "Compare with a representative actual plan before changing indexes or hints."], evidence: [...planContext(statement), { label: "Operator", value: operator.physicalOp }, { label: "Estimated rows", value: formatNumber(operator.estimatedRows) }, { label: "Actual rows", value: formatNumber(operator.actualRows) }, { label: "Difference", value: `${formatNumber(ratio)}×` }], references: [...refs, ...REFERENCES.blitzCache, ...REFERENCES.olaIndexOptimize], affectedRecordIds, affectedPlanIds: [plan.id, statement.id, operator.id], impact: ratio * Math.log10(operator.actualRows + 1) }));
      }
    }
    if (operator.warnings.some((warning) => warning.toLowerCase().includes("spill"))) {
      const severity: Severity = (operator.actualRows ?? 0) >= context.thresholds.plans.highRows ? "High" : "Medium";
      result.push(finding("PLAN-SPILL", severity, "High", "Execution plan", `${operator.physicalOp} spilled to tempdb`, "The actual plan reports a runtime spill, indicating that the operator could not complete in its memory grant.", { explanation: "Spills add tempdb I/O and often point to estimation errors, insufficient grants, or a large sort/hash workload.", confidenceReason: "High confidence because the actual execution plan contains an explicit runtime spill warning.", limitations: planLimitations, diagnosticTools: [diagnosticTool("First Responder Kit · sp_BlitzCache", "Find cached plans with the largest spill footprint and determine whether this is recurring.", "EXEC dbo.sp_BlitzCache @SortOrder = 'Spills';"), diagnosticTool("First Responder Kit · sp_BlitzFirst", "Compare tempdb/file pressure and memory grants during the slowdown.", "EXEC dbo.sp_BlitzFirst @ExpertMode = 1;")], remediation: ["Correct large row-estimate errors first, then review indexes and predicates that feed the spilling operator.", "Evaluate grant feedback and memory pressure before changing server memory settings."], evidence: [...planContext(statement), { label: "Operator", value: operator.physicalOp }, { label: "Node", value: String(operator.nodeId ?? "Unknown") }, { label: "Actual rows", value: formatNumber(operator.actualRows) }], references: [...refs, ...REFERENCES.memory, ...REFERENCES.blitzCache, ...REFERENCES.blitzFirst], affectedRecordIds, affectedPlanIds: [plan.id, statement.id, operator.id], impact: (operator.actualRows ?? 0) + 100_000 }));
    }
    const conversion = operator.warnings.find((warning) => warning.toLowerCase().includes("conversion"));
    if (conversion) {
      result.push(finding("PLAN-CONVERT", "Medium", "High", "Execution plan", "Plan-affecting implicit conversion", `${operator.physicalOp} contains a conversion warning that may prevent an efficient seek or distort estimates.`, { confidenceReason: "High confidence because Showplan explicitly marks this conversion as plan-affecting.", limitations: planLimitations, remediation: ["Align parameter, variable, and column data types.", "Avoid applying conversion functions to indexed columns in predicates."], evidence: [...planContext(statement), { label: "Operator", value: operator.physicalOp }, { label: "Node", value: String(operator.nodeId ?? "Unknown") }, { label: "Showplan warning", value: conversion }], references: refs, affectedRecordIds, affectedPlanIds: [plan.id, statement.id, operator.id], impact: 200 }));
    }
    const residualPredicate = operator.residualPredicate ?? operator.nonSargablePredicate;
    if (residualPredicate) {
      const explicitResidual = Boolean(operator.residualPredicate);
      const rowVolume = operator.actualRows ?? operator.estimatedRows ?? 0;
      const lowImpactActual = statement.isActual && rowVolume < context.thresholds.plans.mediumRows;
      const severity: Severity = !statement.isActual ? "Low" : lowImpactActual ? "Informational" : "Medium";
      const confidence: Confidence = statement.isActual ? "High" : "Low";
      const residualLimitations = [
        ...planLimitations,
        !statement.isActual ? "The predicate shape is visible, but its runtime row volume and impact were not observed." : null,
        lowImpactActual ? `This execution processed fewer than ${formatNumber(context.thresholds.plans.mediumRows)} rows at the operator, so the residual is retained as context rather than an actionable concern.` : null,
      ].filter((value): value is string => Boolean(value));
      result.push(finding("PLAN-RESIDUAL-PREDICATE", severity, confidence, "Execution plan", explicitResidual ? "Residual predicate applies after the access path" : "Non-SARGable predicate drove scanning", explicitResidual ? `${operator.physicalOp} contains a separate residual predicate that is evaluated after the access path identifies candidate rows.` : `${operator.physicalOp} applies a captured non-SARGable predicate while scanning rows rather than using it as a selective seek predicate.`, { confidenceReason: !statement.isActual ? "Low confidence in operational impact because only estimated plan-shape evidence is available." : explicitResidual ? "High confidence because Showplan supplies a distinct residual predicate alongside the access path." : "High confidence because Showplan supplies the scan access path and a leading-wildcard or conversion expression in the predicate.", limitations: residualLimitations, remediation: ["Align predicate and column data types, and remove functions or leading-wildcard patterns from indexed search predicates where requirements allow.", "Measure a representative plan after changing the predicate or index design."], evidence: [...planContext(statement), { label: "Operator", value: operator.physicalOp }, { label: "Node", value: String(operator.nodeId ?? "Unknown") }, { label: "Object", value: operator.objectName ?? "Not supplied" }, { label: "Predicate", value: residualPredicate }], references: refs, affectedRecordIds, affectedPlanIds: [plan.id, statement.id, operator.id], impact: rowVolume + 150 }));
    }
  }
  const scalarOperators = statement.operators.filter((operator) => operator.hasScalarFunction);
  if (scalarOperators.length) {
    result.push(finding("PLAN-SCALAR-UDF", "High", "High", "Execution plan", "Scalar user-defined function executes in the plan", "Showplan contains a UserDefinedFunction operator, which can add row-by-row CPU cost and can prevent a parallel plan on affected SQL Server versions or compatibility levels.", { confidenceReason: "High confidence because the Showplan XML directly contains UserDefinedFunction evidence.", limitations: [...planLimitations, "The plan alone does not prove whether UDF inlining is unavailable, disabled, or ineligible."], remediation: ["Measure the function's contribution and evaluate an inline relational rewrite or eligible scalar-UDF inlining.", "Retest the statement plan and runtime after any function change."], evidence: [...planContext(statement), { label: "Operators with scalar UDF", value: String(scalarOperators.length) }], references: refs, affectedRecordIds, affectedPlanIds: [plan.id, statement.id, ...scalarOperators.map((operator) => operator.id)], impact: 120_000 }));
  }
  if (statement.degreeOfParallelism === 1 && statement.nonParallelPlanReason && (scalarOperators.length > 0 || statement.nonParallelPlanReason !== "EstimatedDOPIsOne")) {
    result.push(finding("PLAN-SERIALIZATION", "High", "High", "Execution plan", "Plan was forced to execute serially", `The plan ran at DOP 1 and reports NonParallelPlanReason=${statement.nonParallelPlanReason}.`, { confidenceReason: "High confidence because Showplan directly reports both DegreeOfParallelism and NonParallelPlanReason.", limitations: planLimitations, remediation: ["Address the reported plan-specific serialization cause before changing server-wide parallelism settings.", "Compare CPU and elapsed time using a representative execution after the cause is removed."], evidence: [...planContext(statement), { label: "Degree of parallelism", value: String(statement.degreeOfParallelism) }, { label: "Nonparallel reason", value: statement.nonParallelPlanReason }, { label: "Scalar UDF present", value: scalarOperators.length ? "Yes" : "No" }], references: refs, affectedRecordIds, affectedPlanIds: [plan.id, statement.id, ...scalarOperators.map((operator) => operator.id)], impact: 150_000 }));
  }
  if (statement.missingIndexImpact !== null) {
    const severity: Severity = statement.missingIndexImpact >= context.thresholds.plans.mediumMissingIndexImpact && statement.operators.some((operator) => operator.physicalOp.includes("Scan")) ? "Medium" : "Low";
    result.push(finding("PLAN-MISSING-INDEX", severity, "Medium", "Execution plan", `Missing-index suggestion (${statement.missingIndexImpact.toFixed(0)}% optimizer impact)`, "The optimizer emitted a missing-index suggestion. It is a hypothesis for this statement, not an instruction to create the index unchanged.", { confidenceReason: "Medium confidence because this is an optimizer suggestion for one statement, not workload-wide index evidence.", limitations: [...planLimitations, "Existing, overlapping, unused, and write-heavy indexes were not evaluated."], diagnosticTools: [diagnosticTool("First Responder Kit · sp_BlitzIndex", "Compare the suggestion with existing, duplicate, and unused indexes on the affected table.", "EXEC dbo.sp_BlitzIndex @DatabaseName = 'YourDatabase', @SchemaName = 'dbo', @TableName = 'YourTable';", "Replace placeholders and review workload-wide read/write costs before creating an index.")], remediation: ["Consolidate overlapping suggestions and include write, storage, and maintenance cost in the decision. Do not create the Showplan suggestion unchanged.", "Test with representative parameters and measure before and after."], evidence: [...planContext(statement), { label: "Reported impact", value: `${statement.missingIndexImpact.toFixed(1)}%` }], references: [...REFERENCES.indexes, ...REFERENCES.blitzIndex], affectedRecordIds, affectedPlanIds: [plan.id, statement.id], impact: statement.missingIndexImpact }));
  }
  if (statement.memoryGrant && statement.memoryGrant.grantedKb > 0) {
    const waste = Math.max(0, statement.memoryGrant.grantedKb - statement.memoryGrant.usedKb);
    const ratio = statement.memoryGrant.usedKb > 0 ? statement.memoryGrant.grantedKb / statement.memoryGrant.usedKb : Number.POSITIVE_INFINITY;
    if (waste >= context.thresholds.plans.mediumGrantWasteKb && ratio >= context.thresholds.plans.mediumGrantRatio) {
      const severity: Severity = waste >= context.thresholds.plans.highGrantWasteKb && ratio >= context.thresholds.plans.highGrantRatio ? "High" : "Medium";
      result.push(finding("PLAN-MEMORY-GRANT", severity, "High", "Execution plan", "Execution plan received an oversized memory grant", `${formatNumber(waste / 1024)} MB of granted workspace memory was not used.`, { explanation: "Oversized grants can reduce concurrency by reserving workspace memory that other requests may need. Confirm the pattern across executions because parameter sensitivity and memory grant feedback can change later grants.", confidenceReason: "High confidence because the plan reports granted and maximum-used workspace memory for this execution.", limitations: planLimitations, diagnosticTools: [diagnosticTool("First Responder Kit · sp_BlitzCache", "Identify cached queries wasting the most workspace memory and compare this statement with the broader workload.", "EXEC dbo.sp_BlitzCache @SortOrder = 'Unused Grant';"), diagnosticTool("First Responder Kit · sp_BlitzFirst", "Check whether grants are causing server-level pressure or RESOURCE_SEMAPHORE waits during the incident.", "EXEC dbo.sp_BlitzFirst @ExpertMode = 1;")], remediation: ["Investigate row-estimate errors and parameter sensitivity, and verify whether memory grant feedback is active and converging.", "Avoid lowering global memory settings as a first response."], evidence: [...planContext(statement), { label: "Granted", value: `${formatNumber(statement.memoryGrant.grantedKb / 1024)} MB` }, { label: "Used", value: `${formatNumber(statement.memoryGrant.usedKb / 1024)} MB` }, { label: "Unused", value: `${formatNumber(waste / 1024)} MB` }, { label: "Grant / use", value: `${formatNumber(ratio)}×` }], references: [...REFERENCES.memory, ...REFERENCES.blitzCache, ...REFERENCES.blitzFirst], affectedRecordIds, affectedPlanIds: [plan.id, statement.id], impact: waste * ratio }));
    }
  }
  if (!statement.isActual) {
    result.push(finding("PLAN-RUNTIME-UNAVAILABLE", "Not Evaluated", "High", "Data quality", "Runtime plan checks were not evaluated", "This is an estimated plan, so actual rows, runtime warnings, elapsed time, and CPU evidence are unavailable.", { confidenceReason: "High confidence in this limitation because the Showplan document contains no runtime counters.", limitations: planLimitations, nextCapture: captureRecommendation("Capture a representative actual plan", "Runtime-dependent checks require an actual execution plan. Use representative parameters and an approved non-production or controlled production workflow.", undefined, ["Actual versus estimated rows", "Runtime spills and warnings", "Used memory grant", "Elapsed time and CPU evidence"], "Actual-plan collection executes the statement. Follow change-control and workload-safety procedures."), remediation: ["Capture an actual execution plan with representative parameters when safe."], references: refs, affectedRecordIds, affectedPlanIds: [plan.id, statement.id], impact: 0 }));
  }
  const qualifications = planQualifications(statement, plan);
  const earlyAbortLimitation = statement.earlyAbortReason ? "Showplan reported an optimizer early-abort reason; its causal significance for this finding was not evaluated." : null;
  return result.map((item) => {
    const scopedQualifications = item.ruleId === "PLAN-MEMORY-GRANT"
      ? qualifications.filter((qualification) => qualification.kind !== "Compile memory")
      : qualifications;
    return {
      ...item,
      qualifications: scopedQualifications.length ? scopedQualifications : undefined,
      limitations: earlyAbortLimitation && !item.limitations?.includes(earlyAbortLimitation) ? [...(item.limitations ?? []), earlyAbortLimitation] : item.limitations,
    };
  });
}

const planRule: RuleDefinition = {
  id: "PLAN-ANALYSIS", title: "Execution plan analysis", category: "Execution plan", requiredColumns: [], optionalColumns: ["query_plan"], description: "Analyzes standalone and embedded SQL Server Showplan XML.", references: REFERENCES.plans,
  evaluate(context) { return context.plans.flatMap((plan) => plan.statements.flatMap((statement) => planFindings(statement, plan, context))); },
};

export const RULE_DEFINITIONS: RuleDefinition[] = [schedulerPressureRule, blockingRule, resourceRule, waitRule, transactionRule, planRule];

const FINDING_CAPS: Partial<Record<string, number>> = { "WIA-RESOURCE": 20, "WIA-WAIT": 24, "WIA-TRANSACTION": 20 };

function parseEmbeddedPlans(records: WhoIsActiveRecord[], inputs: AnalysisInput[]): { plans: PlanDocument[]; warnings: string[] } {
  const plans: PlanDocument[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    const xml = record.queryPlanXml;
    if (!xml || seen.has(xml)) continue;
    seen.add(xml);
    if (!xml.trim().startsWith("<")) {
      warnings.push(`Row ${record.rowNumber}: embedded query_plan is compressed or not XML and was skipped.`);
      continue;
    }
    try {
      const source = inputs.find((input) => input.id === record.sourceId)?.fileName ?? "capture";
      const parsed = parseShowplan(xml, record.sourceId, `${source} row ${record.rowNumber}`);
      warnings.push(...parsed.warnings.map((warning) => `Row ${record.rowNumber}: ${warning}`));
      plans.push({ ...parsed, sourceRecordId: record.id });
    } catch (error) {
      warnings.push(`Row ${record.rowNumber}: ${error instanceof Error ? error.message : "embedded plan could not be parsed"}`);
    }
  }
  return { plans, warnings };
}

function enrichRelatedFindings(findings: Finding[], plans: PlanDocument[]): void {
  const statementAndOperatorIds = new Set(plans.flatMap((plan) => plan.statements.flatMap((statement) => [statement.id, ...statement.operators.map((operator) => operator.id)])));
  const recordIndex = new Map<string, number[]>();
  const planEvidenceIndex = new Map<string, number[]>();
  const add = (index: Map<string, number[]>, key: string, findingIndex: number) => index.set(key, [...(index.get(key) ?? []), findingIndex]);
  findings.forEach((item, findingIndex) => {
    item.affectedRecordIds.forEach((id) => add(recordIndex, id, findingIndex));
    item.affectedPlanIds.filter((id) => statementAndOperatorIds.has(id)).forEach((id) => add(planEvidenceIndex, id, findingIndex));
  });
  findings.forEach((item, findingIndex) => {
    const candidates = new Set<number>();
    item.affectedRecordIds.forEach((id) => recordIndex.get(id)?.forEach((candidate) => candidates.add(candidate)));
    item.affectedPlanIds.filter((id) => statementAndOperatorIds.has(id)).forEach((id) => planEvidenceIndex.get(id)?.forEach((candidate) => candidates.add(candidate)));
    candidates.delete(findingIndex);
    const related = [...candidates].map((candidateIndex): { item: Finding; link: RelatedFindingLink } => {
      const candidate = findings[candidateIndex];
      const sharesRecord = item.affectedRecordIds.some((id) => candidate.affectedRecordIds.includes(id));
      const sharesPlanEvidence = item.affectedPlanIds.some((id) => statementAndOperatorIds.has(id) && candidate.affectedPlanIds.includes(id));
      const crossesActivityAndPlan = sharesRecord && ((item.category === "Execution plan" || item.category === "Data quality") !== (candidate.category === "Execution plan" || candidate.category === "Data quality"));
      const reason = crossesActivityAndPlan ? "Embedded plan from the affected activity row" : sharesRecord && sharesPlanEvidence ? "Shares activity and statement evidence" : sharesRecord ? "Shares affected activity rows" : "Shares execution-plan statement evidence";
      return { item: candidate, link: { findingId: candidate.id, reason } };
    }).sort((left, right) => severityRank[right.item.severity] - severityRank[left.item.severity] || confidenceRank[right.item.confidence] - confidenceRank[left.item.confidence] || right.item.impact - left.item.impact || left.item.title.localeCompare(right.item.title)).slice(0, 5).map(({ link }) => link);
    item.relatedFindings = related;
  });
}

function linkSchedulerBackedBlocking(findings: Finding[]): void {
  const schedulerFindings = findings.filter((item) => item.ruleId === "WIA-SCHEDULER-PRESSURE");
  for (const scheduler of schedulerFindings) {
    const sessionId = Number(scheduler.evidence.find((item) => item.label === "Runnable root session")?.value);
    if (!Number.isFinite(sessionId)) continue;
    for (const blocking of findings.filter((item) => item.ruleId === "WIA-BLOCKING" && item.blockingContext?.headBlockerSessionId === sessionId)) {
      scheduler.relatedFindings = [...(scheduler.relatedFindings ?? []), { findingId: blocking.id, reason: "The runnable session retained locks long enough to create this downstream blocking chain." }];
      blocking.relatedFindings = [...(blocking.relatedFindings ?? []), { findingId: scheduler.id, reason: "Correlated scheduler evidence indicates CPU pressure prolonged the runnable root session." }];
      blocking.explanation = "This blocking chain is real, but correlated scheduler evidence indicates that CPU pressure prolonged the runnable root session while it retained locks. Treat the chain as a downstream effect and investigate the scheduler-pressure finding first.";
    }
  }
}

export function analyze(inputs: AnalysisInput[], records: WhoIsActiveRecord[], standalonePlans: PlanDocument[], thresholdProfile: ThresholdProfileSnapshot = DEFAULT_THRESHOLD_PROFILE_SNAPSHOT, supplementalEvidence: SupplementalEvidenceSource[] = []): AnalysisReport {
  const resolvedProfile = validateThresholdProfileSnapshotShape(thresholdProfile);
  const embedded = parseEmbeddedPlans(records, inputs);
  const plans = [...standalonePlans, ...embedded.plans];
  const presentColumns = new Set(inputs.flatMap((input) => input.recognizedColumns));
  const context: RuleContext = { inputs, records, plans, supplementalEvidence, presentColumns, thresholds: resolvedProfile.thresholds };
  const findings: Finding[] = [];
  const capCounts = new Map<string, { retainedCount: number; suppressedCount: number }>();
  const appendFindings = (items: Finding[]) => {
    for (const item of items) {
      const cap = FINDING_CAPS[item.ruleId];
      if (cap === undefined) { findings.push(item); continue; }
      const counts = capCounts.get(item.ruleId) ?? { retainedCount: 0, suppressedCount: 0 };
      if (counts.retainedCount < cap) { findings.push(item); counts.retainedCount += 1; }
      else counts.suppressedCount += 1;
      capCounts.set(item.ruleId, counts);
    }
  };
  const notEvaluatedRules: string[] = [];
  for (const rule of RULE_DEFINITIONS) {
    if (rule === schedulerPressureRule && !supplementalEvidence.some((source) => source.kind === "Scheduler counters")) continue;
    const missing = rule.requiredColumns.filter((column) => !presentColumns.has(column));
    if (missing.length && rule !== planRule) {
      notEvaluatedRules.push(rule.title);
      findings.push(finding(`${rule.id}-UNAVAILABLE`, "Not Evaluated", "High", "Data quality", `${rule.title} was not evaluated`, `Required column${missing.length === 1 ? "" : "s"} missing: ${missing.join(", ")}.`, { explanation: "sp_WhoIsActive returns columns according to its collection parameters and output list. Other independent checks still ran.", confidenceReason: "High confidence in this limitation because the required columns are absent from every supplied source.", limitations: [`No conclusion was produced for ${rule.title.toLowerCase()}.`], nextCapture: unavailableCaptureRecommendation(rule.id, missing), remediation: ["Include the listed columns in a future capture if this diagnostic is needed."], references: rule.references, impact: 0 }));
      continue;
    }
    if (rule === planRule && !plans.length) {
      notEvaluatedRules.push(rule.title);
      findings.push(finding("PLAN-UNAVAILABLE", "Not Evaluated", "High", "Data quality", "Execution plans were not evaluated", "No standalone or valid embedded Showplan XML was supplied.", { confidenceReason: "High confidence in this limitation because no valid Showplan document was available.", limitations: ["Operator, row-estimate, spill, memory-grant, conversion, and missing-index checks were unavailable."], nextCapture: captureRecommendation("Capture an execution plan", "Import a saved .sqlplan file or include query_plan in a future sp_WhoIsActive capture.", whoIsActiveCommand(["@get_task_info = 2", "@get_plans = 1"]), ["Statement and operator costs", "Estimated rows", "Plan warnings", "Runtime counters when an actual plan is supplied"], "Plan collection adds overhead and may expose sensitive SQL text. Capture briefly and handle the output securely."), remediation: ["Import a .sqlplan file or capture the query_plan column with @get_plans enabled."], references: rule.references, impact: 0 }));
      continue;
    }
    appendFindings(rule.evaluate(context));
  }
  const capturePoints = new Set(records.map((record) => record.collectionTime).filter(Boolean)).size;
  if (records.length && capturePoints >= context.thresholds.waits.corroboratingCaptures && !findings.some((item) => item.severity !== "Not Evaluated")) {
    findings.push(finding("CAPTURE-HEALTHY", "Informational", "High", "Assessment", "No systemic concern observed", `${records.length} activity rows across ${capturePoints} capture points produced no actionable blocking, wait, transaction, resource, or plan finding.`, {
      explanation: "The supplied time series contains no repeated or threshold-crossing evidence of an active performance incident. This conclusion is limited to the captured interval and evidence types supplied.",
      confidenceReason: "High confidence for the captured interval because multiple collection points were analyzed without a recurring actionable signal.",
      limitations: plans.length ? ["A quiet capture does not prove the workload is always healthy outside this interval."] : ["A quiet capture does not prove the workload is always healthy outside this interval.", "No execution plan was supplied, so operator-level checks were unavailable."],
      remediation: ["No escalation is indicated from this capture. Retain it as a baseline and compare future incident captures against it."],
      evidence: [{ label: "Activity rows", value: String(records.length) }, { label: "Capture points", value: String(capturePoints) }, { label: "Actionable findings", value: "0" }],
      references: [...REFERENCES.whoIsActive],
      impact: 0,
    }));
  }
  const findingCaps: FindingCapDisclosure[] = [...capCounts.entries()].flatMap(([ruleId, counts]) => counts.suppressedCount ? [{ ruleId, ...counts, order: "Descending diagnostic impact" as const }] : []);
  if (findings.some((finding) => finding.ruleId === "PLAN-RUNTIME-UNAVAILABLE")) notEvaluatedRules.push("Runtime plan checks");
  const present = [...presentColumns];
  const blockingOwnerSessionIds = new Set(records.map((record) => record.blockingSessionId).filter((sessionId): sessionId is number => (sessionId ?? 0) > 0));
  const dataQuality: DataQuality = {
    presentColumns: present,
    missingColumns: WHOISACTIVE_COLUMNS.filter((column) => !presentColumns.has(column)),
    unknownColumns: [...new Set(inputs.flatMap((input) => input.unknownColumns))],
    warnings: [
      ...inputs.flatMap((input) => input.warnings),
      ...embedded.warnings,
      ...(() => { const count = records.filter((record) => Boolean(record.waitParseWarning)).length; return count ? [`${count} parenthesized wait_info observation${count === 1 ? "" : "s"} could not be parsed and ${count === 1 ? "was" : "were"} retained only in the original activity data.`] : []; })(),
      ...(presentColumns.has("tempdb_current") || presentColumns.has("tempdb_allocations") ? ["Per-session TempDB pages show request-level consumption only; they do not establish overall TempDB utilization, free space inside the data files, or Windows volume headroom."] : []),
    ],
    notEvaluatedRules,
    findingCaps,
    suppressedSignals: [
      (() => { const count = records.filter((record) => record.wait?.durationMs === 0 && (record.blockingSessionId ?? 0) <= 0 && !["THREADPOOL", "RESOURCE_SEMAPHORE_QUERY_COMPILE"].includes(record.wait.type.toUpperCase())).length; return count ? `${count} zero-duration wait observation${count === 1 ? " was" : "s were"} retained in activity data but suppressed from findings.` : null; })(),
      (() => { const count = records.filter((record) => (record.openTranCount ?? 0) > 0 && (record.durationSeconds ?? 0) < context.thresholds.transactions.mediumAgeSeconds && (record.sessionId === null || !blockingOwnerSessionIds.has(record.sessionId)) && !record.implicitTran).length; return count ? `${count} short, non-blocking open-transaction observation${count === 1 ? " was" : "s were"} suppressed from findings.` : null; })(),
      (() => { const count = records.filter((record) => (record.durationSeconds ?? 0) < context.thresholds.resources.minimumDurationSeconds && [record.cpuMs, record.reads, record.writes, record.usedMemoryPages, record.tempdbCurrentPages].some((value) => (value ?? 0) > 0)).length; return count ? `${count} sub-${context.thresholds.resources.minimumDurationSeconds}-second resource observation${count === 1 ? " was" : "s were"} kept out of capture-relative outlier findings.` : null; })(),
    ].filter((value): value is string => Boolean(value)),
  };
  findings.sort((a, b) => severityRank[b.severity] - severityRank[a.severity] || confidenceRank[b.confidence] - confidenceRank[a.confidence] || b.impact - a.impact || a.title.localeCompare(b.title));
  findings.forEach((item) => { item.deepAnalysisProfile = deepAnalysisProfileForFinding(item) ?? undefined; });
  enrichRelatedFindings(findings, plans);
  linkSchedulerBackedBlocking(findings);
  return { schemaVersion: "1.0", createdAt: new Date().toISOString(), inputs, records, plans, findings, dataQuality, redacted: false, thresholdProfile: resolvedProfile };
}
