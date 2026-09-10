import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { PlanObjectIdentity, PlanOperator, PlanStatement, PlanStatisticsUsage } from "../types";
import { APP_VERSION } from "../version";
import { openDeepCaseArchive } from "./case";
import { estimateRatio, resolveCandidatePlan } from "./spillTriage";
import type { DeepAnalysisCase, ServerCapabilitySnapshot } from "./types";

export type HistoryIssueCode =
  | "severe-underestimate"
  | "severe-overestimate"
  | "runtime-spill"
  | "plan-affecting-convert"
  | "non-sargable-predicate"
  | "statistics-never-updated"
  | "statistics-zero-sample"
  | "statistics-changed-since-update";

export interface HistoryTargetIdentity {
  serverFingerprint: string;
  serverName: string;
  database: string;
  schema: string;
  table: string;
  index: string | null;
  portableKey: string;
  serverKey: string;
}

export interface HistorySourceCase {
  caseId: string;
  caseDigest: string;
  caseSchemaVersion: string;
  appVersion: string;
  importedAt: string;
  serverName: string | null;
  serverFingerprint: string | null;
  olaDatabase: string | null;
  olaSchema: string | null;
  olaCompatible: boolean;
  resolved: boolean;
  limitation: string | null;
}

export interface HistoryCapture {
  id: string;
  kind: "actual-plan" | "statistics-verification";
  sourceCaseId: string | null;
  sourceDigest: string;
  capturedAt: string;
  serverFingerprint: string;
  targets: HistoryTargetIdentity[];
  statisticsUsage: PlanStatisticsUsage[];
}

export interface HistoryObservation {
  id: string;
  captureId: string;
  sourceCaseId: string | null;
  target: HistoryTargetIdentity;
  issueCode: HistoryIssueCode;
  nodeId: number | null;
  actualRows: number | null;
  estimatedRows: number | null;
  ratio: number | null;
  detail: string;
  attribution: "Exact" | "Nearest access";
}

export interface StatisticsVerificationSnapshot {
  schemaVersion: "1.0";
  adapterId: "SQL_EVALUATE_STATS_VERIFY_V1";
  sourceDigest: string;
  capturedAt: string;
  serverName: string;
  serverFingerprint: string;
  database: string;
  schema: string;
  table: string;
  index: string | null;
  statistics: string;
  objectId: number;
  indexId: number | null;
  statsId: number;
  lastUpdated: string | null;
  rows: number | null;
  rowsSampled: number | null;
  modificationCounter: number | null;
  autoUpdateStats: boolean | null;
  olaDatabase: string | null;
  olaSchema: string | null;
  olaProcedure: string | null;
  olaCompatible: boolean;
  target: HistoryTargetIdentity;
}

export interface InvestigationHistory {
  schemaVersion: "1.0";
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  sensitive: true;
  sources: HistorySourceCase[];
  captures: HistoryCapture[];
  observations: HistoryObservation[];
  verifications: StatisticsVerificationSnapshot[];
}

export interface HistoryArchiveManifest {
  schemaVersion: "1.0";
  historyId: string;
  appVersion: string;
  exportedAt: string;
  sensitive: true;
  historyPath: string;
  historySha256: string;
}

export interface HistoryTargetSummary {
  portableKey: string;
  displayName: string;
  target: HistoryTargetIdentity;
  serverNames: string[];
  planCaptureCount: number;
  verificationCaptureCount: number;
  issueCounts: Partial<Record<HistoryIssueCode, number>>;
  firstSeen: string;
  lastSeen: string;
  eligibleServerCount: number;
}

const ARCHIVE_LIMIT = 100 * 1024 * 1024;
const EXPANSION_LIMIT = 200 * 1024 * 1024;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

const ISSUE_LABELS: Record<HistoryIssueCode, string> = {
  "severe-underestimate": "Severe row underestimate",
  "severe-overestimate": "Severe row overestimate",
  "runtime-spill": "Runtime spill",
  "plan-affecting-convert": "Plan-affecting conversion",
  "non-sargable-predicate": "Non-SARGable predicate",
  "statistics-never-updated": "Statistics never updated",
  "statistics-zero-sample": "Statistics sampled zero rows",
  "statistics-changed-since-update": "Statistics changed since update",
};

export function historyIssueLabel(code: HistoryIssueCode): string {
  return ISSUE_LABELS[code];
}

function cleanIdentifier(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return trimmed.slice(1, -1).replace(/]]/g, "]");
  return trimmed;
}

function canonical(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

function makePortableKey(database: string, schema: string, table: string, index: string | null): string {
  return [database, schema, table, index ?? "<table>"].map(canonical).join("|");
}

function quoteSql(value: string): string {
  return `N'${value.replace(/'/g, "''")}'`;
}

function bracket(value: string): string {
  return `[${value.replace(/]/g, "]]")}]`;
}

async function sha256Bytes(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, "0")).join("");
}

async function sha256File(file: File): Promise<string> {
  return sha256Bytes(await file.arrayBuffer());
}

async function fingerprintServer(serverName: string): Promise<string> {
  const encoded = new TextEncoder().encode(canonical(serverName));
  const copy = new Uint8Array(encoded);
  return sha256Bytes(copy.buffer);
}

function targetFromObject(object: PlanObjectIdentity | undefined, statement: PlanStatement, deepCase: DeepAnalysisCase, fingerprint: string, serverName: string): HistoryTargetIdentity | null {
  const schema = cleanIdentifier(object?.schema);
  const table = cleanIdentifier(object?.table);
  const capability = deepCase.serverCapabilities;
  const databaseId = statement.queryIdentity?.databaseId;
  const canUseCapabilityDatabase = databaseId == null || capability?.databaseId == null || databaseId === capability.databaseId;
  const database = cleanIdentifier(object?.database) ?? (canUseCapabilityDatabase ? cleanIdentifier(capability?.databaseName) : null);
  if (!database || !schema || !table) return null;
  const index = cleanIdentifier(object?.index);
  const portableKey = makePortableKey(database, schema, table, index);
  return { serverFingerprint: fingerprint, serverName, database, schema, table, index, portableKey, serverKey: `${fingerprint}|${portableKey}` };
}

function nearestTargets(statement: PlanStatement, start: PlanOperator, deepCase: DeepAnalysisCase, fingerprint: string, serverName: string): Array<{ target: HistoryTargetIdentity; attribution: "Exact" | "Nearest access" }> {
  const exact = targetFromObject(start.objectIdentity, statement, deepCase, fingerprint, serverName);
  if (exact) return [{ target: exact, attribution: "Exact" }];
  const byNode = new Map(statement.operators.flatMap((item) => item.nodeId == null ? [] : [[item.nodeId, item] as const]));
  let frontier = [...(start.childNodeIds ?? [])];
  const visited = new Set<number>();
  while (frontier.length) {
    const next: number[] = [];
    const found = new Map<string, HistoryTargetIdentity>();
    for (const nodeId of frontier) {
      if (visited.has(nodeId)) continue;
      visited.add(nodeId);
      const operator = byNode.get(nodeId);
      if (!operator) continue;
      const target = targetFromObject(operator.objectIdentity, statement, deepCase, fingerprint, serverName);
      if (target) found.set(target.serverKey, target);
      else next.push(...(operator.childNodeIds ?? []));
    }
    if (found.size) return [...found.values()].map((target) => ({ target, attribution: "Nearest access" as const }));
    frontier = next;
  }
  return [];
}

function olaContext(snapshot: ServerCapabilitySnapshot | undefined): { database: string | null; schema: string | null; compatible: boolean } {
  const tool = snapshot?.tools.find((item) => item.toolId === "ola-indexoptimize");
  return {
    database: cleanIdentifier(tool?.databaseName),
    schema: cleanIdentifier(tool?.schemaName) ?? "dbo",
    compatible: Boolean(tool?.installed && tool.compatibleSignature),
  };
}

function addObservation(list: HistoryObservation[], capture: HistoryCapture, target: HistoryTargetIdentity, issueCode: HistoryIssueCode, operator: PlanOperator, ratio: number | null, detail: string, attribution: "Exact" | "Nearest access"): void {
  const id = [capture.id, target.serverKey, issueCode, operator.nodeId ?? "statement"].join(":");
  if (list.some((item) => item.id === id)) return;
  list.push({ id, captureId: capture.id, sourceCaseId: capture.sourceCaseId, target, issueCode, nodeId: operator.nodeId, actualRows: operator.actualRows, estimatedRows: operator.estimatedRows, ratio, detail, attribution });
}

async function deriveCase(file: File, thresholds: { ratio: number; rows: number }, importedAt: string): Promise<{ source: HistorySourceCase; captures: HistoryCapture[]; observations: HistoryObservation[] }> {
  const caseDigest = await sha256File(file);
  const { deepCase } = await openDeepCaseArchive(file);
  const serverName = cleanIdentifier(deepCase.serverCapabilities?.serverName);
  const serverFingerprint = serverName ? await fingerprintServer(serverName) : null;
  const ola = olaContext(deepCase.serverCapabilities);
  const source: HistorySourceCase = {
    caseId: deepCase.id,
    caseDigest,
    caseSchemaVersion: deepCase.schemaVersion,
    appVersion: APP_VERSION,
    importedAt,
    serverName,
    serverFingerprint,
    olaDatabase: ola.database,
    olaSchema: ola.schema,
    olaCompatible: ola.compatible,
    resolved: Boolean(serverName && serverFingerprint),
    limitation: serverName ? null : "A capability snapshot with server name is required before this case can contribute to recurrence totals.",
  };
  if (!serverName || !serverFingerprint || !deepCase.spillTriage) return { source, captures: [], observations: [] };

  const captures: HistoryCapture[] = [];
  const observations: HistoryObservation[] = [];
  const seenStatements = new Set<string>();
  for (const candidate of deepCase.spillTriage.candidates) {
    const manual = deepCase.spillTriage.manualPlanSelections.find((item) => item.candidateId === candidate.id);
    const resolution = resolveCandidatePlan(candidate, deepCase.spillTriage.plans, manual);
    if (!resolution.connected || !resolution.evidence || !resolution.statement || !resolution.evidence.plan.isActual || !resolution.statement.isActual) continue;
    const statementKey = `${resolution.evidence.artifactId}:${resolution.statement.id}`;
    if (seenStatements.has(statementKey)) continue;
    seenStatements.add(statementKey);
    const artifact = deepCase.artifacts.find((item) => item.id === resolution.evidence?.artifactId);
    const capturedAt = resolution.evidence.plan.capturedAt ?? artifact?.capturedAt ?? deepCase.sourceReportCreatedAt ?? deepCase.createdAt;
    const statementIdentity = resolution.statement.queryIdentity?.queryPlanHash ?? resolution.statement.queryIdentity?.queryHash ?? resolution.statement.id;
    const captureId = `${serverFingerprint}:${artifact?.sha256 ?? caseDigest}:${capturedAt}:${statementIdentity}`;
    const targetMap = new Map<string, HistoryTargetIdentity>();
    for (const operator of resolution.statement.operators) {
      const target = targetFromObject(operator.objectIdentity, resolution.statement, deepCase, serverFingerprint, serverName);
      if (target) targetMap.set(target.serverKey, target);
    }
    const capture: HistoryCapture = {
      id: captureId,
      kind: "actual-plan",
      sourceCaseId: deepCase.id,
      sourceDigest: artifact?.sha256 ?? caseDigest,
      capturedAt,
      serverFingerprint,
      targets: [...targetMap.values()],
      statisticsUsage: resolution.statement.statisticsUsage ?? [],
    };
    captures.push(capture);
    for (const operator of resolution.statement.operators) {
      const ratio = estimateRatio(operator);
      const targets = nearestTargets(resolution.statement, operator, deepCase, serverFingerprint, serverName);
      if (targets.length !== 1) continue;
      const linked = targets[0];
      if (ratio != null && ratio >= thresholds.ratio && (operator.actualRows ?? 0) >= thresholds.rows) {
        const code: HistoryIssueCode = (operator.actualRows ?? 0) > (operator.estimatedRows ?? 0) ? "severe-underestimate" : "severe-overestimate";
        addObservation(observations, capture, linked.target, code, operator, ratio, `${operator.physicalOp}: ${operator.actualRows?.toLocaleString()} actual versus ${operator.estimatedRows?.toLocaleString()} estimated rows.`, linked.attribution);
      }
      if ((operator.spillDetails?.length ?? 0) > 0 || operator.warnings.some((item) => /spill/i.test(item))) addObservation(observations, capture, linked.target, "runtime-spill", operator, ratio, `${operator.physicalOp} reported a runtime spill.`, linked.attribution);
      if (operator.warnings.some((item) => /convert/i.test(item))) addObservation(observations, capture, linked.target, "plan-affecting-convert", operator, ratio, `${operator.physicalOp} reported a conversion warning.`, linked.attribution);
      if (operator.nonSargablePredicate) addObservation(observations, capture, linked.target, "non-sargable-predicate", operator, ratio, `${operator.physicalOp} contains a non-SARGable predicate.`, linked.attribution);
    }
  }
  return { source, captures, observations };
}

export function createInvestigationHistory(now = new Date().toISOString(), id = `history-${Date.now().toString(36)}`): InvestigationHistory {
  return { schemaVersion: "1.0", id, title: "Investigation History", createdAt: now, updatedAt: now, sensitive: true, sources: [], captures: [], observations: [], verifications: [] };
}

export async function addCaseArchives(history: InvestigationHistory, files: File[], thresholds: { ratio: number; rows: number }, importedAt = new Date().toISOString()): Promise<{ history: InvestigationHistory; messages: string[] }> {
  let next = history;
  const messages: string[] = [];
  for (const file of files) {
    try {
      const derived = await deriveCase(file, thresholds, importedAt);
      next = {
        ...next,
        updatedAt: importedAt,
        sources: [...next.sources.filter((item) => item.caseId !== derived.source.caseId), derived.source],
        captures: [...next.captures.filter((item) => item.sourceCaseId !== derived.source.caseId), ...derived.captures],
        observations: [...next.observations.filter((item) => item.sourceCaseId !== derived.source.caseId), ...derived.observations],
      };
      messages.push(derived.source.resolved ? `${file.name}: imported ${derived.captures.length} qualifying actual-plan capture${derived.captures.length === 1 ? "" : "s"}.` : `${file.name}: imported as unresolved; add a server capability snapshot to the case.`);
    } catch (error) {
      messages.push(`${file.name}: ${error instanceof Error ? error.message : "The case could not be imported."}`);
    }
  }
  return { history: next, messages };
}

function numberValue(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function booleanValue(value: unknown): boolean | null {
  if (value === null || value === undefined || value === "") return null;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "y", "yes"].includes(normalized)) return true;
  if (["0", "false", "n", "no"].includes(normalized)) return false;
  return null;
}

function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""), value]));
}

async function readVerificationRows(file: File): Promise<Record<string, unknown>[]> {
  const XLSX = await import("xlsx");
  const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
  return workbook.SheetNames.flatMap((name) => XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[name], { defval: null })).map(normalizeRow);
}

export async function addVerificationFiles(history: InvestigationHistory, files: File[], importedAt = new Date().toISOString()): Promise<{ history: InvestigationHistory; messages: string[] }> {
  const messages: string[] = [];
  const incoming: StatisticsVerificationSnapshot[] = [];
  const captures: HistoryCapture[] = [];
  const observations: HistoryObservation[] = [];
  for (const file of files) {
    try {
      const sourceDigest = await sha256File(file);
      let accepted = 0;
      for (const raw of await readVerificationRows(file)) {
        if (raw.adapter_id !== "SQL_EVALUATE_STATS_VERIFY_V1" || String(raw.schema_version) !== "1.0") continue;
        const serverName = cleanIdentifier(String(raw.server_name ?? ""));
        const database = cleanIdentifier(String(raw.database_name ?? ""));
        const schema = cleanIdentifier(String(raw.schema_name ?? ""));
        const table = cleanIdentifier(String(raw.table_name ?? ""));
        const statistics = cleanIdentifier(String(raw.statistics_name ?? ""));
        const capturedAt = String(raw.captured_at ?? "");
        const objectId = numberValue(raw.object_id);
        const statsId = numberValue(raw.stats_id);
        if (!serverName || !database || !schema || !table || !statistics || !Number.isFinite(new Date(capturedAt).getTime()) || objectId == null || statsId == null) continue;
        const serverFingerprint = await fingerprintServer(serverName);
        const index = cleanIdentifier(raw.index_name == null ? null : String(raw.index_name));
        const portableKey = makePortableKey(database, schema, table, index);
        const target: HistoryTargetIdentity = { serverFingerprint, serverName, database, schema, table, index, portableKey, serverKey: `${serverFingerprint}|${portableKey}` };
        const snapshot: StatisticsVerificationSnapshot = {
          schemaVersion: "1.0",
          adapterId: "SQL_EVALUATE_STATS_VERIFY_V1",
          sourceDigest,
          capturedAt,
          serverName,
          serverFingerprint,
          database,
          schema,
          table,
          index,
          statistics,
          objectId,
          indexId: numberValue(raw.index_id),
          statsId,
          lastUpdated: raw.last_updated ? String(raw.last_updated) : null,
          rows: numberValue(raw.rows),
          rowsSampled: numberValue(raw.rows_sampled),
          modificationCounter: numberValue(raw.modification_counter),
          autoUpdateStats: booleanValue(raw.auto_update_stats_on),
          olaDatabase: cleanIdentifier(raw.ola_database == null ? null : String(raw.ola_database)),
          olaSchema: cleanIdentifier(raw.ola_schema == null ? null : String(raw.ola_schema)),
          olaProcedure: cleanIdentifier(raw.ola_procedure == null ? null : String(raw.ola_procedure)),
          olaCompatible: booleanValue(raw.ola_compatible) === true,
          target,
        };
        incoming.push(snapshot);
        const captureId = `${serverFingerprint}:${sourceDigest}:${capturedAt}:${objectId}:${statsId}`;
        const capture: HistoryCapture = { id: captureId, kind: "statistics-verification", sourceCaseId: null, sourceDigest, capturedAt, serverFingerprint, targets: [target], statisticsUsage: [] };
        captures.push(capture);
        const base = { captureId, sourceCaseId: null, target, nodeId: null, actualRows: null, estimatedRows: null, ratio: null, attribution: "Exact" as const };
        if (snapshot.lastUpdated === null && (snapshot.rows ?? 0) > 0) observations.push({ ...base, id: `${captureId}:never`, issueCode: "statistics-never-updated", detail: `${statistics} has no recorded update timestamp.` });
        if ((snapshot.rows ?? 0) > 0 && snapshot.rowsSampled === 0) observations.push({ ...base, id: `${captureId}:sample`, issueCode: "statistics-zero-sample", detail: `${statistics} sampled zero rows.` });
        if ((snapshot.modificationCounter ?? 0) > 0) observations.push({ ...base, id: `${captureId}:modified`, issueCode: "statistics-changed-since-update", detail: `${statistics} has ${snapshot.modificationCounter?.toLocaleString()} modifications since its last update.` });
        accepted += 1;
      }
      messages.push(`${file.name}: imported ${accepted} statistics verification row${accepted === 1 ? "" : "s"}.`);
    } catch (error) {
      messages.push(`${file.name}: ${error instanceof Error ? error.message : "The verification result could not be imported."}`);
    }
  }
  const captureIds = new Set(captures.map((item) => item.id));
  const observationIds = new Set(observations.map((item) => item.id));
  const verificationIds = new Set(incoming.map((item) => `${item.serverFingerprint}:${item.sourceDigest}:${item.capturedAt}:${item.objectId}:${item.statsId}`));
  return {
    messages,
    history: {
      ...history,
      updatedAt: importedAt,
      verifications: [...history.verifications.filter((item) => !verificationIds.has(`${item.serverFingerprint}:${item.sourceDigest}:${item.capturedAt}:${item.objectId}:${item.statsId}`)), ...incoming],
      captures: [...history.captures.filter((item) => !captureIds.has(item.id)), ...captures],
      observations: [...history.observations.filter((item) => !observationIds.has(item.id)), ...observations],
    },
  };
}

function supportsPreview(snapshot: StatisticsVerificationSnapshot, now = Date.now()): boolean {
  const age = now - new Date(snapshot.capturedAt).getTime();
  const hasSignal = (snapshot.modificationCounter ?? 0) > 0 || snapshot.lastUpdated === null && (snapshot.rows ?? 0) > 0 || (snapshot.rows ?? 0) > 0 && snapshot.rowsSampled === 0;
  return age >= 0 && age <= THIRTY_DAYS_MS && snapshot.olaCompatible && Boolean(snapshot.olaDatabase && snapshot.olaSchema) && hasSignal;
}

export function historyTargets(history: InvestigationHistory, now = Date.now()): HistoryTargetSummary[] {
  const identities = new Map<string, HistoryTargetIdentity>();
  for (const capture of history.captures) for (const target of capture.targets) identities.set(target.portableKey, target);
  return [...identities.entries()].map(([portableKey, target]) => {
    const captures = [...new Map(history.captures.filter((item) => item.targets.some((candidate) => candidate.portableKey === portableKey)).map((item) => [item.id, item])).values()];
    const issueCounts: Partial<Record<HistoryIssueCode, number>> = {};
    for (const code of Object.keys(ISSUE_LABELS) as HistoryIssueCode[]) {
      const count = new Set(history.observations.filter((item) => item.target.portableKey === portableKey && item.issueCode === code).map((item) => item.captureId)).size;
      if (count) issueCounts[code] = count;
    }
    const dates = captures.map((item) => item.capturedAt).sort();
    return {
      portableKey,
      displayName: [target.database, target.schema, target.table, target.index].filter(Boolean).join("."),
      target,
      serverNames: [...new Set(captures.flatMap((item) => item.targets.filter((candidate) => candidate.portableKey === portableKey).map((candidate) => candidate.serverName)))].sort(),
      planCaptureCount: captures.filter((item) => item.kind === "actual-plan").length,
      verificationCaptureCount: captures.filter((item) => item.kind === "statistics-verification").length,
      issueCounts,
      firstSeen: dates[0] ?? "",
      lastSeen: dates.at(-1) ?? "",
      eligibleServerCount: new Set(history.verifications.filter((item) => item.target.portableKey === portableKey && supportsPreview(item, now)).map((item) => item.serverFingerprint)).size,
    };
  }).sort((left, right) => Object.values(right.issueCounts).reduce((sum, value) => sum + (value ?? 0), 0) - Object.values(left.issueCounts).reduce((sum, value) => sum + (value ?? 0), 0) || left.displayName.localeCompare(right.displayName));
}

function sourceMappings(history: InvestigationHistory): Array<{ server: string; database: string; schema: string }> {
  return [...new Map(history.sources.filter((item) => item.resolved && item.serverName && item.olaDatabase && item.olaSchema && item.olaCompatible).map((item) => [canonical(item.serverName!), { server: item.serverName!, database: item.olaDatabase!, schema: item.olaSchema! }])).values()];
}

export function generateStatisticsVerificationSql(history: InvestigationHistory, summary: HistoryTargetSummary): string {
  const target = summary.target;
  const mappings = sourceMappings(history);
  const mappingSql = mappings.length ? mappings.map((item) => `(${quoteSql(item.server)}, ${quoteSql(item.database)}, ${quoteSql(item.schema)})`).join(",\n  ") : "(N'<unverified>', NULL, NULL)";
  return `/* SQL Evaluate ${APP_VERSION}: read-only statistics verification
Run independently on each intended server, save the result grid, and import it into Investigation History. */
SET NOCOUNT ON;
DECLARE @TargetDatabase sysname = ${quoteSql(target.database)};
DECLARE @TargetSchema sysname = ${quoteSql(target.schema)};
DECLARE @TargetTable sysname = ${quoteSql(target.table)};
DECLARE @TargetIndex sysname = ${target.index ? quoteSql(target.index) : "NULL"};
DECLARE @CurrentServer sysname = CONVERT(sysname, SERVERPROPERTY('ServerName'));
DECLARE @KnownServers table (server_name sysname, ola_database sysname NULL, ola_schema sysname NULL);
INSERT @KnownServers VALUES
  ${mappingSql};
DECLARE @OlaDatabase sysname, @OlaSchema sysname;
SELECT @OlaDatabase = ola_database, @OlaSchema = ola_schema FROM @KnownServers WHERE LOWER(server_name) = LOWER(@CurrentServer);
IF DB_ID(@TargetDatabase) IS NULL THROW 51000, 'Target database does not exist on this server.', 1;
DECLARE @OlaObject nvarchar(776) = CASE WHEN @OlaDatabase IS NULL THEN NULL ELSE QUOTENAME(@OlaDatabase) + N'.' + QUOTENAME(@OlaSchema) + N'.[IndexOptimize]' END;
DECLARE @OlaCompatible bit = CASE WHEN @OlaObject IS NOT NULL AND OBJECT_ID(@OlaObject, N'P') IS NOT NULL THEN 1 ELSE 0 END;
DECLARE @Sql nvarchar(max) = N'USE ' + QUOTENAME(@TargetDatabase) + N';
SELECT N''SQL_EVALUATE_STATS_VERIFY_V1'' AS adapter_id, N''1.0'' AS schema_version,
  CONVERT(nvarchar(33), SYSUTCDATETIME(), 126) AS captured_at, CONVERT(nvarchar(128), SERVERPROPERTY(''ServerName'')) AS server_name,
  DB_NAME() AS database_name, SCHEMA_NAME(o.schema_id) AS schema_name, o.name AS table_name, i.name AS index_name, s.name AS statistics_name,
  o.object_id, i.index_id, s.stats_id, CONVERT(nvarchar(33), p.last_updated, 126) AS last_updated, p.rows, p.rows_sampled, p.modification_counter,
  CONVERT(int, DATABASEPROPERTYEX(DB_NAME(), ''IsAutoUpdateStatistics'')) AS auto_update_stats_on,
  @OlaDatabase AS ola_database, @OlaSchema AS ola_schema, N''IndexOptimize'' AS ola_procedure, @OlaCompatible AS ola_compatible
FROM sys.objects AS o
JOIN sys.stats AS s ON s.object_id = o.object_id
LEFT JOIN sys.indexes AS i ON i.object_id = s.object_id AND i.index_id = s.stats_id
OUTER APPLY sys.dm_db_stats_properties(s.object_id, s.stats_id) AS p
WHERE o.type = N''U'' AND SCHEMA_NAME(o.schema_id) = @TargetSchema AND o.name = @TargetTable
  AND (@TargetIndex IS NULL OR i.name = @TargetIndex OR s.name = @TargetIndex)
ORDER BY s.stats_id;';
EXEC sys.sp_executesql @Sql, N'@TargetSchema sysname, @TargetTable sysname, @TargetIndex sysname, @OlaDatabase sysname, @OlaSchema sysname, @OlaCompatible bit',
  @TargetSchema, @TargetTable, @TargetIndex, @OlaDatabase, @OlaSchema, @OlaCompatible;
`;
}

export function generateOlaPreviewSql(history: InvestigationHistory, summary: HistoryTargetSummary, now = Date.now()): { sql: string | null; reason: string } {
  const eligible = [...new Map(history.verifications.filter((item) => item.target.portableKey === summary.portableKey && supportsPreview(item, now)).map((item) => [canonical(item.serverName), item])).values()];
  if (!eligible.length) return { sql: null, reason: "Import a current verification result with a statistics-change signal and a compatible Ola IndexOptimize installation." };
  const target = summary.target;
  const rows = eligible.map((item) => `(${quoteSql(item.serverName)}, ${quoteSql(item.olaDatabase!)}, ${quoteSql(item.olaSchema ?? "dbo")})`).join(",\n  ");
  const selector = [target.database, target.schema, target.table, target.index].filter((item): item is string => Boolean(item)).map(bracket).join(".");
  const statisticsScope = target.index ? "INDEX" : "ALL";
  return {
    reason: `${eligible.length} verified server${eligible.length === 1 ? "" : "s"} included.`,
    sql: `/* SQL Evaluate ${APP_VERSION}: advisory Ola Hallengren statistics preview
This script is reusable across the verified servers below and performs no maintenance while @Execute = N'N'. */
SET NOCOUNT ON;
DECLARE @Execute nvarchar(1) = N'N'; -- Change only after independent DBA review and change approval.
DECLARE @CurrentServer sysname = CONVERT(sysname, SERVERPROPERTY('ServerName'));
DECLARE @TargetDatabase sysname = ${quoteSql(target.database)};
DECLARE @TargetObject nvarchar(776) = ${quoteSql(`${bracket(target.database)}.${bracket(target.schema)}.${bracket(target.table)}`)};
DECLARE @IndexSelector nvarchar(max) = ${quoteSql(selector)};
DECLARE @VerifiedServers table (server_name sysname PRIMARY KEY, utility_database sysname, utility_schema sysname);
INSERT @VerifiedServers VALUES
  ${rows};
DECLARE @UtilityDatabase sysname, @UtilitySchema sysname;
SELECT @UtilityDatabase = utility_database, @UtilitySchema = utility_schema FROM @VerifiedServers WHERE LOWER(server_name) = LOWER(@CurrentServer);
IF @UtilityDatabase IS NULL THROW 51000, 'This server has not passed imported SQL Evaluate statistics verification.', 1;
IF DB_ID(@TargetDatabase) IS NULL THROW 51000, 'The verified target database is missing.', 1;
IF OBJECT_ID(@TargetObject, N'U') IS NULL THROW 51000, 'The verified target table is missing.', 1;
DECLARE @OlaObject nvarchar(776) = QUOTENAME(@UtilityDatabase) + N'.' + QUOTENAME(@UtilitySchema) + N'.[IndexOptimize]';
IF OBJECT_ID(@OlaObject, N'P') IS NULL THROW 51000, 'The verified Ola IndexOptimize procedure is missing.', 1;
SELECT @CurrentServer AS current_server, @TargetObject AS target_table, @IndexSelector AS ola_index_selector, @Execute AS execute_mode, ${quoteSql(statisticsScope)} AS statistics_scope;
DECLARE @Sql nvarchar(max) = N'EXEC ' + QUOTENAME(@UtilityDatabase) + N'.' + QUOTENAME(@UtilitySchema) + N'.[IndexOptimize]
  @Databases = @Databases, @Indexes = @Indexes,
  @FragmentationLow = NULL, @FragmentationMedium = NULL, @FragmentationHigh = NULL,
  @UpdateStatistics = @UpdateStatistics, @OnlyModifiedStatistics = N''Y'', @Execute = @Execute;';
EXEC sys.sp_executesql @Sql, N'@Databases nvarchar(max), @Indexes nvarchar(max), @UpdateStatistics nvarchar(max), @Execute nvarchar(1)',
  @Databases = @TargetDatabase, @Indexes = @IndexSelector, @UpdateStatistics = ${quoteSql(statisticsScope)}, @Execute = @Execute;
`,
  };
}

function declaredExpansion(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let offset = bytes.byteLength - 22; offset >= Math.max(0, bytes.byteLength - 65_557); offset -= 1) if (view.getUint32(offset, true) === 0x06054b50) { end = offset; break; }
  if (end < 0) throw new Error("The history ZIP directory is missing.");
  const count = view.getUint16(end + 10, true);
  let cursor = view.getUint32(end + 16, true);
  let total = 0;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > bytes.byteLength || view.getUint32(cursor, true) !== 0x02014b50) throw new Error("The history ZIP directory is malformed.");
    const size = view.getUint32(cursor + 24, true);
    if (size === 0xffffffff) throw new Error("ZIP64 history archives are not supported.");
    total += size;
    cursor += 46 + view.getUint16(cursor + 28, true) + view.getUint16(cursor + 30, true) + view.getUint16(cursor + 32, true);
  }
  return total;
}

function validHistory(value: unknown): value is InvestigationHistory {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<InvestigationHistory>;
  return item.schemaVersion === "1.0" && typeof item.id === "string" && typeof item.title === "string" && item.sensitive === true && Array.isArray(item.sources) && Array.isArray(item.captures) && Array.isArray(item.observations) && Array.isArray(item.verifications);
}

export async function createHistoryArchive(history: InvestigationHistory, exportedAt = new Date().toISOString()): Promise<{ fileName: string; bytes: Uint8Array; manifest: HistoryArchiveManifest }> {
  const historyPath = "history/history.json";
  const historyBytes = strToU8(JSON.stringify({ ...history, updatedAt: exportedAt }, null, 2));
  const copy = new Uint8Array(historyBytes);
  const historySha256 = await sha256Bytes(copy.buffer);
  const manifest: HistoryArchiveManifest = { schemaVersion: "1.0", historyId: history.id, appVersion: APP_VERSION, exportedAt, sensitive: true, historyPath, historySha256 };
  const bytes = zipSync({ "manifest.json": strToU8(JSON.stringify(manifest, null, 2)), [historyPath]: historyBytes }, { level: 6 });
  return { fileName: `SQL-Evaluate-History_${history.id}.sqlevalhistory.zip`, bytes, manifest };
}

export async function openHistoryArchive(file: File): Promise<InvestigationHistory> {
  if (file.size > ARCHIVE_LIMIT) throw new Error("Investigation History archives are limited to 100 MB.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (declaredExpansion(bytes) > EXPANSION_LIMIT) throw new Error("The Investigation History archive expands beyond 200 MB.");
  let entries: Record<string, Uint8Array>;
  try { entries = unzipSync(bytes); } catch { throw new Error("The Investigation History ZIP could not be opened."); }
  if (Object.values(entries).reduce((sum, item) => sum + item.byteLength, 0) > EXPANSION_LIMIT) throw new Error("The Investigation History archive expands beyond 200 MB.");
  const manifestBytes = entries["manifest.json"];
  if (!manifestBytes) throw new Error("The Investigation History archive has no manifest.");
  const manifest = JSON.parse(strFromU8(manifestBytes)) as Partial<HistoryArchiveManifest>;
  if (manifest.schemaVersion !== "1.0" || typeof manifest.historyId !== "string" || manifest.sensitive !== true || manifest.historyPath !== "history/history.json" || typeof manifest.historySha256 !== "string") throw new Error("The Investigation History manifest is malformed or unsupported.");
  const historyBytes = entries[manifest.historyPath];
  if (!historyBytes) throw new Error("The Investigation History document is missing.");
  const copy = new Uint8Array(historyBytes);
  if (await sha256Bytes(copy.buffer) !== manifest.historySha256) throw new Error("The Investigation History document hash verification failed.");
  const history = JSON.parse(strFromU8(historyBytes));
  if (!validHistory(history) || history.id !== manifest.historyId) throw new Error("The Investigation History document is malformed.");
  return history;
}
