import { describe, expect, it } from "vitest";
import type { DeepAnalysisCase } from "./types";
import { createSpillTriageCase } from "./case";
import { deepCaseFindingsCsv, deepCaseJson, deepCasePrintableHtml, redactDeepCase } from "./report";
import { inspectSpillTriageMatrix } from "./spillTriage";

const sample = {
  schemaVersion: "1.1", id: "case", profileId: "cpu-backed-blocking", title: "Case", createdAt: "2026-08-28T00:00:00Z", updatedAt: "2026-08-28T00:00:00Z", sourceReportCreatedAt: "2026-08-28T00:00:00Z", sourceFileNames: ["Secret.xlsx"], rootSessionId: 104, rootIdentity: { sessionId: 104, planHandle: "0xSECRET" },
  sourceFinding: { id: "f", ruleId: "WIA-BLOCKING", severity: "High", confidence: "High", category: "Blocking", title: "Root", summary: "Summary", evidence: [], blockingContext: { headBlockerSessionId: 104, blockedSessionIds: [105], totalBlockedSessions: 1, status: "runnable", databaseName: "PrivateDb", openTransactionCount: 1, commandLabel: "SQL", commandPreview: "SELECT * FROM PrivateTable" } },
  assertions: [{ id: "a", label: "Test", statement: "Statement", state: "Observed", confidence: "High", basis: ["Basis"], missingEvidence: [], artifactIds: ["x"] }], collectionSteps: [],
  artifacts: [{ id: "x", fileName: "PrivatePlan.sqlplan", size: 1, sha256: "abc", importedAt: "2026-08-28T00:00:00Z", kind: "Execution plan", summary: "Summary", signals: [], identity: { planHandle: "0xSECRET" } }],
  observations: [{ id: "o", artifactId: "x", kind: "Plan", metric: "detail", value: 1, capturedAt: null, directness: "Direct", detail: "PrivateObject", identity: { planHandle: "0xSECRET" } }], events: [], sensitive: true,
} satisfies DeepAnalysisCase;

describe("Deep Analysis redacted reports", () => {
  it("removes source names, database, SQL text, handles, and evidence details", () => {
    const safe = JSON.stringify(redactDeepCase(sample));
    expect(safe).not.toContain("Secret.xlsx");
    expect(safe).not.toContain("PrivateDb");
    expect(safe).not.toContain("PrivateTable");
    expect(safe).not.toContain("0xSECRET");
    expect(safe).not.toContain("PrivateObject");
    expect(deepCaseJson(sample)).toContain("sql-evaluate-redacted-deep-analysis");
    expect(deepCaseJson(sample)).not.toContain("commandPreview");
    expect(deepCaseFindingsCsv(sample)).toContain("Test,Observed");
    expect(deepCasePrintableHtml(sample)).toContain("Redacted advisory report");
  });

  it("uses an allowlist for spill handoffs and neutralizes CSV formulas", () => {
    const secret = "SENTINEL_PRIVATE_8472";
    const deepCase = createSpillTriageCase("2026-09-02T00:00:00Z", "safe-handoff");
    const candidate = inspectSpillTriageMatrix([
      ["Total Spills", "Plan Handle", "Database", "Object", "Remove Plan Handle From Cache", `Unknown ${secret}`],
      [100, `0x${secret}`, secret, secret, `DBCC FREEPROCCACHE (${secret})`, secret],
    ], { artifactId: "artifact-safe", fileName: `${secret}.xlsx`, sheetName: secret }).candidates[0];
    candidate.rankReason = secret;
    candidate.warnings = [secret];
    candidate.embeddedPlanXml = `<ShowPlanXML>${secret}</ShowPlanXML>`;
    deepCase.artifacts = [{ id: "artifact-safe", fileName: `${secret}.xlsx`, size: 1, sha256: secret, importedAt: deepCase.createdAt, kind: "Plan cache", summary: secret, signals: ["spill-evidence"], warnings: [secret] }];
    deepCase.events = [{ occurredAt: deepCase.createdAt, type: "Evidence imported", summary: secret }];
    deepCase.spillTriage = {
      candidates: [candidate], selectedCandidateId: candidate.id, plans: [], manualPlanSelections: [],
      imports: [{ artifactId: "artifact-safe", fileName: `${secret}.xlsx`, sheetName: secret, headerRow: 1, ignoredSheets: [{ sheetName: secret, reason: secret }], importedRows: 1, rankableRows: 1, recognizedHeaders: [secret], unknownHeaders: [secret], warnings: [secret] }],
    };
    deepCase.assertions[0].label = "=SUM(1,1)";
    deepCase.assertions[0].basis = [`The source finding directly reports: ${secret}`];
    const json = deepCaseJson(deepCase);
    const csv = deepCaseFindingsCsv(deepCase);
    const html = deepCasePrintableHtml(deepCase);
    expect(`${json}${csv}${html}`).not.toContain(secret);
    expect(JSON.parse(json).spillTriage.candidates[0]).not.toHaveProperty("identity");
    expect(JSON.parse(json).spillTriage.candidates[0]).not.toHaveProperty("rawValue");
    expect(csv).toContain("'=SUM(1,1)");
  });
});
