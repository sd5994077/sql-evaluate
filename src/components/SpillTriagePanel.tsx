import { useEffect, useMemo, useRef, useState } from "react";
import { hasCorrelationReadyIdentity } from "../deepAnalysis/correlation";
import { isPlanImportMessage } from "../deepAnalysis/importMessages";
import type { DeepQueryIdentity, EvidenceImportMessage, SpillCandidate, SpillTriageState } from "../deepAnalysis/types";
import { actualSpillOperators, earliestFeedingEstimateError, highestPerExecution, resolveCandidatePlan, spillVolumeGiB } from "../deepAnalysis/spillTriage";

interface Props {
  spillTriage: SpillTriageState;
  onSelect(candidateId: string): void;
  onChoosePlan(): void;
  onChooseStatement(candidateId: string, artifactId: string, statementId: string): void;
  onClearStatement(candidateId: string): void;
  estimateThresholds?: { ratio: number; rows: number };
  planImportMessages?: EvidenceImportMessage[];
}

const PAGE_SIZE = 50;

function pages(value: number | null): string {
  return value === null ? "Not supplied" : `${value.toLocaleString()} pages (${spillVolumeGiB(value).toLocaleString(undefined, { maximumFractionDigits: 2 })} GiB)`;
}

function metric(value: number | null, suffix = ""): string {
  return value === null ? "Not supplied" : `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}${suffix}`;
}

function shortIdentity(candidate: SpillCandidate): string {
  if (candidate.identity.planHandle) return candidate.identity.planHandle.length > 22 ? `${candidate.identity.planHandle.slice(0, 12)}…${candidate.identity.planHandle.slice(-6)}` : candidate.identity.planHandle;
  if (candidate.identity.queryStoreQueryId !== null && candidate.identity.queryStoreQueryId !== undefined && candidate.identity.queryStorePlanId !== null && candidate.identity.queryStorePlanId !== undefined) return `QS ${candidate.identity.queryStoreQueryId} / ${candidate.identity.queryStorePlanId}`;
  const value = candidate.identity.sqlHandle ?? candidate.identity.queryPlanHash ?? candidate.identity.queryHash;
  if (!value) return "Identity incomplete";
  return value.length > 22 ? `${value.slice(0, 12)}…${value.slice(-6)}` : value;
}

function fullIdentity(candidate: SpillCandidate): string {
  if (candidate.identity.planHandle) return candidate.identity.planHandle;
  if (candidate.identity.queryStoreQueryId !== null && candidate.identity.queryStoreQueryId !== undefined && candidate.identity.queryStorePlanId !== null && candidate.identity.queryStorePlanId !== undefined) return `Query Store query ${candidate.identity.queryStoreQueryId}, plan ${candidate.identity.queryStorePlanId}`;
  return candidate.identity.sqlHandle ?? candidate.identity.queryPlanHash ?? candidate.identity.queryHash ?? "Stable identity not supplied";
}

function candidateActionLabel(candidate: SpillCandidate, selected: boolean): string {
  const rank = candidate.rank ? `rank ${candidate.rank}` : "unranked candidate";
  return `${selected ? "Selected" : "Investigate"} ${rank} ${candidate.objectName ?? shortIdentity(candidate)}`;
}

function statementIdentity(identity: DeepQueryIdentity): string {
  const offsets = identity.statementStartOffset != null && identity.statementEndOffset != null ? `offsets ${identity.statementStartOffset}–${identity.statementEndOffset}` : "offsets not supplied";
  const hash = identity.queryPlanHash ?? identity.queryHash;
  return hash ? `${offsets} · ${hash.length > 22 ? `${hash.slice(0, 12)}…${hash.slice(-6)}` : hash}` : offsets;
}

function importStatusTitle(message: EvidenceImportMessage): string {
  if (message.severity === "error") return "Plan import failed";
  if (message.code === "plan-identity-missing") return "Plan imported but cannot be correlated";
  if (message.code === "duplicate") return "Plan was not re-imported";
  return "Plan import notice";
}

export function SpillTriagePanel({ spillTriage, onSelect, onChoosePlan, onChooseStatement, onClearStatement, estimateThresholds = { ratio: 10, rows: 10_000 }, planImportMessages = [] }: Props) {
  const [page, setPage] = useState(0);
  const selected = spillTriage.candidates.find((candidate) => candidate.id === spillTriage.selectedCandidateId) ?? spillTriage.candidates[0] ?? null;
  const selectedDetails = useRef<HTMLElement>(null);
  const previousSelection = useRef(selected?.id);
  const planImportNotice = useRef<HTMLDivElement>(null);
  const hasRenderedPlanImportNotice = useRef(false);
  useEffect(() => {
    if (previousSelection.current && selected?.id && previousSelection.current !== selected.id) selectedDetails.current?.focus();
    previousSelection.current = selected?.id;
  }, [selected?.id]);
  const perExecution = highestPerExecution(spillTriage.candidates);
  const cumulative = spillTriage.candidates.find((candidate) => candidate.rankGroup === "total") ?? null;
  const rankedCount = spillTriage.candidates.filter((candidate) => candidate.rank !== null).length;
  const unrankedCount = spillTriage.candidates.length - rankedCount;
  const pagesCount = Math.max(1, Math.ceil(spillTriage.candidates.length / PAGE_SIZE));
  const visible = spillTriage.candidates.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const manualSelection = selected ? spillTriage.manualPlanSelections?.find((selection) => selection.candidateId === selected.id) : undefined;
  const resolution = useMemo(() => selected ? resolveCandidatePlan(selected, spillTriage.plans, manualSelection) : null, [selected, spillTriage.plans, manualSelection]);
  const visiblePlanImportMessages = planImportMessages.filter(isPlanImportMessage);
  const planImportKey = visiblePlanImportMessages.map((message) => `${message.fileName}:${message.code}:${message.message}`).join("|");
  const importedPlanHasStableIdentity = spillTriage.plans.some((evidence) => evidence.plan.statements.some((statement) => hasCorrelationReadyIdentity(statement.queryIdentity)));
  const missingMatchTone = !spillTriage.plans.length ? "info" : resolution?.blockedByConflict ? "error" : "warning";
  const missingMatchLabel = missingMatchTone === "error" ? "Error" : missingMatchTone === "warning" ? "Warning" : "Information";
  const missingMatchTitle = !spillTriage.plans.length
    ? "Plan needed"
    : resolution?.blockedByConflict
      ? "Stable identity conflict"
      : resolution?.ambiguous
        ? "Matching plan is ambiguous"
        : !importedPlanHasStableIdentity
          ? "Imported plan cannot be correlated"
          : "No stably correlated plan";
  const missingMatchReason = !spillTriage.plans.length
    ? "No plan has been supplied. Import the cached or actual Showplan for this candidate."
    : !importedPlanHasStableIdentity
      ? "The imported Showplan is valid, but it does not contain a correlation-ready stable identifier. Saving a plan from a results grid does not guarantee that the plan handle or query hashes are embedded in the Showplan XML."
      : `${resolution?.reason ?? "No supported stable identifier matches."} A cached handle may have expired, or the supplied plan may belong to another cached variant. Similar SQL text is never used as a match.`;
  const actualSpills = resolution?.connected && resolution.evidence && resolution.statement ? actualSpillOperators(resolution.evidence.plan, resolution.statement) : [];
  useEffect(() => setPage((value) => Math.min(value, pagesCount - 1)), [pagesCount]);
  useEffect(() => {
    if (!selected) return;
    const index = spillTriage.candidates.findIndex((candidate) => candidate.id === selected.id);
    if (index >= 0) setPage(Math.floor(index / PAGE_SIZE));
  }, [selected?.id, spillTriage.candidates]);
  useEffect(() => {
    if (hasRenderedPlanImportNotice.current && planImportKey) planImportNotice.current?.focus();
    hasRenderedPlanImportNotice.current = true;
  }, [planImportKey]);

  return <div className="spill-triage">
    <div className="spill-stage-head"><span>STAGE 1 / CANDIDATE SELECTION</span><h3>Choose the cached plan variant to investigate first</h3><p>SQL Evaluate compares imported spill pages in a fixed order. It does not calculate an opaque severity score.</p></div>

    {spillTriage.imports.flatMap((item) => item.warnings.slice(0, 2).map((warning) => <div className="spill-disclosure" role="note" key={`${item.artifactId}-${item.sheetName}-${warning}`}><b>Import boundary</b>{warning}</div>))}

    {!spillTriage.candidates.length ? <div className="spill-empty"><strong>Import a sp_BlitzCache spill export</strong><p>Choose a CSV or XLSX produced with <code>@SortOrder = 'Spills'</code>. Numeric spill values are required for ranking; warning-only rows will remain visible but unranked.</p><button type="button" className="button button-primary" onClick={onChoosePlan}>Import BlitzCache export</button></div> : <>
      <div className="spill-summary" aria-live="polite">
        <article><span>Highest cumulative impact</span><strong>{cumulative ? shortIdentity(cumulative) : "No total-backed candidate"}</strong><small>{cumulative ? pages(cumulative.totalSpillPages.value) : "Total spill evidence unavailable"}</small></article>
        <article><span>Highest per execution</span><strong>{perExecution ? shortIdentity(perExecution) : "Not supplied"}</strong><small>{perExecution ? pages(perExecution.averageSpillPages.value) : "Average spill evidence unavailable"}</small></article>
        <article><span>Ranking coverage</span><strong>{rankedCount} ranked</strong><small>{unrankedCount} warning-only, zero, or malformed</small></article>
      </div>

      <div className="spill-table-wrap">
        <table className="spill-table">
          <caption>Spill candidates ordered by cumulative impact, average impact, recency, then source row</caption>
          <thead><tr><th scope="col" aria-sort="ascending">Rank</th><th scope="col">Plan identity</th><th scope="col">Total spill impact</th><th scope="col">Per execution</th><th scope="col">Executions</th><th scope="col">Last execution</th><th scope="col">Context</th><th scope="col">Action</th></tr></thead>
          <tbody>{visible.map((candidate) => <tr key={candidate.id} className={candidate.id === selected?.id ? "selected" : ""}>
            <td data-label="Rank">{candidate.rank ?? "—"}<span className="sr-only">{candidate.rank ? `Rank ${candidate.rank}` : "Unranked"}</span></td>
            <td data-label="Plan identity"><code title={fullIdentity(candidate)}>{shortIdentity(candidate)}</code>{candidate.identity.queryHash && <small>Query hash supplied{candidate.identity.planHandle ? " · plan variant retained" : ""}</small>}</td>
            <td data-label="Total spill impact">{pages(candidate.totalSpillPages.value)}{candidate.totalSpillPages.explanation && <small>{candidate.totalSpillPages.explanation}</small>}</td>
            <td data-label="Per execution">{pages(candidate.averageSpillPages.value)}{candidate.averageSpillPages.explanation && <small>{candidate.averageSpillPages.state === "derived" ? "Derived: " : ""}{candidate.averageSpillPages.explanation}</small>}</td>
            <td data-label="Executions">{metric(candidate.executionCount.value)}</td>
            <td data-label="Last execution">{candidate.lastExecution ? candidate.lastExecution.replace("T", " ") : "Not supplied"}</td>
            <td data-label="Context">{candidate.databaseName ?? "Database not supplied"}<small>{candidate.objectName ?? candidate.queryType ?? "Object not supplied"}</small></td>
            <td data-label="Action"><button type="button" aria-label={candidateActionLabel(candidate, candidate.id === selected?.id)} aria-pressed={candidate.id === selected?.id} onClick={() => onSelect(candidate.id)}>{candidate.id === selected?.id ? "Selected" : "Investigate"}</button></td>
          </tr>)}</tbody>
        </table>
      </div>
      {pagesCount > 1 && <nav className="spill-pagination" aria-label="Spill candidate pages"><button type="button" disabled={page === 0} onClick={() => setPage((value) => value - 1)}>Previous</button><span>Page {page + 1} of {pagesCount}</span><button type="button" disabled={page + 1 >= pagesCount} onClick={() => setPage((value) => value + 1)}>Next</button></nav>}
    </>}

    {selected && <section ref={selectedDetails} tabIndex={-1} className="spill-selected" aria-labelledby="spill-selected-title" aria-live="polite">
      <div className="spill-stage-head"><span>WHY THIS CANDIDATE</span><h3 id="spill-selected-title">{selected.rank ? `Rank ${selected.rank}: highest-priority spill candidate` : "Unranked spill evidence"}</h3><p>{selected.rankReason}</p></div>
      <dl className="spill-context">
        <div><dt>Total spill impact</dt><dd>{pages(selected.totalSpillPages.value)}{selected.totalSpillPages.explanation && <small>{selected.totalSpillPages.explanation}</small>}</dd></div>
        <div><dt>Per-execution severity</dt><dd>{pages(selected.averageSpillPages.value)}{selected.averageSpillPages.explanation && <small>{selected.averageSpillPages.explanation}</small>}</dd></div>
        <div><dt>Duration</dt><dd>{metric(selected.totalDuration.value, " ms total")}</dd></div>
        <div><dt>CPU</dt><dd>{metric(selected.totalCpu.value, " ms total")}</dd></div>
        <div><dt>Reads</dt><dd>{metric(selected.totalReads.value)}</dd></div>
      </dl>
      {selected.administrativeText.length > 0 && <details className="spill-admin"><summary>Administrative source text — not a recommendation</summary><p>This command came from the source export. It changes SQL Server cache state, is not a recommendation from SQL Evaluate, and is never executed here.</p><pre>{selected.administrativeText.map((item) => `${item.header}: ${item.value}`).join("\n")}</pre></details>}
    </section>}

    <section className="spill-diagnosis" aria-labelledby="spill-diagnosis-title">
      <div className="spill-stage-head"><span>STAGE 2 / PLAN DIAGNOSIS</span><h3 id="spill-diagnosis-title">Connect stable identity to operator evidence</h3></div>
      {visiblePlanImportMessages.map((message, index) => <div ref={index === visiblePlanImportMessages.length - 1 ? planImportNotice : undefined} tabIndex={index === visiblePlanImportMessages.length - 1 ? -1 : undefined} className={`spill-match-state spill-import-status spill-match-state-${message.severity}`} role={message.severity === "error" ? "alert" : "status"} aria-label={`${message.severity === "error" ? "Error" : message.severity === "warning" ? "Warning" : "Information"}: ${importStatusTitle(message)}`} key={`${message.fileName}:${message.code}:${index}`}><span className="spill-match-severity"><span aria-hidden="true">{message.severity === "error" ? "×" : message.severity === "warning" ? "!" : "i"}</span>{message.severity === "error" ? "Error" : message.severity === "warning" ? "Warning" : "Information"}</span><strong>{importStatusTitle(message)}</strong><p><b>{message.fileName}</b>: {message.message}</p></div>)}
      {!selected ? <p>Select a candidate after importing a supported export.</p> : !resolution?.connected ? <div className={`spill-match-state spill-match-state-${missingMatchTone}`} role={missingMatchTone === "error" ? "alert" : "status"} aria-label={`${missingMatchLabel}: ${missingMatchTitle}`}><span className="spill-match-severity"><span aria-hidden="true">{missingMatchTone === "error" ? "×" : missingMatchTone === "warning" ? "!" : "i"}</span>{missingMatchLabel}</span><strong>{missingMatchTitle}</strong><p>{missingMatchReason}</p>{resolution?.ambiguous && resolution.alternatives.length > 1 && <div className="spill-alternatives" role="group" aria-label="Equally strong matching plan statements">{resolution.alternatives.map((alternative) => <article key={`${alternative.artifactId}:${alternative.statementId}`}><div><strong>{alternative.fileName} · statement {alternative.statementIndex + 1}</strong><small>{alternative.statementType} · {statementIdentity(alternative.identity)}</small><p>{alternative.reason}</p></div><button type="button" onClick={() => onChooseStatement(selected.id, alternative.artifactId, alternative.statementId)} aria-label={`Choose statement ${alternative.statementIndex + 1} from ${alternative.fileName} for ${candidateActionLabel(selected, true)}`}>Choose statement</button></article>)}</div>}<button type="button" className="button button-primary" onClick={onChoosePlan}>{resolution?.ambiguous ? "Import more specific plan" : spillTriage.plans.length ? "Choose another plan" : "Choose matching plan"}</button></div> : <div className="spill-plan-result">
        <div className="spill-plan-match"><span>{resolution.selectionMethod === "manual" ? "MANUALLY SELECTED" : resolution.quality} STABLE-IDENTITY MATCH</span><strong>{resolution.evidence?.fileName}</strong><p>{resolution.reason}</p>{resolution.selectionMethod === "manual" && <button type="button" onClick={() => onClearStatement(selected.id)}>Clear manual choice</button>}</div>
        {!resolution.evidence?.plan.isActual || !resolution.statement?.isActual ? <div className="spill-estimated"><strong>Estimated/cached plan evidence</strong><p>This plan can show compile-time shape and estimates. Runtime operator counts and spill volumes are not available and are not inferred from the BlitzCache row.</p></div> : <div className="spill-operators">
          <strong>{actualSpills.length} spilling operator{actualSpills.length === 1 ? "" : "s"} in the matched actual statement{resolution.statement.degreeOfParallelism != null ? ` · DOP ${resolution.statement.degreeOfParallelism}` : ""}</strong>
          {actualSpills.map((operator) => {
            const upstream = resolution.statement ? earliestFeedingEstimateError(resolution.statement, operator, estimateThresholds.ratio, estimateThresholds.rows) : null;
            return <article key={operator.id}><h4>{operator.physicalOp} · Node {operator.nodeId ?? "unknown"}</h4>{operator.spillDetails?.map((detail, index) => <dl key={`${operator.id}-${index}`}><div><dt>Spill</dt><dd>{detail.kind}{detail.spillLevel !== null ? ` · level ${detail.spillLevel}` : ""}</dd></div><div><dt>Spilled threads</dt><dd>{metric(detail.spilledThreadCount)}</dd></div><div><dt>Tempdb files</dt><dd>{metric(detail.tempdbFileCount ?? null)}</dd></div><div><dt>Tempdb written</dt><dd>{pages(detail.pagesWritten)}</dd></div><div><dt>Tempdb read</dt><dd>{pages(detail.pagesRead)}</dd></div><div><dt>Grant / use</dt><dd>{detail.grantedMemoryKb !== null ? `${metric(detail.grantedMemoryKb)} KB` : "Not supplied"} / {detail.usedMemoryKb !== null ? `${metric(detail.usedMemoryKb)} KB` : "Not supplied"}</dd></div></dl>)}
              {upstream ? <p className="spill-upstream"><b>Earliest major feeding estimate error:</b> Node {upstream.operator.nodeId ?? "unknown"} {upstream.operator.physicalOp}, estimated {metric(upstream.operator.estimatedRows)} and processed {metric(upstream.operator.actualRows)} rows ({metric(upstream.ratio)}×), {upstream.distance} input hop{upstream.distance === 1 ? "" : "s"} before the spill.</p> : <p className="spill-upstream">No major feeding row-estimate error was found under the current Spill Triage thresholds.</p>}
            </article>;
          })}
          {!actualSpills.length && <p>The matched actual statement contains no parsed Sort or Hash spill details.</p>}
        </div>}
      </div>}
    </section>

    {spillTriage.imports.length > 0 && <section className="spill-quality" aria-labelledby="spill-quality-title"><div className="spill-stage-head"><span>DATA QUALITY</span><h3 id="spill-quality-title">What the import can and cannot establish</h3></div>{spillTriage.imports.map((item) => <article key={`${item.artifactId}-${item.sheetName}`}><strong>{item.fileName}{item.sheetName ? ` · ${item.sheetName}` : ""}</strong><p>{item.importedRows} rows · {item.rankableRows} rankable · {item.unknownHeaders.length} unknown columns preserved</p>{item.headerRow ? <p>Detected spill header at worksheet row {item.headerRow}.</p> : null}{item.ignoredSheets?.length ? <ul>{item.ignoredSheets.map((sheet) => <li key={sheet.sheetName}>Ignored {sheet.sheetName}: {sheet.reason}</li>)}</ul> : null}<ul>{item.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul><details><summary>Recognized columns ({item.recognizedHeaders.length})</summary><p>{item.recognizedHeaders.join(", ") || "None"}</p></details>{item.unknownHeaders.length > 0 && <details><summary>Unknown columns</summary><p>{item.unknownHeaders.join(", ")}</p></details>}</article>)}</section>}
  </div>;
}
