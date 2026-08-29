import { describe, expect, it } from "vitest";
import { WHOISACTIVE_COLUMNS } from "../schema";
import { normalizeRows, parseWait } from "./normalize";

describe("sp_WhoIsActive normalization", () => {
  it("preserves all known columns and unknown future columns", () => {
    const headers = [...WHOISACTIVE_COLUMNS, "future_metric"];
    const values: unknown[] = headers.map(() => null);
    values[headers.indexOf("session_id")] = 77;
    values[headers.indexOf("collection_time")] = 46255.5;
    values[headers.indexOf("start_time")] = 46255.499;
    const [record] = normalizeRows("sample", [headers, values], 0);
    expect(record.sessionId).toBe(77);
    expect(record.durationSeconds).toBeCloseTo(86.4, 2);
    expect(Object.keys(record.original)).toContain("future_metric");
    expect(Object.keys(record.original)).toHaveLength(WHOISACTIVE_COLUMNS.length + 1);
  });

  it("classifies actionable and benign waits", () => {
    expect(parseWait("(1500ms)LCK_M_X:object")?.category).toBe("Locking");
    expect(parseWait("(9ms)WAITFOR")?.category).toBe("Benign / queue");
    expect(parseWait("NULL")).toBeNull();
  });

  it("parses native waittime attributes without depending on request elapsed formatting", () => {
    expect(parseWait("THREADPOOL waittime=221000 lastwaittype=THREADPOOL")).toMatchObject({ type: "THREADPOOL", durationMs: 221000, category: "Worker threads" });
    expect(parseWait("RESOURCE_SEMAPHORE_QUERY_COMPILE waittime=2521 lastwaittype=RESOURCE_SEMAPHORE_QUERY_COMPILE")).toMatchObject({ type: "RESOURCE_SEMAPHORE_QUERY_COMPILE", durationMs: 2521, category: "Compilation" });
  });

  it("parses every documented native multi-task wait shape", () => {
    expect(parseWait("(2x: 1,200ms/1,800ms)CXPACKET:nodeId=7")).toMatchObject({
      type: "CXPACKET",
      durationMs: 1_800,
      taskCount: 2,
      durationsMs: [1_200, 1_800],
      detail: "nodeId=7",
      category: "Parallelism",
    });
    expect(parseWait("(4x: 1,200ms/1,500ms/2,000ms)THREADPOOL")).toMatchObject({
      type: "THREADPOOL",
      durationMs: 2_000,
      taskCount: 4,
      durationsMs: [1_200, 1_500, 2_000],
      category: "Worker threads",
    });
  });

  it("does not turn a malformed parenthesized wait into a garbage wait type", () => {
    expect(parseWait("(4x: nope)THREADPOOL")).toBeNull();
    expect(parseWait("(,ms)LCK_M_X")).toBeNull();
    expect(parseWait("(2x: 1,,200ms/1,800ms)CXPACKET")).toBeNull();
    expect(parseWait("(0x: 1200ms/1800ms)CXPACKET")).toBeNull();
    const [record] = normalizeRows("sample", [["session_id", "wait_info"], [51, "(4x: nope)THREADPOOL"]], 0);
    expect(record.wait).toBeNull();
    expect((record as typeof record & { waitParseWarning?: string }).waitParseWarning).toMatch(/could not be parsed/i);
  });

  it("accepts optional whitespace around the documented native wait wrapper", () => {
    expect(parseWait("( 2x: 1,200ms / 1,800ms ) CXPACKET : nodeId=7")).toMatchObject({
      type: "CXPACKET",
      durationMs: 1_800,
      taskCount: 2,
      durationsMs: [1_200, 1_800],
      detail: "nodeId=7",
    });
  });

  it("normalizes human-readable resource units", () => {
    const [record] = normalizeRows("sample", [["session_id", "CPU", "reads"], [51, "1.5M", "2 KB"]], 0);
    expect(record.cpuMs).toBe(1_500_000);
    expect(record.reads).toBe(2_000);
  });
});
