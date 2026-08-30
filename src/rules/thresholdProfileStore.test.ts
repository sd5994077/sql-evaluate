import { describe, expect, it } from "vitest";
import type { ThresholdProfile } from "../types";
import {
  ACTIVE_THRESHOLD_PROFILE_KEY,
  activateThresholdProfile,
  addThresholdProfile,
  cloneDefaultThresholdProfile,
  deleteThresholdProfile,
  loadThresholdProfileState,
  THRESHOLD_PROFILE_LIBRARY_KEY,
} from "./thresholdProfileStore";
import { DEFAULT_THRESHOLD_PROFILE, DEFAULT_THRESHOLD_PROFILE_SNAPSHOT } from "./thresholdProfiles";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

class ThrowingStorage extends MemoryStorage {
  override getItem(): string | null { throw new Error("storage denied"); }
  override setItem(): void { throw new Error("quota exceeded"); }
}

class FailNextWriteStorage extends MemoryStorage {
  failKey: string | null = null;
  override setItem(key: string, value: string): void {
    if (this.failKey === key) { this.failKey = null; throw new Error("quota exceeded"); }
    super.setItem(key, value);
  }
}

function custom(id = "dba.weekday", name = "DBA weekday"): ThresholdProfile {
  return cloneDefaultThresholdProfile(id, name, "Local-only calibration.");
}

describe("threshold profile local storage", () => {
  it("uses the built-in default for empty or unavailable storage", async () => {
    const empty = await loadThresholdProfileState(new MemoryStorage());
    expect(empty.entries).toHaveLength(1);
    expect(empty.active.builtIn).toBe(true);
    expect(empty.warnings).toEqual([]);

    const unavailable = await loadThresholdProfileState(null);
    expect(unavailable.active.builtIn).toBe(true);
    expect(unavailable.warnings.join(" ")).toMatch(/unavailable/i);
  });

  it("persists a custom profile without activating it, then resolves its exact active reference", async () => {
    const storage = new MemoryStorage();
    const initial = await loadThresholdProfileState(storage);
    const added = await addThresholdProfile(storage, initial.entries, custom());
    expect(added.added).toBe(true);
    expect(added.entry.builtIn).toBe(false);
    expect((await loadThresholdProfileState(storage)).active.builtIn).toBe(true);
    activateThresholdProfile(storage, added.entry);
    const reloaded = await loadThresholdProfileState(storage);
    expect(reloaded.active.snapshot).toEqual(added.entry.snapshot);
    expect(reloaded.warnings).toEqual([]);
  });

  it("falls back without choosing another version when the active reference is unknown", async () => {
    const storage = new MemoryStorage();
    const initial = await loadThresholdProfileState(storage);
    const added = await addThresholdProfile(storage, initial.entries, custom());
    storage.setItem(ACTIVE_THRESHOLD_PROFILE_KEY, JSON.stringify({ schemaVersion: "1.0", id: added.entry.snapshot.id, version: "9.9.9", digest: added.entry.snapshot.digest }));
    const reloaded = await loadThresholdProfileState(storage);
    expect(reloaded.active.builtIn).toBe(true);
    expect(reloaded.warnings.join(" ")).toMatch(/did not resolve exactly/i);
  });

  it("quarantines corrupt libraries, invalid profiles, and conflicting stored identities", async () => {
    const malformed = new MemoryStorage();
    malformed.setItem(THRESHOLD_PROFILE_LIBRARY_KEY, "{bad json");
    expect((await loadThresholdProfileState(malformed)).warnings.join(" ")).toMatch(/could not be loaded/i);

    const storage = new MemoryStorage();
    const first = custom();
    const conflict = structuredClone(first);
    conflict.thresholds.blocking.highVictims = 6;
    storage.setItem(THRESHOLD_PROFILE_LIBRARY_KEY, JSON.stringify({ schemaVersion: "1.0", profiles: [first, { ...first, unexpected: true }, conflict] }));
    const loaded = await loadThresholdProfileState(storage);
    expect(loaded.entries).toHaveLength(2);
    expect(loaded.warnings.join(" ")).toMatch(/quarantined/i);
  });

  it("accepts exact duplicate imports as a no-op and rejects conflicting identities atomically", async () => {
    const storage = new MemoryStorage();
    const initial = await loadThresholdProfileState(storage);
    const first = await addThresholdProfile(storage, initial.entries, custom());
    const duplicate = await addThresholdProfile(storage, first.entries, custom());
    expect(duplicate.added).toBe(false);
    expect(duplicate.entries).toBe(first.entries);
    const before = storage.getItem(THRESHOLD_PROFILE_LIBRARY_KEY);
    const conflict = custom();
    conflict.thresholds.blocking.highVictims = 6;
    await expect(addThresholdProfile(storage, first.entries, conflict)).rejects.toThrow(/different contents/i);
    expect(storage.getItem(THRESHOLD_PROFILE_LIBRARY_KEY)).toBe(before);
  });

  it("rejects reserved IDs and leaves state unchanged when storage writes fail", async () => {
    const storage = new ThrowingStorage();
    await expect(addThresholdProfile(storage, [], DEFAULT_THRESHOLD_PROFILE)).rejects.toThrow(/reserved builtin/i);
    await expect(addThresholdProfile(storage, [], custom())).rejects.toThrow(/quota exceeded/i);
    expect(() => activateThresholdProfile(storage, { profile: DEFAULT_THRESHOLD_PROFILE, snapshot: DEFAULT_THRESHOLD_PROFILE_SNAPSHOT, builtIn: true })).toThrow(/quota exceeded/i);
  });

  it("deletes only custom profiles and falls back explicitly when deleting the active entry", async () => {
    const storage = new MemoryStorage();
    const initial = await loadThresholdProfileState(storage);
    const added = await addThresholdProfile(storage, initial.entries, custom());
    activateThresholdProfile(storage, added.entry);
    const deleted = deleteThresholdProfile(storage, added.entries, added.entry, added.entry);
    expect(deleted.entries).toHaveLength(1);
    expect(deleted.active.builtIn).toBe(true);
    expect((await loadThresholdProfileState(storage)).active.builtIn).toBe(true);
    expect(() => deleteThresholdProfile(storage, deleted.entries, deleted.entries[0], deleted.active)).toThrow(/cannot be deleted/i);
  });

  it("rolls back both local keys when active-profile deletion cannot be persisted", async () => {
    const storage = new FailNextWriteStorage();
    const initial = await loadThresholdProfileState(storage);
    const added = await addThresholdProfile(storage, initial.entries, custom());
    activateThresholdProfile(storage, added.entry);
    storage.failKey = THRESHOLD_PROFILE_LIBRARY_KEY;
    expect(() => deleteThresholdProfile(storage, added.entries, added.entry, added.entry)).toThrow(/quota exceeded/i);
    const reloaded = await loadThresholdProfileState(storage);
    expect(reloaded.entries).toHaveLength(2);
    expect(reloaded.active.snapshot).toEqual(added.entry.snapshot);
  });

  it("stores only profile documents and an exact reference", async () => {
    const storage = new MemoryStorage();
    const initial = await loadThresholdProfileState(storage);
    const added = await addThresholdProfile(storage, initial.entries, custom("dba.private", "Private profile"));
    activateThresholdProfile(storage, added.entry);
    const serialized = [...Array(storage.length)].map((_, index) => storage.getItem(storage.key(index)!)).join(" ");
    expect(serialized).toContain("thresholds");
    expect(serialized).not.toMatch(/sqlText|records|findings|sourceFile|queryPlan|diagnostic/i);
  });
});
