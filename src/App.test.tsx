// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalysisReport, Finding, WhoIsActiveRecord } from "./types";
import App from "./App";
import { cloneDefaultThresholdProfile } from "./rules/thresholdProfileStore";
import { DEFAULT_THRESHOLD_PROFILE_SNAPSHOT } from "./rules/thresholdProfiles";

Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: () => undefined });

class TestStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

beforeEach(() => Object.defineProperty(window, "localStorage", { configurable: true, value: new TestStorage() }));

afterEach(() => {
  cleanup();
  try { window.localStorage.clear(); } catch { /* storage-unavailable behavior is tested separately */ }
  vi.unstubAllGlobals();
});

function record(id: string, sessionId: number): WhoIsActiveRecord {
  return {
    id, sourceId: "saved", rowNumber: sessionId, sessionId, requestId: 0,
    collectionTime: "2026-08-29T12:00:00Z", startTime: null, loginTime: null,
    durationSeconds: null, wait: null, status: "running", blockingSessionId: null,
    blockedSessionCount: null, openTranCount: null, implicitTran: null, cpuMs: null,
    reads: null, writes: null, physicalReads: null, usedMemoryPages: null,
    tempdbAllocationPages: null, tempdbCurrentPages: null, sqlText: null,
    sqlCommand: null, queryPlanXml: null, databaseName: null, loginName: null,
    hostName: null, programName: null, original: { session_id: sessionId },
  };
}

function finding(affectedRecordIds: string[]): Finding {
  return {
    id: "finding-affected", ruleId: "TEST-AFFECTED", severity: "Medium", confidence: "High",
    category: "Test", title: "Affected activity finding", summary: "Links to captured activity.",
    explanation: "Test finding.", remediation: [], evidence: [], references: [],
    affectedRecordIds, affectedPlanIds: [], impact: 1,
  };
}

function report(name: string, records: WhoIsActiveRecord[], findings: Finding[]): AnalysisReport {
  return {
    schemaVersion: "1.0", createdAt: "2026-08-29T12:00:00Z", redacted: false,
    inputs: [{ id: "saved", fileName: name, size: 1, format: "report", rowCount: records.length, recognizedColumns: ["session_id"], unknownColumns: [], warnings: [] }],
    records, plans: [], findings,
    dataQuality: { presentColumns: ["session_id"], missingColumns: [], unknownColumns: [], warnings: [], notEvaluatedRules: [] },
  };
}

async function uploadSavedReport(container: HTMLElement, value: AnalysisReport, fileName: string): Promise<void> {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error("File input was not rendered.");
  const file = new File([JSON.stringify(value)], fileName, { type: "application/json" });
  fireEvent.change(input, { target: { files: [file] } });
  await waitFor(() => expect(screen.getByText(value.inputs[0].fileName)).toBeTruthy());
}

async function storeClone(id: string, name: string): Promise<void> {
  fireEvent.change(screen.getByLabelText("Profile ID"), { target: { value: id } });
  fireEvent.change(screen.getByLabelText("Profile name"), { target: { value: name } });
  fireEvent.click(screen.getByRole("button", { name: "Store clone" }));
  await waitFor(() => expect(screen.getByText(new RegExp(`Stored ${name}`))).toBeTruthy());
}

describe("analysis navigation", () => {
  it("warns that profile names are disclosed in default exports", async () => {
    render(<App />);
    expect(await screen.findByText(/profile names appear in reports and default exports/i)).toBeTruthy();
    expect(screen.getByText(/do not include sensitive system, customer, or incident information/i)).toBeTruthy();
  });

  it("keeps every tab's controlled panel addressable and supports keyboard navigation", async () => {
    const { container } = render(<App />);
    await uploadSavedReport(container, report("first.csv", [record("r1", 51)], []), "first.sqleval.json");

    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(5);
    for (const tab of tabs) {
      const panelId = tab.getAttribute("aria-controls");
      expect(panelId).toBeTruthy();
      expect(document.getElementById(panelId!)).not.toBeNull();
    }

    const findingsTab = screen.getByRole("tab", { name: /findings/i });
    const deepTab = screen.getByRole("tab", { name: /deep analysis/i });
    findingsTab.focus();
    fireEvent.keyDown(findingsTab, { key: "ArrowRight" });
    await waitFor(() => expect(deepTab.getAttribute("aria-selected")).toBe("true"));
    await waitFor(() => expect(document.activeElement).toBe(deepTab));
  });

  it("clears affected-record state when a new saved report is loaded", async () => {
    const { container } = render(<App />);
    await uploadSavedReport(container, report("first.csv", [record("r1", 51), record("r2", 52)], [finding(["r2"])]), "first.sqleval.json");

    fireEvent.click(screen.getByText("Affected activity finding").closest("button")!);
    fireEvent.click(screen.getByRole("button", { name: /show 1 affected activity row/i }));
    expect(screen.getByText("1 affected row")).toBeTruthy();

    await uploadSavedReport(container, report("second.csv", [record("r3", 88)], []), "second.sqleval.json");
    fireEvent.click(screen.getByRole("tab", { name: /activity/i }));
    expect(screen.getByText("1 normalized row")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /clear affected-row filter/i })).toBeNull();
  });

  it("uses singular grammar for one priority finding", async () => {
    const { container } = render(<App />);
    const critical = { ...finding(["r1"]), id: "finding-critical", severity: "Critical" as const };
    await uploadSavedReport(container, report("critical.csv", [record("r1", 51)], [critical]), "critical.sqleval.json");

    expect(screen.getByText("1 item needs priority review")).toBeTruthy();
  });

  it("previews and stores an imported profile without activating it", async () => {
    const { container } = render(<App />);
    await waitFor(() => expect((screen.getByLabelText("Active profile") as HTMLSelectElement).disabled).toBe(false));
    const profile = cloneDefaultThresholdProfile("dba.imported", "Imported DBA profile", "Import preview test.");
    const input = container.querySelector<HTMLInputElement>('input[accept*="application/json"]')!;
    fireEvent.change(input, { target: { files: [new File([JSON.stringify(profile)], "profile.json", { type: "application/json" })] } });
    await waitFor(() => expect(screen.getByText("IMPORT PREVIEW / NOT ACTIVE")).toBeTruthy());
    expect((screen.getByLabelText("Active profile") as HTMLSelectElement).selectedOptions[0].textContent).toMatch(/published defaults/i);
    fireEvent.click(screen.getByRole("button", { name: "Store profile" }));
    await waitFor(() => expect(screen.getByText(/Stored Imported DBA profile/)).toBeTruthy());
    expect((screen.getByLabelText("Active profile") as HTMLSelectElement).selectedOptions[0].textContent).toMatch(/published defaults/i);
    expect(window.localStorage.getItem("sql-evaluate.threshold-profiles.v1")).not.toMatch(/records|findings|sql_text/i);
  });

  it("rejects an oversized profile before presenting an import preview", async () => {
    const { container } = render(<App />);
    await waitFor(() => expect((screen.getByLabelText("Active profile") as HTMLSelectElement).disabled).toBe(false));
    const input = container.querySelector<HTMLInputElement>('input[accept*="application/json"]')!;
    fireEvent.change(input, { target: { files: [new File(["x".repeat(65_537)], "oversized.json", { type: "application/json" })] } });
    await waitFor(() => expect(screen.getByText(/Profile files are limited to 64 KiB/i)).toBeTruthy());
    expect(screen.queryByText("IMPORT PREVIEW / NOT ACTIVE")).toBeNull();
    expect(window.localStorage.getItem("sql-evaluate.threshold-profiles.v1")).toBeNull();
  });

  it("keeps a displayed legacy report immutable when the next-analysis profile changes", async () => {
    const { container } = render(<App />);
    await waitFor(() => expect((screen.getByLabelText("Active profile") as HTMLSelectElement).disabled).toBe(false));
    await uploadSavedReport(container, report("historical.csv", [record("r1", 51)], []), "historical.sqleval.json");
    expect(screen.getByText(/Legacy report · threshold profile not recorded/i)).toBeTruthy();
    await storeClone("dba.next", "DBA next analysis");
    const select = screen.getByLabelText("Active profile") as HTMLSelectElement;
    const customOption = [...select.options].find((option) => option.textContent?.includes("DBA next analysis"))!;
    fireEvent.change(select, { target: { value: customOption.value } });
    expect(select.selectedOptions[0].textContent).toContain("DBA next analysis");
    expect(screen.getByText(/Legacy report · threshold profile not recorded/i)).toBeTruthy();
    expect(screen.getByText("historical.csv")).toBeTruthy();
  });

  it("verifies an imported report profile before displaying the report", async () => {
    const { container } = render(<App />);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const tampered = { ...report("tampered.csv", [record("r1", 51)], []), thresholdProfile: { ...DEFAULT_THRESHOLD_PROFILE_SNAPSHOT, name: "Tampered profile" } };
    fireEvent.change(input, { target: { files: [new File([JSON.stringify(tampered)], "tampered.sqleval.json", { type: "application/json" })] } });
    await waitFor(() => expect(screen.getByText(/threshold profile verification failed/i)).toBeTruthy());
    expect(screen.queryByText("tampered.csv")).toBeNull();
  });

  it("shows exact report thresholds in the data-quality audit view", async () => {
    const { container } = render(<App />);
    await uploadSavedReport(container, { ...report("profiled.csv", [record("r1", 51)], []), thresholdProfile: DEFAULT_THRESHOLD_PROFILE_SNAPSHOT }, "profiled.sqleval.json");
    fireEvent.click(screen.getByRole("tab", { name: /data quality/i }));
    expect(screen.getByText("THRESHOLD PROFILE / THIS REPORT")).toBeTruthy();
    expect(screen.getAllByText(`${DEFAULT_THRESHOLD_PROFILE_SNAPSHOT.id}@${DEFAULT_THRESHOLD_PROFILE_SNAPSHOT.version}`, { exact: false }).length).toBeGreaterThan(0);
    expect(screen.getByText(DEFAULT_THRESHOLD_PROFILE_SNAPSHOT.digest)).toBeTruthy();
  });

  it("sends the selected exact profile snapshot to the next analysis worker", async () => {
    let posted: unknown;
    class FakeWorker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      onmessageerror: (() => void) | null = null;
      postMessage(value: unknown) { posted = value; }
      terminate() { /* no-op */ }
    }
    vi.stubGlobal("Worker", FakeWorker);
    const { container } = render(<App />);
    await waitFor(() => expect((screen.getByLabelText("Active profile") as HTMLSelectElement).disabled).toBe(false));
    await storeClone("dba.worker", "DBA worker profile");
    const select = screen.getByLabelText("Active profile") as HTMLSelectElement;
    const customOption = [...select.options].find((option) => option.textContent?.includes("DBA worker profile"))!;
    fireEvent.change(select, { target: { value: customOption.value } });
    const captureInput = container.querySelector<HTMLInputElement>('input[type="file"][multiple]')!;
    fireEvent.change(captureInput, { target: { files: [new File(["session_id\n51\n"], "capture.csv", { type: "text/csv" })] } });
    await waitFor(() => expect(posted).toBeTruthy());
    expect((posted as { thresholdProfile: { id: string; digest: string } }).thresholdProfile).toMatchObject({ id: "dba.worker", digest: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });
});
