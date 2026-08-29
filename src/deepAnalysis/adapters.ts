import type { DeepArtifactKind, DeepEvidenceObservation, DeepQueryIdentity } from "./types";

export interface MatrixInspection {
  adapterId: string;
  adapterVersion: string;
  kind: DeepArtifactKind;
  signals: Set<string>;
  details: string[];
  warnings: string[];
  capturedAt: string | null;
  resultSetTypes: string[];
  identity?: DeepQueryIdentity;
  observations: DeepEvidenceObservation[];
}

export function normalizeEvidenceHeader(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/[%/]+/g, " ").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function numeric(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = String(value ?? "").replaceAll(",", "").replace(/\s*(kb|mb|gb|ms|s|%)\s*$/i, "").trim();
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function nullableText(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return !text || /^(?:null|n\/a|none)$/i.test(text) ? null : text;
}

function isoLike(value: unknown): string | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  const text = nullableText(value);
  if (!text) return null;
  const date = new Date(text);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function firstIndex(headers: string[], aliases: string[]): number {
  for (const alias of aliases) {
    const index = headers.indexOf(alias);
    if (index >= 0) return index;
  }
  return -1;
}

function identityFromRow(headers: string[], row: unknown[]): DeepQueryIdentity {
  const value = (aliases: string[]) => {
    const index = firstIndex(headers, aliases);
    return index < 0 ? null : row[index];
  };
  return {
    sessionId: numeric(value(["session_id", "spid"])),
    requestId: numeric(value(["request_id"])),
    transactionId: numeric(value(["transaction_id", "transaction_uow"])),
    sqlHandle: nullableText(value(["sql_handle", "sqlhandle"])),
    planHandle: nullableText(value(["plan_handle", "planhandle"])),
    queryHash: nullableText(value(["query_hash", "queryhash"])),
    queryPlanHash: nullableText(value(["query_plan_hash", "queryplanhash"])),
    statementStartOffset: numeric(value(["statement_start_offset"])),
    statementEndOffset: numeric(value(["statement_end_offset"])),
    queryStoreQueryId: numeric(value(["query_store_query_id", "query_id"])),
    queryStorePlanId: numeric(value(["query_store_plan_id", "plan_id"])),
    databaseId: numeric(value(["database_id", "dbid"])),
  };
}

function hasIdentity(identity: DeepQueryIdentity): boolean {
  return Object.values(identity).some((value) => value !== null && value !== undefined && value !== "");
}

function observation(artifactId: string, index: number, kind: string, metric: string, value: DeepEvidenceObservation["value"], capturedAt: string | null, directness: DeepEvidenceObservation["directness"], identity?: DeepQueryIdentity, unit?: string, detail?: string, signalNames?: string[]): DeepEvidenceObservation {
  return { id: `${artifactId}-obs-${index}`, artifactId, kind, metric, value, capturedAt, directness, identity: identity && hasIdentity(identity) ? identity : undefined, unit, detail, signalNames: signalNames?.length ? [...new Set(signalNames)] : undefined };
}

const BLITZ_SIGNAL_TERMS: Array<[string, string]> = [
  ["plan cache instability", "plan-cache-instability"], ["single-use", "single-use-warning"],
  ["forced serialization", "forced-serialization"], ["compilation timeout", "compilation-timeout"],
  ["unused memory grant", "unused-memory-grant"], ["filter udf", "filter-udf"],
  ["non-sargable", "non-sargable"], ["non sargable", "non-sargable"],
];

function blitzSignalsInText(text: string): string[] {
  const normalized = text.toLowerCase();
  return [...new Set(BLITZ_SIGNAL_TERMS.filter(([term]) => normalized.includes(term)).map(([, signal]) => signal))];
}

function recognizedBlitzCache(headers: string[], text: string): boolean {
  const warning = firstIndex(headers, ["warnings", "warning", "findings", "blitzcache_info"]);
  const identity = firstIndex(headers, ["query_hash", "sql_handle", "plan_handle", "query_plan", "database_name", "executions"]);
  return (warning >= 0 && identity >= 0) || text.includes("sp_blitzcache") || text.includes("plan cache instability");
}

export function inspectEvidenceMatrix(matrix: unknown[][], rootSessionId: number | null, artifactId: string): MatrixInspection {
  const headers = (matrix[0] ?? []).map(normalizeEvidenceHeader);
  const rows = matrix.slice(1).filter((row) => row.some((value) => nullableText(value) !== null));
  const signals = new Set<string>();
  const details: string[] = [];
  const warnings: string[] = [];
  const observations: DeepEvidenceObservation[] = [];
  const resultSetTypes = new Set<string>();
  const column = (...aliases: string[]) => firstIndex(headers, aliases);
  const value = (row: unknown[], ...aliases: string[]) => {
    const index = column(...aliases);
    return index < 0 ? null : row[index];
  };
  const capturedValues = rows.map((row) => isoLike(value(row, "captured_at", "collection_time", "runtime_interval_start", "start_time"))).filter((item): item is string => Boolean(item));
  const capturedAt = capturedValues.sort()[0] ?? null;
  const evidenceSetIndex = column("evidence_set", "result_set", "result_set_type");
  rows.forEach((row) => {
    const set = evidenceSetIndex >= 0 ? nullableText(row[evidenceSetIndex]) : null;
    if (set) resultSetTypes.add(set.toUpperCase());
  });
  const text = matrix.flat().map((item) => String(item ?? "")).join(" ").toLowerCase();
  let kind: DeepArtifactKind = "Diagnostic result";
  let adapterId = "generic-tabular";
  if ([...resultSetTypes].some((type) => ["REQUEST_PLAN", "SCHEDULERS", "TRANSACTIONS_LOCKS", "MEMORY_GRANTS", "COMPILATION_COUNTERS", "LAST_KNOWN_ACTUAL_PLAN"].includes(type))) adapterId = "sql-evaluate-native";
  let observationIndex = 0;

  if (column("runnable_tasks_count") >= 0) {
    adapterId = "sql-evaluate-native";
    kind = "Scheduler";
    resultSetTypes.add("SCHEDULERS");
    const samples = new Map<string, number>();
    let maximum = 0;
    let workerMaximum = 0;
    rows.forEach((row, rowIndex) => {
      const runnable = numeric(value(row, "runnable_tasks_count")) ?? 0;
      const workers = numeric(value(row, "work_queue_count")) ?? 0;
      maximum = Math.max(maximum, runnable);
      workerMaximum = Math.max(workerMaximum, workers);
      const timestamp = isoLike(value(row, "captured_at", "collection_time"));
      const sample = nullableText(value(row, "sample_id"));
      const key = sample ? `sample-${sample}` : timestamp ? `timestamp-${timestamp}` : `unscoped-${rowIndex}`;
      samples.set(key, (samples.get(key) ?? 0) + runnable);
      const identity = identityFromRow(headers, row);
      observations.push(observation(artifactId, observationIndex++, "Scheduler", "runnable_tasks_count", runnable, timestamp, "Direct", identity, "tasks"));
      if (column("total_scheduler_delay_ms") >= 0) observations.push(observation(artifactId, observationIndex++, "Scheduler", "total_scheduler_delay_ms", numeric(value(row, "total_scheduler_delay_ms")), timestamp, "Direct", identity, "milliseconds"));
    });
    if (maximum > 0) signals.add("scheduler-runnable-queue");
    if ([...samples.values()].filter((sample) => sample > 0).length >= 2 && ![...samples.keys()].every((key) => key.startsWith("unscoped-"))) signals.add("scheduler-pressure-sustained");
    if (workerMaximum > 0) signals.add("worker-queue");
    details.push(`Maximum runnable queue: ${maximum}.`, `${samples.size} scheduler sample${samples.size === 1 ? "" : "s"} recognized.`, `Maximum worker queue: ${workerMaximum}.`);
  }

  if (column("active_worker_threads") >= 0 && column("max_worker_threads") >= 0) {
    adapterId = "sql-evaluate-worker-counters";
    kind = "Scheduler";
    resultSetTypes.add("WORKER_COUNTERS");
    let activeMaximum = 0;
    let configuredMaximum = 0;
    let queueMaximum = 0;
    rows.forEach((row) => {
      const active = numeric(value(row, "active_worker_threads")) ?? 0;
      const maximum = numeric(value(row, "max_worker_threads")) ?? 0;
      const queue = numeric(value(row, "work_queue_count")) ?? 0;
      const timestamp = isoLike(value(row, "captured_at", "collection_time"));
      activeMaximum = Math.max(activeMaximum, active);
      configuredMaximum = Math.max(configuredMaximum, maximum);
      queueMaximum = Math.max(queueMaximum, queue);
      observations.push(observation(artifactId, observationIndex++, "Worker", "active_worker_threads", active, timestamp, "Direct", undefined, "workers"));
      observations.push(observation(artifactId, observationIndex++, "Worker", "max_worker_threads", maximum, timestamp, "Direct", undefined, "workers"));
      observations.push(observation(artifactId, observationIndex++, "Worker", "work_queue_count", queue, timestamp, "Direct", undefined, "tasks"));
    });
    if (rows.some((row) => (numeric(value(row, "active_worker_threads")) ?? 0) >= (numeric(value(row, "max_worker_threads")) ?? Number.POSITIVE_INFINITY) && (numeric(value(row, "work_queue_count")) ?? 0) > 0)) signals.add("worker-exhaustion-confirmed");
    else if (queueMaximum > 0) signals.add("worker-queue");
    details.push(`Maximum active workers: ${activeMaximum} of ${configuredMaximum}.`, `Maximum work queue: ${queueMaximum}.`);
  }

  if (column("sql_compilations_per_sec") >= 0 && column("batch_requests_per_sec") >= 0) {
    adapterId = "sql-evaluate-compilation-counters";
    kind = "Plan cache";
    resultSetTypes.add("COMPILATION_COUNTERS");
    let maximumRatio = 0;
    let maximumWaiting = 0;
    let firstCacheHit: number | null = null;
    let lastCacheHit: number | null = null;
    rows.forEach((row) => {
      const compilations = numeric(value(row, "sql_compilations_per_sec")) ?? 0;
      const batches = numeric(value(row, "batch_requests_per_sec")) ?? 0;
      const ratio = batches > 0 ? compilations / batches : 0;
      const waiting = numeric(value(row, "resource_semaphore_query_compile_waiting_tasks")) ?? 0;
      const cacheHit = numeric(value(row, "cache_hit_ratio_plan_cache_pct"));
      const timestamp = isoLike(value(row, "captured_at", "collection_time"));
      maximumRatio = Math.max(maximumRatio, ratio);
      maximumWaiting = Math.max(maximumWaiting, waiting);
      firstCacheHit ??= cacheHit;
      if (cacheHit !== null) lastCacheHit = cacheHit;
      observations.push(observation(artifactId, observationIndex++, "Compilation", "compilation_to_batch_ratio", ratio, timestamp, "Derived", undefined, "ratio"));
      observations.push(observation(artifactId, observationIndex++, "Compilation", "compile_waiting_tasks", waiting, timestamp, "Direct", undefined, "tasks"));
      if (cacheHit !== null) observations.push(observation(artifactId, observationIndex++, "Plan cache", "cache_hit_ratio_pct", cacheHit, timestamp, "Direct", undefined, "percent"));
    });
    if (maximumWaiting > 0 && maximumRatio >= 0.1) signals.add("compilation-pressure");
    if (maximumWaiting > 0 && firstCacheHit !== null && lastCacheHit !== null && lastCacheHit < firstCacheHit) signals.add("plan-cache-pressure-wide");
    details.push(`Maximum compilation/batch ratio: ${(maximumRatio * 100).toFixed(1)}%.`, `Maximum compile-semaphore waiting tasks: ${maximumWaiting}.`, `Plan-cache hit ratio moved from ${firstCacheHit ?? "unknown"}% to ${lastCacheHit ?? "unknown"}%.`);
  }

  if (column("request_mode") >= 0 && (column("request_session_id") >= 0 || column("session_id") >= 0)) {
    adapterId = "sql-evaluate-native";
    kind = "Locks";
    resultSetTypes.add("TRANSACTIONS_LOCKS");
    const rootGranted = new Set<string>();
    const victimWaits = new Set<string>();
    let rootRows = 0;
    let incompleteResources = 0;
    rows.forEach((row) => {
      const sessionId = numeric(value(row, "request_session_id", "session_id"));
      const status = normalizeEvidenceHeader(value(row, "request_status"));
      const type = nullableText(value(row, "resource_type"))?.toUpperCase() ?? null;
      const databaseId = nullableText(value(row, "resource_database_id"));
      const entityId = nullableText(value(row, "resource_associated_entity_id"));
      const description = nullableText(value(row, "resource_description"));
      const descriptionRequired = Boolean(type && ["KEY", "PAGE", "RID", "XACT", "APPLICATION", "METADATA"].includes(type));
      const resourceComplete = Boolean(type && databaseId && (type === "DATABASE" || entityId || description) && (!descriptionRequired || description));
      const resource = resourceComplete ? [type, databaseId, entityId ?? "", description ?? ""].join("|") : null;
      if (!resource) incompleteResources += 1;
      if (sessionId === rootSessionId && (!status || status === "grant" || status === "granted")) { rootRows += 1; if (resource) rootGranted.add(resource); }
      if (resource && sessionId !== rootSessionId && (status === "wait" || status === "waiting" || status === "convert")) victimWaits.add(resource);
      observations.push(observation(artifactId, observationIndex++, "Lock", "request_status", status || null, isoLike(value(row, "captured_at", "collection_time")), "Direct", identityFromRow(headers, row), undefined, resource ?? "Incomplete lock resource identity"));
    });
    if (rootRows) signals.add("root-locks-granted");
    if ([...victimWaits].some((resource) => rootGranted.has(resource))) signals.add("lock-resource-match");
    if (incompleteResources) warnings.push("Lock rows were present without enough resource identity to prove an exact root-to-victim resource match.");
    details.push(`${rootRows} granted root lock row${rootRows === 1 ? "" : "s"} recognized.`, `${victimWaits.size} waiting victim resource${victimWaits.size === 1 ? "" : "s"} recognized.`);
  }

  if (column("open_transaction_count", "open_tran_count") >= 0) {
    adapterId = "sql-evaluate-native";
    resultSetTypes.add("TRANSACTIONS_LOCKS");
    rows.forEach((row) => {
      const identity = identityFromRow(headers, row);
      const count = numeric(value(row, "open_transaction_count", "open_tran_count"));
      if (identity.sessionId === rootSessionId && (count ?? 0) > 0) signals.add("root-open-transaction");
      observations.push(observation(artifactId, observationIndex++, "Transaction", "open_transaction_count", count, isoLike(value(row, "captured_at", "collection_time")), "Direct", identity, "transactions"));
    });
  }

  if (column("requested_memory_kb") >= 0 || column("granted_memory_kb") >= 0) {
    adapterId = "sql-evaluate-native";
    kind = "Memory grants";
    resultSetTypes.add("MEMORY_GRANTS");
    let pending = 0;
    let waitMaximum = 0;
    rows.forEach((row) => {
      const requested = numeric(value(row, "requested_memory_kb"));
      const granted = numeric(value(row, "granted_memory_kb"));
      const used = numeric(value(row, "used_memory_kb", "max_used_memory_kb"));
      const wait = numeric(value(row, "wait_time_ms")) ?? 0;
      const grantTime = nullableText(value(row, "grant_time"));
      if (!grantTime && (requested ?? 0) > 0) pending += 1;
      waitMaximum = Math.max(waitMaximum, wait);
      const identity = identityFromRow(headers, row);
      const timestamp = isoLike(value(row, "captured_at", "collection_time", "request_time"));
      observations.push(observation(artifactId, observationIndex++, "Memory grant", "requested_memory_kb", requested, timestamp, "Direct", identity, "KB"));
      observations.push(observation(artifactId, observationIndex++, "Memory grant", "granted_memory_kb", granted, timestamp, "Direct", identity, "KB"));
      observations.push(observation(artifactId, observationIndex++, "Memory grant", "used_memory_kb", used, timestamp, "Direct", identity, "KB"));
    });
    if (pending > 0 || waitMaximum > 0) signals.add("pending-memory-grant");
    details.push(`${pending} pending grant${pending === 1 ? "" : "s"}; maximum wait ${waitMaximum} ms.`);
  }

  if (column("counter_name") >= 0 && column("cntr_value", "counter_value") >= 0) {
    adapterId = "sql-evaluate-native";
    resultSetTypes.add("COMPILATION_COUNTERS");
    const counterValues = new Map<string, Array<{ value: number; capturedAt: string | null }>>();
    rows.forEach((row) => {
      const name = String(value(row, "counter_name") ?? "").trim().toLowerCase();
      const count = numeric(value(row, "cntr_value", "counter_value"));
      const timestamp = isoLike(value(row, "captured_at", "collection_time"));
      if (name && count !== null) counterValues.set(name, [...(counterValues.get(name) ?? []), { value: count, capturedAt: timestamp }]);
    });
    const delta = (name: string) => {
      const entries = counterValues.get(name) ?? [];
      return entries.length >= 2 ? Math.max(0, entries.at(-1)!.value - entries[0].value) : null;
    };
    const compilations = delta("sql compilations/sec");
    const batches = delta("batch requests/sec");
    if (compilations !== null) observations.push(observation(artifactId, observationIndex++, "Compilation", "compilation_delta", compilations, capturedAt, "Derived", undefined, "compilations"));
    if (batches !== null) observations.push(observation(artifactId, observationIndex++, "Compilation", "batch_delta", batches, capturedAt, "Derived", undefined, "batches"));
    if (compilations !== null && batches !== null && batches > 0) {
      const ratio = compilations / batches;
      observations.push(observation(artifactId, observationIndex++, "Compilation", "compilation_to_batch_ratio", ratio, capturedAt, "Derived", undefined, "ratio"));
      if (ratio >= 0.1) signals.add("compilation-pressure");
      details.push(`Compilation/batch delta ratio: ${(ratio * 100).toFixed(1)}%.`);
    } else warnings.push("Compilation pressure requires at least two counter samples containing SQL Compilations/sec and Batch Requests/sec.");
  }

  if (recognizedBlitzCache(headers, text)) {
    adapterId = "sp-blitzcache";
    kind = "Plan cache";
    resultSetTypes.add("BLITZCACHE");
    const matched = BLITZ_SIGNAL_TERMS.filter(([term]) => text.includes(term));
    matched.forEach(([, signal]) => signals.add(signal));
    if (matched.length) signals.add("plan-cache-warning");
    const warningColumn = column("warnings", "warning", "findings", "blitzcache_info");
    rows.forEach((row) => {
      const identity = identityFromRow(headers, row);
      const warningText = warningColumn >= 0 ? nullableText(row[warningColumn]) : null;
      const rowSignals = blitzSignalsInText(row.map((item) => String(item ?? "")).join(" "));
      if (warningText || rowSignals.length) observations.push(observation(artifactId, observationIndex++, "BlitzCache", "warning", warningText ?? rowSignals.join(", "), isoLike(value(row, "captured_at", "collection_time")), "Direct", identity, undefined, undefined, rowSignals));
    });
    details.push(`Recognized BlitzCache signals: ${matched.map(([term]) => term).join(", ") || "none"}.`);
  }

  const planCountIndex = column("plan_count", "total_plan_count");
  const singleCountIndex = column("single_use_plan_count", "single_use_plans");
  let planCount: number | null = null;
  let singleUseCount: number | null = null;
  if (planCountIndex >= 0 && singleCountIndex >= 0 && rows[0]) {
    planCount = numeric(rows[0][planCountIndex]);
    singleUseCount = numeric(rows[0][singleCountIndex]);
  } else if (column("usecounts") >= 0 && (resultSetTypes.has("PLAN_CACHE_INVENTORY") || (column("cacheobjtype") >= 0 && column("objtype") >= 0))) {
    planCount = rows.length;
    singleUseCount = rows.filter((row) => (numeric(value(row, "usecounts")) ?? 0) <= 1).length;
  }
  if (planCount !== null && singleUseCount !== null && planCount > 0) {
    const percentage = singleUseCount / planCount * 100;
    observations.push(observation(artifactId, observationIndex++, "Plan cache", "total_plan_count", planCount, capturedAt, "Direct", undefined, "plans"));
    observations.push(observation(artifactId, observationIndex++, "Plan cache", "single_use_plan_count", singleUseCount, capturedAt, "Direct", undefined, "plans"));
    observations.push(observation(artifactId, observationIndex++, "Plan cache", "single_use_percentage", percentage, capturedAt, "Derived", undefined, "percent"));
    if (planCount >= 1000 && percentage >= 90) signals.add("plan-cache-instability-measured");
    details.push(`${singleUseCount.toLocaleString()} of ${planCount.toLocaleString()} plans are single-use (${percentage.toFixed(1)}%).`);
  }

  const planColumn = column("query_plan", "showplan_xml", "last_query_plan");
  if (planColumn >= 0) {
    const plans = rows.map((row) => nullableText(row[planColumn])).filter((item): item is string => Boolean(item));
    rows.forEach((row) => {
      const present = /<\s*(?:\w+:)?ShowPlanXML\b/i.test(nullableText(row[planColumn]) ?? "");
      observations.push(observation(artifactId, observationIndex++, "Plan lookup", "query_plan_available", present, isoLike(value(row, "captured_at", "collection_time")), "Direct", identityFromRow(headers, row)));
    });
    if (plans.some((plan) => /<\s*(?:\w+:)?ShowPlanXML\b/i.test(plan))) signals.add("embedded-plan-captured");
    else if ([...resultSetTypes].some((type) => ["REQUEST_PLAN", "LAST_KNOWN_ACTUAL_PLAN", "QUERY_STORE"].includes(type)) && rows.some((row) => hasIdentity(identityFromRow(headers, row)))) {
      signals.add("plan-lookup-null");
      details.push("The explicit plan lookup returned NULL for a row with stable request or query identity.");
    }
  }

  const queryStore = resultSetTypes.has("QUERY_STORE") || (column("query_id") >= 0 && column("plan_id") >= 0 && (column("avg_duration") >= 0 || column("query_sql_text") >= 0));
  if (queryStore) {
    adapterId = "query-store-export";
    resultSetTypes.add("QUERY_STORE");
    signals.add("query-store-evidence");
    details.push(`${rows.length} Query Store row${rows.length === 1 ? "" : "s"} recognized.`);
  }

  const extendedEvents = resultSetTypes.has("EXTENDED_EVENTS") || (column("event_name", "name") >= 0 && (column("showplan_xml", "query_plan") >= 0 || text.includes("query_post_execution_showplan")));
  if (extendedEvents) {
    adapterId = "extended-events-export";
    resultSetTypes.add("EXTENDED_EVENTS");
    signals.add("extended-events-evidence");
  }

  if (text.includes("resource_semaphore")) signals.add("pending-memory-grant");
  if (text.includes("threadpool")) signals.add("worker-queue");
  const firstIdentity = rows.map((row) => identityFromRow(headers, row)).find(hasIdentity);
  return { adapterId, adapterVersion: "1.0", kind, signals, details, warnings, capturedAt, resultSetTypes: [...resultSetTypes].sort(), identity: firstIdentity, observations };
}
