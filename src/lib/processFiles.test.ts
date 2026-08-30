import { File } from "node:buffer";
import { describe, expect, it } from "vitest";
import type { ThresholdProfile, ThresholdProfileSnapshot } from "../types";
import { analyze } from "../rules/engine";
import { createThresholdProfileSnapshot, DEFAULT_THRESHOLD_PROFILE, DEFAULT_THRESHOLD_PROFILE_SNAPSHOT } from "../rules/thresholdProfiles";
import { processInputFiles } from "./processFiles";

describe("worker processing boundary", () => {
  it("returns a phase-specific error when analysis throws", async () => {
    const file = new File([
      "session_id,collection_time\n51,2026-08-25T01:00:00Z\n",
    ], "capture.csv", { type: "text/csv" });

    const result = await processInputFiles([file], {
      thresholdProfile: DEFAULT_THRESHOLD_PROFILE_SNAPSHOT,
      analyzeReport: () => { throw new Error("synthetic analysis failure"); },
    });

    expect(result.type).toBe("error");
    expect(result.errors.join(" ")).toMatch(/analysis phase/i);
    expect(result.errors.join(" ")).toContain("synthetic analysis failure");
  });

  it("preserves native multi-task waits through the production ingestion boundary", async () => {
    const file = new File([
      [
        "session_id,collection_time,start_time,wait_info,status",
        "300,2026-08-25T01:00:00Z,2026-08-25T00:59:00Z,(4x: 1200ms/1500ms/2000ms)THREADPOOL,suspended",
        "301,2026-08-25T01:00:00Z,2026-08-25T00:59:00Z,(3x: 900ms/1200ms/1600ms)THREADPOOL,suspended",
        "300,2026-08-25T01:00:05Z,2026-08-25T00:59:00Z,(4x: 2200ms/2500ms/3000ms)THREADPOOL,suspended",
        "301,2026-08-25T01:00:05Z,2026-08-25T00:59:00Z,(3x: 1900ms/2200ms/2600ms)THREADPOOL,suspended",
        "410,2026-08-25T01:00:00Z,2026-08-25T00:59:00Z,(2x: 1200ms/1800ms)CXPACKET:nodeId=7,suspended",
      ].join("\n"),
    ], "native-multitask.csv", { type: "text/csv" });

    const result = await processInputFiles([file], { thresholdProfile: DEFAULT_THRESHOLD_PROFILE_SNAPSHOT });
    expect(result.type).toBe("complete");
    if (result.type !== "complete") return;
    expect(result.errors).toEqual([]);
    const worker = result.report.findings.find((finding) => finding.ruleId === "WIA-WORKER-EXHAUSTION");
    expect(worker).toMatchObject({ severity: "High", affectedRecordIds: expect.any(Array) });
    expect(worker?.affectedRecordIds).toHaveLength(4);
    expect(worker?.evidence).toEqual(expect.arrayContaining([
      { label: "Maximum native task count", value: "4" },
      { label: "Maximum wait", value: "3,000 ms" },
    ]));
    expect(result.report.records.find((record) => record.sessionId === 300)?.wait).toMatchObject({ type: "THREADPOOL", taskCount: 4, durationsMs: [1_200, 1_500, 2_000] });
    expect(result.report.records.find((record) => record.sessionId === 410)?.wait).toMatchObject({ type: "CXPACKET", taskCount: 2, durationMs: 1_800, category: "Parallelism" });
    expect(result.report.findings.some((finding) => finding.title.includes("(2x") || finding.category === "Other" && finding.title.includes("CXPACKET"))).toBe(false);
  });

  it("recognizes Query Store CSV as supplemental evidence instead of a malformed activity capture", async () => {
    const file = new File([
      "query_id,plan_id,query_hash,query_plan_hash,query_sql_text,avg_duration_ms,runtime_interval_start\n1174,418,0x01,0x02,SELECT 1,41,2026-08-28T20:00:00Z\n",
    ], "querystore.csv", { type: "text/csv" });

    const result = await processInputFiles([file], { thresholdProfile: DEFAULT_THRESHOLD_PROFILE_SNAPSHOT });
    expect(result.type).toBe("complete");
    if (result.type !== "complete") return;
    expect(result.errors).toEqual([]);
    expect(result.report.inputs[0]).toMatchObject({ fileName: "querystore.csv", rowCount: 1 });
    expect(result.report.inputs[0].warnings.join(" ")).toMatch(/query store.*supplemental/i);
  });

  it("recognizes memory and tempdb counters as supplemental evidence", async () => {
    const file = new File([
      "collection_time,Memory_Grants_Pending,Memory_Grants_Outstanding,Granted_Workspace_Memory_KB,Tempdb_Data_File_Size_KB,RESOURCE_SEMAPHORE_waiting_tasks\n2026-03-08T22:10:00Z,1,3,786432,512000,0\n",
    ], "memory-counters.csv", { type: "text/csv" });

    const result = await processInputFiles([file], { thresholdProfile: DEFAULT_THRESHOLD_PROFILE_SNAPSHOT });
    expect(result.type).toBe("complete");
    if (result.type !== "complete") return;
    expect(result.errors).toEqual([]);
    expect(result.report.inputs[0]).toMatchObject({ fileName: "memory-counters.csv", rowCount: 1 });
    expect(result.report.inputs[0].warnings.join(" ")).toMatch(/memory counters.*supplemental/i);
  });

  it("verifies and transfers one profile snapshot through the processing boundary", async () => {
    const file = new File([
      "session_id,collection_time\n51,2026-08-25T01:00:00Z\n",
    ], "capture.csv", { type: "text/csv" });
    const custom = structuredClone(DEFAULT_THRESHOLD_PROFILE) as ThresholdProfile;
    custom.id = "dba.worker-transfer";
    custom.name = "DBA worker transfer";
    custom.thresholds.transactions.mediumAgeSeconds = 301;
    const thresholdProfile = await createThresholdProfileSnapshot(custom);
    let received: ThresholdProfileSnapshot | undefined;

    const result = await processInputFiles([file], {
      thresholdProfile,
      analyzeReport: (inputs, records, plans, profile) => {
        received = profile;
        return analyze(inputs, records, plans, profile);
      },
    });

    expect(result.type).toBe("complete");
    expect(received).toEqual(thresholdProfile);
    if (result.type === "complete") expect(result.report.thresholdProfile).toEqual(thresholdProfile);
  });

  it("fails before parsing or analysis when the transferred profile digest is invalid", async () => {
    const file = new File([
      "session_id,collection_time\n51,2026-08-25T01:00:00Z\n",
    ], "capture.csv", { type: "text/csv" });
    const invalid = { ...DEFAULT_THRESHOLD_PROFILE_SNAPSHOT, digest: "0".repeat(64) };
    let analyzed = false;

    const result = await processInputFiles([file], {
      thresholdProfile: invalid,
      analyzeReport: (...args) => { analyzed = true; return analyze(...args); },
    });

    expect(result.type).toBe("error");
    expect(result.errors.join(" ")).toMatch(/threshold profile validation failed/i);
    expect(result.errors.join(" ")).toMatch(/digest does not match/i);
    expect(analyzed).toBe(false);
  });
});
