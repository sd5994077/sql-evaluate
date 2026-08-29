import { File } from "node:buffer";
import { describe, expect, it } from "vitest";
import { processInputFiles } from "./processFiles";

describe("worker processing boundary", () => {
  it("returns a phase-specific error when analysis throws", async () => {
    const file = new File([
      "session_id,collection_time\n51,2026-08-25T01:00:00Z\n",
    ], "capture.csv", { type: "text/csv" });

    const result = await processInputFiles([file], {
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

    const result = await processInputFiles([file]);
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
});
