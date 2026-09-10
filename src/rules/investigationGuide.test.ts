import { describe, expect, it } from "vitest";
import type { Finding, WhoIsActiveRecord } from "../types";
import { composeInvestigationGuide, composeInvestigationGuideSafely } from "./investigationGuide";

function record(id: string, requestId: number, startTime: string, durationSeconds: number): WhoIsActiveRecord {
  return {
    id,
    sourceId: "capture",
    rowNumber: requestId + 2,
    sessionId: 51,
    requestId,
    collectionTime: "2026-08-22T12:00:00Z",
    startTime,
    loginTime: null,
    durationSeconds,
    wait: null,
    status: requestId === 0 ? "suspended" : "running",
    blockingSessionId: null,
    blockedSessionCount: null,
    openTranCount: null,
    implicitTran: null,
    cpuMs: requestId === 0 ? 10_000 : 50,
    reads: null,
    writes: null,
    physicalReads: null,
    usedMemoryPages: null,
    tempdbAllocationPages: null,
    tempdbCurrentPages: null,
    sqlText: null,
    sqlCommand: null,
    queryPlanXml: null,
    databaseName: null,
    loginName: null,
    hostName: null,
    programName: null,
    original: { session_id: 51, request_id: requestId, start_time: startTime },
  };
}

function finding(id: string, recordId: string): Finding {
  return {
    id,
    ruleId: "WIA-RESOURCE",
    severity: "High",
    confidence: "Medium",
    category: "Resource usage",
    title: `Resource finding ${id}`,
    summary: "A resource concern was observed.",
    explanation: "Test evidence.",
    remediation: [],
    evidence: [],
    references: [],
    affectedRecordIds: [recordId],
    affectedPlanIds: [],
    impact: 1,
  };
}

describe("investigation guide composer", () => {
  it("keeps reused session IDs separated by request episode", () => {
    const records = [
      record("request-0", 0, "2026-08-22T10:00:00Z", 7_200),
      record("request-1", 1, "2026-08-22T11:59:00Z", 60),
    ];
    const guide = composeInvestigationGuide({ records, findings: [finding("finding-0", "request-0"), finding("finding-1", "request-1")] });

    expect(guide.subjects).toHaveLength(2);
    expect(guide.subjects.map((subject) => [subject.requestId, subject.durationSeconds, subject.lastStatus])).toEqual([
      [0, 7_200, "suspended"],
      [1, 60, "running"],
    ]);
    expect(new Set(guide.subjects.map((subject) => subject.id)).size).toBe(2);
  });

  it("does not lead the summary with non-blocking transaction activity that spans multiple transaction starts", () => {
    const resource = finding("resource", "request-0");
    const transaction: Finding = {
      ...finding("transaction", "request-0"),
      ruleId: "WIA-TRANSACTION",
      category: "Transactions",
      title: "Session 51 has open-transaction activity",
      evidence: [
        { label: "Distinct transaction starts", value: "105" },
        { label: "Head blocker", value: "No" },
      ],
    };

    const guide = composeInvestigationGuide({ records: [record("request-0", 0, "2026-08-22T10:00:00Z", 7_200)], findings: [transaction, resource] });

    expect(guide.conclusion).toContain(`Priority review: ${resource.title}; ${transaction.title}.`);
    expect(transaction.severity).toBe("High");
  });

  it("preserves priority order when one transaction start was observed", () => {
    const resource = finding("resource", "request-0");
    const transaction: Finding = {
      ...finding("transaction", "request-0"),
      ruleId: "WIA-TRANSACTION",
      category: "Transactions",
      title: "Session 51 has open-transaction activity",
      evidence: [
        { label: "Distinct transaction starts", value: "1" },
        { label: "Head blocker", value: "No" },
      ],
    };

    const guide = composeInvestigationGuide({ records: [record("request-0", 0, "2026-08-22T10:00:00Z", 7_200)], findings: [transaction, resource] });

    expect(guide.conclusion).toContain(`Priority review: ${transaction.title}; ${resource.title}.`);
  });

  it("returns limited guidance without changing findings when composition fails", () => {
    const findings = [finding("finding-0", "request-0")];
    const guide = composeInvestigationGuideSafely({ records: null, findings } as unknown as Parameters<typeof composeInvestigationGuideSafely>[0]);

    expect(guide.steps).toEqual([]);
    expect(guide.conclusion).toMatch(/underlying findings remain available and unchanged/i);
    expect(findings[0].severity).toBe("High");
  });
});
