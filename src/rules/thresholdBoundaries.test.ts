import { describe, expect, it } from "vitest";
import type { AnalysisInput, AnalysisReport, PlanDocument, ThresholdProfileSnapshot, ThresholdProfileThresholds } from "../types";
import { normalizeRows } from "../lib/normalize";
import { analyze } from "./engine";
import { createThresholdProfileSnapshot, DEFAULT_THRESHOLD_PROFILE } from "./thresholdProfiles";

const BASE_TIME = Date.parse("2026-08-29T12:00:00Z");

function iso(offsetMs: number): string {
  return new Date(BASE_TIME + offsetMs).toISOString();
}

async function customProfile(change: (thresholds: ThresholdProfileThresholds) => void): Promise<ThresholdProfileSnapshot> {
  const profile = structuredClone(DEFAULT_THRESHOLD_PROFILE);
  profile.id = "test.threshold-boundaries";
  profile.name = "Threshold boundary test";
  change(profile.thresholds);
  return createThresholdProfileSnapshot(profile);
}

function activityReport(headers: string[], rows: unknown[][], profile: ThresholdProfileSnapshot): AnalysisReport {
  const input: AnalysisInput = {
    id: "activity",
    fileName: "activity.csv",
    size: 1,
    format: "csv",
    rowCount: rows.length,
    recognizedColumns: headers,
    unknownColumns: [],
    warnings: [],
  };
  return analyze([input], normalizeRows(input.id, [headers, ...rows], 0), [], profile);
}

function planReport(plan: PlanDocument, profile: ThresholdProfileSnapshot): AnalysisReport {
  const input: AnalysisInput = { id: plan.sourceId, fileName: plan.fileName, size: 1, format: "sqlplan", rowCount: 0, recognizedColumns: [], unknownColumns: [], warnings: [] };
  return analyze([input], [], [plan], profile);
}

function planWith(options: {
  actualRows?: number;
  estimatedRows?: number;
  missingIndexImpact?: number;
  grant?: { grantedKb: number; usedKb: number };
  spill?: boolean;
}): PlanDocument {
  return {
    id: "plan-boundary",
    sourceId: "plan-source",
    fileName: "boundary.sqlplan",
    version: "1.6",
    isActual: true,
    warnings: [],
    statements: [{
      id: "statement-boundary",
      statementText: "SELECT 1",
      statementType: "SELECT",
      estimatedCost: 1,
      isActual: true,
      missingIndexImpact: options.missingIndexImpact ?? null,
      memoryGrant: options.grant ? { requestedKb: options.grant.grantedKb, grantedKb: options.grant.grantedKb, usedKb: options.grant.usedKb } : undefined,
      warnings: [],
      operators: [{
        id: "operator-boundary",
        nodeId: 0,
        physicalOp: "Clustered Index Scan",
        logicalOp: "Clustered Index Scan",
        estimatedRows: options.estimatedRows ?? null,
        actualRows: options.actualRows ?? null,
        estimatedCost: 1,
        warnings: options.spill ? ["SpillToTempDb"] : [],
      }],
    }],
  };
}

function rule(report: AnalysisReport, ruleId: string, titleFragment?: string) {
  return report.findings.find((finding) => finding.ruleId === ruleId && (!titleFragment || finding.title.includes(titleFragment)));
}

function blockingRows(victims: number, persistenceSeconds: number, victimWaitMs: number): unknown[][] {
  const captures = persistenceSeconds > 0 ? [0, persistenceSeconds * 1000] : [0];
  return captures.flatMap((offset) => [
    [51, null, victims, iso(offset), iso(-60_000), "running", 0, ""],
    [52, 51, 0, iso(offset), iso(-30_000), "suspended", 0, `(${victimWaitMs}ms)LCK_M_X`],
  ]);
}

function resourceRows(durationSeconds: number, captures: number, rank: number, total = 20): unknown[][] {
  const peerValues = Array.from({ length: total }, (_, index) => index + 1).filter((value) => value !== rank);
  const start = iso(-durationSeconds * 1000);
  return Array.from({ length: captures }, (_, capture) => {
    const capturedAt = iso(capture);
    return [
      [1, capturedAt, start, rank],
      ...peerValues.map((value, index) => [index + 2, capturedAt, start, value]),
    ];
  }).flat();
}

function genericWaitRows(waitMs: number, observations: number, persistenceSeconds: number, directlyBlocked = false): unknown[][] {
  return Array.from({ length: observations }, (_, index) => [
    60,
    iso(observations === 1 ? 0 : index * persistenceSeconds * 1000 / (observations - 1)),
    iso(-60_000),
    directlyBlocked ? 51 : null,
    `(${waitMs}ms)PAGEIOLATCH_SH`,
  ]);
}

function specialWaitRows(type: "THREADPOOL" | "RESOURCE_SEMAPHORE_QUERY_COMPILE", captures: number, concurrency: number, variants = 1): unknown[][] {
  let row = 0;
  return Array.from({ length: captures }, (_, capture) => Array.from({ length: concurrency }, (_, session) => {
    const variant = row++ % variants;
    return [session + 1, iso(capture * 1000), iso(-60_000), `(1000ms)${type}`, `SELECT * FROM dbo.T WHERE id = ${variant}`];
  })).flat();
}

describe("threshold profile behavioral boundaries", () => {
  it("applies every blocking cutoff below, at, and above its boundary", async () => {
    const headers = ["session_id", "blocking_session_id", "blocked_session_count", "collection_time", "start_time", "status", "open_tran_count", "wait_info"];
    const victimProfile = await customProfile((thresholds) => { thresholds.blocking.highVictims = 99; thresholds.blocking.mediumPersistenceSeconds = 100; thresholds.blocking.highPersistenceSeconds = 200; });
    expect([1, 2, 3].map((victims) => rule(activityReport(headers, blockingRows(victims, 0, 1000), victimProfile), "WIA-BLOCKING")?.severity)).toEqual(["Low", "Medium", "Medium"]);

    const highVictimProfile = await customProfile((thresholds) => { thresholds.blocking.mediumPersistenceSeconds = 100; thresholds.blocking.highPersistenceSeconds = 200; });
    expect([4, 5, 6].map((victims) => rule(activityReport(headers, blockingRows(victims, 0, 1000), highVictimProfile), "WIA-BLOCKING")?.severity)).toEqual(["Medium", "High", "High"]);

    const persistenceProfile = await customProfile((thresholds) => { thresholds.blocking.mediumVictims = 50; thresholds.blocking.highVictims = 99; });
    expect([14, 15, 16].map((seconds) => rule(activityReport(headers, blockingRows(1, seconds, 1000), persistenceProfile), "WIA-BLOCKING")?.severity)).toEqual(["Low", "Medium", "Medium"]);
    expect([59, 60, 61].map((seconds) => rule(activityReport(headers, blockingRows(1, seconds, 1000), persistenceProfile), "WIA-BLOCKING")?.severity)).toEqual(["Medium", "High", "High"]);

    const transientProfile = await customProfile((thresholds) => { thresholds.blocking.mediumVictims = 50; thresholds.blocking.highVictims = 99; thresholds.blocking.mediumPersistenceSeconds = 100; thresholds.blocking.highPersistenceSeconds = 200; });
    expect([999, 1000, 1001].map((waitMs) => rule(activityReport(headers, blockingRows(1, 0, waitMs), transientProfile), "WIA-BLOCKING")?.severity)).toEqual(["Informational", "Low", "Low"]);
  });

  it("applies every resource cutoff below, at, and above its boundary", async () => {
    const headers = ["session_id", "collection_time", "start_time", "CPU"];
    const severity = (profile: ThresholdProfileSnapshot, duration: number, captures = 1, rank = 20) => rule(activityReport(headers, resourceRows(duration, captures, rank), profile), "WIA-RESOURCE", "Session 1 is")?.severity;
    const confidence = (profile: ThresholdProfileSnapshot, captures: number) => rule(activityReport(headers, resourceRows(300, captures, 20), profile), "WIA-RESOURCE", "Session 1 is")?.confidence;

    const minimum = await customProfile((thresholds) => { Object.assign(thresholds.resources, { minimumDurationSeconds: 30, lowDurationSeconds: 30, mediumDurationSeconds: 30, highDurationSeconds: 100, mediumPercentile: 0.9, highPercentile: 1 }); });
    expect([29, 30, 31].map((value) => severity(minimum, value))).toEqual([undefined, "Medium", "Medium"]);

    const low = await customProfile((thresholds) => { Object.assign(thresholds.resources, { minimumDurationSeconds: 0, lowDurationSeconds: 60, mediumDurationSeconds: 600, highDurationSeconds: 900, highPercentile: 1, lowRepeatedCaptures: 3 }); });
    expect([59, 60, 61].map((value) => severity(low, value, 3))).toEqual([undefined, "Low", "Low"]);

    const medium = await customProfile((thresholds) => { thresholds.resources.highDurationSeconds = 900; });
    expect([299, 300, 301].map((value) => severity(medium, value, 1, 18))).toEqual([undefined, "Medium", "Medium"]);
    expect([899, 900, 901].map((value) => severity(medium, value))).toEqual(["Medium", "High", "High"]);

    const mediumPercentile = await customProfile((thresholds) => { thresholds.resources.highDurationSeconds = 900; });
    expect([17, 18, 19].map((rank) => severity(mediumPercentile, 300, 1, rank))).toEqual([undefined, "Medium", "Medium"]);

    const highPercentile = await customProfile((thresholds) => { thresholds.resources.mediumPercentile = 0.8; thresholds.resources.highPercentile = 0.9; });
    expect([17, 18, 19].map((rank) => severity(highPercentile, 900, 1, rank))).toEqual(["Medium", "High", "High"]);

    const repeated = await customProfile((thresholds) => { Object.assign(thresholds.resources, { lowDurationSeconds: 60, mediumDurationSeconds: 600, highDurationSeconds: 900, highPercentile: 1, lowRepeatedCaptures: 3 }); });
    expect([2, 3, 4].map((captures) => severity(repeated, 60, captures))).toEqual([undefined, "Low", "Low"]);

    const confidenceProfile = await customProfile((thresholds) => { thresholds.resources.mediumConfidenceCaptures = 2; });
    expect([1, 2, 3].map((captures) => confidence(confidenceProfile, captures))).toEqual(["Low", "Medium", "Medium"]);
  });

  it("applies every generic-wait cutoff below, at, and above its boundary", async () => {
    const headers = ["session_id", "collection_time", "start_time", "blocking_session_id", "wait_info"];
    const waitFinding = (profile: ThresholdProfileSnapshot, waitMs: number, observations = 1, persistence = 0, blocked = false) => rule(activityReport(headers, genericWaitRows(waitMs, observations, persistence, blocked), profile), "WIA-WAIT")!;
    const profile = await customProfile(() => undefined);
    expect([999, 1000, 1001].map((value) => waitFinding(profile, value).severity)).toEqual(["Informational", "Medium", "Medium"]);
    expect([59, 60, 61].map((value) => waitFinding(profile, 1000, 2, value).severity)).toEqual(["Medium", "High", "High"]);
    const corroborationProfile = await customProfile((thresholds) => { thresholds.waits.highPersistenceSeconds = 100; });
    expect([1, 2, 3].map((value) => waitFinding(corroborationProfile, 1000, value, 1, true).severity)).toEqual(["Medium", "High", "High"]);
    expect([1, 2, 3].map((value) => waitFinding(profile, 1000, value, 0).confidence)).toEqual(["Low", "Medium", "Medium"]);
  });

  it("applies every worker-exhaustion cutoff below, at, and above its boundary", async () => {
    const headers = ["session_id", "collection_time", "start_time", "wait_info", "sql_text"];
    const worker = (profile: ThresholdProfileSnapshot, captures: number, concurrency: number) => rule(activityReport(headers, specialWaitRows("THREADPOOL", captures, concurrency), profile), "WIA-WORKER-EXHAUSTION")!;
    const profile = await customProfile(() => undefined);
    expect([1, 2, 3].map((value) => worker(profile, value, 2).severity)).toEqual(["Medium", "High", "High"]);
    expect([1, 2, 3].map((value) => worker(profile, 2, value).severity)).toEqual(["Medium", "High", "High"]);
    expect([1, 2, 3].map((value) => worker(profile, value, 2).confidence)).toEqual(["Medium", "High", "High"]);
  });

  it("applies every compile-pressure cutoff below, at, and above its boundary", async () => {
    const headers = ["session_id", "collection_time", "start_time", "wait_info", "sql_text"];
    const compile = (profile: ThresholdProfileSnapshot, captures: number, concurrency: number, variants: number) => rule(activityReport(headers, specialWaitRows("RESOURCE_SEMAPHORE_QUERY_COMPILE", captures, concurrency, variants), profile), "WIA-COMPILE-PRESSURE")!;
    const profile = await customProfile(() => undefined);
    expect([2, 3, 4].map((value) => compile(profile, value, 4, 2).severity)).toEqual(["Medium", "High", "High"]);
    expect([3, 4, 5].map((value) => compile(profile, 3, value, 2).severity)).toEqual(["Medium", "High", "High"]);
    expect([1, 2, 3].map((value) => compile(profile, value, 4, 2).confidence)).toEqual(["Medium", "High", "High"]);
    expect([1, 2, 3].map((value) => compile(profile, 2, 4, value).confidence)).toEqual(["Medium", "High", "High"]);
  });

  it("applies both transaction-age cutoffs below, at, and above their boundaries", async () => {
    const headers = ["session_id", "collection_time", "start_time", "open_tran_count", "status", "blocking_session_id"];
    const profile = await customProfile(() => undefined);
    const transaction = (age: number) => rule(activityReport(headers, [[70, iso(0), iso(-age * 1000), 1, "running", null]], profile), "WIA-TRANSACTION")?.severity;
    expect([299, 300, 301].map(transaction)).toEqual([undefined, "Medium", "Medium"]);
    expect([899, 900, 901].map(transaction)).toEqual(["Medium", "High", "High"]);
  });

  it("applies every plan cutoff below, at, and above its boundary", async () => {
    const profile = await customProfile(() => undefined);
    const estimate = (actualRows: number, ratio: number) => rule(planReport(planWith({ actualRows, estimatedRows: actualRows / ratio }), profile), "PLAN-ESTIMATE")?.severity;
    expect([9.99, 10, 10.01].map((ratio) => estimate(10_000, ratio))).toEqual([undefined, "Medium", "Medium"]);
    expect([99.99, 100, 100.01].map((ratio) => estimate(100_000, ratio))).toEqual(["Medium", "High", "High"]);
    expect([9_999, 10_000, 10_001].map((rows) => estimate(rows, 10))).toEqual([undefined, "Medium", "Medium"]);
    expect([99_999, 100_000, 100_001].map((rows) => estimate(rows, 100))).toEqual(["Medium", "High", "High"]);

    expect([69.99, 70, 70.01].map((impact) => rule(planReport(planWith({ missingIndexImpact: impact }), profile), "PLAN-MISSING-INDEX")?.severity)).toEqual(["Low", "Medium", "Medium"]);

    const grant = (waste: number, ratio: number) => {
      const usedKb = waste / (ratio - 1);
      return rule(planReport(planWith({ grant: { grantedKb: usedKb + waste, usedKb } }), profile), "PLAN-MEMORY-GRANT")?.severity;
    };
    expect([131_071, 131_072, 131_073].map((waste) => grant(waste, 8))).toEqual([undefined, "Medium", "Medium"]);
    expect([524_287, 524_288, 524_289].map((waste) => grant(waste, 8))).toEqual(["Medium", "High", "High"]);
    expect([3.99, 4, 4.01].map((ratio) => grant(600_000, ratio))).toEqual([undefined, "Medium", "Medium"]);
    expect([7.99, 8, 8.01].map((ratio) => grant(600_000, ratio))).toEqual(["Medium", "High", "High"]);

    expect([99_999, 100_000, 100_001].map((rows) => rule(planReport(planWith({ actualRows: rows, spill: true }), profile), "PLAN-SPILL")?.severity)).toEqual(["Medium", "High", "High"]);
  });

  it("keeps a custom change isolated to its configured threshold group", async () => {
    const headers = ["session_id", "collection_time", "start_time", "open_tran_count", "status", "blocking_session_id"];
    const baseline = await customProfile(() => undefined);
    const custom = await customProfile((thresholds) => { thresholds.transactions.mediumAgeSeconds = 200; });
    const rows = [[70, iso(0), iso(-250_000), 1, "running", null]];
    expect(rule(activityReport(headers, rows, baseline), "WIA-TRANSACTION")).toBeUndefined();
    expect(rule(activityReport(headers, rows, custom), "WIA-TRANSACTION")?.severity).toBe("Medium");
    expect(custom.thresholds.blocking).toEqual(baseline.thresholds.blocking);
    expect(custom.thresholds.resources).toEqual(baseline.thresholds.resources);
    expect(custom.thresholds.waits).toEqual(baseline.thresholds.waits);
    expect(custom.thresholds.workerExhaustion).toEqual(baseline.thresholds.workerExhaustion);
    expect(custom.thresholds.compilePressure).toEqual(baseline.thresholds.compilePressure);
    expect(custom.thresholds.plans).toEqual(baseline.thresholds.plans);
  });
});
