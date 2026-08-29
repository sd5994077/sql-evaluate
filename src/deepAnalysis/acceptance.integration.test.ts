import { File } from "node:buffer";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AnalysisReport, Finding, WhoIsActiveRecord } from "../types";
import { addEvidenceFiles, createCpuBlockingCase } from "./case";

function activity(id: string, sessionId: number, blockingSessionId: number | null, status: string, openTranCount: number, waitType: string | null, waitMs: number | null): WhoIsActiveRecord {
  return {
    id, sourceId: "wia", rowNumber: Number(id.replace(/\D/g, "")) || 1, sessionId, requestId: 0,
    collectionTime: "2026-08-28T12:00:02Z", startTime: "2026-08-28T11:55:00Z", loginTime: "2026-08-28T11:00:00Z",
    durationSeconds: 302, wait: waitType ? { type: waitType, durationMs: waitMs, category: "Locking" } : null,
    status, blockingSessionId, blockedSessionCount: null, openTranCount, implicitTran: false,
    cpuMs: 1000, reads: 100, writes: 10, physicalReads: 0, usedMemoryPages: 64, tempdbAllocationPages: 0, tempdbCurrentPages: 0,
    sqlText: sessionId >= 301 ? "INSERT INTO Training.DecisionTreeTrav VALUES (...)" : "EXEC Training.RootWork",
    sqlCommand: null, queryPlanXml: null, databaseName: "Training", loginName: "test", hostName: "fixture", programName: "fixture",
    original: sessionId === 104 ? { plan_handle: "0xABCD", sql_handle: "0xDCBA", query_hash: "0x1111", query_plan_hash: "0x2222", database_id: 5, transaction_id: 90001 } : {},
  };
}

const records = [
  activity("r104", 104, null, "runnable", 2, null, null),
  activity("r236", 236, 104, "suspended", 1, "LCK_M_IX", 780),
  activity("r301", 301, 236, "suspended", 1, "LCK_M_IX", 688),
  activity("r302", 302, 236, "suspended", 1, "LCK_M_IX", 710),
  activity("r303", 303, 236, "suspended", 1, "LCK_M_IX", 740),
  activity("r304", 304, 236, "suspended", 1, "LCK_M_IX", 760),
];

const finding: Finding = {
  id: "cpu-blocking-acceptance", ruleId: "WIA-BLOCKING", severity: "High", confidence: "High", category: "Blocking",
  title: "Session 104 is the root blocker", summary: "An intermediate blocker and four INSERT victims are visible.", explanation: "Fixture", remediation: [], evidence: [], references: [],
  affectedRecordIds: records.map((record) => record.id), affectedPlanIds: [], impact: 100, firstSeen: "2026-08-28T12:00:02Z", lastSeen: "2026-08-28T12:00:02Z",
  blockingContext: {
    headBlockerSessionId: 104, blockedSessionIds: [236, 301, 302, 303, 304], totalBlockedSessions: 5, status: "runnable", databaseName: "Training", openTransactionCount: 2,
    commandLabel: "Current statement", commandPreview: "EXEC Training.RootWork", maxChainDepth: 2, chainComplete: true,
    participants: [
      { sessionId: 104, blockedBySessionId: null, role: "Root", status: "runnable", openTransactionCount: 2, waitType: null, waitDurationMs: null },
      { sessionId: 236, blockedBySessionId: 104, role: "Intermediate", status: "suspended", openTransactionCount: 1, waitType: "LCK_M_IX", waitDurationMs: 780 },
      ...[301, 302, 303, 304].map((sessionId) => ({ sessionId, blockedBySessionId: 236, role: "Victim" as const, status: "suspended", openTransactionCount: 1, waitType: "LCK_M_IX", waitDurationMs: 700 })),
    ],
  },
};

const report: AnalysisReport = {
  schemaVersion: "1.0", createdAt: "2026-08-28T12:00:10Z",
  inputs: [{ id: "wia", fileName: "synthetic-whoisactive.csv", size: 1, format: "csv", rowCount: records.length, recognizedColumns: ["session_id", "blocking_session_id", "open_tran_count", "status", "collection_time"], unknownColumns: ["plan_handle", "sql_handle", "query_hash"], warnings: [] }],
  records, plans: [], findings: [finding], dataQuality: { presentColumns: [], missingColumns: [], unknownColumns: [], warnings: [], notEvaluatedRules: [] }, redacted: false,
};

function fixture(name: string, type = "text/csv"): File {
  const path = fileURLToPath(new URL(`../../test-fixtures/deep-analysis-v2/${name}`, import.meta.url));
  return new File([readFileSync(path)], name, { type });
}

describe("CPU-backed blocking acceptance investigation", () => {
  it("moves only evidence-backed links through the staged investigation", async () => {
    let deepCase = createCpuBlockingCase(report, finding, "2026-08-28T12:00:10Z", "acceptance-case");
    expect(deepCase.assertions.find((item) => item.id === "blocking-chain")?.state).toBe("Observed");
    expect(deepCase.assertions.find((item) => item.id === "scheduler-pressure")?.state).toBe("Not Evaluated");
    expect(deepCase.assertions.find((item) => item.id === "causal-theory")?.state).toBe("Not Evaluated");

    deepCase = (await addEvidenceFiles(deepCase, [fixture("scheduler.csv"), fixture("locks.csv")], "2026-08-28T12:00:11Z")).deepCase;
    expect(deepCase.assertions.find((item) => item.id === "scheduler-pressure")?.state).toBe("Supported");
    expect(deepCase.assertions.find((item) => item.id === "root-lock-owner")?.state).toBe("Observed");
    expect(deepCase.assertions.find((item) => item.id === "causal-theory")?.state).toBe("Supported");

    deepCase = (await addEvidenceFiles(deepCase, [fixture("blitzcache.csv")], "2026-08-28T12:00:12Z")).deepCase;
    expect(deepCase.assertions.find((item) => item.id === "plan-cache-pressure")?.state).toBe("Supported");
    expect(deepCase.assertions.find((item) => item.id === "compilation-pressure")?.state).toBe("Supported");
    expect(deepCase.assertions.find((item) => item.id === "serialization")?.state).toBe("Supported");
    expect(deepCase.assertions.find((item) => item.id === "memory-grant-symptom")?.state).toBe("Supported");
    expect(deepCase.assertions.find((item) => item.id === "memory-grant-pressure")?.state).toBe("Not Evaluated");
    expect(deepCase.observations?.find((item) => item.metric === "total_plan_count")?.value).toBe(35600);

    deepCase = (await addEvidenceFiles(deepCase, [fixture("plan-lookup-null.csv")], "2026-08-28T12:00:13Z")).deepCase;
    expect(deepCase.assertions.find((item) => item.id === "plan-captured")?.state).toBe("Not Evaluated");
    expect(deepCase.captureAttempts?.filter((attempt) => attempt.outcome === "Returned null")).toHaveLength(1);

    deepCase = (await addEvidenceFiles(deepCase, [fixture("root-plan.sqlplan", "application/xml")], "2026-08-28T12:00:14Z")).deepCase;
    expect(deepCase.assertions.find((item) => item.id === "plan-captured")?.state).toBe("Observed");
    expect(deepCase.assertions.find((item) => item.id === "serialization")?.state).toBe("Observed");
    expect(deepCase.assertions.find((item) => item.id === "memory-grant-symptom")?.state).toBe("Observed");
    expect(deepCase.assertions.find((item) => item.id === "memory-grant-pressure")?.state).toBe("Not Evaluated");
    expect(deepCase.artifacts.find((item) => item.fileName === "root-plan.sqlplan")?.summary).toContain("TSQLUserDefinedFunctionsNotParallelizable");
    expect(deepCase.narrative?.headline).toContain("CPU-amplified blocking cascade");
    expect(deepCase.narrative?.nextCheck).not.toContain("stably matched root plan");
    expect(deepCase.narrative?.nextCheck).toContain("Repeat");
    expect(deepCase.captureAttempts?.some((attempt) => attempt.outcome === "Captured")).toBe(true);
  });

  it("produces the same conclusion regardless of evidence import order", async () => {
    const files = [fixture("scheduler.csv"), fixture("locks.csv"), fixture("blitzcache.csv"), fixture("plan-lookup-null.csv"), fixture("root-plan.sqlplan", "application/xml")];
    const forward = (await addEvidenceFiles(createCpuBlockingCase(report, finding, "2026-08-28T12:00:10Z", "forward"), files, "2026-08-28T12:00:11Z")).deepCase;
    const reverse = (await addEvidenceFiles(createCpuBlockingCase(report, finding, "2026-08-28T12:00:10Z", "reverse"), [...files].reverse(), "2026-08-28T12:00:11Z")).deepCase;
    const states = (value: typeof forward) => Object.fromEntries(value.assertions.map((item) => [item.id, item.state]));
    expect(states(reverse)).toEqual(states(forward));
    expect(reverse.narrative).toEqual(forward.narrative);
  });

  it("does not call a stably matched but untimestamped standalone plan incident-time observation", async () => {
    const planPath = fileURLToPath(new URL("../../test-fixtures/deep-analysis-v2/root-plan.sqlplan", import.meta.url));
    const untimestamped = readFileSync(planPath, "utf8").replace(/<!-- SQL_EVALUATE_CAPTURED_AT=.*?-->\s*/, "");
    const deepCase = createCpuBlockingCase(report, finding, "2026-08-28T12:00:10Z", "untimestamped");
    const evaluated = (await addEvidenceFiles(deepCase, [new File([untimestamped], "root-plan.sqlplan", { type: "application/xml" })], "2026-08-28T12:00:11Z")).deepCase;
    expect(evaluated.assertions.find((item) => item.id === "plan-captured")?.state).toBe("Supported");
    expect(evaluated.assertions.find((item) => item.id === "serialization")?.state).toBe("Supported");
  });

  it("does not attribute another BlitzCache row's query warnings to the root statement", async () => {
    const mixed = new File([
      [
        "captured_at,session_id,plan_handle,Warnings\n",
        "2026-08-28T12:00:02Z,104,0xABCD,\"\"\n",
        "2026-08-28T12:00:02Z,777,0x7777,\"Forced Serialization; Unused Memory Grant\"\n",
      ].join(""),
    ], "mixed-blitzcache.csv", { type: "text/csv" });
    const deepCase = createCpuBlockingCase(report, finding, "2026-08-28T12:00:10Z", "mixed-cache");
    const evaluated = (await addEvidenceFiles(deepCase, [mixed], "2026-08-28T12:00:11Z")).deepCase;

    expect(evaluated.assertions.find((item) => item.id === "serialization")?.state).toBe("Not Evaluated");
    expect(evaluated.assertions.find((item) => item.id === "memory-grant-symptom")?.state).toBe("Not Evaluated");
  });
});
