import { useEffect, useMemo, useRef, useState } from "react";
import {
  addCaseArchives,
  addVerificationFiles,
  createHistoryArchive,
  createInvestigationHistory,
  generateOlaPreviewSql,
  generateStatisticsVerificationSql,
  historyIssueLabel,
  historyTargets,
  openHistoryArchive,
  type HistoryIssueCode,
  type HistoryTargetSummary,
  type InvestigationHistory,
} from "../deepAnalysis/history";
import "./InvestigationHistoryWorkspace.css";

interface Props {
  estimateThresholds: { ratio: number; rows: number };
}

function download(fileName: string, content: string | ArrayBuffer, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function safeName(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-|-$/g, "") || "target";
}

function displayDate(value: string): string {
  return value ? new Date(value).toLocaleString() : "Not recorded";
}

export function InvestigationHistoryWorkspace({ estimateThresholds }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [history, setHistory] = useState<InvestigationHistory | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [messages, setMessages] = useState<string[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const openInput = useRef<HTMLInputElement>(null);
  const caseInput = useRef<HTMLInputElement>(null);
  const verificationInput = useRef<HTMLInputElement>(null);
  const targets = useMemo(() => history ? historyTargets(history) : [], [history]);
  const selected = targets.find((item) => item.portableKey === selectedKey) ?? targets[0] ?? null;
  const ola = useMemo(() => history && selected ? generateOlaPreviewSql(history, selected) : { sql: null, reason: "Select a target." }, [history, selected]);

  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  const mayReplace = () => !dirty || confirm("This Investigation History has changes that have not been downloaded. Discard them?");

  const create = () => {
    if (!mayReplace()) return;
    setHistory(createInvestigationHistory());
    setSelectedKey(null);
    setMessages([]);
    setDirty(true);
    setExpanded(true);
  };

  const open = async (file: File) => {
    if (!mayReplace()) return;
    setBusy(true);
    try {
      const next = await openHistoryArchive(file);
      setHistory(next);
      setSelectedKey(null);
      setMessages([`${file.name}: opened and hash verified.`]);
      setDirty(false);
      setExpanded(true);
    } catch (error) {
      setMessages([error instanceof Error ? error.message : "The history archive could not be opened."]);
    } finally {
      setBusy(false);
    }
  };

  const addCases = async (files: File[]) => {
    if (!history || !files.length) return;
    setBusy(true);
    const result = await addCaseArchives(history, files, estimateThresholds);
    setHistory(result.history);
    setMessages(result.messages);
    setDirty(true);
    setBusy(false);
  };

  const addVerification = async (files: File[]) => {
    if (!history || !files.length) return;
    setBusy(true);
    const result = await addVerificationFiles(history, files);
    setHistory(result.history);
    setMessages(result.messages);
    setDirty(true);
    setBusy(false);
  };

  const save = async () => {
    if (!history) return;
    setBusy(true);
    try {
      const archive = await createHistoryArchive(history);
      const copy = new Uint8Array(archive.bytes);
      download(archive.fileName, copy.buffer, "application/zip");
      setMessages(["History ZIP prepared. Check browser downloads; disk storage cannot be confirmed here."]);
      setDirty(false);
    } finally {
      setBusy(false);
    }
  };

  const downloadVerification = (target: HistoryTargetSummary) => {
    if (!history) return;
    download(`SQL-Evaluate-Verify-Statistics_${safeName(target.displayName)}.sql`, generateStatisticsVerificationSql(history, target), "text/plain;charset=utf-8");
  };

  const downloadOla = (target: HistoryTargetSummary) => {
    if (!ola.sql) return;
    download(`SQL-Evaluate-Ola-Preview_${safeName(target.displayName)}.sql`, ola.sql, "text/plain;charset=utf-8");
  };

  return <section className={`history-workspace ${expanded ? "history-workspace-open" : ""}`} aria-labelledby="history-title">
    <div className="history-launch">
      <div>
        <span>CROSS-CASE MEMORY</span>
        <strong id="history-title">Investigation History</strong>
        <p>Find recurring estimate and statistics signals across sensitive case archives, without uploading or silently retaining them.</p>
      </div>
      <div className="history-actions">
        <button type="button" className="button" disabled={busy} onClick={() => openInput.current?.click()}>Open History</button>
        <button type="button" className="button button-primary" disabled={busy} onClick={create}>Create History</button>
        {history && <button type="button" className="history-toggle" onClick={() => setExpanded((value) => !value)}>{expanded ? "Collapse" : "Review"}</button>}
      </div>
    </div>
    <input ref={openInput} hidden type="file" accept=".zip,.sqlevalhistory.zip" onChange={(event) => { const file = event.target.files?.[0]; if (file) void open(file); event.target.value = ""; }} />
    <input ref={caseInput} hidden multiple type="file" accept=".zip,.sqlevalcase.zip" onChange={(event) => { void addCases([...event.target.files ?? []]); event.target.value = ""; }} />
    <input ref={verificationInput} hidden multiple type="file" accept=".csv,.tsv,.xlsx,.xls" onChange={(event) => { void addVerification([...event.target.files ?? []]); event.target.value = ""; }} />

    {expanded && history && <div className="history-body">
      <div className="history-toolbar">
        <div>
          <span>SENSITIVE LOCAL ARTIFACT</span>
          <strong>{history.title}</strong>
          <small>{history.sources.length} source cases / {targets.length} portable targets {dirty ? "/ unsaved changes" : "/ downloaded checkpoint"}</small>
        </div>
        <div className="history-actions">
          <button type="button" className="button" disabled={busy} onClick={() => caseInput.current?.click()}>Add Case ZIPs</button>
          <button type="button" className="button" disabled={busy} onClick={() => verificationInput.current?.click()}>Add Verification Results</button>
          <button type="button" className="button button-save" disabled={busy} onClick={() => void save()}>{busy ? "Working..." : "Save History ZIP"}</button>
        </div>
      </div>
      {messages.length > 0 && <div className="history-messages" role="status" aria-live="polite">{messages.map((message, index) => <p key={`${index}-${message}`}>{message}</p>)}</div>}
      <div className="history-metrics">
        <article><span>Resolved cases</span><strong>{history.sources.filter((item) => item.resolved).length}</strong><small>{history.sources.filter((item) => !item.resolved).length} awaiting server identity</small></article>
        <article><span>Actual-plan captures</span><strong>{new Set(history.captures.filter((item) => item.kind === "actual-plan").map((item) => item.id)).size}</strong><small>Distinct evidence only</small></article>
        <article><span>Servers represented</span><strong>{new Set(history.sources.flatMap((item) => item.serverName ? [item.serverName] : [])).size}</strong><small>Server-aware identity</small></article>
      </div>
      <div className="history-grid">
        <div className="history-targets" role="list" aria-label="Investigation history targets">
          {targets.map((target) => <button type="button" role="listitem" className={target.portableKey === selected?.portableKey ? "active" : ""} key={target.portableKey} onClick={() => setSelectedKey(target.portableKey)}>
            <span>{target.serverNames.length} server{target.serverNames.length === 1 ? "" : "s"}</span>
            <strong>{target.displayName}</strong>
            <small>{Object.values(target.issueCounts).reduce((sum, value) => sum + (value ?? 0), 0)} distinct issue captures / {target.planCaptureCount} evaluated plans</small>
          </button>)}
          {!targets.length && <div className="history-empty"><strong>No resolved targets yet</strong><p>Add saved cases containing a correlated actual plan and a server capability snapshot.</p></div>}
        </div>
        {selected && <article className="history-detail">
          <div className="history-detail-head"><span>PORTABLE TARGET</span><h3>{selected.displayName}</h3><p>{selected.serverNames.join(", ")}</p></div>
          <div className="history-range"><span>First seen <b>{displayDate(selected.firstSeen)}</b></span><span>Last seen <b>{displayDate(selected.lastSeen)}</b></span></div>
          <div className="history-issues">{Object.entries(selected.issueCounts).map(([code, count]) => {
            const issueCode = code as HistoryIssueCode;
            const denominator = issueCode.startsWith("statistics-") ? selected.verificationCaptureCount : selected.planCaptureCount;
            return <div key={code}><strong>{historyIssueLabel(issueCode)}</strong><span>{count} of {denominator} applicable capture{denominator === 1 ? "" : "s"}</span></div>;
          })}</div>
          <div className="history-script-gate"><span>SERVER VERIFICATION</span><strong>{selected.eligibleServerCount} server{selected.eligibleServerCount === 1 ? "" : "s"} eligible for an Ola preview</strong><p>{ola.reason} Repetition is evidence of recurrence, not proof of cause.</p></div>
          <div className="history-actions">
            <button type="button" className="button" onClick={() => downloadVerification(selected)}>Download verification SQL</button>
            <button type="button" className="button button-primary" disabled={!ola.sql} title={!ola.sql ? ola.reason : undefined} onClick={() => downloadOla(selected)}>Download Ola report-only preview</button>
          </div>
        </article>}
      </div>
    </div>}
  </section>;
}
