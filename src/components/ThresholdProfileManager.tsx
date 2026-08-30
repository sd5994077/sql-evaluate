import { useRef, useState } from "react";
import type { FormEvent } from "react";
import type { ThresholdProfile, ThresholdProfileSnapshot } from "../types";
import { downloadBlob } from "../lib/report";
import { MAX_THRESHOLD_PROFILE_BYTES, createThresholdProfileSnapshot, validateImportedThresholdProfile } from "../rules/thresholdProfiles";
import { cloneDefaultThresholdProfile } from "../rules/thresholdProfileStore";
import type { ThresholdProfileEntry } from "../rules/thresholdProfileStore";

interface Props {
  entries: ThresholdProfileEntry[];
  active: ThresholdProfileEntry;
  reportProfile?: ThresholdProfileSnapshot;
  ready: boolean;
  warnings: string[];
  onActivate(entry: ThresholdProfileEntry): void;
  onStore(profile: ThresholdProfile): Promise<{ entry: ThresholdProfileEntry; added: boolean }>;
  onDelete(entry: ThresholdProfileEntry): void;
}

function entryKey(entry: ThresholdProfileEntry): string {
  return `${entry.snapshot.id}@${entry.snapshot.version}:${entry.snapshot.digest}`;
}

function profileLabel(profile: ThresholdProfileSnapshot): string {
  return `${profile.name} · ${profile.id}@${profile.version}`;
}

export function ThresholdProfileManager({ entries, active, reportProfile, ready, warnings, onActivate, onStore, onDelete }: Props) {
  const importInput = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<{ profile: ThresholdProfile; snapshot: ThresholdProfileSnapshot } | null>(null);
  const [message, setMessage] = useState("");
  const [cloneId, setCloneId] = useState("");
  const [cloneName, setCloneName] = useState("");

  const importFile = async (file: File | undefined) => {
    if (!file) return;
    setMessage("");
    setPreview(null);
    try {
      if (file.size > MAX_THRESHOLD_PROFILE_BYTES) throw new Error(`Profile files are limited to ${MAX_THRESHOLD_PROFILE_BYTES / 1024} KiB.`);
      const profile = validateImportedThresholdProfile(JSON.parse(await file.text()));
      setPreview({ profile, snapshot: await createThresholdProfileSnapshot(profile) });
    } catch (error) {
      setMessage(`Profile import failed: ${error instanceof Error ? error.message : "Invalid profile file."}`);
    }
  };

  const storePreview = async () => {
    if (!preview) return;
    try {
      const result = await onStore(preview.profile);
      setMessage(result.added ? `Stored ${profileLabel(result.entry.snapshot)}. It was not activated.` : `${profileLabel(result.entry.snapshot)} is already stored; no changes were made.`);
      setPreview(null);
    } catch (error) {
      setMessage(`Profile was not stored: ${error instanceof Error ? error.message : "Local storage failed."}`);
    }
  };

  const cloneDefault = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const result = await onStore(cloneDefaultThresholdProfile(cloneId, cloneName, "Cloned from the built-in published defaults."));
      setMessage(result.added ? `Stored ${profileLabel(result.entry.snapshot)}. It was not activated.` : `${profileLabel(result.entry.snapshot)} already exists.`);
      if (result.added) { setCloneId(""); setCloneName(""); }
    } catch (error) {
      setMessage(`Profile clone failed: ${error instanceof Error ? error.message : "Invalid profile metadata."}`);
    }
  };

  const reportMatches = reportProfile && reportProfile.id === active.snapshot.id && reportProfile.version === active.snapshot.version && reportProfile.digest === active.snapshot.digest;

  return <section className="profile-manager" aria-labelledby="threshold-profile-title">
    <div className="profile-summary">
      <div><span id="threshold-profile-title">THRESHOLD PROFILE / NEXT ANALYSIS</span><strong>{ready ? active.profile.name : "Loading local profiles…"}</strong><small>{active.snapshot.id}@{active.snapshot.version} · {active.builtIn ? "Built-in" : "Custom"} · {active.snapshot.digest.slice(0, 12)}</small></div>
      <label>Active profile<select disabled={!ready} value={entryKey(active)} onChange={(event) => { const entry = entries.find((candidate) => entryKey(candidate) === event.target.value); if (entry) onActivate(entry); }}>{entries.map((entry) => <option key={entryKey(entry)} value={entryKey(entry)}>{entry.profile.name} ({entry.profile.version})</option>)}</select></label>
      <div className="profile-actions"><button type="button" className="button" disabled={!ready} onClick={() => importInput.current?.click()}>Import profile</button><button type="button" className="button" disabled={!ready} onClick={() => downloadBlob(`${active.snapshot.id}-${active.snapshot.version}.threshold-profile.json`, JSON.stringify(active.profile, null, 2), "application/json")}>Export active</button>{!active.builtIn && <button type="button" className="button profile-delete" onClick={() => onDelete(active)}>Delete active</button>}</div>
      <input ref={importInput} hidden type="file" accept=".json,application/json" onChange={(event) => { void importFile(event.target.files?.[0]); event.target.value = ""; }} />
    </div>
    <div className="profile-audit">
      <details><summary>View exact active thresholds</summary><pre>{JSON.stringify(active.profile, null, 2)}</pre></details>
      <details><summary>Clone published defaults</summary><form onSubmit={(event) => { void cloneDefault(event); }}><label>Profile ID<input required placeholder="dba.weekday" value={cloneId} onChange={(event) => setCloneId(event.target.value)} /></label><label>Profile name<input required placeholder="DBA weekday" value={cloneName} onChange={(event) => setCloneName(event.target.value)} /></label><button className="button" type="submit">Store clone</button></form></details>
    </div>
    <p className="profile-disclosure">Profile names appear in reports and default exports. Do not include sensitive system, customer, or incident information.</p>
    {reportProfile ? <p className={reportMatches ? "profile-status" : "profile-status profile-status-warning"}>Current report: {profileLabel(reportProfile)} · {reportProfile.digest.slice(0, 12)}{reportMatches ? " · matches the next-analysis profile" : " · differs from the next-analysis profile"}</p> : null}
    {preview && <div className="profile-preview" role="status"><div><span>IMPORT PREVIEW / NOT ACTIVE</span><strong>{profileLabel(preview.snapshot)}</strong><small>Digest {preview.snapshot.digest}</small></div><button type="button" className="button button-save" onClick={() => { void storePreview(); }}>Store profile</button><button type="button" className="button" onClick={() => setPreview(null)}>Cancel</button></div>}
    <div aria-live="polite">{[...warnings, ...(message ? [message] : [])].map((warning, index) => <p className="profile-message" key={`${index}:${warning}`}>{warning}</p>)}</div>
  </section>;
}
