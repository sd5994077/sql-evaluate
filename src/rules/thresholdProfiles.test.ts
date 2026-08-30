import { describe, expect, it } from "vitest";
import type { ThresholdProfile } from "../types";
import {
  canonicalThresholdProfileAudit,
  createThresholdProfileSnapshot,
  DEFAULT_THRESHOLD_PROFILE,
  DEFAULT_THRESHOLD_PROFILE_SNAPSHOT,
  MAX_THRESHOLD_PROFILE_BYTES,
  thresholdProfileDigest,
  validateImportedThresholdProfile,
  validateThresholdProfile,
  validateThresholdProfileSnapshotShape,
  verifyThresholdProfileSnapshot,
} from "./thresholdProfiles";

function editableDefault(): ThresholdProfile {
  return structuredClone(DEFAULT_THRESHOLD_PROFILE);
}

function setPath(profile: ThresholdProfile, path: string, value: unknown): void {
  const parts = path.split(".");
  let target: Record<string, unknown> = profile as unknown as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) target = target[part] as Record<string, unknown>;
  target[parts.at(-1)!] = value;
}

describe("threshold profiles", () => {
  it("publishes one frozen default with every current diagnostic cutoff", () => {
    expect(DEFAULT_THRESHOLD_PROFILE).toMatchObject({
      schemaVersion: "1.0",
      id: "builtin.default",
      version: "1.0.0",
      thresholds: {
        blocking: { mediumVictims: 2, highVictims: 5, mediumPersistenceSeconds: 15, highPersistenceSeconds: 60, transientVictimWaitMs: 1000 },
        resources: { minimumDurationSeconds: 30, lowDurationSeconds: 60, mediumDurationSeconds: 300, highDurationSeconds: 900, mediumPercentile: 0.9, highPercentile: 0.95, lowRepeatedCaptures: 3, mediumConfidenceCaptures: 2 },
        waits: { actionableDurationMs: 1000, highPersistenceSeconds: 60, corroboratingCaptures: 2, mediumConfidenceObservations: 2 },
        workerExhaustion: { highCaptures: 2, highConcurrency: 2, highConfidenceCaptures: 2 },
        compilePressure: { highCaptures: 3, highConcurrency: 4, highConfidenceCaptures: 2, highConfidenceVariants: 2 },
        transactions: { mediumAgeSeconds: 300, highAgeSeconds: 900 },
        plans: { mediumEstimateRatio: 10, highEstimateRatio: 100, mediumRows: 10_000, highRows: 100_000, mediumMissingIndexImpact: 70, mediumGrantWasteKb: 131_072, highGrantWasteKb: 524_288, mediumGrantRatio: 4, highGrantRatio: 8 },
      },
    });
    expect(Object.isFrozen(DEFAULT_THRESHOLD_PROFILE)).toBe(true);
    expect(Object.isFrozen(DEFAULT_THRESHOLD_PROFILE.thresholds)).toBe(true);
    expect(Object.values(DEFAULT_THRESHOLD_PROFILE.thresholds).every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(DEFAULT_THRESHOLD_PROFILE_SNAPSHOT)).toBe(true);
    expect(Object.isFrozen(DEFAULT_THRESHOLD_PROFILE_SNAPSHOT.thresholds)).toBe(true);
    expect(Object.values(DEFAULT_THRESHOLD_PROFILE_SNAPSHOT.thresholds).every(Object.isFrozen)).toBe(true);
    expect(MAX_THRESHOLD_PROFILE_BYTES).toBe(65_536);
  });

  it("validates and clones a complete custom profile without coercion", () => {
    const value = editableDefault();
    value.id = "dba.weekday";
    value.name = "DBA weekday";
    value.description = "Local calibration\nReviewed by the DBA team.";
    const validated = validateImportedThresholdProfile(value);
    expect(validated).toEqual(value);
    expect(validated).not.toBe(value);
    expect(validated.thresholds).not.toBe(value.thresholds);
  });

  it.each([
    ["thresholds.blocking.mediumVictims", 0],
    ["thresholds.blocking.highVictims", 0],
    ["thresholds.blocking.mediumPersistenceSeconds", -1],
    ["thresholds.blocking.highPersistenceSeconds", -1],
    ["thresholds.blocking.transientVictimWaitMs", -1],
    ["thresholds.resources.minimumDurationSeconds", -1],
    ["thresholds.resources.lowDurationSeconds", -1],
    ["thresholds.resources.mediumDurationSeconds", -1],
    ["thresholds.resources.highDurationSeconds", -1],
    ["thresholds.resources.mediumPercentile", 0],
    ["thresholds.resources.highPercentile", 1.01],
    ["thresholds.resources.lowRepeatedCaptures", 1],
    ["thresholds.resources.mediumConfidenceCaptures", 1],
    ["thresholds.waits.actionableDurationMs", -1],
    ["thresholds.waits.highPersistenceSeconds", -1],
    ["thresholds.waits.corroboratingCaptures", 1],
    ["thresholds.waits.mediumConfidenceObservations", 1],
    ["thresholds.workerExhaustion.highCaptures", 1],
    ["thresholds.workerExhaustion.highConcurrency", 1],
    ["thresholds.workerExhaustion.highConfidenceCaptures", 1],
    ["thresholds.compilePressure.highCaptures", 1],
    ["thresholds.compilePressure.highConcurrency", 1],
    ["thresholds.compilePressure.highConfidenceCaptures", 1],
    ["thresholds.compilePressure.highConfidenceVariants", 1],
    ["thresholds.transactions.mediumAgeSeconds", -1],
    ["thresholds.transactions.highAgeSeconds", -1],
    ["thresholds.plans.mediumEstimateRatio", 0.99],
    ["thresholds.plans.highEstimateRatio", 0.99],
    ["thresholds.plans.mediumRows", 0],
    ["thresholds.plans.highRows", 0],
    ["thresholds.plans.mediumMissingIndexImpact", 101],
    ["thresholds.plans.mediumGrantWasteKb", -1],
    ["thresholds.plans.highGrantWasteKb", -1],
    ["thresholds.plans.mediumGrantRatio", 0.99],
    ["thresholds.plans.highGrantRatio", 0.99],
  ])("rejects an out-of-range value for %s", (path, invalid) => {
    const value = editableDefault();
    setPath(value, path, invalid);
    expect(() => validateThresholdProfile(value)).toThrow(path);
  });

  it.each([
    ["thresholds.blocking.mediumVictims", "5"],
    ["thresholds.resources.minimumDurationSeconds", 2.5],
    ["thresholds.waits.actionableDurationMs", Number.MAX_SAFE_INTEGER + 1],
    ["thresholds.transactions.mediumAgeSeconds", Number.NaN],
    ["thresholds.plans.mediumEstimateRatio", Number.POSITIVE_INFINITY],
  ])("rejects an invalid numeric representation for %s", (path, invalid) => {
    const value = editableDefault();
    setPath(value, path, invalid);
    expect(() => validateThresholdProfile(value)).toThrow(path);
  });

  it.each([
    ["thresholds.blocking.mediumVictims", "thresholds.blocking.highVictims", 6],
    ["thresholds.blocking.mediumPersistenceSeconds", "thresholds.blocking.highPersistenceSeconds", 61],
    ["thresholds.resources.minimumDurationSeconds", "thresholds.resources.lowDurationSeconds", 61],
    ["thresholds.resources.lowDurationSeconds", "thresholds.resources.mediumDurationSeconds", 301],
    ["thresholds.resources.mediumDurationSeconds", "thresholds.resources.highDurationSeconds", 901],
    ["thresholds.resources.mediumPercentile", "thresholds.resources.highPercentile", 0.96],
    ["thresholds.transactions.mediumAgeSeconds", "thresholds.transactions.highAgeSeconds", 901],
    ["thresholds.plans.mediumEstimateRatio", "thresholds.plans.highEstimateRatio", 101],
    ["thresholds.plans.mediumRows", "thresholds.plans.highRows", 100_001],
    ["thresholds.plans.mediumGrantWasteKb", "thresholds.plans.highGrantWasteKb", 524_289],
    ["thresholds.plans.mediumGrantRatio", "thresholds.plans.highGrantRatio", 9],
  ])("rejects %s above %s", (lowerPath, _upperPath, invalid) => {
    const value = editableDefault();
    setPath(value, lowerPath, invalid);
    expect(() => validateThresholdProfile(value)).toThrow(lowerPath);
  });

  it("rejects incomplete, unknown, inherited, and prototype-polluting objects", () => {
    const missing = editableDefault() as ThresholdProfile & { thresholds: Record<string, unknown> };
    delete (missing.thresholds.blocking as Record<string, unknown>).mediumVictims;
    expect(() => validateThresholdProfile(missing)).toThrow("thresholds.blocking.mediumVictims");

    const unknown = editableDefault() as ThresholdProfile & { unexpected?: boolean };
    unknown.unexpected = true;
    expect(() => validateThresholdProfile(unknown)).toThrow("profile.unexpected");

    const nestedUnknown = editableDefault();
    (nestedUnknown.thresholds.plans as unknown as Record<string, unknown>).unexpected = 1;
    expect(() => validateThresholdProfile(nestedUnknown)).toThrow("thresholds.plans.unexpected");

    const inherited = Object.create({ inherited: true }) as Record<string, unknown>;
    Object.assign(inherited, editableDefault());
    expect(() => validateThresholdProfile(inherited)).toThrow("plain object");

    const polluted = JSON.parse(JSON.stringify(editableDefault()).replace('"description":', '"__proto__":{"polluted":true},"description":'));
    expect(() => validateThresholdProfile(polluted)).toThrow("profile.__proto__");
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it.each([
    [{ ...editableDefault(), schemaVersion: "2.0" }, "schemaVersion"],
    [{ ...editableDefault(), id: "BuiltIn.Default" }, "id"],
    [{ ...editableDefault(), id: "-custom" }, "id"],
    [{ ...editableDefault(), version: "1.0" }, "version"],
    [{ ...editableDefault(), version: "01.0.0" }, "version"],
    [{ ...editableDefault(), version: `${Number.MAX_SAFE_INTEGER + 1}.0.0` }, "version"],
    [{ ...editableDefault(), name: " padded" }, "name"],
    [{ ...editableDefault(), name: "line\nbreak" }, "name"],
    [{ ...editableDefault(), description: "bad\tcontrol" }, "description"],
  ])("rejects invalid profile metadata", (value, path) => {
    expect(() => validateThresholdProfile(value)).toThrow(path);
  });

  it("reserves builtin IDs for bundled profiles", () => {
    expect(validateThresholdProfile(DEFAULT_THRESHOLD_PROFILE).id).toBe("builtin.default");
    expect(() => validateImportedThresholdProfile(DEFAULT_THRESHOLD_PROFILE)).toThrow(/reserved builtin/);
  });

  it("uses deterministic canonical bytes and excludes the description from identity", async () => {
    const expected = '{"schemaVersion":"1.0","id":"builtin.default","version":"1.0.0","name":"SQL Evaluate published defaults","thresholds":{"blocking":{"mediumVictims":2,"highVictims":5,"mediumPersistenceSeconds":15,"highPersistenceSeconds":60,"transientVictimWaitMs":1000},"resources":{"minimumDurationSeconds":30,"lowDurationSeconds":60,"mediumDurationSeconds":300,"highDurationSeconds":900,"mediumPercentile":0.9,"highPercentile":0.95,"lowRepeatedCaptures":3,"mediumConfidenceCaptures":2},"waits":{"actionableDurationMs":1000,"highPersistenceSeconds":60,"corroboratingCaptures":2,"mediumConfidenceObservations":2},"workerExhaustion":{"highCaptures":2,"highConcurrency":2,"highConfidenceCaptures":2},"compilePressure":{"highCaptures":3,"highConcurrency":4,"highConfidenceCaptures":2,"highConfidenceVariants":2},"transactions":{"mediumAgeSeconds":300,"highAgeSeconds":900},"plans":{"mediumEstimateRatio":10,"highEstimateRatio":100,"mediumRows":10000,"highRows":100000,"mediumMissingIndexImpact":70,"mediumGrantWasteKb":131072,"highGrantWasteKb":524288,"mediumGrantRatio":4,"highGrantRatio":8}}}';
    const canonical = canonicalThresholdProfileAudit(DEFAULT_THRESHOLD_PROFILE);
    expect(canonical).toBe(expected);
    expect(await thresholdProfileDigest(DEFAULT_THRESHOLD_PROFILE)).toBe("a4c43e6bcd32c64685a65383015075767590a52170f8de1eb60b8c599b40a41a");
    const changedDescription = { ...editableDefault(), description: "Different local notes" };
    expect(canonicalThresholdProfileAudit(changedDescription)).toBe(canonical);
    expect(await thresholdProfileDigest(changedDescription)).toBe(await thresholdProfileDigest(DEFAULT_THRESHOLD_PROFILE));
    const changedThreshold = editableDefault();
    changedThreshold.thresholds.plans.highGrantRatio = 9;
    expect(await thresholdProfileDigest(changedThreshold)).not.toBe(await thresholdProfileDigest(DEFAULT_THRESHOLD_PROFILE));
  });

  it("creates, validates, and asynchronously verifies report snapshots", async () => {
    const snapshot = await createThresholdProfileSnapshot(DEFAULT_THRESHOLD_PROFILE);
    expect(snapshot).toEqual(DEFAULT_THRESHOLD_PROFILE_SNAPSHOT);
    expect(snapshot).not.toHaveProperty("description");
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(validateThresholdProfileSnapshotShape(snapshot)).toEqual(snapshot);
    await expect(verifyThresholdProfileSnapshot(snapshot)).resolves.toEqual(snapshot);
    await expect(verifyThresholdProfileSnapshot({ ...snapshot, digest: "0".repeat(64) })).rejects.toThrow(/does not match/);
    expect(() => validateThresholdProfileSnapshotShape({ ...snapshot, digest: "ABC" })).toThrow("thresholdProfile.digest");
  });
});
