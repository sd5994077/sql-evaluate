import { useEffect, useState } from "react";
import type { CaseDetails, DeepAnalysisCase } from "../deepAnalysis/types";
import { validateCaseDetails } from "../deepAnalysis/metadata";
import { WorkflowDialog } from "./WorkflowDialog";

export function CaseDetailsEditor({ deepCase, onApply }: { deepCase: DeepAnalysisCase; onApply(details: CaseDetails): void }) {
  const [draft, setDraft] = useState<CaseDetails | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!draft || (draft.title === deepCase.title && draft.notes === (deepCase.notes ?? "") && draft.ticketReference === (deepCase.ticketReference ?? "") && draft.status === (deepCase.status ?? "Investigating"))) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [draft, deepCase]);
  return <section className="case-tracking">
    <div><span>INVESTIGATION TRACKING</span><strong>{deepCase.title}</strong><p>{deepCase.status ?? "Investigating"}{deepCase.ticketReference ? ` · ${deepCase.ticketReference}` : ""}</p></div>
    <button className="button" onClick={() => { setError(""); setDraft({ title: deepCase.title, ticketReference: deepCase.ticketReference ?? "", notes: deepCase.notes ?? "", status: deepCase.status ?? "Investigating" }); }}>Edit case details</button>
    {deepCase.notes && <details><summary>Private case notes</summary><p className="case-notes">{deepCase.notes}</p></details>}
    {draft && <WorkflowDialog title="Edit case details" onCancel={() => setDraft(null)}>
      <form onSubmit={(event) => { event.preventDefault(); try { const details = validateCaseDetails(draft); onApply(details); setDraft(null); } catch (failure) { setError(failure instanceof Error ? failure.message : "Invalid details."); } }}>
        <p>Handwritten details are included only in the sensitive working case ZIP. Status does not change diagnostic evidence.</p>
        <label className="workflow-field">Case title<input required maxLength={200} value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
        <label className="workflow-field">Ticket reference<input maxLength={200} value={draft.ticketReference} onChange={(event) => setDraft({ ...draft, ticketReference: event.target.value })} /></label>
        <label className="workflow-field">Case status<select value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value as CaseDetails["status"] })}><option>Investigating</option><option>Waiting for evidence</option><option>Closed</option></select></label>
        <label className="workflow-field">Case notes<textarea aria-label="Case notes" rows={8} maxLength={20000} value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} /><small>{draft.notes.length.toLocaleString()} / 20,000 characters</small></label>
        {error && <p role="alert">{error}</p>}
        <div className="workflow-actions"><button type="button" className="button" onClick={() => setDraft(null)}>Cancel</button><button type="submit" className="button button-primary">Apply details</button></div>
      </form>
    </WorkflowDialog>}
  </section>;
}
