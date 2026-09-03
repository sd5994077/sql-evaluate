// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectSpillTriageMatrix } from "../deepAnalysis/spillTriage";
import type { SpillTriageState } from "../deepAnalysis/types";
import { SpillTriagePanel } from "./SpillTriagePanel";

afterEach(cleanup);

function state(withPlan = false): SpillTriageState {
  const candidates = inspectSpillTriageMatrix([
    ["Total Spills", "Avg Spills", "# Executions", "Plan Handle", "Query Hash", "Query Plan Hash", "Remove Plan Handle From Cache"],
    [158870, 15887, 10, "0xAAA", "0x111", "0x222", "DBCC FREEPROCCACHE (0xAAA);"],
  ], { artifactId: "a", fileName: "blitz.csv" }).candidates;
  return {
    candidates,
    selectedCandidateId: candidates[0].id,
    imports: [{ artifactId: "a", fileName: "blitz.csv", sheetName: null, importedRows: 10, rankableRows: 1, recognizedHeaders: [], unknownHeaders: [], warnings: ["Ten rows were imported. This is consistent with @Top = 10; it does not prove that only ten cached plans spilled."] }],
    plans: withPlan ? [{ artifactId: "p", fileName: "cached.sqlplan", plan: { id: "p", sourceId: "p", fileName: "cached.sqlplan", version: "1.6", isActual: false, warnings: [], sourceKind: "Cached estimated", statements: [{ id: "s", statementText: "SELECT 1", statementType: "SELECT", estimatedCost: 1, isActual: false, missingIndexImpact: null, warnings: [], operators: [], queryIdentity: { planHandle: "0xAAA", queryHash: "0x111", queryPlanHash: "0x222" } }] } }] : [],
    manualPlanSelections: [],
  };
}

const callbacks = { onChooseStatement: vi.fn(), onClearStatement: vi.fn() };

describe("SpillTriagePanel", () => {
  it("explains cumulative rank and offers a stable-plan next action", () => {
    const choose = vi.fn();
    render(<SpillTriagePanel spillTriage={state()} onSelect={vi.fn()} onChoosePlan={choose} {...callbacks} />);
    expect(screen.getByText(/158,870 pages total/i)).toBeTruthy();
    expect(screen.getAllByText(/does not prove that only ten/i)).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: /choose matching plan/i }));
    expect(choose).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: /freeproccache/i })).toBeNull();
  });

  it("labels a correlated cached plan as compile-only evidence", () => {
    render(<SpillTriagePanel spillTriage={state(true)} onSelect={vi.fn()} onChoosePlan={vi.fn()} {...callbacks} />);
    expect(screen.getByText(/exact stable-identity match/i)).toBeTruthy();
    expect(screen.getByText(/runtime operator counts and spill volumes are not available/i)).toBeTruthy();
  });

  it("presents plan-correlation outcomes with explicit accessible severity", () => {
    const missing = render(<SpillTriagePanel spillTriage={state()} onSelect={vi.fn()} onChoosePlan={vi.fn()} {...callbacks} />);
    const information = screen.getByRole("status", { name: /information: plan needed/i });
    expect(information.classList.contains("spill-match-state-info")).toBe(true);
    missing.unmount();

    const identityFree = state();
    identityFree.plans = [{ artifactId: "p", fileName: "valid-without-identity.sqlplan", plan: { id: "p", sourceId: "p", fileName: "valid-without-identity.sqlplan", version: "1.6", isActual: false, warnings: [], sourceKind: "Cached estimated", statements: [{ id: "s", statementText: "SELECT 1", statementType: "SELECT", estimatedCost: 1, isActual: false, missingIndexImpact: null, warnings: [], operators: [], queryIdentity: {} }] } }];
    const warningRender = render(<SpillTriagePanel spillTriage={identityFree} onSelect={vi.fn()} onChoosePlan={vi.fn()} {...callbacks} />);
    const warning = screen.getByRole("status", { name: /warning: imported plan cannot be correlated/i });
    expect(warning.classList.contains("spill-match-state-warning")).toBe(true);
    expect(within(warning).getByText(/valid, but it does not contain a correlation-ready stable identifier/i)).toBeTruthy();
    warningRender.unmount();

    const conflict = state(true);
    conflict.plans[0]!.plan.statements[0]!.queryIdentity!.planHandle = "0xDIFFERENT";
    render(<SpillTriagePanel spillTriage={conflict} onSelect={vi.fn()} onChoosePlan={vi.fn()} {...callbacks} />);
    const error = screen.getByRole("alert", { name: /error: stable identity conflict/i });
    expect(error.classList.contains("spill-match-state-error")).toBe(true);
  });

  it("keeps a rejected plan upload visible beside the matching-plan action", () => {
    const props = {
      spillTriage: state(),
      onSelect: vi.fn(),
      onChoosePlan: vi.fn(),
      ...callbacks,
      planImportMessages: [{
        fileName: "blitzcache-plan.sqlplan",
        severity: "error",
        code: "plan-invalid",
        message: "The XML document does not contain a ShowPlanXML root. The file was preserved for provenance but was not added as usable plan evidence.",
      }],
    } as unknown as Parameters<typeof SpillTriagePanel>[0];

    render(<SpillTriagePanel {...props} />);

    const error = screen.getByRole("alert", { name: /error: plan import failed/i });
    expect(error.classList.contains("spill-match-state-error")).toBe(true);
    expect(within(error).getByText(/does not contain a ShowPlanXML root/i)).toBeTruthy();
  });

  it("names a Query Store candidate in the cumulative summary and gives every action a unique accessible name", () => {
    const candidates = inspectSpillTriageMatrix([
      ["Total Spills", "Execution Count", "Query Store Query Id", "Query Store Plan Id", "Object Name"],
      [500000, 10, 7001, 7101, "dbo.AuroraProcess"],
      [400000, 10, 7002, 7102, "dbo.AuroraConflict"],
    ], { artifactId: "qs", fileName: "qs.csv" }).candidates;
    render(<SpillTriagePanel spillTriage={{ candidates, selectedCandidateId: candidates[0].id, imports: [], plans: [], manualPlanSelections: [] }} onSelect={vi.fn()} onChoosePlan={vi.fn()} {...callbacks} />);
    expect(screen.getAllByText("QS 7001 / 7101").length).toBeGreaterThan(0);
    expect(screen.queryByText("No ranked candidate")).toBeNull();
    expect(screen.getByRole("button", { name: /selected rank 1 dbo\.AuroraProcess/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /investigate rank 2 dbo\.AuroraConflict/i })).toBeTruthy();
  });

  it("discloses worksheet selection, header position, and ignored sheets", () => {
    const value = state();
    value.imports[0] = { ...value.imports[0], sheetName: "Spill Review", headerRow: 6, ignoredSheets: [{ sheetName: "Read Me", reason: "No supported spill header was detected." }, { sheetName: "CPU Snapshot", reason: "No supported spill header was detected." }] };
    render(<SpillTriagePanel spillTriage={value} onSelect={vi.fn()} onChoosePlan={vi.fn()} {...callbacks} />);
    expect(screen.getByText(/detected spill header at worksheet row 6/i)).toBeTruthy();
    expect(screen.getByText(/ignored Read Me:/i)).toBeTruthy();
    expect(screen.getByText(/ignored CPU Snapshot:/i)).toBeTruthy();
  });

  it("shows a supplied spilled-thread count for actual operator evidence", () => {
    const value = state(true);
    const plan = value.plans[0].plan;
    plan.isActual = true;
    plan.statements[0].isActual = true;
    plan.statements[0].degreeOfParallelism = 4;
    plan.statements[0].operators = [{ id: "op", nodeId: 12, physicalOp: "Sort", logicalOp: "Sort", estimatedRows: 1, actualRows: 100000, estimatedCost: 1, warnings: ["Spill to tempdb"], childNodeIds: [], spillDetails: [{ kind: "Sort", spillLevel: 2, spilledThreadCount: 3, tempdbFileCount: 6, pagesWritten: 10, pagesRead: null, grantedMemoryKb: 100, usedMemoryKb: 90, requestedMemoryKb: 100, rawAttributes: { TempdbFileCount: "6" } }] }];
    render(<SpillTriagePanel spillTriage={value} onSelect={vi.fn()} onChoosePlan={vi.fn()} {...callbacks} />);
    expect(screen.getByText("Spilled threads")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.getByText("Tempdb files")).toBeTruthy();
    expect(screen.getByText("6")).toBeTruthy();
    expect(screen.getByText(/DOP 4/i)).toBeTruthy();
  });

  it("offers an explicit statement choice only for equally strong ambiguous matches", () => {
    const candidates = inspectSpillTriageMatrix([
      ["Total Spills", "Sql Handle", "Object Name"],
      [100, "0xBATCH", "dbo.Ambiguous"],
    ], { artifactId: "a", fileName: "ambiguous.csv" }).candidates;
    const statement = (id: string, start: number) => ({ id, statementText: `SELECT ${start}`, statementType: "SELECT", estimatedCost: 1, isActual: false, missingIndexImpact: null, warnings: [], operators: [], queryIdentity: { sqlHandle: "0xBATCH", statementStartOffset: start, statementEndOffset: start + 10 } });
    const value: SpillTriageState = { candidates, selectedCandidateId: candidates[0].id, imports: [], manualPlanSelections: [], plans: [{ artifactId: "p", fileName: "batch.sqlplan", plan: { id: "p", sourceId: "p", fileName: "batch.sqlplan", version: null, isActual: false, warnings: [], statements: [statement("s1", 0), statement("s2", 20)] } }] };
    const choose = vi.fn();
    render(<SpillTriagePanel spillTriage={value} onSelect={vi.fn()} onChoosePlan={vi.fn()} onChooseStatement={choose} onClearStatement={vi.fn()} />);
    expect(screen.getByText("Matching plan is ambiguous")).toBeTruthy();
    const choices = screen.getAllByRole("button", { name: /choose statement \d from batch\.sqlplan/i });
    expect(choices).toHaveLength(2);
    fireEvent.click(choices[1]);
    expect(choose).toHaveBeenCalledWith(candidates[0].id, "p", "s2");
  });

  it("clamps pagination when a replacement case contains fewer candidates", () => {
    const rows: unknown[][] = [["Total Spills", "Plan Handle"]];
    for (let index = 0; index < 51; index += 1) rows.push([51 - index, `0x${index}`]);
    const candidates = inspectSpillTriageMatrix(rows, { artifactId: "large", fileName: "large.csv" }).candidates;
    const large: SpillTriageState = { candidates, selectedCandidateId: candidates[0].id, imports: [], plans: [], manualPlanSelections: [] };
    const rendered = render(<SpillTriagePanel spillTriage={large} onSelect={vi.fn()} onChoosePlan={vi.fn()} {...callbacks} />);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Page 2 of 2")).toBeTruthy();
    const small = state();
    rendered.rerender(<SpillTriagePanel spillTriage={small} onSelect={vi.fn()} onChoosePlan={vi.fn()} {...callbacks} />);
    expect(screen.getByText(/158,870 pages total/i)).toBeTruthy();
    expect(screen.queryByText(/Page 2 of/)).toBeNull();
  });
});
