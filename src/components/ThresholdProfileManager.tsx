import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { ThresholdProfile, ThresholdProfileSnapshot } from "../types";
import { downloadBlob } from "../lib/report";
import { isBuiltInThresholdProfileId, MAX_THRESHOLD_PROFILE_BYTES, createThresholdProfileSnapshot, validateImportedThresholdProfile, validateThresholdProfile } from "../rules/thresholdProfiles";
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

type ProfileImportMessage = { severity: "info" | "success" | "error"; title: string; detail: string };

export function ThresholdProfileManager({ entries, active, reportProfile, ready, warnings, onActivate, onStore, onDelete }: Props) {
  const importInput = useRef<HTMLInputElement>(null);
  const previewNotice = useRef<HTMLDivElement>(null);
  const importMessageNotice = useRef<HTMLDivElement>(null);
  const hasRenderedImportNotice = useRef(false);
  const [preview, setPreview] = useState<{ profile: ThresholdProfile; snapshot: ThresholdProfileSnapshot } | null>(null);
  const [message, setMessage] = useState<ProfileImportMessage | null>(null);
  const [cloneId, setCloneId] = useState("");
  const [cloneName, setCloneName] = useState("");

  const importFile = async (file: File | undefined) => {
    if (!file) return;
    setMessage(null);
    setPreview(null);
    try {
      if (file.size > MAX_THRESHOLD_PROFILE_BYTES) throw new Error(`Profile files are limited to ${MAX_THRESHOLD_PROFILE_BYTES / 1024} KiB.`);
      const candidate = validateThresholdProfile(JSON.parse(await file.text()));
      const snapshot = await createThresholdProfileSnapshot(candidate);
      if (isBuiltInThresholdProfileId(candidate.id)) {
        const bundled = entries.find((entry) => entry.builtIn && entry.snapshot.id === snapshot.id && entry.snapshot.version === snapshot.version && entry.snapshot.digest === snapshot.digest);
        if (bundled) {
          setMessage({ severity: "info", title: "Profile already available", detail: `${profileLabel(bundled.snapshot)} is the built-in profile already available in this installation. No import is needed.` });
          return;
        }
        throw new Error("This file uses the reserved builtin namespace but does not exactly match the installed built-in profile. It cannot replace bundled defaults.");
      }
      const existing = entries.find((entry) => entry.snapshot.id === snapshot.id && entry.snapshot.version === snapshot.version);
      if (existing) {
        if (existing.snapshot.digest === snapshot.digest) {
          setMessage({ severity: "info", title: "Profile already stored", detail: `${profileLabel(existing.snapshot)} is already in this browser. No import is needed.` });
          return;
        }
        throw new Error(`Profile ${snapshot.id}@${snapshot.version} is already stored with different contents. Increase its version before importing.`);
      }
      setPreview({ profile: validateImportedThresholdProfile(candidate), snapshot });
    } catch (error) {
      setMessage({ severity: "error", title: "Profile import failed", detail: error instanceof Error ? error.message : "Invalid profile file." });
    }
  };

  const storePreview = async () => {
    if (!preview) return;
    try {
      const result = await onStore(preview.profile);
      setMessage(result.added
        ? { severity: "success", title: "Profile stored", detail: `${profileLabel(result.entry.snapshot)} was saved in this browser. It was not activated; choose it from Active profile when you are ready.` }
        : { severity: "info", title: "Profile already stored", detail: `${profileLabel(result.entry.snapshot)} is already in this browser. No changes were made.` });
      setPreview(null);
    } catch (error) {
      setMessage({ severity: "error", title: "Profile was not stored", detail: error instanceof Error ? error.message : "Local storage failed." });
    }
  };

  const cloneDefault = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const result = await onStore(cloneDefaultThresholdProfile(cloneId, cloneName, "Cloned from the built-in published defaults."));
      setMessage(result.added
        ? { severity: "success", title: "Profile stored", detail: `${profileLabel(result.entry.snapshot)} was saved in this browser. It was not activated; choose it from Active profile when you are ready.` }
        : { severity: "info", title: "Profile already stored", detail: `${profileLabel(result.entry.snapshot)} is already in this browser. No changes were made.` });
      if (result.added) { setCloneId(""); setCloneName(""); }
    } catch (error) {
      setMessage({ severity: "error", title: "Profile clone failed", detail: error instanceof Error ? error.message : "Invalid profile metadata." });
    }
  };

  const reportMatches = reportProfile && reportProfile.id === active.snapshot.id && reportProfile.version === active.snapshot.version && reportProfile.digest === active.snapshot.digest;

  useEffect(() => {
    if (hasRenderedImportNotice.current) (preview ? previewNotice.current : message ? importMessageNotice.current : null)?.focus();
    hasRenderedImportNotice.current = true;
  }, [message, preview]);

  return <section className="profile-manager" aria-labelledby="threshold-profile-title">
    <div className="profile-summary">
      <div><span id="threshold-profile-title">THRESHOLD PROFILE / NEXT ANALYSIS</span><strong>{ready ? active.profile.name : "Loading local profiles…"}</strong><small>{active.snapshot.id}@{active.snapshot.version} · {active.builtIn ? "Built-in" : "Custom"} · {active.snapshot.digest.slice(0, 12)}</small></div>
      <label>Active profile<select disabled={!ready} value={entryKey(active)} onChange={(event) => { const entry = entries.find((candidate) => entryKey(candidate) === event.target.value); if (entry) onActivate(entry); }}>{entries.map((entry) => <option key={entryKey(entry)} value={entryKey(entry)}>{entry.profile.name} ({entry.profile.version})</option>)}</select></label>
      <div className="profile-actions"><button type="button" className="button" disabled={!ready} onClick={() => importInput.current?.click()}>Import profile</button><button type="button" className="button" disabled={!ready} onClick={() => downloadBlob(`${active.snapshot.id}-${active.snapshot.version}.threshold-profile.json`, JSON.stringify(active.profile, null, 2), "application/json")}>Export active</button>{!active.builtIn && <button type="button" className="button profile-delete" onClick={() => onDelete(active)}>Delete active</button>}</div>
      <input ref={importInput} hidden type="file" accept=".json,application/json" onChange={(event) => { void importFile(event.target.files?.[0]); event.target.value = ""; }} />
    </div>
    {preview && <div ref={previewNotice} tabIndex={-1} className="profile-preview" role="status" aria-label={`Profile ready to store: ${preview.snapshot.name}`}><div><span>IMPORT PREVIEW / NOT ACTIVE</span><strong>{profileLabel(preview.snapshot)}</strong><small>Digest {preview.snapshot.digest}. Review, then store this profile locally; it will not become active automatically.</small></div><button type="button" className="button button-save" onClick={() => { void storePreview(); }}>Store profile</button><button type="button" className="button" onClick={() => setPreview(null)}>Cancel</button></div>}
    {message && <div ref={importMessageNotice} tabIndex={-1} className={`profile-import-result profile-import-result-${message.severity}`} role={message.severity === "error" ? "alert" : "status"} aria-label={`${message.severity === "error" ? "Error" : message.severity === "success" ? "Success" : "Information"}: ${message.title}`}><strong>{message.title}</strong><p>{message.detail}</p></div>}
    <div className="profile-audit">
      <details><summary>View exact active thresholds</summary><pre>{JSON.stringify(active.profile, null, 2)}</pre></details>
      <details><summary>Clone published defaults</summary><form onSubmit={(event) => { void cloneDefault(event); }}><label>Profile ID<input required placeholder="dba.weekday" value={cloneId} onChange={(event) => setCloneId(event.target.value)} /></label><label>Profile name<input required placeholder="DBA weekday" value={cloneName} onChange={(event) => setCloneName(event.target.value)} /></label><button className="button" type="submit">Store clone</button></form></details>
    </div>
    <p className="profile-disclosure">Profile names appear in reports and default exports. Do not include sensitive system, customer, or incident information.</p>
    {reportProfile ? <p className={reportMatches ? "profile-status" : "profile-status profile-status-warning"}>Current report: {profileLabel(reportProfile)} · {reportProfile.digest.slice(0, 12)}{reportMatches ? " · matches the next-analysis profile" : " · differs from the next-analysis profile"}</p> : null}
    <div aria-live="polite">{warnings.map((warning, index) => <p className="profile-message" key={`${index}:${warning}`}>{warning}</p>)}</div>
  </section>;
}
