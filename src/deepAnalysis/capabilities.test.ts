import { describe, expect, it } from "vitest";
import { CAPABILITY_ADAPTER_ID, capabilitySnapshotCommand, parseCapabilitySnapshot } from "./capabilities";
import { recommendedSpillStepId, spillCollectionSteps } from "./toolCatalog";
import type { SpillCandidate } from "./types";

const headers = ["adapter_id", "schema_version", "captured_at", "server_name", "product_version", "product_level", "edition", "engine_edition", "database_id", "database_name", "last_query_plan_stats", "query_store_state", "view_server_state", "view_server_performance_state", "view_database_state", "view_database_performance_state", "tool_id", "tool_database", "tool_schema", "tool_name", "installed", "compatible_signature", "tool_version", "tool_version_date", "detected_parameters"];

function row(overrides: Record<string, unknown> = {}): unknown[] {
  const values: Record<string, unknown> = {
    adapter_id: CAPABILITY_ADAPTER_ID, schema_version: "1.0", captured_at: "2026-09-03T12:00:00-05:00", server_name: "SQL01",
    product_version: "16.0.4215.2", product_level: "CU", edition: "Standard Edition (64-bit)", engine_edition: 2,
    database_id: 7, database_name: "Clinical", last_query_plan_stats: "ON", query_store_state: "READ_WRITE",
    view_server_state: 0, view_server_performance_state: 1, view_database_state: 0, view_database_performance_state: 1,
    tool_id: "frk-blitzcache", tool_database: "DBA", tool_schema: "dbo", tool_name: "sp_BlitzCache",
    installed: 1, compatible_signature: 1, tool_version: "8.34", tool_version_date: "2026-07-02", detected_parameters: "@Top,@SortOrder,@OnlySqlHandles",
    ...overrides,
  };
  return headers.map((header) => values[header] ?? null);
}

const candidate = {
  id: "candidate", artifactId: "a", fileName: "spill.csv", sheetName: null, rowNumber: 2, sourceOrder: 0,
  identity: { planHandle: "0xAABB", queryHash: "0x0102030405060708", queryPlanHash: "0x1111111111111111", databaseId: 7 },
} as SpillCandidate;

describe("server capability snapshots", () => {
  it("parses SQL Server 2022 Standard capabilities and installed tool versions", () => {
    const result = parseCapabilitySnapshot([headers, row()], "artifact", new Date("2026-09-04T00:00:00Z"));
    expect(result.snapshot).toMatchObject({ productVersion: "16.0.4215.2", edition: "Standard Edition (64-bit)", lastQueryPlanStats: "ON", queryStoreState: "READ_WRITE" });
    expect(result.snapshot?.permissions.viewServerPerformanceState).toBe(true);
    expect(result.snapshot?.permissions.viewDatabasePerformanceState).toBe(true);
    expect(result.snapshot?.tools[0]).toMatchObject({ toolId: "frk-blitzcache", installed: true, compatibleSignature: true, version: "8.34" });
  });

  it("rejects malformed recognized snapshots and warns when snapshots are stale", () => {
    expect(parseCapabilitySnapshot([headers, row({ product_version: null })], "bad").error).toMatch(/product_version/);
    expect(parseCapabilitySnapshot([headers, row({ product_version: "not-a-version" })], "bad").error).toMatch(/recognized SQL Server version/);
    expect(parseCapabilitySnapshot([headers, row(), row({ database_name: "DifferentDatabase" })], "mixed").error).toMatch(/mixes rows/);
    const stale = parseCapabilitySnapshot([headers, row({ captured_at: "2026-01-01T00:00:00Z" })], "old", new Date("2026-09-03T00:00:00Z"));
    expect(stale.stale).toBe(true);
    expect(stale.snapshot?.warnings.join(" ")).toMatch(/30 days old/);
  });

  it("routes by observed capabilities instead of edition name", () => {
    const snapshot = parseCapabilitySnapshot([headers, row()], "artifact", new Date("2026-09-04T00:00:00Z")).snapshot!;
    const steps = spillCollectionSteps(candidate, snapshot, "case");
    expect(steps.find((step) => step.id === "cached-plan-provenance")?.availability).toBe("Available");
    expect(steps.find((step) => step.id === "last-known-actual-plan")?.availability).toBe("Available");
    expect(steps.find((step) => step.id === "query-store-history")?.availability).toBe("Available");
    expect(recommendedSpillStepId(steps, false, false, true)).toBe("cached-plan-provenance");
    expect(recommendedSpillStepId(steps, false, false, true, false)).toBeUndefined();
    expect(recommendedSpillStepId(steps, true, true, true)).toBeUndefined();
    expect(recommendedSpillStepId(steps, true, false, true, true, true)).toBe("last-known-actual-plan");

    const disabled = parseCapabilitySnapshot([headers, row({ last_query_plan_stats: "OFF", query_store_state: "OFF" })], "artifact", new Date("2026-09-04T00:00:00Z")).snapshot!;
    const disabledSteps = spillCollectionSteps(candidate, disabled, "case");
    expect(disabledSteps.find((step) => step.id === "last-known-actual-plan")?.unavailableReason).toMatch(/will not enable/);
    expect(disabledSteps.find((step) => step.id === "query-store-history")?.availability).toBe("Unavailable");
  });

  it("generates bounded manual scripts without cache eviction, maintenance, or AI options", () => {
    const snapshotSql = capabilitySnapshotCommand("case");
    expect(snapshotSql).toContain("SQL_EVALUATE_CAPABILITIES_V1");
    expect(snapshotSql).toContain("SET QUOTED_IDENTIFIER ON;");
    expect(snapshotSql).toContain("WHEN '1' THEN 'ON' WHEN '0' THEN 'OFF'");
    expect(snapshotSql).toContain("ORDER BY t.tool_id;';\n\nEXEC sys.sp_executesql @Discovery");
    expect(snapshotSql).toContain("@VersionCheckMode=1");
    expect(snapshotSql).not.toMatch(/\b(?:ALTER|DROP|DBCC|KILL)\b/i);
    expect(snapshotSql).not.toContain("@AI");
    const cached = spillCollectionSteps(candidate, undefined, "case").find((step) => step.id === "cached-plan-provenance")!.command;
    expect(cached).toContain("qs.plan_handle = @plan_handle");
    expect(cached).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|MERGE|ALTER|CREATE|DROP|TRUNCATE|DBCC|KILL)\b/i);
    const queryStore = spillCollectionSteps(candidate, parseCapabilitySnapshot([headers, row()], "artifact").snapshot!, "case").find((step) => step.id === "query-store-history")!.command;
    expect(queryStore).toContain("GROUP BY rs.plan_id");
    expect(queryStore).toContain("p.query_plan_hash");
    expect(queryStore).toContain("newly enabled store has no earlier history");
    expect(queryStore).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|MERGE|ALTER|CREATE|DROP|TRUNCATE|DBCC|KILL)\b/i);
  });

  it("uses SQL Server 2022 database performance-state permission for Query Store", () => {
    const denied = parseCapabilitySnapshot([headers, row({ view_database_state: 0, view_database_performance_state: 0 })], "artifact").snapshot!;
    const queryStore = spillCollectionSteps(candidate, denied, "case").find((step) => step.id === "query-store-history")!;
    expect(queryStore.availability).toBe("Unavailable");
    expect(queryStore.unavailableReason).toMatch(/VIEW DATABASE PERFORMANCE STATE/);

    const wrongDatabase = parseCapabilitySnapshot([headers, row({ database_id: 8, database_name: "Other" })], "artifact").snapshot!;
    const mismatched = spillCollectionSteps(candidate, wrongDatabase, "case").find((step) => step.id === "query-store-history")!;
    expect(mismatched.availability).toBe("Unavailable");
    expect(mismatched.unavailableReason).toMatch(/candidate belongs to database 7/);
  });
});
