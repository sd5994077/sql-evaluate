import type { AnalysisReport, Finding, InvestigationGuide, InvestigationStep, InvestigationSubjectSummary, WhoIsActiveRecord } from "../types";
import { formatDuration, formatNumber, formatTempdbPages } from "../lib/utils";

const ACTIONABLE = new Set(["Critical", "High", "Medium", "Low"]);

function isLowerPriorityTransactionSummary(finding: Finding): boolean {
  if (finding.ruleId !== "WIA-TRANSACTION" || finding.severity === "Critical") return false;
  const distinctStarts = Number(finding.evidence.find((item) => item.label === "Distinct transaction starts")?.value);
  const headBlocker = finding.evidence.find((item) => item.label === "Head blocker")?.value;
  return Number.isFinite(distinctStarts) && distinctStarts > 1 && headBlocker === "No";
}

function subjectEpisodeKey(record: WhoIsActiveRecord): string {
  return `${record.sourceId}:${record.sessionId ?? "unknown"}:${record.requestId ?? 0}:${record.startTime ?? record.loginTime ?? "unknown-start"}`;
}

function subjectSummary(id: string, records: WhoIsActiveRecord[], related: Finding[], planGap: string | null): InvestigationSubjectSummary {
  const ordered = [...records].sort((left, right) => String(left.collectionTime).localeCompare(String(right.collectionTime)) || left.rowNumber - right.rowNumber);
  const latest = ordered.at(-1)!;
  const duration = Math.max(...records.map((record) => record.durationSeconds ?? 0));
  const latestCompletion = latest.percentComplete;
  const completion = latestCompletion !== null && latestCompletion !== undefined && Number.isFinite(latestCompletion) ? `${formatNumber(latestCompletion)}% reported at the last capture` : "No completion estimate was supplied.";
  const resourceSummary = [
    { label: "Runtime", value: formatDuration(duration) },
    { label: "CPU", value: formatNumber(latest.cpuMs) },
    { label: "Reads", value: formatNumber(latest.reads) },
    { label: "Physical reads", value: formatNumber(latest.physicalReads) },
    { label: "TempDB current", value: formatTempdbPages(latest.tempdbCurrentPages) },
  ];
  const limitation = related.flatMap((finding) => finding.limitations ?? []).find(Boolean);
  return {
    id,
    sessionId: latest.sessionId,
    requestId: latest.requestId,
    lastObservedAt: latest.collectionTime,
    lastStatus: latest.status,
    durationSeconds: duration,
    resourceSummary,
    blockingObserved: records.some((record) => (record.blockingSessionId ?? 0) > 0) || related.some((finding) => Boolean(finding.blockingContext)),
    completion,
    primaryEvidenceGap: planGap ?? limitation ?? "No additional evidence gap was identified.",
  };
}

function stepFromFinding(finding: Finding, actionType: InvestigationStep["actionType"], title?: string, command?: string): Omit<InvestigationStep, "id" | "order"> {
  return {
    title: title ?? finding.nextCapture?.title ?? `Review ${finding.title}`,
    reason: finding.nextCapture?.reason ?? finding.summary,
    actionType,
    expectedEvidence: finding.nextCapture?.expectedEvidence ?? finding.evidence.slice(0, 4).map((item) => item.label),
    caution: finding.nextCapture?.caution,
    command: command ?? finding.nextCapture?.command,
    sourceFindingIds: [finding.id],
    targetFindingId: finding.id,
    deepAnalysisProfile: finding.deepAnalysisProfile,
  };
}

export function composeInvestigationGuide(report: Pick<AnalysisReport, "records" | "findings">): InvestigationGuide {
  const planGap = report.findings.some((finding) => finding.ruleId === "PLAN-UNAVAILABLE")
    ? "No execution plan was supplied for operator-level analysis."
    : report.findings.some((finding) => finding.ruleId === "PLAN-RUNTIME-UNAVAILABLE") ? "The supplied estimated plan has no runtime counters; a representative actual plan is still needed." : null;
  const actionable = report.findings.filter((finding) => ACTIONABLE.has(finding.severity));
  const priorityCandidates = actionable.filter((finding) => finding.severity === "Critical" || finding.severity === "High");
  const priority = [
    ...priorityCandidates.filter((finding) => !isLowerPriorityTransactionSummary(finding)),
    ...priorityCandidates.filter(isLowerPriorityTransactionSummary),
  ].slice(0, 2);
  const conclusion = priority.length
    ? `Priority review: ${priority.map((finding) => finding.title).join("; ")}. The supplied evidence does not by itself establish root cause.`
    : actionable.length ? `The capture contains ${actionable.length} item${actionable.length === 1 ? "" : "s"} for follow-up, but no Critical or High concern.`
      : "No actionable concern was established in the supplied capture interval.";

  const actionableRecordIds = new Set(actionable.flatMap((finding) => finding.affectedRecordIds));
  const subjectGroups = new Map<string, WhoIsActiveRecord[]>();
  for (const record of report.records) {
    if (!actionableRecordIds.has(record.id) || record.sessionId === null) continue;
    const key = subjectEpisodeKey(record);
    const records = subjectGroups.get(key) ?? [];
    records.push(record);
    subjectGroups.set(key, records);
  }
  const subjects = [...subjectGroups.entries()].slice(0, 5).map(([key, subjectRecords]) => {
    const subjectRecordIds = new Set(subjectRecords.map((record) => record.id));
    const related = actionable.filter((finding) => finding.affectedRecordIds.some((id) => subjectRecordIds.has(id)));
    return subjectSummary(`subject-${key}`, subjectRecords, related, planGap);
  });

  const candidates: Array<Omit<InvestigationStep, "id" | "order">> = [];
  const first = (ruleIds: string[]) => report.findings.find((finding) => ruleIds.includes(finding.ruleId) && ACTIONABLE.has(finding.severity));
  const contributors = (predicate: (finding: Finding) => boolean) => report.findings.filter(predicate).map((finding) => finding.id);
  const inputCorrection = actionable.length ? undefined : report.findings.find((finding) => finding.severity === "Not Evaluated" && finding.ruleId.endsWith("-UNAVAILABLE") && !finding.ruleId.startsWith("PLAN-") && finding.nextCapture);
  if (inputCorrection) {
    const correction = stepFromFinding(inputCorrection, "Capture", "Capture the required columns before drawing this conclusion");
    correction.condition = "Use this first when the unavailable rule is material to the incident you are investigating.";
    candidates.push(correction);
  }
  const urgent = first(["WIA-SCHEDULER-PRESSURE", "WIA-WORKER-EXHAUSTION", "WIA-BLOCKING"]);
  if (urgent) {
    const step = stepFromFinding(urgent, urgent.deepAnalysisProfile ? "Deep Analysis" : "Capture");
    step.condition = "Use while the availability risk is active or reproducible; historical rows do not prove that it is still occurring.";
    step.sourceFindingIds = contributors((finding) => finding.ruleId === urgent.ruleId && ACTIONABLE.has(finding.severity));
    candidates.push(step);
  }
  const resource = first(["WIA-RESOURCE"]);
  if (resource) {
    const step = stepFromFinding(resource, "Capture", "Capture short resource deltas and the execution plan");
    step.condition = "Use if the request is still active or can be reproduced safely; otherwise acquire a representative historical plan when available.";
    step.sourceFindingIds = contributors((finding) => finding.ruleId === "WIA-RESOURCE" && ACTIONABLE.has(finding.severity));
    candidates.push(step);
  }
  const unavailablePlan = report.findings.find((finding) => finding.ruleId === "PLAN-UNAVAILABLE" || finding.ruleId === "PLAN-RUNTIME-UNAVAILABLE");
  if (unavailablePlan) {
    const runtimeUnavailable = unavailablePlan.ruleId === "PLAN-RUNTIME-UNAVAILABLE";
    const upload = stepFromFinding(unavailablePlan, "Upload", runtimeUnavailable ? "Analyze a representative actual execution plan" : "Analyze the capture together with a saved execution plan", undefined);
    upload.reason = runtimeUnavailable
      ? "The supplied estimated plan has no runtime counters. Choose a representative actual plan together with the original capture files when they are available locally."
      : "Choose the saved plan together with the original capture. If this analysis still has its original local source files, SQL Evaluate includes them automatically; an imported report cannot reconstruct those raw sources.";
    upload.condition = runtimeUnavailable ? "Acquire an actual plan only through an approved, workload-safe workflow using representative parameters." : "Use a representative saved plan from the same request and workload interval when possible.";
    candidates.push(upload);
  }
  const storageWait = actionable.find((finding) => finding.ruleId === "WIA-WAIT" && finding.evidence.some((item) => item.label === "Category" && item.value === "Storage I/O"));
  if (storageWait) {
    const tool = storageWait.diagnosticTools?.find((item) => item.name.includes("sp_BlitzFirst"));
    const step = stepFromFinding(storageWait, "Corroborate", "Corroborate storage waits at the server level", tool?.command);
    step.condition = "Collect server and file-latency evidence during the same slowdown interval; historical request waits alone do not establish storage pressure.";
    step.sourceFindingIds = contributors((finding) => finding.ruleId === "WIA-WAIT" && ACTIONABLE.has(finding.severity) && finding.evidence.some((item) => item.label === "Category" && item.value === "Storage I/O"));
    candidates.push(step);
  }
  const transaction = first(["WIA-TRANSACTION"]);
  if (transaction) {
    const step = stepFromFinding(transaction, "Capture", "Confirm transaction ownership and current impact");
    step.condition = "Use if open-transaction activity persists or participates in blocking; do not assume one transaction remained open for the request's full age.";
    step.sourceFindingIds = contributors((finding) => finding.ruleId === "WIA-TRANSACTION" && ACTIONABLE.has(finding.severity));
    candidates.push(step);
  }
  for (const finding of actionable) {
    if (candidates.length >= 5) break;
    if (candidates.some((candidate) => candidate.sourceFindingIds.includes(finding.id)) || !finding.nextCapture) continue;
    if (finding.ruleId === "WIA-WAIT" && candidates.some((candidate) => report.findings.find((item) => item.id === candidate.targetFindingId)?.ruleId === "WIA-WAIT")) continue;
    candidates.push(stepFromFinding(finding, finding.deepAnalysisProfile ? "Deep Analysis" : "Capture"));
  }

  const merged: Array<Omit<InvestigationStep, "id" | "order">> = [];
  for (const candidate of candidates) {
    const key = `${candidate.actionType}:${candidate.title}:${candidate.command ?? ""}`;
    const existing = merged.find((item) => `${item.actionType}:${item.title}:${item.command ?? ""}` === key);
    if (existing) existing.sourceFindingIds = [...new Set([...existing.sourceFindingIds, ...candidate.sourceFindingIds])];
    else merged.push(candidate);
  }
  const steps = merged.slice(0, 5).map((candidate, index): InvestigationStep => ({ ...candidate, id: `guide-step-${index + 1}`, order: index + 1 }));

  const missingEvidence = [...new Set(report.findings
    .filter((finding) => finding.severity === "Not Evaluated")
    .flatMap((finding) => [finding.summary, ...(finding.limitations ?? [])]))].slice(0, 8);
  return { schemaVersion: "1.0", conclusion, missingEvidence, subjects, steps };
}

export function composeInvestigationGuideSafely(report: Pick<AnalysisReport, "records" | "findings">): InvestigationGuide {
  try {
    return composeInvestigationGuide(report);
  } catch {
    return {
      schemaVersion: "1.0",
      conclusion: "No prioritized investigation path could be derived from this report. The underlying findings remain available and unchanged.",
      missingEvidence: ["Investigation guidance could not be generated from the stored evidence."],
      subjects: [],
      steps: [],
    };
  }
}
