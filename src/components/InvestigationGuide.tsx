import { useState } from "react";
import type { Finding, InvestigationGuide as InvestigationGuideModel } from "../types";
import { deepAnalysisProfileForFinding } from "../deepAnalysis/profile";
import { formatDuration } from "../lib/utils";

interface Props {
  guide: InvestigationGuideModel;
  findings: Finding[];
  onSelectFinding(finding: Finding): void;
  onDeepAnalysis(finding: Finding): void;
  onUpload(): void;
}

export function InvestigationGuide({ guide, findings, onSelectFinding, onDeepAnalysis, onUpload }: Props) {
  const [copied, setCopied] = useState<string | null>(null);
  const byId = new Map(findings.map((finding) => [finding.id, finding]));
  const copy = async (id: string, command: string) => {
    try { await navigator.clipboard.writeText(command); setCopied(id); }
    catch { setCopied(`failed:${id}`); }
    window.setTimeout(() => setCopied((current) => current === id || current === `failed:${id}` ? null : current), 1800);
  };
  const renderStep = (step: InvestigationGuideModel["steps"][number]) => {
    const target = step.targetFindingId ? byId.get(step.targetFindingId) : undefined;
    const resolvedDeepProfile = target ? deepAnalysisProfileForFinding(target) : null;
    const deepAnalysisReady = Boolean(step.deepAnalysisProfile && resolvedDeepProfile === step.deepAnalysisProfile);
    return <li key={step.id}>
      <span className="guide-order">{String(step.order).padStart(2, "0")}</span>
      <div className="guide-step-copy"><div><b>{step.actionType}</b>{step.deepAnalysisProfile && <em>{deepAnalysisReady ? "Deep Analysis ready" : "Deep Analysis unavailable"}</em>}</div><h3>{step.title}</h3><p>{step.reason}</p>{step.condition && <p className="guide-condition"><strong>When:</strong> {step.condition}</p>}<small>Expected: {step.expectedEvidence.join(" · ") || "Review the linked evidence"}</small>{step.caution && <aside><strong>Caution</strong>{step.caution}</aside>}</div>
      <div className="guide-step-actions">
        {step.actionType === "Upload" && <button type="button" className="button button-primary" onClick={onUpload}>Choose plan</button>}
        {step.command && <button type="button" className="button" onClick={() => void copy(step.id, step.command!)}>{copied === step.id ? "Copied" : copied === `failed:${step.id}` ? "Copy failed" : "Copy command"}</button>}
        {target && <button type="button" className="button" onClick={() => onSelectFinding(target)}>Open evidence</button>}
        {target && deepAnalysisReady && <button type="button" className="button" onClick={() => onDeepAnalysis(target)}>Deep Analysis</button>}
        {step.deepAnalysisProfile && !deepAnalysisReady && <span className="guide-action-unavailable">This profile is not available in this app version.</span>}
      </div>
    </li>;
  };
  const [firstStep, ...laterSteps] = guide.steps;
  return <section id="investigation-guide" tabIndex={-1} className="investigation-guide" aria-labelledby="investigation-guide-title">
    <div className="guide-heading"><div><span>RECOMMENDED INVESTIGATION ORDER</span><h2 id="investigation-guide-title">Start here</h2></div><p>{guide.conclusion}</p></div>
    {guide.subjects.length > 0 && <div className="guide-subjects" aria-label="Investigation subjects">{guide.subjects.map((subject) => <article key={subject.id}>
      <div><span>SUBJECT</span><strong>Session {subject.sessionId ?? "unknown"}</strong><small>{subject.requestId === null ? "Request unknown" : `Request ${subject.requestId}`} · last {subject.lastStatus ?? "status unavailable"}</small></div>
      <dl><div><dt>Runtime</dt><dd>{formatDuration(subject.durationSeconds)}</dd></div><div><dt>Last observed</dt><dd>{subject.lastObservedAt ? new Date(subject.lastObservedAt).toLocaleString() : "Not supplied"}</dd></div><div><dt>Completion</dt><dd>{subject.completion}</dd></div><div><dt>Blocking observed</dt><dd>{subject.blockingObserved ? "Yes" : "No relationship captured"}</dd></div></dl>
      <ul className="guide-resources">{subject.resourceSummary.slice(1).map((item) => <li key={item.label}><span>{item.label}</span><b>{item.value}</b></li>)}</ul>
      <p>{subject.primaryEvidenceGap}</p>
    </article>)}</div>}
    {firstStep && <ol className="guide-steps">{renderStep(firstStep)}</ol>}
    {laterSteps.length > 0 && <details className="guide-more"><summary>Show {laterSteps.length} follow-up step{laterSteps.length === 1 ? "" : "s"}</summary><ol className="guide-steps" start={2}>{laterSteps.map(renderStep)}</ol></details>}
    {!guide.steps.length && <div className="guide-empty">No escalation step is indicated from the supplied capture. Review data-quality limits before treating this as a baseline.</div>}
    {guide.missingEvidence.length > 0 && <details className="guide-gaps"><summary>{guide.missingEvidence.length} evidence gap{guide.missingEvidence.length === 1 ? "" : "s"}</summary><ul>{guide.missingEvidence.map((gap) => <li key={gap}>{gap}</li>)}</ul></details>}
  </section>;
}
