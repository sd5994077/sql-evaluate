import type { ThresholdProfileSnapshot } from "../types";
import { analyze, RULE_DEFINITIONS } from "../rules/engine";
import { verifyThresholdProfileSnapshot } from "../rules/thresholdProfiles";
import { parseInputFile } from "./ingest";
import type { ParsedSource } from "./ingest";
import { captureRange } from "./importPreview";
import type { ImportPreviewItem } from "./importPreview";

export interface PreparedAnalysis {
  parsed: Map<string, ParsedSource>;
  previews: ImportPreviewItem[];
}

export async function prepareAnalysis(files: File[], sheets: Record<string, string> = {}, progress?: (name: string) => void): Promise<PreparedAnalysis> {
  const parsed = new Map<string, ParsedSource>();
  const previews: ImportPreviewItem[] = [];
  for (const [index, file] of files.entries()) {
    const id = String(index);
    try {
      const source = await parseInputFile(file, sheets[id]);
      parsed.set(id, source);
      previews.push({ id, fileName: file.name, size: file.size, kind: source.plans.length ? "Showplan" : source.supplementalEvidence.length ? "Supplemental evidence" : "Activity capture",
        usable: true, count: source.plans.length ? source.plans.reduce((sum, plan) => sum + plan.statements.length, 0) : source.input.rowCount,
        countLabel: source.plans.length ? "plan statements" : "rows",
        worksheets: source.worksheets ?? [], selectedSheet: source.input.sheetName, selectableSheets: source.selectableSheets,
        ...captureRange([...source.records.map((row) => row.collectionTime), ...source.supplementalEvidence.flatMap((evidence) => evidence.samples.map((sample) => sample.collectionTime))]),
        recognized: source.input.recognizedColumns,
        missing: source.plans.length ? [] : RULE_DEFINITIONS.filter((rule) => rule.requiredColumns.some((column) => !source.input.recognizedColumns.includes(column))).map((rule) => rule.title),
        warnings: source.input.warnings });
    } catch (error) {
      previews.push({ id, fileName: file.name, size: file.size, kind: "Unreadable input", usable: false, count: 0, countLabel: "rows",
        worksheets: [], firstCapturedAt: null, lastCapturedAt: null, recognized: [], missing: [],
        warnings: [error instanceof Error ? error.message : "The file could not be read."] });
    }
    progress?.(file.name);
  }
  return { parsed, previews };
}

export async function analyzePrepared(batch: PreparedAnalysis, selectedIds: string[], profile: ThresholdProfileSnapshot) {
  const snapshot = await verifyThresholdProfileSnapshot(profile);
  const sources = [...new Set(selectedIds)].map((id) => {
    const source = batch.parsed.get(id);
    if (!source) throw new Error("A selected input is not usable. Review the preview.");
    return source;
  });
  if (!sources.length) throw new Error("Select at least one usable file.");
  return analyze(sources.map((source) => source.input), sources.flatMap((source) => source.records), sources.flatMap((source) => source.plans), snapshot, sources.flatMap((source) => source.supplementalEvidence));
}

export type PreviewWorkerRequest =
  | { type: "prepare"; requestId: number; files: File[]; sheets: Record<string, string> }
  | { type: "analyze"; requestId: number; selectedIds: string[]; thresholdProfile: ThresholdProfileSnapshot }
  | { type: "discard"; requestId: number };
