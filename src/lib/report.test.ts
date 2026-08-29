import { describe, expect, it } from "vitest";
import type { AnalysisReport } from "../types";
import { findingsCsv, printableReport, redactReport, validateReport } from "./report";

const report: AnalysisReport = {
  schemaVersion: "1.0", createdAt: "2026-08-22T12:00:00Z", redacted: false,
  inputs: [{ id: "s", fileName: "sample.csv", size: 10, format: "csv", rowCount: 1, recognizedColumns: ["session_id", "sql_text"], unknownColumns: [], warnings: [] }],
  records: [{ id: "r", sourceId: "s", rowNumber: 2, sessionId: 51, requestId: 0, collectionTime: null, startTime: null, loginTime: null, durationSeconds: null, wait: null, status: null, blockingSessionId: null, blockedSessionCount: null, openTranCount: null, implicitTran: null, cpuMs: null, reads: null, writes: null, physicalReads: null, usedMemoryPages: null, tempdbAllocationPages: null, tempdbCurrentPages: null, sqlText: "SELECT * FROM Customer WHERE Id = 123456 AND Name = 'Ada'", sqlCommand: "EXEC Secret 123456", queryPlanXml: "<ShowPlanXML />", databaseName: "PrivateDb", loginName: "domain\\person", hostName: "host-1", programName: "billing", original: { session_id: 51, sql_text: "secret", sql_text__2: "duplicate secret", query_plan__2: "duplicate plan", database_name: "PrivateDb" } }],
  plans: [{ id: "p", sourceId: "s", fileName: "plan.sqlplan", version: "1.6", isActual: true, warnings: [], statements: [{ id: "st", statementText: "SELECT * FROM PrivateTable WHERE Id = 7", statementType: "SELECT", estimatedCost: 1, isActual: true, missingIndexImpact: null, queryIdentity: { sqlHandle: "0xSECRET_HANDLE", queryHash: "0xSECRET_HASH" }, operators: [{ id: "op", nodeId: 1, physicalOp: "Index Scan", logicalOp: "Index Scan", estimatedRows: 1, actualRows: 1, estimatedCost: 1, warnings: ["Plan-affecting conversion: CONVERT_IMPLICIT(int,[PrivateDb].[dbo].[PrivateTable].[SecretColumn],0)"], objectName: "[PrivateDb].[dbo].[PrivateTable]", predicate: "[PrivateDb].[dbo].[PrivateTable].[SecretColumn] = 7", seekPredicate: "[PrivateDb].[dbo].[PrivateTable].[SecretColumn] = 7", residualPredicate: "[PrivateDb].[dbo].[PrivateTable].[SecretColumn] = 7", nonSargablePredicate: "CONVERT_IMPLICIT(int,[PrivateDb].[dbo].[PrivateTable].[SecretColumn],0) = 7" }], warnings: ["Plan-affecting conversion: CONVERT_IMPLICIT(int,[PrivateDb].[dbo].[PrivateTable].[SecretColumn],0)"] }] }],
  findings: [{ id: "f", ruleId: "TEST", severity: "High", confidence: "High", category: "Test", title: "Example", summary: "Evidence, with comma", explanation: "Why", remediation: ["Verify"], blockingContext: { headBlockerSessionId: 51, blockedSessionIds: [52, 53, 54, 55, 56], totalBlockedSessions: 14, status: "sleeping", databaseName: "PrivateDb", openTransactionCount: 1, commandLabel: "Last / outer command", commandPreview: "EXEC Secret 123456" }, evidence: [{ label: "Predicate", value: "[PrivateDb].[dbo].[PrivateTable].[SecretColumn] = 7" }, { label: "Value", value: "1" }], references: [{ label: "Docs", url: "https://example.com" }], affectedRecordIds: ["r"], affectedPlanIds: [], impact: 1 }],
  dataQuality: { presentColumns: ["session_id", "sql_text"], missingColumns: [], unknownColumns: [], warnings: [], notEvaluatedRules: [] },
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

  it("creates portable CSV and HTML and validates JSON shape", () => {
    expect(findingsCsv(report.findings)).toContain('"Evidence, with comma"');
    expect(findingsCsv(redactReport(report).findings)).not.toContain("EXEC Secret");
    expect(printableReport(report)).toContain("SQL Evaluate report");
    expect(validateReport(JSON.parse(JSON.stringify(report))).records).toHaveLength(1);
    expect(() => validateReport({ schemaVersion: "2.0" })).toThrow(/compatible/);
    expect(() => validateReport({ ...report, findings: [{}] })).toThrow(/compatible/);
  });

  it("exports and validates enhanced investigation context while accepting older schema-1.0 reports", () => {
    const csv = findingsCsv(enhancedReport.findings, enhancedReport.dataQuality.findingCaps);
    const html = printableReport(enhancedReport);
    expect(csv).toContain("Confidence basis");
    expect(csv).toContain("Confirm persistence");
    expect(html).toContain("Investigation context");
    expect(html).toContain("Blocked sessions");
    expect(csv).toContain("6 additional WIA-WAIT findings were suppressed after retaining 24");
    expect(html).toContain("6 additional WIA-WAIT findings were suppressed after retaining 24");
    expect(validateReport(JSON.parse(JSON.stringify(enhancedReport))).findings[0].timeline?.points).toHaveLength(2);
    expect(validateReport(JSON.parse(JSON.stringify(report))).findings[0].timeline).toBeUndefined();
    const tooManyPoints = Array.from({ length: 73 }, (_, index) => ({ capturedAt: new Date(index * 1_000).toISOString(), value: index }));
    expect(() => validateReport({ ...enhancedReport, findings: [{ ...enhancedReport.findings[0], timeline: { ...enhancedReport.findings[0].timeline!, points: tooManyPoints } }] })).toThrow(/compatible/);
  });

  it("does not emit active-content reference links in printable reports", () => {
    const unsafe = { ...report, findings: [{ ...report.findings[0], references: [{ label: "Unsafe", url: "javascript:alert(1)" }] }] };
    expect(printableReport(unsafe)).not.toContain('href="javascript:');
  });

  it("neutralizes spreadsheet formulas from imported report fields", () => {
    const formulaFinding = { ...report.findings[0], title: "=2+2", summary: "+SUM(1,1)", category: "@external" };
    const csv = findingsCsv([formulaFinding], [{ ruleId: "=CAP", retainedCount: 1, suppressedCount: 1, order: "Descending diagnostic impact" }]);
    expect(csv).toContain("'=2+2");
    expect(csv).toContain("'+SUM(1,1)");
    expect(csv).toContain("'@external");
    expect(csv).toContain("'=CAP findings truncated");
  });

  it("rejects nonsensical finding-cap metadata in imported reports", () => {
    const withCap = (retainedCount: number, suppressedCount: number) => ({
      ...report,
      dataQuality: { ...report.dataQuality, findingCaps: [{ ruleId: "WIA-WAIT", retainedCount, suppressedCount, order: "Descending diagnostic impact" }] },
    });
    expect(() => validateReport(withCap(-1, 2))).toThrow(/compatible/);
    expect(() => validateReport(withCap(2.5, 2))).toThrow(/compatible/);
    expect(() => validateReport(withCap(2, 0))).toThrow(/compatible/);
    expect(() => validateReport(withCap(Number.MAX_SAFE_INTEGER + 1, 2))).toThrow(/compatible/);
  });
});
