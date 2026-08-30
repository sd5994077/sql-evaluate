import { describe, expect, it } from "vitest";
import type { AnalysisInput, ThresholdProfile, WhoIsActiveRecord } from "../types";
import { normalizeRows } from "../lib/normalize";
import { parseShowplan } from "../lib/showplan";
import { deepAnalysisProfileForFinding } from "../deepAnalysis/profile";
import { analyze } from "./engine";
import { createThresholdProfileSnapshot, DEFAULT_THRESHOLD_PROFILE, DEFAULT_THRESHOLD_PROFILE_SNAPSHOT } from "./thresholdProfiles";

const input: AnalysisInput = { id: "sample", fileName: "sample.csv", size: 100, format: "csv", rowCount: 0, recognizedColumns: ["session_id", "blocking_session_id", "blocked_session_count", "collection_time", "start_time", "status", "open_tran_count", "wait_info", "CPU", "reads"], unknownColumns: [], warnings: [] };

function records(): WhoIsActiveRecord[] {
  const headers = input.recognizedColumns;
  return normalizeRows("sample", [headers,
    [51, null, 6, "2026-08-22T12:00:00Z", "2026-08-22T11:40:00Z", "sleeping", 1, "(9ms)WAITFOR", 100, 100],
    [52, 51, 0, "2026-08-22T12:00:00Z", "2026-08-22T11:59:30Z", "suspended", 1, "(2000ms)LCK_M_X", 10, 20],
    [52, 51, 0, "2026-08-22T12:01:10Z", "2026-08-22T11:59:30Z", "suspended", 1, "(2200ms)LCK_M_X", 12, 30],
  ], 0);
}

describe("diagnostic engine", () => {
  it("keeps large same-capture grouping within a linear-time budget", () => {
    const headers = ["session_id", "collection_time", "open_tran_count", "status", "dd hh:mm:ss.mss"];
    const rowCount = 20_000;
    const rows = [headers, ...Array.from({ length: rowCount }, (_, index) => [index + 1, "2026-08-22T12:00:00Z", 1, "sleeping", "00 00:00:00.000"])];
    const source: AnalysisInput = { id: "large", fileName: "large.csv", size: 1_000_000, format: "csv", rowCount, recognizedColumns: headers, unknownColumns: [], warnings: [] };
    const normalized = normalizeRows(source.id, rows, 0);
    const startedAt = performance.now();
    const report = analyze([source], normalized, []);
    expect(performance.now() - startedAt).toBeLessThan(2_000);
    expect(report.records).toHaveLength(rowCount);
  }, 10_000);

  it("elevates a persistent sleeping head blocker", () => {
    const report = analyze([{ ...input, rowCount: 3 }], records(), []);
    const blocking = report.findings.find((finding) => finding.ruleId === "WIA-BLOCKING");
    expect(blocking?.severity).toBe("High");
    expect(blocking?.summary).toMatch(/6 downstream/);
  });

  it("keeps WAITFOR informational when isolated", () => {
    const report = analyze([{ ...input, rowCount: 3 }], records(), []);
    const wait = report.findings.find((finding) => finding.title.includes("WAITFOR"));
    expect(wait?.severity).toBe("Informational");
  });

  it("marks plan analysis unavailable without failing activity checks", () => {
    const report = analyze([{ ...input, rowCount: 3 }], records(), []);
    expect(report.findings.some((finding) => finding.ruleId === "PLAN-UNAVAILABLE" && finding.severity === "Not Evaluated")).toBe(true);
    expect(report.findings.some((finding) => finding.ruleId === "WIA-BLOCKING")).toBe(true);
    expect(report.findings.find((finding) => finding.ruleId === "PLAN-UNAVAILABLE")?.relatedFindings).toEqual([]);
  });

  it("evaluates scheduler-pressure availability only when scheduler counters were imported", () => {
    const headers = ["session_id", "collection_time", "start_time"];
    const source: AnalysisInput = { id: "limited", fileName: "limited.csv", size: 100, format: "csv", rowCount: 1, recognizedColumns: headers, unknownColumns: [], warnings: [] };
    const normalized = normalizeRows(source.id, [headers, [51, "2026-08-22T12:00:00Z", "2026-08-22T11:59:00Z"]], 0);

    const withoutCounters = analyze([source], normalized, []);
    expect(withoutCounters.dataQuality.notEvaluatedRules).not.toContain("CPU and scheduler pressure");

    const withCounters = analyze([source], normalized, [], DEFAULT_THRESHOLD_PROFILE_SNAPSHOT, [{ id: "scheduler", sourceId: "scheduler", fileName: "scheduler.csv", kind: "Scheduler counters", samples: [], rowCount: 0 }]);
    expect(withCounters.dataQuality.notEvaluatedRules).toContain("CPU and scheduler pressure");
  });

  it("orders confidence High, Medium, then Low within the same severity", () => {
    const report = analyze([{ ...input, rowCount: 3 }], records(), []);
    const highFindings = report.findings.filter((finding) => finding.severity === "High");
    const confidences = highFindings.map((finding) => finding.confidence);
    expect(confidences).toEqual([...confidences].sort((a, b) => ({ High: 3, Medium: 2, Low: 1 })[b] - ({ High: 3, Medium: 2, Low: 1 })[a]));
  });

  it("counts concurrent victims when blocked_session_count is absent", () => {
    const headers = ["session_id", "blocking_session_id", "collection_time"];
    const rows = [headers, [51, null, "2026-08-22T12:00:00Z"], ...[52, 53, 54, 55, 56].map((session) => [session, 51, "2026-08-22T12:00:00Z"] )];
    const source: AnalysisInput = { id: "blocking", fileName: "blocking.csv", size: 100, format: "csv", rowCount: 6, recognizedColumns: headers, unknownColumns: [], warnings: [] };
    const report = analyze([source], normalizeRows(source.id, rows, 0), []);
    const blocking = report.findings.find((finding) => finding.ruleId === "WIA-BLOCKING");
    expect(blocking?.severity).toBe("High");
    expect(blocking?.summary).toMatch(/5 downstream/);
  });

  it("uses one supplied profile for rule decisions and persists that exact snapshot", async () => {
    const headers = ["session_id", "blocking_session_id", "collection_time"];
    const rows = [headers, [51, null, "2026-08-22T12:00:00Z"], ...[52, 53, 54, 55, 56].map((session) => [session, 51, "2026-08-22T12:00:00Z"] )];
    const source: AnalysisInput = { id: "profile-blocking", fileName: "profile-blocking.csv", size: 100, format: "csv", rowCount: 6, recognizedColumns: headers, unknownColumns: [], warnings: [] };
    const normalized = normalizeRows(source.id, rows, 0);
    const defaultReport = analyze([source], normalized, []);
    const custom = structuredClone(DEFAULT_THRESHOLD_PROFILE) as ThresholdProfile;
    custom.id = "dba.blocking-six";
    custom.name = "DBA blocking six";
    custom.thresholds.blocking.highVictims = 6;
    const customSnapshot = await createThresholdProfileSnapshot(custom);
    const customReport = analyze([source], normalized, [], customSnapshot);

    expect(defaultReport.thresholdProfile).toEqual(DEFAULT_THRESHOLD_PROFILE_SNAPSHOT);
    expect(defaultReport.findings.find((finding) => finding.ruleId === "WIA-BLOCKING")?.severity).toBe("High");
    expect(customReport.thresholdProfile).toEqual(customSnapshot);
    expect(customReport.findings.find((finding) => finding.ruleId === "WIA-BLOCKING")?.severity).toBe("Medium");
    const withoutBlocking = (report: typeof defaultReport) => report.findings
      .filter((finding) => finding.ruleId !== "WIA-BLOCKING")
      .map(({ ruleId, severity, confidence, title }) => ({ ruleId, severity, confidence, title }))
      .sort((left, right) => left.ruleId.localeCompare(right.ruleId));
    expect(withoutBlocking(customReport)).toEqual(withoutBlocking(defaultReport));
  });

  it("builds one blocking incident from the true root and labels intermediate blockers", () => {
    const headers = ["session_id", "blocking_session_id", "blocked_session_count", "collection_time", "status", "open_tran_count", "wait_info", "sql_text"];
    const rows = [headers,
      [67, null, 3, "2026-08-22T12:00:00Z", "runnable", 1, null, "UPDATE dbo.Parent SET Value = 1"],
      [61, 67, 2, "2026-08-22T12:00:00Z", "suspended", 2, "(2000ms)LCK_M_X", "UPDATE dbo.Child SET Value = 2"],
      [74, 61, 1, "2026-08-22T12:00:00Z", "suspended", 1, "(1800ms)LCK_M_X", "UPDATE dbo.Leaf SET Value = 3"],
      [90, 74, 0, "2026-08-22T12:00:00Z", "suspended", 0, "(1600ms)LCK_M_S", "SELECT Value FROM dbo.Leaf"],
    ];
    const source: AnalysisInput = { id: "chain", fileName: "chain.csv", size: 100, format: "csv", rowCount: 4, recognizedColumns: headers, unknownColumns: [], warnings: [] };
    const blockingFindings = analyze([source], normalizeRows(source.id, rows, 0), []).findings.filter((finding) => finding.ruleId === "WIA-BLOCKING");
    expect(blockingFindings).toHaveLength(1);
    expect(blockingFindings[0].title).toBe("Session 67 is the root blocker");
    expect(blockingFindings[0].blockingContext?.participants).toEqual([
      expect.objectContaining({ sessionId: 67, role: "Root", blockedBySessionId: null }),
      expect.objectContaining({ sessionId: 61, role: "Intermediate", blockedBySessionId: 67 }),
      expect.objectContaining({ sessionId: 74, role: "Intermediate", blockedBySessionId: 61 }),
      expect.objectContaining({ sessionId: 90, role: "Victim", blockedBySessionId: 74 }),
    ]);
    expect(blockingFindings[0].blockingContext?.maxChainDepth).toBe(3);
    expect(blockingFindings[0].diagnosticTools?.map((tool) => tool.name)).not.toContain("sp_WhoIsActive");
    expect(blockingFindings[0].remediation.join(" ")).toMatch(/runnable root blocker/i);
  });

  it("keeps blocker context to five victim SPIDs and labels sleeping-session command text accurately", () => {
    const headers = ["session_id", "blocking_session_id", "blocked_session_count", "collection_time", "status", "open_tran_count", "database_name", "sql_text", "sql_command", "wait_info"];
    const rows: unknown[][] = [headers,
      [55, null, 14, "2026-08-22T12:00:00Z", "sleeping", 1, "SalesDb", null, "UPDATE dbo.Orders\nSET Status = @Status WHERE OrderId = @OrderId", null],
      ...[62, 63, 64, 65, 66, 67].map((sessionId, index) => [sessionId, 55, 0, "2026-08-22T12:00:00Z", "suspended", 0, "SalesDb", "SELECT 1", null, `(${71_000 - index * 1_000}ms)LCK_M_S`]),
    ];
    const source: AnalysisInput = { id: "context", fileName: "context.csv", size: 100, format: "csv", rowCount: rows.length - 1, recognizedColumns: headers, unknownColumns: [], warnings: [] };
    const blocking = analyze([source], normalizeRows(source.id, rows, 0), []).findings.find((finding) => finding.ruleId === "WIA-BLOCKING");
    expect(blocking?.blockingContext).toMatchObject({ headBlockerSessionId: 55, blockedSessionIds: [62, 63, 64, 65, 66], totalBlockedSessions: 14, status: "sleeping", databaseName: "SalesDb", openTransactionCount: 1, commandLabel: "Last / outer command" });
    expect(blocking?.blockingContext?.commandPreview).toBe("UPDATE dbo.Orders SET Status = @Status WHERE OrderId = @OrderId");
  });

  it("adds confidence, timelines, capture recipes, and deterministic related signals", () => {
    const report = analyze([{ ...input, rowCount: 3 }], records(), []);
    const blocking = report.findings.find((finding) => finding.ruleId === "WIA-BLOCKING")!;
    const lockWait = report.findings.find((finding) => finding.ruleId === "WIA-WAIT" && finding.title.includes("LCK_M_X"))!;
    const transaction = report.findings.find((finding) => finding.ruleId === "WIA-TRANSACTION" && finding.title.includes("51"))!;
    expect(blocking.confidenceReason).toMatch(/blocker row/i);
    expect(blocking.timeline).toMatchObject({ metric: "Blocked sessions", unit: "sessions", direction: "Decreasing", firstValue: 6, latestValue: 1, peakValue: 6 });
    expect(blocking.nextCapture?.command).toContain("@get_locks = 1");
    expect(blocking.nextCapture?.expectedEvidence).toContain("Transaction age and open-transaction state");
    expect(blocking.relatedFindings?.map((link) => link.findingId)).toContain(lockWait.id);
    expect(blocking.relatedFindings?.map((link) => link.findingId)).toContain(transaction.id);
    expect(lockWait.timeline?.unit).toBe("milliseconds");
    expect(lockWait.nextCapture?.command).toContain("@get_transaction_info = 1");
    expect(transaction.timeline?.metric).toBe("Request age proxy");
    expect(report.findings.every((finding) => (finding.relatedFindings?.length ?? 0) <= 5)).toBe(true);
  });

  it("sorts and limits a long activity timeline to the latest 72 capture points", () => {
    const headers = ["session_id", "collection_time", "wait_info"];
    const rows: unknown[][] = [headers];
    for (let index = 0; index < 80; index += 1) rows.push([75, new Date(Date.UTC(2026, 7, 22, 12, index)).toISOString(), `(${1_000 + index}ms)PAGEIOLATCH_SH`]);
    const source: AnalysisInput = { id: "timeline", fileName: "timeline.csv", size: 100, format: "csv", rowCount: 80, recognizedColumns: headers, unknownColumns: [], warnings: [] };
    const wait = analyze([source], normalizeRows(source.id, rows, 0), []).findings.find((finding) => finding.ruleId === "WIA-WAIT")!;
    expect(wait.timeline?.points).toHaveLength(72);
    expect(wait.timeline?.points[0].value).toBe(1_008);
    expect(wait.timeline?.points.at(-1)?.value).toBe(1_079);
    expect(wait.timeline?.direction).toBe("Increasing");
  });

  it("uses transaction start time for the transaction timeline without changing request-age severity logic", () => {
    const headers = ["session_id", "collection_time", "start_time", "tran_start_time", "open_tran_count"];
    const rows = [headers,
      [88, "2026-08-22T12:00:00Z", "2026-08-22T11:59:00Z", "2026-08-22T11:50:00Z", 1],
      [88, "2026-08-22T12:02:00Z", "2026-08-22T11:59:00Z", "2026-08-22T11:50:00Z", 1],
    ];
    const source: AnalysisInput = { id: "transactions", fileName: "transactions.csv", size: 100, format: "csv", rowCount: 2, recognizedColumns: headers, unknownColumns: [], warnings: [] };
    const transaction = analyze([source], normalizeRows(source.id, rows, 0), []).findings.find((finding) => finding.ruleId === "WIA-TRANSACTION")!;
    expect(transaction.timeline).toMatchObject({ metric: "Transaction age", firstValue: 600, latestValue: 720, direction: "Increasing" });
    expect(transaction.limitations?.join(" ")).not.toMatch(/proxy/i);
  });

  it("explains estimated-plan limitations without inventing a runtime timeline", () => {
    const xml = `<ShowPlanXML Version="1.6" xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan"><BatchSequence><Batch><Statements><StmtSimple StatementText="SELECT 1" StatementType="SELECT"><QueryPlan><RelOp NodeId="0" PhysicalOp="Constant Scan" LogicalOp="Constant Scan" EstimateRows="1" /></QueryPlan></StmtSimple></Statements></Batch></BatchSequence></ShowPlanXML>`;
    const source: AnalysisInput = { id: "plan", fileName: "estimated.sqlplan", size: xml.length, format: "sqlplan", rowCount: 0, recognizedColumns: [], unknownColumns: [], warnings: [] };
    const finding = analyze([source], [], [parseShowplan(xml, source.id, source.fileName)]).findings.find((item) => item.ruleId === "PLAN-RUNTIME-UNAVAILABLE")!;
    expect(finding.confidenceReason).toMatch(/no runtime counters/i);
    expect(finding.timeline).toBeUndefined();
    expect(finding.nextCapture).toMatchObject({ title: "Capture a representative actual plan", command: undefined });
  });

  it("adds ordered same-statement compile context without changing findings or grades", () => {
    const xml = `<ShowPlanXML Version="1.6" xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan"><BatchSequence><Batch><Statements><StmtSimple StatementText="SELECT 1" StatementType="SELECT" StatementOptmEarlyAbortReason="TimeOut" StatementOptmLevel="FULL&lt;unsafe"><QueryPlan CompileTime="45" CompileCPU="40" CompileMemory="4096"><RelOp NodeId="0" PhysicalOp="Constant Scan" LogicalOp="Constant Scan" EstimateRows="1" /></QueryPlan></StmtSimple></Statements></Batch></BatchSequence></ShowPlanXML>`;
    const withoutContext = xml.replace(' StatementOptmEarlyAbortReason="TimeOut" StatementOptmLevel="FULL&lt;unsafe"', "").replace(' CompileTime="45" CompileCPU="40" CompileMemory="4096"', "");
    const source: AnalysisInput = { id: "qualified-plan", fileName: "qualified.sqlplan", size: xml.length, format: "sqlplan", rowCount: 0, recognizedColumns: [], unknownColumns: [], warnings: [] };
    const qualified = analyze([source], [], [parseShowplan(xml, source.id, source.fileName)]);
    const baseline = analyze([source], [], [parseShowplan(withoutContext, source.id, source.fileName)]);
    expect(qualified.findings.map((item) => [item.ruleId, item.severity, item.confidence])).toEqual(baseline.findings.map((item) => [item.ruleId, item.severity, item.confidence]));
    const finding = qualified.findings.find((item) => item.ruleId === "PLAN-RUNTIME-UNAVAILABLE")!;
    expect(finding.qualifications?.map((item) => [item.kind, item.disposition, item.value])).toEqual([
      ["Compile time", "Context only", "45 ms"],
      ["Compile CPU", "Context only", "40 ms"],
      ["Compile memory", "Context only", "4096 KB"],
      ["Optimizer early abort", "Observed", "TimeOut"],
      ["Optimization level", "Observed", "[redacted optimizer value]"],
    ]);
    expect(finding.qualifications?.every((item) => item.planId === qualified.plans[0].id && item.statementId === qualified.plans[0].statements[0].id)).toBe(true);
    expect(finding.limitations?.join(" ")).toMatch(/causal significance.*not evaluated/i);
    expect(deepAnalysisProfileForFinding(finding)).toBe("actual-plan");
  });

  it("keeps compile qualifications on the embedded plan finding instead of copying them to activity", () => {
    const xml = `<ShowPlanXML Version="1.6" xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan"><BatchSequence><Batch><Statements><StmtSimple StatementText="SELECT 1" StatementType="SELECT" StatementOptmLevel="FULL"><QueryPlan CompileTime="5"><RelOp NodeId="0" PhysicalOp="Constant Scan" LogicalOp="Constant Scan" /></QueryPlan></StmtSimple></Statements></Batch></BatchSequence></ShowPlanXML>`;
    const headers = ["session_id", "collection_time", "start_time", "open_tran_count", "query_plan"];
    const source: AnalysisInput = { id: "embedded-qualified", fileName: "capture.csv", size: xml.length, format: "csv", rowCount: 1, recognizedColumns: headers, unknownColumns: [], warnings: [] };
    const report = analyze([source], normalizeRows(source.id, [headers, [51, "2026-08-22T12:00:00Z", "2026-08-22T11:50:00Z", 1, xml]], 0), []);
    const activity = report.findings.find((item) => item.ruleId === "WIA-TRANSACTION")!;
    const plan = report.findings.find((item) => item.ruleId === "PLAN-RUNTIME-UNAVAILABLE")!;
    expect(activity.qualifications).toBeUndefined();
    expect(plan.qualifications?.map((item) => item.kind)).toEqual(["Compile time", "Optimization level"]);
    expect(activity.relatedFindings?.some((link) => link.findingId === plan.id && /embedded plan/i.test(link.reason))).toBe(true);
    expect(plan.relatedFindings?.some((link) => link.findingId === activity.id && /embedded plan/i.test(link.reason))).toBe(true);
  });

  it("ranks resource use against peers in the same capture point", () => {
    const headers = ["session_id", "collection_time", "start_time", "CPU"];
    const rows: unknown[][] = [headers, [51, "2026-08-22T12:00:00Z", "2026-08-22T11:50:00Z", 100]];
    for (let session = 100; session < 200; session += 1) rows.push([session, "2026-08-22T12:00:00Z", "2026-08-22T11:59:00Z", 1]);
    rows.push([51, "2026-08-22T12:01:00Z", "2026-08-22T11:50:00Z", 100]);
    for (let session = 200; session < 209; session += 1) rows.push([session, "2026-08-22T12:01:00Z", "2026-08-22T11:59:00Z", 1000]);
    const source: AnalysisInput = { id: "resources", fileName: "resources.csv", size: 100, format: "csv", rowCount: rows.length - 1, recognizedColumns: headers, unknownColumns: [], warnings: [] };
    const report = analyze([source], normalizeRows(source.id, rows, 0), []);
    expect(report.findings.some((finding) => finding.ruleId === "WIA-RESOURCE" && finding.title.includes("51"))).toBe(false);
  });

  it("does not treat reused blocker session IDs across capture gaps as continuous blocking", () => {
    const headers = ["session_id", "blocking_session_id", "collection_time"];
    const rows = [headers,
      [52, 51, "2026-08-22T12:00:00Z"],
      [80, null, "2026-08-22T12:01:00Z"],
      [53, 51, "2026-08-22T13:00:00Z"],
    ];
    const source: AnalysisInput = { id: "gaps", fileName: "gaps.csv", size: 100, format: "csv", rowCount: 3, recognizedColumns: headers, unknownColumns: [], warnings: [] };
    const findings = analyze([source], normalizeRows(source.id, rows, 0), []).findings.filter((finding) => finding.ruleId === "WIA-BLOCKING");
    expect(findings).toHaveLength(2);
    expect(findings.some((finding) => finding.severity === "High")).toBe(false);
  });

  it("classifies negative SQL Server blocking owner codes without inventing a blocker SPID", () => {
    const headers = ["session_id", "blocking_session_id", "collection_time", "wait_info"];
    const rows = [headers,
      [75, -5, "2026-08-22T12:00:00Z", "(120ms)PAGEIOLATCH_SH"],
      [73, -5, "2026-08-22T12:00:00Z", "(150ms)PAGEIOLATCH_SH"],
    ];
    const source: AnalysisInput = { id: "special-blocker", fileName: "special.csv", size: 100, format: "csv", rowCount: 2, recognizedColumns: headers, unknownColumns: [], warnings: [] };
    const report = analyze([source], normalizeRows(source.id, rows, 0), []);
    expect(report.findings.some((finding) => finding.title.includes("Session -5"))).toBe(false);
    expect(report.findings.find((finding) => finding.ruleId === "WIA-BLOCKING-SPECIAL")).toMatchObject({
      severity: "Informational",
      title: "Unidentified latch owner (-5) observed",
    });
  });

  it("keeps a one-victim single-capture block low and a one-capture locking wait below High", () => {
    const headers = ["session_id", "blocking_session_id", "collection_time", "wait_info"];
    const rows = [headers,
      [51, null, "2026-08-22T12:00:00Z", null],
      [52, 51, "2026-08-22T12:00:00Z", "(29764ms)LCK_M_X"],
    ];
    const source: AnalysisInput = { id: "transient", fileName: "transient.csv", size: 100, format: "csv", rowCount: 2, recognizedColumns: headers, unknownColumns: [], warnings: [] };
    const report = analyze([source], normalizeRows(source.id, rows, 0), []);
    expect(report.findings.find((finding) => finding.ruleId === "WIA-BLOCKING")?.severity).toBe("Low");
    expect(report.findings.find((finding) => finding.ruleId === "WIA-WAIT")?.severity).toBe("Medium");
  });

  it("states that per-session tempdb pages do not establish overall tempdb utilization", () => {
    const headers = ["session_id", "collection_time", "start_time", "tempdb_current"];
    const rows = [headers, [68, "2026-08-22T12:00:00Z", "2026-08-22T11:40:00Z", 9_901_800]];
    const source: AnalysisInput = { id: "tempdb-scope", fileName: "tempdb.csv", size: 100, format: "csv", rowCount: 1, recognizedColumns: headers, unknownColumns: [], warnings: [] };
    const report = analyze([source], normalizeRows(source.id, rows, 0), []);
    expect(report.dataQuality.warnings.join(" ")).toMatch(/per-session tempdb pages.*overall tempdb utilization/i);
    expect(report.findings.find((finding) => finding.ruleId === "WIA-RESOURCE")?.evidence.find((item) => item.label === "Tempdb current")?.value).toContain("75.54 GB");
  });

  it("emits residual findings only from explicit or supported access-path evidence", () => {
    const xml = `<ShowPlanXML Version="1.6" xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan"><BatchSequence><Batch><Statements><StmtSimple StatementText="SELECT Id FROM dbo.T"><QueryPlan><RelOp NodeId="1" PhysicalOp="Index Scan" LogicalOp="Index Scan"><IndexScan><Predicate><ScalarOperator ScalarString="[dbo].[T].[Id]&gt;(10)" /></Predicate></IndexScan></RelOp><RelOp NodeId="2" PhysicalOp="Index Seek" LogicalOp="Index Seek"><IndexScan><SeekPredicates><SeekPredicateNew><SeekKeys><Prefix ScanType="EQ"><RangeExpressions><ScalarOperator ScalarString="(10)" /></RangeExpressions></Prefix></SeekKeys></SeekPredicateNew></SeekPredicates><Predicate><ScalarOperator ScalarString="[dbo].[T].[Flag]=(1)" /></Predicate></IndexScan></RelOp></QueryPlan></StmtSimple></Statements></Batch></BatchSequence></ShowPlanXML>`;
    const source: AnalysisInput = { id: "predicate-plan", fileName: "predicate.sqlplan", size: xml.length, format: "sqlplan", rowCount: 0, recognizedColumns: [], unknownColumns: [], warnings: [] };
    const residuals = analyze([source], [], [parseShowplan(xml, source.id, source.fileName)]).findings.filter((finding) => finding.ruleId === "PLAN-RESIDUAL-PREDICATE");
    expect(residuals).toHaveLength(1);
    expect(residuals[0]).toMatchObject({ severity: "Low", confidence: "Low" });
    expect(residuals[0].evidence).toEqual(expect.arrayContaining([{ label: "Node", value: "2" }, { label: "Predicate", value: "[dbo].[T].[Flag]=(1)" }]));
  });

  it("discloses exact suppressed counts for every bounded finding family", () => {
    const headers = ["session_id", "collection_time", "start_time", "tran_start_time", "open_tran_count", "wait_info", "CPU"];
    const rows: unknown[][] = [headers];
    for (let index = 0; index < 30; index += 1) {
      const collected = new Date(Date.UTC(2026, 7, 25, 1, 0, index)).toISOString();
      rows.push([100 + index, collected, "2026-08-25T00:30:00Z", "2026-08-25T00:30:00Z", 1, `(2000ms)LCK_TEST_${index}`, 100 + index]);
    }
    const source: AnalysisInput = { id: "caps", fileName: "caps.csv", size: 100, format: "csv", rowCount: 30, recognizedColumns: headers, unknownColumns: [], warnings: [] };
    const report = analyze([source], normalizeRows(source.id, rows, 0), []);
    expect(report.findings.filter((finding) => finding.ruleId === "WIA-RESOURCE")).toHaveLength(20);
    expect(report.findings.filter((finding) => finding.ruleId === "WIA-WAIT")).toHaveLength(24);
    expect(report.findings.filter((finding) => finding.ruleId === "WIA-TRANSACTION")).toHaveLength(20);
    expect((report.dataQuality as typeof report.dataQuality & { findingCaps?: unknown[] }).findingCaps).toEqual([
      { ruleId: "WIA-RESOURCE", retainedCount: 20, suppressedCount: 10, order: "Descending diagnostic impact" },
      { ruleId: "WIA-WAIT", retainedCount: 24, suppressedCount: 6, order: "Descending diagnostic impact" },
      { ruleId: "WIA-TRANSACTION", retainedCount: 20, suppressedCount: 10, order: "Descending diagnostic impact" },
    ]);
  });
});
