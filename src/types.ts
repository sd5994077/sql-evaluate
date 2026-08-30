export type Severity = "Critical" | "High" | "Medium" | "Low" | "Informational" | "Not Evaluated";
export type Confidence = "High" | "Medium" | "Low";
export type InputFormat = "csv" | "xlsx" | "sqlplan" | "report";

export interface AnalysisInput {
  id: string;
  fileName: string;
  size: number;
  format: InputFormat;
  sheetName?: string;
  rowCount: number;
  recognizedColumns: string[];
  unknownColumns: string[];
  warnings: string[];
}

export interface WaitInfo {
  durationMs: number | null;
  durationsMs?: number[];
  taskCount?: number | null;
  type: string;
  detail?: string;
  category: string;
}

export interface WhoIsActiveRecord {
  id: string;
  sourceId: string;
  rowNumber: number;
  sessionId: number | null;
  requestId: number | null;
  collectionTime: string | null;
  startTime: string | null;
  tranStartTime?: string | null;
  loginTime: string | null;
  durationSeconds: number | null;
  wait: WaitInfo | null;
  waitParseWarning?: string | null;
  status: string | null;
  blockingSessionId: number | null;
  blockedSessionCount: number | null;
  openTranCount: number | null;
  implicitTran: boolean | null;
  cpuMs: number | null;
  reads: number | null;
  writes: number | null;
  physicalReads: number | null;
  usedMemoryPages: number | null;
  tempdbAllocationPages: number | null;
  tempdbCurrentPages: number | null;
  sqlText: string | null;
  sqlCommand: string | null;
  queryPlanXml: string | null;
  databaseName: string | null;
  loginName: string | null;
  hostName: string | null;
  programName: string | null;
  original: Record<string, unknown>;
}

export type SupplementalEvidenceKind = "Scheduler counters" | "Compilation counters" | "Worker counters" | "Memory counters" | "Query Store";

export interface SupplementalEvidenceSample {
  collectionTime: string | null;
  metrics: Record<string, number>;
}

export interface SupplementalEvidenceSource {
  id: string;
  sourceId: string;
  fileName: string;
  kind: SupplementalEvidenceKind;
  samples: SupplementalEvidenceSample[];
  rowCount: number;
}

export interface PlanOperator {
  id: string;
  nodeId: number | null;
  physicalOp: string;
  logicalOp: string;
  estimatedRows: number | null;
  actualRows: number | null;
  estimatedCost: number | null;
  warnings: string[];
  objectName?: string;
  predicate?: string | null;
  seekPredicate?: string | null;
  residualPredicate?: string | null;
  nonSargablePredicate?: string | null;
  isParallel?: boolean;
  hasScalarFunction?: boolean;
}

export type PlanSourceKind = "Embedded" | "Cached estimated" | "Estimated" | "Actual" | "Last-known actual" | "Query Store" | "Extended Events";

export interface PlanQueryIdentity {
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

export interface PlanStatement {
  id: string;
  statementText: string;
  statementType: string;
  estimatedCost: number | null;
  isActual: boolean;
  missingIndexImpact: number | null;
  memoryGrant?: { requestedKb: number; grantedKb: number; usedKb: number };
  operators: PlanOperator[];
  warnings: string[];
  queryIdentity?: PlanQueryIdentity;
  nonParallelPlanReason?: string | null;
  earlyAbortReason?: string | null;
  optimizationLevel?: string | null;
  degreeOfParallelism?: number | null;
  compileTimeMs?: number | null;
  compileCpuMs?: number | null;
  compileMemoryKb?: number | null;
  retrievedFromCache?: boolean | null;
}

export interface PlanDocument {
  id: string;
  sourceId: string;
  sourceRecordId?: string;
  fileName: string;
  version: string | null;
  isActual: boolean;
  statements: PlanStatement[];
  warnings: string[];
  sourceKind?: PlanSourceKind;
  capturedAt?: string | null;
}

export interface EvidenceItem {
  label: string;
  value: string;
}

export interface DiagnosticTool {
  name: string;
  purpose: string;
  command?: string;
  caution?: string;
}

export interface BlockingParticipant {
  sessionId: number;
  blockedBySessionId: number | null;
  role: "Root" | "Intermediate" | "Victim";
  status: string | null;
  openTransactionCount: number | null;
  waitType: string | null;
  waitDurationMs: number | null;
}

export interface BlockingContext {
  headBlockerSessionId: number;
  blockedSessionIds: number[];
  totalBlockedSessions: number;
  status: string | null;
  databaseName: string | null;
  openTransactionCount: number | null;
  commandLabel: string | null;
  commandPreview: string | null;
  participants?: BlockingParticipant[];
  maxChainDepth?: number;
  chainComplete?: boolean;
}

export type TimelineDirection = "Increasing" | "Decreasing" | "Stable" | "Single observation";

export interface FindingTimelinePoint {
  capturedAt: string;
  value: number;
}

export interface FindingTimeline {
  metric: string;
  unit: "sessions" | "milliseconds" | "seconds" | "percent";
  points: FindingTimelinePoint[];
  firstValue: number;
  latestValue: number;
  peakValue: number;
  direction: TimelineDirection;
}

export interface CaptureRecommendation {
  title: string;
  reason: string;
  command?: string;
  expectedEvidence: string[];
  caution?: string;
}

export interface RelatedFindingLink {
  findingId: string;
  reason: string;
}

export type FindingQualificationKind = "Compile time" | "Compile CPU" | "Compile memory" | "Optimizer early abort" | "Optimization level";

export interface FindingQualification {
  kind: FindingQualificationKind;
  disposition: "Observed" | "Context only";
  value: string;
  reason: string;
  planId: string;
  statementId: string;
}

export interface Finding {
  id: string;
  ruleId: string;
  severity: Severity;
  confidence: Confidence;
  category: string;
  title: string;
  summary: string;
  explanation: string;
  remediation: string[];
  diagnosticTools?: DiagnosticTool[];
  blockingContext?: BlockingContext;
  confidenceReason?: string;
  limitations?: string[];
  timeline?: FindingTimeline;
  nextCapture?: CaptureRecommendation;
  relatedFindings?: RelatedFindingLink[];
  qualifications?: FindingQualification[];
  evidence: EvidenceItem[];
  references: { label: string; url: string }[];
  affectedRecordIds: string[];
  affectedPlanIds: string[];
  firstSeen?: string | null;
  lastSeen?: string | null;
  persistenceSeconds?: number | null;
  impact: number;
  deepAnalysisProfile?: string;
}

export interface FindingCapDisclosure {
  ruleId: string;
  retainedCount: number;
  suppressedCount: number;
  order: "Descending diagnostic impact";
}

export interface DataQuality {
  presentColumns: string[];
  missingColumns: string[];
  unknownColumns: string[];
  warnings: string[];
  notEvaluatedRules: string[];
  suppressedSignals?: string[];
  findingCaps?: FindingCapDisclosure[];
}

export interface ThresholdProfileThresholds {
  blocking: {
    mediumVictims: number;
    highVictims: number;
    mediumPersistenceSeconds: number;
    highPersistenceSeconds: number;
    transientVictimWaitMs: number;
  };
  resources: {
    minimumDurationSeconds: number;
    lowDurationSeconds: number;
    mediumDurationSeconds: number;
    highDurationSeconds: number;
    mediumPercentile: number;
    highPercentile: number;
    lowRepeatedCaptures: number;
    mediumConfidenceCaptures: number;
  };
  waits: {
    actionableDurationMs: number;
    highPersistenceSeconds: number;
    corroboratingCaptures: number;
    mediumConfidenceObservations: number;
  };
  workerExhaustion: {
    highCaptures: number;
    highConcurrency: number;
    highConfidenceCaptures: number;
  };
  compilePressure: {
    highCaptures: number;
    highConcurrency: number;
    highConfidenceCaptures: number;
    highConfidenceVariants: number;
  };
  transactions: {
    mediumAgeSeconds: number;
    highAgeSeconds: number;
  };
  plans: {
    mediumEstimateRatio: number;
    highEstimateRatio: number;
    mediumRows: number;
    highRows: number;
    mediumMissingIndexImpact: number;
    mediumGrantWasteKb: number;
    highGrantWasteKb: number;
    mediumGrantRatio: number;
    highGrantRatio: number;
  };
}

export interface ThresholdProfile {
  schemaVersion: "1.0";
  id: string;
  version: string;
  name: string;
  description: string;
  thresholds: ThresholdProfileThresholds;
}

export interface ThresholdProfileSnapshot extends Omit<ThresholdProfile, "description"> {
  digest: string;
}

export interface AnalysisWorkerRequest {
  files: File[];
  thresholdProfile: ThresholdProfileSnapshot;
}

export interface AnalysisReport {
  schemaVersion: "1.0";
  createdAt: string;
  inputs: AnalysisInput[];
  records: WhoIsActiveRecord[];
  plans: PlanDocument[];
  findings: Finding[];
  dataQuality: DataQuality;
  redacted: boolean;
  thresholdProfile?: ThresholdProfileSnapshot;
}

export interface RuleContext {
  inputs: AnalysisInput[];
  records: WhoIsActiveRecord[];
  plans: PlanDocument[];
  supplementalEvidence: SupplementalEvidenceSource[];
  presentColumns: Set<string>;
  thresholds: ThresholdProfileThresholds;
}

export interface RuleDefinition {
  id: string;
  title: string;
  category: string;
  requiredColumns: string[];
  optionalColumns: string[];
  description: string;
  references: { label: string; url: string }[];
  evaluate(context: RuleContext): Finding[];
}
