import { incidentOverlap, matchQueryIdentity } from "./correlation";
import type { DeepAnalysisCase, DeepCaptureAttempt, DeepCaseArtifact, DeepEvidenceAssertion, DeepEvidenceState } from "./types";

function artifactsBySignal(deepCase: DeepAnalysisCase): Map<string, DeepCaseArtifact[]> {
  const map = new Map<string, DeepCaseArtifact[]>();
  deepCase.artifacts.forEach((artifact) => artifact.signals.forEach((signal) => map.set(signal, [...(map.get(signal) ?? []), artifact])));
  return map;
}

function observationValue(deepCase: DeepAnalysisCase, metric: string): number | null {
  const values = (deepCase.observations ?? []).filter((item) => item.metric === metric && typeof item.value === "number").map((item) => item.value as number);
  return values.length ? values.at(-1)! : null;
}

function correlatedWithRoot(deepCase: DeepAnalysisCase, artifact: DeepCaseArtifact): boolean {
  if (artifact.identity?.sessionId === deepCase.rootSessionId) return true;
  const match = matchQueryIdentity(deepCase.rootIdentity, artifact.identity);
  if (match.matched && match.quality !== "Candidate") return true;
  return (deepCase.observations ?? []).some((item) => {
    if (item.artifactId !== artifact.id) return false;
    if (item.identity?.sessionId === deepCase.rootSessionId) return true;
    const observationMatch = matchQueryIdentity(deepCase.rootIdentity, item.identity);
    return observationMatch.matched && observationMatch.quality !== "Candidate";
  });
}

function correlatedSignalArtifacts(deepCase: DeepAnalysisCase, signal: string, artifacts: DeepCaseArtifact[]): DeepCaseArtifact[] {
  const observations = deepCase.observations ?? [];
  return artifacts.filter((artifact) => {
    const scoped = observations.filter((item) => item.artifactId === artifact.id && item.signalNames?.includes(signal));
    if (!scoped.length) return correlatedWithRoot(deepCase, artifact);
    return scoped.some((item) => {
      if (item.identity?.sessionId === deepCase.rootSessionId) return true;
      const match = matchQueryIdentity(deepCase.rootIdentity, item.identity);
      return match.matched && match.quality !== "Candidate";
    });
  });
}

function updateAssertion(item: DeepEvidenceAssertion, state: DeepEvidenceState, basis: string[], missingEvidence: string[], artifacts: DeepCaseArtifact[], occurredAt: string): DeepEvidenceAssertion {
  const artifactIds = [...new Set([...item.artifactIds, ...artifacts.map((artifact) => artifact.id)])];
  const transition = item.state === state ? [] : [{ occurredAt, from: item.state, to: state, reason: basis[0] ?? "Evidence state changed after reevaluation.", artifactIds: artifacts.map((artifact) => artifact.id) }];
  return {
    ...item,
    state,
    confidence: state === "Observed" || state === "Contradicted" ? "High" : state === "Supported" ? "Medium" : "High",
    basis,
    missingEvidence,
    artifactIds,
    history: [...(item.history ?? []), ...transition],
  };
}

function methodForArtifact(artifact: DeepCaseArtifact): DeepCaptureAttempt["method"] {
  if (artifact.adapterId === "query-store-export") return "Query Store";
  if (artifact.adapterId === "extended-events-export") return "Extended Events";
  if (artifact.resultSetTypes?.includes("LAST_KNOWN_ACTUAL_PLAN")) return "Last-known actual";
  return "Live cache";
}

function captureAttempts(deepCase: DeepAnalysisCase, bySignal: Map<string, DeepCaseArtifact[]>): DeepCaptureAttempt[] {
  const attempts = [...(deepCase.captureAttempts ?? [])];
  const seen = new Set(attempts.flatMap((attempt) => attempt.artifactIds.map((artifactId) => `${artifactId}:${attempt.outcome}`)));
  for (const artifact of bySignal.get("plan-lookup-null") ?? []) {
    const key = `${artifact.id}:Returned null`;
    if (seen.has(key)) continue;
    attempts.push({ id: `attempt-${artifact.id}-null`, occurredAt: artifact.importedAt, method: methodForArtifact(artifact), requestedEvidence: "A plan for the root statement", outcome: "Returned null", detail: "The result included stable request identity but query_plan was NULL. The plan may have been evicted or unavailable for this request.", artifactIds: [artifact.id] });
    seen.add(key);
  }
  for (const artifact of [...(bySignal.get("plan-captured") ?? []), ...(bySignal.get("embedded-plan-captured") ?? [])]) {
    const key = `${artifact.id}:Captured`;
    if (seen.has(key)) continue;
    attempts.push({ id: `attempt-${artifact.id}-captured`, occurredAt: artifact.importedAt, method: methodForArtifact(artifact), requestedEvidence: "A plan for the root statement", outcome: "Captured", detail: correlatedWithRoot(deepCase, artifact) ? "The plan has a stable identity match to the root request." : "A plan was captured, but a stable root-request match is still required.", artifactIds: [artifact.id] });
    seen.add(key);
  }
  return attempts;
}

export function evaluateDeepCase(deepCase: DeepAnalysisCase): DeepAnalysisCase {
  const bySignal = artifactsBySignal(deepCase);
  const evidenceFor = (...signals: string[]) => signals.flatMap((signal) => bySignal.get(signal) ?? []);
  const inWindow = (artifact: DeepCaseArtifact) => incidentOverlap(artifact.capturedAt, deepCase.incidentWindow).quality !== "Context only";
  const usable = (...signals: string[]) => evidenceFor(...signals).filter(inWindow);
  const assertions = deepCase.assertions.map((item) => {
    let state = item.state;
    let basis = item.basis;
    let missing = item.missingEvidence;
    let artifacts: DeepCaseArtifact[] = [];

    if (item.id === "scheduler-pressure") {
      const sustained = usable("scheduler-pressure-sustained");
      const clue = usable("scheduler-runnable-queue");
      if (sustained.length) {
        state = "Supported"; artifacts = sustained; basis = ["Repeated scheduler samples contain runnable workers queued for CPU during the investigation window."]; missing = ["Host CPU utilization or scheduler-delay deltas for magnitude when not supplied"];
      } else if (clue.length) {
        state = "Not Evaluated"; artifacts = clue; basis = ["A runnable scheduler queue was observed once; one sample does not establish sustained CPU pressure."]; missing = ["At least two timestamped scheduler samples during the same incident"];
      }
    }
    if (item.id === "worker-exhaustion" || item.id === "worker-ceiling") {
      const confirmed = usable("worker-exhaustion-confirmed");
      const queued = usable("worker-queue");
      if (confirmed.length) { state = item.id === "worker-ceiling" ? "Supported" : "Observed"; artifacts = confirmed; basis = ["Active workers reached the configured ceiling while queued work was present."]; missing = item.id === "worker-ceiling" ? [] : ["Concurrency-source attribution"]; }
      else if (queued.length) { state = "Supported"; artifacts = queued; basis = ["Worker-queue evidence is present, but the configured ceiling was not reached in the supplied rows."]; missing = ["Active and maximum worker counts from the same samples"]; }
    }
    if (item.id === "root-lock-owner") {
      const exact = usable("lock-resource-match");
      const rootLocks = usable("root-locks-granted");
      if (exact.length) { state = "Observed"; artifacts = exact; basis = ["A granted root lock and a victim wait reference the same captured lock resource."]; missing = []; }
      else if (rootLocks.length) { state = "Supported"; artifacts = rootLocks; basis = ["The root session owns granted locks, but the victim wait resource was not matched exactly."]; missing = ["Victim waiting-lock rows containing the same resource identity"];
      }
    }
    if (item.id === "plan-cache-pressure") {
      const measured = usable("plan-cache-instability-measured");
      const wideCounters = usable("plan-cache-pressure-wide");
      const warnings = usable("plan-cache-instability", "plan-cache-warning");
      const total = observationValue(deepCase, "total_plan_count");
      const percentage = observationValue(deepCase, "single_use_percentage");
      if (measured.length) { state = "Supported"; artifacts = measured; basis = [`A complete cache inventory reports ${total?.toLocaleString() ?? "a measured set of"} plans with ${percentage?.toFixed(1) ?? "a high"}% single-use.`]; missing = ["A normal-window comparison and time-aligned compilation rate"]; }
      else if (wideCounters.length) { state = "Supported"; artifacts = wideCounters; basis = ["Repeated compilation counters show compile-semaphore waiters while the plan-cache hit ratio declines."]; missing = ["A single-use plan inventory and normal-window comparison"]; }
      else if (warnings.length) { state = "Supported"; artifacts = warnings; basis = ["A recognized BlitzCache export reports plan-cache or compilation symptoms."]; missing = ["A complete plan-cache inventory and compilation-to-batch deltas"];
      }
    }
    if (item.id === "compilation-pressure") {
      const measuredCompile = usable("compilation-pressure");
      const timeouts = usable("compilation-timeout");
      artifacts = [...measuredCompile, ...timeouts];
      if (measuredCompile.length) { state = "Supported"; basis = [`Repeated counters report a compilation-to-batch ratio of ${((observationValue(deepCase, "compilation_to_batch_ratio") ?? 0) * 100).toFixed(1)}%.`]; missing = ["Normal-window comparison and query-level compile attribution"]; }
      else if (timeouts.length) { state = "Supported"; basis = ["BlitzCache reports one or more compilation timeouts, a query-level symptom rather than server-wide compile pressure."]; missing = ["Repeated SQL Compilations/sec and Batch Requests/sec counter samples"]; }
    }
    if (item.id === "serialization") {
      const planReason = usable("nonparallel-reason").filter((artifact) => correlatedWithRoot(deepCase, artifact));
      const timeAlignedPlanReason = planReason.filter((artifact) => ["Exact", "Overlapping"].includes(incidentOverlap(artifact.capturedAt, deepCase.incidentWindow).quality));
      const blitz = correlatedSignalArtifacts(deepCase, "forced-serialization", usable("forced-serialization"));
      if (timeAlignedPlanReason.length) { state = "Observed"; artifacts = timeAlignedPlanReason; basis = ["A time-compatible, stably matched root Showplan contains an explicit NonParallelPlanReason."]; missing = []; }
      else if (planReason.length) { state = "Supported"; artifacts = planReason; basis = ["A stably matched root Showplan contains an explicit NonParallelPlanReason, but its capture time is unavailable."]; missing = ["A plan timestamp overlapping the incident window"]; }
      else if (blitz.length) { state = "Supported"; artifacts = blitz; basis = ["A stably correlated BlitzCache row reports forced serialization."]; missing = ["Matching Showplan XML containing the nonparallel reason"]; }
      else if (bySignal.has("forced-serialization")) { state = "Not Evaluated"; artifacts = usable("forced-serialization"); basis = ["Forced-serialization warnings exist, but none has a stable identity match to the root request."]; missing = ["Root query or plan handle/hash correlation"];
      }
    }
    if (item.id === "memory-grant-symptom") {
      const actual = usable("plan-memory-overgrant").filter((artifact) => correlatedWithRoot(deepCase, artifact) && ["Exact", "Overlapping"].includes(incidentOverlap(artifact.capturedAt, deepCase.incidentWindow).quality));
      const unused = correlatedSignalArtifacts(deepCase, "unused-memory-grant", usable("unused-memory-grant"));
      if (actual.length) { state = "Observed"; artifacts = actual; basis = ["A time-compatible, stably matched actual plan reports a workspace grant at least four times maximum used memory."]; missing = []; }
      else if (unused.length) { state = "Supported"; artifacts = unused; basis = ["A stably correlated plan/cache row reports an unused workspace-memory grant."]; missing = ["A matching actual plan with granted and maximum-used memory"]; }
      else if (bySignal.has("unused-memory-grant")) { state = "Not Evaluated"; artifacts = usable("unused-memory-grant"); basis = ["Unused-grant evidence exists but is not stably matched to the root query."]; missing = ["Root plan_handle, query hash, or Query Store identity"];
      }
    }
    if (item.id === "memory-grant-pressure") {
      const pending = usable("pending-memory-grant");
      const unused = usable("unused-memory-grant");
      if (pending.length) { state = "Supported"; artifacts = pending; basis = ["Imported evidence contains a pending or waiting workspace-memory grant or RESOURCE_SEMAPHORE evidence."]; missing = ["Persistence and affected-query correlation"]; }
      else if (unused.length) { state = "Not Evaluated"; artifacts = unused; basis = ["Unused memory in one plan does not establish server-level grant-pool pressure."]; missing = ["Pending grants or RESOURCE_SEMAPHORE evidence"];
      }
    }
    if (item.id === "plan-captured") {
      const plans = usable("plan-captured", "embedded-plan-captured");
      const correlated = plans.filter((artifact) => correlatedWithRoot(deepCase, artifact));
      const timeAligned = correlated.filter((artifact) => ["Exact", "Overlapping"].includes(incidentOverlap(artifact.capturedAt, deepCase.incidentWindow).quality));
      if (timeAligned.length) { state = "Observed"; artifacts = timeAligned; basis = ["A time-compatible captured Showplan has a stable identity match to the root request."]; missing = []; }
      else if (correlated.length) { state = "Supported"; artifacts = correlated; basis = ["A captured Showplan has a stable identity match to the root request, but its capture time is unavailable."]; missing = ["A plan timestamp overlapping the incident window"]; }
      else if (plans.length) { state = "Not Evaluated"; artifacts = plans; basis = ["Showplan evidence was imported, but no stable identifier connects it to the root statement."]; missing = ["Matching plan_handle, sql_handle plus statement offsets, query hashes, or Query Store IDs"];
      } else if (bySignal.has("plan-lookup-null")) { state = "Not Evaluated"; artifacts = usable("plan-lookup-null"); basis = ["The live plan lookup returned NULL, consistent with eviction or an unavailable cached plan."]; missing = ["A same-moment plan, already-enabled last-known actual plan, or existing Query Store plan"];
      }
    }
    if (item.id === "causal-theory") {
      if (deepCase.profileId === "worker-exhaustion") {
        const confirmed = usable("worker-exhaustion-confirmed");
        artifacts = confirmed;
        if (confirmed.length) { state = "Supported"; basis = ["THREADPOOL source evidence aligns with worker counters reaching the configured ceiling while the work queue grows."]; missing = ["Determine whether the trigger was overlapping jobs, a connection burst, or workers retained elsewhere"]; }
        else { state = "Not Evaluated"; basis = ["THREADPOOL is observed, but server worker-ceiling evidence has not been imported."]; missing = ["Active workers, maximum workers, and work queue from the incident window"]; }
        return updateAssertion(item, state, basis, missing, artifacts, deepCase.updatedAt);
      }
      if (deepCase.profileId === "compile-pressure") {
        const compile = usable("compilation-pressure");
        const cache = usable("plan-cache-pressure-wide", "plan-cache-instability-measured");
        artifacts = [...compile, ...cache];
        if (compile.length && cache.length) { state = "Supported"; basis = ["Compile-semaphore waits align with high compilation activity and deteriorating or single-use plan-cache evidence."]; missing = ["Confirm the upstream parameterization source before choosing remediation"]; }
        else { state = "Not Evaluated"; basis = ["The compile semaphore is observed, but counter and cache evidence do not yet establish the full cause."]; missing = [!compile.length ? "Repeated compilation and batch samples" : "Plan-cache reuse evidence"]; }
        return updateAssertion(item, state, basis, missing, artifacts, deepCase.updatedAt);
      }
      if (deepCase.profileId === "plan-specific") {
        state = "Supported"; basis = ["The source Showplan directly reports the plan-specific cause; a controlled before/after runtime comparison is still required."]; missing = ["Representative runtime comparison after remediation"];
        return updateAssertion(item, state, basis, missing, [], deepCase.updatedAt);
      }
      if (deepCase.profileId === "transaction-blocking") {
        const exactLocks = usable("lock-resource-match");
        artifacts = exactLocks;
        if (exactLocks.length) { state = "Supported"; basis = ["The sleeping open transaction is the captured root and imported lock evidence matches its granted resource to victim waits."]; missing = ["Application or connection owner responsible for the retained transaction"]; }
        else { state = "Not Evaluated"; basis = ["The sleeping open transaction is visible, but exact transaction-to-lock ownership is not yet imported."]; missing = ["Root granted locks and matching victim wait resources", "Outer command and connection owner"];
        }
        return updateAssertion(item, state, basis, missing, artifacts, deepCase.updatedAt);
      }
      const assertion = (id: string) => deepCase.assertions.find((candidate) => candidate.id === id);
      const chain = assertion("blocking-chain")?.state === "Observed";
      const runnable = assertion("root-runnable")?.state === "Observed";
      const transaction = assertion("open-transactions");
      const hasScheduler = usable("scheduler-pressure-sustained").length > 0;
      const exactLocks = usable("lock-resource-match").length > 0;
      const cache = usable("plan-cache-instability-measured", "compilation-pressure", "plan-cache-warning");
      const matchedRootPlan = usable("plan-captured", "embedded-plan-captured").some((artifact) => correlatedWithRoot(deepCase, artifact));
      artifacts = usable("scheduler-pressure-sustained", "lock-resource-match", "plan-cache-instability-measured", "compilation-pressure", "plan-captured", "embedded-plan-captured");
      if (transaction?.state === "Contradicted" && usable("root-locks-granted").length) {
        state = "Not Evaluated"; basis = ["The source reports zero open transactions while later evidence reports root locks; the observations may describe different instants."]; missing = ["Time-aligned transaction, lock, and scheduler evidence"];
      } else if (chain && runnable && transaction?.state === "Observed" && hasScheduler && exactLocks) {
        state = "Supported";
        basis = ["The blocking graph, runnable root, open transaction, repeated scheduler queues, and matching root/victim lock resource align in the incident evidence.", ...(cache.length ? ["Time-compatible plan-cache or compilation evidence supplies a plausible contributor to scheduler pressure."] : [])];
        missing = matchedRootPlan
          ? ["Repeat the time-aligned incident capture to test whether the same scheduler, lock, and plan pattern persists."]
          : cache.length
            ? ["A stably matched root plan is still required to explain the query-level cause."]
            : ["Plan-cache, compilation, and root-plan evidence are still needed to test the proposed source of CPU pressure."];
      } else {
        state = "Not Evaluated"; basis = ["The blocking chain may be established, but the evidence does not yet connect every proposed causal link in the same incident window."]; missing = [!hasScheduler ? "Repeated scheduler pressure" : "", !exactLocks ? "Exact root-lock to victim-wait resource match" : "", transaction?.state !== "Observed" ? "Time-aligned open transaction" : ""].filter(Boolean);
      }
    }
    return updateAssertion(item, state, basis, missing, artifacts, deepCase.updatedAt);
  });

  const facts = assertions.filter((item) => item.id !== "causal-theory");
  const causal = assertions.find((item) => item.id === "causal-theory");
  const plan = assertions.find((item) => item.id === "plan-captured");
  const genericNextCheck = causal?.missingEvidence[0] ?? facts.find((item) => item.state === "Not Evaluated")?.missingEvidence[0] ?? "Repeat the bounded evidence capture to test persistence.";
  const narrative = {
    headline: deepCase.profileId === "cpu-backed-blocking" ? causal?.state === "Supported" ? "Evidence supports a CPU-amplified blocking cascade" : "The blocking incident is visible; the wider cause remains incomplete" : causal?.state === "Supported" ? `Evidence supports the ${deepCase.title.toLowerCase()} theory` : `${deepCase.title} evidence remains incomplete`,
    established: facts.filter((item) => item.state === "Observed").map((item) => item.statement),
    supported: facts.filter((item) => item.state === "Supported").map((item) => item.statement),
    contradicted: facts.filter((item) => item.state === "Contradicted").map((item) => item.statement),
    unanswered: facts.filter((item) => item.state === "Not Evaluated").map((item) => `${item.label}: ${item.missingEvidence[0] ?? "More evidence is required."}`),
    nextCheck: deepCase.profileId === "cpu-backed-blocking" ? plan?.state !== "Observed" ? "Capture a plan with a stable identity match to the root statement." : causal?.missingEvidence[0] ?? "Repeat the incident capture to test persistence." : genericNextCheck,
  };
  const artifactIds = deepCase.artifacts.map((artifact) => artifact.id);
  const recognizedCount = deepCase.artifacts.filter((artifact) => artifact.signals.length).length;
  const collectionSteps = deepCase.collectionSteps.map((step) => ({ ...step, artifactIds, status: recognizedCount >= 3 ? "Imported" as const : recognizedCount > 0 ? "Partially imported" as const : "Pending" as const }));
  return { ...deepCase, assertions, collectionSteps, captureAttempts: captureAttempts(deepCase, bySignal), narrative };
}
