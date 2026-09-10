import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { AnalysisReport, Finding, Severity, ThresholdProfile, WhoIsActiveRecord } from "./types";
import { CaseDetailsEditor } from "./components/CaseDetailsEditor";
import { WorkflowDialog } from "./components/WorkflowDialog";
import { ImportPreviewDialog } from "./components/ImportPreviewDialog";
import type { PreviewState } from "./components/ImportPreviewDialog";
import { useDocumentCheckpoint } from "./lib/useDocumentCheckpoint";
import { updateCaseDetails } from "./deepAnalysis/metadata";
import type { PreparedEvidenceBatch } from "./deepAnalysis/case";
import type { PreviewWorkerRequest } from "./lib/preparedAnalysis";
import { DropZone } from "./components/DropZone";
import { DeepAnalysisWorkspace } from "./components/DeepAnalysisWorkspace";
import { InvestigationHistoryWorkspace } from "./components/InvestigationHistoryWorkspace";
import { FindingDrawer } from "./components/FindingDrawer";
import { InvestigationGuide } from "./components/InvestigationGuide";
import { SeverityBadge } from "./components/SeverityBadge";
import { ThresholdProfileManager } from "./components/ThresholdProfileManager";
import type { DeepAnalysisCase, EvidenceImportMessage } from "./deepAnalysis/types";
import { prepareEvidenceFiles, commitEvidenceFiles, chooseSpillPlanStatement, clearSpillPlanStatement, createDeepAnalysisCase, createDeepCaseArchive, createSpillTriageCase, openDeepCaseArchive, selectSpillCandidate } from "./deepAnalysis/case";
import { deepAnalysisProfileForFinding } from "./deepAnalysis/profile";
import { downloadBlob, findingsCsv, printableReport, redactReport, validateReport } from "./lib/report";
import { createRunArchive } from "./lib/runBundle";
import { formatDuration, formatNumber, formatTempdbPages } from "./lib/utils";
import { APP_VERSION } from "./version";
import { activateThresholdProfile, addThresholdProfile, DEFAULT_THRESHOLD_PROFILE_ENTRY, deleteThresholdProfile, loadThresholdProfileState } from "./rules/thresholdProfileStore";
import { composeInvestigationGuideSafely } from "./rules/investigationGuide";
import type { ThresholdProfileEntry } from "./rules/thresholdProfileStore";

type Tab = "findings" | "deep" | "activity" | "plans" | "quality";
type ActivitySort = "session" | "collected" | "status" | "wait" | "blocker" | "runtime" | "cpu" | "reads" | "writes" | "tempdb";
const tabs: Tab[] = ["findings", "deep", "activity", "plans", "quality"];
const ACTIVITY_PAGE_SIZE = 100;
const severities: Severity[] = ["Critical", "High", "Medium", "Low", "Informational", "Not Evaluated"];
const severityOrder: Record<Severity, number> = { Critical: 6, High: 5, Medium: 4, Low: 3, Informational: 2, "Not Evaluated": 1 };

function activityValue(record: WhoIsActiveRecord, sort: ActivitySort): string | number | null {
  if (sort === "session") return record.sessionId;
  if (sort === "collected") return record.collectionTime;
  if (sort === "status") return record.status;
  if (sort === "wait") return record.wait?.type ?? null;
  if (sort === "blocker") return record.blockingSessionId;
  if (sort === "runtime") return record.durationSeconds;
  if (sort === "cpu") return record.cpuMs;
  if (sort === "reads") return record.reads;
  if (sort === "writes") return record.writes;
  return record.tempdbCurrentPages;
}

function browserProfileStorage(): Storage | null {
  try {
    const storage = window.localStorage;
    return storage && typeof storage.getItem === "function" && typeof storage.setItem === "function" ? storage : null;
  } catch {
    return null;
  }
}

function SignalRail({ report }: { report: AnalysisReport }) {
  const points = useMemo(() => {
    const byTime = new Map<string, number>();
    report.records.forEach((record) => { if (record.collectionTime) byTime.set(record.collectionTime, (byTime.get(record.collectionTime) ?? 0) + ((record.blockingSessionId ?? 0) > 0 ? 3 : 0) + (record.wait ? 1 : 0)); });
    return [...byTime.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-72);
  }, [report]);
  const max = Math.max(1, ...points.map(([, value]) => value));
  if (!points.length) return <div className="empty-mini">No collection timeline in this input.</div>;
  return <div className="signal-rail" aria-label="Activity signal by collection time">{points.map(([time, value]) => <span key={time} title={`${new Date(time).toLocaleString()}: signal ${value}`} style={{ height: `${Math.max(5, value / max * 100)}%` }} />)}</div>;
}

function App() {
  const [report, setReport] = useState<AnalysisReport | null>(null);
  const [reportImportedLegacy, setReportImportedLegacy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [uploadMessages, setUploadMessages] = useState<EvidenceImportMessage[]>([]);
  const [tab, setTab] = useState<Tab>("findings");
  const [selected, setSelected] = useState<Finding | null>(null);
  const [severity, setSeverity] = useState<Severity | "All">("All");
  const [category, setCategory] = useState("All");
  const [query, setQuery] = useState("");
  const [activitySession, setActivitySession] = useState("");
  const [activitySort, setActivitySort] = useState<ActivitySort>("collected");
  const [activityAscending, setActivityAscending] = useState(true);
  const [activityPage, setActivityPage] = useState(0);
  const [activityRecordIds, setActivityRecordIds] = useState<string[] | null>(null);
  const [rawExport, setRawExport] = useState(false);
  const [sourceFiles, setSourceFiles] = useState<File[]>([]);
  const [savingRun, setSavingRun] = useState(false);
  const [deepCase, setDeepCase] = useState<DeepAnalysisCase | null>(null);
  const [deepFiles, setDeepFiles] = useState<File[]>([]);
  const [deepBusy, setDeepBusy] = useState(false);
  const [profileEntries, setProfileEntries] = useState<ThresholdProfileEntry[]>([DEFAULT_THRESHOLD_PROFILE_ENTRY]);
  const [activeProfile, setActiveProfile] = useState<ThresholdProfileEntry>(DEFAULT_THRESHOLD_PROFILE_ENTRY);
  const [profileWarnings, setProfileWarnings] = useState<string[]>([]);
  const [profileReady, setProfileReady] = useState(false);
  const reportCheckpoint = useDocumentCheckpoint(report);
  const caseCheckpoint = useDocumentCheckpoint(deepCase);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [replacement, setReplacement] = useState<{ action(): void; report: boolean; deep: boolean } | null>(null);
  const [guardBusy, setGuardBusy] = useState(false);
  const requestId = useRef(0);
  const pendingEvidence = useRef<PreparedEvidenceBatch | null>(null);
  const chosenAnalysisIds = useRef<string[]>([]);
  const incomingFiles = useRef<File[]>([]);
  const sourceSheets = useRef(new Map<File, string>());
  const busy = loading || deepBusy || savingRun || guardBusy;
  const workflowLocked = busy || Boolean(preview) || Boolean(replacement);
  const profileStorageRef = useRef<Storage | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const closeDrawer = useCallback(() => setSelected(null), []);
  const showInvestigationGuide = useCallback(() => {
    setSelected(null);
    setTab("findings");
    window.setTimeout(() => {
      const guide = document.getElementById("investigation-guide");
      guide?.focus();
      guide?.scrollIntoView?.({ block: "start" });
    }, 0);
  }, []);
  const resetReportView = useCallback(() => {
    setSelected(null);
    setSeverity("All");
    setCategory("All");
    setQuery("");
    setActivitySession("");
    setActivityRecordIds(null);
    setActivityPage(0);
    setActivitySort("collected");
    setActivityAscending(true);
  }, []);

  useEffect(() => () => { requestId.current++; workerRef.current?.terminate(); }, []);
  useEffect(() => {
    if (!reportCheckpoint.dirty && !caseCheckpoint.dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [reportCheckpoint.dirty, caseCheckpoint.dirty]);

  function replaceWorkspace(action: () => void, replacesReport: boolean, replacesCase: boolean) {
    const losesReport = replacesReport && reportCheckpoint.dirty;
    const losesCase = replacesCase && caseCheckpoint.dirty;
    if (losesReport || losesCase) setReplacement({ action, report: losesReport, deep: losesCase });
    else action();
  }

  function cancelPreview() {
    requestId.current++;
    workerRef.current?.postMessage({ type: "discard", requestId: requestId.current } satisfies PreviewWorkerRequest);
    workerRef.current?.terminate();
    workerRef.current = null;
    pendingEvidence.current = null;
    setPreview(null); setLoading(false); setDeepBusy(false);
  }
  useEffect(() => {
    let mounted = true;
    const storage = browserProfileStorage();
    profileStorageRef.current = storage;
    void loadThresholdProfileState(storage).then((state) => {
      if (!mounted) return;
      setProfileEntries(state.entries);
      setActiveProfile(state.active);
      setProfileWarnings(state.warnings);
      setProfileReady(true);
    });
    return () => { mounted = false; };
  }, []);

  const activateProfile = (entry: ThresholdProfileEntry) => {
    try {
      activateThresholdProfile(profileStorageRef.current, entry);
      setActiveProfile(entry);
    } catch (error) {
      if (entry.builtIn) setActiveProfile(DEFAULT_THRESHOLD_PROFILE_ENTRY);
      setProfileWarnings((current) => [...current, `Profile selection was not persisted: ${error instanceof Error ? error.message : "Local storage failed."}`]);
    }
  };

  const storeProfile = async (profile: ThresholdProfile) => {
    const result = await addThresholdProfile(profileStorageRef.current, profileEntries, profile);
    if (result.added) setProfileEntries(result.entries);
    return { entry: result.entry, added: result.added };
  };

  const removeProfile = (entry: ThresholdProfileEntry) => {
    if (!confirm(`Delete ${entry.profile.name} (${entry.snapshot.id}@${entry.snapshot.version})?${entry.snapshot.digest === activeProfile.snapshot.digest ? " The built-in default will become active." : ""}`)) return;
    try {
      const next = deleteThresholdProfile(profileStorageRef.current, profileEntries, entry, activeProfile);
      setProfileEntries(next.entries);
      setActiveProfile(next.active);
    } catch (error) {
      setProfileWarnings((current) => [...current, `Profile deletion failed: ${error instanceof Error ? error.message : "Local storage failed."}`]);
    }
  };

  async function openDeepCase(file: File) {
    if (workflowLocked) return;
    const token = ++requestId.current;
    setDeepBusy(true);
    try {
      const opened = await openDeepCaseArchive(file);
      if (token !== requestId.current) return;
      replaceWorkspace(() => {
        setDeepCase(opened.deepCase); caseCheckpoint.loaded(opened.deepCase);
        setDeepFiles(opened.files); setSelected(null); setErrors([]); setUploadMessages([]); setTab("deep");
      }, false, true);
    } catch (error) {
      if (token === requestId.current) setErrors([`Deep Analysis case could not be opened: ${error instanceof Error ? error.message : "Unknown case error"}`]);
    } finally { if (token === requestId.current) setDeepBusy(false); }
  }

  function prepareMain(files: File[], append = false, sheets: Record<string, string> = {}, selectedIds?: string[]) {
    const token = ++requestId.current;
    workerRef.current?.terminate();
    const initial: PreviewState = { target: "analysis", files, append, sheets, selectedIds: selectedIds ?? [], items: [], busy: true };
    setPreview(initial); setLoading(true); setProgress("Preparing import preview"); setErrors([]);
    let worker: Worker;
    try { worker = new Worker(new URL("./analysis.worker.ts", import.meta.url), { type: "module" }); }
    catch (error) { setErrors([`Worker startup phase failed: ${error instanceof Error ? error.message : "Unavailable"}`]); setLoading(false); setPreview(null); return; }
    workerRef.current = worker;
    const fail = (messages: string[]) => {
      if (token !== requestId.current) return;
      setErrors(messages); setLoading(false); setPreview(null); worker.terminate(); workerRef.current = null;
    };
    worker.onerror = (event) => { event.preventDefault(); fail([`Worker failed: ${event.message || "Select the files again."}`]); };
    worker.onmessageerror = () => fail(["Worker response could not be read. Select the files again."]);
    let preparedSheets: Record<string, string> = {};
    worker.onmessage = (event) => {
      if (token !== requestId.current || event.data.requestId !== token) return;
      if (event.data.type === "progress") setProgress(`Inspected ${event.data.fileName}`);
      if (event.data.type === "prepared") {
        preparedSheets = Object.fromEntries(event.data.previews.filter((item: { selectedSheet?: string }) => item.selectedSheet).map((item: { id: string; selectedSheet: string }) => [item.id, item.selectedSheet]));
        setPreview({ ...initial, items: event.data.previews, busy: false, selectedIds: event.data.previews.filter((item: { usable: boolean; id: string }) => item.usable && (!selectedIds || selectedIds.includes(item.id))).map((item: { id: string }) => item.id) });
        setLoading(false);
      }
      if (event.data.type === "complete") {
        const result: AnalysisReport = event.data.report;
        const keptFiles = chosenAnalysisIds.current.map((id) => files[Number(id)]);
        const keptSheets = new Map<File, string>();
        chosenAnalysisIds.current.forEach((id) => { const sheet = preparedSheets[id]; if (sheet) keptSheets.set(files[Number(id)], sheet); });
        setPreview(null); setLoading(false); worker.terminate(); workerRef.current = null;
        replaceWorkspace(() => {
          setReport(result); reportCheckpoint.reset(); setReportImportedLegacy(false);
          setSourceFiles(keptFiles); sourceSheets.current = keptSheets;
          setDeepCase(null); caseCheckpoint.reset(); setDeepFiles([]); setErrors(event.data.errors);
          setUploadMessages([]); resetReportView(); setTab("findings");
        }, true, true);
      }
      if (event.data.type === "error") fail(event.data.errors);
    };
    try { worker.postMessage({ type: "prepare", requestId: token, files, sheets }); }
    catch (error) { fail([`Worker input-transfer phase failed: ${error instanceof Error ? error.message : "Unavailable"}`]); }
  }

  const analyzeFiles = async (files: File[], append = false) => {
    if (!files.length || workflowLocked) return;
    const caseFile = files.find((file) => file.name.toLowerCase().endsWith(".sqlevalcase.zip"));
    if (caseFile) {
      if (files.length !== 1) { setErrors(["Open a saved .sqlevalcase.zip by itself; other selected files were not analyzed."]); return; }
      await openDeepCase(caseFile); return;
    }
    const reportFile = files.find((file) => file.name.toLowerCase().endsWith(".sqleval.json"));
    if (reportFile) {
      if (files.length !== 1) { setErrors(["Open a saved .sqleval.json report by itself; other selected files were not analyzed."]); return; }
      if (reportFile.size > 100 * 1024 * 1024) { setErrors(["Saved reports are limited to 100 MB."]); return; }
      const token = ++requestId.current;
      setLoading(true);
      try {
        const opened = await validateReport(JSON.parse(await reportFile.text()));
        if (token !== requestId.current) return;
        const next = opened.investigationGuide ? opened : { ...opened, investigationGuide: composeInvestigationGuideSafely(opened) };
        replaceWorkspace(() => {
          setReport(next); reportCheckpoint.loaded(next); setReportImportedLegacy(!opened.thresholdProfile);
          setSourceFiles([]); sourceSheets.current.clear(); setDeepCase(null); caseCheckpoint.reset(); setDeepFiles([]);
          setErrors([]); setUploadMessages([]); resetReportView(); setTab("findings");
        }, true, true);
      } catch (error) { if (token === requestId.current) setErrors([error instanceof Error ? error.message : "Report could not be opened."]); }
      finally { if (token === requestId.current) setLoading(false); }
      return;
    }
    incomingFiles.current = files;
    const combined = append && sourceFiles.length ? [...new Set([...sourceFiles, ...files])] : files;
    prepareMain(combined, append && sourceFiles.length > 0, Object.fromEntries(combined.flatMap((file, index) => sourceSheets.current.has(file) ? [[String(index), sourceSheets.current.get(file)!]] : [])));
  };

  function changePreview(next: PreviewState) {
    if (!preview || preview.busy) return;
    if (next.target === "analysis" && next.append !== preview.append) {
      const chosen = next.append ? [...new Set([...sourceFiles, ...incomingFiles.current])] : incomingFiles.current;
      const overrides = new Map(sourceSheets.current);
      preview.files.forEach((file, index) => { const sheet = preview.sheets[String(index)] ?? preview.items.find((item) => item.id === String(index))?.selectedSheet; if (sheet) overrides.set(file, sheet); });
      prepareMain(chosen, next.append, Object.fromEntries(chosen.flatMap((file, index) => overrides.has(file) ? [[String(index), overrides.get(file)!]] : [])));
    } else setPreview(next);
  }

  function confirmPreview() {
    if (!preview || preview.busy || !preview.selectedIds.length) return;
    if (preview.target === "analysis") {
      chosenAnalysisIds.current = [...preview.selectedIds];
      setPreview({ ...preview, busy: true }); setLoading(true); setProgress("Analyzing selected evidence");
      try { workerRef.current?.postMessage({ type: "analyze", requestId: requestId.current, selectedIds: preview.selectedIds, thresholdProfile: activeProfile.snapshot } satisfies PreviewWorkerRequest); }
      catch (error) { cancelPreview(); setErrors([error instanceof Error ? error.message : "Analysis could not start."]); }
    } else if (deepCase && pendingEvidence.current) {
      const result = commitEvidenceFiles(deepCase, pendingEvidence.current, new Set(preview.selectedIds.map((id) => preview.files[Number(id)])));
      setDeepCase(result.deepCase); setDeepFiles((current) => [...current, ...result.acceptedFiles]); setUploadMessages(result.messages);
      setErrors([]); pendingEvidence.current = null; setPreview(null);
    }
  }

  const filtered = useMemo(() => {
    if (!report) return [];
    return report.findings.filter((finding) => (severity === "All" || finding.severity === severity) && (category === "All" || finding.category === category) && (!query || `${finding.title} ${finding.summary} ${finding.ruleId}`.toLowerCase().includes(query.toLowerCase())));
  }, [report, severity, category, query]);
  const deepRecommendations = useMemo(() => report ? report.findings
    .filter((finding) => Boolean(deepAnalysisProfileForFinding(finding))
      && (finding.severity !== "Informational" || finding.ruleId === "PLAN-RUNTIME-UNAVAILABLE"))
    .sort((a, b) => severityOrder[b.severity] - severityOrder[a.severity] || b.impact - a.impact) : [], [report]);
  const categories = report ? [...new Set(report.findings.map((finding) => finding.category))].sort() : [];
  const relatedFindings = useMemo(() => {
    if (!report || !selected?.relatedFindings?.length) return [];
    const byId = new Map(report.findings.map((finding) => [finding.id, finding]));
    return selected.relatedFindings.flatMap((link) => { const related = byId.get(link.findingId); return related ? [related] : []; });
  }, [report, selected]);
  const selectedGuideStep = useMemo(() => selected ? report?.investigationGuide?.steps.find((step) => step.sourceFindingIds.includes(selected.id)) : undefined, [report, selected]);
  const activityRows = useMemo(() => {
    if (!report) return [];
    const affected = activityRecordIds ? new Set(activityRecordIds) : null;
    const sessionQuery = activitySession.trim().toLowerCase();
    return report.records
      .filter((record) => (!affected || affected.has(record.id)) && (!sessionQuery || String(record.sessionId ?? "").toLowerCase().includes(sessionQuery)))
      .sort((left, right) => {
        const a = activityValue(left, activitySort);
        const b = activityValue(right, activitySort);
        if (a === b) return left.rowNumber - right.rowNumber;
        if (a === null) return 1;
        if (b === null) return -1;
        const compared = typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b));
        return activityAscending ? compared : -compared;
      });
  }, [report, activityRecordIds, activitySession, activitySort, activityAscending]);
  const activityPages = Math.max(1, Math.ceil(activityRows.length / ACTIVITY_PAGE_SIZE));
  const activityPageRows = activityRows.slice(activityPage * ACTIVITY_PAGE_SIZE, (activityPage + 1) * ACTIVITY_PAGE_SIZE);
  useEffect(() => { setActivityPage(0); }, [report, activityRecordIds, activitySession, activitySort, activityAscending]);
  const priority = report?.findings.filter((finding) => finding.severity === "Critical" || finding.severity === "High").length ?? 0;
  const highest = report ? [...report.findings].sort((a, b) => severityOrder[b.severity] - severityOrder[a.severity])[0]?.severity ?? "Not Evaluated" : "Not Evaluated";
  const worksheetInputs = report?.inputs.filter((input) => Boolean(input.sheetName)) ?? [];
  const collectionTimes = report ? report.records.map((record) => record.collectionTime).filter((value): value is string => Boolean(value)).sort() : [];
  const collectionSpan = collectionTimes.length > 1 ? (new Date(collectionTimes.at(-1)!).getTime() - new Date(collectionTimes[0]).getTime()) / 1000 : 0;

  const selectActivitySort = (next: ActivitySort) => {
    if (activitySort === next) setActivityAscending((current) => !current);
    else { setActivitySort(next); setActivityAscending(true); }
  };
  const activitySortButton = (label: string, key: ActivitySort) => <button type="button" onClick={() => selectActivitySort(key)} aria-label={`Sort activity by ${label}${activitySort === key ? `, currently ${activityAscending ? "ascending" : "descending"}` : ""}`}>{label}{activitySort === key ? <span aria-hidden="true">{activityAscending ? " ↑" : " ↓"}</span> : null}</button>;
  const handleTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number | null = null;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = tabs.length - 1;
    if (next === null) return;
    event.preventDefault();
    setTab(tabs[next]);
    requestAnimationFrame(() => document.getElementById(`tab-${tabs[next]}`)?.focus());
  };
  const showAffectedActivity = useCallback((finding: Finding) => {
    if (!finding.affectedRecordIds.length) return;
    setActivityRecordIds(finding.affectedRecordIds);
    setActivitySession("");
    setActivityPage(0);
    setTab("activity");
    setSelected(null);
    requestAnimationFrame(() => document.getElementById("panel-activity")?.focus());
  }, []);

  const exportReport = (kind: "json" | "csv" | "html") => {
    if (!report || busy) return false;
    try {
      if (!report.thresholdProfile && !reportImportedLegacy) throw new Error("Export refused: the generated report has no resolved threshold profile.");
      const output = rawExport ? report : redactReport(report);
      if (kind === "json") { downloadBlob("sql-evaluate-report.sqleval.json", JSON.stringify(output, null, 2), "application/json"); reportCheckpoint.downloaded(report); }
      if (kind === "csv") downloadBlob("sql-evaluate-findings.csv", findingsCsv(output), "text/csv;charset=utf-8");
      if (kind === "html") downloadBlob("sql-evaluate-report.html", printableReport(output), "text/html;charset=utf-8");
      return true;
    } catch (error) { setErrors([error instanceof Error ? error.message : "Export failed."]); return false; }
  };

  const saveRun = async () => {
    if (!report || savingRun) return false;
    const snapshot = report;
    setSavingRun(true);
    try {
      const archive = await createRunArchive(snapshot, sourceFiles, { includeRaw: rawExport, processingErrors: errors, allowLegacyReport: reportImportedLegacy });
      const archiveBytes = new Uint8Array(archive.bytes.byteLength); archiveBytes.set(archive.bytes);
      downloadBlob(archive.fileName, archiveBytes.buffer, "application/zip");
      reportCheckpoint.downloaded(snapshot);
      return true;
    } catch (error) {
      setErrors((current) => [...current, `Run archive could not be created: ${error instanceof Error ? error.message : "Unknown export error"}`]);
      return false;
    } finally { setSavingRun(false); }
  };

  const startDeepAnalysis = (finding: Finding) => {
    if (!report || workflowLocked) return;
    try {
      const next = createDeepAnalysisCase(report, finding);
      replaceWorkspace(() => { setDeepCase(next); caseCheckpoint.reset(); setDeepFiles([]); setErrors([]); setUploadMessages([]); setSelected(null); setTab("deep"); }, false, true);
    } catch (error) { setErrors([`Deep Analysis could not start: ${error instanceof Error ? error.message : "Unknown case error"}`]); }
  };

  const startSpillTriage = () => {
    if (workflowLocked) return;
    const next = createSpillTriageCase();
    replaceWorkspace(() => { setDeepCase(next); caseCheckpoint.reset(); setDeepFiles([]); setErrors([]); setUploadMessages([]); setSelected(null); setTab("deep"); }, false, true);
  };

  const selectDeepSpillCandidate = (candidateId: string) => {
    if (!workflowLocked) setDeepCase((current) => current && current.spillTriage?.selectedCandidateId !== candidateId ? selectSpillCandidate(current, candidateId) : current);
  };
  const chooseDeepSpillPlan = (candidateId: string, artifactId: string, statementId: string) => {
    if (!workflowLocked) setDeepCase((current) => current ? chooseSpillPlanStatement(current, candidateId, artifactId, statementId) : current);
  };
  const clearDeepSpillPlan = (candidateId: string) => {
    if (!workflowLocked) setDeepCase((current) => current?.spillTriage?.manualPlanSelections.some((item) => item.candidateId === candidateId) ? clearSpillPlanStatement(current, candidateId) : current);
  };

  const importDeepEvidence = async (files: File[]) => {
    if (!deepCase || !files.length || workflowLocked) return;
    const token = ++requestId.current;
    setDeepBusy(true);
    setPreview({ target: "deep", files, items: [], selectedIds: [], sheets: {}, append: true, busy: true });
    try {
      const batch = await prepareEvidenceFiles(deepCase, files);
      if (token !== requestId.current) return;
      pendingEvidence.current = batch;
      setPreview({ target: "deep", files, items: batch.previews, selectedIds: batch.previews.filter((item) => item.usable).map((item) => item.id), sheets: {}, append: true, busy: false });
    } catch (error) {
      if (token !== requestId.current) return;
      setPreview(null); setErrors([`Deep Analysis evidence could not be inspected: ${error instanceof Error ? error.message : "Unknown error"}`]);
    } finally { if (token === requestId.current) setDeepBusy(false); }
  };

  const saveDeepCase = async () => {
    if (!deepCase || deepBusy) return false;
    if (!confirm("This working case may contain raw SQL, plans, identifiers, database names, parameters, and handwritten notes. Save the sensitive case ZIP to a protected internal location?")) return false;
    const snapshot = deepCase;
    setDeepBusy(true);
    try {
      const archive = await createDeepCaseArchive(snapshot, deepFiles);
      const bytes = new Uint8Array(archive.bytes.byteLength); bytes.set(archive.bytes);
      downloadBlob(archive.fileName, bytes.buffer, "application/zip");
      caseCheckpoint.downloaded(snapshot);
      return true;
    } catch (error) {
      setErrors([`Deep Analysis case could not be saved: ${error instanceof Error ? error.message : "Unknown case export error"}`]); return false;
    } finally { setDeepBusy(false); }
  };

  const resolveReplacement = async (download: boolean) => {
    if (!replacement || guardBusy) return;
    const pending = replacement;
    setGuardBusy(true);
    try {
      if (download && pending.report && !await saveRun()) { setReplacement(null); return; }
      if (download && pending.deep && !await saveDeepCase()) { setReplacement(null); return; }
      setReplacement(null); pending.action();
    } finally { setGuardBusy(false); }
  };

  return <div className="app-shell">
    <header className="topbar"><div className="brand"><span className="brand-mark"><i /><i /><i /></span><div><strong>SQL Evaluate</strong><span>Activity &amp; plan triage</span></div></div><div className="privacy-chip"><span className="pulse" />LOCAL ONLY · 127.0.0.1</div></header>
    <main inert={workflowLocked ? true : undefined}>
      <section className="hero"><div><div className="eyebrow">SQL SERVER DIAGNOSTIC CONSOLE</div><h1>Turn a capture into<br /><em>an investigation.</em></h1><p>Load <code>sp_WhoIsActive</code> output or a Showplan file. Your data stays in this browser session; findings show their evidence and limits.</p></div><div className="hero-grid" aria-hidden="true"><span>BLOCK</span><b>CHAIN</b><span>WAIT</span><b>TYPE</b><span>PLAN</span><b>XML</b></div></section>
      <DropZone disabled={workflowLocked || !profileReady} onFiles={analyzeFiles} />
      <input id="guide-evidence-input" hidden multiple type="file" accept=".csv,.tsv,.xlsx,.xls,.sqlplan,.xml" onChange={(event) => { void analyzeFiles([...event.target.files ?? []], true); event.target.value = ""; }} />
      <InvestigationHistoryWorkspace estimateThresholds={{ ratio: activeProfile.snapshot.thresholds.plans.mediumEstimateRatio, rows: activeProfile.snapshot.thresholds.plans.mediumRows }} />
      <ThresholdProfileManager entries={profileEntries} active={activeProfile} reportProfile={report?.thresholdProfile} ready={profileReady} warnings={profileWarnings} onActivate={activateProfile} onStore={storeProfile} onDelete={removeProfile} />
      {loading && <div className="processing"><span className="loader" /><div><strong>Analyzing locally</strong><p>{progress}</p></div></div>}
      {errors.length > 0 && <div className="error-panel"><strong>Some input could not be processed</strong>{errors.map((error) => <p key={error}>{error}</p>)}</div>}
      {uploadMessages.length > 0 && (!deepCase || deepCase.profileId !== "spill-triage") && <div className="upload-message-panel" role="status" aria-live="polite"><strong>Evidence import results</strong>{uploadMessages.map((item, index) => <p className={`upload-message-${item.severity}`} key={`${item.fileName}-${item.code}-${index}`}><b>{item.fileName}</b>: {item.message}</p>)}</div>}
      {report && <div className="download-status" role="status"><strong>Report: {reportCheckpoint.label}</strong>{reportCheckpoint.downloadedAt && <p>Latest download prepared: {new Date(reportCheckpoint.downloadedAt).toLocaleString()}. Check your browser downloads. Original inputs are included only in a Run ZIP with raw details enabled.</p>}</div>}
      {deepCase && <div className="download-status" role="status"><strong>Case: {caseCheckpoint.label}</strong>{caseCheckpoint.downloadedAt && <p>Latest download prepared: {new Date(caseCheckpoint.downloadedAt).toLocaleString()}. Check your browser downloads; disk storage cannot be confirmed here.</p>}</div>}
      {deepCase && (tab === "deep" || !report) && <CaseDetailsEditor key={deepCase.id} deepCase={deepCase} onApply={(details) => setDeepCase((current) => current ? updateCaseDetails(current, details) : current)} />}
      {report && <>
        <section className="report-meta"><div><span>ANALYSIS / {new Date(report.createdAt).toLocaleDateString()}</span><strong>{report.inputs.map((input) => input.fileName).join(" + ")}</strong><small className="report-profile">{report.thresholdProfile ? `Profile ${report.thresholdProfile.id}@${report.thresholdProfile.version} · ${report.thresholdProfile.digest.slice(0, 12)}` : "Legacy report · threshold profile not recorded"}</small></div><div className="report-actions"><label className="raw-toggle"><input type="checkbox" checked={rawExport} onChange={(event) => { if (event.target.checked && !confirm("Raw exports and run archives may contain the original capture, SQL text, host names, logins, database names, and parameter values. Include them?")) return; setRawExport(event.target.checked); }} />Include raw details</label><button className="button button-save" disabled={savingRun} onClick={saveRun}>{savingRun ? "Preparing ZIP…" : "Save Run ZIP"}</button><button className="button" onClick={() => exportReport("json")}>JSON</button><button className="button" onClick={() => exportReport("csv")}>CSV</button><button className="button" onClick={() => exportReport("html")}>Print HTML</button></div></section>
        <section className="kpi-grid">
          <div className="kpi kpi-primary"><span>HIGHEST CONCERN</span><strong><SeverityBadge severity={highest} /></strong><small>{priority ? `${priority} item${priority === 1 ? " needs" : "s need"} priority review` : "No critical or high-severity finding"}</small></div>
          <div className="kpi"><span>ACTIVITY ROWS</span><strong>{report.records.length.toLocaleString()}</strong><small>{new Set(report.records.map((record) => record.collectionTime).filter(Boolean)).size} collection points</small></div>
          <div className="kpi"><span>CAPTURE WINDOW</span><strong>{formatDuration(collectionSpan)}</strong><small>{report.inputs.length} source file{report.inputs.length === 1 ? "" : "s"}</small></div>
          <div className="kpi"><span>PLAN DOCUMENTS</span><strong>{report.plans.length}</strong><small>{report.plans.reduce((sum, plan) => sum + plan.statements.length, 0)} statements inspected</small></div>
          <div className="kpi"><span>CHECK COVERAGE</span><strong>{report.dataQuality.presentColumns.length}<i>/50</i></strong><small>{report.dataQuality.notEvaluatedRules.length} rule groups unavailable</small></div>
        </section>
        <section className="overview-grid"><div className="panel"><div className="panel-title"><div><span>SEVERITY PROFILE</span><strong>Findings by concern</strong></div></div><div className="severity-bars">{severities.map((item) => { const count = report.findings.filter((finding) => finding.severity === item).length; const max = Math.max(1, ...severities.map((candidate) => report.findings.filter((finding) => finding.severity === candidate).length)); return <button key={item} onClick={() => { setSeverity(item); setTab("findings"); }}><span>{item}</span><i><b className={`fill fill-${item.toLowerCase().replace(" ", "-")}`} style={{ width: `${count / max * 100}%` }} /></i><strong>{count}</strong></button>; })}</div></div><div className="panel"><div className="panel-title"><div><span>CAPTURE SIGNAL</span><strong>Waits + blocking observations</strong></div><small>Last 72 points</small></div><SignalRail report={report} /></div></section>
        <nav className="tabs" role="tablist" aria-label="Analysis views">{tabs.map((item, index) => <button key={item} id={`tab-${item}`} role="tab" aria-selected={tab === item} aria-controls={`panel-${item}`} tabIndex={tab === item ? 0 : -1} className={tab === item ? "active" : ""} onKeyDown={(event) => handleTabKeyDown(event, index)} onClick={() => setTab(item)}>{item === "quality" ? "Data quality" : item === "deep" ? "Deep Analysis" : item}<span>{item === "findings" ? report.findings.length : item === "deep" ? deepCase ? deepCase.artifacts.length : deepRecommendations.length : item === "activity" ? report.records.length : item === "plans" ? report.plans.length : worksheetInputs.length + report.dataQuality.warnings.length + report.dataQuality.notEvaluatedRules.length + (report.dataQuality.findingCaps?.length ?? 0) + (report.dataQuality.suppressedSignals?.length ?? 0)}</span></button>)}</nav>
        {tab === "findings" && report.investigationGuide && <InvestigationGuide guide={report.investigationGuide} findings={report.findings} onSelectFinding={setSelected} onDeepAnalysis={startDeepAnalysis} onUpload={() => document.getElementById("guide-evidence-input")?.click()} />}
        {tabs.filter((item) => item !== tab).map((item) => <section key={`inactive-${item}`} id={`panel-${item}`} role="tabpanel" aria-labelledby={`tab-${item}`} hidden />)}
        {tab === "findings" && <section id="panel-findings" role="tabpanel" aria-labelledby="tab-findings" tabIndex={0} className="data-panel"><div className="filters"><input aria-label="Search findings" placeholder="Search findings…" value={query} onChange={(event) => setQuery(event.target.value)} /><select aria-label="Severity filter" value={severity} onChange={(event) => setSeverity(event.target.value as Severity | "All")}><option>All</option>{severities.map((item) => <option key={item}>{item}</option>)}</select><select aria-label="Category filter" value={category} onChange={(event) => setCategory(event.target.value)}><option>All</option>{categories.map((item) => <option key={item}>{item}</option>)}</select><span>{filtered.length} shown</span></div><div className="finding-table" role="table"><div className="finding-row finding-header" role="row"><span>Concern</span><span>Finding</span><span>Evidence</span><span>Confidence</span><span /></div>{filtered.map((item) => <button className="finding-row" role="row" key={item.id} onClick={() => setSelected(item)}><span><SeverityBadge severity={item.severity} /></span><span><strong>{item.title}</strong><small>{item.category} · {item.ruleId}</small></span><span>{item.summary}</span><span aria-label={`${item.confidence} confidence`} className={`confidence confidence-${item.confidence.toLowerCase()}`}>{item.confidence} conf.</span><span className="row-arrow">→</span></button>)}</div>{!filtered.length && <div className="empty-table">No findings match these filters.</div>}</section>}
        {tab === "deep" && <section id="panel-deep" role="tabpanel" aria-labelledby="tab-deep" tabIndex={0} className="tabpanel"><DeepAnalysisWorkspace deepCase={deepCase} recommendations={deepRecommendations} busy={deepBusy} onStart={startDeepAnalysis} onStartSpillTriage={startSpillTriage} onSelectSpillCandidate={selectDeepSpillCandidate} onChooseSpillPlan={chooseDeepSpillPlan} onClearSpillPlan={clearDeepSpillPlan} onImport={importDeepEvidence} onSave={saveDeepCase} onOpen={openDeepCase} estimateThresholds={{ ratio: activeProfile.snapshot.thresholds.plans.mediumEstimateRatio, rows: activeProfile.snapshot.thresholds.plans.mediumRows }} importMessages={uploadMessages} /></section>}
        {tab === "activity" && <section id="panel-activity" role="tabpanel" aria-labelledby="tab-activity" tabIndex={0} className="data-panel"><div className="section-intro"><div><span>RAW ACTIVITY</span><strong>{activityRecordIds ? `${activityRows.length} affected row${activityRows.length === 1 ? "" : "s"}` : `${activityRows.length} normalized row${activityRows.length === 1 ? "" : "s"}`}</strong></div><p>Filter, sort, and page through normalized evidence. Original columns remain available in JSON export.</p></div><div className="activity-controls"><label>Session<input aria-label="Filter activity by session" placeholder="SPID" value={activitySession} onChange={(event) => setActivitySession(event.target.value)} /></label>{activityRecordIds && <button type="button" className="button" onClick={() => setActivityRecordIds(null)}>Clear affected-row filter</button>}<span>Rows {activityRows.length ? activityPage * ACTIVITY_PAGE_SIZE + 1 : 0}–{Math.min((activityPage + 1) * ACTIVITY_PAGE_SIZE, activityRows.length)} of {activityRows.length}</span></div><div className="raw-scroll"><table><thead><tr><th>{activitySortButton("Session", "session")}</th><th>{activitySortButton("Collected", "collected")}</th><th>{activitySortButton("Status", "status")}</th><th>{activitySortButton("Wait", "wait")}</th><th>{activitySortButton("Blocker", "blocker")}</th><th>{activitySortButton("Runtime", "runtime")}</th><th>{activitySortButton("CPU", "cpu")}</th><th>{activitySortButton("Reads", "reads")}</th><th>{activitySortButton("Writes", "writes")}</th><th>{activitySortButton("Tempdb current", "tempdb")}</th></tr></thead><tbody>{activityPageRows.map((record) => <tr key={record.id}><td>{record.sessionId ?? "—"}</td><td>{record.collectionTime ? new Date(record.collectionTime).toLocaleString() : "—"}</td><td>{record.status ?? "—"}</td><td>{record.wait?.type ?? "—"}</td><td>{record.blockingSessionId ?? "—"}</td><td>{formatDuration(record.durationSeconds)}</td><td>{formatNumber(record.cpuMs)}</td><td>{formatNumber(record.reads)}</td><td>{formatNumber(record.writes)}</td><td>{formatTempdbPages(record.tempdbCurrentPages)}</td></tr>)}</tbody></table>{!activityRows.length && <div className="empty-table">No activity rows match this filter.</div>}</div><div className="activity-pagination"><button type="button" className="button" disabled={activityPage === 0} onClick={() => setActivityPage((current) => Math.max(0, current - 1))}>Previous</button><span>Page {activityPage + 1} of {activityPages}</span><button type="button" className="button" disabled={activityPage + 1 >= activityPages} onClick={() => setActivityPage((current) => Math.min(activityPages - 1, current + 1))}>Next</button></div></section>}
        {tab === "plans" && <section id="panel-plans" role="tabpanel" aria-labelledby="tab-plans" tabIndex={0} className="data-panel"><div className="section-intro"><div><span>SHOWPLAN INVENTORY</span><strong>{report.plans.length ? `${report.plans.length} parsed document${report.plans.length === 1 ? "" : "s"}` : "No plan supplied"}</strong></div><p>Runtime evidence is available only in actual plans.</p></div><div className="plan-list">{report.plans.map((plan) => <article key={plan.id}><div><span className={plan.isActual ? "actual" : "estimated"}>{plan.isActual ? "ACTUAL" : "ESTIMATED"}</span><strong>{plan.fileName}</strong><small>Showplan {plan.version ?? "unknown version"}</small></div><b>{plan.statements.length}<small> statements</small></b>{plan.statements.slice(0, 4).map((statement) => <p key={statement.id}>{statement.statementText || statement.statementType}</p>)}</article>)}{!report.plans.length && <div className="empty-table">Import a .sqlplan or XML file, or include the query_plan column in a capture.</div>}</div></section>}
        {tab === "quality" && <section id="panel-quality" role="tabpanel" aria-labelledby="tab-quality" tabIndex={0} className="quality-grid"><div className="data-panel"><div className="section-intro"><div><span>SCHEMA COVERAGE</span><strong>{report.dataQuality.presentColumns.length} recognized columns</strong></div></div><div className="tag-list">{report.dataQuality.presentColumns.map((column) => <span className="present" key={column}>{column}</span>)}</div><details><summary>{report.dataQuality.missingColumns.length} optional columns not supplied</summary><div className="tag-list">{report.dataQuality.missingColumns.map((column) => <span key={column}>{column}</span>)}</div></details></div><div className="data-panel"><div className="section-intro"><div><span>LIMITATIONS, WARNINGS &amp; AUDIT</span><strong>What this report could not establish</strong></div></div><ul className="quality-list">{worksheetInputs.map((input) => <li key={input.id}><b>Worksheet analyzed</b>{input.fileName} · {input.sheetName}</li>)}{report.dataQuality.notEvaluatedRules.map((rule) => <li key={rule}><b>Not evaluated</b>{rule}</li>)}{report.dataQuality.warnings.map((warning) => <li key={warning}><b>Input warning</b>{warning}</li>)}{(report.dataQuality.findingCaps ?? []).map((cap) => <li key={cap.ruleId}><b>Finding cap</b>{cap.suppressedCount} additional {cap.ruleId} findings were suppressed after retaining {cap.retainedCount}, ordered by {cap.order.toLowerCase()}.</li>)}{(report.dataQuality.suppressedSignals ?? []).map((signal) => <li key={signal}><b>Suppressed signal</b>{signal}</li>)}{report.dataQuality.unknownColumns.map((column) => <li key={column}><b>Preserved unknown column</b>{column}</li>)}</ul>{!worksheetInputs.length && !report.dataQuality.notEvaluatedRules.length && !report.dataQuality.warnings.length && !(report.dataQuality.findingCaps ?? []).length && !(report.dataQuality.suppressedSignals ?? []).length && !report.dataQuality.unknownColumns.length && <div className="empty-table">No data-quality limitations were detected.</div>}</div><div className="data-panel profile-audit-panel"><div className="section-intro"><div><span>THRESHOLD PROFILE / THIS REPORT</span><strong>{report.thresholdProfile ? report.thresholdProfile.name : "Not recorded"}</strong></div></div>{report.thresholdProfile ? <><p>{report.thresholdProfile.id}@{report.thresholdProfile.version} · {report.thresholdProfile.id.startsWith("builtin.") ? "Built-in" : "Custom"}</p><code>{report.thresholdProfile.digest}</code><details><summary>View exact resolved thresholds</summary><pre>{JSON.stringify(report.thresholdProfile.thresholds, null, 2)}</pre></details></> : <p>Legacy report — threshold profile not recorded.</p>}</div></section>}
      </>}
      {deepCase && !report && <DeepAnalysisWorkspace deepCase={deepCase} recommendations={[]} busy={deepBusy} onStart={startDeepAnalysis} onStartSpillTriage={startSpillTriage} onSelectSpillCandidate={selectDeepSpillCandidate} onChooseSpillPlan={chooseDeepSpillPlan} onClearSpillPlan={clearDeepSpillPlan} onImport={importDeepEvidence} onSave={saveDeepCase} onOpen={openDeepCase} estimateThresholds={{ ratio: activeProfile.snapshot.thresholds.plans.mediumEstimateRatio, rows: activeProfile.snapshot.thresholds.plans.mediumRows }} importMessages={uploadMessages} />}
      {!report && !loading && !deepCase && <><section className="spill-launch"><div><span>FOCUSED WORKFLOW</span><strong>Have a sp_BlitzCache spill export?</strong><p>Rank its cached plan variants locally, then connect the highest-priority candidate to an uploaded execution plan.</p></div><button type="button" className="button button-primary" onClick={startSpillTriage}>Start Spill Triage</button></section><section className="trust-row"><div><span>01</span><strong>Private by construction</strong><p>No telemetry, uploads, database connection, or automatic remediation.</p></div><div><span>02</span><strong>Evidence before advice</strong><p>Severity and confidence are separate; missing data stays missing.</p></div><div><span>03</span><strong>Built for handoff</strong><p>Export a redacted report with evidence and source links.</p></div></section></>}
    </main>
    {preview && <ImportPreviewDialog preview={preview} canAppend={sourceFiles.length > 0} caseTitle={deepCase?.title} onChange={changePreview} onSheet={(id, sheet) => prepareMain(preview.files, preview.append, { ...preview.sheets, [id]: sheet }, preview.selectedIds)} onConfirm={confirmPreview} onCancel={cancelPreview} />}
    {replacement && <WorkflowDialog title="Protect unfinished work" onCancel={() => { if (!guardBusy) setReplacement(null); }}>
      <p>The {replacement.report && replacement.deep ? "report and working case have" : replacement.report ? "report has" : "working case has"} changes that have not been downloaded. Continuing will replace this work.</p>
      <p>A report Run ZIP follows the current raw-details choice. A working-case ZIP contains sensitive evidence and handwritten notes. Download preparation does not confirm disk storage.</p>
      <div className="workflow-actions"><button className="button" disabled={guardBusy} onClick={() => setReplacement(null)}>Cancel</button><button className="button" disabled={guardBusy} onClick={() => void resolveReplacement(false)}>Discard and continue</button><button className="button button-primary" disabled={guardBusy} onClick={() => void resolveReplacement(true)}>{guardBusy ? "Preparing downloads…" : "Download and continue"}</button></div>
    </WorkflowDialog>}
    <footer><span>SQL EVALUATE / OFFLINE TRIAGE / v{APP_VERSION}</span><p>Recommendations are advisory. Validate against workload context.</p></footer>
    <FindingDrawer finding={selected} guideStep={selectedGuideStep} relatedFindings={relatedFindings} onSelectFinding={setSelected} onDeepAnalysis={startDeepAnalysis} onShowActivity={showAffectedActivity} onShowGuide={showInvestigationGuide} onClose={closeDrawer} />
  </div>;
}

export default App;
