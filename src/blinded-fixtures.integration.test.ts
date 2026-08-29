import { File } from "node:buffer";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AnalysisReport } from "./types";
import { processInputFiles } from "./lib/processFiles";
import { addEvidenceFiles, createDeepAnalysisCase } from "./deepAnalysis/case";
import { deepAnalysisProfileForFinding } from "./deepAnalysis/profile";

const fixturesRoot = fileURLToPath(new URL("../fixtures/", import.meta.url));

async function analyzeCase(caseId: string, names: string[]): Promise<AnalysisReport> {
  const files = names.map((name) => new File([readFileSync(`${fixturesRoot}${caseId}/${name}`)], name));
  const result = await processInputFiles(files);
  if (result.type === "error") throw new Error(result.errors.join("\n"));
  expect(result.errors).toEqual([]);
  return result.report;
}

function fixtureFile(caseId: string, name: string): File {
  return new File([readFileSync(`${fixturesRoot}${caseId}/${name}`)], name);
}

describe("opaque blinded fixture regressions", () => {
  it("CASE-001 stays quiet for a healthy capture", async () => {
    const report = await analyzeCase("CASE-001", ["whoisactive_CASE-001.csv"]);
    expect(report.findings.filter((item) => ["High", "Medium", "Low"].includes(item.severity))).toHaveLength(0);
  });

  it("CASE-004 identifies one compilation-pressure incident", async () => {
    const report = await analyzeCase("CASE-004", ["whoisactive_CASE-004.xlsx", "plan_CASE-004_a.sqlplan"]);
    const primary = report.findings.filter((item) => item.ruleId === "WIA-COMPILE-PRESSURE");
    expect(primary).toHaveLength(1);
    expect(primary[0].severity).toMatch(/High|Medium/);
    expect(primary[0].title).toMatch(/compil|plan.cache/i);
    expect(primary[0].affectedRecordIds.length).toBe(417);
  });

  it("CASE-005 identifies one worker-exhaustion incident", async () => {
    const report = await analyzeCase("CASE-005", ["whoisactive_CASE-005.csv"]);
    const primary = report.findings.filter((item) => item.ruleId === "WIA-WORKER-EXHAUSTION");
    expect(primary).toHaveLength(1);
    expect(primary[0].severity).toBe("High");
    expect(primary[0].title).toMatch(/worker|THREADPOOL/i);
    expect(primary[0].affectedRecordIds.length).toBe(664);
    expect(report.findings.filter((item) => item.ruleId === "WIA-WAIT" && item.title.includes("THREADPOOL"))).toHaveLength(0);
  });

  it("CASE-006 surfaces the actual spill without downgrading the published grant threshold", async () => {
    const report = await analyzeCase("CASE-006", ["whoisactive_CASE-006.xlsx", "plan_CASE-006_a.sqlplan"]);
    expect(report.findings.some((item) => item.ruleId === "PLAN-SPILL")).toBe(true);
    expect(report.findings.find((item) => item.ruleId === "PLAN-MEMORY-GRANT")?.severity).toBe("High");
  });

  it("CASE-007 surfaces forced serialization and scalar UDF evidence", async () => {
    const report = await analyzeCase("CASE-007", ["whoisactive_CASE-007.csv", "plan_CASE-007_a.sqlplan"]);
    expect(report.findings.some((item) => item.ruleId === "PLAN-SERIALIZATION")).toBe(true);
    expect(report.findings.some((item) => item.ruleId === "PLAN-SCALAR-UDF")).toBe(true);
  });

  it("CASE-008 surfaces conversion and residual predicate causes", async () => {
    const report = await analyzeCase("CASE-008", ["whoisactive_CASE-008.xlsx", "plan_CASE-008_a.sqlplan"]);
    const conversion = report.findings.find((item) => item.ruleId === "PLAN-CONVERT");
    expect(conversion).toBeDefined();
    expect(conversion?.evidence.find((item) => item.label === "Operator")?.value).toBe("Index Scan");
    expect(report.findings.some((item) => item.ruleId === "PLAN-RESIDUAL-PREDICATE")).toBe(true);
  });

  it("CASE-009 emits at most one low-impact transient observation", async () => {
    const report = await analyzeCase("CASE-009", ["whoisactive_CASE-009.csv"]);
    const actionable = report.findings.filter((item) => ["High", "Medium", "Low", "Informational"].includes(item.severity));
    expect(actionable.length).toBeLessThanOrEqual(1);
    expect(actionable.every((item) => deepAnalysisProfileForFinding(item) === null && item.deepAnalysisProfile === undefined)).toBe(true);
  });

  it("CASE-010 recommends a representative actual plan", async () => {
    const report = await analyzeCase("CASE-010", ["whoisactive_CASE-010.csv", "plan_CASE-010_a.sqlplan"]);
    const limitation = report.findings.find((item) => item.ruleId === "PLAN-RUNTIME-UNAVAILABLE");
    expect(limitation?.severity).toBe("Not Evaluated");
    expect(limitation?.nextCapture?.title).toMatch(/actual plan/i);
  });

  it("routes blocking profiles from the root state", async () => {
    const sleeping = await analyzeCase("CASE-002", ["whoisactive_CASE-002.xlsx"]);
    const runnable = await analyzeCase("CASE-003", ["whoisactive_CASE-003.csv"]);
    const sleepingFinding = sleeping.findings.find((item) => item.ruleId === "WIA-BLOCKING" && item.blockingContext?.headBlockerSessionId === 52)!;
    const runnableFinding = runnable.findings.find((item) => item.ruleId === "WIA-BLOCKING" && item.blockingContext?.status === "runnable")!;
    expect(deepAnalysisProfileForFinding(sleepingFinding)).toBe("transaction-blocking");
    expect(createDeepAnalysisCase(sleeping, sleepingFinding, "2026-01-01T00:00:00Z", "sleeping-case").title).not.toMatch(/CPU-backed/i);
    expect(deepAnalysisProfileForFinding(runnableFinding)).toBe("cpu-backed-blocking");
  });

  it("routes worker counters through the worker-exhaustion case", async () => {
    const report = await analyzeCase("CASE-005", ["whoisactive_CASE-005.csv"]);
    const finding = report.findings.find((item) => item.ruleId === "WIA-WORKER-EXHAUSTION")!;
    const deepCase = createDeepAnalysisCase(report, finding, "2026-04-11T03:15:00Z", "worker-case");
    const evaluated = await addEvidenceFiles(deepCase, [fixtureFile("CASE-005", "counters_CASE-005.csv")], "2026-04-11T03:20:00Z");
    expect(deepCase.profileId).toBe("worker-exhaustion");
    expect(evaluated.deepCase.assertions.find((item) => item.id === "worker-ceiling")?.state).toBe("Supported");
    expect(evaluated.deepCase.assertions.find((item) => item.id === "causal-theory")?.state).toBe("Supported");
  });

  it("routes compilation counters through the compile-pressure case", async () => {
    const report = await analyzeCase("CASE-004", ["whoisactive_CASE-004.xlsx", "plan_CASE-004_a.sqlplan"]);
    const finding = report.findings.find((item) => item.ruleId === "WIA-COMPILE-PRESSURE")!;
    const deepCase = createDeepAnalysisCase(report, finding, "2026-09-02T08:40:00Z", "compile-case");
    const evaluated = await addEvidenceFiles(deepCase, [fixtureFile("CASE-004", "counters_CASE-004.csv")], "2026-09-02T08:45:00Z");
    expect(deepCase.profileId).toBe("compile-pressure");
    expect(evaluated.deepCase.assertions.find((item) => item.id === "compilation-pressure")?.state).toBe("Supported");
    expect(evaluated.deepCase.assertions.find((item) => item.id === "causal-theory")?.state).toBe("Supported");
  });

  it("routes plan and runtime limitations to bounded profiles", async () => {
    const memory = await analyzeCase("CASE-006", ["whoisactive_CASE-006.xlsx", "plan_CASE-006_a.sqlplan"]);
    const plan = await analyzeCase("CASE-007", ["whoisactive_CASE-007.csv", "plan_CASE-007_a.sqlplan"]);
    const estimated = await analyzeCase("CASE-010", ["whoisactive_CASE-010.csv", "plan_CASE-010_a.sqlplan"]);
    expect(deepAnalysisProfileForFinding(memory.findings.find((item) => item.ruleId === "PLAN-MEMORY-GRANT")!)).toBe("memory-grants");
    expect(deepAnalysisProfileForFinding(plan.findings.find((item) => item.ruleId === "PLAN-SERIALIZATION")!)).toBe("plan-specific");
    expect(deepAnalysisProfileForFinding(estimated.findings.find((item) => item.ruleId === "PLAN-RUNTIME-UNAVAILABLE")!)).toBe("actual-plan");
  });
});
