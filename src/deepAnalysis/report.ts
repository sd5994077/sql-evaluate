import type { DeepAnalysisCase } from "./types";

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character]!);
}

function csvCell(value: unknown): string {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function redactDeepCase(deepCase: DeepAnalysisCase): DeepAnalysisCase {
  const sensitiveLabel = /sql|command|query|plan|database|host|login|program|parameter|object/i;
  return {
    ...deepCase,
    sourceFileNames: deepCase.sourceFileNames.map((_, index) => `source-${index + 1}`),
    sourceFinding: {
      ...deepCase.sourceFinding,
      evidence: deepCase.sourceFinding.evidence.map((item) => sensitiveLabel.test(item.label) ? { ...item, value: "[redacted]" } : item),
      blockingContext: deepCase.sourceFinding.blockingContext ? {
        ...deepCase.sourceFinding.blockingContext,
        databaseName: deepCase.sourceFinding.blockingContext.databaseName ? "[redacted]" : null,
        commandPreview: deepCase.sourceFinding.blockingContext.commandPreview ? "[redacted command preview]" : null,
      } : undefined,
    },
    rootIdentity: deepCase.rootIdentity ? { sessionId: deepCase.rootIdentity.sessionId, requestId: deepCase.rootIdentity.requestId } : undefined,
    observations: (deepCase.observations ?? []).map((item) => ({
      ...item,
      detail: item.detail ? "[redacted evidence detail]" : undefined,
      identity: item.identity ? { sessionId: item.identity.sessionId, requestId: item.identity.requestId, queryStoreQueryId: item.identity.queryStoreQueryId, queryStorePlanId: item.identity.queryStorePlanId } : undefined,
    })),
    artifacts: deepCase.artifacts.map((artifact, index) => ({ ...artifact, fileName: `evidence-${index + 1}`, summary: `${artifact.kind} evidence recognized with ${artifact.signals.length} supported signal${artifact.signals.length === 1 ? "" : "s"}.`, identity: artifact.identity ? { sessionId: artifact.identity.sessionId, requestId: artifact.identity.requestId, queryStoreQueryId: artifact.identity.queryStoreQueryId, queryStorePlanId: artifact.identity.queryStorePlanId } : undefined })),
    events: deepCase.events.map((event) => ({ ...event, summary: `${event.type} recorded in the working case.` })),
  };
}

export function deepCaseJson(deepCase: DeepAnalysisCase): string {
  return JSON.stringify(redactDeepCase(deepCase), null, 2);
}

export function deepCaseFindingsCsv(deepCase: DeepAnalysisCase): string {
  const safe = redactDeepCase(deepCase);
  const rows = [["Assertion", "State", "Confidence", "Statement", "Basis", "Missing evidence", "Evidence files"]];
  safe.assertions.forEach((item) => rows.push([item.label, item.state, item.confidence, item.statement, item.basis.join(" | "), item.missingEvidence.join(" | "), String(item.artifactIds.length)]));
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}

export function deepCasePrintableHtml(deepCase: DeepAnalysisCase): string {
  const safe = redactDeepCase(deepCase);
  const narrative = safe.narrative;
  const list = (items: string[] | undefined) => `<ul>${(items ?? []).map((item) => `<li>${escapeHtml(item)}</li>`).join("") || "<li>None</li>"}</ul>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(safe.title)}</title><style>
  body{font:16px/1.55 Segoe UI,sans-serif;color:#15242b;max-width:1100px;margin:40px auto;padding:0 24px}h1{font-size:34px;line-height:1.1}h2{margin-top:34px;border-bottom:2px solid #153c49;padding-bottom:7px}.meta{color:#52666f}.notice{padding:12px;border:1px solid #a67c25;background:#fff8dc}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.box{border:1px solid #aebdc3;padding:14px}.state{font-weight:700;text-transform:uppercase;font-size:12px}.Observed{color:#087f92}.Supported{color:#8a5a00}.Contradicted{color:#a62323}.Not-Evaluated{color:#637079}@media(max-width:700px){.grid{grid-template-columns:1fr}}@media print{body{margin:0}.notice{break-inside:avoid}}</style></head><body>
  <p class="notice"><b>Redacted advisory report.</b> Validate all conclusions against approved current evidence before operational changes.</p>
  <h1>${escapeHtml(narrative?.headline ?? safe.title)}</h1><p class="meta">Case ${escapeHtml(safe.id)} · Updated ${escapeHtml(safe.updatedAt)} · Root SPID ${escapeHtml(safe.rootSessionId ?? "Unknown")}</p>
  <h2>Investigation summary</h2><div class="grid"><div class="box"><b>Established</b>${list(narrative?.established)}</div><div class="box"><b>Supported</b>${list(narrative?.supported)}</div><div class="box"><b>Contradicted</b>${list(narrative?.contradicted)}</div><div class="box"><b>Unanswered</b>${list(narrative?.unanswered)}</div></div>
  <h2>Evidence ledger</h2>${safe.assertions.map((item) => `<article class="box"><span class="state ${escapeHtml(item.state.replaceAll(" ", "-"))}">${escapeHtml(item.state)} · ${escapeHtml(item.confidence)} confidence</span><h3>${escapeHtml(item.label)}</h3><p>${escapeHtml(item.statement)}</p><b>Basis</b>${list(item.basis)}<b>Still needed</b>${list(item.missingEvidence)}</article>`).join("")}
  <h2>Next check</h2><p>${escapeHtml(narrative?.nextCheck ?? "No next check available.")}</p></body></html>`;
}
