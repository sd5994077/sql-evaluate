import { File } from "node:buffer";
import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { parseCaptureFile } from "./ingest";

describe("capture workbook ingestion", () => {
  it("imports duplicate WhoIsActive column blocks and reports the ambiguity", async () => {
    const headers = [
      "session_id", "wait_info", "tran_log_writes", "CPU", "tempdb_allocations", "tempdb_current",
      "blocking_session_id", "blocked_session_count", "reads", "writes", "physical_reads",
      "tran_log_writes", "CPU", "tempdb_allocations", "tempdb_current", "blocking_session_id",
      "blocked_session_count", "reads", "writes", "physical_reads", "start_time", "login_time",
      "request_id", "collection_time",
    ];
    const row = [
      95, "(5ms)WRITELOG", "NULL", 28900, 152, 136, "NULL", 0, 3158789, 27260, 98385,
      "NULL", 28900, 152, 136, "NULL", 0, 3158789, 27260, 98385,
      46259.04388232639, 46259.04383306713, 0, 46259.04515416667,
    ];
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([headers, row]), "Sheet1");
    const bytes = XLSX.write(workbook, { bookType: "xlsx", type: "array" });
    const parsed = await parseCaptureFile(new File([bytes], "capture2-shape.xlsx"));

    expect(parsed.records).toHaveLength(1);
    expect(parsed.records[0].sessionId).toBe(95);
    expect(parsed.records[0].tempdbCurrentPages).toBe(136);
    expect(parsed.records[0].original.CPU__13).toBe(28900);
    expect(parsed.input.warnings.join(" ")).toMatch(/duplicate columns/i);
  });
});
