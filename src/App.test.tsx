// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  await waitFor(() => expect(screen.getByRole("status", { name: /success: profile stored/i })).toBeTruthy());
}

describe("analysis navigation", () => {
  it("starts a manual Spill Triage case from the landing page", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Start Spill Triage" }));
    expect(await screen.findByRole("heading", { name: "Spill Triage" })).toBeTruthy();
    expect(screen.getByText(/stage 1 \/ candidate selection/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Import BlitzCache export" })).toBeTruthy();
    expect(document.querySelector('[data-testid="spill-triage-evidence-input"]')).toBeInstanceOf(HTMLInputElement);
    expect(screen.getByRole("button", { name: "JSON" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "CSV" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Print HTML" })).toBeTruthy();
    expect(screen.getByText(/not reopenable/i)).toBeTruthy();
  });

  it("shows a rejected Showplan beside the Spill Triage matching-plan action", async () => {
    const { container } = render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Start Spill Triage" }));
    const evidenceInput = container.querySelector<HTMLInputElement>('[data-testid="spill-triage-evidence-input"]')!;
    fireEvent.change(evidenceInput, { target: { files: [new File(["Total Spills,Plan Handle\n100,0xAAA\n"], "blitz-spills.csv", { type: "text/csv" })] } });
    await waitFor(() => expect((screen.getByRole("button", { name: "Import selected evidence" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Import selected evidence" }));
    expect(await screen.findByRole("button", { name: "Choose matching plan" })).toBeTruthy();

    fireEvent.change(evidenceInput, { target: { files: [new File(["not a Showplan"], "blitzcache-plan.sqlplan", { type: "application/xml" })] } });

    await waitFor(() => expect((screen.getByRole("button", { name: "Import selected evidence" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Import selected evidence" }));
    const error = await screen.findByRole("alert", { name: /error: plan import failed/i });
    expect(within(error).getByText(/blitzcache-plan\.sqlplan/i)).toBeTruthy();
  });

  it("shows non-plan import errors inside the Spill Triage workspace", async () => {
    const { container } = render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Start Spill Triage" }));
    const evidenceInput = container.querySelector<HTMLInputElement>('[data-testid="spill-triage-evidence-input"]')!;

    fireEvent.change(evidenceInput, { target: { files: [new File([], "empty-blitzcache.csv", { type: "text/csv" })] } });

    const error = await screen.findByRole("dialog", { name: "Review imported files" });
    await within(error).findByText(/file is empty and was not imported/i);
    expect(within(error).getByText(/empty-blitzcache\.csv/i)).toBeTruthy();
    expect(within(error).getByText(/file is empty and was not imported/i)).toBeTruthy();
  });

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

  it("derives a progressive guide for an older report and opens its source evidence", async () => {
    const { container } = render(<App />);
    const resource = { ...finding(["r1"]), id: "resource-finding", ruleId: "WIA-RESOURCE", severity: "High" as const, title: "Sustained resource consumer", nextCapture: { title: "Capture resource deltas", reason: "Confirm measured growth.", command: "EXEC dbo.sp_WhoIsActive @delta_interval = 5;", expectedEvidence: ["CPU and I/O rates"], caution: "Capture briefly." } };
    const transaction = { ...finding(["r1"]), id: "transaction-finding", ruleId: "WIA-TRANSACTION", title: "Open-transaction activity", nextCapture: { title: "Capture transaction ownership", reason: "Confirm ownership.", expectedEvidence: ["Transaction start"] } };
    await uploadSavedReport(container, report("guided.csv", [record("r1", 51)], [resource, transaction]), "guided.sqleval.json");

    expect(screen.getByRole("heading", { name: "Start here" })).toBeTruthy();
    expect(screen.getByText("Capture short resource deltas and the execution plan")).toBeTruthy();
    const followups = screen.getByText(/Show 1 follow-up step/i).closest("details")!;
    expect(followups.hasAttribute("open")).toBe(false);
    fireEvent.click(followups.querySelector("summary")!);
    expect(followups.hasAttribute("open")).toBe(true);
    fireEvent.click(screen.getAllByRole("button", { name: "Open evidence" })[0]);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Sustained resource consumer" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Back to investigation step 1/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement?.id).toBe("investigation-guide");
  });

  it("labels an unsupported imported Deep Analysis profile without exposing a dead action", async () => {
    const { container } = render(<App />);
    const resource = { ...finding(["r1"]), id: "resource-finding", ruleId: "WIA-RESOURCE", severity: "High" as const, title: "Sustained resource consumer" };
    const guided: AnalysisReport = {
      ...report("future-guide.csv", [record("r1", 51)], [resource]),
      investigationGuide: {
        schemaVersion: "1.0",
        conclusion: "Review imported guidance.",
        missingEvidence: [],
        subjects: [],
        steps: [{ id: "guide-step-1", order: 1, title: "Future workflow", reason: "This report references a newer workflow.", actionType: "Deep Analysis", expectedEvidence: [], sourceFindingIds: [resource.id], targetFindingId: resource.id, deepAnalysisProfile: "future-profile" }],
      },
    };
    await uploadSavedReport(container, guided, "future-guide.sqleval.json");

    const guide = screen.getByRole("heading", { name: "Start here" }).closest("section")!;
    expect(within(guide).getByText("Deep Analysis unavailable")).toBeTruthy();
    expect(within(guide).getByText(/not available in this app version/i)).toBeTruthy();
    expect(within(guide).queryByRole("button", { name: "Deep Analysis" })).toBeNull();
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
    await waitFor(() => expect(screen.getByRole("status", { name: /success: profile stored/i })).toBeTruthy());
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

  it("discloses the worksheet selected from a workbook in Data Quality", async () => {
    const { container } = render(<App />);
    const workbookReport = report("workbook.xlsx", [record("r1", 51)], []);
    workbookReport.inputs[0].sheetName = "Live Capture";
    await uploadSavedReport(container, workbookReport, "workbook.sqleval.json");

    fireEvent.click(screen.getByRole("tab", { name: /data quality/i }));
    expect(screen.getByText("Worksheet analyzed")).toBeTruthy();
    expect(screen.getByText(/workbook\.xlsx.*Live Capture/i)).toBeTruthy();
  });

  it("sends the selected exact profile snapshot to the next analysis worker", async () => {
    let posted: unknown;
    class FakeWorker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      onmessageerror: (() => void) | null = null;
      postMessage(value: unknown) {
        posted = value;
        const request = value as { type: string; requestId: number };
        if (request.type === "prepare") queueMicrotask(() => this.onmessage?.({ data: { type: "prepared", requestId: request.requestId, previews: [{ id: "0", fileName: "capture.csv", size: 10, kind: "Activity capture", usable: true, count: 1, countLabel: "rows", worksheets: [], recognized: ["session_id"], missing: [], warnings: [], firstCapturedAt: null, lastCapturedAt: null }] } } as MessageEvent));
      }
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
    fireEvent.click(await screen.findByRole("button", { name: "Analyze selected files" }));
    expect((posted as { thresholdProfile: { id: string; digest: string } }).thresholdProfile).toMatchObject({ id: "dba.worker", digest: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });
});
