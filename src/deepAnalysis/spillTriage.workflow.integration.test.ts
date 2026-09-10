import { File } from "node:buffer";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { addEvidenceFiles, createSpillTriageCase, selectSpillCandidate } from "./case";
import { actualSpillOperators, resolveCandidatePlan } from "./spillTriage";
import { recommendedSpillStepId } from "./toolCatalog";
import type { DeepAnalysisCase } from "./types";

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../test-fixtures/spill-triage/${name}`, import.meta.url)), "utf8");
}

function csvCell(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

const capabilitySnapshot = `adapter_id,schema_version,captured_at,server_name,product_version,edition,engine_edition,database_id,database_name,last_query_plan_stats,query_store_state,view_server_state,view_server_performance_state,view_database_state,view_database_performance_state,tool_id,tool_database,tool_schema,tool_name,installed,compatible_signature
SQL_EVALUATE_CAPABILITIES_V1,1.0,2026-09-03T12:00:00-05:00,SQL01,16.0.4215.2,Standard Edition,2,7,SyntheticDb,ON,READ_WRITE,0,1,0,1,frk-blitzcache,DBA,dbo,sp_BlitzCache,1,1
`;

function workflowState(deepCase: DeepAnalysisCase) {
  const triage = deepCase.spillTriage!;
  const candidate = triage.candidates.find((item) => item.id === triage.selectedCandidateId) ?? triage.candidates[0];
  const resolution = candidate ? resolveCandidatePlan(candidate, triage.plans) : null;
  return {
    candidate,
    resolution,
    recommendedId: recommendedSpillStepId(
      deepCase.collectionSteps,
      Boolean(resolution?.connected),
      Boolean(resolution?.connected && resolution.statement?.isActual),
      Boolean(deepCase.serverCapabilities),
      Boolean(candidate),
      triage.plans.some((item) => item.plan.sourceKind === "Query Store"),
    ),
  };
}

function collectionCommand(deepCase: DeepAnalysisCase, stepId: string): string {
  return deepCase.collectionSteps.find((step) => step.id === stepId)?.command ?? "";
}

describe("Spill Triage evidence-ladder workflow", () => {
  it("routes a ranked candidate through capabilities, cached provenance, and a retained actual plan", async () => {
    let deepCase = createSpillTriageCase("2026-09-03T12:00:00Z", "workflow-e2e");

    // 1. Import and deliberately select the highest-ranked spill candidate.
    const spillExport = fixture("current-expert.csv").replaceAll("0xAAA", "0xAABB");
    deepCase = (await addEvidenceFiles(deepCase, [new File([spillExport], "spill-export.csv")], "2026-09-03T12:01:00Z")).deepCase;
    const candidate = deepCase.spillTriage!.candidates[0];
    deepCase = selectSpillCandidate(deepCase, candidate.id);
    expect(candidate).toMatchObject({ rank: 1, identity: { planHandle: "0xAABB" } });
    expect(workflowState(deepCase).recommendedId).toBe("server-capability-snapshot");
    expect(collectionCommand(deepCase, "cached-plan-provenance")).toContain("DECLARE @plan_handle varbinary(64) = 0xAABB");

    // 2. Import a same-database capability snapshot that authorizes only already-enabled retained sources.
    deepCase = (await addEvidenceFiles(deepCase, [new File([capabilitySnapshot], "capabilities.csv")], "2026-09-03T12:02:00Z")).deepCase;
    expect(deepCase.serverCapabilities).toMatchObject({ productVersion: "16.0.4215.2", databaseName: "SyntheticDb", lastQueryPlanStats: "ON", queryStoreState: "READ_WRITE" });
    expect(workflowState(deepCase).recommendedId).toBe("cached-plan-provenance");

    // 3. Import the generated cached-plan result. The Showplan itself lacks identity, so the result-row provenance must supply it.
    const identityFreeCachedPlan = fixture("cached-estimated.sqlplan").replaceAll("0xAAA", "0xAABB").replace(/ PlanHandle="[^"]*" SqlHandle="[^"]*" QueryHash="[^"]*" QueryPlanHash="[^"]*" StatementStartOffset="[^"]*" StatementEndOffset="[^"]*"/, "");
    const cachedResult = `adapter_id,evidence_set,captured_at,plan_handle,sql_handle,query_hash,query_plan_hash,statement_start_offset,statement_end_offset,database_id,query_plan\nSQL_EVALUATE_NATIVE_V1,CACHED_PLAN_PROVENANCE,2026-09-03T12:03:00Z,0xAABB,0xSQL1,0x111,0x222,0,100,7,${csvCell(identityFreeCachedPlan)}\n`;
    deepCase = (await addEvidenceFiles(deepCase, [new File([cachedResult], "cached-plan.csv")], "2026-09-03T12:03:00Z")).deepCase;
    let resolution = resolveCandidatePlan(candidate, deepCase.spillTriage!.plans);
    expect(resolution).toMatchObject({ connected: true, quality: "Exact", selectionMethod: "automatic" });
    expect(resolution.evidence?.plan).toMatchObject({ sourceKind: "Cached estimated", isActual: false });
    expect(workflowState(deepCase).recommendedId).toBe("last-known-actual-plan");
    expect(collectionCommand(deepCase, "last-known-actual-plan")).toContain("DECLARE @plan_handle varbinary(64) = 0xAABB");

    // 4. Import an already-retained last-known actual plan; it must supersede compile-only evidence for runtime diagnosis.
    const actualPlan = fixture("actual-spills.sqlplan").replaceAll("0xAAA", "0xAABB");
    const actualResult = `adapter_id,evidence_set,captured_at,plan_handle,sql_handle,query_hash,query_plan_hash,statement_start_offset,statement_end_offset,database_id,last_query_plan\nSQL_EVALUATE_NATIVE_V1,LAST_KNOWN_ACTUAL_PLAN,2026-09-03T12:04:00Z,0xAABB,0xSQL1,0x111,0x222,0,100,7,${csvCell(actualPlan)}\n`;
    deepCase = (await addEvidenceFiles(deepCase, [new File([actualResult], "last-known-actual.csv")], "2026-09-03T12:04:00Z")).deepCase;
    resolution = resolveCandidatePlan(candidate, deepCase.spillTriage!.plans);
    expect(resolution).toMatchObject({ connected: true, quality: "Exact", selectionMethod: "automatic" });
    expect(resolution.evidence?.plan).toMatchObject({ sourceKind: "Last-known actual", isActual: true });
    expect(actualSpillOperators(resolution.evidence!.plan, resolution.statement!)).toHaveLength(2);
    expect(workflowState(deepCase).recommendedId).toBeUndefined();
  });

  it("routes to existing Query Store history when last-known actual plans are unavailable", async () => {
    let deepCase = createSpillTriageCase("2026-09-03T12:00:00Z", "workflow-query-store");
    const queryHash = "0x0102030405060708";
    const spillExport = fixture("current-expert.csv").replaceAll("0xAAA", "0xAABB").replaceAll("0x111", queryHash);
    deepCase = (await addEvidenceFiles(deepCase, [new File([spillExport], "spill-export.csv")], "2026-09-03T12:01:00Z")).deepCase;
    const candidate = deepCase.spillTriage!.candidates[0];
    deepCase = selectSpillCandidate(deepCase, candidate.id);

    const queryStoreSnapshot = capabilitySnapshot.replace(",ON,READ_WRITE,", ",OFF,READ_WRITE,");
    deepCase = (await addEvidenceFiles(deepCase, [new File([queryStoreSnapshot], "capabilities.csv")], "2026-09-03T12:02:00Z")).deepCase;
    expect(deepCase.serverCapabilities).toMatchObject({ lastQueryPlanStats: "OFF", queryStoreState: "READ_WRITE" });

    const identityFreeCachedPlan = fixture("cached-estimated.sqlplan").replaceAll("0xAAA", "0xAABB").replace(/ PlanHandle="[^"]*" SqlHandle="[^"]*" QueryHash="[^"]*" QueryPlanHash="[^"]*" StatementStartOffset="[^"]*" StatementEndOffset="[^"]*"/, "");
    const cachedResult = `adapter_id,evidence_set,captured_at,plan_handle,sql_handle,query_hash,query_plan_hash,statement_start_offset,statement_end_offset,database_id,query_plan\nSQL_EVALUATE_NATIVE_V1,CACHED_PLAN_PROVENANCE,2026-09-03T12:03:00Z,0xAABB,0xSQL1,${queryHash},0x222,0,100,7,${csvCell(identityFreeCachedPlan)}\n`;
    deepCase = (await addEvidenceFiles(deepCase, [new File([cachedResult], "cached-plan.csv")], "2026-09-03T12:03:00Z")).deepCase;

    expect(workflowState(deepCase)).toMatchObject({
      recommendedId: "query-store-history",
      resolution: { connected: true, statement: { isActual: false } },
    });
    expect(collectionCommand(deepCase, "query-store-history")).toContain(`DECLARE @QueryHash binary(8) = ${queryHash}`);
  });
});
