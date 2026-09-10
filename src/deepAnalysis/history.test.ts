import { describe, expect, it } from "vitest";
import { parseShowplan } from "../lib/showplan";
import {
  createHistoryArchive,
  createInvestigationHistory,
  generateOlaPreviewSql,
  historyTargets,
  openHistoryArchive,
  type HistoryTargetIdentity,
  type InvestigationHistory,
} from "./history";

describe("investigation history", () => {
  it("extracts structured object and optimizer statistics identity", () => {
    const xml = `<ShowPlanXML Version="1.6" xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan"><BatchSequence><Batch><Statements><StmtSimple StatementText="SELECT * FROM dbo.Fact"><OptimizerStatsUsage><StatisticsInfo Database="[Warehouse]" Schema="[dbo]" Table="[Fact]" Statistics="[IX_Fact]" ModificationCount="900" SamplingPercent="25" LastUpdate="2026-09-01T00:00:00" /></OptimizerStatsUsage><QueryPlan><RelOp NodeId="1" PhysicalOp="Index Scan" LogicalOp="Index Scan" EstimateRows="10"><RunTimeInformation><RunTimeCountersPerThread Thread="0" ActualRows="100000" /></RunTimeInformation><IndexScan><Object Database="[Warehouse]" Schema="[dbo]" Table="[Fact]" Index="[IX_Fact]" IndexKind="NonClustered" /></IndexScan></RelOp></QueryPlan></StmtSimple></Statements></Batch></BatchSequence></ShowPlanXML>`;
    const statement = parseShowplan(xml, "actual", "actual.sqlplan").statements[0];
    expect(statement.operators[0].objectIdentity).toMatchObject({ database: "[Warehouse]", schema: "[dbo]", table: "[Fact]", index: "[IX_Fact]" });
    expect(statement.statisticsUsage?.[0]).toMatchObject({ statistics: "[IX_Fact]", modificationCount: 900, samplingPercent: 25 });
  });

  it("round-trips a hash-verified history archive", async () => {
    const history = createInvestigationHistory("2026-09-07T12:00:00Z", "history-test");
    const archive = await createHistoryArchive(history, "2026-09-07T12:01:00Z");
    const reopened = await openHistoryArchive(new File([new Uint8Array(archive.bytes)], archive.fileName));
    expect(reopened.id).toBe("history-test");
    expect(archive.fileName).toBe("SQL-Evaluate-History_history-test.sqlevalhistory.zip");
  });

  it("counts an issue once per capture and generates a report-only Ola preview", () => {
    const target: HistoryTargetIdentity = { serverFingerprint: "a", serverName: "SQL-A", database: "Warehouse", schema: "dbo", table: "Fact", index: "IX_Fact", portableKey: "warehouse|dbo|fact|ix_fact", serverKey: "a|warehouse|dbo|fact|ix_fact" };
    const history: InvestigationHistory = {
      ...createInvestigationHistory("2026-09-07T12:00:00Z", "history-test"),
      captures: [{ id: "capture-1", kind: "actual-plan", sourceCaseId: "case-1", sourceDigest: "abc", capturedAt: "2026-09-07T12:00:00Z", serverFingerprint: "a", targets: [target], statisticsUsage: [] }],
      observations: [
        { id: "one", captureId: "capture-1", sourceCaseId: "case-1", target, issueCode: "severe-underestimate", nodeId: 1, actualRows: 100000, estimatedRows: 10, ratio: 10000, detail: "Mismatch", attribution: "Exact" },
        { id: "two", captureId: "capture-1", sourceCaseId: "case-1", target, issueCode: "severe-underestimate", nodeId: 2, actualRows: 100000, estimatedRows: 10, ratio: 10000, detail: "Mismatch", attribution: "Exact" },
      ],
      verifications: [{ schemaVersion: "1.0", adapterId: "SQL_EVALUATE_STATS_VERIFY_V1", sourceDigest: "verify", capturedAt: new Date().toISOString(), serverName: "SQL-A", serverFingerprint: "a", database: "Warehouse", schema: "dbo", table: "Fact", index: "IX_Fact", statistics: "IX_Fact", objectId: 1, indexId: 2, statsId: 2, lastUpdated: "2026-09-01T00:00:00Z", rows: 100000, rowsSampled: 100000, modificationCounter: 500, autoUpdateStats: true, olaDatabase: "DBA", olaSchema: "dbo", olaProcedure: "IndexOptimize", olaCompatible: true, target }],
    };
    const summary = historyTargets(history)[0];
    expect(summary.issueCounts["severe-underestimate"]).toBe(1);
    const preview = generateOlaPreviewSql(history, summary);
    expect(preview.sql).toContain("DECLARE @Execute nvarchar(1) = N'N'");
    expect(preview.sql).toContain("@FragmentationLow = NULL");
    expect(preview.sql).not.toMatch(/INDEX_REBUILD|INDEX_REORGANIZE/);
  });
});
