import type { ImportPreviewItem } from "../lib/importPreview";
import { WorkflowDialog } from "./WorkflowDialog";

export interface PreviewState {
  target: "analysis" | "deep";
  files: File[];
  items: ImportPreviewItem[];
  selectedIds: string[];
  sheets: Record<string, string>;
  append: boolean;
  busy: boolean;
}

export function ImportPreviewDialog({ preview, canAppend, caseTitle, onChange, onSheet, onConfirm, onCancel }: {
  preview: PreviewState; canAppend: boolean; caseTitle?: string;
  onChange(preview: PreviewState): void; onSheet(id: string, sheet: string): void; onConfirm(): void; onCancel(): void;
}) {
  return <WorkflowDialog title="Review imported files" onCancel={onCancel}>
    <p>{preview.target === "deep" ? `Add evidence to: ${caseTitle}` : "Review the detected evidence before analysis. Your current results remain available until you confirm."}</p>
    {preview.target === "analysis" && <label className="workflow-field">Destination<select aria-label="Import destination" disabled={preview.busy} value={preview.append ? "append" : "new"} onChange={(event) => onChange({ ...preview, append: event.target.value === "append" })}><option value="new">New analysis</option><option value="append" disabled={!canAppend}>Add to current analysis</option></select>{!canAppend && <small>Adding requires the original captures in this session. For a reopened report, select the original captures again.</small>}</label>}
    {preview.busy && <p role="status">Preparing local preview…</p>}
    <div className="preview-files">{preview.items.map((item) => <article key={item.id} className={item.usable ? "" : "preview-rejected"}>
      <label className="preview-file-title"><input type="checkbox" disabled={!item.usable || preview.busy} checked={preview.selectedIds.includes(item.id)} onChange={(event) => onChange({ ...preview, selectedIds: event.target.checked ? [...preview.selectedIds, item.id] : preview.selectedIds.filter((id) => id !== item.id) })} /><strong>{item.fileName}</strong></label>
      <p>{item.kind} · {(item.size / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} KB · {item.count.toLocaleString()} {item.countLabel}</p>
      <p>Capture time: {item.firstCapturedAt ? `${item.firstCapturedAt} — ${item.lastCapturedAt}` : "Not supplied"}</p>
      {item.selectableSheets?.length ? <label className="workflow-field">Worksheet for {item.fileName}<select value={item.selectedSheet} disabled={preview.busy} onChange={(event) => onSheet(item.id, event.target.value)}>{item.selectableSheets.map((sheet) => <option key={sheet}>{sheet}</option>)}</select></label> : null}
      {item.worksheets.length > 0 && <p>Worksheets {preview.target === "deep" ? "inspected" : "available"}: {item.worksheets.join(", ")}</p>}
      <details><summary>Recognized evidence ({item.recognized.length})</summary><p>{item.recognized.join(", ") || "No recognized categories or columns."}</p></details>
      {item.missing.length > 0 && <details><summary>{preview.target === "deep" ? "Current case evidence gaps (before this import)" : "Checks requiring additional evidence"}</summary><ul>{[...new Set(item.missing)].map((value) => <li key={value}>{value}</li>)}</ul></details>}
      {item.warnings.map((warning, index) => <p className="preview-warning" key={index}>{warning}</p>)}
    </article>)}</div>
    <div className="workflow-actions"><button className="button" onClick={onCancel}>Cancel</button><button className="button button-primary" disabled={preview.busy || !preview.selectedIds.length} onClick={onConfirm}>{preview.target === "deep" ? "Import selected evidence" : "Analyze selected files"}</button></div>
  </WorkflowDialog>;
}
