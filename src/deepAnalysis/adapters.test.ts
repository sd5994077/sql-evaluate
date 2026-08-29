import { describe, expect, it } from "vitest";
import { inspectEvidenceMatrix } from "./adapters";

describe("Deep Analysis evidence adapters", () => {
  it("requires repeated scheduler samples before marking sustained pressure", () => {
    const one = inspectEvidenceMatrix([
      ["evidence_set", "sample_id", "captured_at", "scheduler_id", "runnable_tasks_count"],
      ["SCHEDULERS", 1, "2026-08-28T12:00:00Z", 0, 7],
    ], 104, "a1");
    expect(one.signals).toContain("scheduler-runnable-queue");
    expect(one.signals).not.toContain("scheduler-pressure-sustained");

    const repeated = inspectEvidenceMatrix([
      ["evidence_set", "sample_id", "captured_at", "scheduler_id", "runnable_tasks_count"],
      ["SCHEDULERS", 1, "2026-08-28T12:00:00Z", 0, 7],
      ["SCHEDULERS", 2, "2026-08-28T12:00:02Z", 0, 5],
    ], 104, "a2");
    expect(repeated.signals).toContain("scheduler-pressure-sustained");
  });

  it("does not split one scheduler sample when row timestamps differ", () => {
    const result = inspectEvidenceMatrix([
      ["evidence_set", "sample_id", "captured_at", "scheduler_id", "runnable_tasks_count"],
      ["SCHEDULERS", 1, "2026-08-28T12:00:00.000Z", 0, 7],
      ["SCHEDULERS", 1, "2026-08-28T12:00:00.001Z", 1, 5],
    ], 104, "one-grid");
    expect(result.signals).toContain("scheduler-runnable-queue");
    expect(result.signals).not.toContain("scheduler-pressure-sustained");
  });

  it("calculates a complete single-use plan inventory and keeps BlitzCache warnings distinct", () => {
    const result = inspectEvidenceMatrix([
      ["evidence_set", "captured_at", "session_id", "plan_handle", "Warnings", "plan_count", "single_use_plan_count"],
      ["PLAN_CACHE_INVENTORY", "2026-08-28T12:00:01Z", 104, "0xABCD", "Plan Cache Instability; Forced Serialization; Compilation Timeout; Unused Memory Grant; Filter UDF; non-SARGable", 35600, 35000],
    ], 104, "cache");
    expect(result.adapterId).toBe("sp-blitzcache");
    expect(result.signals).toContain("plan-cache-instability-measured");
    expect(result.signals).toContain("forced-serialization");
    expect(result.signals).toContain("compilation-timeout");
    expect(result.signals).toContain("unused-memory-grant");
    expect(result.observations.find((item) => item.metric === "single_use_percentage")?.value).toBeCloseTo(98.3146, 3);
  });

  it("matches granted root locks to victim waiting resources", () => {
    const result = inspectEvidenceMatrix([
      ["request_session_id", "request_status", "request_mode", "resource_type", "resource_database_id", "resource_associated_entity_id"],
      [104, "GRANT", "IX", "OBJECT", 5, 9001],
      [301, "WAIT", "IX", "OBJECT", 5, 9001],
    ], 104, "locks");
    expect(result.signals).toContain("root-locks-granted");
    expect(result.signals).toContain("lock-resource-match");
  });

  it("does not match lock rows when resource identity is absent", () => {
    const result = inspectEvidenceMatrix([
      ["request_session_id", "request_status", "request_mode"],
      [104, "GRANT", "IX"],
      [301, "WAIT", "IX"],
    ], 104, "incomplete-locks");
    expect(result.signals).toContain("root-locks-granted");
    expect(result.signals).not.toContain("lock-resource-match");
    expect(result.warnings).toContain("Lock rows were present without enough resource identity to prove an exact root-to-victim resource match.");
  });

  it("derives compilation pressure only from repeated compilation and batch counters", () => {
    const result = inspectEvidenceMatrix([
      ["captured_at", "counter_name", "cntr_value"],
      ["2026-08-28T12:00:00Z", "Batch Requests/sec", 10000],
      ["2026-08-28T12:00:00Z", "SQL Compilations/sec", 2000],
      ["2026-08-28T12:00:02Z", "Batch Requests/sec", 10100],
      ["2026-08-28T12:00:02Z", "SQL Compilations/sec", 2030],
    ], 104, "counters");
    expect(result.signals).toContain("compilation-pressure");
    expect(result.observations.find((item) => item.metric === "compilation_to_batch_ratio")?.value).toBe(0.3);
  });
});
