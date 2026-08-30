import { strToU8, zipSync } from "fflate";
import type { AnalysisReport, WhoIsActiveRecord } from "../types";
import { APP_VERSION } from "../version";
import { isBuiltInThresholdProfileId, verifyThresholdProfileSnapshot } from "../rules/thresholdProfiles";
import { findingsCsv, printableReport, redactReport } from "./report";

interface RunArchiveOptions {
  includeRaw: boolean;
  processingErrors: string[];
  runId?: string;
  exportedAt?: string;
  allowLegacyReport?: boolean;
}

interface SourceManifestEntry {
  fileName: string;
  size: number;
  sha256: string;
  included: boolean;
}

export interface RunArchive {
  fileName: string;
  bytes: Uint8Array;
  manifest: {
    schemaVersion: "1.0";
    runId: string;
    appVersion: string;
    analysisCreatedAt: string;
    exportedAt: string;
    rawIncluded: boolean;
    thresholdProfile?: { id: string; name: string; version: string; digest: string; builtIn: boolean };
    sources: SourceManifestEntry[];
    counts: { inputs: number; records: number; plans: number; findings: number };
    outputs: string[];
  };
}

function csvCell(value: unknown): string {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function activityCsv(records: WhoIsActiveRecord[]): string {
  const headers = [
    "record_id", "source_id", "row_number", "session_id", "request_id", "collection_time", "start_time", "login_time",
    "duration_seconds", "wait_type", "wait_duration_ms", "wait_category", "status", "blocking_session_id", "blocked_session_count",
    "open_tran_count", "implicit_tran", "cpu_ms", "reads", "writes", "physical_reads", "used_memory_pages",
    "tempdb_allocation_pages", "tempdb_current_pages", "database_name", "login_name", "host_name", "program_name", "sql_text", "sql_command",
  ];
  const rows = records.map((record) => [
    record.id, record.sourceId, record.rowNumber, record.sessionId, record.requestId, record.collectionTime, record.startTime, record.loginTime,
    record.durationSeconds, record.wait?.type, record.wait?.durationMs, record.wait?.category, record.status, record.blockingSessionId,
    record.blockedSessionCount, record.openTranCount, record.implicitTran, record.cpuMs, record.reads, record.writes, record.physicalReads,
    record.usedMemoryPages, record.tempdbAllocationPages, record.tempdbCurrentPages, record.databaseName, record.loginName, record.hostName,
    record.programName, record.sqlText, record.sqlCommand,
  ]);
  return [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
}

function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).at(-1) || "source-file";
  return base.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_").replace(/[. ]+$/g, "") || "source-file";
}

async function sha256(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function defaultRunId(exportedAt: string): string {
  const stamp = exportedAt.replace(/[-:]/g, "").replace("T", "-").replace(/\.\d{3}Z$/, "").replace("Z", "");
  const suffix = crypto.randomUUID().slice(0, 8);
  return `${stamp}-${suffix}`;
}

function uniqueSourcePath(name: string, used: Set<string>): string {
  const safe = safeFileName(name);
  if (!used.has(safe.toLowerCase())) {
    used.add(safe.toLowerCase());
    return `source/${safe}`;
  }
  const dot = safe.lastIndexOf(".");
  const stem = dot > 0 ? safe.slice(0, dot) : safe;
  const extension = dot > 0 ? safe.slice(dot) : "";
  let index = 2;
  while (used.has(`${stem}-${index}${extension}`.toLowerCase())) index += 1;
  const unique = `${stem}-${index}${extension}`;
  used.add(unique.toLowerCase());
  return `source/${unique}`;
}

export async function createRunArchive(report: AnalysisReport, sourceFiles: File[], options: RunArchiveOptions): Promise<RunArchive> {
  if (!report.thresholdProfile && !options.allowLegacyReport) throw new Error("A newly generated report cannot be archived without its resolved threshold profile.");
  const verifiedReport = report.thresholdProfile ? { ...report, thresholdProfile: await verifyThresholdProfileSnapshot(report.thresholdProfile) } : report;
  const exportedAt = options.exportedAt ?? new Date().toISOString();
  const runId = options.runId ?? defaultRunId(exportedAt);
  const output = options.includeRaw ? verifiedReport : redactReport(verifiedReport);
  const sourcePaths = new Map<File, string>();
  const usedSourceNames = new Set<string>();
  sourceFiles.forEach((file) => sourcePaths.set(file, uniqueSourcePath(file.name, usedSourceNames)));
  const sources: SourceManifestEntry[] = await Promise.all(sourceFiles.map(async (file) => ({
    fileName: file.name,
    size: file.size,
    sha256: await sha256(file),
    included: options.includeRaw,
  })));
  const outputPaths = [
    "results/analysis.sqleval.json",
    "results/findings.csv",
    "results/report.html",
    "normalized/activity.csv",
    "diagnostics/processing-log.json",
  ];
  const manifest: RunArchive["manifest"] = {
    schemaVersion: "1.0",
    runId,
    appVersion: APP_VERSION,
    analysisCreatedAt: verifiedReport.createdAt,
    exportedAt,
    rawIncluded: options.includeRaw,
    thresholdProfile: verifiedReport.thresholdProfile ? {
      id: verifiedReport.thresholdProfile.id,
      name: verifiedReport.thresholdProfile.name,
      version: verifiedReport.thresholdProfile.version,
      digest: verifiedReport.thresholdProfile.digest,
      builtIn: isBuiltInThresholdProfileId(verifiedReport.thresholdProfile.id),
    } : undefined,
    sources,
    counts: { inputs: verifiedReport.inputs.length, records: verifiedReport.records.length, plans: verifiedReport.plans.length, findings: verifiedReport.findings.length },
    outputs: [...outputPaths, ...(options.includeRaw ? [...sourcePaths.values()] : [])],
  };
  const diagnostics = {
    runId,
    processingErrors: options.processingErrors,
    inputWarnings: verifiedReport.inputs.flatMap((input) => input.warnings.map((warning) => ({ fileName: input.fileName, warning }))),
    dataQualityWarnings: verifiedReport.dataQuality.warnings,
    notEvaluatedRules: verifiedReport.dataQuality.notEvaluatedRules,
    findingCaps: verifiedReport.dataQuality.findingCaps ?? [],
    thresholdProfile: verifiedReport.thresholdProfile,
  };
  const archiveFiles: Record<string, Uint8Array> = {
    "manifest.json": strToU8(JSON.stringify(manifest, null, 2)),
    "results/analysis.sqleval.json": strToU8(JSON.stringify(output, null, 2)),
    "results/findings.csv": strToU8(findingsCsv(output)),
    "results/report.html": strToU8(printableReport(output)),
    "normalized/activity.csv": strToU8(activityCsv(output.records)),
    "diagnostics/processing-log.json": strToU8(JSON.stringify(diagnostics, null, 2)),
  };
  if (options.includeRaw) {
    for (const file of sourceFiles) archiveFiles[sourcePaths.get(file)!] = new Uint8Array(await file.arrayBuffer());
  }

  return {
    fileName: `SQL-Evaluate-Run_${runId}.zip`,
    bytes: zipSync(archiveFiles, { level: 6 }),
    manifest,
  };
}
