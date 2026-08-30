import { describe, expect, it } from "vitest";
import type { AnalysisReport } from "../types";
import { findingsCsv, printableReport, redactReport, validateReport, validateReportShape } from "./report";
import { DEFAULT_THRESHOLD_PROFILE_SNAPSHOT } from "../rules/thresholdProfiles";

const report: AnalysisReport = {
  schemaVersion: "1.0", createdAt: "2026-08-22T12:00:00Z", redacted: false,
  inputs: [{ id: "s", fileName: "sample.csv", size: 10, format: "csv", rowCount: 1, recognizedColumns: ["session_id", "sql_text"], unknownColumns: [], warnings: [] }],
  records: [{ id: "r", sourceId: "s", rowNumber: 2, sessionId: 51, requestId: 0, collectionTime: null, startTime: null, loginTime: null, durationSeconds: null, wait: null, status: null, blockingSessionId: null, blockedSessionCount: null, openTranCount: null, implicitTran: null, cpuMs: null, reads: null, writes: null, physicalReads: null, usedMemoryPages: null, tempdbAllocationPages: null, tempdbCurrentPages: null, sqlText: "SELECT * FROM Customer WHERE Id = 123456 AND Name = 'Ada'", sqlCommand: "EXEC Secret 123456", queryPlanXml: "<ShowPlanXML />", databaseName: "PrivateDb", loginName: "domain\\person", hostName: "host-1", programName: "billing", original: { session_id: 51, sql_text: "secret", sql_text__2: "duplicate secret", query_plan__2: "duplicate plan", database_name: "PrivateDb" } }],
  plans: [{ id: "p", sourceId: "s", fileName: "plan.sqlplan", version: "1.6", isActual: true, warnings: [], statements: [{ id: "st", statementText: "SELECT * FROM PrivateTable WHERE Id = 7", statementType: "SELECT", estimatedCost: 1, isActual: true, missingIndexImpact: null, queryIdentity: { sqlHandle: "0xSECRET_HANDLE", queryHash: "0xSECRET_HASH" }, operators: [{ id: "op", nodeId: 1, physicalOp: "Index Scan", logicalOp: "Index Scan", estimatedRows: 1, actualRows: 1, estimatedCost: 1, warnings: ["Plan-affecting conversion: CONVERT_IMPLICIT(int,[PrivateDb].[dbo].[PrivateTable].[SecretColumn],0)"], objectName: "[PrivateDb].[dbo].[PrivateTable]", predicate: "[PrivateDb].[dbo].[PrivateTable].[SecretColumn] = 7", seekPredicate: "[PrivateDb].[dbo].[PrivateTable].[SecretColumn] = 7", residualPredicate: "[PrivateDb].[dbo].[PrivateTable].[SecretColumn] = 7", nonSargablePredicate: "CONVERT_IMPLICIT(int,[PrivateDb].[dbo].[PrivateTable].[SecretColumn],0) = 7" }], warnings: ["Plan-affecting conversion: CONVERT_IMPLICIT(int,[PrivateDb].[dbo].[PrivateTable].[SecretColumn],0)"] }] }],
  findings: [{ id: "f", ruleId: "TEST", severity: "High", confidence: "High", category: "Test", title: "Example", summary: "Evidence, with comma", explanation: "Why", remediation: ["Verify"], blockingContext: { headBlockerSessionId: 51, blockedSessionIds: [52, 53, 54, 55, 56], totalBlockedSessions: 14, status: "sleeping", databaseName: "PrivateDb", openTransactionCount: 1, commandLabel: "Last / outer command", commandPreview: "EXEC Secret 123456" }, evidence: [{ label: "Predicate", value: "[PrivateDb].[dbo].[PrivateTable].[SecretColumn] = 7" }, { label: "Value", value: "1" }], references: [{ label: "Docs", url: "https://example.com" }], affectedRecordIds: ["r"], affectedPlanIds: [], impact: 1 }],
  dataQuality: { presentColumns: ["session_id", "sql_text"], missingColumns: [], unknownColumns: [], warnings: [], notEvaluatedRules: [] },
  thresholdProfile: DEFAULT_THRESHOLD_PROFILE_SNAPSHOT,
};

const enhancedReport: AnalysisReport = {
  ...report,
  dataQuality: { ...report.dataQuality, findingCaps: [{ ruleId: "WIA-WAIT", retainedCount: 24, suppressedCount: 6, order: "Descending diagnostic impact" }] },
  findings: [{
    ...report.findings[0],
    confidenceReason: "High confidence because direct evidence was supplied.",
    limitations: ["Only one workload window was supplied."],
    timeline: { metric: "Blocked sessions", unit: "sessions", points: [{ capturedAt: "2026-08-22T12:00:00Z", value: 5 }, { capturedAt: "2026-08-22T12:01:00Z", value: 2 }], firstValue: 5, latestValue: 2, peakValue: 5, direction: "Decreasing" },
    nextCapture: { title: "Confirm persistence", reason: "Repeat a short sample.", command: "EXEC dbo.sp_WhoIsActive @delta_interval = 5;", expectedEvidence: ["A second observation"], caution: "Capture briefly." },
    relatedFindings: [],
  }],
};

const qualifiedReport: AnalysisReport = {
  ...report,
  plans: [{ ...report.plans[0], statements: [{ ...report.plans[0].statements[0], compileTimeMs: 45, compileCpuMs: 40, compileMemoryKb: 4096, earlyAbortReason: "TimeOut", optimizationLevel: "FULL" }] }],
  findings: [{
    ...report.findings[0], ruleId: "PLAN-TEST", category: "Execution plan", affectedPlanIds: ["p", "st"], qualifications: [
      { kind: "Compile time", disposition: "Context only", value: "45 ms", reason: "Compile context.", planId: "p", statementId: "st" },
      { kind: "Compile CPU", disposition: "Context only", value: "40 ms", reason: "CPU context.", planId: "p", statementId: "st" },
      { kind: "Compile memory", disposition: "Context only", value: "4096 KB", reason: "Separate from grants.", planId: "p", statementId: "st" },
      { kind: "Optimizer early abort", disposition: "Observed", value: "TimeOut", reason: "Observed only.", planId: "p", statementId: "st" },
      { kind: "Optimization level", disposition: "Observed", value: "FULL", reason: "Not ranked.", planId: "p", statementId: "st" },
    ],
  }],
};

describe("report exports", () => {
  it("redacts sensitive fields and literals by default", () => {
    const safe = redactReport(report);
    expect(safe.redacted).toBe(true);
    expect(safe.records[0].loginName).toBe("[redacted]");
    expect(safe.records[0].sqlText).not.toContain("Ada");
    expect(safe.records[0].sqlText).not.toContain("123456");
    expect(safe.records[0].original.sql_text).toBe("[redacted]");
    expect(safe.records[0].original.sql_text__2).toBe("[redacted]");
    expect(safe.records[0].original.query_plan__2).toBe("[redacted]");
    expect(safe.plans[0].statements[0].operators[0].objectName).toBe("[redacted object]");
    expect(safe.plans[0].statements[0].operators[0].predicate).toBe("[redacted expression]");
    expect(safe.plans[0].statements[0].operators[0].seekPredicate).toBe("[redacted expression]");
    expect(safe.plans[0].statements[0].operators[0].residualPredicate).toBe("[redacted expression]");
    expect(safe.plans[0].statements[0].operators[0].nonSargablePredicate).toBe("[redacted expression]");
    expect(safe.plans[0].statements[0].queryIdentity).toBeUndefined();
    expect(safe.findings[0].blockingContext?.databaseName).toBe("[redacted]");
    expect(safe.findings[0].blockingContext?.commandPreview).toBe("[redacted command preview]");
    const serialized = JSON.stringify(safe);
    expect(serialized).not.toContain("PrivateTable");
    expect(serialized).not.toContain("SecretColumn");
    expect(serialized).not.toContain("0xSECRET");
    expect(serialized).not.toContain(" = 7");
  });

  it("creates portable CSV and HTML and validates JSON shape", async () => {
    expect(findingsCsv(report)).toContain('"Evidence, with comma"');
    expect(findingsCsv(redactReport(report))).not.toContain("EXEC Secret");
    expect(findingsCsv(report)).toContain("THRESHOLD-PROFILE");
    expect(findingsCsv(report)).toContain(DEFAULT_THRESHOLD_PROFILE_SNAPSHOT.digest);
    expect(printableReport(report)).toContain("SQL Evaluate report");
    expect((await validateReport(JSON.parse(JSON.stringify(report)))).records).toHaveLength(1);
    expect(() => validateReportShape({ schemaVersion: "2.0" })).toThrow(/compatible/);
    expect(() => validateReportShape({ ...report, findings: [{}] })).toThrow(/compatible/);
    expect((await validateReport({ ...report, thresholdProfile: DEFAULT_THRESHOLD_PROFILE_SNAPSHOT })).thresholdProfile).toEqual(DEFAULT_THRESHOLD_PROFILE_SNAPSHOT);
    expect(() => validateReportShape({ ...report, thresholdProfile: { ...DEFAULT_THRESHOLD_PROFILE_SNAPSHOT, digest: 1 } })).toThrow(/compatible/);
  });

  it("exports and validates enhanced investigation context while accepting older schema-1.0 reports", async () => {
    const csv = findingsCsv(enhancedReport);
    const html = printableReport(enhancedReport);
    expect(csv).toContain("Confidence basis");
    expect(csv).toContain("Confirm persistence");
    expect(html).toContain("Investigation context");
    expect(html).toContain("Blocked sessions");
    expect(csv).toContain("6 additional WIA-WAIT findings were suppressed after retaining 24");
    expect(html).toContain("6 additional WIA-WAIT findings were suppressed after retaining 24");
    expect((await validateReport(JSON.parse(JSON.stringify(enhancedReport)))).findings[0].timeline?.points).toHaveLength(2);
    const { thresholdProfile: _profile, ...legacy } = report;
    expect((await validateReport(JSON.parse(JSON.stringify(legacy)))).findings[0].timeline).toBeUndefined();
    expect(findingsCsv(legacy)).toContain("Legacy report — threshold profile not recorded.");
    expect(printableReport(legacy)).toContain("Legacy report — threshold profile not recorded.");
    const tooManyPoints = Array.from({ length: 73 }, (_, index) => ({ capturedAt: new Date(index * 1_000).toISOString(), value: index }));
    expect(() => validateReportShape({ ...enhancedReport, findings: [{ ...enhancedReport.findings[0], timeline: { ...enhancedReport.findings[0].timeline!, points: tooManyPoints } }] })).toThrow(/compatible/);
  });

  it("rejects a structurally valid report whose profile digest does not match", async () => {
    const tampered = { ...report, thresholdProfile: { ...DEFAULT_THRESHOLD_PROFILE_SNAPSHOT, name: "Tampered profile" } };
    expect(validateReportShape(tampered).thresholdProfile?.name).toBe("Tampered profile");
    await expect(validateReport(tampered)).rejects.toThrow(/verification failed/);
  });

  it("does not emit active-content reference links in printable reports", () => {
    const unsafe = { ...report, findings: [{ ...report.findings[0], references: [{ label: "Unsafe", url: "javascript:alert(1)" }] }] };
    expect(printableReport(unsafe)).not.toContain('href="javascript:');
  });

  it("neutralizes spreadsheet formulas from imported report fields", () => {
    const formulaFinding = { ...report.findings[0], title: "=2+2", summary: "+SUM(1,1)", category: "@external" };
    const csv = findingsCsv({ ...report, thresholdProfile: { ...DEFAULT_THRESHOLD_PROFILE_SNAPSHOT, name: "=PROFILE" }, findings: [formulaFinding], dataQuality: { ...report.dataQuality, findingCaps: [{ ruleId: "=CAP", retainedCount: 1, suppressedCount: 1, order: "Descending diagnostic impact" }] } });
    expect(csv).toContain("'=2+2");
    expect(csv).toContain("'+SUM(1,1)");
    expect(csv).toContain("'@external");
    expect(csv).toContain("'=CAP findings truncated");
    expect(csv).toContain("'=PROFILE");
  });

  it("rejects nonsensical finding-cap metadata in imported reports", () => {
    const withCap = (retainedCount: number, suppressedCount: number) => ({
      ...report,
      dataQuality: { ...report.dataQuality, findingCaps: [{ ruleId: "WIA-WAIT", retainedCount, suppressedCount, order: "Descending diagnostic impact" }] },
    });
    expect(() => validateReportShape(withCap(-1, 2))).toThrow(/compatible/);
    expect(() => validateReportShape(withCap(2.5, 2))).toThrow(/compatible/);
    expect(() => validateReportShape(withCap(2, 0))).toThrow(/compatible/);
    expect(() => validateReportShape(withCap(Number.MAX_SAFE_INTEGER + 1, 2))).toThrow(/compatible/);
  });

  it("validates, displays, and exports statement-scoped qualifications", async () => {
    expect((await validateReport(JSON.parse(JSON.stringify(qualifiedReport)))).findings[0].qualifications).toHaveLength(5);
    const csv = findingsCsv(qualifiedReport);
    const html = printableReport(qualifiedReport);
    expect(csv).toContain("Qualifications");
    expect(csv).toContain("Compile memory (Context only): 4096 KB");
    expect(html).toContain("Compile and optimizer context");
    expect(html).toContain("Optimization level");
  });

  it("rejects invalid qualification order, duplication, disposition, controls, and references", () => {
    const baseFinding = qualifiedReport.findings[0];
    const withQualifications = (qualifications: NonNullable<typeof baseFinding.qualifications>, affectedPlanIds = baseFinding.affectedPlanIds) => ({ ...qualifiedReport, findings: [{ ...baseFinding, affectedPlanIds, qualifications }] });
    expect(() => validateReportShape(withQualifications([...baseFinding.qualifications!].reverse()))).toThrow(/compatible/);
    expect(() => validateReportShape(withQualifications([baseFinding.qualifications![0], baseFinding.qualifications![0]]))).toThrow(/compatible/);
    expect(() => validateReportShape(withQualifications([{ ...baseFinding.qualifications![0], disposition: "Observed" }]))).toThrow(/compatible/);
    expect(() => validateReportShape(withQualifications([{ ...baseFinding.qualifications![0], value: "45 ms\nSELECT secret" }]))).toThrow(/compatible/);
    expect(() => validateReportShape(withQualifications([{ ...baseFinding.qualifications![0], statementId: "other" }]))).toThrow(/compatible/);
    expect(() => validateReportShape(withQualifications([baseFinding.qualifications![0]], ["p"]))).toThrow(/compatible/);
    expect(() => validateReportShape({ ...qualifiedReport, findings: [{ ...baseFinding, ruleId: "WIA-TEST" }] })).toThrow(/compatible/);
  });

  it("rejects malformed optional compile fields on imported plan statements", () => {
    const withCompileTime = (compileTimeMs: unknown) => ({ ...qualifiedReport, plans: [{ ...qualifiedReport.plans[0], statements: [{ ...qualifiedReport.plans[0].statements[0], compileTimeMs }] }] });
    expect(() => validateReportShape(withCompileTime(Number.POSITIVE_INFINITY))).toThrow(/compatible/);
    expect(() => validateReportShape(withCompileTime(-1))).toThrow(/compatible/);
    expect(() => validateReportShape(withCompileTime("45"))).toThrow(/compatible/);
  });

  it("redacts unsafe optimizer metadata and untrusted qualification prose in default exports", () => {
    const unsafe = {
      ...qualifiedReport,
      plans: [{ ...qualifiedReport.plans[0], statements: [{ ...qualifiedReport.plans[0].statements[0], earlyAbortReason: "</style><script>alert(1)</script>", optimizationLevel: "SELECT Secret" }] }],
      findings: [{ ...qualifiedReport.findings[0], qualifications: qualifiedReport.findings[0].qualifications!.map((item) => item.kind === "Optimization level" ? { ...item, value: "SELECT Secret", reason: "SELECT * FROM PrivateTable" } : item) }],
    };
    const safe = redactReport(unsafe);
    expect(safe.plans[0].statements[0].earlyAbortReason).toBe("[redacted optimizer value]");
    expect(safe.plans[0].statements[0].optimizationLevel).toBe("[redacted optimizer value]");
    expect(safe.findings[0].qualifications?.find((item) => item.kind === "Optimization level")).toMatchObject({ value: "[redacted optimizer value]", reason: expect.not.stringContaining("PrivateTable") });
    expect(findingsCsv(safe)).not.toContain("SELECT Secret");
    expect(printableReport(safe)).not.toContain("<script>");
  });
});
