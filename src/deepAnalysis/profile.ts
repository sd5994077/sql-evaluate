import type { Finding } from "../types";
import type { DeepProfileId } from "./types";

export const CPU_BACKED_BLOCKING_PROFILE = {
  id: "cpu-backed-blocking" as const,
  title: "CPU-backed blocking cascade",
  shortTitle: "CPU + blocking",
  description: "Tests whether scheduler pressure is extending the life of a root transaction and amplifying a blocking chain.",
  version: "1.0",
  overhead: "Moderate" as const,
};

export const DEEP_ANALYSIS_PROFILE_CATALOG = [
  { id: "cpu-backed-blocking", label: "CPU-backed blocking", status: "Ready", detail: "Scheduler queues, open transactions, lock ownership, grants, and a same-moment plan." },
  { id: "transaction-blocking", label: "Transaction-owned blocking", status: "Ready", detail: "Sleeping owners, open transactions, retained locks, outer commands, and connection ownership." },
  { id: "worker-exhaustion", label: "Worker exhaustion", status: "Ready", detail: "THREADPOOL waits, worker ceilings, scheduler queues, and incoming concurrency." },
  { id: "compile-pressure", label: "Compilation pressure", status: "Ready", detail: "Compile semaphores, compilation rates, single-use plans, cache-hit movement, and parameterization." },
  { id: "memory-grants", label: "Memory grant pressure", status: "Ready", detail: "Pending grants, RESOURCE_SEMAPHORE, grant waste, spills, and concurrency." },
  { id: "plan-specific", label: "Plan-specific diagnosis", status: "Ready", detail: "Serialization, scalar UDFs, implicit conversion, residual predicates, estimates, and spills." },
  { id: "actual-plan", label: "Actual-plan acquisition", status: "Ready", detail: "Representative runtime counters without inventing conclusions from estimated plans." },
  { id: "deadlocks", label: "Deadlocks", status: "Planned", detail: "Victim graphs, lock order, transaction scope, and statement or plan evidence." },
  { id: "tempdb-io", label: "TempDB + storage", status: "Planned", detail: "File latency, allocation pressure, spills, latches, and task-level TempDB use." },
] as const;

export function deepAnalysisProfileForFinding(finding: Finding): DeepProfileId | null {
  if (finding.severity === "Informational") return null;
  if (finding.ruleId === "WIA-BLOCKING" && finding.blockingContext) {
    const sleepingOpen = finding.blockingContext.status?.toLowerCase() === "sleeping" && (finding.blockingContext.openTransactionCount ?? 0) > 0;
    return sleepingOpen ? "transaction-blocking" : finding.blockingContext.status?.toLowerCase() === "runnable" ? "cpu-backed-blocking" : "transaction-blocking";
  }
  if (finding.ruleId === "WIA-WORKER-EXHAUSTION") return "worker-exhaustion";
  if (finding.ruleId === "WIA-COMPILE-PRESSURE") return "compile-pressure";
  if (["PLAN-MEMORY-GRANT", "PLAN-SPILL"].includes(finding.ruleId) || (finding.ruleId === "WIA-WAIT" && finding.title.includes("RESOURCE_SEMAPHORE"))) return "memory-grants";
  if (["PLAN-SERIALIZATION", "PLAN-SCALAR-UDF", "PLAN-CONVERT", "PLAN-RESIDUAL-PREDICATE", "PLAN-ESTIMATE"].includes(finding.ruleId)) return "plan-specific";
  if (finding.ruleId === "PLAN-RUNTIME-UNAVAILABLE") return "actual-plan";
  return null;
}

export function profileLabel(profileId: DeepProfileId): string {
  return DEEP_ANALYSIS_PROFILE_CATALOG.find((profile) => profile.id === profileId)?.label ?? profileId;
}

function safeCaseTag(caseId: string): string {
  return caseId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80) || "UNASSIGNED";
}

export function cpuBlockingCollectionCommand(rootSessionId: number | null, caseId = "UNASSIGNED"): string {
  const sessionId = Number.isInteger(rootSessionId) && (rootSessionId ?? 0) > 0 ? rootSessionId : 0;
  const caseTag = safeCaseTag(caseId);
  return `/* SQL Evaluate Deep Analysis: CPU-backed blocking cascade
   Read-only. Run briefly during the incident and save each result grid as CSV/XLSX.
   SQL Evaluate never executes this script. */
SET NOCOUNT ON;
DECLARE @TargetSessionId smallint = ${sessionId};
DECLARE @SqlEvaluateCase varchar(80) = '${caseTag}';

/* 1. Root request, current text, and same-moment cached plan */
SELECT 'SQL_EVALUATE_NATIVE_V1' AS adapter_id, @SqlEvaluateCase AS case_id,
       'REQUEST_PLAN' AS evidence_set, 1 AS sample_id, SYSDATETIMEOFFSET() AS captured_at,
       r.session_id, r.request_id, r.status, r.scheduler_id,
       r.blocking_session_id, r.open_transaction_count, r.wait_type,
       r.wait_time, r.wait_resource, r.cpu_time, r.total_elapsed_time,
       r.reads, r.writes, r.logical_reads, r.granted_query_memory,
       r.sql_handle, r.plan_handle, st.text AS batch_text, qp.query_plan
FROM sys.dm_exec_requests AS r
OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) AS st
OUTER APPLY sys.dm_exec_query_plan(r.plan_handle) AS qp
WHERE r.session_id = @TargetSessionId OR r.blocking_session_id = @TargetSessionId;

/* 2. Scheduler queues: runnable workers wait for CPU; work queue tasks wait for a worker */
SELECT 'SQL_EVALUATE_NATIVE_V1' AS adapter_id, @SqlEvaluateCase AS case_id,
       'SCHEDULERS' AS evidence_set, 1 AS sample_id, SYSDATETIMEOFFSET() AS captured_at,
       scheduler_id, cpu_id, status, is_idle, current_tasks_count,
       runnable_tasks_count, current_workers_count, active_workers_count,
       work_queue_count, context_switches_count, yield_count,
       pending_disk_io_count, total_cpu_usage_ms, total_scheduler_delay_ms
FROM sys.dm_os_schedulers
WHERE status = 'VISIBLE ONLINE' AND scheduler_id < 255;

/* 3. First cumulative counter sample */
SELECT 'SQL_EVALUATE_NATIVE_V1' AS adapter_id, @SqlEvaluateCase AS case_id,
       'COMPILATION_COUNTERS' AS evidence_set, 1 AS sample_id, SYSDATETIMEOFFSET() AS captured_at,
       counter_name, instance_name, cntr_value, cntr_type
FROM sys.dm_os_performance_counters
WHERE object_name LIKE '%:SQL Statistics%'
  AND counter_name IN ('Batch Requests/sec', 'SQL Compilations/sec', 'SQL Re-Compilations/sec');

/* Two seconds is enough to distinguish a single runnable instant from a repeated clue.
   Increase only under an approved incident procedure. */
WAITFOR DELAY '00:00:02';

/* 4. Second scheduler and counter samples */
SELECT 'SQL_EVALUATE_NATIVE_V1' AS adapter_id, @SqlEvaluateCase AS case_id,
       'SCHEDULERS' AS evidence_set, 2 AS sample_id, SYSDATETIMEOFFSET() AS captured_at,
       scheduler_id, cpu_id, status, is_idle, current_tasks_count,
       runnable_tasks_count, current_workers_count, active_workers_count,
       work_queue_count, context_switches_count, yield_count,
       pending_disk_io_count, total_cpu_usage_ms, total_scheduler_delay_ms
FROM sys.dm_os_schedulers
WHERE status = 'VISIBLE ONLINE' AND scheduler_id < 255;

SELECT 'SQL_EVALUATE_NATIVE_V1' AS adapter_id, @SqlEvaluateCase AS case_id,
       'COMPILATION_COUNTERS' AS evidence_set, 2 AS sample_id, SYSDATETIMEOFFSET() AS captured_at,
       counter_name, instance_name, cntr_value, cntr_type
FROM sys.dm_os_performance_counters
WHERE object_name LIKE '%:SQL Statistics%'
  AND counter_name IN ('Batch Requests/sec', 'SQL Compilations/sec', 'SQL Re-Compilations/sec');

/* 5. Transaction ownership plus granted/waiting locks for the complete visible chain */
;WITH BlockingChain AS
(
    SELECT @TargetSessionId AS session_id,
           CAST('/' + CONVERT(varchar(11), @TargetSessionId) + '/' AS varchar(8000)) AS visited
    UNION ALL
    SELECT r.session_id,
           CAST(parent.visited + CONVERT(varchar(11), r.session_id) + '/' AS varchar(8000))
    FROM sys.dm_exec_requests AS r
    JOIN BlockingChain AS parent ON r.blocking_session_id = parent.session_id
    WHERE parent.visited NOT LIKE '%/' + CONVERT(varchar(11), r.session_id) + '/%'
)
SELECT 'SQL_EVALUATE_NATIVE_V1' AS adapter_id, @SqlEvaluateCase AS case_id,
       'TRANSACTIONS_LOCKS' AS evidence_set, 2 AS sample_id, SYSDATETIMEOFFSET() AS captured_at,
       chain.session_id, es.open_transaction_count, tl.request_session_id,
       st.transaction_id, at.transaction_begin_time,
       at.transaction_type, at.transaction_state, tl.resource_type,
       tl.resource_database_id, tl.resource_associated_entity_id,
       tl.resource_description, tl.resource_subtype, tl.resource_lock_partition,
       tl.request_mode, tl.request_status,
       tl.request_owner_type, tl.request_owner_id
FROM BlockingChain AS chain
JOIN sys.dm_tran_locks AS tl ON tl.request_session_id = chain.session_id
LEFT JOIN sys.dm_exec_sessions AS es ON es.session_id = chain.session_id
LEFT JOIN sys.dm_tran_session_transactions AS st
  ON st.session_id = chain.session_id
 AND tl.request_owner_type = 'TRANSACTION'
 AND tl.request_owner_id = st.transaction_id
LEFT JOIN sys.dm_tran_active_transactions AS at ON at.transaction_id = st.transaction_id
OPTION (MAXRECURSION 100);

/* 6. Workspace grants and pending grant pressure */
SELECT 'SQL_EVALUATE_NATIVE_V1' AS adapter_id, @SqlEvaluateCase AS case_id,
       'MEMORY_GRANTS' AS evidence_set, 2 AS sample_id, SYSDATETIMEOFFSET() AS captured_at,
       session_id, request_id, scheduler_id, dop, request_time, grant_time,
       requested_memory_kb, granted_memory_kb, required_memory_kb,
       used_memory_kb, max_used_memory_kb, wait_time_ms, queue_id
FROM sys.dm_exec_query_memory_grants
WHERE session_id = @TargetSessionId OR grant_time IS NULL;`;
}

export function lastKnownActualPlanCommand(rootSessionId: number | null, caseId = "UNASSIGNED"): string {
  const sessionId = Number.isInteger(rootSessionId) && (rootSessionId ?? 0) > 0 ? rootSessionId : 0;
  return `/* SQL Evaluate escalation: last-known actual plan. Read-only.
   This works only when LAST_QUERY_PLAN_STATS is already enabled and SQL Server retained the plan. */
SET NOCOUNT ON;
DECLARE @TargetSessionId smallint = ${sessionId};
DECLARE @SqlEvaluateCase varchar(80) = '${safeCaseTag(caseId)}';

SELECT name, value, value_for_secondary, is_value_default
FROM sys.database_scoped_configurations
WHERE name = 'LAST_QUERY_PLAN_STATS';

SELECT 'SQL_EVALUATE_NATIVE_V1' AS adapter_id, @SqlEvaluateCase AS case_id,
       'LAST_KNOWN_ACTUAL_PLAN' AS evidence_set, SYSDATETIMEOFFSET() AS captured_at,
       r.session_id, r.request_id, r.sql_handle, r.plan_handle,
       r.statement_start_offset, r.statement_end_offset, qps.query_plan
FROM sys.dm_exec_requests AS r
OUTER APPLY sys.dm_exec_query_plan_stats(r.plan_handle) AS qps
WHERE r.session_id = @TargetSessionId;`;
}

export function queryStoreExportCommand(caseId = "UNASSIGNED"): string {
  return `/* SQL Evaluate escalation: existing Query Store history. Read-only.
   Run in the affected database. This script does not enable or change Query Store. */
SET NOCOUNT ON;
DECLARE @SqlEvaluateCase varchar(80) = '${safeCaseTag(caseId)}';
DECLARE @QueryHash binary(8) = NULL; -- Replace with the confirmed query_hash.
DECLARE @Since datetime2 = DATEADD(hour, -2, SYSUTCDATETIME());

SELECT actual_state_desc, desired_state_desc, readonly_reason,
       current_storage_size_mb, max_storage_size_mb
FROM sys.database_query_store_options;

SELECT 'QUERY_STORE_EXPORT_V1' AS adapter_id, @SqlEvaluateCase AS case_id,
       'QUERY_STORE' AS evidence_set, SYSUTCDATETIME() AS captured_at,
       q.query_id, p.plan_id, q.query_hash, qt.query_sql_text,
       p.query_plan, p.is_forced_plan, p.force_failure_count,
       rsi.start_time AS runtime_interval_start, rsi.end_time AS runtime_interval_end,
       rs.count_executions, rs.avg_duration, rs.avg_cpu_time,
       rs.avg_logical_io_reads, rs.avg_query_max_used_memory
FROM sys.query_store_query AS q
JOIN sys.query_store_query_text AS qt ON qt.query_text_id = q.query_text_id
JOIN sys.query_store_plan AS p ON p.query_id = q.query_id
LEFT JOIN sys.query_store_runtime_stats AS rs ON rs.plan_id = p.plan_id
LEFT JOIN sys.query_store_runtime_stats_interval AS rsi ON rsi.runtime_stats_interval_id = rs.runtime_stats_interval_id
WHERE @QueryHash IS NOT NULL
  AND q.query_hash = @QueryHash
  AND (rsi.start_time IS NULL OR rsi.end_time >= @Since)
ORDER BY rsi.start_time, p.plan_id;`;
}

export function extendedEventsShowplanCommand(caseId = "UNASSIGNED"): string {
  const sessionName = `SQL_Evaluate_${safeCaseTag(caseId)}`.slice(0, 100);
  return `/* SQL Evaluate LAST RESORT: filtered post-execution Showplan Extended Events.
   ADMINISTRATIVE, NOT READ-ONLY. Requires separate approval.
   query_post_execution_showplan can add substantial CPU and storage overhead.
   Replace the database ID literal below, keep the duration short, and always run the STOP/DROP cleanup. */

CREATE EVENT SESSION [${sessionName}] ON SERVER
ADD EVENT sqlserver.query_post_execution_showplan
(
  ACTION(sqlserver.database_id, sqlserver.session_id, sqlserver.sql_text)
  WHERE (sqlserver.database_id = 0) -- REQUIRED: replace 0 with one confirmed database_id.
)
ADD TARGET package0.event_file
(
  SET filename = N'SQL_Evaluate_Showplan.xel', max_file_size = 64, max_rollover_files = 2
)
WITH (MAX_MEMORY = 4096 KB, EVENT_RETENTION_MODE = ALLOW_SINGLE_EVENT_LOSS,
      MAX_DISPATCH_LATENCY = 5 SECONDS, TRACK_CAUSALITY = ON, STARTUP_STATE = OFF);

ALTER EVENT SESSION [${sessionName}] ON SERVER STATE = START;
-- Reproduce or wait briefly for the target statement, then immediately run cleanup below.
ALTER EVENT SESSION [${sessionName}] ON SERVER STATE = STOP;
DROP EVENT SESSION [${sessionName}] ON SERVER;

/* Export only the target event rows as XML or CSV for SQL Evaluate.
   SQL Evaluate does not directly parse binary .xel files in this release. */`;
}
