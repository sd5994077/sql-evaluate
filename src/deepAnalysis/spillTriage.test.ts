import { describe, expect, it } from "vitest";
import { earliestFeedingEstimateError, highestPerExecution, inspectSpillTriageMatrix, resolveCandidatePlan, topNDisclosure } from "./spillTriage";
import type { SpillPlanEvidence } from "./types";

const matrix = [
  ["Total Spills", "Avg Spills", "# Executions", "Last Execution", "Database", "Plan Handle", "Query Hash", "Query Plan Hash", "Total CPU", "Remove Plan Handle From Cache", "Future Column"],
  [158870, 15887, 10, "2026-09-02 09:00:00", "Training", "0xAAA", "0x111", "0xA1", "00:01:00", "DBCC FREEPROCCACHE (0xAAA);", "kept"],
  [100000, 50000, 2, "2026-09-02 09:10:00", "Training", "0xBBB", "0x111", "0xB1", "00:02:00", "DBCC FREEPROCCACHE (0xBBB);", null],
  ["bad", null, 1, null, "Training", "0xCCC", "0x333", "0xC1", null, null, null],
];

describe("Spill Triage", () => {
  it("normalizes, ranks cumulative impact, and preserves provenance", () => {
    const result = inspectSpillTriageMatrix(matrix, { artifactId: "a", fileName: "blitz.csv" });
    expect(result.summary?.rankableRows).toBe(2);
    expect(result.candidates[0].identity.planHandle).toBe("0xAAA");
    expect(result.candidates[0].rank).toBe(1);
    expect(result.candidates[0].rankReason).toContain("158,870 pages total");
    expect(result.candidates[0].administrativeText[0].value).toContain("FREEPROCCACHE");
    expect(result.candidates[0].unknownColumns).toEqual([{ header: "Future Column", value: "kept" }]);
    expect(result.candidates[2].rank).toBeNull();
  });

  it("keeps the catastrophic average candidate visible separately", () => {
    const result = inspectSpillTriageMatrix(matrix, { artifactId: "a", fileName: "blitz.csv" });
    expect(highestPerExecution(result.candidates)?.identity.planHandle).toBe("0xBBB");
  });

  it("keeps average-only evidence behind every total-backed candidate", () => {
    const result = inspectSpillTriageMatrix([
      ["Total Spills", "Avg Spills", "Plan Handle"],
      [10, 1, "0xTOTAL"],
      [null, 1000000, "0xAVERAGE"],
    ], { artifactId: "a", fileName: "partial.csv" });
    expect(result.candidates.map((candidate) => [candidate.identity.planHandle, candidate.rankGroup])).toEqual([["0xTOTAL", "total"], ["0xAVERAGE", "average-only"]]);
  });

  it("uses source order as the final deterministic tie breaker", () => {
    const result = inspectSpillTriageMatrix([
      ["Total Spills", "Avg Spills", "Plan Handle"],
      [100, 10, "0xFIRST"],
      [100, 10, "0xSECOND"],
    ], { artifactId: "a", fileName: "ties.csv" });
    expect(result.candidates.map((candidate) => candidate.identity.planHandle)).toEqual(["0xFIRST", "0xSECOND"]);
  });

  it("derives an average only from valid total and execution values", () => {
    const result = inspectSpillTriageMatrix([
      ["TotalSpills", "Executions", "Plan Handle"],
      [100, 4, "0x1"],
    ], { artifactId: "a", fileName: "legacy.csv" });
    expect(result.candidates[0].averageSpillPages.value).toBe(25);
    expect(result.candidates[0].averageSpillPages.state).toBe("derived");
  });

  it("converts explicitly labeled MiB spill values to 8 KB pages", () => {
    const result = inspectSpillTriageMatrix([
      ["TotalSpills", "Total Spill MiB", "Executions", "Query Hash", "Query Plan Hash"],
      [null, "800 MiB", 2, "0xUNIT", "0xUNITPLAN"],
    ], { artifactId: "units", fileName: "units.xlsx" });
    expect(result.candidates[0].totalSpillPages).toMatchObject({ value: 102400, unit: "pages", state: "imported" });
    expect(result.candidates[0].totalSpillPages.explanation).toMatch(/converted from 800 MiB/i);
    expect(result.candidates[0].unknownColumns).toEqual([]);
    expect(result.candidates[0].rank).toBe(1);
  });

  it("rejects cell units that contradict the spill column instead of guessing", () => {
    const result = inspectSpillTriageMatrix([
      ["Total Spill MiB", "Avg Spills", "Plan Handle"],
      ["800 KB", 10, "0xCONFLICT1"],
      ["800 MiB", 10, "0xMATCH"],
    ], { artifactId: "units", fileName: "units.xlsx" });
    expect(result.candidates.find((candidate) => candidate.identity.planHandle === "0xCONFLICT1")?.totalSpillPages).toMatchObject({ value: null, state: "invalid" });
    expect(result.candidates.find((candidate) => candidate.identity.planHandle === "0xMATCH")?.totalSpillPages).toMatchObject({ value: 102400, state: "imported" });

    const canonical = inspectSpillTriageMatrix([
      ["Total Spills", "Plan Handle"],
      ["800 MiB", "0xCONFLICT2"],
    ], { artifactId: "canonical", fileName: "canonical.csv" });
    expect(canonical.candidates[0].totalSpillPages).toMatchObject({ value: null, state: "invalid" });
    expect(canonical.summary?.warnings.join(" ")).toMatch(/malformed spill values/i);
  });

  it("distinguishes reported zero from a missing total in average-backed ranking copy", () => {
    const result = inspectSpillTriageMatrix([
      ["Total Spills", "Avg Spills", "Plan Handle"],
      [0, 60_000, "0xZERO"],
    ], { artifactId: "zero", fileName: "zero.csv" });
    expect(result.candidates[0].rankReason).toMatch(/reported as zero/i);
    expect(result.candidates[0].rankReason).not.toMatch(/not supplied/i);
  });

  it("discloses top ten without claiming a complete population", () => {
    expect(topNDisclosure(10)).toContain("does not prove");
    expect(topNDisclosure(12)).toContain("bounded top-N");
  });

  it("does not connect query-hash-only or conflicting plan variants", () => {
    const candidate = inspectSpillTriageMatrix(matrix, { artifactId: "a", fileName: "blitz.csv" }).candidates[0];
    const plan = { id: "p", sourceId: "p", fileName: "p.sqlplan", version: null, isActual: false, warnings: [], statements: [{ id: "s", statementText: "", statementType: "SELECT", estimatedCost: 1, isActual: false, missingIndexImpact: null, operators: [], warnings: [], queryIdentity: { queryHash: "0x111", planHandle: "0xBBB" } }] };
    expect(resolveCandidatePlan(candidate, [{ artifactId: "p", fileName: "p.sqlplan", plan }] as SpillPlanEvidence[]).connected).toBe(false);
  });

  it("explains when an otherwise exact identity is blocked by a conflicting plan handle", () => {
    const candidate = inspectSpillTriageMatrix([
      ["Total Spills", "Plan Handle", "Query Store Query Id", "Query Store Plan Id"],
      [100, "0xAAA", 7002, 7102],
    ], { artifactId: "conflict", fileName: "conflict.csv" }).candidates[0];
    const plan = { id: "p", sourceId: "p", fileName: "p.sqlplan", version: null, isActual: false, warnings: [], statements: [{ id: "s", statementText: "", statementType: "SELECT", estimatedCost: 1, isActual: false, missingIndexImpact: null, operators: [], warnings: [], queryIdentity: { planHandle: "0xBBB", queryStoreQueryId: 7002, queryStorePlanId: 7102 } }] };
    const resolution = resolveCandidatePlan(candidate, [{ artifactId: "p", fileName: "p.sqlplan", plan }] as SpillPlanEvidence[]);
    expect(resolution).toMatchObject({ connected: false, ambiguous: false, quality: "Candidate", blockedByConflict: true });
    expect(resolution.reason).toMatch(/plan_handle conflicts/i);
  });

  it("finds the earliest major estimate error feeding a spill", () => {
    const leaf = { id: "leaf", nodeId: 3, physicalOp: "Scan", logicalOp: "Scan", estimatedRows: 1, actualRows: 100000, estimatedCost: 1, warnings: [], childNodeIds: [] };
    const middle = { ...leaf, id: "middle", nodeId: 2, physicalOp: "Join", childNodeIds: [3], actualRows: 50000 };
    const spill = { ...leaf, id: "spill", nodeId: 1, physicalOp: "Sort", childNodeIds: [2], spillDetails: [{ kind: "Sort" as const, spillLevel: 1, spilledThreadCount: 1, pagesWritten: 10, pagesRead: 10, grantedMemoryKb: 100, usedMemoryKb: 100, requestedMemoryKb: null, rawAttributes: {} }] };
    const statement = { id: "s", statementText: "", statementType: "SELECT", estimatedCost: 1, isActual: true, missingIndexImpact: null, warnings: [], operators: [spill, middle, leaf] };
    expect(earliestFeedingEstimateError(statement, spill)?.operator.nodeId).toBe(3);
  });

  it("normalizes and ranks a large result set without dropping rows", () => {
    const rows: unknown[][] = [["Total Spills", "Avg Spills", "# Executions", "Plan Handle", "Query Hash", "Query Plan Hash"]];
    for (let index = 0; index < 50_000; index += 1) rows.push([index + 1, (index + 1) / 10, 10, `0x${index}`, "0xQUERY", `0xPLAN${index}`]);
    const result = inspectSpillTriageMatrix(rows, { artifactId: "large", fileName: "large.csv" });
    expect(result.candidates).toHaveLength(50_000);
    expect(result.candidates[0]).toMatchObject({ rank: 1, totalSpillPages: { value: 50_000 } });
  }, 10_000);
});
