import { resolveCandidatePlan } from "./spillTriage";
import type { DeepAnalysisCase, DeepEvidenceState, SpillNumericMetric } from "./types";

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character]!);
}

function csvCell(value: unknown): string {
  const text = String(value ?? "");
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

function redactGeneratedText(value: string): string {
  return value
    .replace(/The source finding directly reports:[^\r\n]*/gi, "The source finding directly reports this condition.")
    .replace(/\bSPID\s+\d+\b/gi, "SPID [redacted]")
    .replace(/\b0x[0-9a-f]+\b/gi, "[redacted identity]");
}

interface HandoffMetric {
  value: number | null;
  unit: SpillNumericMetric["unit"];
  state: SpillNumericMetric["state"];
  provenance: "imported" | "derived" | "converted" | "unavailable";
}

export interface DeepAnalysisHandoffReport {
  documentType: "sql-evaluate-redacted-deep-analysis";
  schemaVersion: "1.0";
  redacted: true;
  case: { id: string; profileId: DeepAnalysisCase["profileId"]; createdAt: string; updatedAt: string };
  sourceFinding?: { ruleId: string; severity: string; confidence: string; category: string };
  narrative?: { headline: string; established: string[]; supported: string[]; contradicted: string[]; unanswered: string[]; nextCheck: string };
  assertions: Array<{ label: string; statement: string; state: DeepEvidenceState; confidence: string; basis: string[]; missingEvidence: string[]; evidenceFileCount: number }>;
  evidenceSummary: { fileCount: number; recognizedFileCount: number; kinds: Array<{ kind: string; count: number }> };
  spillTriage?: {
    imports: Array<{ importedRows: number; rankableRows: number; headerRow: number | null; recognizedColumnCount: number; unknownColumnCount: number }>;
    candidates: Array<{ rank: number | null; rankGroup: "total" | "average-only" | "unranked"; totalSpillPages: HandoffMetric; averageSpillPages: HandoffMetric; executionCount: HandoffMetric; lastExecution: string | null; rankingBasis: string }>;
    selectedCorrelation: { connected: boolean; ambiguous: boolean; blockedByConflict: boolean; quality: "Exact" | "Strong" | "Candidate" | "None"; selectionMethod: "automatic" | "manual" | "none" } | null;
  };
}

function safeMetric(metric: SpillNumericMetric): HandoffMetric {
  return {
    value: metric.value,
    unit: metric.unit,
    state: metric.state,
    provenance: metric.state === "derived" ? "derived" : metric.explanation?.startsWith("Converted") ? "converted" : metric.value === null ? "unavailable" : "imported",
  };
}

function rankingBasis(rankGroup: "total" | "average-only" | "unranked", total: number | null, average: number | null): string {
  if (rankGroup === "total") return `Ranked by cumulative spill impact: ${total?.toLocaleString() ?? "unknown"} pages total${average !== null ? `; ${average.toLocaleString()} pages per execution` : ""}.`;
  if (rankGroup === "average-only") return `Total spill volume was not usable; ranked in the average-only group at ${average?.toLocaleString() ?? "unknown"} pages per execution.`;
  return "Numeric spill volume was missing, zero, or invalid, so this row is visible but unranked.";
}

export function buildRedactedDeepAnalysisReport(deepCase: DeepAnalysisCase): DeepAnalysisHandoffReport {
  const artifactIds = new Set(deepCase.artifacts.map((artifact) => artifact.id));
  const kinds = new Map<string, number>();
  deepCase.artifacts.forEach((artifact) => kinds.set(artifact.kind, (kinds.get(artifact.kind) ?? 0) + 1));
  const selected = deepCase.spillTriage?.candidates.find((candidate) => candidate.id === deepCase.spillTriage?.selectedCandidateId) ?? deepCase.spillTriage?.candidates[0];
  const manual = selected ? deepCase.spillTriage?.manualPlanSelections?.find((selection) => selection.candidateId === selected.id) : undefined;
  const resolution = selected && deepCase.spillTriage ? resolveCandidatePlan(selected, deepCase.spillTriage.plans, manual) : null;
  return {
    documentType: "sql-evaluate-redacted-deep-analysis",
    schemaVersion: "1.0",
    redacted: true,
    case: { id: deepCase.id, profileId: deepCase.profileId, createdAt: deepCase.createdAt, updatedAt: deepCase.updatedAt },
    sourceFinding: deepCase.sourceFinding ? { ruleId: deepCase.sourceFinding.ruleId, severity: deepCase.sourceFinding.severity, confidence: deepCase.sourceFinding.confidence, category: deepCase.sourceFinding.category } : undefined,
    narrative: deepCase.narrative ? {
      headline: redactGeneratedText(deepCase.narrative.headline),
      established: deepCase.narrative.established.map(redactGeneratedText),
      supported: deepCase.narrative.supported.map(redactGeneratedText),
      contradicted: deepCase.narrative.contradicted.map(redactGeneratedText),
      unanswered: deepCase.narrative.unanswered.map(redactGeneratedText),
      nextCheck: redactGeneratedText(deepCase.narrative.nextCheck),
    } : undefined,
    assertions: deepCase.assertions.map((assertion) => ({
      label: redactGeneratedText(assertion.label), statement: redactGeneratedText(assertion.statement), state: assertion.state, confidence: assertion.confidence,
      basis: assertion.basis.map(redactGeneratedText), missingEvidence: assertion.missingEvidence.map(redactGeneratedText),
      evidenceFileCount: new Set(assertion.artifactIds.filter((id) => artifactIds.has(id))).size,
    })),
    evidenceSummary: { fileCount: deepCase.artifacts.length, recognizedFileCount: deepCase.artifacts.filter((artifact) => artifact.signals.length > 0).length, kinds: [...kinds].map(([kind, count]) => ({ kind, count })).sort((left, right) => left.kind.localeCompare(right.kind)) },
    spillTriage: deepCase.spillTriage ? {
      imports: deepCase.spillTriage.imports.map((summary) => ({ importedRows: summary.importedRows, rankableRows: summary.rankableRows, headerRow: summary.headerRow ?? null, recognizedColumnCount: summary.recognizedHeaders.length, unknownColumnCount: summary.unknownHeaders.length })),
      candidates: deepCase.spillTriage.candidates.map((candidate) => ({ rank: candidate.rank, rankGroup: candidate.rankGroup, totalSpillPages: safeMetric(candidate.totalSpillPages), averageSpillPages: safeMetric(candidate.averageSpillPages), executionCount: safeMetric(candidate.executionCount), lastExecution: candidate.lastExecution, rankingBasis: rankingBasis(candidate.rankGroup, candidate.totalSpillPages.value, candidate.averageSpillPages.value) })),
      selectedCorrelation: resolution ? { connected: resolution.connected, ambiguous: resolution.ambiguous, blockedByConflict: resolution.blockedByConflict, quality: resolution.quality, selectionMethod: resolution.selectionMethod } : null,
    } : undefined,
  };
}

/** @deprecated Redacted handoffs are reports, not reopenable working cases. */
export const redactDeepCase = buildRedactedDeepAnalysisReport;

export function deepCaseJson(deepCase: DeepAnalysisCase): string {
  return JSON.stringify(buildRedactedDeepAnalysisReport(deepCase), null, 2);
}

export function deepCaseFindingsCsv(deepCase: DeepAnalysisCase): string {
  const safe = buildRedactedDeepAnalysisReport(deepCase);
  const rows: unknown[][] = [["Assertion", "State", "Confidence", "Statement", "Basis", "Missing evidence", "Evidence files"]];
  safe.assertions.forEach((item) => rows.push([item.label, item.state, item.confidence, item.statement, item.basis.join(" | "), item.missingEvidence.join(" | "), item.evidenceFileCount]));
  safe.spillTriage?.candidates.forEach((candidate) => rows.push([candidate.rank ? `Spill candidate rank ${candidate.rank}` : "Unranked spill evidence", candidate.rank ? "Observed" : "Not Evaluated", "High", candidate.rankingBasis, candidate.totalSpillPages.value === null ? "Total spill pages not supplied" : `${candidate.totalSpillPages.value} total 8 KB pages; ${candidate.averageSpillPages.value ?? "unknown"} average pages per execution`, candidate.rank ? "Matching stable-identity plan" : "Valid positive numeric spill evidence", 1]));
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}

function list(items: string[] | undefined): string {
  return `<ul>${(items ?? []).map((item) => `<li>${escapeHtml(item)}</li>`).join("") || "<li>None</li>"}</ul>`;
}

export function deepCasePrintableHtml(deepCase: DeepAnalysisCase): string {
  const safe = buildRedactedDeepAnalysisReport(deepCase);
  const narrative = safe.narrative;
  const spillCandidates = safe.spillTriage?.candidates ?? [];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>SQL Evaluate Deep Analysis handoff</title><style>
  body{font:16px/1.55 Segoe UI,sans-serif;color:#15242b;max-width:1100px;margin:40px auto;padding:0 24px}h1{font-size:34px;line-height:1.1}h2{margin-top:34px;border-bottom:2px solid #153c49;padding-bottom:7px}.meta{color:#52666f}.notice{padding:12px;border:1px solid #a67c25;background:#fff8dc}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.box{border:1px solid #aebdc3;padding:14px}.state{font-weight:700;text-transform:uppercase;font-size:12px}.Observed{color:#087f92}.Supported{color:#8a5a00}.Contradicted{color:#a62323}.Not-Evaluated{color:#637079}@media(max-width:700px){.grid{grid-template-columns:1fr}}@media print{body{margin:0}.notice{break-inside:avoid}}</style></head><body>
  <p class="notice"><b>Redacted advisory report.</b> This file is not a reopenable working case. Validate conclusions against approved current evidence before operational changes.</p>
  <h1>${escapeHtml(narrative?.headline ?? "Deep Analysis evidence summary")}</h1><p class="meta">Case ${escapeHtml(safe.case.id)} · Updated ${escapeHtml(safe.case.updatedAt)}</p>
  <h2>Investigation summary</h2><div class="grid"><div class="box"><b>Established</b>${list(narrative?.established)}</div><div class="box"><b>Supported</b>${list(narrative?.supported)}</div><div class="box"><b>Contradicted</b>${list(narrative?.contradicted)}</div><div class="box"><b>Unanswered</b>${list(narrative?.unanswered)}</div></div>
  <h2>Evidence ledger</h2>${safe.assertions.map((item) => `<article class="box"><span class="state ${escapeHtml(item.state.replaceAll(" ", "-"))}">${escapeHtml(item.state)} · ${escapeHtml(item.confidence)} confidence</span><h3>${escapeHtml(item.label)}</h3><p>${escapeHtml(item.statement)}</p><b>Basis</b>${list(item.basis)}<b>Still needed</b>${list(item.missingEvidence)}</article>`).join("")}
  ${spillCandidates.length ? `<h2>Spill candidates</h2>${spillCandidates.map((candidate) => `<article class="box"><span class="state ${candidate.rank ? "Observed" : "Not-Evaluated"}">${candidate.rank ? `RANK ${escapeHtml(candidate.rank)}` : "UNRANKED"}</span><h3>${candidate.rank ? "Highest-priority spill candidate comparison" : "Spill evidence without numeric rank"}</h3><p>${escapeHtml(candidate.rankingBasis)}</p><p>Total: ${escapeHtml(candidate.totalSpillPages.value ?? "Not supplied")} 8 KB pages · Average: ${escapeHtml(candidate.averageSpillPages.value ?? "Not supplied")} pages/execution.</p></article>`).join("")}` : ""}
  <h2>Next check</h2><p>${escapeHtml(narrative?.nextCheck ?? "No next check available.")}</p></body></html>`;
}
