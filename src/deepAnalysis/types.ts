import type { BlockingContext, Confidence, EvidenceItem, Severity } from "../types";

export type DeepEvidenceState = "Observed" | "Supported" | "Contradicted" | "Not Evaluated";
export type DeepArtifactKind = "Scheduler" | "Locks" | "Memory grants" | "Plan cache" | "Execution plan" | "Diagnostic result";
export type DeepCollectionStatus = "Pending" | "Partially imported" | "Imported";
export type DeepOverlapQuality = "Exact" | "Overlapping" | "Context only" | "Unknown";
export type DeepDirectness = "Direct" | "Derived" | "Contextual";
export type DeepProfileId = "cpu-backed-blocking" | "transaction-blocking" | "worker-exhaustion" | "compile-pressure" | "memory-grants" | "plan-specific" | "actual-plan";

export interface DeepQueryIdentity {
  sessionId?: number | null;
  requestId?: number | null;
  transactionId?: number | null;
  sqlHandle?: string | null;
  planHandle?: string | null;
  queryHash?: string | null;
  queryPlanHash?: string | null;
  statementStartOffset?: number | null;
  statementEndOffset?: number | null;
  queryStoreQueryId?: number | null;
  queryStorePlanId?: number | null;
  databaseId?: number | null;
}

export interface DeepIncidentWindow {
  firstObservedAt: string | null;
  lastObservedAt: string | null;
  serverStartTime?: string | null;
  overlapQuality: DeepOverlapQuality;
  explanation: string;
}

export interface DeepEvidenceObservation {
  id: string;
  artifactId: string;
  kind: string;
  metric: string;
  value: string | number | boolean | null;
  unit?: string;
  capturedAt: string | null;
  directness: DeepDirectness;
  identity?: DeepQueryIdentity;
  signalNames?: string[];
  detail?: string;
}

export interface DeepStateTransition {
  occurredAt: string;
  from: DeepEvidenceState;
  to: DeepEvidenceState;
  reason: string;
  artifactIds: string[];
}

export interface DeepEvidenceAssertion {
  id: string;
  label: string;
  statement: string;
  state: DeepEvidenceState;
  confidence: Confidence;
  basis: string[];
  missingEvidence: string[];
  artifactIds: string[];
  contradictingArtifactIds?: string[];
  history?: DeepStateTransition[];
}

export interface DeepCaseArtifact {
  id: string;
  fileName: string;
  size: number;
  sha256: string;
  importedAt: string;
  kind: DeepArtifactKind;
  summary: string;
  signals: string[];
  adapterId?: string;
  adapterVersion?: string;
  capturedAt?: string | null;
  resultSetTypes?: string[];
  identity?: DeepQueryIdentity;
  warnings?: string[];
}

export interface DeepCaptureAttempt {
  id: string;
  occurredAt: string;
  method: "Live cache" | "Last-known actual" | "Query Store" | "Extended Events" | "Manual import";
  requestedEvidence: string;
  outcome: "Captured" | "Returned null" | "Unavailable" | "Permission denied" | "Not run";
  detail: string;
  artifactIds: string[];
}

export interface DeepCollectionStep {
  id: string;
  title: string;
  purpose: string;
  command: string;
  requiredPermissions: string[];
  expectedEvidence: string[];
  supportedVersions: string;
  overhead: "Low" | "Moderate" | "High";
  caution: string;
  status: DeepCollectionStatus;
  artifactIds: string[];
  executionMode?: "Read-only" | "Administrative";
  requiresApproval?: boolean;
}

export interface DeepCaseEvent {
  occurredAt: string;
  type: "Case created" | "Evidence imported" | "Case reopened";
  summary: string;
}

export interface DeepSourceFinding {
  id: string;
  ruleId: string;
  severity: Severity;
  confidence: Confidence;
  category: string;
  title: string;
  summary: string;
  evidence: EvidenceItem[];
  blockingContext?: BlockingContext;
}

export interface DeepAnalysisCase {
  schemaVersion: "1.0" | "1.1";
  id: string;
  profileId: DeepProfileId;
  title: string;
  createdAt: string;
  updatedAt: string;
  sourceReportCreatedAt: string;
  sourceFileNames: string[];
  sourceFinding: DeepSourceFinding;
  rootSessionId: number | null;
  incidentWindow?: DeepIncidentWindow;
  rootIdentity?: DeepQueryIdentity;
  observations?: DeepEvidenceObservation[];
  captureAttempts?: DeepCaptureAttempt[];
  narrative?: {
    headline: string;
    established: string[];
    supported: string[];
    contradicted: string[];
    unanswered: string[];
    nextCheck: string;
  };
  assertions: DeepEvidenceAssertion[];
  collectionSteps: DeepCollectionStep[];
  artifacts: DeepCaseArtifact[];
  events: DeepCaseEvent[];
  sensitive: true;
}

export interface DeepCaseArchiveManifest {
  schemaVersion: "1.0" | "1.1";
  caseId: string;
  appVersion: string;
  exportedAt: string;
  sensitive: true;
  casePath: string;
  caseSha256?: string;
  evidence: Array<{ artifactId: string; fileName: string; path: string; size: number; sha256: string }>;
}

export interface DeepCaseArchive {
  fileName: string;
  bytes: Uint8Array;
  manifest: DeepCaseArchiveManifest;
}
