import type { AnalysisReport, Finding, FindingCapDisclosure, WhoIsActiveRecord } from "../types";
import { escapeHtml } from "./utils";

export function safeExternalUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

function redactSql(value: string | null): string | null {
  if (!value) return value;
  return "[redacted SQL]";
}

function redactPlanWarning(value: string): string {
  return /^plan-affecting conversion:/i.test(value) ? "Plan-affecting conversion: [redacted expression]" : value;
}

const SENSITIVE_EVIDENCE_LABEL = /(?:sql|command|database|host|login|program|parameter|object|predicate|expression|warning|statement text|table|column|index)/i;

function redactFinding(finding: Finding): Finding {
  return {
    ...finding,
    evidence: finding.evidence.map((item) => SENSITIVE_EVIDENCE_LABEL.test(item.label) ? { ...item, value: "[redacted]" } : item),
    blockingContext: finding.blockingContext ? {
      ...finding.blockingContext,
      databaseName: finding.blockingContext.databaseName ? "[redacted]" : null,
      commandPreview: finding.blockingContext.commandPreview ? "[redacted command preview]" : null,
    } : undefined,
  };
}

function redactRecord(record: WhoIsActiveRecord): WhoIsActiveRecord {
  const original: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(record.original)) original[key] = "[redacted]";
  return {
    ...record,
    loginName: record.loginName ? "[redacted]" : null,
    hostName: record.hostName ? "[redacted]" : null,
    programName: record.programName ? "[redacted]" : null,
    databaseName: record.databaseName ? "[redacted]" : null,
    sqlText: redactSql(record.sqlText),
    sqlCommand: redactSql(record.sqlCommand),
    queryPlanXml: record.queryPlanXml ? "[redacted plan XML]" : null,
    original,
  };
}

export function redactReport(report: AnalysisReport): AnalysisReport {
  return {
    ...report,
    redacted: true,
    records: report.records.map(redactRecord),
    plans: report.plans.map((plan) => ({
      ...plan,
      statements: plan.statements.map((statement) => ({
        ...statement,
        statementText: redactSql(statement.statementText) ?? "",
        queryIdentity: undefined,
        warnings: statement.warnings.map(redactPlanWarning),
        operators: statement.operators.map((operator) => ({
          ...operator,
          objectName: operator.objectName ? "[redacted object]" : undefined,
          predicate: operator.predicate ? "[redacted expression]" : operator.predicate,
          seekPredicate: operator.seekPredicate ? "[redacted expression]" : operator.seekPredicate,
          residualPredicate: operator.residualPredicate ? "[redacted expression]" : operator.residualPredicate,
          nonSargablePredicate: operator.nonSargablePredicate ? "[redacted expression]" : operator.nonSargablePredicate,
          warnings: operator.warnings.map(redactPlanWarning),
        })),
      })),
    })),
    findings: report.findings.map(redactFinding),
  };
}

export function downloadBlob(name: string, content: BlobPart, type: string): void {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([content], { type }));
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function csvCell(value: unknown): string {
  const text = String(value ?? "");
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

function findingCapMessage(cap: FindingCapDisclosure): string {
  return `${cap.suppressedCount} additional ${cap.ruleId} findings were suppressed after retaining ${cap.retainedCount}, ordered by ${cap.order.toLowerCase()}.`;
}

export function findingsCsv(findings: Finding[], findingCaps: FindingCapDisclosure[] = []): string {
  const byId = new Map(findings.map((finding) => [finding.id, finding]));
  const rows = [["Severity", "Confidence", "Confidence basis", "Limitations", "Category", "Rule", "Deep Analysis profile", "Title", "Summary", "Timeline", "Related signals", "Next capture", "Evidence", "Blocking context", "Diagnostic tools", "Remediation", "References"]];
  for (const item of findings) rows.push([
    item.severity, item.confidence, item.confidenceReason ?? "", (item.limitations ?? []).join(" | "), item.category, item.ruleId, item.deepAnalysisProfile ?? "", item.title, item.summary,
    item.timeline ? `${item.timeline.metric}: ${item.timeline.direction}; first ${item.timeline.firstValue} ${item.timeline.unit}; peak ${item.timeline.peakValue}; latest ${item.timeline.latestValue}; ${item.timeline.points.length} points` : "",
    (item.relatedFindings ?? []).map((link) => `${byId.get(link.findingId)?.title ?? link.findingId}: ${link.reason}`).join(" | "),
    item.nextCapture ? `${item.nextCapture.title}: ${item.nextCapture.reason}${item.nextCapture.command ? ` | ${item.nextCapture.command}` : ""}` : "",
    item.evidence.map((evidence) => `${evidence.label}: ${evidence.value}`).join(" | "),
    item.blockingContext ? `Root blocker: ${item.blockingContext.headBlockerSessionId} | Chain: ${(item.blockingContext.participants ?? []).map((participant) => `${participant.sessionId} (${participant.role}${participant.blockedBySessionId ? `, blocked by ${participant.blockedBySessionId}` : ""})`).join(" -> ") || "not supplied"} | Blocked SPIDs: ${item.blockingContext.blockedSessionIds.join(", ")}${item.blockingContext.totalBlockedSessions > item.blockingContext.blockedSessionIds.length ? ` | ${item.blockingContext.totalBlockedSessions - item.blockingContext.blockedSessionIds.length} more reported` : ""}${item.blockingContext.commandPreview ? ` | ${item.blockingContext.commandLabel}: ${item.blockingContext.commandPreview}` : ""}` : "",
    (item.diagnosticTools ?? []).map((tool) => `${tool.name}: ${tool.command ?? tool.purpose}`).join(" | "),
    item.remediation.join(" | "), item.references.map((reference) => reference.url).join(" | "),
  ]);
  for (const cap of findingCaps) rows.push([
    "Informational", "High", "Exact count from the bounded rule output.", "", "Data quality", "FINDING-CAP", "", `${cap.ruleId} findings truncated`, findingCapMessage(cap), "", "", "", "", "", "", "Review the retained findings and exported suppression count together.", "",
  ]);
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}

export function printableReport(report: AnalysisReport): string {
  const counts = ["High", "Medium", "Low", "Informational", "Not Evaluated"].map((severity) => ({ severity, count: report.findings.filter((finding) => finding.severity === severity).length }));
  const byId = new Map(report.findings.map((finding) => [finding.id, finding]));
  const capAudit = (report.dataQuality.findingCaps ?? []).length ? `<section class="audit"><h2>Finding-cap disclosures</h2><ul>${report.dataQuality.findingCaps!.map((cap) => `<li>${escapeHtml(findingCapMessage(cap))}</li>`).join("")}</ul></section>` : "";
  const findings = report.findings.map((item) => `
    <article class="finding ${item.severity.toLowerCase().replace(" ", "-")}">
      <div class="eyebrow">${escapeHtml(item.severity)} · ${escapeHtml(item.confidence)} confidence · ${escapeHtml(item.category)}${item.deepAnalysisProfile ? ` · Deep Analysis: ${escapeHtml(item.deepAnalysisProfile)}` : ""}</div>
      <h2>${escapeHtml(item.title)}</h2><p>${escapeHtml(item.summary)}</p>
      ${item.blockingContext ? `<div class="blocking"><b>Root blocker SPID ${item.blockingContext.headBlockerSessionId}</b>${item.blockingContext.participants?.length ? `<p>Resolved chain: ${item.blockingContext.participants.map((participant) => `${escapeHtml(participant.sessionId)} (${escapeHtml(participant.role)}${participant.blockedBySessionId ? `, blocked by ${escapeHtml(participant.blockedBySessionId)}` : ""})`).join(" · ")}</p>` : ""}<p>Blocked SPIDs: ${escapeHtml(item.blockingContext.blockedSessionIds.join(", ") || "not supplied")}${item.blockingContext.totalBlockedSessions > item.blockingContext.blockedSessionIds.length ? ` · +${item.blockingContext.totalBlockedSessions - item.blockingContext.blockedSessionIds.length} more reported` : ""}</p>${item.blockingContext.commandPreview ? `<pre><code>${escapeHtml(item.blockingContext.commandLabel ?? "Captured command")}: ${escapeHtml(item.blockingContext.commandPreview)}</code></pre>` : ""}</div>` : ""}
      ${item.confidenceReason || item.timeline || item.nextCapture || item.relatedFindings?.length ? `<div class="investigation"><h3>Investigation context</h3>${item.confidenceReason ? `<b>${escapeHtml(item.confidence)} confidence</b><p>${escapeHtml(item.confidenceReason)}</p>` : ""}${item.limitations?.length ? `<ul>${item.limitations.map((limitation) => `<li>${escapeHtml(limitation)}</li>`).join("")}</ul>` : ""}${item.timeline ? `<p><b>${escapeHtml(item.timeline.metric)}:</b> ${escapeHtml(item.timeline.direction)} · first ${escapeHtml(item.timeline.firstValue)} ${escapeHtml(item.timeline.unit)} · peak ${escapeHtml(item.timeline.peakValue)} · latest ${escapeHtml(item.timeline.latestValue)} · ${item.timeline.points.length} capture point${item.timeline.points.length === 1 ? "" : "s"}</p>` : ""}${item.relatedFindings?.length ? `<p><b>Related signals:</b> ${item.relatedFindings.map((link) => `${escapeHtml(byId.get(link.findingId)?.title ?? link.findingId)} (${escapeHtml(link.reason)})`).join(" · ")}</p>` : ""}${item.nextCapture ? `<h4>${escapeHtml(item.nextCapture.title)}</h4><p>${escapeHtml(item.nextCapture.reason)}</p><ul>${item.nextCapture.expectedEvidence.map((evidence) => `<li>${escapeHtml(evidence)}</li>`).join("")}</ul>${item.nextCapture.command ? `<pre><code>${escapeHtml(item.nextCapture.command)}</code></pre>` : ""}${item.nextCapture.caution ? `<small>${escapeHtml(item.nextCapture.caution)}</small>` : ""}` : ""}</div>` : ""}
      <dl>${item.evidence.map((evidence) => `<div><dt>${escapeHtml(evidence.label)}</dt><dd>${escapeHtml(evidence.value)}</dd></div>`).join("")}</dl>
      ${(item.diagnosticTools ?? []).length ? `<h3>Suggested diagnostic tools</h3>${(item.diagnosticTools ?? []).map((tool) => `<div class="tool"><b>${escapeHtml(tool.name)}</b><p>${escapeHtml(tool.purpose)}</p>${tool.command ? `<pre><code>${escapeHtml(tool.command)}</code></pre>` : ""}${tool.caution ? `<small>${escapeHtml(tool.caution)}</small>` : ""}</div>`).join("")}` : ""}
      ${item.remediation.length ? `<h3>Recommended next steps</h3><ol>${item.remediation.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ol>` : ""}
      ${item.references.some((reference) => safeExternalUrl(reference.url)) ? `<p class="refs">${item.references.flatMap((reference) => { const url = safeExternalUrl(reference.url); return url ? [`<a href="${escapeHtml(url)}">${escapeHtml(reference.label)}</a>`] : []; }).join(" · ")}</p>` : ""}
    </article>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>SQL Evaluate report</title><style>
  :root{font-family:Aptos,Segoe UI,sans-serif;color:#142333;background:#eef3f6}body{max-width:1100px;margin:0 auto;padding:48px 30px}header{border-bottom:4px solid #14b8d4;padding-bottom:24px;margin-bottom:24px}h1{font:700 34px Bahnschrift,Aptos,sans-serif;letter-spacing:.02em;margin:0 0 8px}.summary{display:flex;gap:10px;flex-wrap:wrap}.pill{border:1px solid #c5d1da;background:white;padding:8px 12px}.audit{background:#fff7df;border:1px solid #d4a514;padding:14px 20px;margin:14px 0}.finding{break-inside:avoid;background:#fff;border-left:5px solid #78909c;margin:14px 0;padding:20px 24px;box-shadow:0 2px 8px #14304412}.finding.high{border-color:#c62828}.finding.medium{border-color:#ed7d20}.finding.low{border-color:#d4a514}.finding.informational{border-color:#1689a7}.finding.not-evaluated{border-color:#718096}.eyebrow{text-transform:uppercase;font-size:11px;font-weight:700;letter-spacing:.1em}h2{font-size:20px;margin:7px 0}p,li{line-height:1.45}dl{display:flex;gap:20px;flex-wrap:wrap}dt{font-size:11px;text-transform:uppercase;color:#536878}dd{margin:2px 0;font-weight:700}.blocking,.investigation,.tool{border:1px solid #c5d1da;padding:12px;margin:8px 0}.blocking p,.tool p{margin:5px 0}.blocking pre,.investigation pre,.tool pre{white-space:pre-wrap;background:#eef3f6;padding:10px}.investigation small,.tool small{color:#6a5723}.refs a{color:#07627a}@media print{body{padding:0;background:#fff}.finding{box-shadow:none;border-top:1px solid #ddd}}
  </style></head><body><header><div class="eyebrow">Offline SQL diagnostic</div><h1>SQL Evaluate report</h1><p>Created ${escapeHtml(new Date(report.createdAt).toLocaleString())} · ${report.records.length.toLocaleString()} activity rows · ${report.plans.length} plans</p><div class="summary">${counts.map((item) => `<span class="pill"><b>${item.count}</b> ${escapeHtml(item.severity)}</span>`).join("")}</div></header>${capAudit}${findings}</body></html>`;
}

export function validateReport(value: unknown): AnalysisReport {
  if (!value || typeof value !== "object") throw new Error("Report JSON is not an object.");
  const report = value as Partial<AnalysisReport>;
  const object = (item: unknown): item is Record<string, unknown> => Boolean(item) && typeof item === "object";
  const strings = (item: unknown): item is string[] => Array.isArray(item) && item.every((entry) => typeof entry === "string");
  const inputValid = (item: unknown) => object(item) && typeof item.id === "string" && typeof item.fileName === "string" && strings(item.recognizedColumns) && strings(item.unknownColumns) && strings(item.warnings);
  const recordValid = (item: unknown) => object(item) && typeof item.id === "string" && typeof item.sourceId === "string" && object(item.original);
  const operatorValid = (item: unknown) => object(item) && typeof item.id === "string" && typeof item.physicalOp === "string" && typeof item.logicalOp === "string" && strings(item.warnings);
  const statementValid = (item: unknown) => object(item) && typeof item.id === "string" && typeof item.statementText === "string" && typeof item.statementType === "string" && Array.isArray(item.operators) && item.operators.every(operatorValid) && strings(item.warnings);
  const planValid = (item: unknown) => object(item) && typeof item.id === "string" && typeof item.sourceId === "string" && (item.sourceRecordId === undefined || typeof item.sourceRecordId === "string") && typeof item.fileName === "string" && Array.isArray(item.statements) && item.statements.every(statementValid) && strings(item.warnings);
  const timelineValid = (item: unknown) => object(item) && typeof item.metric === "string" && ["sessions", "milliseconds", "seconds", "percent"].includes(String(item.unit)) && ["Increasing", "Decreasing", "Stable", "Single observation"].includes(String(item.direction)) && typeof item.firstValue === "number" && typeof item.latestValue === "number" && typeof item.peakValue === "number" && Array.isArray(item.points) && item.points.length <= 72 && item.points.every((point) => object(point) && typeof point.capturedAt === "string" && typeof point.value === "number");
  const captureValid = (item: unknown) => object(item) && typeof item.title === "string" && typeof item.reason === "string" && (item.command === undefined || typeof item.command === "string") && strings(item.expectedEvidence) && (item.caution === undefined || typeof item.caution === "string");
  const relatedValid = (item: unknown) => object(item) && typeof item.findingId === "string" && typeof item.reason === "string";
  const blockingParticipantValid = (item: unknown) => object(item) && typeof item.sessionId === "number" && (item.blockedBySessionId === null || typeof item.blockedBySessionId === "number") && ["Root", "Intermediate", "Victim"].includes(String(item.role)) && (item.status === null || typeof item.status === "string") && (item.openTransactionCount === null || typeof item.openTransactionCount === "number") && (item.waitType === null || typeof item.waitType === "string") && (item.waitDurationMs === null || typeof item.waitDurationMs === "number");
  const findingValid = (item: unknown) => object(item)
    && typeof item.id === "string" && typeof item.ruleId === "string" && typeof item.severity === "string" && typeof item.confidence === "string"
    && typeof item.category === "string" && typeof item.title === "string" && typeof item.summary === "string" && typeof item.explanation === "string"
    && strings(item.remediation) && strings(item.affectedRecordIds) && strings(item.affectedPlanIds)
    && (item.confidenceReason === undefined || typeof item.confidenceReason === "string")
    && (item.limitations === undefined || strings(item.limitations))
    && (item.timeline === undefined || timelineValid(item.timeline))
    && (item.nextCapture === undefined || captureValid(item.nextCapture))
    && (item.relatedFindings === undefined || (Array.isArray(item.relatedFindings) && item.relatedFindings.length <= 5 && item.relatedFindings.every(relatedValid)))
    && (item.deepAnalysisProfile === undefined || typeof item.deepAnalysisProfile === "string")
    && (item.blockingContext === undefined || (object(item.blockingContext) && typeof item.blockingContext.headBlockerSessionId === "number" && Array.isArray(item.blockingContext.blockedSessionIds) && item.blockingContext.blockedSessionIds.every((entry) => typeof entry === "number") && typeof item.blockingContext.totalBlockedSessions === "number" && (item.blockingContext.status === null || typeof item.blockingContext.status === "string") && (item.blockingContext.databaseName === null || typeof item.blockingContext.databaseName === "string") && (item.blockingContext.openTransactionCount === null || typeof item.blockingContext.openTransactionCount === "number") && (item.blockingContext.commandLabel === null || typeof item.blockingContext.commandLabel === "string") && (item.blockingContext.commandPreview === null || typeof item.blockingContext.commandPreview === "string") && (item.blockingContext.participants === undefined || (Array.isArray(item.blockingContext.participants) && item.blockingContext.participants.every(blockingParticipantValid))) && (item.blockingContext.maxChainDepth === undefined || typeof item.blockingContext.maxChainDepth === "number") && (item.blockingContext.chainComplete === undefined || typeof item.blockingContext.chainComplete === "boolean")))
    && (item.diagnosticTools === undefined || (Array.isArray(item.diagnosticTools) && item.diagnosticTools.every((entry) => object(entry) && typeof entry.name === "string" && typeof entry.purpose === "string" && (entry.command === undefined || typeof entry.command === "string") && (entry.caution === undefined || typeof entry.caution === "string"))))
    && Array.isArray(item.evidence) && item.evidence.every((entry) => object(entry) && typeof entry.label === "string" && typeof entry.value === "string")
    && Array.isArray(item.references) && item.references.every((entry) => object(entry) && typeof entry.label === "string" && typeof entry.url === "string" && safeExternalUrl(entry.url) !== null);
  const countValid = (item: unknown): item is number => typeof item === "number" && Number.isSafeInteger(item) && item >= 0;
  const findingCapValid = (item: unknown) => object(item) && typeof item.ruleId === "string" && Boolean(item.ruleId.trim()) && countValid(item.retainedCount) && countValid(item.suppressedCount) && item.suppressedCount > 0 && item.order === "Descending diagnostic impact";
  const qualityValid = object(report.dataQuality) && strings(report.dataQuality.presentColumns) && strings(report.dataQuality.missingColumns) && strings(report.dataQuality.unknownColumns) && strings(report.dataQuality.warnings) && strings(report.dataQuality.notEvaluatedRules) && (report.dataQuality.suppressedSignals === undefined || strings(report.dataQuality.suppressedSignals)) && (report.dataQuality.findingCaps === undefined || Array.isArray(report.dataQuality.findingCaps) && report.dataQuality.findingCaps.every(findingCapValid));
  if (report.schemaVersion !== "1.0" || typeof report.createdAt !== "string" || typeof report.redacted !== "boolean"
    || !Array.isArray(report.inputs) || !report.inputs.every(inputValid)
    || !Array.isArray(report.records) || !report.records.every(recordValid)
    || !Array.isArray(report.plans) || !report.plans.every(planValid)
    || !Array.isArray(report.findings) || !report.findings.every(findingValid)
    || !qualityValid) throw new Error("This is not a compatible SQL Evaluate report.");
  return report as AnalysisReport;
}
