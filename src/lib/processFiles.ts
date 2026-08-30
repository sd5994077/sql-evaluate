import type { AnalysisReport, PlanDocument, SupplementalEvidenceSource, ThresholdProfileSnapshot, WhoIsActiveRecord } from "../types";
import { analyze } from "../rules/engine";
import { verifyThresholdProfileSnapshot } from "../rules/thresholdProfiles";
import { parseInputFile } from "./ingest";

export type ProcessingResult =
  | { type: "complete"; report: AnalysisReport; errors: string[] }
  | { type: "error"; errors: string[] };

interface ProcessingOptions {
  thresholdProfile: ThresholdProfileSnapshot;
  onProgress?: (fileName: string) => void;
  analyzeReport?: typeof analyze;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "Unknown error");
}

export async function processInputFiles(files: File[], options: ProcessingOptions): Promise<ProcessingResult> {
  let thresholdProfile: ThresholdProfileSnapshot;
  try {
    thresholdProfile = await verifyThresholdProfileSnapshot(options.thresholdProfile);
  } catch (error) {
    return { type: "error", errors: [`Threshold profile validation failed before analysis: ${errorText(error)}`] };
  }
  const inputs = [];
  const records: WhoIsActiveRecord[] = [];
  const plans: PlanDocument[] = [];
  const supplementalEvidence: SupplementalEvidenceSource[] = [];
  const errors: string[] = [];

  for (const file of files) {
    try {
      const parsed = await parseInputFile(file);
      inputs.push(parsed.input);
      records.push(...parsed.records);
      plans.push(...parsed.plans);
      supplementalEvidence.push(...parsed.supplementalEvidence);
      options.onProgress?.(file.name);
    } catch (error) {
      errors.push(`${file.name}: ${errorText(error)}`);
    }
  }

  if (!inputs.length) return { type: "error", errors };

  try {
    const report = (options.analyzeReport ?? analyze)(inputs, records, plans, thresholdProfile, supplementalEvidence);
    return { type: "complete", report, errors };
  } catch (error) {
    return {
      type: "error",
      errors: [...errors, `Analysis phase failed after parsing ${inputs.length} input file${inputs.length === 1 ? "" : "s"}: ${errorText(error)}`],
    };
  }
}
