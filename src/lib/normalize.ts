import type { WaitInfo, WhoIsActiveRecord } from "../types";
import { canonicalColumn, normalizeHeader } from "../schema";
import { asIsoDate, asNumber, asText, differenceSeconds, durationTextToSeconds, makeId } from "./utils";

const BENIGN_WAITS = ["WAITFOR", "LAZYWRITER_SLEEP", "SLEEP_TASK", "BROKER_", "XE_TIMER_EVENT", "ONDEMAND_TASK_QUEUE"];
const GROUPED_INTEGER_PATTERN = "(?:\\d+|\\d{1,3}(?:,\\d{3})+)";
const NATIVE_WAIT_PATTERN = new RegExp(`^\\(\\s*(?:(${GROUPED_INTEGER_PATTERN})x\\s*:\\s*)?(${GROUPED_INTEGER_PATTERN}\\s*ms(?:\\s*\\/\\s*${GROUPED_INTEGER_PATTERN}\\s*ms){0,2})\\s*\\)\\s*([^:\\s]+)\\s*(?::\\s*(.*))?$`, "i");
const NAMED_WAITTIME_PATTERN = new RegExp(`(?:^|\\s)waittime\\s*=\\s*(${GROUPED_INTEGER_PATTERN})(?=\\s|$)`, "i");

function groupedInteger(value: string): number | null {
  const parsed = Number(value.replaceAll(",", ""));
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function waitCategory(type: string): string {
  const upper = type.toUpperCase();
  if (BENIGN_WAITS.some((prefix) => upper.startsWith(prefix))) return "Benign / queue";
  if (upper.startsWith("LCK_")) return "Locking";
  if (upper.startsWith("PAGEIOLATCH_") || ["IO_COMPLETION", "ASYNC_IO_COMPLETION"].includes(upper)) return "Storage I/O";
  if (upper === "WRITELOG") return "Transaction log";
  if (upper === "RESOURCE_SEMAPHORE_QUERY_COMPILE") return "Compilation";
  if (upper.startsWith("RESOURCE_SEMAPHORE")) return "Memory grant";
  if (upper === "THREADPOOL") return "Worker threads";
  if (upper === "ASYNC_NETWORK_IO") return "Network / client";
  if (upper.startsWith("PAGELATCH_") || upper.startsWith("LATCH_")) return "Latch / tempdb";
  if (["CXPACKET", "CXCONSUMER", "CXSYNC_PORT", "CXSYNC_CONSUMER"].includes(upper)) return "Parallelism";
  if (upper.startsWith("PREEMPTIVE_") || ["OLEDB", "CLR_AUTO_EVENT"].includes(upper)) return "External";
  return "Other";
}

export function parseWait(value: unknown): WaitInfo | null {
  const text = asText(value);
  if (!text) return null;
  const parenthesized = text.match(NATIVE_WAIT_PATTERN);
  if (text.startsWith("(") && !parenthesized) return null;
  const namedDuration = text.match(NAMED_WAITTIME_PATTERN);
  const plainType = text.match(/^([A-Za-z0-9_]+)(?:[\s:]|$)/)?.[1];
  const type = (parenthesized?.[3] ?? plainType)?.trim();
  if (!type) return null;
  const durationsMs = parenthesized
    ? [...parenthesized[2].matchAll(new RegExp(`(${GROUPED_INTEGER_PATTERN})\\s*ms`, "gi"))].map((match) => groupedInteger(match[1]))
    : namedDuration ? [groupedInteger(namedDuration[1])] : [];
  if (durationsMs.some((duration) => duration === null)) return null;
  const taskCount = parenthesized?.[1] ? groupedInteger(parenthesized[1]) : parenthesized ? 1 : null;
  if (taskCount !== null && taskCount < 1) return null;
  const validDurations = durationsMs as number[];
  return {
    durationMs: validDurations.length ? Math.max(...validDurations) : null,
    durationsMs: validDurations,
    taskCount,
    type,
    detail: parenthesized ? parenthesized[4]?.trim() || undefined : text.slice(type.length).trim() || undefined,
    category: waitCategory(type),
  };
}

function canonicalizeRow(headers: unknown[], row: unknown[]): Record<string, unknown> {
  const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  headers.forEach((header, index) => {
    const key = canonicalColumn(header) ?? (normalizeHeader(header) || `column_${index + 1}`);
    if (record[key] !== undefined) record[`${key}__${index + 1}`] = row[index] ?? null;
    else record[key] = row[index] ?? null;
  });
  return record;
}

function pick(record: Record<string, unknown>, name: string): unknown {
  const exact = Object.keys(record).find((key) => key.toLowerCase() === name.toLowerCase());
  return exact ? record[exact] : null;
}

export function normalizeRows(sourceId: string, matrix: unknown[][], headerIndex: number): WhoIsActiveRecord[] {
  const headers = matrix[headerIndex] ?? [];
  return matrix.slice(headerIndex + 1)
    .filter((row) => row.some((value) => value !== null && value !== undefined && String(value).trim() !== ""))
    .map((row, index) => {
      const original = canonicalizeRow(headers, row);
      const collectionTime = asIsoDate(pick(original, "collection_time"));
      const startTime = asIsoDate(pick(original, "start_time"));
      const duration = durationTextToSeconds(pick(original, "dd hh:mm:ss.mss")) ?? differenceSeconds(startTime, collectionTime);
      const waitText = asText(pick(original, "wait_info"));
      const wait = parseWait(waitText);
      return {
        id: `${sourceId}-row-${headerIndex + index + 2}`,
        sourceId,
        rowNumber: headerIndex + index + 2,
        sessionId: asNumber(pick(original, "session_id")),
        requestId: asNumber(pick(original, "request_id")),
        collectionTime,
        startTime,
        tranStartTime: asIsoDate(pick(original, "tran_start_time")),
        loginTime: asIsoDate(pick(original, "login_time")),
        durationSeconds: duration,
        wait,
        waitParseWarning: waitText?.startsWith("(") && !wait ? "The parenthesized wait_info value could not be parsed." : null,
        status: asText(pick(original, "status"))?.toLowerCase() ?? null,
        blockingSessionId: asNumber(pick(original, "blocking_session_id")),
        blockedSessionCount: asNumber(pick(original, "blocked_session_count")),
        openTranCount: asNumber(pick(original, "open_tran_count")),
        implicitTran: asText(pick(original, "implicit_tran")) ? asText(pick(original, "implicit_tran"))!.toUpperCase() === "ON" : null,
        cpuMs: asNumber(pick(original, "CPU_delta")) ?? asNumber(pick(original, "CPU")),
        reads: asNumber(pick(original, "reads_delta")) ?? asNumber(pick(original, "reads")),
        writes: asNumber(pick(original, "writes_delta")) ?? asNumber(pick(original, "writes")),
        physicalReads: asNumber(pick(original, "physical_reads_delta")) ?? asNumber(pick(original, "physical_reads")),
        usedMemoryPages: asNumber(pick(original, "used_memory_delta")) ?? asNumber(pick(original, "used_memory")),
        tempdbAllocationPages: asNumber(pick(original, "tempdb_allocations_delta")) ?? asNumber(pick(original, "tempdb_allocations")),
        tempdbCurrentPages: asNumber(pick(original, "tempdb_current_delta")) ?? asNumber(pick(original, "tempdb_current")),
        sqlText: asText(pick(original, "sql_text")),
        sqlCommand: asText(pick(original, "sql_command")),
        queryPlanXml: asText(pick(original, "query_plan")),
        databaseName: asText(pick(original, "database_name")),
        loginName: asText(pick(original, "login_name")),
        hostName: asText(pick(original, "host_name")),
        programName: asText(pick(original, "program_name")),
        original,
      } satisfies WhoIsActiveRecord;
    });
}

export function sourceIdFor(name: string): string {
  return `${name.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase()}-${makeId("src").slice(-12)}`;
}
