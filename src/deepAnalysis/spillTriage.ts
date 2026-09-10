import type { PlanDocument, PlanOperator, PlanStatement } from "../types";
import { matchQueryIdentity } from "./correlation";
import type { DeepQueryIdentity, SpillCandidate, SpillImportSummary, SpillManualPlanSelection, SpillNumericMetric, SpillPlanEvidence } from "./types";

const NULL_TEXT = /^(?:null|n\/a|none|not supplied)$/i;

export function normalizeSpillHeader(value: unknown): string {
  return String(value ?? "").trim().replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().replace(/#/g, " number ").replace(/8\s*k(?:b)?(?:\s*pages?)?/g, " pages ").replace(/[^a-z0-9]+/g, "_").replace(/(?:pages_)+pages/g, "pages").replace(/^_|_$/g, "");
}

const ALIASES = {
  totalSpills: ["total_spills", "total_spill", "total_spilled_pages", "total_spills_pages", "total_spills_8kb_pages"],
  averageSpills: ["avg_spills", "average_spills", "average_spill", "avg_spilled_pages", "average_spills_pages"],
  minimumSpills: ["min_spills", "minimum_spills", "minimum_spill"],
  maximumSpills: ["max_spills", "maximum_spills", "maximum_spill"],
  executions: ["number_executions", "executions", "execution_count", "number_of_executions"],
  lastExecution: ["last_execution", "last_execution_time", "last_executed"],
  totalCpu: ["total_cpu", "total_cpu_ms", "total_worker_time"],
  averageCpu: ["avg_cpu", "average_cpu", "average_cpu_ms", "avg_worker_time"],
  totalDuration: ["total_duration", "total_duration_ms", "total_elapsed_time"],
  averageDuration: ["avg_duration", "average_duration", "average_duration_ms", "avg_elapsed_time"],
  totalReads: ["total_reads", "total_logical_reads"],
  averageReads: ["avg_reads", "average_reads", "average_logical_reads"],
  databaseName: ["database", "database_name", "database_context"],
  objectName: ["object", "object_name", "procedure_name"],
  queryType: ["query_type", "statement_type"],
  warnings: ["warnings", "warning", "findings", "blitzcache_info"],
  planHandle: ["plan_handle", "planhandle"],
  sqlHandle: ["sql_handle", "sqlhandle"],
  queryHash: ["query_hash", "queryhash"],
  queryPlanHash: ["query_plan_hash", "queryplanhash"],
  startOffset: ["statement_start_offset", "start_offset"],
  endOffset: ["statement_end_offset", "end_offset"],
  databaseId: ["database_id", "dbid"],
  queryStoreQueryId: ["query_store_query_id", "query_id"],
  queryStorePlanId: ["query_store_plan_id", "plan_id"],
  queryPlan: ["query_plan", "showplan_xml", "last_query_plan"],
} as const;

const ADMIN_HEADERS = ["remove_plan_handle_from_cache", "remove_plan_from_cache", "freeproccache_command", "cache_removal_command"];
const KNOWN = new Set<string>(Object.values(ALIASES).flat());

interface SpillMetricColumn {
  index: number;
  pageFactor: number;
  sourceUnit: SpillSourceUnit;
  sourceUnitLabel: string;
}

type SpillSourceUnit = "pages" | "bytes" | "kb" | "kib" | "mb" | "mib" | "gb" | "gib";

const SPILL_UNIT_FACTORS: Record<SpillSourceUnit, number> = { pages: 1, bytes: 1 / 8192, kb: 1 / 8, kib: 1 / 8, mb: 128, mib: 128, gb: 131072, gib: 131072 };

function findIndex(headers: string[], aliases: readonly string[]): number {
  for (const alias of aliases) {
    const index = headers.indexOf(alias);
    if (index >= 0) return index;
  }
  return -1;
}

function spillMetricColumns(headers: string[], rawHeaders: string[], aliases: readonly string[]): SpillMetricColumn[] {
  const columns: SpillMetricColumn[] = [];
  const canonical = findIndex(headers, aliases);
  if (canonical >= 0) columns.push({ index: canonical, pageFactor: 1, sourceUnit: "pages", sourceUnitLabel: "8 KB pages" });
  const bases = new Set(aliases.map((alias) => alias.replace(/_(?:8kb_)?pages$/, "")));
  for (let index = 0; index < headers.length; index += 1) {
    const normalized = headers[index].replace(/_(ki|mi|gi)_b$/, "_$1b");
    const match = normalized.match(/_(bytes|kb|kib|mb|mib|gb|gib)$/);
    if (!match || !bases.has(normalized.slice(0, -match[0].length))) continue;
    const sourceUnit = match[1] as SpillSourceUnit;
    const sourceUnitLabel = rawHeaders[index].match(/\b(bytes?|KiB|MiB|GiB|KB|MB|GB)\b/i)?.[0] ?? sourceUnit;
    columns.push({ index, pageFactor: SPILL_UNIT_FACTORS[sourceUnit], sourceUnit, sourceUnitLabel });
  }
  return columns;
}

function text(value: unknown): string | null {
  const result = String(value ?? "").trim();
  return result && !NULL_TEXT.test(result) ? result : null;
}

function numericValue(value: unknown, kind: "number" | "duration" = "number"): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const raw = text(value);
  if (!raw) return null;
  if (kind === "duration") {
    const clock = raw.match(/^(\d+):([0-5]?\d):([0-5]?\d(?:\.\d+)?)$/);
    if (clock) return ((Number(clock[1]) * 60 + Number(clock[2])) * 60 + Number(clock[3])) * 1000;
    const terms = [...raw.matchAll(/([+]?(?:\d+(?:\.\d+)?|\.\d+))\s*(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|hours?|hrs?|days?)/gi)];
    if (terms.length && terms.map((item) => item[0]).join(" ").replace(/\s+/g, "").length >= raw.replace(/[,\s]+/g, "").length) {
      return terms.reduce((sum, item) => {
        const amount = Number(item[1]);
        const unit = item[2].toLowerCase();
        const multiplier = unit.startsWith("d") ? 86_400_000 : unit.startsWith("h") ? 3_600_000 : unit.startsWith("m") && !unit.startsWith("ms") && !unit.startsWith("mill") ? 60_000 : unit.startsWith("s") ? 1000 : 1;
        return sum + amount * multiplier;
      }, 0);
    }
  }
  const cleaned = raw.replaceAll(",", "").replace(/\s*(?:pages?|executions?|reads?|bytes?|kib|mib|gib|kb|mb|gb|ms)\s*$/i, "").trim();
  if (!/^[+]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/i.test(cleaned)) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizedSpillUnit(value: string | undefined): SpillSourceUnit | null {
  if (!value) return null;
  const unit = value.toLowerCase().replace(/\s+/g, "");
  if (/^(?:page|pages|8k|8kb|8kbpage|8kbpages)$/.test(unit)) return "pages";
  if (/^bytes?$/.test(unit)) return "bytes";
  return (["kb", "kib", "mb", "mib", "gb", "gib"] as SpillSourceUnit[]).includes(unit as SpillSourceUnit) ? unit as SpillSourceUnit : null;
}

function spillNumericValue(value: unknown): { value: number; unit: SpillSourceUnit | null; unitLabel: string | null } | null {
  if (typeof value === "number") return Number.isFinite(value) ? { value, unit: null, unitLabel: null } : null;
  const raw = text(value);
  if (!raw) return null;
  const match = raw.replaceAll(",", "").match(/^([+]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?)\s*(8\s*k(?:b)?(?:\s*pages?)?|pages?|bytes?|kib|mib|gib|kb|mb|gb)?$/i);
  if (!match) return null;
  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed)) return null;
  return { value: parsed, unit: normalizedSpillUnit(match[2]), unitLabel: match[2] ?? null };
}

function metric(rawHeader: string | null, rawValue: unknown, unit: SpillNumericMetric["unit"], kind: "number" | "duration" = "number"): SpillNumericMetric {
  const missing = text(rawValue) === null;
  const value = numericValue(rawValue, kind);
  if (missing) return { rawHeader, rawValue, value: null, unit, state: "missing" };
  if (value === null || value < 0) return { rawHeader, rawValue, value: null, unit, state: "invalid" };
  if (value <= 0) return { rawHeader, rawValue, value, unit, state: "zero-or-nonpositive" };
  return { rawHeader, rawValue, value, unit, state: "imported" };
}

function spillMetric(row: unknown[], rawHeaders: string[], columns: SpillMetricColumn[]): SpillNumericMetric {
  if (!columns.length) return metric(null, null, "pages");
  let missing: SpillNumericMetric | null = null;
  for (const column of columns) {
    const rawValue = row[column.index];
    if (text(rawValue) === null) { missing ??= metric(rawHeaders[column.index] || null, rawValue, "pages"); continue; }
    const parsed = spillNumericValue(rawValue);
    if (!parsed || parsed.value < 0) return { rawHeader: rawHeaders[column.index] || null, rawValue, value: null, unit: "pages", state: "invalid", explanation: "The spill value is not a valid nonnegative number with a supported unit." };
    if (parsed.unit && parsed.unit !== column.sourceUnit) {
      return { rawHeader: rawHeaders[column.index] || null, rawValue, value: null, unit: "pages", state: "invalid", explanation: `The cell unit ${parsed.unitLabel} conflicts with the ${column.sourceUnitLabel} column unit.` };
    }
    const value = parsed.value * column.pageFactor;
    const state = value <= 0 ? "zero-or-nonpositive" as const : "imported" as const;
    const explanation = column.pageFactor === 1 ? undefined : `Converted from ${parsed.value.toLocaleString()} ${column.sourceUnitLabel} to ${value.toLocaleString()} 8 KB pages.`;
    return { rawHeader: rawHeaders[column.index] || null, rawValue, value, unit: "pages", state, explanation };
  }
  return missing ?? metric(null, null, "pages");
}

function parseLastExecution(value: unknown): string | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  const raw = text(value);
  if (!raw) return null;
  const sql = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/);
  if (sql) return `${sql[1]}-${sql[2]}-${sql[3]}T${sql[4]}:${sql[5]}:${sql[6]}${sql[7] ? `.${sql[7]}` : ""}`;
  const parsed = new Date(raw);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function identityValue(headers: string[], row: unknown[], aliases: readonly string[]): unknown {
  const index = findIndex(headers, aliases);
  return index >= 0 ? row[index] : null;
}

function identityFrom(headers: string[], row: unknown[]): DeepQueryIdentity {
  const number = (aliases: readonly string[]) => numericValue(identityValue(headers, row, aliases));
  return {
    planHandle: text(identityValue(headers, row, ALIASES.planHandle)),
    sqlHandle: text(identityValue(headers, row, ALIASES.sqlHandle)),
    queryHash: text(identityValue(headers, row, ALIASES.queryHash)),
    queryPlanHash: text(identityValue(headers, row, ALIASES.queryPlanHash)),
    statementStartOffset: number(ALIASES.startOffset),
    statementEndOffset: number(ALIASES.endOffset),
    databaseId: number(ALIASES.databaseId),
    queryStoreQueryId: number(ALIASES.queryStoreQueryId),
    queryStorePlanId: number(ALIASES.queryStorePlanId),
  };
}

function rankGroup(candidate: SpillCandidate): SpillCandidate["rankGroup"] {
  if (candidate.totalSpillPages.value !== null && candidate.totalSpillPages.value > 0) return "total";
  if (candidate.averageSpillPages.value !== null && candidate.averageSpillPages.value > 0) return "average-only";
  return "unranked";
}

function timestamp(value: string | null): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

export function rankSpillCandidates(input: SpillCandidate[]): SpillCandidate[] {
  const candidates = input.map((candidate) => ({ ...candidate, rankGroup: rankGroup(candidate), rank: null }));
  const ranked = candidates.filter((candidate) => candidate.rankGroup !== "unranked").sort((left, right) => {
    if (left.rankGroup !== right.rankGroup) return left.rankGroup === "total" ? -1 : 1;
    if (left.rankGroup === "total") {
      const total = (right.totalSpillPages.value ?? -1) - (left.totalSpillPages.value ?? -1);
      if (total) return total;
    }
    const average = (right.averageSpillPages.value ?? -1) - (left.averageSpillPages.value ?? -1);
    if (average) return average;
    const recent = timestamp(right.lastExecution) - timestamp(left.lastExecution);
    if (recent) return recent;
    return left.sourceOrder - right.sourceOrder;
  });
  const rankedById = new Map(ranked.map((candidate, index) => {
    const total = candidate.totalSpillPages.value;
    const average = candidate.averageSpillPages.value;
    const totalContext = candidate.totalSpillPages.state === "zero-or-nonpositive"
      ? candidate.totalSpillPages.value === 0 ? "Total spill volume was reported as zero" : "Total spill volume was reported as nonpositive"
      : "Total spill volume was not supplied";
    const reason = candidate.rankGroup === "total"
      ? `Ranked by cumulative spill impact: ${total?.toLocaleString()} pages total${average !== null ? `; ${average.toLocaleString()} pages per execution` : ""}.`
      : `${totalContext}; ranked in the average-only group at ${average?.toLocaleString()} pages per execution.`;
    return [candidate.id, { rank: index + 1, rankReason: reason }] as const;
  }));
  return candidates.map((candidate) => {
    const ranking = rankedById.get(candidate.id);
    return ranking ? { ...candidate, ...ranking } : { ...candidate, rankReason: "Numeric spill volume was missing, zero, or malformed, so this row is visible but unranked." };
  }).sort((left, right) => (left.rank ?? Number.MAX_SAFE_INTEGER) - (right.rank ?? Number.MAX_SAFE_INTEGER) || left.sourceOrder - right.sourceOrder);
}

export function topNDisclosure(count: number): string {
  return count === 10
    ? "Ten rows were imported. This is consistent with @Top = 10; it does not prove that only ten cached plans spilled."
    : `${count.toLocaleString()} row${count === 1 ? " was" : "s were"} imported. This may be a bounded top-N result rather than the complete population.`;
}

export function inspectSpillTriageMatrix(matrix: unknown[][], options: { artifactId: string; fileName: string; sheetName?: string | null; sourceOffset?: number }): { candidates: SpillCandidate[]; summary: SpillImportSummary | null } {
  const nonEmpty = matrix.map((row, index) => ({ row, index })).filter(({ row }) => row.some((value) => text(value) !== null));
  const headerEntry = nonEmpty.slice(0, 50).find(({ row }) => {
    const raw = row.map((value) => String(value ?? "").trim());
    const normalized = raw.map(normalizeSpillHeader);
    const spill = spillMetricColumns(normalized, raw, ALIASES.totalSpills).length > 0 || spillMetricColumns(normalized, raw, ALIASES.averageSpills).length > 0 || findIndex(normalized, ALIASES.warnings) >= 0;
    const signature = findIndex(normalized, [...ALIASES.planHandle, ...ALIASES.sqlHandle, ...ALIASES.queryHash, ...ALIASES.queryPlanHash, ...ALIASES.executions, ...ALIASES.totalCpu, ...ALIASES.totalDuration]) >= 0;
    return spill && signature;
  });
  if (!headerEntry) return { candidates: [], summary: null };
  const rawHeaders = headerEntry.row.map((value) => String(value ?? "").trim());
  const headers = rawHeaders.map(normalizeSpillHeader);
  const totalSpillColumns = spillMetricColumns(headers, rawHeaders, ALIASES.totalSpills);
  const averageSpillColumns = spillMetricColumns(headers, rawHeaders, ALIASES.averageSpills);
  const minimumSpillColumns = spillMetricColumns(headers, rawHeaders, ALIASES.minimumSpills);
  const maximumSpillColumns = spillMetricColumns(headers, rawHeaders, ALIASES.maximumSpills);
  const valueAt = (row: unknown[], aliases: readonly string[]) => {
    const index = findIndex(headers, aliases);
    return index >= 0 ? row[index] : null;
  };
  const headerAt = (aliases: readonly string[]) => {
    const index = findIndex(headers, aliases);
    return index >= 0 ? rawHeaders[index] : null;
  };
  const knownIndexes = new Set(headers.map((header, index) => KNOWN.has(header) || ADMIN_HEADERS.includes(header) ? index : -1).filter((index) => index >= 0));
  for (const column of [...totalSpillColumns, ...averageSpillColumns, ...minimumSpillColumns, ...maximumSpillColumns]) knownIndexes.add(column.index);
  const rows = matrix.slice(headerEntry.index + 1).map((row, index) => ({ row, rowNumber: headerEntry.index + index + 2 })).filter(({ row }) => row.some((value) => text(value) !== null));
  const candidates = rows.map(({ row, rowNumber }, index): SpillCandidate => {
    const executionCount = metric(headerAt(ALIASES.executions), valueAt(row, ALIASES.executions), "executions");
    const totalSpillPages = spillMetric(row, rawHeaders, totalSpillColumns);
    let averageSpillPages = spillMetric(row, rawHeaders, averageSpillColumns);
    if (averageSpillPages.state === "missing" && totalSpillPages.value !== null && totalSpillPages.value > 0 && executionCount.value !== null && executionCount.value > 0) {
      averageSpillPages = { rawHeader: null, rawValue: null, value: totalSpillPages.value / executionCount.value, unit: "pages", state: "derived", explanation: `${totalSpillPages.value} total pages / ${executionCount.value} executions` };
    }
    const warning = text(valueAt(row, ALIASES.warnings));
    const administrativeText = headers.flatMap((header, column) => ADMIN_HEADERS.includes(header) || /^\s*dbcc\s+freeproccache/i.test(String(row[column] ?? "")) ? [{ header: rawHeaders[column] || `Column ${column + 1}`, value: String(row[column] ?? "") }] : []);
    return {
      id: `${options.artifactId}:${options.sheetName ?? "csv"}:${rowNumber}`,
      artifactId: options.artifactId,
      fileName: options.fileName,
      sheetName: options.sheetName ?? null,
      rowNumber,
      sourceOrder: (options.sourceOffset ?? 0) + index,
      identity: identityFrom(headers, row),
      databaseName: text(valueAt(row, ALIASES.databaseName)),
      objectName: text(valueAt(row, ALIASES.objectName)),
      queryType: text(valueAt(row, ALIASES.queryType)),
      warnings: warning ? warning.split(/[;|]/).map((item) => item.trim()).filter(Boolean) : [],
      totalSpillPages,
      averageSpillPages,
      minimumSpillPages: spillMetric(row, rawHeaders, minimumSpillColumns),
      maximumSpillPages: spillMetric(row, rawHeaders, maximumSpillColumns),
      executionCount,
      lastExecution: parseLastExecution(valueAt(row, ALIASES.lastExecution)),
      lastExecutionRaw: valueAt(row, ALIASES.lastExecution),
      totalCpu: metric(headerAt(ALIASES.totalCpu), valueAt(row, ALIASES.totalCpu), "milliseconds", "duration"),
      averageCpu: metric(headerAt(ALIASES.averageCpu), valueAt(row, ALIASES.averageCpu), "milliseconds", "duration"),
      totalDuration: metric(headerAt(ALIASES.totalDuration), valueAt(row, ALIASES.totalDuration), "milliseconds", "duration"),
      averageDuration: metric(headerAt(ALIASES.averageDuration), valueAt(row, ALIASES.averageDuration), "milliseconds", "duration"),
      totalReads: metric(headerAt(ALIASES.totalReads), valueAt(row, ALIASES.totalReads), "reads"),
      averageReads: metric(headerAt(ALIASES.averageReads), valueAt(row, ALIASES.averageReads), "reads"),
      administrativeText,
      unknownColumns: rawHeaders.flatMap((header, column) => !knownIndexes.has(column) && text(row[column]) !== null ? [{ header: header || `Column ${column + 1}`, value: row[column] }] : []),
      embeddedPlanXml: text(valueAt(row, ALIASES.queryPlan)) ?? undefined,
      rankGroup: "unranked",
      rank: null,
      rankReason: "Pending ranking.",
    };
  });
  const ranked = rankSpillCandidates(candidates);
  const warnings: string[] = [topNDisclosure(ranked.length), "SQL Evaluate ranked these imported rows locally. The export does not prove which parameters produced it."];
  const requestedMetrics: Array<[string, readonly string[]]> = [
    ["execution count", ALIASES.executions], ["last execution", ALIASES.lastExecution],
    ["CPU", [...ALIASES.totalCpu, ...ALIASES.averageCpu]], ["duration", [...ALIASES.totalDuration, ...ALIASES.averageDuration]], ["reads", [...ALIASES.totalReads, ...ALIASES.averageReads]],
  ];
  const missingMetrics = requestedMetrics.filter(([, aliases]) => findIndex(headers, aliases) < 0).map(([label]) => label);
  if (!totalSpillColumns.length) missingMetrics.unshift("total spills");
  if (!averageSpillColumns.length) missingMetrics.splice(totalSpillColumns.length ? 0 : 1, 0, "average spills");
  if (missingMetrics.length) warnings.push(`Missing metrics: ${missingMetrics.join(", ")}. Missing values are not treated as zero.`);
  const invalidCount = ranked.filter((candidate) => [candidate.totalSpillPages, candidate.averageSpillPages].some((item) => item.state === "invalid")).length;
  if (invalidCount) warnings.push(`${invalidCount} row${invalidCount === 1 ? " contains" : "s contain"} malformed spill values and cannot use those values for ranking.`);
  const convertedCount = ranked.filter((candidate) => [candidate.totalSpillPages, candidate.averageSpillPages, candidate.minimumSpillPages, candidate.maximumSpillPages].some((item) => item.explanation?.startsWith("Converted"))).length;
  if (convertedCount) warnings.push(`${convertedCount} row${convertedCount === 1 ? " includes" : "s include"} an explicitly labeled spill unit converted to 8 KB pages.`);
  const unitConflictCount = ranked.filter((candidate) => [candidate.totalSpillPages, candidate.averageSpillPages, candidate.minimumSpillPages, candidate.maximumSpillPages].some((item) => item.explanation?.includes("conflicts with"))).length;
  if (unitConflictCount) warnings.push(`${unitConflictCount} row${unitConflictCount === 1 ? " has" : "s have"} conflicting header and cell units; those values were rejected rather than guessed.`);
  const warningOnly = ranked.filter((candidate) => candidate.rankGroup === "unranked" && candidate.warnings.length).length;
  if (warningOnly) warnings.push(`${warningOnly} warning-only row${warningOnly === 1 ? " remains" : "s remain"} visible but unranked because numeric spill evidence is absent.`);
  const invalidTimes = ranked.filter((candidate) => text(candidate.lastExecutionRaw) !== null && candidate.lastExecution === null).length;
  if (invalidTimes) warnings.push(`${invalidTimes} last-execution timestamp${invalidTimes === 1 ? " could" : "s could"} not be parsed and did not affect ranking.`);
  const incompleteIdentity = ranked.filter((candidate) => {
    const identity = candidate.identity;
    const queryStore = identity.queryStoreQueryId != null && identity.queryStorePlanId != null && identity.databaseId != null;
    return !queryStore && !identity.planHandle && !identity.sqlHandle && !(identity.queryHash && identity.queryPlanHash);
  }).length;
  if (incompleteIdentity) warnings.push(`${incompleteIdentity} row${incompleteIdentity === 1 ? " lacks" : "s lack"} enough stable plan identity for automatic correlation.`);
  const unscopedQueryStore = ranked.filter((candidate) => candidate.identity.queryStoreQueryId != null && candidate.identity.queryStorePlanId != null && candidate.identity.databaseId == null).length;
  if (unscopedQueryStore) warnings.push(`${unscopedQueryStore} row${unscopedQueryStore === 1 ? " has" : "s have"} Query Store IDs without database context; those IDs cannot establish an automatic match across imported sources.`);
  const batchOnly = ranked.filter((candidate) => candidate.identity.sqlHandle && (candidate.identity.statementStartOffset == null || candidate.identity.statementEndOffset == null)).length;
  if (batchOnly) warnings.push(`${batchOnly} row${batchOnly === 1 ? " has" : "s have"} a batch sql_handle without complete statement offsets and may require manual disambiguation.`);
  const inconsistent = ranked.filter((candidate) => candidate.totalSpillPages.value === 0 && (candidate.averageSpillPages.value ?? 0) > 0).length;
  if (inconsistent) warnings.push(`${inconsistent} row${inconsistent === 1 ? " reports" : "s report"} zero total spills with a positive average and is ranked only in the average-backed group.`);
  return { candidates: ranked, summary: {
    artifactId: options.artifactId,
    fileName: options.fileName,
    sheetName: options.sheetName ?? null,
    headerRow: headerEntry.index + 1,
    importedRows: ranked.length,
    rankableRows: ranked.filter((candidate) => candidate.rank !== null).length,
    recognizedHeaders: rawHeaders.filter((_, index) => knownIndexes.has(index)),
    unknownHeaders: rawHeaders.filter((_, index) => !knownIndexes.has(index)),
    warnings,
  } };
}

export interface SpillPlanResolution {
  connected: boolean;
  ambiguous: boolean;
  blockedByConflict: boolean;
  quality: "Exact" | "Strong" | "Candidate" | "None";
  selectionMethod: "automatic" | "manual" | "none";
  reason: string;
  alternatives: SpillPlanAlternative[];
  evidence?: SpillPlanEvidence;
  statement?: PlanStatement;
}

export interface SpillPlanAlternative {
  artifactId: string;
  fileName: string;
  statementId: string;
  statementIndex: number;
  statementType: string;
  identity: DeepQueryIdentity;
  quality: "Exact" | "Strong";
  reason: string;
}

function normalizedIdentityText(value: string | null | undefined): string | null {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/^0x/, "");
  return normalized || null;
}

function sameIdentityText(left: string | null | undefined, right: string | null | undefined): boolean {
  const normalizedLeft = normalizedIdentityText(left);
  const normalizedRight = normalizedIdentityText(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

function hasExactStatementDiscriminator(candidate: DeepQueryIdentity, statement: DeepQueryIdentity): boolean {
  const offsetsMatch = sameIdentityText(candidate.sqlHandle, statement.sqlHandle)
    && candidate.statementStartOffset != null
    && candidate.statementEndOffset != null
    && candidate.statementStartOffset === statement.statementStartOffset
    && candidate.statementEndOffset === statement.statementEndOffset;
  const hashesMatch = sameIdentityText(candidate.queryHash, statement.queryHash)
    && sameIdentityText(candidate.queryPlanHash, statement.queryPlanHash);
  const queryStoreMatches = candidate.databaseId != null
    && candidate.queryStoreQueryId != null
    && candidate.queryStorePlanId != null
    && candidate.databaseId === statement.databaseId
    && candidate.queryStoreQueryId === statement.queryStoreQueryId
    && candidate.queryStorePlanId === statement.queryStorePlanId;
  return offsetsMatch || hashesMatch || queryStoreMatches;
}

export function resolveCandidatePlan(candidate: SpillCandidate, plans: SpillPlanEvidence[], manualSelection?: SpillManualPlanSelection | null): SpillPlanResolution {
  const weight = { Exact: 3, Strong: 2, Candidate: 1, None: 0 } as const;
  const evaluated = plans.flatMap((evidence) => evidence.plan.statements.map((statement, statementIndex) => {
    const statementIdentity = statement.queryIdentity ?? {};
    const match = matchQueryIdentity(candidate.identity, statementIdentity);
    return { evidence, statement, statementIndex, match };
  }));
  const matches = evaluated.filter((item) => item.match.matched);
  // Prefer runtime evidence, then an exact current cached plan, over retained
  // compile-only history. Equally strong statements of the same evidence kind
  // remain ambiguous.
  const evidencePriority = (item: typeof matches[number]) => item.statement.isActual
    ? 2
    : item.evidence.plan.sourceKind === "Cached estimated" ? 1 : 0;
  matches.sort((left, right) =>
    weight[right.match.quality] - weight[left.match.quality]
    || evidencePriority(right) - evidencePriority(left),
  );
  const best = matches[0];
  const statementLocalConflicts = new Set([
    "query_plan_hash conflicts",
    "statement_start_offset conflicts",
    "statement_end_offset conflicts",
    "Query Store query ID conflicts",
    "Query Store plan ID conflicts",
  ]);
  const isDisambiguatedSiblingConflict = (item: typeof evaluated[number]) => Boolean(
    item.match.conflicts.every((conflict) => statementLocalConflicts.has(conflict))
    && sameIdentityText(candidate.identity.planHandle, item.statement.queryIdentity?.planHandle)
    && matches.some((match) => match.match.quality === "Exact"
      && match.evidence.artifactId === item.evidence.artifactId
      && match.statementIndex !== item.statementIndex
      && sameIdentityText(candidate.identity.planHandle, match.statement.queryIdentity?.planHandle)
      && hasExactStatementDiscriminator(candidate.identity, match.statement.queryIdentity ?? {})),
  );
  const strongestConflict = evaluated
    .filter((item) => item.match.conflicts.length > 0 && !isDisambiguatedSiblingConflict(item))
    .sort((left, right) => weight[right.match.quality] - weight[left.match.quality])[0];
  // A cached batch can contain several statements that share plan_handle. When
  // one statement has an equally strong, non-conflicting match, it is more
  // specific evidence than a sibling statement with different offsets or hashes.
  if (strongestConflict && (!best || weight[strongestConflict.match.quality] >= weight[best.match.quality])) {
    return { connected: false, ambiguous: false, blockedByConflict: true, quality: strongestConflict.match.quality, selectionMethod: "none", reason: strongestConflict.match.reason, alternatives: [] };
  }
  if (!best || weight[best.match.quality] < weight.Strong) return { connected: false, ambiguous: false, blockedByConflict: false, quality: best?.match.quality ?? "None", selectionMethod: "none", reason: best?.match.reason ?? "No supported stable identifier matches.", alternatives: [] };
  const peers = matches.filter((item) =>
    weight[item.match.quality] === weight[best.match.quality]
    && evidencePriority(item) === evidencePriority(best),
  );
  const alternatives: SpillPlanAlternative[] = peers.map((item) => ({
    artifactId: item.evidence.artifactId,
    fileName: item.evidence.fileName,
    statementId: item.statement.id,
    statementIndex: item.statementIndex,
    statementType: item.statement.statementType,
    identity: item.statement.queryIdentity ?? {},
    quality: item.match.quality as "Exact" | "Strong",
    reason: item.match.reason,
  }));
  if (peers.length > 1) {
    const chosen = manualSelection?.candidateId === candidate.id
      ? peers.find((item) => item.evidence.artifactId === manualSelection.artifactId && item.statement.id === manualSelection.statementId)
      : undefined;
    if (chosen) return { connected: true, ambiguous: false, blockedByConflict: false, quality: chosen.match.quality, selectionMethod: "manual", reason: `A user selected this statement from ${peers.length} equally strong, non-conflicting stable-identity matches. Verify the statement offsets or another statement-level identifier before remediation.`, alternatives, evidence: chosen.evidence, statement: chosen.statement };
    return { connected: false, ambiguous: true, blockedByConflict: false, quality: best.match.quality, selectionMethod: "none", reason: `${peers.length} plans or statements share the best stable-identity match. Automatic connection is blocked; choose among these matches or import statement offsets or another unique stable identity.`, alternatives };
  }
  return { connected: true, ambiguous: false, blockedByConflict: false, quality: best.match.quality, selectionMethod: "automatic", reason: best.match.reason, alternatives, evidence: best.evidence, statement: best.statement };
}

export function estimateRatio(operator: PlanOperator): number | null {
  if (operator.actualRows === null || operator.estimatedRows === null) return null;
  const minimum = Math.max(1, Math.min(operator.actualRows, operator.estimatedRows));
  return Math.max(operator.actualRows, operator.estimatedRows) / minimum;
}

export function earliestFeedingEstimateError(statement: PlanStatement, spillingOperator: PlanOperator, minimumRatio = 10, minimumActualRows = 10_000): { operator: PlanOperator; ratio: number; distance: number } | null {
  const byNode = new Map(statement.operators.flatMap((operator) => operator.nodeId === null ? [] : [[operator.nodeId, operator] as const]));
  const queue = (spillingOperator.childNodeIds ?? []).map((nodeId) => ({ nodeId, distance: 1 }));
  const visited = new Set<number>();
  const matches: Array<{ operator: PlanOperator; ratio: number; distance: number }> = [];
  while (queue.length) {
    const current = queue.shift()!;
    if (visited.has(current.nodeId)) continue;
    visited.add(current.nodeId);
    const operator = byNode.get(current.nodeId);
    if (!operator) continue;
    const ratio = estimateRatio(operator);
    if (ratio !== null && ratio >= minimumRatio && (operator.actualRows ?? 0) >= minimumActualRows) matches.push({ operator, ratio, distance: current.distance });
    for (const child of operator.childNodeIds ?? []) queue.push({ nodeId: child, distance: current.distance + 1 });
  }
  return matches.sort((left, right) => right.distance - left.distance || right.ratio - left.ratio || (right.operator.actualRows ?? 0) - (left.operator.actualRows ?? 0) || (left.operator.nodeId ?? 0) - (right.operator.nodeId ?? 0))[0] ?? null;
}

export function spillVolumeGiB(pages: number): number {
  return pages * 8 / 1024 / 1024;
}

export function highestPerExecution(candidates: SpillCandidate[]): SpillCandidate | null {
  return [...candidates].filter((candidate) => (candidate.averageSpillPages.value ?? 0) > 0).sort((a, b) => (b.averageSpillPages.value ?? 0) - (a.averageSpillPages.value ?? 0) || a.sourceOrder - b.sourceOrder)[0] ?? null;
}

export function actualSpillOperators(plan: PlanDocument, statement: PlanStatement): PlanOperator[] {
  if (!plan.isActual || !statement.isActual) return [];
  return statement.operators.filter((operator) => (operator.spillDetails?.length ?? 0) > 0 || operator.warnings.some((warning) => /spill/i.test(warning)));
}
