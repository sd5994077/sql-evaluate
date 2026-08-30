import * as XLSX from "xlsx";
import type { AnalysisInput, PlanDocument, SupplementalEvidenceSource, WhoIsActiveRecord } from "../types";
import { canonicalColumn, headerScore, normalizeHeader } from "../schema";
import { decodeText, findHeaderRow, parseCsv } from "./csv";
import { normalizeRows, sourceIdFor } from "./normalize";
import { parseShowplan } from "./showplan";
import { parseSupplementalEvidence } from "./supplementalEvidence";

export interface ParsedSource {
  input: AnalysisInput;
  records: WhoIsActiveRecord[];
  plans: PlanDocument[];
  supplementalEvidence: SupplementalEvidenceSource[];
}

function schemaFor(headers: unknown[]): { recognized: string[]; unknown: string[]; duplicates: string[] } {
  const recognized = [...new Set(headers.map(canonicalColumn).filter((value): value is string => Boolean(value)))];
  const unknown = headers.map(normalizeHeader).filter((value) => value && !canonicalColumn(value));
  const counts = new Map<string, { label: string; count: number }>();
  headers.forEach((header) => {
    const label = canonicalColumn(header) ?? normalizeHeader(header);
    if (!label) return;
    const key = label.toLowerCase();
    const current = counts.get(key);
    counts.set(key, { label, count: (current?.count ?? 0) + 1 });
  });
  const duplicates = [...counts.values()].filter(({ count }) => count > 1).map(({ label }) => label);
  return { recognized, unknown, duplicates };
}

function fromMatrix(file: File, format: "csv" | "xlsx", matrix: unknown[][], sheetName?: string): ParsedSource {
  const sourceId = sourceIdFor(file.name);
  const headerIndex = findHeaderRow(matrix);
  if (headerIndex < 0) throw new Error("No sp_WhoIsActive header row was found in the first 20 rows.");
  const schema = schemaFor(matrix[headerIndex]);
  const records = normalizeRows(sourceId, matrix, headerIndex);
  const warnings: string[] = [];
  if (schema.recognized.length < 5) warnings.push("Only a small subset of sp_WhoIsActive columns was recognized.");
  if (schema.duplicates.length) warnings.push(`Duplicate columns were detected and preserved with numbered suffixes: ${schema.duplicates.join(", ")}.`);
  return {
    input: {
      id: sourceId,
      fileName: file.name,
      size: file.size,
      format,
      sheetName,
      rowCount: records.length,
      recognizedColumns: schema.recognized,
      unknownColumns: schema.unknown,
      warnings,
    },
    records,
    plans: [],
    supplementalEvidence: [],
  };
}

export async function parseCaptureFile(file: File): Promise<ParsedSource> {
  if (file.size > 100 * 1024 * 1024) throw new Error("Capture files are limited to 100 MB.");
  const lower = file.name.toLowerCase();
  const buffer = await file.arrayBuffer();
  if (lower.endsWith(".csv") || lower.endsWith(".tsv")) {
    const matrix = parseCsv(decodeText(buffer));
    const supplemental = parseSupplementalEvidence(file, matrix);
    if (supplemental) return { input: supplemental.input, records: [], plans: [], supplementalEvidence: [supplemental.evidence] };
    return fromMatrix(file, "csv", matrix);
  }
  if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) {
    const workbook = XLSX.read(buffer, { type: "array", cellDates: true, dense: true });
    const candidates = workbook.SheetNames.map((name) => {
      const matrix = XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, raw: true, defval: null }) as unknown[][];
      const score = Math.max(0, ...matrix.slice(0, 20).map(headerScore));
      return { name, matrix, score };
    }).sort((a, b) => b.score - a.score);
    if (!candidates[0] || candidates[0].score < 2) throw new Error("No worksheet contains a recognizable sp_WhoIsActive header row.");
    const parsed = fromMatrix(file, "xlsx", candidates[0].matrix, candidates[0].name);
    const ties = candidates.filter((candidate) => candidate.score === candidates[0].score && candidate.name !== candidates[0].name);
    if (ties.length) parsed.input.warnings.push(`Selected ${candidates[0].name}; equally plausible sheets: ${ties.map((tie) => tie.name).join(", ")}.`);
    return parsed;
  }
  throw new Error("Supported capture formats are CSV, TSV, XLSX, and XLS.");
}

export async function parsePlanFile(file: File): Promise<ParsedSource> {
  if (file.size > 25 * 1024 * 1024) throw new Error("Execution plan files are limited to 25 MB.");
  const sourceId = sourceIdFor(file.name);
  const plan = parseShowplan(decodeText(await file.arrayBuffer()), sourceId, file.name);
  return {
    input: { id: sourceId, fileName: file.name, size: file.size, format: "sqlplan", rowCount: 0, recognizedColumns: [], unknownColumns: [], warnings: plan.warnings },
    records: [],
    plans: [plan],
    supplementalEvidence: [],
  };
}

export async function parseInputFile(file: File): Promise<ParsedSource> {
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".sqlplan") || lower.endsWith(".xml")) return parsePlanFile(file);
  return parseCaptureFile(file);
}
