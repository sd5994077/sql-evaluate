import type { AnalysisInput, SupplementalEvidenceKind, SupplementalEvidenceSource } from "../types";
import { sourceIdFor } from "./normalize";

const METRIC_ALIASES: Record<string, string> = {
  processor_pct_time: "processor_pct_time",
  sqlserver_processes_pct_time: "sqlserver_processes_pct_time",
  signal_wait_time_pct: "signal_wait_time_pct",
  batch_requests_per_sec: "batch_requests_per_sec",
  runnable_tasks_count: "runnable_tasks_count",
  sql_compilations_per_sec: "sql_compilations_per_sec",
  sql_re_compilations_per_sec: "sql_re_compilations_per_sec",
  cache_hit_ratio_plan_cache_pct: "cache_hit_ratio_plan_cache_pct",
  resource_semaphore_query_compile_waiting_tasks: "resource_semaphore_query_compile_waiting_tasks",
  active_worker_threads: "active_worker_threads",
  max_worker_threads: "max_worker_threads",
  work_queue_count: "work_queue_count",
  pending_diskio_count: "pending_diskio_count",
  memory_grants_pending: "memory_grants_pending",
  memory_grants_outstanding: "memory_grants_outstanding",
  granted_workspace_memory_kb: "granted_workspace_memory_kb",
  tempdb_data_file_size_kb: "tempdb_data_file_size_kb",
  resource_semaphore_waiting_tasks: "resource_semaphore_waiting_tasks",
};

function header(value: unknown): string {
  return String(value ?? "").replace(/^\uFEFF/, "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function numeric(value: unknown): number | null {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const parsed = Number(String(value).replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function evidenceKind(headers: string[]): SupplementalEvidenceKind | null {
  const columns = new Set(headers);
  if (columns.has("processor_pct_time") && columns.has("signal_wait_time_pct") && columns.has("runnable_tasks_count")) return "Scheduler counters";
  if (columns.has("sql_compilations_per_sec") && columns.has("batch_requests_per_sec")) return "Compilation counters";
  if (columns.has("active_worker_threads") && columns.has("max_worker_threads") && columns.has("work_queue_count")) return "Worker counters";
  if (columns.has("memory_grants_pending") && columns.has("granted_workspace_memory_kb") && columns.has("tempdb_data_file_size_kb")) return "Memory counters";
  if (columns.has("query_id") && columns.has("plan_id") && (columns.has("avg_duration_ms") || columns.has("query_sql_text"))) return "Query Store";
  return null;
}

export function parseSupplementalEvidence(file: File, matrix: unknown[][]): { input: AnalysisInput; evidence: SupplementalEvidenceSource } | null {
  const rawHeaders = matrix[0] ?? [];
  const headers = rawHeaders.map(header);
  const kind = evidenceKind(headers);
  if (!kind) return null;
  const sourceId = sourceIdFor(file.name);
  const rows = matrix.slice(1).filter((row) => row.some((value) => value !== null && value !== undefined && String(value).trim() !== ""));
  const timeIndex = headers.findIndex((value) => ["collection_time", "captured_at", "runtime_interval_start"].includes(value));
  const metricIndexes = headers.map((value, index) => ({ index, metric: METRIC_ALIASES[value] })).filter((item): item is { index: number; metric: string } => Boolean(item.metric));
  const samples = rows.map((row) => {
    const metrics: Record<string, number> = {};
    for (const { index, metric } of metricIndexes) {
      const value = numeric(row[index]);
      if (value !== null) metrics[metric] = value;
    }
    const rawTime = timeIndex >= 0 ? String(row[timeIndex] ?? "").trim() : "";
    return { collectionTime: rawTime || null, metrics };
  });
  return {
    input: {
      id: sourceId,
      fileName: file.name,
      size: file.size,
      format: "csv",
      rowCount: rows.length,
      recognizedColumns: rawHeaders.map((value) => String(value ?? "").trim()).filter(Boolean),
      unknownColumns: [],
      warnings: [`Recognized as ${kind.toLowerCase()} and used as supplemental evidence.`],
    },
    evidence: { id: `${sourceId}-supplemental`, sourceId, fileName: file.name, kind, samples, rowCount: rows.length },
  };
}
