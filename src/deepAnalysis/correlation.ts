import type { DeepIncidentWindow, DeepOverlapQuality, DeepQueryIdentity } from "./types";

export interface IdentityMatch {
  matched: boolean;
  quality: "Exact" | "Strong" | "Candidate" | "None";
  reason: string;
  conflicts: string[];
}

function handle(value: string | null | undefined): string | null {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/^0x/, "");
  return normalized || null;
}

function sameNumber(left: number | null | undefined, right: number | null | undefined): boolean {
  return left !== null && left !== undefined && right !== null && right !== undefined && left === right;
}

function sameHandle(left: string | null | undefined, right: string | null | undefined): boolean {
  const a = handle(left);
  const b = handle(right);
  return Boolean(a && b && a === b);
}

export function hasCorrelationReadyIdentity(identity: DeepQueryIdentity | undefined): boolean {
  if (!identity) return false;
  return Boolean(
    identity.planHandle
    || identity.sqlHandle
    || (identity.queryHash && identity.queryPlanHash)
    || (identity.queryStoreQueryId != null && identity.queryStorePlanId != null && identity.databaseId != null),
  );
}

export function matchQueryIdentity(left: DeepQueryIdentity | undefined, right: DeepQueryIdentity | undefined): IdentityMatch {
  if (!left || !right) return { matched: false, quality: "None", reason: "One source has no stable query identity.", conflicts: [] };
  const conflicts: string[] = [];
  const conflictHandle = (key: "planHandle" | "sqlHandle" | "queryHash" | "queryPlanHash", label: string) => {
    const a = handle(left[key]);
    const b = handle(right[key]);
    if (a && b && a !== b) conflicts.push(`${label} conflicts`);
  };
  const conflictNumber = (key: "queryStoreQueryId" | "queryStorePlanId" | "databaseId", label: string) => {
    const a = left[key];
    const b = right[key];
    if (a != null && b != null && a !== b) conflicts.push(`${label} conflicts`);
  };
  conflictHandle("planHandle", "plan_handle");
  conflictHandle("sqlHandle", "sql_handle");
  conflictHandle("queryPlanHash", "query_plan_hash");
  conflictNumber("queryStoreQueryId", "Query Store query ID");
  conflictNumber("queryStorePlanId", "Query Store plan ID");
  conflictNumber("databaseId", "database ID");
  if (sameHandle(left.sqlHandle, right.sqlHandle)) {
    if (left.statementStartOffset != null && right.statementStartOffset != null && left.statementStartOffset !== right.statementStartOffset) conflicts.push("statement_start_offset conflicts");
    if (left.statementEndOffset != null && right.statementEndOffset != null && left.statementEndOffset !== right.statementEndOffset) conflicts.push("statement_end_offset conflicts");
  }

  let base: IdentityMatch;
  if (sameNumber(left.queryStoreQueryId, right.queryStoreQueryId) && sameNumber(left.queryStorePlanId, right.queryStorePlanId)) {
    if (left.databaseId != null && right.databaseId != null) {
      base = sameNumber(left.databaseId, right.databaseId)
        ? { matched: true, quality: "Exact", reason: `Query Store query ${left.queryStoreQueryId} and plan ${left.queryStorePlanId} match in database ${left.databaseId}.`, conflicts: [] }
        : { matched: false, quality: "None", reason: "The Query Store IDs occur in different databases.", conflicts: [] };
    } else {
      base = { matched: true, quality: "Candidate", reason: "The Query Store query and plan IDs match, but exact correlation requires database context from both sources.", conflicts: [] };
    }
  } else if (sameHandle(left.planHandle, right.planHandle)) base = { matched: true, quality: "Exact", reason: "The plan_handle values match.", conflicts: [] };
  else if (sameHandle(left.sqlHandle, right.sqlHandle)) {
    const leftComplete = left.statementStartOffset != null && left.statementEndOffset != null;
    const rightComplete = right.statementStartOffset != null && right.statementEndOffset != null;
    if (leftComplete && rightComplete && sameNumber(left.statementStartOffset, right.statementStartOffset) && sameNumber(left.statementEndOffset, right.statementEndOffset)) {
      base = { matched: true, quality: "Exact", reason: "The sql_handle and statement offsets match.", conflicts: [] };
    } else if (!leftComplete || !rightComplete) {
      base = { matched: true, quality: "Strong", reason: "The batch sql_handle matches, but one or both sources lack complete statement offsets.", conflicts: [] };
    } else base = { matched: false, quality: "None", reason: "The batch sql_handle matches, but the statement offsets do not.", conflicts: [] };
  } else if (sameHandle(left.queryHash, right.queryHash)) {
    if (sameHandle(left.queryPlanHash, right.queryPlanHash)) base = { matched: true, quality: "Strong", reason: "The query_hash and query_plan_hash match in compatible database context.", conflicts: [] };
    else base = { matched: true, quality: "Candidate", reason: "The query_hash matches, but the plan identity is absent or different.", conflicts: [] };
  } else if (sameNumber(left.sessionId, right.sessionId) && sameNumber(left.requestId, right.requestId)) {
    if (sameNumber(left.transactionId, right.transactionId)) base = { matched: true, quality: "Exact", reason: "Session, request, and transaction IDs match.", conflicts: [] };
    else base = { matched: true, quality: "Strong", reason: "Session and request IDs match; transaction identity is unavailable or different.", conflicts: [] };
  } else base = { matched: false, quality: "None", reason: "No supported stable identifier matches.", conflicts: [] };

  const queryStorePairMatches = sameNumber(left.queryStoreQueryId, right.queryStoreQueryId)
    && sameNumber(left.queryStorePlanId, right.queryStorePlanId);
  const conflictIsRelevant = base.matched
    || queryStorePairMatches
    || sameHandle(left.planHandle, right.planHandle)
    || sameHandle(left.sqlHandle, right.sqlHandle)
    || sameHandle(left.queryPlanHash, right.queryPlanHash)
    || sameHandle(left.queryHash, right.queryHash)
    || (sameNumber(left.sessionId, right.sessionId) && sameNumber(left.requestId, right.requestId));
  if (conflicts.length && conflictIsRelevant) {
    return { matched: false, quality: base.quality, reason: `Automatic correlation was blocked because ${conflicts.join("; ")}.`, conflicts };
  }
  return base;
}

export function incidentOverlap(capturedAt: string | null | undefined, window: DeepIncidentWindow | undefined, toleranceSeconds = 30): { quality: DeepOverlapQuality; reason: string } {
  if (!capturedAt || !window?.firstObservedAt || !window.lastObservedAt) return { quality: "Unknown", reason: "A capture timestamp or incident boundary is missing." };
  const captured = new Date(capturedAt).getTime();
  const first = new Date(window.firstObservedAt).getTime();
  const last = new Date(window.lastObservedAt).getTime();
  if (![captured, first, last].every(Number.isFinite)) return { quality: "Unknown", reason: "One or more timestamps could not be interpreted." };
  const tolerance = toleranceSeconds * 1000;
  if (captured >= first && captured <= last) return { quality: "Exact", reason: "The evidence timestamp falls inside the incident window." };
  if (captured >= first - tolerance && captured <= last + tolerance) return { quality: "Overlapping", reason: `The evidence is within ${toleranceSeconds} seconds of the incident window.` };
  return { quality: "Context only", reason: "The evidence timestamp falls outside the incident window." };
}
