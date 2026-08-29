export const WHOISACTIVE_COLUMNS = [
  "session_id", "dd hh:mm:ss.mss", "dd hh:mm:ss.mss (avg)", "avg_elapsed_time",
  "physical_io", "physical_io_delta", "reads", "reads_delta", "writes", "writes_delta",
  "physical_reads", "physical_reads_delta", "CPU", "CPU_delta", "context_switches",
  "context_switches_delta", "used_memory", "used_memory_delta", "tasks", "status",
  "wait_info", "tran_start_time", "tran_log_writes", "implicit_tran", "open_tran_count",
  "tempdb_allocations", "tempdb_allocations_delta", "tempdb_current", "tempdb_current_delta",
  "blocking_session_id", "blocked_session_count", "percent_complete", "host_name", "login_name",
  "database_name", "program_name", "additional_info", "start_time", "login_time", "request_id",
  "collection_time", "sql_text", "sql_command", "query_plan", "locks", "memory_info",
  "requested_memory", "granted_memory", "max_used_memory", "max_used_memory_delta",
] as const;

const canonical = new Map(WHOISACTIVE_COLUMNS.map((column) => [column.toLowerCase(), column]));

export function normalizeHeader(value: unknown): string {
  return String(value ?? "")
    .replace(/^\uFEFF/, "")
    .trim()
    .replace(/^\[|\]$/g, "")
    .replace(/\s+/g, " ");
}

export function canonicalColumn(value: unknown): string | null {
  const normalized = normalizeHeader(value);
  return canonical.get(normalized.toLowerCase()) ?? null;
}

export function headerScore(row: unknown[]): number {
  return new Set(row.map(canonicalColumn).filter(Boolean)).size;
}
