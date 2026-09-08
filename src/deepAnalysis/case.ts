import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { AnalysisReport, Finding, PlanDocument, PlanQueryIdentity, PlanSourceKind } from "../types";
import { APP_VERSION } from "../version";
import { decodeText, parseCsv } from "../lib/csv";
import { identityFromRow, inspectEvidenceMatrix, normalizeEvidenceHeader } from "./adapters";
import { parseCapabilitySnapshot } from "./capabilities";
import { hasCorrelationReadyIdentity } from "./correlation";
import { evaluateDeepCase } from "./evaluator";
import { cpuBlockingCollectionCommand, CPU_BACKED_BLOCKING_PROFILE, deepAnalysisProfileForFinding, extendedEventsShowplanCommand, lastKnownActualPlanCommand, profileLabel, queryStoreExportCommand } from "./profile";
import { inspectSpillTriageMatrix, rankSpillCandidates, resolveCandidatePlan } from "./spillTriage";
import { spillCollectionSteps } from "./toolCatalog";
import type { DeepAnalysisCase, DeepCaseArchive, DeepCaseArchiveManifest, DeepCaseArtifact, DeepEvidenceAssertion, DeepEvidenceObservation, DeepProfileId, DeepQueryIdentity, EvidenceImportMessage, ServerCapabilitySnapshot, SpillCandidate, SpillImportSummary, SpillManualPlanSelection, SpillPlanEvidence, SpillTriageState } from "./types";

const CASE_SIZE_LIMIT = 100 * 1024 * 1024;
const UNCOMPRESSED_LIMIT = 200 * 1024 * 1024;

function assertion(id: string, label: string, statement: string, state: DeepEvidenceAssertion["state"], basis: string[], missingEvidence: string[]): DeepEvidenceAssertion {
  return { id, label, statement, state, confidence: state === "Observed" ? "High" : state === "Supported" ? "Medium" : state === "Contradicted" ? "High" : "High", basis, missingEvidence, artifactIds: [] };
}

function caseId(): string {
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").replace(/\.\d{3}Z$/, "");
  return `${timestamp}-${crypto.randomUUID().slice(0, 8)}`;
}

function originalValue(original: Record<string, unknown>, aliases: string[]): unknown {
  const normalized = new Map(Object.entries(original).map(([key, value]) => [key.toLowerCase().replace(/[^a-z0-9]+/g, ""), value]));
  for (const alias of aliases) {
    const value = normalized.get(alias.toLowerCase().replace(/[^a-z0-9]+/g, ""));
    if (value !== undefined && value !== null && String(value).trim() !== "") return value;
  }
  return null;
}

function numberValue(value: unknown): number | null {
  const text = String(value ?? "").replaceAll(",", "").trim();
  if (!text || /^(?:null|n\/a|none)$/i.test(text)) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function textValue(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text && !/^null$/i.test(text) ? text : null;
}

function rootIdentity(report: AnalysisReport, finding: Finding): DeepQueryIdentity {
  const affected = report.records.filter((record) => finding.affectedRecordIds.includes(record.id));
  const root = finding.blockingContext?.headBlockerSessionId ?? affected.find((record) => record.sessionId !== null)?.sessionId ?? null;
  const rows = affected.filter((record) => root === null || record.sessionId === root);
  const record = rows.at(-1);
  const original = record?.original ?? {};
  return {
    sessionId: root,
    requestId: record?.requestId ?? null,
    transactionId: numberValue(originalValue(original, ["transaction_id", "transaction uow"])),
    sqlHandle: textValue(originalValue(original, ["sql_handle", "sql handle"])),
    planHandle: textValue(originalValue(original, ["plan_handle", "plan handle"])),
    queryHash: textValue(originalValue(original, ["query_hash", "query hash"])),
    queryPlanHash: textValue(originalValue(original, ["query_plan_hash", "query plan hash"])),
    statementStartOffset: numberValue(originalValue(original, ["statement_start_offset"])),
    statementEndOffset: numberValue(originalValue(original, ["statement_end_offset"])),
    databaseId: numberValue(originalValue(original, ["database_id", "dbid"])),
  };
}

export function createCpuBlockingCase(report: AnalysisReport, finding: Finding, createdAt = new Date().toISOString(), id = caseId()): DeepAnalysisCase {
  if (finding.ruleId !== "WIA-BLOCKING" || !finding.blockingContext) throw new Error("CPU-backed blocking analysis requires a blocking finding with a resolved root context.");
  const context = finding.blockingContext;
  const chainObserved = Boolean(context.participants?.length && context.headBlockerSessionId > 0);
  const rootRunnable = context.status?.toLowerCase() === "runnable";
  const transactionKnown = context.openTransactionCount !== null;
  const hasOpenTransaction = (context.openTransactionCount ?? 0) > 0;
  const relatedTimes = report.records.filter((record) => finding.affectedRecordIds.includes(record.id)).map((record) => record.collectionTime).filter((value): value is string => Boolean(value)).sort();
  const base: DeepAnalysisCase = {
    schemaVersion: "1.4",
    id,
    profileId: CPU_BACKED_BLOCKING_PROFILE.id,
    title: `CPU-backed blocking / SPID ${context.headBlockerSessionId}`,
    createdAt,
    updatedAt: createdAt,
    sourceReportCreatedAt: report.createdAt,
    sourceFileNames: report.inputs.map((input) => input.fileName),
    sourceFinding: {
      id: finding.id,
      ruleId: finding.ruleId,
      severity: finding.severity,
      confidence: finding.confidence,
      category: finding.category,
      title: finding.title,
      summary: finding.summary,
      evidence: finding.evidence,
      blockingContext: context,
    },
    origin: { kind: "finding", finding: {
      id: finding.id, ruleId: finding.ruleId, severity: finding.severity, confidence: finding.confidence,
      category: finding.category, title: finding.title, summary: finding.summary, evidence: finding.evidence, blockingContext: context,
    } },
    rootSessionId: context.headBlockerSessionId,
    rootIdentity: rootIdentity(report, finding),
    incidentWindow: {
      firstObservedAt: relatedTimes[0] ?? finding.firstSeen ?? null,
      lastObservedAt: relatedTimes.at(-1) ?? finding.lastSeen ?? null,
      overlapQuality: relatedTimes.length ? "Exact" : "Unknown",
      explanation: relatedTimes.length ? "The incident window comes from affected WhoIsActive collection timestamps." : "The source finding has no usable collection boundary; later evidence requires explicit timestamps.",
    },
    observations: [],
    captureAttempts: [],
    assertions: [
      assertion("blocking-chain", "Blocking chain", `SPID ${context.headBlockerSessionId} is the captured root of ${context.totalBlockedSessions} downstream session${context.totalBlockedSessions === 1 ? "" : "s"}.`, chainObserved ? "Observed" : "Not Evaluated", chainObserved ? ["The capture contains a connected root, intermediate, and victim graph."] : [], chainObserved ? [] : ["A complete blocking graph with the root row"]),
      assertion("root-runnable", "Root scheduler state", `SPID ${context.headBlockerSessionId} was runnable at the captured instant.`, rootRunnable ? "Observed" : context.status ? "Contradicted" : "Not Evaluated", context.status ? [`Captured root status: ${context.status}.`] : [], rootRunnable ? ["Repeated scheduler queue samples to establish sustained pressure"] : context.status ? [] : ["Root request status"]),
      assertion("open-transactions", "Open transaction", `SPID ${context.headBlockerSessionId} had an open transaction while blocking downstream work.`, hasOpenTransaction ? "Observed" : transactionKnown ? "Contradicted" : "Not Evaluated", transactionKnown ? [`Captured open transaction count: ${context.openTransactionCount}.`] : [], hasOpenTransaction ? ["Transaction age and ownership", "Granted lock resources"] : transactionKnown ? [] : ["Open transaction count and transaction ownership"]),
      assertion("root-lock-owner", "Lock ownership", `The root transaction owns the lock resources responsible for the downstream waits.`, "Not Evaluated", [], ["Transaction-to-lock ownership for the root SPID", "Victim wait resources"]),
      assertion("scheduler-pressure", "Scheduler pressure", "Sustained runnable queues delayed the root request and extended lock duration.", "Not Evaluated", rootRunnable ? ["The root was runnable in one capture; this is a clue, not proof of sustained CPU pressure."] : [], ["Repeated runnable_tasks_count by visible scheduler", "Scheduler delay and CPU context during the same incident"]),
      assertion("plan-cache-pressure", "Compilation and plan-cache pressure", "Ad-hoc plan churn or compilation problems materially contributed to CPU pressure.", "Not Evaluated", [], ["Single-use plan prevalence", "Compilation rate relative to batch rate", "Plan warnings or supported sp_BlitzCache evidence"]),
      assertion("compilation-pressure", "Compilation pressure", "Compilation activity materially contributed to scheduler pressure during the incident.", "Not Evaluated", [], ["Repeated SQL Compilations/sec and Batch Requests/sec counter samples", "Time alignment with the incident"]),
      assertion("serialization", "Root plan serialization", "The responsible root statement was forced to execute serially for a plan-specific reason.", "Not Evaluated", [], ["A stably matched root plan containing NonParallelPlanReason", "Or a stably correlated BlitzCache row"]),
      assertion("memory-grant-symptom", "Root memory-grant symptom", "The responsible query reserved materially more workspace memory than it used.", "Not Evaluated", [], ["A stably matched actual plan or cache row with requested, granted, and used memory"]),
      assertion("memory-grant-pressure", "Memory grant pressure", "Workspace-memory grants reduced concurrency during the incident.", "Not Evaluated", [], ["Pending grants or RESOURCE_SEMAPHORE evidence", "Requested, granted, and used memory"]),
      assertion("plan-captured", "Root execution plan", "A plan for the responsible root statement was captured close enough to the incident for operator analysis.", "Not Evaluated", [], ["Same-moment plan_handle and query_plan, or an approved historical plan source"]),
      assertion("causal-theory", "Working causal theory", "Scheduler or compilation pressure prolonged an open root transaction, extending locks and amplifying the blocking chain.", "Not Evaluated", ["The captured chain, runnable root state, and open transaction make this plausible, but they do not establish sustained CPU pressure."], ["Scheduler queue persistence", "Root lock ownership", "Compilation and plan evidence"]),
    ],
    collectionSteps: [{
      id: "cpu-blocking-live-capture",
      title: "Capture the root, schedulers, locks, grants, and live plan",
      purpose: "Collect the evidence that distinguishes brief runnable state from sustained CPU pressure and proves whether the root transaction owns the blocking locks.",
      command: cpuBlockingCollectionCommand(context.headBlockerSessionId, id),
      requiredPermissions: ["VIEW SERVER STATE (SQL Server 2019 and earlier)", "VIEW SERVER PERFORMANCE STATE (SQL Server 2022 and later)"],
      expectedEvidence: ["Same-moment request and cached plan", "Visible scheduler runnable and worker queues", "Root transaction age and granted locks", "Pending and active memory grants", "Compilation counters for repeated comparison"],
      supportedVersions: "SQL Server 2016 and later; permission names vary by version.",
      overhead: "Moderate",
      caution: "Run briefly during the incident. Saving plan XML can be expensive for large plans; do not loop this script continuously.",
      status: "Pending",
      artifactIds: [],
      executionMode: "Read-only",
    }, {
      id: "last-known-actual-plan",
      title: "Try an already-enabled last-known actual plan",
      purpose: "Use only after a live cached-plan lookup returns NULL. This does not enable LAST_QUERY_PLAN_STATS.",
      command: lastKnownActualPlanCommand(context.headBlockerSessionId, id),
      requiredPermissions: ["VIEW SERVER PERFORMANCE STATE (SQL Server 2022+) or VIEW SERVER STATE"],
      expectedEvidence: ["Database-scoped configuration state", "A last-known actual Showplan when already retained"],
      supportedVersions: "SQL Server 2019 and later when LAST_QUERY_PLAN_STATS is already enabled.",
      overhead: "Low",
      caution: "A NULL result is expected when the feature is disabled or the plan is no longer retained.",
      status: "Pending",
      artifactIds: [],
      executionMode: "Read-only",
    }, {
      id: "query-store-history",
      title: "Inspect existing Query Store history",
      purpose: "Use bounded historical evidence only when Query Store is already enabled and contains the confirmed query hash.",
      command: queryStoreExportCommand(id),
      requiredPermissions: ["VIEW DATABASE STATE or an organization-approved equivalent"],
      expectedEvidence: ["Query Store state", "Query and plan IDs", "Compile plans", "Bounded runtime intervals"],
      supportedVersions: "SQL Server 2016 and later. Query Store must already be enabled and populated.",
      overhead: "Low",
      caution: "This script does not enable Query Store. Query Store plans are compile plans unless another source supplies runtime counters.",
      status: "Pending",
      artifactIds: [],
      executionMode: "Read-only",
    }, {
      id: "xe-post-execution-showplan",
      title: "Last resort: narrowly filtered post-execution Showplan",
      purpose: "Capture a rapidly evicted plan only after live, last-known-actual, and Query Store paths are unavailable.",
      command: extendedEventsShowplanCommand(id),
      requiredPermissions: ["Organization change approval", "ALTER ANY EVENT SESSION", "A confirmed database filter"],
      expectedEvidence: ["Post-execution Showplan exported as XML or CSV", "Event timestamp and target session/query identity"],
      supportedVersions: "SQL Server 2016 and later; syntax and permission policy must be reviewed locally.",
      overhead: "High",
      caution: "Administrative and potentially expensive. Apply a narrow filter, run briefly, and execute the included stop/drop cleanup.",
      status: "Pending",
      artifactIds: [],
      executionMode: "Administrative",
      requiresApproval: true,
    }],
    artifacts: [],
    events: [{ occurredAt: createdAt, type: "Case created", summary: `Started from ${finding.title}.` }],
    sensitive: true,
  };
  return evaluateDeepCase(base);
}

function genericCollectionCommand(profileId: DeepProfileId, rootSessionId: number | null): string {
  const target = Number.isInteger(rootSessionId) && (rootSessionId ?? 0) > 0 ? rootSessionId : 0;
  if (profileId === "transaction-blocking") return `/* SQL Evaluate: transaction-owned blocking. Read-only. */\nEXEC dbo.sp_WhoIsActive @get_task_info = 2, @delta_interval = 5, @get_locks = 1, @get_transaction_info = 1, @get_outer_command = 1, @find_block_leaders = 1;`;
  if (profileId === "worker-exhaustion") return `/* SQL Evaluate: worker exhaustion. Read-only; two bounded samples. */
SET NOCOUNT ON;
DECLARE @WorkerSamples table
(
    sample_id tinyint NOT NULL,
    captured_at datetimeoffset NOT NULL,
    active_worker_threads bigint NOT NULL,
    max_worker_threads bigint NOT NULL,
    work_queue_count bigint NOT NULL,
    runnable_tasks_count bigint NOT NULL
);

INSERT @WorkerSamples
SELECT 1, SYSDATETIMEOFFSET(), SUM(CONVERT(bigint, s.active_workers_count)),
       MAX(CONVERT(bigint, i.max_workers_count)), SUM(CONVERT(bigint, s.work_queue_count)),
       SUM(CONVERT(bigint, s.runnable_tasks_count))
FROM sys.dm_os_schedulers AS s
CROSS JOIN sys.dm_os_sys_info AS i
WHERE s.status = 'VISIBLE ONLINE' AND s.scheduler_id < 255;

WAITFOR DELAY '00:00:02';

INSERT @WorkerSamples
SELECT 2, SYSDATETIMEOFFSET(), SUM(CONVERT(bigint, s.active_workers_count)),
       MAX(CONVERT(bigint, i.max_workers_count)), SUM(CONVERT(bigint, s.work_queue_count)),
       SUM(CONVERT(bigint, s.runnable_tasks_count))
FROM sys.dm_os_schedulers AS s
CROSS JOIN sys.dm_os_sys_info AS i
WHERE s.status = 'VISIBLE ONLINE' AND s.scheduler_id < 255;

SELECT 'WORKER_COUNTERS' AS evidence_set, sample_id, captured_at,
       active_worker_threads, max_worker_threads, work_queue_count, runnable_tasks_count
FROM @WorkerSamples
ORDER BY sample_id;

SELECT 'THREADPOOL_REQUESTS' AS evidence_set, SYSDATETIMEOFFSET() AS captured_at,
       session_id, request_id, status, wait_type, wait_time
FROM sys.dm_exec_requests
WHERE wait_type = 'THREADPOOL';`;
  if (profileId === "compile-pressure") return `/* SQL Evaluate: compilation and plan-cache pressure. Read-only; two bounded counter samples. */
SET NOCOUNT ON;
DECLARE @CompilationCounters table
(
    sample_id tinyint NOT NULL,
    captured_at datetimeoffset NOT NULL,
    counter_name nvarchar(128) NOT NULL,
    cntr_value bigint NOT NULL
);

INSERT @CompilationCounters
SELECT 1, SYSDATETIMEOFFSET(), counter_name, cntr_value
FROM sys.dm_os_performance_counters
WHERE object_name LIKE '%:SQL Statistics%'
  AND counter_name IN ('Batch Requests/sec', 'SQL Compilations/sec', 'SQL Re-Compilations/sec');

WAITFOR DELAY '00:00:02';

INSERT @CompilationCounters
SELECT 2, SYSDATETIMEOFFSET(), counter_name, cntr_value
FROM sys.dm_os_performance_counters
WHERE object_name LIKE '%:SQL Statistics%'
  AND counter_name IN ('Batch Requests/sec', 'SQL Compilations/sec', 'SQL Re-Compilations/sec');

SELECT 'COMPILATION_COUNTERS' AS evidence_set, sample_id, captured_at, counter_name, cntr_value
FROM @CompilationCounters
ORDER BY sample_id, counter_name;

SELECT 'PLAN_CACHE_INVENTORY' AS evidence_set, SYSDATETIMEOFFSET() AS captured_at,
       COUNT_BIG(*) AS total_plan_count,
       SUM(CONVERT(bigint, CASE WHEN objtype = 'Adhoc' AND usecounts <= 1 THEN 1 ELSE 0 END)) AS single_use_plan_count,
       SUM(CONVERT(bigint, size_in_bytes)) AS total_size_bytes
FROM sys.dm_exec_cached_plans;`;
  if (profileId === "memory-grants") return `/* SQL Evaluate: execution memory grants. Read-only. */\nSELECT session_id, request_id, request_time, grant_time, requested_memory_kb, granted_memory_kb, used_memory_kb, max_used_memory_kb, wait_time_ms FROM sys.dm_exec_query_memory_grants;\nSELECT session_id, request_id, wait_type, wait_time, granted_query_memory FROM sys.dm_exec_requests WHERE wait_type = 'RESOURCE_SEMAPHORE' OR session_id = ${target};`;
  if (profileId === "plan-specific") return `/* SQL Evaluate: plan-specific follow-up. Read-only cache lookup; a NULL plan is a valid result. */\nDECLARE @TargetSessionId smallint = ${target};\nSELECT r.session_id, r.request_id, r.sql_handle, r.plan_handle, qp.query_plan FROM sys.dm_exec_requests AS r OUTER APPLY sys.dm_exec_query_plan(r.plan_handle) AS qp WHERE @TargetSessionId = 0 OR r.session_id = @TargetSessionId;`;
  if (profileId === "spill-triage") return `/* SQL Evaluate Spill Triage input. SQL Evaluate never executes this script. */\nEXEC dbo.sp_BlitzCache @SortOrder = 'Spills', @Top = 10, @ExpertMode = 1;`;
  return lastKnownActualPlanCommand(target);
}

export function createSpillTriageCase(createdAt = new Date().toISOString(), id = caseId()): DeepAnalysisCase {
  const base: DeepAnalysisCase = {
    schemaVersion: "1.4",
    id,
    profileId: "spill-triage",
    title: "Spill Triage",
    createdAt,
    updatedAt: createdAt,
    sourceReportCreatedAt: createdAt,
    sourceFileNames: [],
    origin: { kind: "manual", label: "Imported sp_BlitzCache spill results" },
    rootSessionId: null,
    rootIdentity: {},
    incidentWindow: { firstObservedAt: null, lastObservedAt: null, overlapQuality: "Unknown", explanation: "The import does not establish an incident window." },
    observations: [],
    captureAttempts: [],
    assertions: [
      assertion("spill-candidates", "Spill candidates", "Numeric BlitzCache spill evidence is available for transparent candidate ranking.", "Not Evaluated", [], ["A supported sp_BlitzCache CSV or workbook export"]),
      assertion("plan-captured", "Matching execution plan", "A plan is connected to the selected candidate through stable SQL Server identity.", "Not Evaluated", [], ["A cached or actual Showplan with stable identity"]),
    ],
    collectionSteps: [],
    artifacts: [],
    events: [{ occurredAt: createdAt, type: "Case created", summary: "Started a manual offline Spill Triage case." }],
    spillTriage: { candidates: [], selectedCandidateId: null, imports: [], plans: [], manualPlanSelections: [] },
    sensitive: true,
  };
  return { ...base, collectionSteps: spillCollectionSteps(undefined, undefined, id) };
}

function controlledActualPlanInstructions(): string {
  return `/* SQL Evaluate: controlled representative actual-plan acquisition.
   ADMINISTRATIVE WORKFLOW — separate approval required.

   1. Open SQL Server Management Studio and select Include Actual Execution Plan.
   2. Use a non-production environment or an approved, representative production execution.
   3. Execute only the reviewed parameterized statement with representative parameters.
   4. Save the resulting execution plan as .sqlplan and import it into this case.

   No workload SQL is included here because executing an unknown statement could change data
   or add material production load. SQL Evaluate never executes this workflow. */`;
}

export function createDeepAnalysisCase(report: AnalysisReport, finding: Finding, createdAt = new Date().toISOString(), id = caseId(), requestedProfile?: DeepProfileId): DeepAnalysisCase {
  const profileId = requestedProfile ?? deepAnalysisProfileForFinding(finding);
  if (!profileId) throw new Error("No Deep Analysis profile applies to this finding.");
  if (profileId === "cpu-backed-blocking") return createCpuBlockingCase(report, finding, createdAt, id);
  if (profileId === "transaction-blocking" && (!finding.blockingContext || finding.ruleId !== "WIA-BLOCKING")) throw new Error("Transaction-owned blocking analysis requires a resolved blocking root.");
  const identity = rootIdentity(report, finding);
  const rootSessionId = identity.sessionId ?? null;
  const relatedTimes = report.records.filter((record) => finding.affectedRecordIds.includes(record.id)).map((record) => record.collectionTime).filter((value): value is string => Boolean(value)).sort();
  const direct = (label: string, statement: string) => assertion(label.toLowerCase().replace(/[^a-z0-9]+/g, "-"), label, statement, "Observed", [`The source finding directly reports: ${finding.title}.`], []);
  const assertions: DeepEvidenceAssertion[] = profileId === "spill-triage" ? [
    direct("Spill candidates", "The source finding reports a runtime spill; imported BlitzCache rows can prioritize the cached variants for investigation."),
    assertion("plan-captured", "Matching execution plan", "A plan is connected to the selected candidate through stable SQL Server identity.", "Not Evaluated", [], ["A cached or actual Showplan with stable identity"]),
  ] : profileId === "transaction-blocking" ? [
    assertion("blocking-chain", "Blocking chain", `SPID ${finding.blockingContext!.headBlockerSessionId} is the captured blocking root.`, "Observed", ["The supplied capture contains the resolved blocking graph."], []),
    assertion("open-transactions", "Open transaction", "The sleeping root retained an open transaction while blocking downstream work.", (finding.blockingContext!.openTransactionCount ?? 0) > 0 ? "Observed" : "Not Evaluated", [`Captured open transaction count: ${finding.blockingContext!.openTransactionCount ?? "unknown"}.`], ["Transaction ownership and start time"]),
    assertion("root-lock-owner", "Lock ownership", "The root transaction owns the lock resources responsible for the victim waits.", "Not Evaluated", [], ["Root granted locks and matching victim wait resources"]),
    assertion("causal-theory", "Working causal theory", "A transaction boundary or idle client retained locks and produced the blocking fan-out.", "Not Evaluated", ["The sleeping root and open transaction make this plausible."], ["Outer command, transaction owner, connection state, and exact lock-resource match"]),
  ] : profileId === "worker-exhaustion" ? [
    direct("Worker exhaustion", "Repeated THREADPOOL waits show requests queued for workers."),
    assertion("worker-ceiling", "Worker ceiling", "Active workers reached the configured worker ceiling while the work queue grew.", "Not Evaluated", [], ["Active_Worker_Threads, Max_Worker_Threads, and Work_Queue_Count samples"]),
    assertion("causal-theory", "Working causal theory", "Instance worker exhaustion reduced availability for all arriving work.", "Not Evaluated", [], ["Worker ceiling and queue correlation", "Concurrency source"]),
  ] : profileId === "compile-pressure" ? [
    direct("Compile semaphore", "Persistent RESOURCE_SEMAPHORE_QUERY_COMPILE waits show compile-memory contention."),
    assertion("compilation-pressure", "Compilation pressure", "Compilation activity is high relative to incoming batches.", "Not Evaluated", [], ["Repeated compilation and batch counters"]),
    assertion("plan-cache-pressure", "Plan-cache pressure", "Single-use ad-hoc plans and falling cache reuse contribute to compilation pressure.", "Not Evaluated", [], ["Single-use plan inventory and cache-hit movement"]),
    assertion("causal-theory", "Working causal theory", "Literal statement variants drove repeated compilation and compile-memory contention.", "Not Evaluated", [], ["Time-aligned counters and plan-cache inventory"]),
  ] : profileId === "memory-grants" ? [
    direct("Memory grant symptom", "The source evidence reports a workspace-memory grant or spill concern."),
    assertion("memory-grant-pressure", "Memory grant pressure", "Pending grants reduced query concurrency during the incident.", "Not Evaluated", [], ["Pending grants and RESOURCE_SEMAPHORE persistence"]),
    assertion("plan-captured", "Actual execution plan", "A representative actual plan supplies grant use, spills, and runtime row counts.", finding.ruleId.startsWith("PLAN-") && finding.ruleId !== "PLAN-RUNTIME-UNAVAILABLE" ? "Observed" : "Not Evaluated", finding.ruleId.startsWith("PLAN-") ? ["The source finding came from Showplan evidence."] : [], ["Representative actual plan"]),
    assertion("causal-theory", "Working causal theory", "Estimate or grant-sizing problems caused spill or concurrency pressure.", "Not Evaluated", [], ["Time-aligned server grant pressure and representative runtime plan"]),
  ] : profileId === "plan-specific" ? [
    direct("Plan cause", "Showplan directly reports a plan-specific diagnostic cause."),
    assertion("plan-captured", "Execution plan", "A plan for the responsible statement is available for operator analysis.", "Observed", ["The source finding is based on imported Showplan XML."], []),
    assertion("causal-theory", "Working causal theory", "The direct plan cause explains the associated runtime or resource symptoms.", "Not Evaluated", [], ["Representative runtime comparison after remediation"]),
  ] : [
    assertion("plan-captured", "Representative actual plan", "An actual plan with runtime counters was captured safely.", "Not Evaluated", [], ["Actual versus estimated rows, spills, grant use, elapsed time, and CPU"]),
  ];
  const collectionSteps: DeepAnalysisCase["collectionSteps"] = profileId === "actual-plan" ? [{
    id: "last-known-actual-plan",
    title: "Try an already-enabled last-known actual plan",
    purpose: "Use a read-only lookup when an active target session is known and LAST_QUERY_PLAN_STATS is already enabled.",
    command: lastKnownActualPlanCommand(rootSessionId, id),
    requiredPermissions: ["VIEW SERVER PERFORMANCE STATE (SQL Server 2022+) or VIEW SERVER STATE"],
    expectedEvidence: ["Configuration state", "A retained Showplan containing runtime counters"],
    supportedVersions: "SQL Server 2019 and later when LAST_QUERY_PLAN_STATS is already enabled.",
    overhead: "Low",
    caution: rootSessionId ? "A NULL result is valid when the plan was not retained." : "No target session was identified; set a confirmed active session ID before running this lookup.",
    status: "Pending",
    artifactIds: [],
    executionMode: "Read-only",
  }, {
    id: "controlled-actual-plan",
    title: "Capture a controlled representative actual plan",
    purpose: "Acquire runtime counters without inventing conclusions from the estimated plan.",
    command: controlledActualPlanInstructions(),
    requiredPermissions: ["Approved workload execution context", "SHOWPLAN permission in the target database"],
    expectedEvidence: ["Actual versus estimated rows", "Runtime spills", "Granted versus used memory", "Runtime operator counters"],
    supportedVersions: "Supported SQL Server versions and SSMS clients that can save actual execution plans.",
    overhead: "Moderate",
    caution: "Executing a workload statement can change data or add load. Use only a reviewed statement and an approved environment.",
    status: "Pending",
    artifactIds: [],
    executionMode: "Administrative",
    requiresApproval: true,
  }] : [{ id: `${profileId}-capture`, title: `Collect ${profileLabel(profileId).toLowerCase()} evidence`, purpose: "Import the bounded evidence needed to support or contradict the working theory.", command: genericCollectionCommand(profileId, rootSessionId), requiredPermissions: ["VIEW SERVER STATE or VIEW SERVER PERFORMANCE STATE as applicable"], expectedEvidence: assertions.flatMap((item) => item.missingEvidence).slice(0, 8), supportedVersions: "SQL Server 2016 and later; permissions vary by version.", overhead: "Low", caution: "Run briefly under approved production-access procedures. SQL Evaluate never executes this script.", status: "Pending", artifactIds: [], executionMode: "Read-only" }];
  const base: DeepAnalysisCase = {
    schemaVersion: "1.4", id, profileId, title: `${profileLabel(profileId)}${rootSessionId ? ` / SPID ${rootSessionId}` : ""}`, createdAt, updatedAt: createdAt,
    sourceReportCreatedAt: report.createdAt, sourceFileNames: report.inputs.map((input) => input.fileName),
    sourceFinding: { id: finding.id, ruleId: finding.ruleId, severity: finding.severity, confidence: finding.confidence, category: finding.category, title: finding.title, summary: finding.summary, evidence: finding.evidence, blockingContext: finding.blockingContext },
    origin: { kind: "finding", finding: { id: finding.id, ruleId: finding.ruleId, severity: finding.severity, confidence: finding.confidence, category: finding.category, title: finding.title, summary: finding.summary, evidence: finding.evidence, blockingContext: finding.blockingContext } },
    rootSessionId, rootIdentity: identity,
    incidentWindow: { firstObservedAt: relatedTimes[0] ?? finding.firstSeen ?? null, lastObservedAt: relatedTimes.at(-1) ?? finding.lastSeen ?? null, overlapQuality: relatedTimes.length ? "Exact" : "Unknown", explanation: relatedTimes.length ? "The incident window comes from affected capture timestamps." : "No usable capture boundary was supplied." },
    observations: [], captureAttempts: [], assertions,
    collectionSteps,
    artifacts: [], events: [{ occurredAt: createdAt, type: "Case created", summary: `Started ${profileLabel(profileId)} from ${finding.title}.` }], spillTriage: profileId === "spill-triage" ? { candidates: [], selectedCandidateId: null, imports: [], plans: [], manualPlanSelections: [] } : undefined, sensitive: true,
  };
  if (profileId === "spill-triage") base.collectionSteps = spillCollectionSteps(base.spillTriage?.candidates[0], undefined, id);
  return evaluateDeepCase(base);
}

async function sha256Bytes(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function sha256File(file: File): Promise<string> {
  return sha256Bytes(await file.arrayBuffer());
}

interface InspectedEvidence {
  artifact: DeepCaseArtifact;
  observations: DeepEvidenceObservation[];
  spillCandidates: SpillCandidate[];
  spillImports: SpillImportSummary[];
  spillPlans: SpillPlanEvidence[];
  capabilitySnapshots: ServerCapabilitySnapshot[];
  messages: EvidenceImportMessage[];
}

interface EmbeddedPlanCell {
  xml: string;
  identity: DeepQueryIdentity;
  sourceKind?: PlanSourceKind;
}

function normalizedIdentityValue(value: unknown): string | number | null {
  if (value === null || value === undefined || value === "") return null;
  return typeof value === "number" ? value : String(value).trim().toLowerCase();
}

function enrichPlanWithSidecar(plan: PlanDocument, sidecar: DeepQueryIdentity): { plan: PlanDocument; warning?: string } {
  const statements = plan.statements;
  const exactOffsets = sidecar.statementStartOffset != null && sidecar.statementEndOffset != null
    ? statements.filter((statement) => statement.queryIdentity?.statementStartOffset === sidecar.statementStartOffset && statement.queryIdentity?.statementEndOffset === sidecar.statementEndOffset)
    : [];
  const pairedHashes = sidecar.queryHash && sidecar.queryPlanHash
    ? statements.filter((statement) => normalizedIdentityValue(statement.queryIdentity?.queryHash) === normalizedIdentityValue(sidecar.queryHash) && normalizedIdentityValue(statement.queryIdentity?.queryPlanHash) === normalizedIdentityValue(sidecar.queryPlanHash))
    : [];
  const queryStore = sidecar.queryStoreQueryId != null && sidecar.queryStorePlanId != null
    ? statements.filter((statement) => statement.queryIdentity?.queryStoreQueryId === sidecar.queryStoreQueryId && statement.queryIdentity?.queryStorePlanId === sidecar.queryStorePlanId)
    : [];
  const targets = exactOffsets.length === 1 ? exactOffsets : pairedHashes.length === 1 ? pairedHashes : queryStore.length === 1 ? queryStore : statements.length === 1 ? statements : [];
  if (targets.length !== 1) return { plan, warning: "Stable sidecar identity was preserved, but it could not be assigned to exactly one statement in the embedded Showplan." };
  const target = targets[0];
  const current = target.queryIdentity ?? {};
  const fields: Array<keyof PlanQueryIdentity> = ["sqlHandle", "planHandle", "queryHash", "queryPlanHash", "statementStartOffset", "statementEndOffset", "queryStoreQueryId", "queryStorePlanId", "databaseId"];
  const conflicts = fields.filter((field) => normalizedIdentityValue(current[field]) !== null && normalizedIdentityValue(sidecar[field]) !== null && normalizedIdentityValue(current[field]) !== normalizedIdentityValue(sidecar[field]));
  // SQL Server can emit a statement SqlHandle in a cached Showplan that differs
  // from the sql_handle on the exact dm_exec_query_stats row. An exact sidecar
  // plan_handle is more specific provenance in that case. A contradictory plan
  // handle (or any other conflict) still prevents automatic merging.
  const sidecarPlanMatches = sidecar.planHandle
    && (!current.planHandle || normalizedIdentityValue(current.planHandle) === normalizedIdentityValue(sidecar.planHandle));
  // Query Store compile plans can expose StatementSqlHandle, which is not the
  // plan-cache batch sql_handle carried by dm_exec_query_stats. A fully scoped
  // Query Store sidecar is authoritative for correlation and must not retain
  // that embedded value as a comparable batch handle.
  const scopedQueryStoreSidecar = plan.sourceKind === "Query Store"
    && sidecar.queryStoreQueryId != null
    && sidecar.queryStorePlanId != null
    && sidecar.databaseId != null;
  const sidecarOwnsSqlHandle = Boolean(sidecarPlanMatches || scopedQueryStoreSidecar);
  const blockingConflicts = conflicts.filter((field) => field !== "sqlHandle" || !sidecarOwnsSqlHandle);
  if (blockingConflicts.length) return { plan, warning: `Showplan identity conflicts with its result-row provenance for ${blockingConflicts.join(", ")}; SQL Evaluate did not merge the sidecar identity.` };
  const planSidecar = Object.fromEntries(fields.map((field) => [field, sidecar[field]]).filter(([, value]) => value !== null && value !== undefined && value !== ""));
  const embeddedIdentity = Object.fromEntries(Object.entries(current)
    .filter(([field, value]) => value !== null && value !== undefined && value !== "" && !(field === "sqlHandle" && sidecarOwnsSqlHandle))) as PlanQueryIdentity;
  const merged = { ...planSidecar, ...embeddedIdentity } as PlanQueryIdentity;
  return { plan: { ...plan, statements: statements.map((statement) => statement.id === target.id ? { ...statement, queryIdentity: merged } : statement) } };
}

function supportedEvidenceFile(fileName: string, profileId: DeepProfileId): boolean {
  const lower = fileName.toLowerCase();
  const extensions = profileId === "spill-triage"
    ? [".csv", ".tsv", ".xlsx", ".xls", ".sqlplan", ".xml"]
    : [".csv", ".tsv", ".xlsx", ".xls", ".sqlplan", ".xml", ".json", ".txt"];
  return extensions.some((extension) => lower.endsWith(extension));
}

function readFailureMessage(file: File): string {
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) return "The workbook could not be read. Confirm it is not password-protected or corrupted, then save a fresh copy and retry.";
  if (lower.endsWith(".sqlplan") || lower.endsWith(".xml")) return "The execution plan could not be read. Confirm it is raw SQL Server Showplan XML and retry.";
  return "The evidence file could not be read. Confirm the file is accessible and not corrupted, then retry.";
}

async function inspectEvidenceFile(file: File, rootSessionId: number | null, importedAt: string): Promise<InspectedEvidence> {
  if (file.size > CASE_SIZE_LIMIT) throw new Error(`${file.name}: evidence files are limited to 100 MB.`);
  const bytes = await file.arrayBuffer();
  const hash = await sha256Bytes(bytes);
  const artifactId = `artifact-${hash.slice(0, 16)}`;
  const lower = file.name.toLowerCase();
  const signals = new Set<string>();
  const details: string[] = [];
  const warnings: string[] = [];
  const observations: DeepEvidenceObservation[] = [];
  const resultSetTypes = new Set<string>();
  let kind: DeepCaseArtifact["kind"] = "Diagnostic result";
  let adapterId = "raw-attachment";
  let adapterVersion = "1.0";
  let capturedAt: string | null = null;
  let identity: DeepQueryIdentity | undefined;
  const embeddedPlans: EmbeddedPlanCell[] = [];
  const spillCandidates: SpillCandidate[] = [];
  const spillImports: SpillImportSummary[] = [];
  const spillPlans: SpillPlanEvidence[] = [];
  const capabilitySnapshots: ServerCapabilitySnapshot[] = [];
  const messages: EvidenceImportMessage[] = [];

  const mergeMatrix = (matrix: unknown[][], prefix?: string) => {
    const capability = parseCapabilitySnapshot(matrix, artifactId);
    if (capability.recognized) {
      adapterId = "sql-evaluate-capabilities";
      resultSetTypes.add("SERVER_CAPABILITIES");
      if (capability.snapshot) {
        capabilitySnapshots.push(capability.snapshot);
        signals.add("server-capabilities");
        details.push(`Server capabilities: SQL Server ${capability.snapshot.productVersion}${capability.snapshot.edition ? ` ${capability.snapshot.edition}` : ""}; ${capability.snapshot.tools.filter((tool) => tool.installed).length} installed diagnostic object${capability.snapshot.tools.filter((tool) => tool.installed).length === 1 ? "" : "s"} detected.`);
        warnings.push(...capability.snapshot.warnings);
        if (capability.stale) messages.push({ fileName: file.name, severity: "warning", code: "capability-stale", message: capability.snapshot.warnings.find((warning) => warning.includes("days old")) ?? "The capability snapshot may be stale." });
      } else {
        const message = capability.error ?? "The capability snapshot is malformed.";
        warnings.push(message);
        messages.push({ fileName: file.name, severity: "error", code: "capability-invalid", message });
      }
    }
    const result = inspectEvidenceMatrix(matrix, rootSessionId, artifactId);
    result.signals.forEach((signal) => signals.add(signal));
    result.resultSetTypes.forEach((type) => resultSetTypes.add(type));
    const observationOffset = observations.length;
    observations.push(...result.observations.map((item, index) => ({ ...item, id: `${artifactId}-obs-${observationOffset + index}` })));
    warnings.push(...result.warnings);
    if (result.kind !== "Diagnostic result") kind = result.kind;
    if (result.adapterId !== "generic-tabular") adapterId = result.adapterId;
    adapterVersion = result.adapterVersion;
    capturedAt ??= result.capturedAt;
    identity ??= result.identity;
    details.push(...result.details.map((detail) => prefix ? `${prefix}: ${detail}` : detail));
    const spill = inspectSpillTriageMatrix(matrix, { artifactId, fileName: file.name, sheetName: prefix ?? null, sourceOffset: spillCandidates.length });
    spillCandidates.push(...spill.candidates);
    if (spill.summary) spillImports.push(spill.summary);
    const headerRows = matrix
      .map((row, index) => ({ row, index, headers: row.map(normalizeEvidenceHeader) }))
      .filter(({ row }) => row.some((value) => String(value ?? "").trim()))
      .slice(0, 50);
    const spillHeader = spill.summary ? headerRows.find(({ index }) => index === (spill.summary?.headerRow ?? 0) - 1) : undefined;
    const planHeader = spillHeader && ["query_plan", "showplan_xml", "last_query_plan"].some((name) => spillHeader.headers.includes(name))
      ? spillHeader
      : spill.summary ? undefined : headerRows.find(({ headers }) => ["query_plan", "showplan_xml", "last_query_plan"].some((name) => headers.includes(name)));
    const planIndex = planHeader ? ["query_plan", "showplan_xml", "last_query_plan"].map((name) => planHeader.headers.indexOf(name)).find((index) => index >= 0) ?? -1 : -1;
    if (planHeader && planIndex >= 0) matrix.slice(planHeader.index + 1).forEach((row) => {
      const xml = String(row[planIndex] ?? "").trim();
      if (/<\s*(?:\w+:)?ShowPlanXML\b/i.test(xml)) {
        const evidenceSetIndex = planHeader.headers.indexOf("evidence_set");
        const evidenceSet = evidenceSetIndex >= 0 ? String(row[evidenceSetIndex] ?? "").trim().toUpperCase() : "";
        const sourceKind: PlanSourceKind | undefined = evidenceSet === "LAST_KNOWN_ACTUAL_PLAN" ? "Last-known actual" : evidenceSet === "QUERY_STORE" ? "Query Store" : evidenceSet === "EXTENDED_EVENTS" ? "Extended Events" : evidenceSet === "CACHED_PLAN_PROVENANCE" || evidenceSet === "REQUEST_PLAN" ? "Cached estimated" : undefined;
        embeddedPlans.push({ xml, identity: identityFromRow(planHeader.headers, row), sourceKind });
      }
    });
  };

  if (lower.endsWith(".sqlplan") || lower.endsWith(".xml")) {
    try {
      const xml = decodeText(bytes);
      const { parseShowplan } = await import("../lib/showplan");
      const plan = parseShowplan(xml, `deep-${hash.slice(0, 12)}`, file.name);
      spillPlans.push({ artifactId, fileName: file.name, plan });
      signals.add("plan-captured");
      adapterId = "showplan";
      kind = "Execution plan";
      resultSetTypes.add("SHOWPLAN");
      const statementIdentity = plan.statements.find((statement) => statement.queryIdentity && Object.values(statement.queryIdentity).some((value) => value != null))?.queryIdentity;
      identity = statementIdentity;
      capturedAt = xml.match(/SQL_EVALUATE_CAPTURED_AT\s*=\s*([^\s<>]+)/i)?.[1] ?? null;
      details.push(`${plan.statements.length} statement${plan.statements.length === 1 ? "" : "s"}; ${plan.sourceKind ?? (plan.isActual ? "actual" : "estimated or cached")} plan evidence.`);
      if (plan.isActual) signals.add("actual-plan");
      if (plan.statements.some((statement) => statement.warnings.length || statement.operators.some((operator) => operator.warnings.length))) signals.add("plan-warning");
      const nonparallel = plan.statements.map((statement) => statement.nonParallelPlanReason).filter((value): value is string => Boolean(value));
      if (nonparallel.length) { signals.add("nonparallel-reason"); details.push(`Nonparallel reason: ${[...new Set(nonparallel)].join(", ")}.`); }
      const wastedGrants = plan.statements.map((statement) => statement.memoryGrant).filter((grant) => grant && grant.grantedKb > 0 && grant.grantedKb >= Math.max(1, grant.usedKb) * 4);
      if (wastedGrants.length) { signals.add("unused-memory-grant"); signals.add("plan-memory-overgrant"); details.push("The plan contains a workspace-memory grant at least four times maximum used memory."); }
      if (plan.statements.some((statement) => statement.operators.some((operator) => operator.hasScalarFunction))) signals.add("filter-udf");
      if (plan.statements.some((statement) => statement.operators.some((operator) => Boolean(operator.residualPredicate || operator.nonSargablePredicate)))) signals.add("non-sargable");
      if (!plan.statements.some((statement) => hasCorrelationReadyIdentity(statement.queryIdentity))) {
        const message = "Showplan imported successfully, but it contains no correlation-ready stable identity (plan_handle; sql_handle; query_hash plus query_plan_hash; or Query Store IDs plus database ID). It can be reviewed as plan evidence but cannot be connected automatically to a spill candidate.";
        warnings.push(message);
        messages.push({ fileName: file.name, severity: "warning", code: "plan-identity-missing", message });
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : "The file could not be parsed as SQL Server Showplan XML.";
      details.push(`XML was attached but not recognized as Showplan: ${reason}`);
      warnings.push("The XML attachment was preserved for provenance but cannot drive plan assertions.");
      messages.push({ fileName: file.name, severity: "error", code: "plan-invalid", message: `${reason} The file was preserved for provenance but was not added as usable plan evidence.` });
    }
  } else if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) {
    const XLSX = await import("xlsx");
    const workbook = XLSX.read(bytes, { type: "array", dense: true, cellDates: true });
    const ignoredSheets: Array<{ sheetName: string; reason: string }> = [];
    for (const sheetName of workbook.SheetNames) {
      const matrix = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: true, defval: null }) as unknown[][];
      const importsBefore = spillImports.length;
      mergeMatrix(matrix, sheetName);
      if (spillImports.length === importsBefore) ignoredSheets.push({ sheetName, reason: "No supported spill header was detected." });
    }
    for (const summary of spillImports) summary.ignoredSheets = ignoredSheets;
  } else {
    const text = decodeText(bytes);
    let matrix: unknown[][];
    if (lower.endsWith(".json")) {
      try {
        const parsed = JSON.parse(text) as unknown;
        const rows = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" && Array.isArray((parsed as { rows?: unknown[] }).rows) ? (parsed as { rows: unknown[] }).rows : [];
        if (rows.length && rows.every((row) => row && typeof row === "object" && !Array.isArray(row))) {
          const headers = [...new Set(rows.flatMap((row) => Object.keys(row as Record<string, unknown>)))];
          matrix = [headers, ...rows.map((row) => headers.map((header) => (row as Record<string, unknown>)[header] ?? null))];
        } else matrix = [["payload"], [text]];
      } catch { matrix = [["payload"], [text]]; }
    } else matrix = lower.endsWith(".csv") || lower.endsWith(".tsv") ? parseCsv(text) : [["payload"], [text]];
    mergeMatrix(matrix);
  }

  if (embeddedPlans.length) {
    const { parseShowplan } = await import("../lib/showplan");
    for (const [index, embedded] of embeddedPlans.slice(0, 25).entries()) {
      try {
        const parsed = parseShowplan(embedded.xml, `${adapterId}-${hash.slice(0, 12)}-${index}`, `${adapterId}-${file.name}`);
        const enriched = enrichPlanWithSidecar({ ...parsed, sourceKind: embedded.sourceKind ?? parsed.sourceKind }, embedded.identity);
        const plan = enriched.plan;
        spillPlans.push({ artifactId, fileName: file.name, plan });
        if (enriched.warning) {
          warnings.push(enriched.warning);
          messages.push({ fileName: file.name, severity: "warning", code: enriched.warning.includes("conflicts") ? "plan-identity-conflict" : "plan-identity-missing", message: enriched.warning });
        }
        const statementIdentity = plan.statements.find((statement) => statement.queryIdentity && Object.values(statement.queryIdentity).some((value) => value != null))?.queryIdentity;
        identity ??= statementIdentity;
        if (plan.isActual) signals.add("actual-plan");
        const nonparallel = plan.statements.map((statement) => statement.nonParallelPlanReason).filter((value): value is string => Boolean(value));
        if (nonparallel.length) { signals.add("nonparallel-reason"); details.push(`Embedded plan nonparallel reason: ${[...new Set(nonparallel)].join(", ")}.`); }
        if (plan.statements.some((statement) => statement.warnings.length || statement.operators.some((operator) => operator.warnings.length))) signals.add("plan-warning");
        if (plan.statements.some((statement) => statement.operators.some((operator) => operator.hasScalarFunction))) signals.add("filter-udf");
        if (plan.statements.some((statement) => statement.memoryGrant && statement.memoryGrant.grantedKb > 0 && statement.memoryGrant.grantedKb >= Math.max(1, statement.memoryGrant.usedKb) * 4)) { signals.add("unused-memory-grant"); signals.add("plan-memory-overgrant"); }
      } catch (error) {
        warnings.push(`An embedded Showplan cell could not be parsed: ${error instanceof Error ? error.message : "parse error"}`);
      }
    }
    if (embeddedPlans.length > 25) warnings.push(`${embeddedPlans.length - 25} additional embedded plans were preserved but not expanded in this case import.`);
  }

  return { artifact: {
    id: artifactId,
    fileName: file.name,
    size: file.size,
    sha256: hash,
    importedAt,
    kind,
    summary: details.length ? details.join(" ") : "Attached for provenance; no supported diagnostic shape was recognized.",
    signals: [...signals].sort(),
    adapterId,
    adapterVersion,
    capturedAt,
    resultSetTypes: [...resultSetTypes].sort(),
    identity,
    warnings,
  }, observations, spillCandidates, spillImports, spillPlans, capabilitySnapshots, messages };
}

function validManualPlanSelections(spillTriage: SpillTriageState): SpillManualPlanSelection[] {
  return spillTriage.manualPlanSelections.filter((selection) => {
    const candidate = spillTriage.candidates.find((item) => item.id === selection.candidateId);
    if (!candidate) return false;
    const resolution = resolveCandidatePlan(candidate, spillTriage.plans);
    return resolution.ambiguous && resolution.alternatives.some((alternative) => alternative.artifactId === selection.artifactId && alternative.statementId === selection.statementId);
  });
}

export async function addEvidenceFiles(deepCase: DeepAnalysisCase, files: File[], importedAt = new Date().toISOString()): Promise<{ deepCase: DeepAnalysisCase; acceptedFiles: File[]; messages: EvidenceImportMessage[] }> {
  const existing = new Set(deepCase.artifacts.map((artifact) => artifact.sha256));
  const uniqueFiles: File[] = [];
  const messages: EvidenceImportMessage[] = [];
  for (const file of files) {
    if (!supportedEvidenceFile(file.name, deepCase.profileId)) {
      messages.push({ fileName: file.name, severity: "error", code: "unsupported-type", message: deepCase.profileId === "spill-triage" ? "This file type is not supported here. Use CSV, TSV, XLSX, XLS, SQLPLAN, or XML evidence." : "This file type is not supported here. Use CSV, TSV, XLSX, XLS, SQLPLAN, XML, JSON, or TXT evidence." });
      continue;
    }
    if (file.size === 0) {
      messages.push({ fileName: file.name, severity: "error", code: "empty-file", message: "The file is empty and was not imported." });
      continue;
    }
    if (file.size > CASE_SIZE_LIMIT) {
      messages.push({ fileName: file.name, severity: "error", code: "read-failed", message: "The file exceeds the 100 MB evidence limit and was not imported." });
      continue;
    }
    try {
      const hash = await sha256File(file);
      if (existing.has(hash)) {
        messages.push({ fileName: file.name, severity: "info", code: "duplicate", message: "Identical evidence is already in this case, so this copy was skipped. Renaming does not change duplicate detection." });
        continue;
      }
      existing.add(hash);
      uniqueFiles.push(file);
    } catch {
      messages.push({ fileName: file.name, severity: "error", code: "read-failed", message: readFailureMessage(file) });
    }
  }
  const inspected = await Promise.allSettled(uniqueFiles.map((file) => inspectEvidenceFile(file, deepCase.rootSessionId, importedAt)));
  const accepted: InspectedEvidence[] = [];
  const acceptedFiles: File[] = [];
  inspected.forEach((result, index) => {
    if (result.status === "fulfilled") {
      accepted.push(result.value);
      acceptedFiles.push(uniqueFiles[index]);
      messages.push(...result.value.messages);
    } else {
      messages.push({ fileName: uniqueFiles[index].name, severity: "error", code: "read-failed", message: readFailureMessage(uniqueFiles[index]) });
    }
  });
  const artifacts = accepted.map((item) => item.artifact);
  const observations = accepted.flatMap((item) => item.observations);
  const priorSpill = deepCase.spillTriage ?? { candidates: [], selectedCandidateId: null, imports: [], plans: [], manualPlanSelections: [] };
  const combinedCandidates = rankSpillCandidates([...priorSpill.candidates, ...accepted.flatMap((item) => item.spillCandidates)].map((candidate, index) => ({ ...candidate, sourceOrder: index })));
  const nextSpill = deepCase.profileId === "spill-triage" || combinedCandidates.length || accepted.some((item) => item.spillPlans.length)
    ? {
      candidates: combinedCandidates,
      selectedCandidateId: priorSpill.selectedCandidateId && combinedCandidates.some((candidate) => candidate.id === priorSpill.selectedCandidateId) ? priorSpill.selectedCandidateId : combinedCandidates.find((candidate) => candidate.rank === 1)?.id ?? combinedCandidates[0]?.id ?? null,
      imports: [...priorSpill.imports, ...accepted.flatMap((item) => item.spillImports)],
      plans: [...priorSpill.plans, ...accepted.flatMap((item) => item.spillPlans)],
      manualPlanSelections: priorSpill.manualPlanSelections ?? [],
    } : undefined;
  const spillTriage = nextSpill ? { ...nextSpill, manualPlanSelections: validManualPlanSelections(nextSpill) } : undefined;
  const importedSnapshots = accepted.flatMap((item) => item.capabilitySnapshots).sort((left, right) => right.capturedAt.localeCompare(left.capturedAt));
  const serverCapabilities = importedSnapshots[0] ?? deepCase.serverCapabilities;
  const selectedCandidate = spillTriage?.candidates.find((candidate) => candidate.id === spillTriage.selectedCandidateId) ?? spillTriage?.candidates[0];
  const collectionSteps = deepCase.profileId === "spill-triage" ? spillCollectionSteps(selectedCandidate, serverCapabilities, deepCase.id) : deepCase.collectionSteps;
  const updated = evaluateDeepCase({
    ...deepCase,
    schemaVersion: "1.4",
    updatedAt: importedAt,
    artifacts: [...deepCase.artifacts, ...artifacts],
    observations: [...(deepCase.observations ?? []), ...observations],
    spillTriage,
    serverCapabilities,
    collectionSteps,
    events: artifacts.length ? [...deepCase.events, { occurredAt: importedAt, type: "Evidence imported", summary: `${artifacts.length} evidence file${artifacts.length === 1 ? "" : "s"} attached and evaluated.` }] : deepCase.events,
  });
  return { deepCase: updated, acceptedFiles, messages };
}

export function selectSpillCandidate(deepCase: DeepAnalysisCase, candidateId: string): DeepAnalysisCase {
  if (!deepCase.spillTriage?.candidates.some((candidate) => candidate.id === candidateId)) return deepCase;
  const spillTriage = { ...deepCase.spillTriage, selectedCandidateId: candidateId };
  const candidate = spillTriage.candidates.find((item) => item.id === candidateId);
  return evaluateDeepCase({ ...deepCase, updatedAt: new Date().toISOString(), spillTriage, collectionSteps: spillCollectionSteps(candidate, deepCase.serverCapabilities, deepCase.id) });
}

export function chooseSpillPlanStatement(deepCase: DeepAnalysisCase, candidateId: string, artifactId: string, statementId: string, selectedAt = new Date().toISOString()): DeepAnalysisCase {
  if (!deepCase.spillTriage) return deepCase;
  const candidate = deepCase.spillTriage.candidates.find((item) => item.id === candidateId);
  if (!candidate) return deepCase;
  const resolution = resolveCandidatePlan(candidate, deepCase.spillTriage.plans);
  if (!resolution.ambiguous || !resolution.alternatives.some((alternative) => alternative.artifactId === artifactId && alternative.statementId === statementId)) return deepCase;
  const selection = { candidateId, artifactId, statementId, selectedAt };
  const manualPlanSelections = [...(deepCase.spillTriage.manualPlanSelections ?? []).filter((item) => item.candidateId !== candidateId), selection];
  return evaluateDeepCase({ ...deepCase, updatedAt: selectedAt, spillTriage: { ...deepCase.spillTriage, manualPlanSelections } });
}

export function clearSpillPlanStatement(deepCase: DeepAnalysisCase, candidateId: string, clearedAt = new Date().toISOString()): DeepAnalysisCase {
  if (!deepCase.spillTriage?.manualPlanSelections?.some((item) => item.candidateId === candidateId)) return deepCase;
  return evaluateDeepCase({ ...deepCase, updatedAt: clearedAt, spillTriage: { ...deepCase.spillTriage, manualPlanSelections: deepCase.spillTriage.manualPlanSelections.filter((item) => item.candidateId !== candidateId) } });
}

function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).at(-1) || "evidence";
  return base.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_").replace(/[. ]+$/g, "") || "evidence";
}

function normalizeServerCapabilitySnapshot(value: unknown): ServerCapabilitySnapshot {
  if (!value || typeof value !== "object") throw new Error("The server capability snapshot in this case is malformed.");
  const snapshot = value as Partial<ServerCapabilitySnapshot>;
  const permissions = snapshot.permissions as Partial<ServerCapabilitySnapshot["permissions"]> | undefined;
  const nullableString = (item: unknown) => item === null || typeof item === "string";
  const nullableNumber = (item: unknown) => item === null || typeof item === "number" && Number.isFinite(item);
  const nullableBoolean = (item: unknown) => item === null || item === undefined || typeof item === "boolean";
  const validTool = (item: unknown) => {
    if (!item || typeof item !== "object") return false;
    const tool = item as Partial<ServerCapabilitySnapshot["tools"][number]>;
    return typeof tool.toolId === "string" && typeof tool.objectName === "string" && typeof tool.installed === "boolean"
      && nullableString(tool.databaseName) && nullableString(tool.schemaName) && nullableBoolean(tool.compatibleSignature)
      && nullableString(tool.version) && nullableString(tool.versionDate)
      && Array.isArray(tool.detectedParameters) && tool.detectedParameters.every((parameter) => typeof parameter === "string");
  };
  const valid = snapshot.schemaVersion === "1.0" && snapshot.adapterId === "SQL_EVALUATE_CAPABILITIES_V1"
    && typeof snapshot.capturedAt === "string" && Number.isFinite(new Date(snapshot.capturedAt).getTime())
    && typeof snapshot.sourceArtifactId === "string" && typeof snapshot.productVersion === "string" && /^\d+(?:\.\d+){1,3}$/.test(snapshot.productVersion)
    && nullableString(snapshot.serverName) && nullableString(snapshot.productLevel) && nullableString(snapshot.edition)
    && nullableNumber(snapshot.engineEdition) && nullableNumber(snapshot.databaseId) && nullableString(snapshot.databaseName)
    && ["ON", "OFF", "UNAVAILABLE", "UNKNOWN"].includes(snapshot.lastQueryPlanStats ?? "") && nullableString(snapshot.queryStoreState)
    && permissions && nullableBoolean(permissions.viewServerState) && nullableBoolean(permissions.viewServerPerformanceState)
    && nullableBoolean(permissions.viewDatabaseState) && nullableBoolean(permissions.viewDatabasePerformanceState)
    && Array.isArray(snapshot.tools) && snapshot.tools.every(validTool)
    && Array.isArray(snapshot.warnings) && snapshot.warnings.every((warning) => typeof warning === "string");
  if (!valid || !permissions) throw new Error("The server capability snapshot in this case is malformed.");
  return {
    ...snapshot,
    permissions: {
      viewServerState: permissions.viewServerState ?? null,
      viewServerPerformanceState: permissions.viewServerPerformanceState ?? null,
      viewDatabaseState: permissions.viewDatabaseState ?? null,
      viewDatabasePerformanceState: permissions.viewDatabasePerformanceState ?? null,
    },
  } as ServerCapabilitySnapshot;
}

function validateCase(value: unknown): DeepAnalysisCase {
  if (!value || typeof value !== "object") throw new Error("Case JSON is not an object.");
  const candidate = value as Partial<DeepAnalysisCase>;
  const supportedProfiles: DeepProfileId[] = ["cpu-backed-blocking", "transaction-blocking", "worker-exhaustion", "compile-pressure", "memory-grants", "plan-specific", "actual-plan", "spill-triage"];
  if ((candidate.schemaVersion !== "1.0" && candidate.schemaVersion !== "1.1" && candidate.schemaVersion !== "1.2" && candidate.schemaVersion !== "1.3" && candidate.schemaVersion !== "1.4") || typeof candidate.id !== "string" || !candidate.profileId || !supportedProfiles.includes(candidate.profileId)) throw new Error("Unsupported or malformed Deep Analysis case.");
  if (!Array.isArray(candidate.assertions) || !Array.isArray(candidate.collectionSteps) || !Array.isArray(candidate.artifacts) || !Array.isArray(candidate.events)) throw new Error("Deep Analysis case is missing required collections.");
  if (candidate.profileId !== "spill-triage" && (!candidate.sourceFinding || typeof candidate.sourceFinding.title !== "string")) throw new Error("Deep Analysis case is missing its source finding.");
  const deepCase = candidate as DeepAnalysisCase;
  const serverCapabilities = deepCase.serverCapabilities ? normalizeServerCapabilitySnapshot(deepCase.serverCapabilities) : undefined;
  if (deepCase.schemaVersion === "1.3" || deepCase.schemaVersion === "1.4") {
    if (deepCase.spillTriage) {
      const selections = deepCase.spillTriage.manualPlanSelections;
      if (!Array.isArray(selections) || selections.some((selection) => !selection || typeof selection.candidateId !== "string" || typeof selection.artifactId !== "string" || typeof selection.statementId !== "string" || typeof selection.selectedAt !== "string" || !Number.isFinite(new Date(selection.selectedAt).getTime())) || new Set(selections.map((selection) => selection.candidateId)).size !== selections.length) throw new Error("The Spill Triage case has malformed manual plan selections.");
    }
    if (deepCase.schemaVersion === "1.4") return { ...deepCase, serverCapabilities };
  }
  const existing = new Set(deepCase.assertions.map((item) => item.id));
  const additions = [
    assertion("compilation-pressure", "Compilation pressure", "Compilation activity materially contributed to scheduler pressure during the incident.", "Not Evaluated", [], ["Repeated compilation and batch counter samples"]),
    assertion("serialization", "Root plan serialization", "The responsible root statement was forced to execute serially for a plan-specific reason.", "Not Evaluated", [], ["A stably matched root Showplan containing NonParallelPlanReason"]),
    assertion("memory-grant-symptom", "Root memory-grant symptom", "The responsible query reserved materially more workspace memory than it used.", "Not Evaluated", [], ["A stably matched actual plan or cache row"]),
  ].filter((item) => !existing.has(item.id));
  const migrated: DeepAnalysisCase = {
    ...deepCase,
    schemaVersion: "1.4",
    origin: deepCase.origin ?? (deepCase.sourceFinding ? { kind: "finding", finding: deepCase.sourceFinding } : { kind: "manual", label: "Spill Triage" }),
    rootIdentity: deepCase.rootIdentity ?? { sessionId: deepCase.rootSessionId },
    incidentWindow: deepCase.incidentWindow ?? { firstObservedAt: null, lastObservedAt: null, overlapQuality: "Unknown", explanation: "This case predates timestamped incident windows." },
    observations: deepCase.observations ?? [],
    captureAttempts: deepCase.captureAttempts ?? [],
    assertions: [...deepCase.assertions, ...additions],
    spillTriage: deepCase.spillTriage ? { ...deepCase.spillTriage, manualPlanSelections: [] } : undefined,
    serverCapabilities,
  };
  if (migrated.profileId === "spill-triage") {
    const selected = migrated.spillTriage?.candidates.find((candidate) => candidate.id === migrated.spillTriage?.selectedCandidateId) ?? migrated.spillTriage?.candidates[0];
    migrated.collectionSteps = spillCollectionSteps(selected, migrated.serverCapabilities, migrated.id);
  }
  return migrated;
}

export async function createDeepCaseArchive(deepCase: DeepAnalysisCase, evidenceFiles: File[], exportedAt = new Date().toISOString()): Promise<DeepCaseArchive> {
  const fileHashes = new Map<string, { file: File; hash: string }>();
  for (const file of evidenceFiles) {
    const hash = await sha256File(file);
    fileHashes.set(hash, { file, hash });
  }
  const used = new Set<string>();
  const entries: DeepCaseArchiveManifest["evidence"] = [];
  const archiveFiles: Record<string, Uint8Array> = {};
  for (const artifact of deepCase.artifacts) {
    const match = fileHashes.get(artifact.sha256);
    if (!match) throw new Error(`Evidence file is unavailable for ${artifact.fileName}; re-import it before saving a portable case.`);
    const safe = safeFileName(match.file.name);
    let path = `evidence/${artifact.id}-${safe}`;
    let suffix = 2;
    while (used.has(path.toLowerCase())) path = `evidence/${artifact.id}-${suffix++}-${safe}`;
    used.add(path.toLowerCase());
    const bytes = new Uint8Array(await match.file.arrayBuffer());
    archiveFiles[path] = bytes;
    entries.push({ artifactId: artifact.id, fileName: match.file.name, path, size: match.file.size, sha256: artifact.sha256 });
  }
  const casePath = "case/case.json";
  const caseBytes = strToU8(JSON.stringify(deepCase, null, 2));
  const caseCopy = new Uint8Array(caseBytes.byteLength); caseCopy.set(caseBytes);
  const caseSha256 = await sha256Bytes(caseCopy.buffer);
  const manifest: DeepCaseArchiveManifest = { schemaVersion: "1.4", caseId: deepCase.id, appVersion: APP_VERSION, exportedAt, sensitive: true, casePath, caseSha256, evidence: entries };
  archiveFiles[manifest.casePath] = caseBytes;
  archiveFiles["manifest.json"] = strToU8(JSON.stringify(manifest, null, 2));
  return { fileName: `SQL-Evaluate-Case_${deepCase.id}.sqlevalcase.zip`, bytes: zipSync(archiveFiles, { level: 6 }), manifest };
}

function safeArchivePath(path: string): boolean {
  return Boolean(path) && !path.includes("\\") && !path.startsWith("/") && !path.split("/").includes("..");
}

function declaredZipExpansion(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minimumEocdSize = 22;
  const maximumCommentSize = 65_535;
  let eocdOffset = -1;
  for (let offset = bytes.byteLength - minimumEocdSize; offset >= Math.max(0, bytes.byteLength - minimumEocdSize - maximumCommentSize); offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) { eocdOffset = offset; break; }
  }
  if (eocdOffset < 0) throw new Error("ZIP end-of-central-directory record is missing.");
  const entryCount = view.getUint16(eocdOffset + 10, true);
  let cursor = view.getUint32(eocdOffset + 16, true);
  let total = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > bytes.byteLength || view.getUint32(cursor, true) !== 0x02014b50) throw new Error("ZIP central directory is malformed.");
    const uncompressedSize = view.getUint32(cursor + 24, true);
    if (uncompressedSize === 0xffffffff) throw new Error("ZIP64 archives are not supported.");
    total += uncompressedSize;
    if (total > UNCOMPRESSED_LIMIT) return total;
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return total;
}

export async function openDeepCaseArchive(file: File): Promise<{ deepCase: DeepAnalysisCase; files: File[] }> {
  if (file.size > CASE_SIZE_LIMIT) throw new Error("Deep Analysis case archives are limited to 100 MB.");
  const archiveBytes = new Uint8Array(await file.arrayBuffer());
  let declaredExpansion: number;
  try { declaredExpansion = declaredZipExpansion(archiveBytes); }
  catch { throw new Error("The Deep Analysis case ZIP could not be opened."); }
  if (declaredExpansion > UNCOMPRESSED_LIMIT) throw new Error("The Deep Analysis case expands beyond the 200 MB safety limit.");
  let entries: Record<string, Uint8Array>;
  try { entries = unzipSync(archiveBytes); }
  catch { throw new Error("The Deep Analysis case ZIP could not be opened."); }
  const total = Object.values(entries).reduce((sum, bytes) => sum + bytes.byteLength, 0);
  if (total > UNCOMPRESSED_LIMIT) throw new Error("The Deep Analysis case expands beyond the 200 MB safety limit.");
  if (!entries["manifest.json"]) throw new Error("The Deep Analysis case has no manifest.");
  const manifest = JSON.parse(strFromU8(entries["manifest.json"])) as DeepCaseArchiveManifest;
  if ((manifest.schemaVersion !== "1.0" && manifest.schemaVersion !== "1.1" && manifest.schemaVersion !== "1.2" && manifest.schemaVersion !== "1.3" && manifest.schemaVersion !== "1.4") || typeof manifest.caseId !== "string" || !safeArchivePath(manifest.casePath) || (manifest.caseSha256 !== undefined && typeof manifest.caseSha256 !== "string") || !Array.isArray(manifest.evidence)) throw new Error("The Deep Analysis manifest is malformed or unsupported.");
  const caseBytes = entries[manifest.casePath];
  if (!caseBytes) throw new Error("The Deep Analysis case JSON is missing.");
  if (manifest.caseSha256) {
    const copy = new Uint8Array(caseBytes.byteLength); copy.set(caseBytes);
    if (await sha256Bytes(copy.buffer) !== manifest.caseSha256) throw new Error("The Deep Analysis case JSON hash verification failed.");
  }
  const deepCase = validateCase(JSON.parse(strFromU8(caseBytes)));
  if (deepCase.id !== manifest.caseId) throw new Error("The case ID does not match its manifest.");
  const files: File[] = [];
  for (const evidence of manifest.evidence) {
    if (!safeArchivePath(evidence.path) || typeof evidence.sha256 !== "string" || typeof evidence.fileName !== "string") throw new Error("The case contains an unsafe evidence path.");
    const bytes = entries[evidence.path];
    if (!bytes || bytes.byteLength !== evidence.size) throw new Error(`${evidence.fileName}: evidence is missing or has the wrong size.`);
    const copy = new Uint8Array(bytes.byteLength); copy.set(bytes);
    const hash = await sha256Bytes(copy.buffer);
    if (hash !== evidence.sha256) throw new Error(`${evidence.fileName}: evidence hash verification failed.`);
    files.push(new File([copy.buffer], evidence.fileName));
  }
  const baselineFinding: Finding | null = deepCase.sourceFinding ? {
    ...deepCase.sourceFinding,
    explanation: "Portable Deep Analysis case source finding.",
    remediation: [],
    references: [],
    affectedRecordIds: [],
    affectedPlanIds: [],
    firstSeen: deepCase.incidentWindow?.firstObservedAt,
    lastSeen: deepCase.incidentWindow?.lastObservedAt,
    impact: 0,
  } : null;
  const baselineReport: AnalysisReport | null = baselineFinding ? {
    schemaVersion: "1.0",
    createdAt: deepCase.sourceReportCreatedAt,
    inputs: deepCase.sourceFileNames.map((fileName, index) => ({ id: `reopened-source-${index}`, fileName, size: 0, format: "csv", rowCount: 0, recognizedColumns: [], unknownColumns: [], warnings: [] })),
    records: [],
    plans: [],
    findings: [baselineFinding],
    dataQuality: { presentColumns: [], missingColumns: [], unknownColumns: [], warnings: [], notEvaluatedRules: [] },
    redacted: false,
  } : null;
  const baseline = baselineReport && baselineFinding ? createDeepAnalysisCase(baselineReport, baselineFinding, deepCase.createdAt, deepCase.id, deepCase.profileId) : createSpillTriageCase(deepCase.createdAt, deepCase.id);
  const storedByHash = new Map(deepCase.artifacts.map((artifact) => [artifact.sha256, artifact]));
  const reInspected = await Promise.all(files.map((evidenceFile, index) => inspectEvidenceFile(evidenceFile, deepCase.rootSessionId, storedByHash.get(manifest.evidence[index]?.sha256 ?? "")?.importedAt ?? manifest.exportedAt)));
  const reopenedAt = new Date().toISOString();
  const rebuiltCandidates = rankSpillCandidates(reInspected.flatMap((item) => item.spillCandidates).map((candidate, index) => ({ ...candidate, sourceOrder: index })));
  const rebuiltSpill = deepCase.profileId === "spill-triage" || rebuiltCandidates.length ? (() => {
    const rebuilt: SpillTriageState = {
      candidates: rebuiltCandidates,
      selectedCandidateId: deepCase.spillTriage?.selectedCandidateId && rebuiltCandidates.some((candidate) => candidate.id === deepCase.spillTriage?.selectedCandidateId) ? deepCase.spillTriage.selectedCandidateId : rebuiltCandidates.find((candidate) => candidate.rank === 1)?.id ?? null,
      imports: reInspected.flatMap((item) => item.spillImports),
      plans: reInspected.flatMap((item) => item.spillPlans),
      manualPlanSelections: deepCase.spillTriage?.manualPlanSelections ?? [],
    };
    return { ...rebuilt, manualPlanSelections: validManualPlanSelections(rebuilt) };
  })() : undefined;
  const rebuiltCapabilities = reInspected.flatMap((item) => item.capabilitySnapshots).sort((left, right) => right.capturedAt.localeCompare(left.capturedAt))[0] ?? deepCase.serverCapabilities;
  const rebuiltSelected = rebuiltSpill?.candidates.find((candidate) => candidate.id === rebuiltSpill.selectedCandidateId) ?? rebuiltSpill?.candidates[0];
  const reconstructed = evaluateDeepCase({
    ...deepCase,
    schemaVersion: "1.4",
    updatedAt: reopenedAt,
    assertions: baseline.assertions,
    collectionSteps: deepCase.profileId === "spill-triage" ? spillCollectionSteps(rebuiltSelected, rebuiltCapabilities, deepCase.id) : baseline.collectionSteps,
    artifacts: reInspected.map((item) => item.artifact),
    observations: reInspected.flatMap((item) => item.observations),
    spillTriage: rebuiltSpill,
    serverCapabilities: rebuiltCapabilities,
    captureAttempts: [],
    narrative: undefined,
    events: [...deepCase.events, { occurredAt: reopenedAt, type: "Case reopened", summary: `Reopened ${file.name}; derived evidence state was rebuilt from verified attachments.` }],
  });
  return { deepCase: reconstructed, files };
}
