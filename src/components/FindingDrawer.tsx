import { useEffect, useRef, useState } from "react";
import type { BlockingContext, Finding } from "../types";
import { safeExternalUrl } from "../lib/report";
import { formatDuration, formatNumber } from "../lib/utils";
import { SeverityBadge } from "./SeverityBadge";
import { deepAnalysisProfileForFinding, profileLabel } from "../deepAnalysis/profile";

function copyWithSelectionFallback(command: string): boolean {
  const textarea = document.createElement("textarea");
  textarea.value = command;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.inset = "-9999px auto auto -9999px";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  return copied;
}

function BlockingContextPanel({ context }: { context: BlockingContext }) {
  const remaining = Math.max(0, context.totalBlockedSessions - context.blockedSessionIds.length);
  const participants = context.participants ?? [];
  return <section className="blocking-context" aria-labelledby="blocking-context-title">
    <div className="blocking-context-title"><div><span>CHAIN / ROOT</span><h3 id="blocking-context-title">Root blocking incident</h3></div><strong><small>SPID</small>{context.headBlockerSessionId}</strong></div>
    <dl className="blocker-facts">
      <div><dt>Status</dt><dd>{context.status ?? "Not supplied"}</dd></div>
      <div><dt>Database</dt><dd>{context.databaseName ?? "Not supplied"}</dd></div>
      <div><dt>Open transactions</dt><dd>{context.openTransactionCount ?? "Not supplied"}</dd></div>
    </dl>
    {participants.length > 0 && <div className="blocking-chain-map"><div className="chain-map-head"><span>Resolved blocking chain</span><small>{context.maxChainDepth ?? 1} level{context.maxChainDepth === 1 ? "" : "s"} · {context.chainComplete === false ? "Incomplete evidence" : "Complete in capture"}</small></div><ol>{participants.map((participant) => <li className={`chain-${participant.role.toLowerCase()}`} key={`${participant.role}-${participant.sessionId}`}><i aria-hidden="true" /><div><span>{participant.role}</span><strong>SPID {participant.sessionId}</strong></div><p>{participant.blockedBySessionId ? <>Blocked by <b>{participant.blockedBySessionId}</b></> : "Chain origin"}</p><small>{participant.status ?? "status unknown"}{participant.waitType ? ` · ${participant.waitType}${participant.waitDurationMs !== null ? ` ${formatNumber(participant.waitDurationMs)} ms` : ""}` : ""}</small></li>)}</ol></div>}
    <div className="blocked-sessions"><span>Blocked SPIDs · longest reported waits first</span><div>{context.blockedSessionIds.map((sessionId) => <b key={sessionId}>{sessionId}</b>)}{remaining > 0 && <b className="more-spids">+ {remaining} more</b>}{!context.blockedSessionIds.length && <em>Individual victim SPIDs were not supplied.</em>}</div></div>
    <div className="blocker-command"><div><span>{context.commandLabel ?? "Captured command"}</span><small>Sensitive local detail</small></div>{context.commandPreview ? <code>{context.commandPreview}</code> : <p>No blocker statement or outer command was supplied in this capture.</p>}</div>
  </section>;
}

function timelineValue(value: number, unit: NonNullable<Finding["timeline"]>["unit"]): string {
  if (unit === "seconds") return formatDuration(value);
  if (unit === "milliseconds") return `${formatNumber(value)} ms`;
  if (unit === "percent") return `${formatNumber(value)}%`;
  return `${formatNumber(value)} session${value === 1 ? "" : "s"}`;
}

function TimelineGraphic({ timeline }: { timeline: NonNullable<Finding["timeline"]> }) {
  const width = 300;
  const height = 54;
  const minimum = Math.min(...timeline.points.map((point) => point.value));
  const maximum = Math.max(...timeline.points.map((point) => point.value));
  const range = Math.max(1, maximum - minimum);
  const coordinates = timeline.points.map((point, index) => {
    const x = timeline.points.length === 1 ? width / 2 : index / (timeline.points.length - 1) * width;
    const y = height - 5 - (point.value - minimum) / range * (height - 10);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return <svg className="finding-timeline" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${timeline.metric}: ${timeline.direction}; first ${timelineValue(timeline.firstValue, timeline.unit)}, peak ${timelineValue(timeline.peakValue, timeline.unit)}, latest ${timelineValue(timeline.latestValue, timeline.unit)}.`} preserveAspectRatio="none"><line x1="0" y1={height - 5} x2={width} y2={height - 5} /><polyline points={coordinates} />{timeline.points.map((point, index) => { const [x, y] = coordinates.split(" ")[index].split(","); return <circle key={`${point.capturedAt}-${index}`} cx={x} cy={y} r="2.6"><title>{new Date(point.capturedAt).toLocaleString()}: {timelineValue(point.value, timeline.unit)}</title></circle>; })}</svg>;
}

function InvestigationContext({ finding, related, copiedCommand, onCopy, onSelectFinding }: { finding: Finding; related: Finding[]; copiedCommand: string | null; onCopy(command: string, key: string): void; onSelectFinding(finding: Finding): void }) {
  const hasContext = finding.confidenceReason || finding.timeline || finding.nextCapture || related.length || finding.limitations?.length;
  if (!hasContext) return null;
  const timeline = finding.timeline;
  const nextCapture = finding.nextCapture;
  return <section className="investigation-context" aria-labelledby="investigation-context-title">
    <div className="investigation-heading"><div><span>Evidence / next move</span><h3 id="investigation-context-title">Investigation context</h3></div><b>{finding.confidence} confidence</b></div>
    <div className="confidence-basis"><span>Why this confidence</span><p>{finding.confidenceReason ?? `${finding.confidence} confidence based on the supplied evidence.`}</p>{Boolean(finding.limitations?.length) && <ul>{finding.limitations!.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul>}</div>
    {timeline && <div className="timeline-card"><div className="timeline-title"><div><span>{timeline.metric}</span><strong>{timeline.direction}</strong></div><small>{timeline.points.length} capture point{timeline.points.length === 1 ? "" : "s"}</small></div><TimelineGraphic timeline={timeline} /><dl><div><dt>First</dt><dd>{timelineValue(timeline.firstValue, timeline.unit)}</dd></div><div><dt>Peak</dt><dd>{timelineValue(timeline.peakValue, timeline.unit)}</dd></div><div><dt>Latest</dt><dd>{timelineValue(timeline.latestValue, timeline.unit)}</dd></div></dl></div>}
    {related.length > 0 && <div className="related-signals"><span>Related signals</span><div>{related.map((item) => { const relationship = finding.relatedFindings?.find((link) => link.findingId === item.id)?.reason; return <button type="button" key={item.id} onClick={() => onSelectFinding(item)}><SeverityBadge severity={item.severity} /><span><strong>{item.title}</strong><small>{relationship}</small></span><b aria-hidden="true">→</b></button>; })}</div></div>}
    {nextCapture && <div className="next-capture"><div><span>What to capture next</span><strong>{nextCapture.title}</strong></div><p>{nextCapture.reason}</p><ul>{nextCapture.expectedEvidence.map((evidence) => <li key={evidence}>{evidence}</li>)}</ul>{nextCapture.command && <div className="command-block"><code>{nextCapture.command}</code><button type="button" onClick={() => onCopy(nextCapture.command!, "next-capture")} aria-label="Copy next capture command">{copiedCommand === "next-capture" ? "Copied" : copiedCommand === "failed" ? "Copy failed" : "Copy"}</button></div>}{nextCapture.caution && <small><b>Caution</b>{nextCapture.caution}</small>}<em>SQL Evaluate never executes this command.</em></div>}
  </section>;
}

export function FindingDrawer({ finding, relatedFindings = [], onSelectFinding, onDeepAnalysis, onShowActivity, onClose }: { finding: Finding | null; relatedFindings?: Finding[]; onSelectFinding?(finding: Finding): void; onDeepAnalysis?(finding: Finding): void; onShowActivity?(finding: Finding): void; onClose(): void }) {
  const drawer = useRef<HTMLElement>(null);
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null);
  useEffect(() => {
    if (!finding) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousBodyOverflow = document.body.style.overflow;
    const previousHtmlOverflow = document.documentElement.style.overflow;
    const handleKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    setCopiedCommand(null);
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    document.addEventListener("keydown", handleKey);
    drawer.current?.focus();
    drawer.current?.scrollTo({ top: 0 });
    return () => {
      document.removeEventListener("keydown", handleKey);
      document.body.style.overflow = previousBodyOverflow;
      document.documentElement.style.overflow = previousHtmlOverflow;
      previous?.focus();
    };
  }, [finding, onClose]);
  if (!finding) return null;
  const references = finding.references.flatMap((reference) => {
    const url = safeExternalUrl(reference.url);
    return url ? [{ ...reference, url }] : [];
  });
  const tools = finding.diagnosticTools ?? [];
  const deepProfile = deepAnalysisProfileForFinding(finding);
  const copyCommand = async (command: string, key: string) => {
    let copied = false;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
      await Promise.race([
        navigator.clipboard.writeText(command),
        new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error("Clipboard timed out")), 750)),
      ]);
      copied = true;
    } catch {
      copied = copyWithSelectionFallback(command);
    }
    setCopiedCommand(copied ? key : "failed");
    window.setTimeout(() => setCopiedCommand((current) => current === key || current === "failed" ? null : current), 1800);
  };
  return <div className="drawer-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
    <aside ref={drawer} tabIndex={-1} className="drawer" role="dialog" aria-modal="true" aria-labelledby="finding-title">
      <div className="drawer-head"><div className="drawer-flags"><SeverityBadge severity={finding.severity} /><span className={`confidence confidence-${finding.confidence.toLowerCase()}`}>{finding.confidence} conf.</span></div><button className="icon-button" onClick={onClose} aria-label="Close finding details">×</button></div>
      <div className="eyebrow">{finding.ruleId} · {finding.category}</div>
      <h2 id="finding-title">{finding.title}</h2>
      <p className="lead">{finding.summary}</p>
      {onDeepAnalysis && deepProfile && <button className="deep-launch" onClick={() => onDeepAnalysis(finding)}>Open {profileLabel(deepProfile)} Deep Analysis →</button>}
      {onShowActivity && finding.affectedRecordIds.length > 0 && <button type="button" className="activity-launch" onClick={() => onShowActivity(finding)}>Show {finding.affectedRecordIds.length} affected activity row{finding.affectedRecordIds.length === 1 ? "" : "s"} →</button>}
      {finding.blockingContext && <BlockingContextPanel context={finding.blockingContext} />}
      <InvestigationContext finding={finding} related={relatedFindings} copiedCommand={copiedCommand} onCopy={copyCommand} onSelectFinding={onSelectFinding ?? (() => undefined)} />
      <section><h3>Why this matters</h3><p>{finding.explanation}</p></section>
      {finding.evidence.length > 0 && <section><h3>Observed evidence</h3><dl className="evidence-list">{finding.evidence.map((item) => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl></section>}
      {tools.length > 0 && <section><h3>Suggested diagnostic tools</h3><p className="tool-intro">Optional, read-only investigation steps. SQL Evaluate never executes these commands.</p><div className="tool-list">{tools.map((tool, index) => { const copyKey = `tool-${index}`; return <article className="tool-card" key={`${tool.name}-${index}`}><div className="tool-card-head"><span>{String(index + 1).padStart(2, "0")}</span><strong>{tool.name}</strong></div><p>{tool.purpose}</p>{tool.command && <div className="command-block"><code>{tool.command}</code><button type="button" onClick={() => copyCommand(tool.command!, copyKey)} aria-label={`Copy ${tool.name} command`}>{copiedCommand === copyKey ? "Copied" : copiedCommand === "failed" ? "Copy failed" : "Copy"}</button></div>}{tool.caution && <small><b>Caution</b>{tool.caution}</small>}</article>; })}</div></section>}
      {finding.remediation.length > 0 && <section><h3>Recommended next steps</h3><ol className="steps">{finding.remediation.map((step, index) => <li key={index}>{step}</li>)}</ol></section>}
      {references.length > 0 && <section><h3>Documentation &amp; tools</h3><div className="reference-list">{references.map((reference) => <a key={reference.url} href={reference.url} target="_blank" rel="noreferrer">{reference.label}<span aria-hidden="true">↗</span></a>)}</div></section>}
      <div className="caution"><strong>Advisory only.</strong> Verify against workload context before changing SQL, indexes, configuration, or sessions.</div>
    </aside>
  </div>;
}
