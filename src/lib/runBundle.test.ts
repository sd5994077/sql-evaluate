import { File } from "node:buffer";
import { describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import type { AnalysisReport } from "../types";
import { DEFAULT_THRESHOLD_PROFILE_SNAPSHOT } from "../rules/thresholdProfiles";
import { findingsCsv, printableReport, redactReport } from "./report";
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
  thresholdProfile: DEFAULT_THRESHOLD_PROFILE_SNAPSHOT,
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
    const manifest = JSON.parse(strFromU8(files["manifest.json"]));
    const processingLog = JSON.parse(strFromU8(files["diagnostics/processing-log.json"]));
    expect(manifest.rawIncluded).toBe(false);
    expect(manifest.thresholdProfile).toEqual({ id: DEFAULT_THRESHOLD_PROFILE_SNAPSHOT.id, name: DEFAULT_THRESHOLD_PROFILE_SNAPSHOT.name, version: DEFAULT_THRESHOLD_PROFILE_SNAPSHOT.version, digest: DEFAULT_THRESHOLD_PROFILE_SNAPSHOT.digest, builtIn: true });
    expect(processingLog.thresholdProfile).toEqual(DEFAULT_THRESHOLD_PROFILE_SNAPSHOT);
    expect(manifest.sources[0]).toMatchObject({ fileName: "capture.csv", included: false, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(files["source/capture.csv"]).toBeUndefined();
    for (const path of ["results/analysis.sqleval.json", "results/findings.csv", "results/report.html", "normalized/activity.csv"]) {
      const content = strFromU8(files[path]);
      expect(content).not.toContain("SELECT 'secret'");
      expect(content).not.toContain("PrivateDb");
      expect(content).not.toContain("domain\\person");
    }
    expect(strFromU8(files["results/findings.csv"])).toContain("6 additional WIA-WAIT findings were suppressed after retaining 24");
    expect(strFromU8(files["results/findings.csv"])).toBe(findingsCsv(redactReport(report)));
    expect(strFromU8(files["results/report.html"])).toContain("6 additional WIA-WAIT findings were suppressed after retaining 24");
    expect(strFromU8(files["results/report.html"])).toBe(printableReport(redactReport(report)));
    expect(strFromU8(files["results/findings.csv"])).toContain("THRESHOLD-PROFILE");
    expect(strFromU8(files["results/report.html"])).toContain(DEFAULT_THRESHOLD_PROFILE_SNAPSHOT.digest);
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

  it("allows an explicitly identified legacy report without inventing profile metadata", async () => {
    const { thresholdProfile: _profile, ...legacy } = report;
    await expect(createRunArchive(legacy, [], { includeRaw: false, processingErrors: [] })).rejects.toThrow(/cannot be archived/);
    const archive = await createRunArchive(legacy, [], { includeRaw: false, processingErrors: [], allowLegacyReport: true, runId: "legacy", exportedAt: "2026-08-25T08:46:00Z" });
    const files = unzipSync(archive.bytes);
    expect(archive.manifest.thresholdProfile).toBeUndefined();
    expect(strFromU8(files["results/findings.csv"])).toContain("Legacy report — threshold profile not recorded.");
    expect(strFromU8(files["diagnostics/processing-log.json"])).not.toContain('"thresholdProfile"');
  });

  it("refuses to archive a report with tampered profile provenance", async () => {
    const tampered = { ...report, thresholdProfile: { ...DEFAULT_THRESHOLD_PROFILE_SNAPSHOT, name: "Tampered" } };
    await expect(createRunArchive(tampered, [], { includeRaw: false, processingErrors: [] })).rejects.toThrow(/digest does not match/);
  });
});
