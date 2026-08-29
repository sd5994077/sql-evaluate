import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { AnalysisReport, Finding } from "../types";
import { APP_VERSION } from "../version";
import { decodeText, parseCsv } from "../lib/csv";
import { inspectEvidenceMatrix, normalizeEvidenceHeader } from "./adapters";
import { evaluateDeepCase } from "./evaluator";
import { cpuBlockingCollectionCommand, CPU_BACKED_BLOCKING_PROFILE, deepAnalysisProfileForFinding, extendedEventsShowplanCommand, lastKnownActualPlanCommand, profileLabel, queryStoreExportCommand } from "./profile";
import type { DeepAnalysisCase, DeepCaseArchive, DeepCaseArchiveManifest, DeepCaseArtifact, DeepEvidenceAssertion, DeepEvidenceObservation, DeepProfileId, DeepQueryIdentity } from "./types";

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
    schemaVersion: "1.1",
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
  return lastKnownActualPlanCommand(target);
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
  const assertions: DeepEvidenceAssertion[] = profileId === "transaction-blocking" ? [
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
    schemaVersion: "1.1", id, profileId, title: `${profileLabel(profileId)}${rootSessionId ? ` / SPID ${rootSessionId}` : ""}`, createdAt, updatedAt: createdAt,
    sourceReportCreatedAt: report.createdAt, sourceFileNames: report.inputs.map((input) => input.fileName),
    sourceFinding: { id: finding.id, ruleId: finding.ruleId, severity: finding.severity, confidence: finding.confidence, category: finding.category, title: finding.title, summary: finding.summary, evidence: finding.evidence, blockingContext: finding.blockingContext },
    rootSessionId, rootIdentity: identity,
    incidentWindow: { firstObservedAt: relatedTimes[0] ?? finding.firstSeen ?? null, lastObservedAt: relatedTimes.at(-1) ?? finding.lastSeen ?? null, overlapQuality: relatedTimes.length ? "Exact" : "Unknown", explanation: relatedTimes.length ? "The incident window comes from affected capture timestamps." : "No usable capture boundary was supplied." },
    observations: [], captureAttempts: [], assertions,
    collectionSteps,
    artifacts: [], events: [{ occurredAt: createdAt, type: "Case created", summary: `Started ${profileLabel(profileId)} from ${finding.title}.` }], sensitive: true,
  };
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
  const embeddedPlans: string[] = [];

  const mergeMatrix = (matrix: unknown[][], prefix?: string) => {
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
    const headers = (matrix[0] ?? []).map(normalizeEvidenceHeader);
    const planIndex = ["query_plan", "showplan_xml", "last_query_plan"].map((name) => headers.indexOf(name)).find((index) => index >= 0) ?? -1;
    if (planIndex >= 0) matrix.slice(1).forEach((row) => {
      const xml = String(row[planIndex] ?? "").trim();
      if (/<\s*(?:\w+:)?ShowPlanXML\b/i.test(xml)) embeddedPlans.push(xml);
    });
  };

  if (lower.endsWith(".sqlplan") || lower.endsWith(".xml")) {
    try {
      const xml = decodeText(bytes);
      const { parseShowplan } = await import("../lib/showplan");
      const plan = parseShowplan(xml, `deep-${hash.slice(0, 12)}`, file.name);
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
    } catch (error) {
      details.push(`XML was attached but not recognized as Showplan: ${error instanceof Error ? error.message : "parse error"}`);
      warnings.push("The XML attachment was preserved but cannot drive plan assertions.");
    }
  } else if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) {
    const XLSX = await import("xlsx");
    const workbook = XLSX.read(bytes, { type: "array", dense: true, cellDates: true });
    for (const sheetName of workbook.SheetNames) {
      const matrix = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: true, defval: null }) as unknown[][];
      mergeMatrix(matrix, sheetName);
    }
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
    for (const [index, xml] of embeddedPlans.slice(0, 25).entries()) {
      try {
        const plan = parseShowplan(xml, `${adapterId}-${hash.slice(0, 12)}-${index}`, `${adapterId}-${file.name}`);
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
  }, observations };
}

export async function addEvidenceFiles(deepCase: DeepAnalysisCase, files: File[], importedAt = new Date().toISOString()): Promise<{ deepCase: DeepAnalysisCase; acceptedFiles: File[] }> {
  const inspected = await Promise.all(files.map((file) => inspectEvidenceFile(file, deepCase.rootSessionId, importedAt)));
  const existing = new Set(deepCase.artifacts.map((artifact) => artifact.sha256));
  const accepted = inspected.filter((item) => !existing.has(item.artifact.sha256));
  const artifacts = accepted.map((item) => item.artifact);
  const observations = accepted.flatMap((item) => item.observations);
  const acceptedHashes = new Set(artifacts.map((artifact) => artifact.sha256));
  const acceptedFiles: File[] = [];
  for (const file of files) if (acceptedHashes.has(await sha256File(file))) acceptedFiles.push(file);
  const updated = evaluateDeepCase({
    ...deepCase,
    schemaVersion: "1.1",
    updatedAt: importedAt,
    artifacts: [...deepCase.artifacts, ...artifacts],
    observations: [...(deepCase.observations ?? []), ...observations],
    events: artifacts.length ? [...deepCase.events, { occurredAt: importedAt, type: "Evidence imported", summary: `${artifacts.length} evidence file${artifacts.length === 1 ? "" : "s"} attached and evaluated.` }] : deepCase.events,
  });
  return { deepCase: updated, acceptedFiles };
}

function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).at(-1) || "evidence";
  return base.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_").replace(/[. ]+$/g, "") || "evidence";
}

function validateCase(value: unknown): DeepAnalysisCase {
  if (!value || typeof value !== "object") throw new Error("Case JSON is not an object.");
  const candidate = value as Partial<DeepAnalysisCase>;
  const supportedProfiles: DeepProfileId[] = ["cpu-backed-blocking", "transaction-blocking", "worker-exhaustion", "compile-pressure", "memory-grants", "plan-specific", "actual-plan"];
  if ((candidate.schemaVersion !== "1.0" && candidate.schemaVersion !== "1.1") || typeof candidate.id !== "string" || !candidate.profileId || !supportedProfiles.includes(candidate.profileId)) throw new Error("Unsupported or malformed Deep Analysis case.");
  if (!Array.isArray(candidate.assertions) || !Array.isArray(candidate.collectionSteps) || !Array.isArray(candidate.artifacts) || !Array.isArray(candidate.events)) throw new Error("Deep Analysis case is missing required collections.");
  if (!candidate.sourceFinding || typeof candidate.sourceFinding.title !== "string") throw new Error("Deep Analysis case is missing its source finding.");
  const deepCase = candidate as DeepAnalysisCase;
  if (deepCase.schemaVersion === "1.1") return deepCase;
  const existing = new Set(deepCase.assertions.map((item) => item.id));
  const additions = [
    assertion("compilation-pressure", "Compilation pressure", "Compilation activity materially contributed to scheduler pressure during the incident.", "Not Evaluated", [], ["Repeated compilation and batch counter samples"]),
    assertion("serialization", "Root plan serialization", "The responsible root statement was forced to execute serially for a plan-specific reason.", "Not Evaluated", [], ["A stably matched root Showplan containing NonParallelPlanReason"]),
    assertion("memory-grant-symptom", "Root memory-grant symptom", "The responsible query reserved materially more workspace memory than it used.", "Not Evaluated", [], ["A stably matched actual plan or cache row"]),
  ].filter((item) => !existing.has(item.id));
  return {
    ...deepCase,
    schemaVersion: "1.1",
    rootIdentity: deepCase.rootIdentity ?? { sessionId: deepCase.rootSessionId },
    incidentWindow: deepCase.incidentWindow ?? { firstObservedAt: null, lastObservedAt: null, overlapQuality: "Unknown", explanation: "This case predates timestamped incident windows." },
    observations: deepCase.observations ?? [],
    captureAttempts: deepCase.captureAttempts ?? [],
    assertions: [...deepCase.assertions, ...additions],
  };
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
  const manifest: DeepCaseArchiveManifest = { schemaVersion: "1.1", caseId: deepCase.id, appVersion: APP_VERSION, exportedAt, sensitive: true, casePath, caseSha256, evidence: entries };
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
  if ((manifest.schemaVersion !== "1.0" && manifest.schemaVersion !== "1.1") || typeof manifest.caseId !== "string" || !safeArchivePath(manifest.casePath) || (manifest.caseSha256 !== undefined && typeof manifest.caseSha256 !== "string") || !Array.isArray(manifest.evidence)) throw new Error("The Deep Analysis manifest is malformed or unsupported.");
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
  const baselineFinding: Finding = {
    ...deepCase.sourceFinding,
    explanation: "Portable Deep Analysis case source finding.",
    remediation: [],
    references: [],
    affectedRecordIds: [],
    affectedPlanIds: [],
    firstSeen: deepCase.incidentWindow?.firstObservedAt,
    lastSeen: deepCase.incidentWindow?.lastObservedAt,
    impact: 0,
  };
  const baselineReport: AnalysisReport = {
    schemaVersion: "1.0",
    createdAt: deepCase.sourceReportCreatedAt,
    inputs: deepCase.sourceFileNames.map((fileName, index) => ({ id: `reopened-source-${index}`, fileName, size: 0, format: "csv", rowCount: 0, recognizedColumns: [], unknownColumns: [], warnings: [] })),
    records: [],
    plans: [],
    findings: [baselineFinding],
    dataQuality: { presentColumns: [], missingColumns: [], unknownColumns: [], warnings: [], notEvaluatedRules: [] },
    redacted: false,
  };
  const baseline = createDeepAnalysisCase(baselineReport, baselineFinding, deepCase.createdAt, deepCase.id, deepCase.profileId);
  const storedByHash = new Map(deepCase.artifacts.map((artifact) => [artifact.sha256, artifact]));
  const reInspected = await Promise.all(files.map((evidenceFile, index) => inspectEvidenceFile(evidenceFile, deepCase.rootSessionId, storedByHash.get(manifest.evidence[index]?.sha256 ?? "")?.importedAt ?? manifest.exportedAt)));
  const reopenedAt = new Date().toISOString();
  const reconstructed = evaluateDeepCase({
    ...deepCase,
    schemaVersion: "1.1",
    updatedAt: reopenedAt,
    assertions: baseline.assertions,
    collectionSteps: baseline.collectionSteps,
    artifacts: reInspected.map((item) => item.artifact),
    observations: reInspected.flatMap((item) => item.observations),
    captureAttempts: [],
    narrative: undefined,
    events: [...deepCase.events, { occurredAt: reopenedAt, type: "Case reopened", summary: `Reopened ${file.name}; derived evidence state was rebuilt from verified attachments.` }],
  });
  return { deepCase: reconstructed, files };
}
