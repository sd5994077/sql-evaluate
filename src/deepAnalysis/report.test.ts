import { describe, expect, it } from "vitest";
import type { DeepAnalysisCase } from "./types";
import { deepCaseFindingsCsv, deepCaseJson, deepCasePrintableHtml, redactDeepCase } from "./report";

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
    expect(deepCaseJson(sample)).toContain("[redacted command preview]");
    expect(deepCaseFindingsCsv(sample)).toContain("Test,Observed");
    expect(deepCasePrintableHtml(sample)).toContain("Redacted advisory report");
  });
});
