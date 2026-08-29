import { File } from "node:buffer";
import { describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import type { AnalysisReport } from "../types";
import { createRunArchive } from "./runBundle";

const report: AnalysisReport = {
  schemaVersion: "1.0",
  createdAt: "2026-08-25T08:45:00Z",
  redacted: false,
  inputs: [{ id: "source-1", fileName: "capture.csv", size: 42, format: "csv", rowCount: 1, recognizedColumns: ["session_id", "collection_time"], unknownColumns: [], warnings: [] }],
  records: [{ id: "record-1", sourceId: "source-1", rowNumber: 2, sessionId: 51, requestId: 0, collectionTime: "2026-08-25T08:45:00Z", startTime: null, loginTime: null, durationSeconds: null, wait: null, status: null, blockingSessionId: null, blockedSessionCount: null, openTranCount: null, implicitTran: null, cpuMs: null, reads: null, writes: null, physicalReads: null, usedMemoryPages: null, tempdbAllocationPages: 128, tempdbCurrentPages: 64, sqlText: "SELECT 'secret'", sqlCommand: null, queryPlanXml: null, databaseName: "PrivateDb", loginName: "domain\\person", hostName: null, programName: null, original: { session_id: 51, collection_time: "2026-08-25T08:45:00Z", sql_text: "SELECT 'secret'" } }],
  plans: [],
  findings: [],
  dataQuality: { presentColumns: ["session_id", "collection_time"], missingColumns: [], unknownColumns: [], warnings: [], notEvaluatedRules: [], findingCaps: [{ ruleId: "WIA-WAIT", retainedCount: 24, suppressedCount: 6, order: "Descending diagnostic impact" }] },
};

describe("run archive", () => {
  it("packages redacted outputs without the original source by default", async () => {
    const source = new File(["session_id,sql_text\n51,SELECT secret\n"], "capture.csv", { type: "text/csv" });
    const archive = await createRunArchive(report, [source], {
      includeRaw: false,
      processingErrors: [],
      runId: "20260825-084500-test1234",
      exportedAt: "2026-08-25T08:46:00Z",
    });
    const files = unzipSync(archive.bytes);

    expect(archive.fileName).toBe("SQL-Evaluate-Run_20260825-084500-test1234.zip");
    expect(Object.keys(files).sort()).toEqual([
      "diagnostics/processing-log.json",
      "manifest.json",
      "normalized/activity.csv",
      "results/analysis.sqleval.json",
      "results/findings.csv",
      "results/report.html",
    ]);
    expect(strFromU8(files["results/analysis.sqleval.json"])).not.toContain("domain\\\\person");
    expect(strFromU8(files["manifest.json"])).toContain('"rawIncluded": false');
    expect(strFromU8(files["results/findings.csv"])).toContain("6 additional WIA-WAIT findings were suppressed after retaining 24");
    expect(strFromU8(files["results/report.html"])).toContain("6 additional WIA-WAIT findings were suppressed after retaining 24");
    expect(strFromU8(files["diagnostics/processing-log.json"])).toContain('"findingCaps"');
  });

  it("includes original sources only after raw export is authorized", async () => {
    const source = new File(["session_id\n51\n"], "../capture.csv", { type: "text/csv" });
    const archive = await createRunArchive(report, [source], {
      includeRaw: true,
      processingErrors: ["one optional file was skipped"],
      runId: "20260825-084500-test5678",
      exportedAt: "2026-08-25T08:46:00Z",
    });
    const files = unzipSync(archive.bytes);

    expect(files["source/capture.csv"]).toBeDefined();
    expect(strFromU8(files["diagnostics/processing-log.json"])).toContain("one optional file was skipped");
  });
});
