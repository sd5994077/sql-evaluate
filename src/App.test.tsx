// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { AnalysisReport, Finding, WhoIsActiveRecord } from "./types";
import App from "./App";

Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: () => undefined });

afterEach(cleanup);

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

describe("analysis navigation", () => {
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
});
