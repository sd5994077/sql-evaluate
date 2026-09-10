import { capabilitySnapshotCommand, installedTool, sqlServerMajorVersion } from "./capabilities";
import { extendedEventsShowplanCommand } from "./profile";
import type { DeepCollectionStep, DiagnosticAvailability, DiagnosticProvider, ServerCapabilitySnapshot, SpillCandidate } from "./types";

export type DiagnosticSafety = "Read-only" | "Administrative" | "Excluded";
export type DiagnosticCategory = "Health" | "Active workload" | "Plan cache" | "Indexes" | "Deadlocks" | "History" | "Plan acquisition" | "Maintenance";

export interface DiagnosticRecipe {
  id: string;
  provider: DiagnosticProvider;
  name: string;
  category: DiagnosticCategory;
  purpose: string;
  safety: DiagnosticSafety;
  supportedVersions: string;
  requiredPermissions: string[];
  expectedEvidence: string[];
  overhead: "Low" | "Moderate" | "High";
  caution: string;
  officialUrl: string;
  fallbackRecipeId?: string;
}

const FRK = "https://github.com/BrentOzarULTD/SQL-Server-First-Responder-Kit";
const OLA = "https://github.com/olahallengren/sql-server-maintenance-solution";
const WIA = "https://github.com/amachanic/sp_whoisactive";
const MICROSOFT_PLANS = "https://learn.microsoft.com/sql/relational-databases/system-dynamic-management-views/sys-dm-exec-query-plan-stats-transact-sql";

export const DIAGNOSTIC_TOOL_CATALOG: readonly DiagnosticRecipe[] = [
  { id: "frk-blitz", provider: "First Responder Kit", name: "sp_Blitz", category: "Health", purpose: "Prioritized SQL Server health review.", safety: "Read-only", supportedVersions: "Use only when the installed procedure reports a compatible signature.", requiredPermissions: ["Permissions required by the installed First Responder Kit version"], expectedEvidence: ["Prioritized configuration and health findings"], overhead: "Moderate", caution: "Review the installed procedure documentation and run during an approved diagnostic window.", officialUrl: FRK },
  { id: "frk-blitzfirst", provider: "First Responder Kit", name: "sp_BlitzFirst", category: "Active workload", purpose: "Bounded current-workload, waits, file, and performance-counter sampling.", safety: "Read-only", supportedVersions: "Use only when the installed procedure reports a compatible signature.", requiredPermissions: ["VIEW SERVER STATE or the version-appropriate equivalent"], expectedEvidence: ["Wait deltas", "Active requests", "Perfmon and file-stat deltas"], overhead: "Moderate", caution: "Keep the sample bounded and avoid optional output-table writes.", officialUrl: FRK, fallbackRecipeId: "native-capability-snapshot" },
  { id: "frk-blitzwho", provider: "First Responder Kit", name: "sp_BlitzWho", category: "Active workload", purpose: "Snapshot active requests, blocking, grants, and optional live plans.", safety: "Read-only", supportedVersions: "Use only when the installed procedure reports a compatible signature.", requiredPermissions: ["VIEW SERVER STATE or the version-appropriate equivalent"], expectedEvidence: ["Active request identity", "Blocking and grant context", "Optional live plan"], overhead: "Low", caution: "Live plans can add collection overhead and expose SQL text.", officialUrl: FRK },
  { id: "frk-blitzcache", provider: "First Responder Kit", name: "sp_BlitzCache", category: "Plan cache", purpose: "Rank cached statements by spills, grants, CPU, reads, duration, or executions.", safety: "Read-only", supportedVersions: "SQL Server 2016+ for current releases; verify the installed signature.", requiredPermissions: ["VIEW SERVER STATE or VIEW SERVER PERFORMANCE STATE as applicable"], expectedEvidence: ["plan_handle and sql_handle", "Paired query hashes", "Aggregate cache metrics", "Cached Showplan when returned"], overhead: "Moderate", caution: "Use a bounded @Top. SQL Evaluate never enables AI options or recommends cache-removal columns.", officialUrl: FRK, fallbackRecipeId: "native-cached-plan-provenance" },
  { id: "frk-blitzindex", provider: "First Responder Kit", name: "sp_BlitzIndex", category: "Indexes", purpose: "Review index design, usage, duplication, and missing-index context.", safety: "Read-only", supportedVersions: "Use only when the installed procedure reports a compatible signature.", requiredPermissions: ["Database metadata and state permissions required by the installed version"], expectedEvidence: ["Existing index definitions and usage", "Missing-index context", "Duplicate or overlapping indexes"], overhead: "Moderate", caution: "Generated index statements are starting points, not automatic recommendations.", officialUrl: FRK },
  { id: "frk-blitzlock", provider: "First Responder Kit", name: "sp_BlitzLock", category: "Deadlocks", purpose: "Read and analyze deadlocks already captured by Extended Events.", safety: "Read-only", supportedVersions: "Use only when the installed procedure reports a compatible signature.", requiredPermissions: ["Permission to read the selected Extended Events target"], expectedEvidence: ["Deadlock graphs", "Victim and resource identity", "Available plans"], overhead: "Moderate", caution: "Reading large event targets can be expensive; bound dates and database filters.", officialUrl: FRK },
  { id: "frk-blitzanalysis", provider: "First Responder Kit", name: "sp_BlitzAnalysis", category: "History", purpose: "Analyze already-logged sp_BlitzFirst history.", safety: "Read-only", supportedVersions: "Requires compatible logged First Responder Kit tables.", requiredPermissions: ["SELECT on the existing diagnostic history tables"], expectedEvidence: ["Historical wait, file, and performance trends"], overhead: "Low", caution: "Do not create or populate logging tables as part of this read-only workflow.", officialUrl: FRK },
  { id: "whoisactive", provider: "sp_WhoIsActive", name: "sp_WhoIsActive", category: "Active workload", purpose: "Capture current requests, blocking, transactions, and cached plans.", safety: "Read-only", supportedVersions: "Verify the installed procedure parameter signature.", requiredPermissions: ["Permissions required by the installed sp_WhoIsActive version"], expectedEvidence: ["Session and request identity", "Waits and blocking", "Optional cached plans"], overhead: "Low", caution: "Plan and lock options increase overhead and may expose sensitive text.", officialUrl: WIA },
  { id: "ola-commandlog", provider: "Ola Hallengren", name: "CommandLog history", category: "History", purpose: "Correlate existing backup, integrity, statistics, or index-maintenance activity with an incident.", safety: "Read-only", supportedVersions: "Requires an existing CommandLog table from SQL Server Maintenance Solution.", requiredPermissions: ["SELECT on the existing CommandLog table"], expectedEvidence: ["Command type", "Start/end time", "Database/object", "Outcome and error details"], overhead: "Low", caution: "Read existing history only; do not launch maintenance to collect diagnostic evidence.", officialUrl: OLA },
  { id: "native-capability-snapshot", provider: "SQL Evaluate native", name: "Server capability snapshot", category: "Health", purpose: "Discover server, database, permission, feature, and installed-tool capabilities.", safety: "Read-only", supportedVersions: "SQL Server 2016+; unavailable features are reported rather than enabled.", requiredPermissions: ["Public metadata plus any organization-approved visibility permissions"], expectedEvidence: ["Version and edition", "Feature states", "Effective permissions", "Installed tool signatures"], overhead: "Low", caution: "Run in the affected database. Version-check mode is invoked only for procedures exposing the documented guarded contract.", officialUrl: MICROSOFT_PLANS },
  { id: "native-cached-plan-provenance", provider: "SQL Evaluate native", name: "Cached plan with provenance", category: "Plan acquisition", purpose: "Retrieve a cached Showplan with statement-level stable identity from an exact plan_handle.", safety: "Read-only", supportedVersions: "SQL Server 2016+ while the plan remains cached.", requiredPermissions: ["VIEW SERVER STATE (through SQL Server 2019) or VIEW SERVER PERFORMANCE STATE (SQL Server 2022+)"], expectedEvidence: ["plan_handle and sql_handle", "Paired query hashes", "Statement offsets", "database_id", "Cached Showplan"], overhead: "Low", caution: "A zero-row or NULL-plan result is valid when the cache entry expired.", officialUrl: "https://learn.microsoft.com/sql/relational-databases/system-dynamic-management-views/sys-dm-exec-query-stats-transact-sql" },
  { id: "native-last-known-actual", provider: "SQL Evaluate native", name: "Last-known actual plan", category: "Plan acquisition", purpose: "Retrieve retained runtime counters for an exact cached plan identity.", safety: "Read-only", supportedVersions: "SQL Server 2019+ when LAST_QUERY_PLAN_STATS is already enabled.", requiredPermissions: ["VIEW SERVER STATE or VIEW SERVER PERFORMANCE STATE as applicable"], expectedEvidence: ["Runtime Showplan", "Stable statement identity"], overhead: "Low", caution: "SQL Evaluate does not enable LAST_QUERY_PLAN_STATS. A NULL plan is a valid result.", officialUrl: MICROSOFT_PLANS },
  { id: "query-store-history", provider: "SQL Evaluate native", name: "Existing Query Store history", category: "Plan acquisition", purpose: "Retrieve retained plans and runtime aggregates for a stable query identity.", safety: "Read-only", supportedVersions: "SQL Server 2016+ when Query Store is already enabled and populated.", requiredPermissions: ["SQL Server 2016-2019: VIEW DATABASE STATE", "SQL Server 2022+: VIEW DATABASE PERFORMANCE STATE or the broader VIEW DATABASE STATE"], expectedEvidence: ["Query Store query and plan IDs", "database_id", "Paired query hashes", "One retained Showplan row per Query Store plan", "Aggregated runtime window"], overhead: "Low", caution: "SQL Evaluate does not enable or change Query Store. Enabling Query Store does not recover plans or runtime history from before enablement.", officialUrl: "https://learn.microsoft.com/sql/relational-databases/performance/monitoring-performance-by-using-the-query-store" },
  { id: "controlled-actual-plan", provider: "Manual workflow", name: "Controlled actual plan", category: "Plan acquisition", purpose: "Capture a representative execution with runtime operator counters.", safety: "Administrative", supportedVersions: "Supported SQL Server and SSMS versions.", requiredPermissions: ["Approved execution context", "SHOWPLAN in the affected database"], expectedEvidence: ["Actual and estimated rows", "Runtime spills and memory use"], overhead: "Moderate", caution: "Executing workload SQL can change data or add production load; use a reviewed statement and approved environment.", officialUrl: "https://learn.microsoft.com/sql/relational-databases/performance/display-an-actual-execution-plan" },
  { id: "xe-post-execution-showplan", provider: "SQL Evaluate native", name: "Filtered post-execution Showplan Extended Events", category: "Plan acquisition", purpose: "Capture rapidly evicted executions after lower-risk retained sources fail.", safety: "Administrative", supportedVersions: "SQL Server 2016+ after local syntax and overhead review.", requiredPermissions: ["Organization change approval", "ALTER ANY EVENT SESSION", "A confirmed narrow filter"], expectedEvidence: ["Post-execution Showplan", "Event timestamp", "Stable query identity"], overhead: "High", caution: "Administrative and potentially expensive. Apply a narrow filter, run briefly, and execute the included cleanup.", officialUrl: "https://learn.microsoft.com/shows/sql-workshops/extended-event-query-post-execution-showplan-in-sql-server" },
  { id: "excluded-maintenance", provider: "Ola Hallengren", name: "Maintenance procedure execution", category: "Maintenance", purpose: "DatabaseBackup, DatabaseIntegrityCheck, and IndexOptimize perform maintenance rather than evidence-only diagnosis.", safety: "Excluded", supportedVersions: "Not applicable to automatic diagnostic routing.", requiredPermissions: [], expectedEvidence: [], overhead: "High", caution: "Never recommend running maintenance merely to collect troubleshooting evidence.", officialUrl: OLA },
];

function exactHex(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized && /^0x(?:[0-9a-f]{2}){1,64}$/i.test(normalized) ? normalized : null;
}

function exactQueryHash(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized && /^0x[0-9a-f]{16}$/i.test(normalized) ? normalized : null;
}

function nativeAvailability(snapshot: ServerCapabilitySnapshot | undefined): { availability: DiagnosticAvailability; reason?: string } {
  if (!snapshot) return { availability: "Unknown", reason: "Import a capability snapshot to verify SQL Server permissions." };
  const major = sqlServerMajorVersion(snapshot);
  const granted = major !== null && major >= 16 ? snapshot.permissions.viewServerPerformanceState : snapshot.permissions.viewServerState;
  if (granted === true) return { availability: "Available" };
  if (granted === false) return { availability: "Unavailable", reason: major !== null && major >= 16 ? "VIEW SERVER PERFORMANCE STATE was not granted." : "VIEW SERVER STATE was not granted." };
  return { availability: "Unknown", reason: "The required server-state permission could not be determined." };
}

function cachedPlanCommand(candidate: SpillCandidate | undefined, caseId: string): string {
  const planHandle = exactHex(candidate?.identity.planHandle);
  return `/* SQL Evaluate: exact cached plan with provenance. Read-only.
   Save the result grid as CSV or XLSX and import it into this Spill Triage case. */
SET NOCOUNT ON;
DECLARE @SqlEvaluateCase varchar(80) = '${caseId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80) || "UNASSIGNED"}';
DECLARE @plan_handle varbinary(64) = ${planHandle ?? "NULL"}; -- Exact plan_handle from the selected candidate.

SELECT 'SQL_EVALUATE_NATIVE_V1' AS adapter_id, @SqlEvaluateCase AS case_id,
       'CACHED_PLAN_PROVENANCE' AS evidence_set, SYSDATETIMEOFFSET() AS captured_at,
       qs.plan_handle, qs.sql_handle, qs.query_hash, qs.query_plan_hash,
       qs.statement_start_offset, qs.statement_end_offset,
       qp.dbid AS database_id, qp.query_plan
FROM sys.dm_exec_query_stats AS qs
OUTER APPLY sys.dm_exec_query_plan(qs.plan_handle) AS qp
WHERE @plan_handle IS NOT NULL AND qs.plan_handle = @plan_handle;`;
}

function lastKnownActualCommand(candidate: SpillCandidate | undefined, caseId: string): string {
  const planHandle = exactHex(candidate?.identity.planHandle);
  return `/* SQL Evaluate: exact last-known actual plan. Read-only.
   Requires LAST_QUERY_PLAN_STATS to be already enabled. SQL Evaluate does not change that setting. */
SET NOCOUNT ON;
DECLARE @SqlEvaluateCase varchar(80) = '${caseId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80) || "UNASSIGNED"}';
DECLARE @plan_handle varbinary(64) = ${planHandle ?? "NULL"};

SELECT 'SQL_EVALUATE_NATIVE_V1' AS adapter_id, @SqlEvaluateCase AS case_id,
       'LAST_KNOWN_ACTUAL_PLAN' AS evidence_set, SYSDATETIMEOFFSET() AS captured_at,
       qs.plan_handle, qs.sql_handle, qs.query_hash, qs.query_plan_hash,
       qs.statement_start_offset, qs.statement_end_offset,
       qps.dbid AS database_id, qps.query_plan
FROM sys.dm_exec_query_stats AS qs
OUTER APPLY sys.dm_exec_query_plan_stats(qs.plan_handle) AS qps
WHERE @plan_handle IS NOT NULL AND qs.plan_handle = @plan_handle;`;
}

function queryStoreCommand(candidate: SpillCandidate | undefined, caseId: string): string {
  const queryHash = exactQueryHash(candidate?.identity.queryHash);
  return `/* SQL Evaluate: existing Query Store plan history. Read-only.
   Run in the affected database. This script does not enable or change Query Store. */
SET NOCOUNT ON;
DECLARE @SqlEvaluateCase varchar(80) = '${caseId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80) || "UNASSIGNED"}';
DECLARE @QueryHash binary(8) = ${queryHash ?? "NULL"};
DECLARE @Since datetime2 = DATEADD(hour, -2, SYSUTCDATETIME());

/* Query Store begins collecting only after it is enabled. A newly enabled store has no earlier history.
   Runtime intervals are aggregated first so each Query Store plan is exported exactly once. */
;WITH RuntimeWindow AS
(
    SELECT rs.plan_id,
           MIN(rsi.start_time) AS runtime_interval_start,
           MAX(rsi.end_time) AS runtime_interval_end,
           SUM(CONVERT(bigint, rs.count_executions)) AS count_executions,
           SUM(CONVERT(decimal(38,4), rs.avg_duration) * rs.count_executions) / NULLIF(SUM(CONVERT(decimal(38,4), rs.count_executions)), 0) AS avg_duration,
           SUM(CONVERT(decimal(38,4), rs.avg_cpu_time) * rs.count_executions) / NULLIF(SUM(CONVERT(decimal(38,4), rs.count_executions)), 0) AS avg_cpu_time,
           SUM(CONVERT(decimal(38,4), rs.avg_logical_io_reads) * rs.count_executions) / NULLIF(SUM(CONVERT(decimal(38,4), rs.count_executions)), 0) AS avg_logical_io_reads,
           SUM(CONVERT(decimal(38,4), rs.avg_query_max_used_memory) * rs.count_executions) / NULLIF(SUM(CONVERT(decimal(38,4), rs.count_executions)), 0) AS avg_query_max_used_memory
    FROM sys.query_store_runtime_stats AS rs
    JOIN sys.query_store_runtime_stats_interval AS rsi ON rsi.runtime_stats_interval_id = rs.runtime_stats_interval_id
    WHERE rsi.end_time >= @Since
    GROUP BY rs.plan_id
)
SELECT 'QUERY_STORE_EXPORT_V1' AS adapter_id, @SqlEvaluateCase AS case_id,
       'QUERY_STORE' AS evidence_set, SYSUTCDATETIME() AS captured_at,
       DB_ID() AS database_id, q.query_id, p.plan_id, q.query_hash, p.query_plan_hash,
       px.plan_xml.value('declare default element namespace "http://schemas.microsoft.com/sqlserver/2004/07/showplan"; (//StmtSimple/@StatementStartOffset)[1]', 'int') AS statement_start_offset,
       px.plan_xml.value('declare default element namespace "http://schemas.microsoft.com/sqlserver/2004/07/showplan"; (//StmtSimple/@StatementEndOffset)[1]', 'int') AS statement_end_offset,
       qt.query_sql_text, p.query_plan, p.is_forced_plan,
       rw.runtime_interval_start, rw.runtime_interval_end,
       rw.count_executions, rw.avg_duration, rw.avg_cpu_time,
       rw.avg_logical_io_reads, rw.avg_query_max_used_memory
FROM sys.query_store_query AS q
JOIN sys.query_store_query_text AS qt ON qt.query_text_id = q.query_text_id
JOIN sys.query_store_plan AS p ON p.query_id = q.query_id
OUTER APPLY (SELECT TRY_CONVERT(xml, p.query_plan) AS plan_xml) AS px
LEFT JOIN RuntimeWindow AS rw ON rw.plan_id = p.plan_id
WHERE @QueryHash IS NOT NULL AND q.query_hash = @QueryHash
ORDER BY p.plan_id;`;
}

function controlledActualInstructions(): string {
  return `/* SQL Evaluate: controlled representative actual-plan acquisition.
   ADMINISTRATIVE WORKFLOW — separate approval required.

   1. In SSMS, select Include Actual Execution Plan.
   2. Use a non-production environment or an approved representative production execution.
   3. Execute only the reviewed parameterized statement with representative parameters.
   4. Save the plan as .sqlplan and import it into this case.

   SQL Evaluate never executes this workflow. */`;
}

function step(recipeId: string, values: Pick<DeepCollectionStep, "id" | "title" | "purpose" | "command" | "availability"> & Partial<DeepCollectionStep>): DeepCollectionStep {
  const recipe = DIAGNOSTIC_TOOL_CATALOG.find((item) => item.id === recipeId)!;
  return {
    id: values.id,
    title: values.title,
    purpose: values.purpose,
    command: values.command,
    availability: values.availability,
    unavailableReason: values.unavailableReason,
    selectionReason: values.selectionReason,
    recipeId,
    provider: recipe.provider,
    requiredPermissions: recipe.requiredPermissions,
    expectedEvidence: recipe.expectedEvidence,
    supportedVersions: recipe.supportedVersions,
    overhead: recipe.overhead,
    caution: recipe.caution,
    status: values.status ?? "Pending",
    artifactIds: values.artifactIds ?? [],
    executionMode: recipe.safety === "Administrative" ? "Administrative" : "Read-only",
    requiresApproval: recipe.safety === "Administrative" || values.requiresApproval,
  };
}

export function spillCollectionSteps(candidate: SpillCandidate | undefined, snapshot: ServerCapabilitySnapshot | undefined, caseId: string): DeepCollectionStep[] {
  const native = nativeAvailability(snapshot);
  const handle = exactHex(candidate?.identity.planHandle);
  const queryHash = exactQueryHash(candidate?.identity.queryHash);
  const major = sqlServerMajorVersion(snapshot);
  const queryStoreAvailable = Boolean(snapshot?.queryStoreState && !["OFF", "UNAVAILABLE", "ERROR", "PERMISSION_REQUIRED", "UNKNOWN"].includes(snapshot.queryStoreState.toUpperCase()));
  const queryStorePermission = !snapshot ? null : major !== null && major >= 16
    ? snapshot.permissions.viewDatabasePerformanceState === true || snapshot.permissions.viewDatabaseState === true
    : snapshot.permissions.viewDatabaseState;
  const queryStoreDatabaseMismatch = candidate?.identity.databaseId != null && snapshot?.databaseId != null && candidate.identity.databaseId !== snapshot.databaseId;
  const queryStoreDatabaseKnown = Boolean(snapshot && (snapshot.databaseId != null || snapshot.databaseName));
  const blitz = installedTool(snapshot, "frk-blitzcache");
  const capability = step("native-capability-snapshot", {
    id: "server-capability-snapshot",
    title: snapshot ? "Refresh server capability snapshot" : "Import server capability snapshot",
    purpose: "Verify version, edition, permissions, plan-history features, and installed diagnostic tools before choosing an evidence path.",
    command: capabilitySnapshotCommand(caseId),
    availability: "Available",
    selectionReason: snapshot ? "A snapshot is present; refresh it when server settings or installed tools may have changed." : "Capabilities are unknown, so this is the safest first check.",
  });
  const cached = step("native-cached-plan-provenance", {
    id: "cached-plan-provenance",
    title: "Retrieve cached plan with stable provenance",
    purpose: "Use the exact selected plan_handle to return the plan and its statement-level stable identifiers in one importable row set.",
    command: cachedPlanCommand(candidate, caseId),
    availability: !handle ? "Unavailable" : native.availability,
    unavailableReason: !handle ? "The selected candidate does not contain a valid plan_handle." : native.reason,
    selectionReason: handle ? "The selected candidate supplies an exact plan_handle; this is the lowest-overhead correlation route." : undefined,
  });
  const lastKnown = step("native-last-known-actual", {
    id: "last-known-actual-plan",
    title: "Retrieve last-known actual plan",
    purpose: "Use the exact plan_handle to request retained runtime counters after cached-plan provenance is established.",
    command: lastKnownActualCommand(candidate, caseId),
    availability: !handle ? "Unavailable" : !snapshot ? "Unknown" : major === null || major < 15 ? "Unavailable" : snapshot.lastQueryPlanStats === "ON" ? native.availability : "Unavailable",
    unavailableReason: !handle ? "The selected candidate does not contain a valid plan_handle." : !snapshot ? "Import a capability snapshot to verify LAST_QUERY_PLAN_STATS." : major === null || major < 15 ? "Last-known actual plans require SQL Server 2019 or later." : snapshot.lastQueryPlanStats !== "ON" ? `LAST_QUERY_PLAN_STATS is ${snapshot.lastQueryPlanStats}; SQL Evaluate will not enable it.` : native.reason,
    selectionReason: snapshot?.lastQueryPlanStats === "ON" ? "The server reports that last-known actual plan retention is already enabled." : undefined,
  });
  const queryStore = step("query-store-history", {
    id: "query-store-history",
    title: "Review existing Query Store history",
    purpose: "Retrieve retained plans and runtime aggregates for the selected query hash from the affected database.",
    command: queryStoreCommand(candidate, caseId),
    availability: !queryHash ? "Unavailable" : !snapshot ? "Unknown" : queryStoreDatabaseMismatch || !queryStoreAvailable ? "Unavailable" : !queryStoreDatabaseKnown ? "Unknown" : queryStorePermission === true ? "Available" : queryStorePermission === false ? "Unavailable" : "Unknown",
    unavailableReason: !queryHash ? "The selected candidate does not contain a valid 8-byte query_hash." : !snapshot ? "Import a capability snapshot to verify Query Store." : queryStoreDatabaseMismatch ? `The selected candidate belongs to database ${candidate?.identity.databaseId}, but the snapshot was captured in database ${snapshot.databaseId}. Run and import the snapshot from the affected database.` : !queryStoreAvailable ? `Query Store state is ${snapshot.queryStoreState ?? "unknown"}; SQL Evaluate will not enable it.` : !queryStoreDatabaseKnown ? "The capability snapshot does not identify the affected database." : queryStorePermission === false ? (major !== null && major >= 16 ? "VIEW DATABASE PERFORMANCE STATE (or the broader VIEW DATABASE STATE) was not granted." : "VIEW DATABASE STATE was not granted.") : queryStorePermission === null ? "The database performance-state permission could not be determined." : undefined,
    selectionReason: queryStoreAvailable && queryStoreDatabaseKnown && !queryStoreDatabaseMismatch && queryStorePermission === true ? "The affected database reports existing Query Store history." : undefined,
  });
  const controlled = step("controlled-actual-plan", {
    id: "controlled-actual-plan",
    title: "Capture a controlled representative actual plan",
    purpose: "Acquire current runtime counters when retained-plan sources cannot answer the question.",
    command: controlledActualInstructions(),
    availability: "Approval required",
    selectionReason: "Use only after read-only retained-plan paths are unavailable or returned no plan.",
    requiresApproval: true,
  });
  const xe = step("xe-post-execution-showplan", {
    id: "xe-post-execution-showplan",
    title: "Last resort: filtered Extended Events Showplan",
    purpose: "Capture rapidly evicted executions only after cache, last-known actual, Query Store, and controlled capture paths are unsuitable.",
    command: extendedEventsShowplanCommand(caseId),
    availability: "Approval required",
    selectionReason: "This is a high-overhead last resort and is never automatically preferred.",
    requiresApproval: true,
  });
  const result = [capability, cached, lastKnown, queryStore, controlled, xe];
  if (blitz) capability.selectionReason = `Capability snapshot imported; compatible ${blitz.objectName} ${blitz.version ?? "version unknown"} was also detected for bounded spill ranking.`;
  return result;
}

export function recommendedSpillStepId(steps: DeepCollectionStep[], hasConnectedPlan: boolean, hasActualPlan: boolean, hasSnapshot: boolean, hasCandidate = true, hasQueryStoreEvidence = false): string | undefined {
  if (hasActualPlan || !hasCandidate) return undefined;
  if (!hasSnapshot) return "server-capability-snapshot";
  const retainedHistory = hasQueryStoreEvidence ? [] : ["query-store-history"];
  const preferred = hasConnectedPlan ? ["last-known-actual-plan", ...retainedHistory, "controlled-actual-plan"] : ["cached-plan-provenance", "last-known-actual-plan", ...retainedHistory, "controlled-actual-plan"];
  return preferred.find((id) => {
    const value = steps.find((item) => item.id === id)?.availability;
    return value === "Available" || value === "Approval required";
  }) ?? steps.find((item) => item.availability === "Available")?.id;
}
