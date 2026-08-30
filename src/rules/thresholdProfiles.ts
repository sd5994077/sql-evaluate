import type { ThresholdProfile, ThresholdProfileSnapshot, ThresholdProfileThresholds } from "../types";

export const MAX_THRESHOLD_PROFILE_BYTES = 64 * 1024;

const PROFILE_KEYS = ["schemaVersion", "id", "version", "name", "description", "thresholds"] as const;
const SNAPSHOT_KEYS = ["schemaVersion", "id", "version", "name", "thresholds", "digest"] as const;
const THRESHOLD_GROUP_KEYS = ["blocking", "resources", "waits", "workerExhaustion", "compilePressure", "transactions", "plans"] as const;
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const DISALLOWED_NAME_CONTROLS = /[\u0000-\u001F\u007F]/;
const DISALLOWED_DESCRIPTION_CONTROLS = /[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F]/;

function fail(path: string, message: string): never {
  throw new Error(`${path} ${message}.`);
}

function objectAt(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, "must be an object");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(path, "must be a plain object");
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], path: string): void {
  const actual = Object.keys(value);
  const missing = expected.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (missing.length) fail(`${path}.${missing[0]}`, "is required");
  const unknown = actual.filter((key) => !expected.includes(key));
  if (unknown.length) fail(`${path}.${unknown[0]}`, "is not supported");
}

function stringAt(value: unknown, path: string): string {
  if (typeof value !== "string") fail(path, "must be a string");
  return value;
}

function numberAt(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "must be a finite number");
  return value;
}

function integerAt(value: unknown, path: string): number {
  const number = numberAt(value, path);
  if (!Number.isSafeInteger(number)) fail(path, "must be a safe integer");
  return number;
}

function minimum(value: number, lower: number, path: string): number {
  if (value < lower) fail(path, `must be greater than or equal to ${lower}`);
  return value;
}

function maximum(value: number, upper: number, path: string): number {
  if (value > upper) fail(path, `must be less than or equal to ${upper}`);
  return value;
}

function positive(value: number, path: string): number {
  if (value <= 0) fail(path, "must be greater than 0");
  return value;
}

function ordered(lower: number, upper: number, lowerPath: string, upperPath: string): void {
  if (lower > upper) fail(lowerPath, `must be less than or equal to ${upperPath}`);
}

function groupAt(value: Record<string, unknown>, key: string, expected: readonly string[]): Record<string, unknown> {
  const group = objectAt(value[key], `thresholds.${key}`);
  exactKeys(group, expected, `thresholds.${key}`);
  return group;
}

function validateThresholds(value: unknown): ThresholdProfileThresholds {
  const thresholds = objectAt(value, "thresholds");
  exactKeys(thresholds, THRESHOLD_GROUP_KEYS, "thresholds");

  const blockingValue = groupAt(thresholds, "blocking", ["mediumVictims", "highVictims", "mediumPersistenceSeconds", "highPersistenceSeconds", "transientVictimWaitMs"]);
  const blocking = {
    mediumVictims: minimum(integerAt(blockingValue.mediumVictims, "thresholds.blocking.mediumVictims"), 1, "thresholds.blocking.mediumVictims"),
    highVictims: minimum(integerAt(blockingValue.highVictims, "thresholds.blocking.highVictims"), 1, "thresholds.blocking.highVictims"),
    mediumPersistenceSeconds: minimum(integerAt(blockingValue.mediumPersistenceSeconds, "thresholds.blocking.mediumPersistenceSeconds"), 0, "thresholds.blocking.mediumPersistenceSeconds"),
    highPersistenceSeconds: minimum(integerAt(blockingValue.highPersistenceSeconds, "thresholds.blocking.highPersistenceSeconds"), 0, "thresholds.blocking.highPersistenceSeconds"),
    transientVictimWaitMs: minimum(integerAt(blockingValue.transientVictimWaitMs, "thresholds.blocking.transientVictimWaitMs"), 0, "thresholds.blocking.transientVictimWaitMs"),
  };
  ordered(blocking.mediumVictims, blocking.highVictims, "thresholds.blocking.mediumVictims", "thresholds.blocking.highVictims");
  ordered(blocking.mediumPersistenceSeconds, blocking.highPersistenceSeconds, "thresholds.blocking.mediumPersistenceSeconds", "thresholds.blocking.highPersistenceSeconds");

  const resourcesValue = groupAt(thresholds, "resources", ["minimumDurationSeconds", "lowDurationSeconds", "mediumDurationSeconds", "highDurationSeconds", "mediumPercentile", "highPercentile", "lowRepeatedCaptures", "mediumConfidenceCaptures"]);
  const resources = {
    minimumDurationSeconds: minimum(integerAt(resourcesValue.minimumDurationSeconds, "thresholds.resources.minimumDurationSeconds"), 0, "thresholds.resources.minimumDurationSeconds"),
    lowDurationSeconds: minimum(integerAt(resourcesValue.lowDurationSeconds, "thresholds.resources.lowDurationSeconds"), 0, "thresholds.resources.lowDurationSeconds"),
    mediumDurationSeconds: minimum(integerAt(resourcesValue.mediumDurationSeconds, "thresholds.resources.mediumDurationSeconds"), 0, "thresholds.resources.mediumDurationSeconds"),
    highDurationSeconds: minimum(integerAt(resourcesValue.highDurationSeconds, "thresholds.resources.highDurationSeconds"), 0, "thresholds.resources.highDurationSeconds"),
    mediumPercentile: maximum(positive(numberAt(resourcesValue.mediumPercentile, "thresholds.resources.mediumPercentile"), "thresholds.resources.mediumPercentile"), 1, "thresholds.resources.mediumPercentile"),
    highPercentile: maximum(positive(numberAt(resourcesValue.highPercentile, "thresholds.resources.highPercentile"), "thresholds.resources.highPercentile"), 1, "thresholds.resources.highPercentile"),
    lowRepeatedCaptures: minimum(integerAt(resourcesValue.lowRepeatedCaptures, "thresholds.resources.lowRepeatedCaptures"), 2, "thresholds.resources.lowRepeatedCaptures"),
    mediumConfidenceCaptures: minimum(integerAt(resourcesValue.mediumConfidenceCaptures, "thresholds.resources.mediumConfidenceCaptures"), 2, "thresholds.resources.mediumConfidenceCaptures"),
  };
  ordered(resources.minimumDurationSeconds, resources.lowDurationSeconds, "thresholds.resources.minimumDurationSeconds", "thresholds.resources.lowDurationSeconds");
  ordered(resources.lowDurationSeconds, resources.mediumDurationSeconds, "thresholds.resources.lowDurationSeconds", "thresholds.resources.mediumDurationSeconds");
  ordered(resources.mediumDurationSeconds, resources.highDurationSeconds, "thresholds.resources.mediumDurationSeconds", "thresholds.resources.highDurationSeconds");
  ordered(resources.mediumPercentile, resources.highPercentile, "thresholds.resources.mediumPercentile", "thresholds.resources.highPercentile");

  const waitsValue = groupAt(thresholds, "waits", ["actionableDurationMs", "highPersistenceSeconds", "corroboratingCaptures", "mediumConfidenceObservations"]);
  const waits = {
    actionableDurationMs: minimum(integerAt(waitsValue.actionableDurationMs, "thresholds.waits.actionableDurationMs"), 0, "thresholds.waits.actionableDurationMs"),
    highPersistenceSeconds: minimum(integerAt(waitsValue.highPersistenceSeconds, "thresholds.waits.highPersistenceSeconds"), 0, "thresholds.waits.highPersistenceSeconds"),
    corroboratingCaptures: minimum(integerAt(waitsValue.corroboratingCaptures, "thresholds.waits.corroboratingCaptures"), 2, "thresholds.waits.corroboratingCaptures"),
    mediumConfidenceObservations: minimum(integerAt(waitsValue.mediumConfidenceObservations, "thresholds.waits.mediumConfidenceObservations"), 2, "thresholds.waits.mediumConfidenceObservations"),
  };

  const workerValue = groupAt(thresholds, "workerExhaustion", ["highCaptures", "highConcurrency", "highConfidenceCaptures"]);
  const workerExhaustion = {
    highCaptures: minimum(integerAt(workerValue.highCaptures, "thresholds.workerExhaustion.highCaptures"), 2, "thresholds.workerExhaustion.highCaptures"),
    highConcurrency: minimum(integerAt(workerValue.highConcurrency, "thresholds.workerExhaustion.highConcurrency"), 2, "thresholds.workerExhaustion.highConcurrency"),
    highConfidenceCaptures: minimum(integerAt(workerValue.highConfidenceCaptures, "thresholds.workerExhaustion.highConfidenceCaptures"), 2, "thresholds.workerExhaustion.highConfidenceCaptures"),
  };

  const compileValue = groupAt(thresholds, "compilePressure", ["highCaptures", "highConcurrency", "highConfidenceCaptures", "highConfidenceVariants"]);
  const compilePressure = {
    highCaptures: minimum(integerAt(compileValue.highCaptures, "thresholds.compilePressure.highCaptures"), 2, "thresholds.compilePressure.highCaptures"),
    highConcurrency: minimum(integerAt(compileValue.highConcurrency, "thresholds.compilePressure.highConcurrency"), 2, "thresholds.compilePressure.highConcurrency"),
    highConfidenceCaptures: minimum(integerAt(compileValue.highConfidenceCaptures, "thresholds.compilePressure.highConfidenceCaptures"), 2, "thresholds.compilePressure.highConfidenceCaptures"),
    highConfidenceVariants: minimum(integerAt(compileValue.highConfidenceVariants, "thresholds.compilePressure.highConfidenceVariants"), 2, "thresholds.compilePressure.highConfidenceVariants"),
  };

  const transactionsValue = groupAt(thresholds, "transactions", ["mediumAgeSeconds", "highAgeSeconds"]);
  const transactions = {
    mediumAgeSeconds: minimum(integerAt(transactionsValue.mediumAgeSeconds, "thresholds.transactions.mediumAgeSeconds"), 0, "thresholds.transactions.mediumAgeSeconds"),
    highAgeSeconds: minimum(integerAt(transactionsValue.highAgeSeconds, "thresholds.transactions.highAgeSeconds"), 0, "thresholds.transactions.highAgeSeconds"),
  };
  ordered(transactions.mediumAgeSeconds, transactions.highAgeSeconds, "thresholds.transactions.mediumAgeSeconds", "thresholds.transactions.highAgeSeconds");

  const plansValue = groupAt(thresholds, "plans", ["mediumEstimateRatio", "highEstimateRatio", "mediumRows", "highRows", "mediumMissingIndexImpact", "mediumGrantWasteKb", "highGrantWasteKb", "mediumGrantRatio", "highGrantRatio"]);
  const plans = {
    mediumEstimateRatio: minimum(numberAt(plansValue.mediumEstimateRatio, "thresholds.plans.mediumEstimateRatio"), 1, "thresholds.plans.mediumEstimateRatio"),
    highEstimateRatio: minimum(numberAt(plansValue.highEstimateRatio, "thresholds.plans.highEstimateRatio"), 1, "thresholds.plans.highEstimateRatio"),
    mediumRows: minimum(integerAt(plansValue.mediumRows, "thresholds.plans.mediumRows"), 1, "thresholds.plans.mediumRows"),
    highRows: minimum(integerAt(plansValue.highRows, "thresholds.plans.highRows"), 1, "thresholds.plans.highRows"),
    mediumMissingIndexImpact: maximum(minimum(numberAt(plansValue.mediumMissingIndexImpact, "thresholds.plans.mediumMissingIndexImpact"), 0, "thresholds.plans.mediumMissingIndexImpact"), 100, "thresholds.plans.mediumMissingIndexImpact"),
    mediumGrantWasteKb: minimum(integerAt(plansValue.mediumGrantWasteKb, "thresholds.plans.mediumGrantWasteKb"), 0, "thresholds.plans.mediumGrantWasteKb"),
    highGrantWasteKb: minimum(integerAt(plansValue.highGrantWasteKb, "thresholds.plans.highGrantWasteKb"), 0, "thresholds.plans.highGrantWasteKb"),
    mediumGrantRatio: minimum(numberAt(plansValue.mediumGrantRatio, "thresholds.plans.mediumGrantRatio"), 1, "thresholds.plans.mediumGrantRatio"),
    highGrantRatio: minimum(numberAt(plansValue.highGrantRatio, "thresholds.plans.highGrantRatio"), 1, "thresholds.plans.highGrantRatio"),
  };
  ordered(plans.mediumEstimateRatio, plans.highEstimateRatio, "thresholds.plans.mediumEstimateRatio", "thresholds.plans.highEstimateRatio");
  ordered(plans.mediumRows, plans.highRows, "thresholds.plans.mediumRows", "thresholds.plans.highRows");
  ordered(plans.mediumGrantWasteKb, plans.highGrantWasteKb, "thresholds.plans.mediumGrantWasteKb", "thresholds.plans.highGrantWasteKb");
  ordered(plans.mediumGrantRatio, plans.highGrantRatio, "thresholds.plans.mediumGrantRatio", "thresholds.plans.highGrantRatio");

  return { blocking, resources, waits, workerExhaustion, compilePressure, transactions, plans };
}

function validateVersion(value: unknown): string {
  const version = stringAt(value, "version");
  const match = VERSION_PATTERN.exec(version);
  if (!match || match.slice(1).some((part) => !Number.isSafeInteger(Number(part)))) fail("version", "must use safe-integer MAJOR.MINOR.PATCH without prerelease or build metadata");
  return version;
}

export function isBuiltInThresholdProfileId(id: string): boolean {
  return id.startsWith("builtin.");
}

export function validateThresholdProfile(value: unknown): ThresholdProfile {
  const profile = objectAt(value, "profile");
  exactKeys(profile, PROFILE_KEYS, "profile");
  if (profile.schemaVersion !== "1.0") fail("schemaVersion", "must be 1.0");

  const id = stringAt(profile.id, "id");
  if (!ID_PATTERN.test(id)) fail("id", "must be 1-64 lowercase ASCII letters, numbers, dots, underscores, or hyphens and start with a letter or number");
  const version = validateVersion(profile.version);

  const name = stringAt(profile.name, "name");
  if (name !== name.trim() || [...name].length < 1 || [...name].length > 80 || DISALLOWED_NAME_CONTROLS.test(name)) fail("name", "must be trimmed, contain 1-80 characters, and contain no control characters or line breaks");

  const description = stringAt(profile.description, "description");
  if ([...description].length > 500 || DISALLOWED_DESCRIPTION_CONTROLS.test(description)) fail("description", "must contain at most 500 characters and no control characters other than line breaks");

  return { schemaVersion: "1.0", id, version, name, description, thresholds: validateThresholds(profile.thresholds) };
}

export function validateImportedThresholdProfile(value: unknown): ThresholdProfile {
  const profile = validateThresholdProfile(value);
  if (isBuiltInThresholdProfileId(profile.id)) fail("id", "uses the reserved builtin namespace");
  return profile;
}

function freezeProfile(profile: ThresholdProfile): ThresholdProfile {
  for (const group of Object.values(profile.thresholds)) Object.freeze(group);
  Object.freeze(profile.thresholds);
  return Object.freeze(profile);
}

function freezeSnapshot(snapshot: ThresholdProfileSnapshot): ThresholdProfileSnapshot {
  for (const group of Object.values(snapshot.thresholds)) Object.freeze(group);
  Object.freeze(snapshot.thresholds);
  return Object.freeze(snapshot);
}

export const DEFAULT_THRESHOLD_PROFILE: ThresholdProfile = freezeProfile(validateThresholdProfile({
  schemaVersion: "1.0",
  id: "builtin.default",
  version: "1.0.0",
  name: "SQL Evaluate published defaults",
  description: "Preserves SQL Evaluate 1.3.0 diagnostic behavior.",
  thresholds: {
    blocking: { mediumVictims: 2, highVictims: 5, mediumPersistenceSeconds: 15, highPersistenceSeconds: 60, transientVictimWaitMs: 1000 },
    resources: { minimumDurationSeconds: 30, lowDurationSeconds: 60, mediumDurationSeconds: 300, highDurationSeconds: 900, mediumPercentile: 0.9, highPercentile: 0.95, lowRepeatedCaptures: 3, mediumConfidenceCaptures: 2 },
    waits: { actionableDurationMs: 1000, highPersistenceSeconds: 60, corroboratingCaptures: 2, mediumConfidenceObservations: 2 },
    workerExhaustion: { highCaptures: 2, highConcurrency: 2, highConfidenceCaptures: 2 },
    compilePressure: { highCaptures: 3, highConcurrency: 4, highConfidenceCaptures: 2, highConfidenceVariants: 2 },
    transactions: { mediumAgeSeconds: 300, highAgeSeconds: 900 },
    plans: { mediumEstimateRatio: 10, highEstimateRatio: 100, mediumRows: 10_000, highRows: 100_000, mediumMissingIndexImpact: 70, mediumGrantWasteKb: 128 * 1024, highGrantWasteKb: 512 * 1024, mediumGrantRatio: 4, highGrantRatio: 8 },
  },
}));

export const DEFAULT_THRESHOLD_PROFILE_SNAPSHOT: ThresholdProfileSnapshot = freezeSnapshot({
  schemaVersion: DEFAULT_THRESHOLD_PROFILE.schemaVersion,
  id: DEFAULT_THRESHOLD_PROFILE.id,
  version: DEFAULT_THRESHOLD_PROFILE.version,
  name: DEFAULT_THRESHOLD_PROFILE.name,
  thresholds: DEFAULT_THRESHOLD_PROFILE.thresholds,
  digest: "a4c43e6bcd32c64685a65383015075767590a52170f8de1eb60b8c599b40a41a",
});

type ThresholdProfileAudit = Pick<ThresholdProfile, "schemaVersion" | "id" | "version" | "name" | "thresholds">;

export function canonicalThresholdProfileAudit(profile: ThresholdProfileAudit): string {
  const validated = validateThresholdProfile({
    schemaVersion: profile.schemaVersion,
    id: profile.id,
    version: profile.version,
    name: profile.name,
    description: "",
    thresholds: profile.thresholds,
  });
  const { thresholds } = validated;
  return JSON.stringify({
    schemaVersion: validated.schemaVersion,
    id: validated.id,
    version: validated.version,
    name: validated.name,
    thresholds: {
      blocking: { ...thresholds.blocking },
      resources: { ...thresholds.resources },
      waits: { ...thresholds.waits },
      workerExhaustion: { ...thresholds.workerExhaustion },
      compilePressure: { ...thresholds.compilePressure },
      transactions: { ...thresholds.transactions },
      plans: { ...thresholds.plans },
    },
  });
}

export async function thresholdProfileDigest(profile: ThresholdProfileAudit): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("Local SHA-256 support is unavailable in this browser.");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalThresholdProfileAudit(profile)));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function createThresholdProfileSnapshot(profile: ThresholdProfile): Promise<ThresholdProfileSnapshot> {
  const validated = validateThresholdProfile(profile);
  return freezeSnapshot({
    schemaVersion: validated.schemaVersion,
    id: validated.id,
    version: validated.version,
    name: validated.name,
    thresholds: validated.thresholds,
    digest: await thresholdProfileDigest(validated),
  });
}

export function validateThresholdProfileSnapshotShape(value: unknown): ThresholdProfileSnapshot {
  const snapshot = objectAt(value, "thresholdProfile");
  exactKeys(snapshot, SNAPSHOT_KEYS, "thresholdProfile");
  const profile = validateThresholdProfile({
    schemaVersion: snapshot.schemaVersion,
    id: snapshot.id,
    version: snapshot.version,
    name: snapshot.name,
    description: "",
    thresholds: snapshot.thresholds,
  });
  const digest = stringAt(snapshot.digest, "thresholdProfile.digest");
  if (!DIGEST_PATTERN.test(digest)) fail("thresholdProfile.digest", "must be 64 lowercase hexadecimal characters");
  return freezeSnapshot({ schemaVersion: profile.schemaVersion, id: profile.id, version: profile.version, name: profile.name, thresholds: profile.thresholds, digest });
}

export async function verifyThresholdProfileSnapshot(value: unknown): Promise<ThresholdProfileSnapshot> {
  const snapshot = validateThresholdProfileSnapshotShape(value);
  if (await thresholdProfileDigest(snapshot) !== snapshot.digest) throw new Error("thresholdProfile.digest does not match the profile contents.");
  return snapshot;
}
