import { describe, expect, it } from "vitest";
import { addEvidenceFiles, createSpillTriageCase } from "./case";
import { resolveCandidatePlan } from "./spillTriage";

function csvCell(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

const plan = (planHandle = "") => `<?xml version="1.0" encoding="utf-8"?>
<ShowPlanXML Version="1.6" xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan">
 <BatchSequence><Batch><Statements><StmtSimple StatementText="SELECT 1" StatementType="SELECT"${planHandle ? ` PlanHandle="${planHandle}"` : ""}>
  <QueryPlan><RelOp NodeId="0" PhysicalOp="Constant Scan" LogicalOp="Constant Scan" EstimateRows="1" /></QueryPlan>
 </StmtSimple></Statements></Batch></BatchSequence>
</ShowPlanXML>`;

describe("tabular Showplan provenance", () => {
  it("connects identity-free Showplan XML using stable identity from the same result row", async () => {
    let deepCase = createSpillTriageCase("2026-09-03T12:00:00Z", "provenance");
    const spill = new File(["Total Spills,Plan Handle,Query Hash,Query Plan Hash,Statement Start Offset,Statement End Offset,Database ID\n1000,0xAABB,0x0102030405060708,0x1111111111111111,0,20,7\n"], "spill.csv");
    deepCase = (await addEvidenceFiles(deepCase, [spill], "2026-09-03T12:01:00Z")).deepCase;
    const result = `adapter_id,evidence_set,captured_at,plan_handle,sql_handle,query_hash,query_plan_hash,statement_start_offset,statement_end_offset,database_id,query_plan\nSQL_EVALUATE_NATIVE_V1,CACHED_PLAN_PROVENANCE,2026-09-03T12:02:00Z,0xAABB,0xCCDD,0x0102030405060708,0x1111111111111111,0,20,7,${csvCell(plan())}\n`;
    deepCase = (await addEvidenceFiles(deepCase, [new File([result], "cached-plan.csv")], "2026-09-03T12:02:00Z")).deepCase;
    const candidate = deepCase.spillTriage!.candidates[0];
    const resolution = resolveCandidatePlan(candidate, deepCase.spillTriage!.plans);
    expect(resolution).toMatchObject({ connected: true, quality: "Exact" });
    expect(resolution.statement?.queryIdentity).toMatchObject({ planHandle: "0xAABB", sqlHandle: "0xCCDD", databaseId: 7 });
  });

  it("does not overwrite a conflicting identity embedded in Showplan", async () => {
    const deepCase = createSpillTriageCase("2026-09-03T12:00:00Z", "conflict");
    const result = `adapter_id,evidence_set,captured_at,plan_handle,query_plan\nSQL_EVALUATE_NATIVE_V1,CACHED_PLAN_PROVENANCE,2026-09-03T12:02:00Z,0xAABB,${csvCell(plan("0xBBBB"))}\n`;
    const imported = await addEvidenceFiles(deepCase, [new File([result], "conflict.csv")], "2026-09-03T12:02:00Z");
    expect(imported.messages.some((message) => message.code === "plan-identity-conflict")).toBe(true);
    expect(imported.deepCase.spillTriage?.plans[0].plan.statements[0].queryIdentity?.planHandle).toBe("0xBBBB");
  });

  it("uses exact plan-handle provenance when SQL Server emits a different embedded SqlHandle", async () => {
    let deepCase = createSpillTriageCase("2026-09-03T12:00:00Z", "sql-handle-provenance");
    const spill = new File(["Total Spills,Plan Handle,SQL Handle,Query Hash,Query Plan Hash,Database ID\n1000,0xAABB,0xCCDD,0x0102030405060708,0x1111111111111111,7\n"], "spill.csv");
    deepCase = (await addEvidenceFiles(deepCase, [spill], "2026-09-03T12:01:00Z")).deepCase;
    const embedded = plan().replace('StatementType="SELECT"', 'StatementType="SELECT" SqlHandle="0xDIFFERENT" QueryHash="0x0102030405060708" QueryPlanHash="0x1111111111111111"');
    const result = [
      "adapter_id,evidence_set,captured_at,plan_handle,sql_handle,query_hash,query_plan_hash,database_id,query_plan",
      `SQL_EVALUATE_NATIVE_V1,CACHED_PLAN_PROVENANCE,2026-09-03T12:02:00Z,0xAABB,0xCCDD,0x0102030405060708,0x1111111111111111,7,${csvCell(embedded)}`,
    ].join("\n") + "\n";
    deepCase = (await addEvidenceFiles(deepCase, [new File([result], "cached-plan.csv")], "2026-09-03T12:02:00Z")).deepCase;
    const resolution = resolveCandidatePlan(deepCase.spillTriage!.candidates[0], deepCase.spillTriage!.plans);
    expect(resolution).toMatchObject({ connected: true, quality: "Exact" });
    expect(resolution.statement?.queryIdentity).toMatchObject({ planHandle: "0xAABB", sqlHandle: "0xCCDD" });
  });

  it("connects a Query Store export through paired hashes and database identity", async () => {
    let deepCase = createSpillTriageCase("2026-09-03T12:00:00Z", "query-store");
    const spill = new File(["Total Spills,Query Hash,Query Plan Hash,Database ID\n1000,0x0102030405060708,0x1111111111111111,7\n"], "spill.csv");
    deepCase = (await addEvidenceFiles(deepCase, [spill], "2026-09-03T12:01:00Z")).deepCase;
    const result = `adapter_id,evidence_set,captured_at,database_id,query_id,plan_id,query_hash,query_plan_hash,statement_start_offset,statement_end_offset,query_plan\nQUERY_STORE_EXPORT_V1,QUERY_STORE,2026-09-03T12:02:00Z,7,7001,7101,0x0102030405060708,0x1111111111111111,0,20,${csvCell(plan())}\n`;
    deepCase = (await addEvidenceFiles(deepCase, [new File([result], "query-store.csv")], "2026-09-03T12:02:00Z")).deepCase;
    const evidence = deepCase.spillTriage!.plans[0].plan;
    const resolution = resolveCandidatePlan(deepCase.spillTriage!.candidates[0], deepCase.spillTriage!.plans);
    expect(evidence.sourceKind).toBe("Query Store");
    expect(evidence.statements[0].queryIdentity).toMatchObject({ queryStoreQueryId: 7001, queryStorePlanId: 7101, databaseId: 7 });
    expect(resolution).toMatchObject({ connected: true, quality: "Strong" });
  });

  it("does not compare a Query Store statement handle with a plan-cache batch handle", async () => {
    let deepCase = createSpillTriageCase("2026-09-03T12:00:00Z", "query-store-statement-handle");
    const spill = new File([
      "Total Spills,SQL Handle,Query Hash,database_id,query_id,plan_id\n1000,0xBATCH,0x0102030405060708,7,7001,7101\n",
    ], "spill.csv");
    deepCase = (await addEvidenceFiles(deepCase, [spill], "2026-09-03T12:01:00Z")).deepCase;
    const embedded = plan().replace(
      'StatementType="SELECT"',
      'StatementType="SELECT" StatementSqlHandle="0xSTATEMENT" QueryHash="0x0102030405060708" QueryPlanHash="0x1111111111111111"',
    );
    const result = `adapter_id,evidence_set,captured_at,database_id,query_id,plan_id,query_hash,query_plan_hash,query_plan\nQUERY_STORE_EXPORT_V1,QUERY_STORE,2026-09-03T12:02:00Z,7,7001,7101,0x0102030405060708,0x1111111111111111,${csvCell(embedded)}\n`;
    deepCase = (await addEvidenceFiles(deepCase, [new File([result], "query-store.csv")], "2026-09-03T12:02:00Z")).deepCase;

    const evidence = deepCase.spillTriage!.plans[0].plan;
    const resolution = resolveCandidatePlan(deepCase.spillTriage!.candidates[0], deepCase.spillTriage!.plans);
    expect(evidence.statements[0].queryIdentity?.sqlHandle).toBeUndefined();
    expect(resolution).toMatchObject({ connected: true, quality: "Exact", blockedByConflict: false });
  });

  it("prefers an exact current cached plan over an equivalent Query Store compile plan", async () => {
    let deepCase = createSpillTriageCase("2026-09-03T12:00:00Z", "cached-before-query-store");
    const spill = new File([
      "Total Spills,Plan Handle,SQL Handle,Query Hash,database_id,query_id,plan_id\n1000,0xPLAN,0xBATCH,0x0102030405060708,7,7001,7101\n",
    ], "spill.csv");
    deepCase = (await addEvidenceFiles(deepCase, [spill], "2026-09-03T12:01:00Z")).deepCase;

    const cachedResult = `adapter_id,evidence_set,captured_at,plan_handle,sql_handle,query_hash,query_plan_hash,database_id,query_plan\nSQL_EVALUATE_NATIVE_V1,CACHED_PLAN_PROVENANCE,2026-09-03T12:02:00Z,0xPLAN,0xBATCH,0x0102030405060708,0x1111111111111111,7,${csvCell(plan())}\n`;
    deepCase = (await addEvidenceFiles(deepCase, [new File([cachedResult], "cached-plan.csv")], "2026-09-03T12:02:00Z")).deepCase;

    const queryStorePlan = plan().replace(
      'StatementType="SELECT"',
      'StatementType="SELECT" StatementSqlHandle="0xSTATEMENT" QueryHash="0x0102030405060708" QueryPlanHash="0x1111111111111111"',
    );
    const queryStoreResult = `adapter_id,evidence_set,captured_at,database_id,query_id,plan_id,query_hash,query_plan_hash,query_plan\nQUERY_STORE_EXPORT_V1,QUERY_STORE,2026-09-03T12:03:00Z,7,7001,7101,0x0102030405060708,0x1111111111111111,${csvCell(queryStorePlan)}\n`;
    deepCase = (await addEvidenceFiles(deepCase, [new File([queryStoreResult], "query-store.csv")], "2026-09-03T12:03:00Z")).deepCase;

    const resolution = resolveCandidatePlan(deepCase.spillTriage!.candidates[0], deepCase.spillTriage!.plans);
    expect(resolution).toMatchObject({ connected: true, ambiguous: false, quality: "Exact" });
    expect(resolution.evidence?.plan.sourceKind).toBe("Cached estimated");
  });
});
