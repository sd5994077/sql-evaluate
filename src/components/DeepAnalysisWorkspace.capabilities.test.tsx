// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addEvidenceFiles, createSpillTriageCase } from "../deepAnalysis/case";
import type { DeepAnalysisCase } from "../deepAnalysis/types";
import { DeepAnalysisWorkspace } from "./DeepAnalysisWorkspace";

afterEach(cleanup);

function renderWorkspace(deepCase: DeepAnalysisCase = createSpillTriageCase("2026-09-03T12:00:00Z", "ui-capability")) {
  render(<DeepAnalysisWorkspace
    deepCase={deepCase}
    recommendations={[]}
    busy={false}
    onStart={vi.fn()}
    onStartSpillTriage={vi.fn()}
    onSelectSpillCandidate={vi.fn()}
    onChooseSpillPlan={vi.fn()}
    onClearSpillPlan={vi.fn()}
    onImport={vi.fn()}
    onSave={vi.fn()}
    onOpen={vi.fn()}
    estimateThresholds={{ ratio: 10, rows: 10_000 }}
  />);
}

describe("Deep Analysis capability routing UI", () => {
  it("makes unknown capabilities and unavailable identity paths explicit", () => {
    renderWorkspace();
    expect(screen.getByRole("heading", { name: "Route by evidence, not assumptions" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Import server capability snapshot/ }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: /Retrieve cached plan with stable provenance/ }));
    expect(screen.getByText("The selected candidate does not contain a valid plan_handle.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Copy SQL" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("offers the bounded Query Store process when SQL Server 2022 capabilities allow it", async () => {
    let deepCase = createSpillTriageCase("2026-09-03T12:00:00Z", "ui-query-store");
    const spill = "Total Spills,Query Hash,Query Plan Hash,Database ID\n1000,0x0102030405060708,0x1111111111111111,7\n";
    const capability = "adapter_id,schema_version,captured_at,server_name,product_version,edition,engine_edition,database_id,database_name,last_query_plan_stats,query_store_state,view_server_state,view_server_performance_state,view_database_state,view_database_performance_state,tool_id,tool_database,tool_schema,tool_name,installed,compatible_signature\nSQL_EVALUATE_CAPABILITIES_V1,1.0,2026-09-03T12:00:00-05:00,SQL01,16.0.4215.2,Standard Edition,2,7,Clinical,OFF,READ_WRITE,0,1,0,1,frk-blitzcache,DBA,dbo,sp_BlitzCache,1,1\n";
    deepCase = (await addEvidenceFiles(deepCase, [new File([spill], "spill.csv"), new File([capability], "capability.csv")], "2026-09-03T18:00:00Z")).deepCase;
    renderWorkspace(deepCase);
    expect(screen.getByRole("heading", { name: /Standard Edition.*16\.0\.4215\.2/ })).toBeTruthy();
    const queryStoreTab = screen.getByRole("tab", { name: /Review existing Query Store history.*Available/ });
    fireEvent.click(queryStoreTab);
    expect(queryStoreTab.getAttribute("tabindex")).toBe("0");
    expect(queryStoreTab.getAttribute("aria-controls")).toBeTruthy();
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(queryStoreTab.id);
    expect(screen.getByText(/Query Store begins collecting only after it is enabled/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Copy SQL" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
