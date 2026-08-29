import { File } from "node:buffer";
import { describe, expect, it } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { AnalysisReport, Finding } from "../types";
import { addEvidenceFiles, createCpuBlockingCase, createDeepAnalysisCase, createDeepCaseArchive, openDeepCaseArchive } from "./case";
import { cpuBlockingCollectionCommand, extendedEventsShowplanCommand, lastKnownActualPlanCommand, queryStoreExportCommand } from "./profile";

const blockingFinding: Finding = {
  id: "finding-block-104",
  ruleId: "WIA-BLOCKING",
  severity: "High",
  confidence: "High",
  category: "Blocking",
  title: "Session 104 is the root blocker",
  summary: "Four downstream sessions reported across a two-level chain.",
  explanation: "Blocking reduces concurrency.",
  remediation: [],
  evidence: [],
  references: [],
  affectedRecordIds: ["r104", "r236", "r301"],
  affectedPlanIds: [],
  impact: 100,
  blockingContext: {
    headBlockerSessionId: 104,
    blockedSessionIds: [236, 301, 302, 303],
    totalBlockedSessions: 4,
    status: "runnable",
    databaseName: "Epic",
    openTransactionCount: 2,
    commandLabel: "Current statement",
    commandPreview: "INSERT INTO Epic.DecisionTreeTrav ...",
    maxChainDepth: 2,
    chainComplete: true,
    participants: [
      { sessionId: 104, blockedBySessionId: null, role: "Root", status: "runnable", openTransactionCount: 2, waitType: null, waitDurationMs: null },
      { sessionId: 236, blockedBySessionId: 104, role: "Intermediate", status: "suspended", openTransactionCount: 1, waitType: "LCK_M_IX", waitDurationMs: 780 },
      { sessionId: 301, blockedBySessionId: 236, role: "Victim", status: "suspended", openTransactionCount: 1, waitType: "LCK_M_IX", waitDurationMs: 688 },
    ],
  },
};

const report: AnalysisReport = {
  schemaVersion: "1.0",
  createdAt: "2026-08-27T15:00:00Z",
  inputs: [{ id: "sample", fileName: "capture.xlsx", size: 100, format: "xlsx", rowCount: 3, recognizedColumns: ["session_id"], unknownColumns: [], warnings: [] }],
  records: [],
  plans: [],
  findings: [blockingFinding],
  dataQuality: { presentColumns: ["session_id"], missingColumns: [], unknownColumns: [], warnings: [], notEvaluatedRules: [] },
  redacted: false,
};

function withDeclaredUncompressedSize(bytes: Uint8Array, size: number): Uint8Array {
  const copy = new Uint8Array(bytes);
  const view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
  for (let offset = 0; offset <= copy.byteLength - 4; offset += 1) {
    const signature = view.getUint32(offset, true);
    if (signature === 0x04034b50 && offset + 26 <= copy.byteLength) view.setUint32(offset + 22, size, true);
    if (signature === 0x02014b50 && offset + 28 <= copy.byteLength) view.setUint32(offset + 24, size, true);
  }
  return copy;
}

describe("deep analysis cases", () => {
  it("generates a bounded read-only collection recipe for the selected root", () => {
    const command = cpuBlockingCollectionCommand(104);
    expect(command).toContain("DECLARE @TargetSessionId smallint = 104");
    expect(command).toContain("sys.dm_os_schedulers");
    expect(command).toContain("sys.dm_tran_locks");
    expect(command).toContain("WITH BlockingChain");
    expect(command).toContain("r.blocking_session_id = parent.session_id");
    expect(command).toContain("tl.request_session_id = chain.session_id");
    expect(command).toContain("sys.dm_exec_query_memory_grants");
    expect(command).not.toMatch(/\b(INSERT|UPDATE|DELETE|MERGE|EXEC|ALTER|CREATE|DROP|TRUNCATE|DBCC|KILL)\b/i);
    expect(lastKnownActualPlanCommand(104)).not.toMatch(/\b(INSERT|UPDATE|DELETE|MERGE|EXEC|ALTER|CREATE|DROP|TRUNCATE|DBCC|KILL)\b/i);
    expect(queryStoreExportCommand()).not.toMatch(/\b(INSERT|UPDATE|DELETE|MERGE|EXEC|ALTER|CREATE|DROP|TRUNCATE|DBCC|KILL)\b/i);
  });

  it("keeps the administrative Extended Events last resort explicit and self-cleaning", () => {
    const command = extendedEventsShowplanCommand("case-test");
    expect(command).toContain("ADMINISTRATIVE, NOT READ-ONLY");
    expect(command).toContain("query_post_execution_showplan");
    expect(command).toContain("STATE = STOP");
    expect(command).toContain("DROP EVENT SESSION");
    expect(command).toContain("max_file_size = 64");
    expect(command).not.toContain("@DatabaseId");
    expect(command).toContain("WHERE (sqlserver.database_id = 0)");
  });

  it("generates evidence commands that match the ready-profile adapters", () => {
    const sourceFinding = { ...blockingFinding, blockingContext: undefined, affectedRecordIds: [] };
    const worker = createDeepAnalysisCase(report, { ...sourceFinding, ruleId: "WIA-WORKER-EXHAUSTION" }, "2026-08-27T15:05:00Z", "worker-contract", "worker-exhaustion");
    const workerCommand = worker.collectionSteps[0].command;
    expect(workerCommand).toContain("'WORKER_COUNTERS' AS evidence_set");
    expect(workerCommand).toContain("active_worker_threads");
    expect(workerCommand).toContain("max_worker_threads");
    expect(workerCommand).toContain("work_queue_count");
    expect(workerCommand).toContain("WAITFOR DELAY");

    const compile = createDeepAnalysisCase(report, { ...sourceFinding, ruleId: "WIA-COMPILE-PRESSURE" }, "2026-08-27T15:05:00Z", "compile-contract", "compile-pressure");
    const compileCommand = compile.collectionSteps[0].command;
    expect(compileCommand).toContain("'COMPILATION_COUNTERS' AS evidence_set");
    expect(compileCommand).toContain("sample_id");
    expect(compileCommand).toContain("WAITFOR DELAY");
    expect(compileCommand).toContain("'PLAN_CACHE_INVENTORY' AS evidence_set");
    expect(compileCommand).toContain("single_use_plan_count");

    const actual = createDeepAnalysisCase(report, { ...sourceFinding, ruleId: "PLAN-RUNTIME-UNAVAILABLE" }, "2026-08-27T15:05:00Z", "actual-contract", "actual-plan");
    expect(actual.collectionSteps.some((step) => step.command.includes("sys.dm_exec_query_plan_stats"))).toBe(true);
    expect(actual.collectionSteps.some((step) => step.requiresApproval && step.command.includes("Include Actual Execution Plan"))).toBe(true);
  });

  it("starts a CPU-backed blocking case without overstating the causal theory", () => {
    const deepCase = createCpuBlockingCase(report, blockingFinding, "2026-08-27T15:05:00Z", "case-test");

    expect(deepCase.id).toBe("case-test");
    expect(deepCase.rootSessionId).toBe(104);
    expect(deepCase.rootIdentity?.transactionId).toBeNull();
    expect(deepCase.rootIdentity?.statementStartOffset).toBeNull();
    expect(deepCase.assertions.find((item) => item.id === "blocking-chain")?.state).toBe("Observed");
    expect(deepCase.assertions.find((item) => item.id === "root-runnable")?.state).toBe("Observed");
    expect(deepCase.assertions.find((item) => item.id === "open-transactions")?.state).toBe("Observed");
    expect(deepCase.assertions.find((item) => item.id === "scheduler-pressure")?.state).toBe("Not Evaluated");
    expect(deepCase.assertions.find((item) => item.id === "causal-theory")?.state).toBe("Not Evaluated");
  });

  it("updates only the assertions supported by imported scheduler, lock, and cache evidence", async () => {
    const deepCase = createCpuBlockingCase(report, blockingFinding, "2026-08-27T15:05:00Z", "case-test");
    const scheduler = new File([
      "evidence_set,sample_id,captured_at,scheduler_id,runnable_tasks_count,work_queue_count\nSCHEDULERS,1,2026-08-27T15:05:01Z,0,7,0\nSCHEDULERS,2,2026-08-27T15:05:03Z,0,5,0\n",
    ], "scheduler.csv", { type: "text/csv" });
    const locks = new File([
      "evidence_set,captured_at,request_session_id,request_status,request_mode,resource_type,resource_database_id,resource_associated_entity_id\nLOCKS,2026-08-27T15:05:03Z,104,GRANT,IX,OBJECT,5,9001\nLOCKS,2026-08-27T15:05:03Z,301,WAIT,IX,OBJECT,5,9001\n",
    ], "locks.csv", { type: "text/csv" });
    const cache = new File([
      "Warnings,Query Plan\n\"Plan Cache Instability; Forced Serialization; Compilation Timeout; Unused Memory Grant; Filter UDF\",NULL\n",
    ], "blitz-cache.csv", { type: "text/csv" });

    const result = await addEvidenceFiles(deepCase, [scheduler, locks, cache], "2026-08-27T15:10:00Z");

    expect(result.deepCase.assertions.find((item) => item.id === "scheduler-pressure")?.state).toBe("Supported");
    expect(result.deepCase.assertions.find((item) => item.id === "root-lock-owner")?.state).toBe("Observed");
    expect(result.deepCase.assertions.find((item) => item.id === "plan-cache-pressure")?.state).toBe("Supported");
    expect(result.deepCase.assertions.find((item) => item.id === "plan-captured")?.state).toBe("Not Evaluated");
    expect(result.deepCase.assertions.find((item) => item.id === "causal-theory")?.state).toBe("Supported");
    expect(result.deepCase.artifacts).toHaveLength(3);
  });

  it("keeps the overall theory unresolved when imported locks conflict with a zero open-transaction capture", async () => {
    const zeroTransactionFinding: Finding = { ...blockingFinding, blockingContext: { ...blockingFinding.blockingContext!, openTransactionCount: 0 } };
    const deepCase = createCpuBlockingCase({ ...report, findings: [zeroTransactionFinding] }, zeroTransactionFinding, "2026-08-27T15:05:00Z", "case-conflict");
    const scheduler = new File(["scheduler_id,runnable_tasks_count,work_queue_count\n0,7,0\n"], "scheduler.csv", { type: "text/csv" });
    const locks = new File(["request_session_id,request_status,request_mode\n104,GRANT,IX\n"], "locks.csv", { type: "text/csv" });

    const result = await addEvidenceFiles(deepCase, [scheduler, locks], "2026-08-27T15:10:00Z");
    const theory = result.deepCase.assertions.find((item) => item.id === "causal-theory");

    expect(theory?.state).toBe("Not Evaluated");
    expect(theory?.basis.join(" ")).toContain("zero open transactions");
  });

  it("round-trips a sensitive working case with evidence and verified hashes", async () => {
    const deepCase = createCpuBlockingCase(report, blockingFinding, "2026-08-27T15:05:00Z", "case-test");
    const evidence = new File(["scheduler_id,runnable_tasks_count\n0,7\n"], "scheduler.csv", { type: "text/csv" });
    const evaluated = await addEvidenceFiles(deepCase, [evidence], "2026-08-27T15:10:00Z");
    const archive = await createDeepCaseArchive(evaluated.deepCase, [evidence], "2026-08-27T15:11:00Z");
    const archiveCopy = new Uint8Array(archive.bytes.byteLength);
    archiveCopy.set(archive.bytes);
    const reopened = await openDeepCaseArchive(new File([archiveCopy.buffer], archive.fileName, { type: "application/zip" }));

    expect(archive.fileName).toBe("SQL-Evaluate-Case_case-test.sqlevalcase.zip");
    expect(reopened.deepCase.id).toBe("case-test");
    expect(reopened.files).toHaveLength(1);
    expect(reopened.files[0].name).toBe("scheduler.csv");
    expect(reopened.deepCase.artifacts[0].sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("migrates a schema 1.0 working case when it is reopened", async () => {
    const current = createCpuBlockingCase(report, blockingFinding, "2026-08-27T15:05:00Z", "case-old");
    const oldCase = { ...current, schemaVersion: "1.0" as const, incidentWindow: undefined, rootIdentity: undefined, observations: undefined, captureAttempts: undefined, narrative: undefined };
    const archive = await createDeepCaseArchive(oldCase, [], "2026-08-27T15:11:00Z");
    const copy = new Uint8Array(archive.bytes.byteLength); copy.set(archive.bytes);
    const reopened = await openDeepCaseArchive(new File([copy.buffer], archive.fileName, { type: "application/zip" }));
    expect(reopened.deepCase.schemaVersion).toBe("1.1");
    expect(reopened.deepCase.rootIdentity?.sessionId).toBe(104);
    expect(reopened.deepCase.assertions.some((item) => item.id === "serialization")).toBe(true);
  });

  it("rejects a case whose evidence bytes no longer match the manifest", async () => {
    const deepCase = createCpuBlockingCase(report, blockingFinding, "2026-08-27T15:05:00Z", "case-tampered");
    const evidence = new File(["scheduler_id,runnable_tasks_count\n0,7\n"], "scheduler.csv", { type: "text/csv" });
    const evaluated = await addEvidenceFiles(deepCase, [evidence], "2026-08-27T15:10:00Z");
    const archive = await createDeepCaseArchive(evaluated.deepCase, [evidence], "2026-08-27T15:11:00Z");
    const entries = unzipSync(archive.bytes);
    const evidencePath = Object.keys(entries).find((path) => path.startsWith("evidence/"))!;
    entries[evidencePath] = new Uint8Array(entries[evidencePath].byteLength);
    const tamperedBytes = zipSync(entries);
    const copy = new Uint8Array(tamperedBytes.byteLength); copy.set(tamperedBytes);

    await expect(openDeepCaseArchive(new File([copy.buffer], archive.fileName, { type: "application/zip" }))).rejects.toThrow("hash verification failed");
  });

  it("rejects an archive whose declared expansion exceeds the safety limit before extraction", async () => {
    const deepCase = createCpuBlockingCase(report, blockingFinding, "2026-08-27T15:05:00Z", "case-expanded");
    const archive = await createDeepCaseArchive(deepCase, [], "2026-08-27T15:11:00Z");
    const forged = withDeclaredUncompressedSize(archive.bytes, 201 * 1024 * 1024);
    const forgedCopy = new Uint8Array(forged.byteLength); forgedCopy.set(forged);

    await expect(openDeepCaseArchive(new File([forgedCopy.buffer], archive.fileName, { type: "application/zip" }))).rejects.toThrow("expands beyond the 200 MB safety limit");
  });

  it("rejects a case whose derived case JSON no longer matches the manifest", async () => {
    const deepCase = createCpuBlockingCase(report, blockingFinding, "2026-08-27T15:05:00Z", "case-json-tampered");
    const archive = await createDeepCaseArchive(deepCase, [], "2026-08-27T15:11:00Z");
    const entries = unzipSync(archive.bytes);
    const manifest = JSON.parse(strFromU8(entries["manifest.json"])) as { casePath: string; caseSha256?: string };
    const caseJson = JSON.parse(strFromU8(entries[manifest.casePath])) as { assertions: Array<{ state: string }> };
    caseJson.assertions[0].state = "Contradicted";
    entries[manifest.casePath] = strToU8(JSON.stringify(caseJson));
    const tampered = zipSync(entries);
    const tamperedCopy = new Uint8Array(tampered.byteLength); tamperedCopy.set(tampered);

    await expect(openDeepCaseArchive(new File([tamperedCopy.buffer], archive.fileName, { type: "application/zip" }))).rejects.toThrow("case JSON hash verification failed");
  });

  it("re-derives legacy case signals from verified evidence instead of trusting stored derived state", async () => {
    const deepCase = createCpuBlockingCase(report, blockingFinding, "2026-08-27T15:05:00Z", "case-legacy-derived");
    const evidence = new File(["sample_id,captured_at,scheduler_id,runnable_tasks_count\n1,2026-08-27T15:05:01Z,0,7\n"], "scheduler.csv", { type: "text/csv" });
    const evaluated = await addEvidenceFiles(deepCase, [evidence], "2026-08-27T15:10:00Z");
    const archive = await createDeepCaseArchive(evaluated.deepCase, [evidence], "2026-08-27T15:11:00Z");
    const entries = unzipSync(archive.bytes);
    const manifest = JSON.parse(strFromU8(entries["manifest.json"])) as { casePath: string; caseSha256?: string };
    delete manifest.caseSha256;
    const caseJson = JSON.parse(strFromU8(entries[manifest.casePath])) as { artifacts: Array<{ signals: string[] }>; assertions: Array<{ id: string; state: string }> };
    caseJson.artifacts[0].signals.push("scheduler-pressure-sustained");
    caseJson.assertions.find((item) => item.id === "scheduler-pressure")!.state = "Supported";
    entries["manifest.json"] = strToU8(JSON.stringify(manifest));
    entries[manifest.casePath] = strToU8(JSON.stringify(caseJson));
    const legacy = zipSync(entries);
    const legacyCopy = new Uint8Array(legacy.byteLength); legacyCopy.set(legacy);
    const reopened = await openDeepCaseArchive(new File([legacyCopy.buffer], archive.fileName, { type: "application/zip" }));

    expect(reopened.deepCase.assertions.find((item) => item.id === "scheduler-pressure")?.state).toBe("Not Evaluated");
    expect(reopened.deepCase.artifacts[0].signals).not.toContain("scheduler-pressure-sustained");
  });
});
