import { describe, expect, it } from "vitest";
import { incidentOverlap, matchQueryIdentity } from "./correlation";

describe("Deep Analysis correlation", () => {
  it("prefers exact handles and never treats query hash alone as an exact plan match", () => {
    expect(matchQueryIdentity({ planHandle: "0xABCD" }, { planHandle: "abcd" })).toMatchObject({ matched: true, quality: "Exact" });
    expect(matchQueryIdentity({ queryHash: "0x1111", databaseId: 5 }, { queryHash: "1111", databaseId: 5 })).toMatchObject({ matched: true, quality: "Candidate" });
    expect(matchQueryIdentity({ sessionId: 104, requestId: 0, transactionId: 91 }, { sessionId: 104, requestId: 0, transactionId: 91 })).toMatchObject({ matched: true, quality: "Exact" });
  });

  it("does not treat a batch sql_handle without statement offsets as an exact statement match", () => {
    expect(matchQueryIdentity(
      { sqlHandle: "0xBATCH", statementStartOffset: 10, statementEndOffset: 40 },
      { sqlHandle: "0xBATCH" },
    )).toMatchObject({ matched: true, quality: "Strong" });
    expect(matchQueryIdentity(
      { sqlHandle: "0xBATCH", statementStartOffset: 10, statementEndOffset: 40 },
      { sqlHandle: "0xBATCH", statementStartOffset: 10, statementEndOffset: 40 },
    )).toMatchObject({ matched: true, quality: "Exact" });
  });

  it("requires database context for an exact Query Store match", () => {
    expect(matchQueryIdentity(
      { queryStoreQueryId: 7, queryStorePlanId: 9, databaseId: 5 },
      { queryStoreQueryId: 7, queryStorePlanId: 9, databaseId: 5 },
    )).toMatchObject({ matched: true, quality: "Exact", conflicts: [] });
    expect(matchQueryIdentity(
      { queryStoreQueryId: 7, queryStorePlanId: 9 },
      { queryStoreQueryId: 7, queryStorePlanId: 9 },
    )).toMatchObject({ matched: true, quality: "Candidate", conflicts: [] });
    expect(matchQueryIdentity(
      { queryStoreQueryId: 7, queryStorePlanId: 9, databaseId: 5 },
      { queryStoreQueryId: 7, queryStorePlanId: 9, databaseId: 6 },
    )).toMatchObject({ matched: false, quality: "None", conflicts: ["database ID conflicts"] });
  });

  it("blocks weaker fallbacks when stronger supplied identity fields conflict", () => {
    expect(matchQueryIdentity(
      { planHandle: "0xA", queryHash: "0xQ", queryPlanHash: "0xP1" },
      { planHandle: "0xB", queryHash: "0xQ", queryPlanHash: "0xP1" },
    )).toMatchObject({ matched: false, quality: "Strong", conflicts: ["plan_handle conflicts"] });
    expect(matchQueryIdentity(
      { sqlHandle: "0xS", statementStartOffset: 0, statementEndOffset: 20, queryHash: "0xQ", queryPlanHash: "0xP" },
      { sqlHandle: "0xS", statementStartOffset: 22, statementEndOffset: 40, queryHash: "0xQ", queryPlanHash: "0xP" },
    )).toMatchObject({ matched: false, quality: "None", conflicts: ["statement_start_offset conflicts", "statement_end_offset conflicts"] });
  });

  it("does not report mismatched fields as a conflict when the sources share no stable identity", () => {
    expect(matchQueryIdentity(
      { queryStoreQueryId: 7, queryStorePlanId: 9, databaseId: 5 },
      { queryStoreQueryId: 8, queryStorePlanId: 10, databaseId: 6 },
    )).toMatchObject({ matched: false, quality: "None", conflicts: [], reason: "No supported stable identifier matches." });
  });

  it("keeps evidence outside the incident window contextual", () => {
    const window = { firstObservedAt: "2026-08-28T12:00:00Z", lastObservedAt: "2026-08-28T12:00:10Z", overlapQuality: "Exact" as const, explanation: "test" };
    expect(incidentOverlap("2026-08-28T12:00:05Z", window).quality).toBe("Exact");
    expect(incidentOverlap("2026-08-28T12:00:25Z", window).quality).toBe("Overlapping");
    expect(incidentOverlap("2026-08-28T12:02:00Z", window).quality).toBe("Context only");
  });
});
