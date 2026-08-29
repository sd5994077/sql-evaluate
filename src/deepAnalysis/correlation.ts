import type { DeepIncidentWindow, DeepOverlapQuality, DeepQueryIdentity } from "./types";

export interface IdentityMatch {
  matched: boolean;
  quality: "Exact" | "Strong" | "Candidate" | "None";
  reason: string;
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

export function matchQueryIdentity(left: DeepQueryIdentity | undefined, right: DeepQueryIdentity | undefined): IdentityMatch {
  if (!left || !right) return { matched: false, quality: "None", reason: "One source has no stable query identity." };
  if (sameNumber(left.queryStoreQueryId, right.queryStoreQueryId) && sameNumber(left.queryStorePlanId, right.queryStorePlanId)) {
    return { matched: true, quality: "Exact", reason: `Query Store query ${left.queryStoreQueryId} and plan ${left.queryStorePlanId} match.` };
  }
  if (sameHandle(left.planHandle, right.planHandle)) return { matched: true, quality: "Exact", reason: "The plan_handle values match." };
  if (sameHandle(left.sqlHandle, right.sqlHandle)) {
    const leftComplete = left.statementStartOffset != null && left.statementEndOffset != null;
    const rightComplete = right.statementStartOffset != null && right.statementEndOffset != null;
    if (leftComplete && rightComplete) {
      if (sameNumber(left.statementStartOffset, right.statementStartOffset) && sameNumber(left.statementEndOffset, right.statementEndOffset)) {
        return { matched: true, quality: "Exact", reason: "The sql_handle and statement offsets match." };
      }
    } else {
      return { matched: true, quality: "Strong", reason: "The batch sql_handle matches, but one or both sources lack complete statement offsets." };
    }
  }
  if (sameHandle(left.queryHash, right.queryHash)
    && (!left.databaseId || !right.databaseId || sameNumber(left.databaseId, right.databaseId))) {
    if (sameHandle(left.queryPlanHash, right.queryPlanHash)) return { matched: true, quality: "Strong", reason: "The query_hash and query_plan_hash match in compatible database context." };
    return { matched: true, quality: "Candidate", reason: "The query_hash matches, but the plan identity is absent or different." };
  }
  if (sameNumber(left.sessionId, right.sessionId) && sameNumber(left.requestId, right.requestId)) {
    if (sameNumber(left.transactionId, right.transactionId)) return { matched: true, quality: "Exact", reason: "Session, request, and transaction IDs match." };
    return { matched: true, quality: "Strong", reason: "Session and request IDs match; transaction identity is unavailable or different." };
  }
  return { matched: false, quality: "None", reason: "No supported stable identifier matches." };
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
