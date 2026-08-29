import { existsSync, readFileSync } from "node:fs";
import { File } from "node:buffer";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseCaptureFile } from "./lib/ingest";
import { analyze } from "./rules/engine";

const fixturePath = fileURLToPath(new URL("../outputs/sql-evaluate-synthetic/SQL-Evaluate-Synthetic-WhoIsActive-15-Rows.xlsx", import.meta.url));

describe("synthetic all-column workbook", () => {
  it.skipIf(!existsSync(fixturePath))("exercises activity and embedded actual-plan diagnostics", async () => {
    const file = new File([readFileSync(fixturePath)], "SQL-Evaluate-Synthetic-WhoIsActive-15-Rows.xlsx");
    const parsed = await parseCaptureFile(file);
    const report = analyze([parsed.input], parsed.records, parsed.plans);

    expect(parsed.records).toHaveLength(15);
    expect(parsed.input.recognizedColumns).toHaveLength(50);
    expect(new Set(parsed.records.map((record) => record.collectionTime))).toHaveLength(3);
    expect(report.plans).toHaveLength(1);
    expect(report.findings).toHaveLength(12);
    expect(report.findings.filter((finding) => finding.severity === "High")).toHaveLength(8);
    expect(report.findings.filter((finding) => finding.severity === "Medium")).toHaveLength(3);
    expect(report.findings.filter((finding) => finding.severity === "Informational")).toHaveLength(1);
    expect(report.findings.some((finding) => finding.ruleId === "WIA-BLOCKING" && finding.severity === "High")).toBe(true);
    expect(report.findings.some((finding) => finding.ruleId === "WIA-RESOURCE" && finding.severity === "High")).toBe(true);
    expect(report.findings.some((finding) => finding.ruleId === "PLAN-ESTIMATE" && finding.severity === "High")).toBe(true);
    expect(report.findings.some((finding) => finding.ruleId === "PLAN-SPILL" && finding.severity === "High")).toBe(true);
    expect(report.findings.some((finding) => finding.ruleId === "PLAN-MEMORY-GRANT" && finding.severity === "High")).toBe(true);
    expect(report.findings.some((finding) => finding.ruleId === "PLAN-CONVERT")).toBe(true);
    expect(report.findings.some((finding) => finding.ruleId === "PLAN-MISSING-INDEX")).toBe(true);
    expect(report.findings.filter((finding) => finding.title.includes("WAITFOR")).every((finding) => finding.severity === "Informational")).toBe(true);
    expect(report.findings.find((finding) => finding.ruleId === "WIA-BLOCKING")?.diagnosticTools?.map((tool) => tool.name)).not.toContain("sp_WhoIsActive");
    const blockingContexts = report.findings.filter((finding) => finding.ruleId === "WIA-BLOCKING").map((finding) => finding.blockingContext);
    expect(blockingContexts.some((context) => context?.headBlockerSessionId === 55 && context.totalBlockedSessions === 5)).toBe(true);
    expect(blockingContexts.every((context) => (context?.blockedSessionIds.length ?? 0) <= 5)).toBe(true);
    expect(report.findings.find((finding) => finding.ruleId === "WIA-WAIT" && finding.title.includes("LCK_M_S"))?.diagnosticTools?.map((tool) => tool.name).join(" ")).toContain("sp_BlitzFirst");
    expect(report.findings.find((finding) => finding.ruleId === "PLAN-MEMORY-GRANT")?.diagnosticTools?.map((tool) => tool.name).join(" ")).toContain("sp_BlitzCache");
    expect(report.findings.find((finding) => finding.ruleId === "PLAN-ESTIMATE")?.diagnosticTools?.map((tool) => tool.name).join(" ")).toContain("IndexOptimize");
    expect(report.findings.find((finding) => finding.ruleId === "PLAN-MISSING-INDEX")?.diagnosticTools?.map((tool) => tool.name).join(" ")).toContain("sp_BlitzIndex");
    expect(report.findings.find((finding) => finding.ruleId === "PLAN-MISSING-INDEX")?.confidenceReason).toMatch(/optimizer suggestion/i);
    expect(report.findings.find((finding) => finding.ruleId === "PLAN-SPILL")?.confidenceReason).toMatch(/runtime spill warning/i);
    expect(report.findings.every((finding) => Boolean(finding.confidenceReason))).toBe(true);
    expect(report.findings.filter((finding) => ["WIA-BLOCKING", "WIA-RESOURCE", "WIA-WAIT", "WIA-TRANSACTION"].includes(finding.ruleId)).every((finding) => Boolean(finding.timeline))).toBe(true);
    expect(report.findings.find((finding) => finding.ruleId === "WIA-BLOCKING")?.nextCapture?.command).toContain("@find_block_leaders = 1");
    expect(report.plans[0].sourceRecordId).toBeTruthy();
    const estimate = report.findings.find((finding) => finding.ruleId === "PLAN-ESTIMATE")!;
    const spill = report.findings.find((finding) => finding.ruleId === "PLAN-SPILL")!;
    expect(estimate.affectedRecordIds).toContain(report.plans[0].sourceRecordId);
    expect(estimate.relatedFindings?.map((link) => link.findingId)).toContain(spill.id);
    expect(report.findings.every((finding) => (finding.relatedFindings?.length ?? 0) <= 5)).toBe(true);
  });
});
