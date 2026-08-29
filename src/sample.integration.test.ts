import { existsSync, readFileSync } from "node:fs";
import { File } from "node:buffer";
import { describe, expect, it } from "vitest";
import { parseCaptureFile } from "./lib/ingest";
import { analyze } from "./rules/engine";

const samplePath = process.env.SQL_EVALUATE_SAMPLE;
const enabled = Boolean(samplePath && existsSync(samplePath));

describe.runIf(enabled)("provided sanitized workbook", () => {
  it("imports and analyzes the expected capture shape", async () => {
    const bytes = readFileSync(samplePath!);
    const file = new File([bytes], "capture.csv.xlsx");
    const parsed = await parseCaptureFile(file);
    const report = analyze([parsed.input], parsed.records, []);
    expect(parsed.records).toHaveLength(604);
    expect(new Set(parsed.records.map((record) => record.collectionTime).filter(Boolean))).toHaveLength(73);
    expect(Math.max(...parsed.records.map((record) => record.blockedSessionCount ?? 0))).toBe(14);
    expect(report.findings.some((finding) => finding.ruleId === "WIA-BLOCKING")).toBe(true);
    expect(report.findings.length).toBeLessThan(99);
    const blocking = report.findings.filter((finding) => finding.ruleId === "WIA-BLOCKING");
    expect(blocking.length).toBeLessThan(34);
    expect(blocking.every((finding) => finding.title.includes("root blocker"))).toBe(true);
    expect(blocking.some((finding) => finding.blockingContext?.participants?.some((participant) => participant.role === "Intermediate"))).toBe(true);
    expect(report.findings.filter((finding) => finding.title.includes("WAITFOR")).every((finding) => finding.severity !== "High")).toBe(true);
    expect(report.findings.some((finding) => finding.ruleId === "PLAN-UNAVAILABLE")).toBe(true);
  });
});
