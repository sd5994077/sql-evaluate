import type { ThresholdProfile, ThresholdProfileSnapshot } from "../types";
import {
  createThresholdProfileSnapshot,
  DEFAULT_THRESHOLD_PROFILE,
  DEFAULT_THRESHOLD_PROFILE_SNAPSHOT,
  validateImportedThresholdProfile,
} from "./thresholdProfiles";

export const THRESHOLD_PROFILE_LIBRARY_KEY = "sql-evaluate.threshold-profiles.v1";
export const ACTIVE_THRESHOLD_PROFILE_KEY = "sql-evaluate.active-threshold-profile.v1";

export interface ThresholdProfileEntry {
  profile: ThresholdProfile;
  snapshot: ThresholdProfileSnapshot;
  builtIn: boolean;
}

export interface ThresholdProfileState {
  entries: ThresholdProfileEntry[];
  active: ThresholdProfileEntry;
  warnings: string[];
}

interface ActiveReference {
  schemaVersion: "1.0";
  id: string;
  version: string;
  digest: string;
}

export const DEFAULT_THRESHOLD_PROFILE_ENTRY: ThresholdProfileEntry = Object.freeze({ profile: DEFAULT_THRESHOLD_PROFILE, snapshot: DEFAULT_THRESHOLD_PROFILE_SNAPSHOT, builtIn: true });

function defaultEntry(): ThresholdProfileEntry { return DEFAULT_THRESHOLD_PROFILE_ENTRY; }

function storageRequired(storage: Storage | null): Storage {
  if (!storage) throw new Error("Local profile storage is unavailable. The built-in default remains active.");
  return storage;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key)) && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function parseLibrary(raw: string): unknown[] {
  const value: unknown = JSON.parse(raw);
  if (!plainObject(value) || !exactKeys(value, ["schemaVersion", "profiles"]) || value.schemaVersion !== "1.0" || !Array.isArray(value.profiles)) {
    throw new Error("the stored profile library has an unsupported shape");
  }
  return value.profiles;
}

function parseActiveReference(raw: string): ActiveReference {
  const value: unknown = JSON.parse(raw);
  if (!plainObject(value) || !exactKeys(value, ["schemaVersion", "id", "version", "digest"]) || value.schemaVersion !== "1.0"
    || typeof value.id !== "string" || typeof value.version !== "string" || typeof value.digest !== "string") {
    throw new Error("the active profile reference has an unsupported shape");
  }
  return value as unknown as ActiveReference;
}

function sameIdentity(left: ThresholdProfileSnapshot, right: ThresholdProfileSnapshot): boolean {
  return left.id === right.id && left.version === right.version;
}

function reference(snapshot: ThresholdProfileSnapshot): ActiveReference {
  return { schemaVersion: "1.0", id: snapshot.id, version: snapshot.version, digest: snapshot.digest };
}

export async function loadThresholdProfileState(storage: Storage | null): Promise<ThresholdProfileState> {
  const fallback = defaultEntry();
  if (!storage) return { entries: [fallback], active: fallback, warnings: ["Local profile storage is unavailable; the built-in default is active for this session."] };

  const warnings: string[] = [];
  const customEntries: ThresholdProfileEntry[] = [];
  try {
    const raw = storage.getItem(THRESHOLD_PROFILE_LIBRARY_KEY);
    if (raw) {
      for (const candidate of parseLibrary(raw)) {
        try {
          const profile = validateImportedThresholdProfile(candidate);
          const snapshot = await createThresholdProfileSnapshot(profile);
          const existing = customEntries.find((entry) => sameIdentity(entry.snapshot, snapshot));
          if (existing) {
            warnings.push(existing.snapshot.digest === snapshot.digest
              ? `Duplicate stored profile ${snapshot.id}@${snapshot.version} was ignored.`
              : `Conflicting stored profile ${snapshot.id}@${snapshot.version} was quarantined.`);
            continue;
          }
          customEntries.push({ profile, snapshot, builtIn: false });
        } catch (error) {
          warnings.push(`A stored threshold profile was quarantined: ${error instanceof Error ? error.message : "invalid profile"}`);
        }
      }
    }
  } catch (error) {
    warnings.push(`The local threshold-profile library could not be loaded; the built-in default is active. ${error instanceof Error ? error.message : "Invalid local data."}`);
  }

  const entries = [fallback, ...customEntries.sort((left, right) => left.profile.name.localeCompare(right.profile.name) || left.profile.version.localeCompare(right.profile.version))];
  let active = fallback;
  try {
    const raw = storage.getItem(ACTIVE_THRESHOLD_PROFILE_KEY);
    if (raw) {
      const selected = parseActiveReference(raw);
      const resolved = entries.find((entry) => entry.snapshot.id === selected.id && entry.snapshot.version === selected.version && entry.snapshot.digest === selected.digest);
      if (resolved) active = resolved;
      else warnings.push(`The saved active profile ${selected.id}@${selected.version} did not resolve exactly; the built-in default is active.`);
    }
  } catch (error) {
    warnings.push(`The saved active profile reference was ignored; the built-in default is active. ${error instanceof Error ? error.message : "Invalid local data."}`);
  }
  return { entries, active, warnings };
}

function persistLibrary(storage: Storage | null, entries: ThresholdProfileEntry[]): void {
  const target = storageRequired(storage);
  const profiles = entries.filter((entry) => !entry.builtIn).map((entry) => entry.profile);
  target.setItem(THRESHOLD_PROFILE_LIBRARY_KEY, JSON.stringify({ schemaVersion: "1.0", profiles }));
}

function restoreItem(storage: Storage, key: string, value: string | null): void {
  if (value === null) storage.removeItem(key);
  else storage.setItem(key, value);
}

export async function addThresholdProfile(storage: Storage | null, entries: ThresholdProfileEntry[], value: unknown): Promise<{ entries: ThresholdProfileEntry[]; entry: ThresholdProfileEntry; added: boolean }> {
  const profile = validateImportedThresholdProfile(value);
  const snapshot = await createThresholdProfileSnapshot(profile);
  const existing = entries.find((entry) => sameIdentity(entry.snapshot, snapshot));
  if (existing) {
    if (existing.snapshot.digest !== snapshot.digest) throw new Error(`Profile ${snapshot.id}@${snapshot.version} already exists with different contents. Use a new version.`);
    return { entries, entry: existing, added: false };
  }
  const entry = { profile, snapshot, builtIn: false } satisfies ThresholdProfileEntry;
  const next = [...entries, entry];
  persistLibrary(storage, next);
  return { entries: next, entry, added: true };
}

export function activateThresholdProfile(storage: Storage | null, entry: ThresholdProfileEntry): void {
  storageRequired(storage).setItem(ACTIVE_THRESHOLD_PROFILE_KEY, JSON.stringify(reference(entry.snapshot)));
}

export function deleteThresholdProfile(storage: Storage | null, entries: ThresholdProfileEntry[], entry: ThresholdProfileEntry, active: ThresholdProfileEntry): { entries: ThresholdProfileEntry[]; active: ThresholdProfileEntry } {
  if (entry.builtIn) throw new Error("Built-in threshold profiles cannot be deleted.");
  const target = storageRequired(storage);
  const nextEntries = entries.filter((candidate) => candidate.snapshot.digest !== entry.snapshot.digest || !sameIdentity(candidate.snapshot, entry.snapshot));
  const nextActive = sameIdentity(active.snapshot, entry.snapshot) && active.snapshot.digest === entry.snapshot.digest ? defaultEntry() : active;
  const previousLibrary = target.getItem(THRESHOLD_PROFILE_LIBRARY_KEY);
  const previousActive = target.getItem(ACTIVE_THRESHOLD_PROFILE_KEY);
  try {
    if (nextActive.builtIn && !active.builtIn) activateThresholdProfile(target, nextActive);
    persistLibrary(target, nextEntries);
  } catch (error) {
    try {
      restoreItem(target, THRESHOLD_PROFILE_LIBRARY_KEY, previousLibrary);
      restoreItem(target, ACTIVE_THRESHOLD_PROFILE_KEY, previousActive);
    } catch { /* best-effort rollback; startup validation still fails safe */ }
    throw error;
  }
  return { entries: nextEntries, active: nextActive };
}

export function cloneDefaultThresholdProfile(id: string, name: string, description = ""): ThresholdProfile {
  return validateImportedThresholdProfile({
    ...structuredClone(DEFAULT_THRESHOLD_PROFILE),
    id,
    name,
    description,
    version: "1.0.0",
  });
}
