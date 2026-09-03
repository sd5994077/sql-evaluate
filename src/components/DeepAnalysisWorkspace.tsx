import { useRef, useState } from "react";
import type { Finding } from "../types";
import type { DeepAnalysisCase, DeepCollectionStep, DeepEvidenceState, EvidenceImportMessage } from "../deepAnalysis/types";
import { isPlanImportMessage } from "../deepAnalysis/importMessages";
import { DEEP_ANALYSIS_PROFILE_CATALOG } from "../deepAnalysis/profile";
import { deepAnalysisProfileForFinding, profileLabel } from "../deepAnalysis/profile";
import { deepCaseFindingsCsv, deepCaseJson, deepCasePrintableHtml } from "../deepAnalysis/report";
import { recommendedSpillStepId } from "../deepAnalysis/toolCatalog";
import { resolveCandidatePlan } from "../deepAnalysis/spillTriage";
import { downloadBlob } from "../lib/report";
import { formatNumber } from "../lib/utils";
import { SeverityBadge } from "./SeverityBadge";
import { SpillTriagePanel } from "./SpillTriagePanel";

interface Props {
  deepCase: DeepAnalysisCase | null;
  recommendations: Finding[];
  busy: boolean;
  onStart(finding: Finding): void;
  onStartSpillTriage(): void;
  onSelectSpillCandidate(candidateId: string): void;
  onChooseSpillPlan(candidateId: string, artifactId: string, statementId: string): void;
  onClearSpillPlan(candidateId: string): void;
  onImport(files: File[]): void;
  onSave(): void;
  onOpen(file: File): void;
  estimateThresholds: { ratio: number; rows: number };
  importMessages?: EvidenceImportMessage[];
}

const stateOrder: DeepEvidenceState[] = ["Observed", "Supported", "Contradicted", "Not Evaluated"];
const causalOrder = ["plan-cache-pressure", "compilation-pressure", "scheduler-pressure", "root-runnable", "open-transactions", "root-lock-owner", "blocking-chain"];

function copyFallback(text: string): boolean {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.setAttribute("readonly", "");
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  return copied;
}

function stateClass(state: DeepEvidenceState): string {
  return state.toLowerCase().replace(" ", "-");
}

function EvidenceStateBadge({ state }: { state: DeepEvidenceState }) {
  return <span className={`deep-state deep-state-${stateClass(state)}`}><i aria-hidden="true" />{state}</span>;
}

function DeepShareActions({ deepCase }: { deepCase: DeepAnalysisCase }) {
  return <div className="deep-share-actions"><span>REDACTED HANDOFF</span><button onClick={() => downloadBlob(`SQL-Evaluate_${deepCase.id}_redacted.json`, deepCaseJson(deepCase), "application/json")}>JSON</button><button onClick={() => downloadBlob(`SQL-Evaluate_${deepCase.id}_assertions.csv`, deepCaseFindingsCsv(deepCase), "text/csv;charset=utf-8")}>CSV</button><button onClick={() => downloadBlob(`SQL-Evaluate_${deepCase.id}_report.html`, deepCasePrintableHtml(deepCase), "text/html;charset=utf-8")}>Print HTML</button><small>These allowlisted reports are not reopenable. The working case ZIP remains raw and sensitive.</small></div>;
}

function CollectionRecipe({ steps, recommendedId, caseId }: { steps: DeepCollectionStep[]; recommendedId?: string; caseId: string }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const selected = steps.find((item) => item.id === selectedId) ?? steps.find((item) => item.id === recommendedId) ?? steps[0];
  if (!selected) return null;
  const tabPrefix = `diagnostic-${caseId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const unavailable = selected.availability === "Unavailable";
  const copyCommand = async () => {
    if (unavailable) return;
    try { await navigator.clipboard.writeText(selected.command); setCopied(true); }
    catch { setCopied(copyFallback(selected.command)); }
    window.setTimeout(() => setCopied(false), 1800);
  };
  const moveTabFocus = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const tabs = [...(event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])];
    const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : event.key === "ArrowRight" ? (index + 1) % tabs.length : (index - 1 + tabs.length) % tabs.length;
    tabs[nextIndex]?.focus();
    tabs[nextIndex]?.click();
  };
  return <section className="deep-recipe diagnostic-ladder" aria-labelledby="diagnostic-ladder-title">
    <div className="deep-section-title"><div><span>EVIDENCE ACQUISITION LADDER</span><h3 id="diagnostic-ladder-title">{selected.title}</h3></div><span className={`overhead overhead-${selected.overhead.toLowerCase()}`}>{selected.overhead} overhead</span></div>
    <div className="capture-ladder" role="tablist" aria-label="Evidence acquisition paths">{steps.map((item, index) => <button id={`${tabPrefix}-tab-${item.id}`} aria-controls={`${tabPrefix}-panel`} role="tab" aria-selected={item.id === selected.id} tabIndex={item.id === selected.id ? 0 : -1} className={`${item.id === selected.id ? "active" : ""} ${item.availability === "Unavailable" ? "unavailable" : ""}`} key={item.id} onClick={() => setSelectedId(item.id)} onKeyDown={(event) => moveTabFocus(event, index)}><span>{String(index + 1).padStart(2, "0")}</span><strong>{item.title}</strong><small>{item.provider ?? "SQL Evaluate native"} · {item.availability ?? "Unknown"}</small>{item.id === recommendedId && <b>RECOMMENDED</b>}</button>)}</div>
    <div id={`${tabPrefix}-panel`} role="tabpanel" aria-labelledby={`${tabPrefix}-tab-${selected.id}`}>
    <p>{selected.purpose}</p>
    {selected.selectionReason && <p className="recipe-why"><b>Why this route:</b> {selected.selectionReason}</p>}
    {selected.unavailableReason && <div className={`recipe-availability ${unavailable ? "recipe-unavailable" : "recipe-unknown"}`} role="status"><b>{unavailable ? "Unavailable" : "Capability not confirmed"}</b><p>{selected.unavailableReason}</p></div>}
    <div className="recipe-grid"><div><span>Expected evidence</span><ul>{selected.expectedEvidence.map((item) => <li key={item}>{item}</li>)}</ul></div><div><span>Permissions and compatibility</span><ul>{selected.requiredPermissions.map((item) => <li key={item}>{item}</li>)}</ul><small>{selected.supportedVersions}</small></div></div>
    <div className="deep-command"><code>{selected.command}</code><div><button disabled={unavailable} onClick={copyCommand}>{copied ? "Copied" : "Copy SQL"}</button><button disabled={unavailable} onClick={() => downloadBlob(`SQL-Evaluate_${caseId}_${selected.id}.sql`, selected.command, "text/plain;charset=utf-8")}>Download .sql</button></div></div>
    <div className={`recipe-caution ${selected.executionMode === "Administrative" ? "recipe-administrative" : ""}`}><b>{selected.executionMode === "Administrative" ? "Separate approval required" : "Caution"}</b><p>{selected.caution}</p><span>SQL EVALUATE NEVER EXECUTES THIS SCRIPT.</span></div>
    </div>
  </section>;
}

function ServerCapabilityPanel({ deepCase, onImport }: { deepCase: DeepAnalysisCase; onImport(): void }) {
  const snapshot = deepCase.serverCapabilities;
  const installed = snapshot?.tools.filter((tool) => tool.installed) ?? [];
  const usable = installed.filter((tool) => tool.compatibleSignature !== false);
  return <section className={`capability-board ${snapshot ? "capability-observed" : "capability-unknown"}`} aria-labelledby="capability-title">
    <div className="capability-heading"><div><span>SERVER CAPABILITY SNAPSHOT</span><h3 id="capability-title">{snapshot ? `${snapshot.edition ?? "SQL Server"} · ${snapshot.productVersion}` : "Route by evidence, not assumptions"}</h3><p>{snapshot ? `Captured ${new Date(snapshot.capturedAt).toLocaleString()} in ${snapshot.databaseName ?? "an unknown database"}.` : "Import the result of the read-only preflight before choosing version-, permission-, or feature-dependent collection steps."}</p></div><button type="button" className="button" onClick={onImport}>{snapshot ? "Import refreshed snapshot" : "Import snapshot result"}</button></div>
    {snapshot ? <>
      <dl className="capability-facts"><div><dt>Edition</dt><dd>{snapshot.edition ?? "Not visible"}</dd></div><div><dt>LAST_QUERY_PLAN_STATS</dt><dd className={snapshot.lastQueryPlanStats === "ON" ? "available" : "caution"}>{snapshot.lastQueryPlanStats}</dd></div><div><dt>Query Store</dt><dd className={snapshot.queryStoreState && !["OFF", "ERROR", "UNAVAILABLE", "PERMISSION_REQUIRED", "UNKNOWN"].includes(snapshot.queryStoreState.toUpperCase()) ? "available" : "caution"}>{snapshot.queryStoreState ?? "Unknown"}</dd></div><div><dt>Diagnostic tools</dt><dd>{usable.length} compatible / {installed.length} installed</dd></div></dl>
      <div className="capability-tools">{installed.map((tool) => <span className={tool.compatibleSignature === false ? "tool-incompatible" : ""} key={tool.toolId}><b>{tool.objectName}</b><small>{tool.databaseName ?? "unknown database"} · {tool.version ?? (tool.compatibleSignature === false ? "incompatible signature" : "version unknown")}</small></span>)}{!installed.length && <p>No supported community diagnostic objects were detected in the selected utility database. Native read-only routes remain available.</p>}</div>
      {snapshot.warnings.map((warning) => <div className="capability-warning" role="status" key={warning}><b>Warning</b>{warning}</div>)}
    </> : <div className="capability-pending"><span aria-hidden="true">?</span><p>SQL Evaluate will not infer capabilities from the edition label alone. The first ladder step provides the snapshot script.</p></div>}
  </section>;
}

export function DeepAnalysisWorkspace({ deepCase, recommendations, busy, onStart, onStartSpillTriage, onSelectSpillCandidate, onChooseSpillPlan, onClearSpillPlan, onImport, onSave, onOpen, estimateThresholds, importMessages = [] }: Props) {
  const evidenceInput = useRef<HTMLInputElement>(null);
  const caseInput = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const planImportMessages = importMessages.filter(isPlanImportMessage);
  const generalImportMessages = importMessages.filter((message) => !isPlanImportMessage(message));
  const generalImportSeverity = generalImportMessages.some((message) => message.severity === "error")
    ? "error"
    : generalImportMessages.some((message) => message.severity === "warning") ? "warning" : "info";
  const generalImportLabel = generalImportSeverity === "error" ? "Error" : generalImportSeverity === "warning" ? "Warning" : "Information";

  if (!deepCase) return <section className="deep-empty">
    <div className="deep-empty-intro">
      <div><span className="deep-kicker">DEEP ANALYSIS / OFFLINE CASEWORK</span><h2>Test the theory.<br /><em>Preserve the evidence.</em></h2></div>
      <p>Move beyond a finding when a bounded diagnostic check can change the conclusion. SQL Evaluate supplies read-only recipes, evaluates the returned files, and stores the investigation in a portable case—never a database.</p>
      <div className="deep-empty-actions"><button className="button button-primary" onClick={onStartSpillTriage}>Start Spill Triage</button><button className="button" onClick={() => caseInput.current?.click()}>Open case ZIP</button><small>Working cases may contain sensitive SQL and plans.</small></div>
      <input ref={caseInput} hidden type="file" accept=".sqlevalcase.zip,.zip" onChange={(event) => { const file = event.target.files?.[0]; if (file) onOpen(file); event.target.value = ""; }} />
    </div>
    <div className="deep-profile-grid">
      {DEEP_ANALYSIS_PROFILE_CATALOG.map((profile, index) => <article className={profile.status === "Ready" ? "profile-ready" : ""} key={profile.id}><span>{String(index + 1).padStart(2, "0")}</span><div><small>{profile.status}</small><strong>{profile.label}</strong><p>{profile.detail}</p></div></article>)}
    </div>
    <div className="deep-recommendations">
      <div className="section-intro"><div><span>RECOMMENDED FROM THIS REPORT</span><strong>{recommendations.length ? "Investigations with a useful next test" : "No profile recommendation yet"}</strong></div><p>Recommendations appear only when deeper evidence could change the conclusion.</p></div>
      {recommendations.slice(0, 5).map((finding) => { const profile = deepAnalysisProfileForFinding(finding); return <button key={finding.id} onClick={() => onStart(finding)}><SeverityBadge severity={finding.severity} /><span><strong>{finding.title}</strong><small>{profile ? profileLabel(profile) : "Deep Analysis"} · {finding.confidence} confidence</small></span><b>START CASE →</b></button>; })}
      {!recommendations.length && <div className="empty-table">No current finding has a bounded Deep Analysis profile.</div>}
    </div>
  </section>;

  if (deepCase.profileId === "spill-triage") {
    const triage = deepCase.spillTriage ?? { candidates: [], selectedCandidateId: null, imports: [], plans: [], manualPlanSelections: [] };
    const candidate = triage.candidates.find((item) => item.id === triage.selectedCandidateId) ?? triage.candidates[0];
    const manual = candidate ? triage.manualPlanSelections.find((item) => item.candidateId === candidate.id) : undefined;
    const resolution = candidate ? resolveCandidatePlan(candidate, triage.plans, manual) : null;
    const recommendedId = recommendedSpillStepId(deepCase.collectionSteps, Boolean(resolution?.connected), Boolean(resolution?.connected && resolution.statement?.isActual), Boolean(deepCase.serverCapabilities), Boolean(candidate), triage.plans.some((item) => item.plan.sourceKind === "Query Store"));
    return <section className="deep-workspace">
    <header className="deep-case-head">
      <div><span className="deep-kicker">CASE / {deepCase.id}</span><h2>{deepCase.title}</h2><p>Rank imported spill evidence, then connect the selected cached variant to a plan through stable SQL Server identity.</p></div>
      <div className="deep-case-actions"><span className="sensitive-chip">SENSITIVE WORKING CASE</span><button className="button" disabled={busy} onClick={() => caseInput.current?.click()}>Open case</button><button className="button" disabled={busy} onClick={() => evidenceInput.current?.click()}>Import evidence</button><button className="button button-save" disabled={busy} onClick={onSave}>{busy ? "Preparing…" : "Save case ZIP"}</button></div>
      <input ref={caseInput} hidden type="file" accept=".sqlevalcase.zip,.zip" onChange={(event) => { const file = event.target.files?.[0]; if (file) onOpen(file); event.target.value = ""; }} />
      <input ref={evidenceInput} data-testid="spill-triage-evidence-input" hidden multiple type="file" accept=".csv,.tsv,.xlsx,.xls,.sqlplan,.xml" onChange={(event) => { onImport([...event.target.files ?? []]); event.target.value = ""; }} />
    </header>
    {generalImportMessages.length > 0 && <div className="upload-message-panel" role={generalImportSeverity === "error" ? "alert" : "status"} aria-live={generalImportSeverity === "error" ? "assertive" : "polite"} aria-label={`${generalImportLabel}: Evidence import results`}><strong>Evidence import results</strong>{generalImportMessages.map((message, index) => <p className={`upload-message-${message.severity}`} key={`${message.fileName}-${message.code}-${index}`}><b>{message.fileName}</b>: {message.message}</p>)}</div>}
    <ServerCapabilityPanel deepCase={deepCase} onImport={() => evidenceInput.current?.click()} />
    <SpillTriagePanel spillTriage={triage} onSelect={onSelectSpillCandidate} onChoosePlan={() => evidenceInput.current?.click()} onChooseStatement={onChooseSpillPlan} onClearStatement={onClearSpillPlan} estimateThresholds={estimateThresholds} planImportMessages={planImportMessages} />
    <CollectionRecipe steps={deepCase.collectionSteps} recommendedId={recommendedId} caseId={deepCase.id} />
    <DeepShareActions deepCase={deepCase} />
  </section>;
  }

  const planAssertion = deepCase.assertions.find((item) => item.id === "plan-captured");
  const lastAttempt = deepCase.captureAttempts?.at(-1);
  const recommendedStepId = deepCase.profileId !== "cpu-backed-blocking" ? deepCase.collectionSteps[0]?.id : planAssertion?.state === "Observed" ? "cpu-blocking-live-capture"
    : lastAttempt?.method === "Live cache" && lastAttempt.outcome === "Returned null" ? "last-known-actual-plan"
      : lastAttempt?.method === "Last-known actual" && lastAttempt.outcome !== "Captured" ? "query-store-history"
        : lastAttempt?.method === "Query Store" && lastAttempt.outcome !== "Captured" ? "xe-post-execution-showplan"
          : "cpu-blocking-live-capture";
  const step = deepCase.collectionSteps.find((item) => item.id === selectedStepId) ?? deepCase.collectionSteps.find((item) => item.id === recommendedStepId) ?? deepCase.collectionSteps[0];
  const causal = causalOrder.flatMap((id) => { const item = deepCase.assertions.find((assertion) => assertion.id === id); return item ? [item] : []; });
  const conclusion = deepCase.assertions.find((item) => item.id === "causal-theory");
  const counts = new Map(stateOrder.map((state) => [state, deepCase.assertions.filter((assertion) => assertion.state === state).length]));
  const copyCommand = async () => {
    try { await navigator.clipboard.writeText(step.command); setCopied(true); }
    catch { setCopied(copyFallback(step.command)); }
    window.setTimeout(() => setCopied(false), 1800);
  };

  return <section className="deep-workspace">
    <header className="deep-case-head">
      <div><span className="deep-kicker">CASE / {deepCase.id}</span><h2>{deepCase.title}</h2><p>Started from <b>{deepCase.sourceFinding?.title ?? (deepCase.origin?.kind === "manual" ? deepCase.origin.label : "manual evidence import")}</b>. Every link below is labeled by what the imported evidence can support.</p></div>
      <div className="deep-case-actions"><span className="sensitive-chip">SENSITIVE WORKING CASE</span><button className="button" disabled={busy} onClick={() => caseInput.current?.click()}>Open case</button><button className="button" disabled={busy} onClick={() => evidenceInput.current?.click()}>Import evidence</button><button className="button button-save" disabled={busy} onClick={onSave}>{busy ? "Preparing…" : "Save case ZIP"}</button></div>
      <input ref={caseInput} hidden type="file" accept=".sqlevalcase.zip,.zip" onChange={(event) => { const file = event.target.files?.[0]; if (file) onOpen(file); event.target.value = ""; }} />
      <input ref={evidenceInput} hidden multiple type="file" accept=".csv,.tsv,.xlsx,.xls,.sqlplan,.xml,.json,.txt" onChange={(event) => { onImport([...event.target.files ?? []]); event.target.value = ""; }} />
    </header>

    <div className="deep-state-strip" aria-label="Evidence state totals">{stateOrder.map((state) => <div key={state}><EvidenceStateBadge state={state} /><strong>{counts.get(state)}</strong></div>)}</div>

    {deepCase.narrative && <section className="case-narrative" aria-labelledby="case-narrative-title">
      <div className="narrative-head"><div><span>DBA INVESTIGATION NARRATIVE</span><h3 id="case-narrative-title">{deepCase.narrative.headline}</h3></div><p>Every sentence below is generated from the current evidence ledger—not from a fixed diagnosis template.</p></div>
      <div className="narrative-groups">
        <article className="narrative-established"><span>Established</span>{deepCase.narrative.established.map((item) => <p key={item}>{item}</p>)}{!deepCase.narrative.established.length && <p>Nothing has reached direct-observation status yet.</p>}</article>
        <article className="narrative-supported"><span>Supported</span>{deepCase.narrative.supported.map((item) => <p key={item}>{item}</p>)}{!deepCase.narrative.supported.length && <p>No wider causal link is sufficiently supported yet.</p>}</article>
        <article className="narrative-contradicted"><span>Contradicted</span>{deepCase.narrative.contradicted.map((item) => <p key={item}>{item}</p>)}{!deepCase.narrative.contradicted.length && <p>No claim is directly contradicted.</p>}</article>
        <article className="narrative-open"><span>Unanswered</span>{deepCase.narrative.unanswered.slice(0, 4).map((item) => <p key={item}>{item}</p>)}</article>
      </div>
      <div className="narrative-next"><span>Next discriminating check</span><strong>{deepCase.narrative.nextCheck}</strong></div>
      <DeepShareActions deepCase={deepCase} />
    </section>}

    <section className="causal-board" aria-labelledby="causal-board-title">
      <div className="deep-section-title"><div><span>WORKING THEORY</span><h3 id="causal-board-title">Evidence-ranked causal chain</h3></div><p>Arrows show the theory—not automatic proof of causation.</p></div>
      <div className="causal-rail">{causal.map((item, index) => <article className={`causal-card causal-${stateClass(item.state)}`} key={item.id}><EvidenceStateBadge state={item.state} /><strong>{item.label}</strong><p>{item.statement}</p>{index < causal.length - 1 && <i className="causal-arrow" aria-hidden="true">→</i>}</article>)}</div>
      <div className="causal-verdict"><span>Current conclusion</span><EvidenceStateBadge state={conclusion?.state ?? "Not Evaluated"} /><p>{conclusion?.statement}</p>{conclusion?.basis[0] && <small>{conclusion.basis[0]}</small>}</div>
    </section>

    <div className="deep-columns">
      <section className="evidence-ledger">
        <div className="deep-section-title"><div><span>EVIDENCE LEDGER</span><h3>What is proven—and what is not</h3></div></div>
        <div>{deepCase.assertions.map((item) => <article key={item.id}><div><EvidenceStateBadge state={item.state} /><strong>{item.label}</strong></div><p>{item.statement}</p>{item.basis.length > 0 && <ul className="basis-list">{item.basis.map((basis) => <li key={basis}>{basis}</li>)}</ul>}{item.missingEvidence.length > 0 && <div className="missing-evidence"><span>Still needed</span>{item.missingEvidence.map((missing) => <b key={missing}>{missing}</b>)}</div>}</article>)}</div>
      </section>

      <aside className="case-provenance">
        <div className="deep-section-title"><div><span>CASE FILE</span><h3>Evidence &amp; history</h3></div></div>
        <dl><div><dt>Root SPID</dt><dd>{deepCase.rootSessionId ?? "Unknown"}</dd></div><div><dt>Incident window</dt><dd>{deepCase.incidentWindow?.firstObservedAt ? `${new Date(deepCase.incidentWindow.firstObservedAt).toLocaleTimeString()}–${new Date(deepCase.incidentWindow.lastObservedAt ?? deepCase.incidentWindow.firstObservedAt).toLocaleTimeString()}` : "Timestamp unavailable"}</dd></div><div><dt>Source files</dt><dd>{deepCase.sourceFileNames.length}</dd></div><div><dt>Evidence files</dt><dd>{deepCase.artifacts.length}</dd></div><div><dt>Observations</dt><dd>{deepCase.observations?.length ?? 0}</dd></div><div><dt>Last updated</dt><dd>{new Date(deepCase.updatedAt).toLocaleString()}</dd></div></dl>
        <div className="artifact-list">{deepCase.artifacts.map((artifact) => <article key={artifact.id}><span>{artifact.kind} · {artifact.adapterId ?? "Unclassified"}</span><strong>{artifact.fileName}</strong><small>{formatNumber(artifact.size)} bytes · SHA-256 {artifact.sha256.slice(0, 12)}…</small>{artifact.capturedAt && <small>Captured {new Date(artifact.capturedAt).toLocaleString()}</small>}{artifact.resultSetTypes?.length ? <div className="artifact-tags">{artifact.resultSetTypes.map((type) => <b key={type}>{type}</b>)}</div> : null}<p>{artifact.summary}</p>{artifact.warnings?.map((warning) => <em key={warning}>{warning}</em>)}</article>)}{!deepCase.artifacts.length && <p className="no-artifacts">No returned evidence has been imported. The case still records its source finding and working theory.</p>}</div>
        {(deepCase.captureAttempts?.length ?? 0) > 0 && <div className="capture-attempts"><span>PLAN CAPTURE ATTEMPTS</span>{deepCase.captureAttempts?.map((attempt) => <article key={attempt.id}><b>{attempt.outcome}</b><strong>{attempt.method}</strong><p>{attempt.detail}</p></article>)}</div>}
        <ol className="case-events">{[...deepCase.events].reverse().map((event, index) => <li key={`${event.occurredAt}-${index}`}><span>{event.type}</span><time>{new Date(event.occurredAt).toLocaleString()}</time><p>{event.summary}</p></li>)}</ol>
      </aside>
    </div>

    <section className="deep-recipe">
      <div className="deep-section-title"><div><span>NEXT DISCRIMINATING CHECK</span><h3>{step.title}</h3></div><span className={`overhead overhead-${step.overhead.toLowerCase()}`}>{step.overhead} overhead</span></div>
      <div className="capture-ladder" role="tablist" aria-label="Evidence escalation paths">{deepCase.collectionSteps.map((item, index) => <button role="tab" aria-selected={item.id === step.id} className={item.id === step.id ? "active" : ""} key={item.id} onClick={() => setSelectedStepId(item.id)}><span>{String(index + 1).padStart(2, "0")}</span><strong>{item.title}</strong><small>{item.executionMode ?? "Read-only"} · {item.overhead}</small>{item.id === recommendedStepId && <b>RECOMMENDED</b>}</button>)}</div>
      <p>{step.purpose}</p>
      <div className="recipe-grid"><div><span>Expected evidence</span><ul>{step.expectedEvidence.map((item) => <li key={item}>{item}</li>)}</ul></div><div><span>Permissions</span><ul>{step.requiredPermissions.map((item) => <li key={item}>{item}</li>)}</ul><small>{step.supportedVersions}</small></div></div>
      <div className="deep-command"><code>{step.command}</code><div><button onClick={copyCommand}>{copied ? "Copied" : "Copy SQL"}</button><button onClick={() => downloadBlob(`SQL-Evaluate_${deepCase.id}_${step.id}.sql`, step.command, "text/plain;charset=utf-8")}>Download .sql</button></div></div>
      <div className={`recipe-caution ${step.executionMode === "Administrative" ? "recipe-administrative" : ""}`}><b>{step.executionMode === "Administrative" ? "Separate approval required" : "Caution"}</b><p>{step.caution}</p><span>SQL EVALUATE NEVER EXECUTES THIS SCRIPT.</span></div>
    </section>
  </section>;
}
