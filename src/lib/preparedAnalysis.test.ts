import { File } from "node:buffer";
import * as XLSX from "xlsx";
import { describe, expect, it, vi } from "vitest";
import { prepareAnalysis, analyzePrepared } from "./preparedAnalysis";
import { DEFAULT_THRESHOLD_PROFILE_SNAPSHOT } from "../rules/thresholdProfiles";

describe("prepared analysis", () => {
  it("analyzes the exact selected worksheet without reading the file again", async () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["session_id", "collection_time", "status"], [51, "2026-09-05T10:00:00Z", "running"]]), "Default");
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["session_id", "collection_time"], [72, "2026-09-05T11:00:00Z"]]), "Incident");
    const file = new File([XLSX.write(workbook, { type: "buffer", bookType: "xlsx" })], "two-sheets.xlsx");
    const batch = await prepareAnalysis([file], { "0": "Incident" });
    expect(batch.previews[0]).toMatchObject({ selectedSheet: "Incident", worksheets: ["Default", "Incident"], count: 1, firstCapturedAt: "2026-09-05T11:00:00.000Z" });
    const read = vi.spyOn(file, "arrayBuffer").mockRejectedValue(new Error("Do not re-read"));
    const report = await analyzePrepared(batch, ["0"], DEFAULT_THRESHOLD_PROFILE_SNAPSHOT);
    expect(report.records.map((row) => row.sessionId)).toEqual([72]);
    expect(report.inputs[0].sheetName).toBe("Incident");
    expect(read).not.toHaveBeenCalled();
  });

  it("isolates bad files and excludes unchecked files from results", async () => {
    const files = [
      new File(["session_id,collection_time\n51,2026-09-05T10:00:00Z"], "first.csv"),
      new File(["session_id,collection_time\n99,2026-09-05T11:00:00Z"], "excluded.csv"),
      new File([], "empty.csv"),
    ];
    const batch = await prepareAnalysis(files);
    expect(batch.previews.map((item) => item.usable)).toEqual([true, true, false]);
    const report = await analyzePrepared(batch, ["0"], DEFAULT_THRESHOLD_PROFILE_SNAPSHOT);
    expect(report.inputs.map((input) => input.fileName)).toEqual(["first.csv"]);
    expect(report.records.map((row) => row.sessionId)).toEqual([51]);
    await expect(analyzePrepared(batch, ["2"], DEFAULT_THRESHOLD_PROFILE_SNAPSHOT)).rejects.toThrow("not usable");
    await expect(analyzePrepared(batch, [], DEFAULT_THRESHOLD_PROFILE_SNAPSHOT)).rejects.toThrow("at least one");
  });

  it("uses supplied supplemental timestamps and leaves missing capture times unknown", async () => {
    const batch = await prepareAnalysis([
      new File(["session_id\n51"], "untimed.csv", { lastModified: Date.now() }),
      new File(["collection_time,Memory_Grants_Pending,Granted_Workspace_Memory_KB,Tempdb_Data_File_Size_KB\n2026-09-05T12:00:00Z,1,2048,4096"], "memory.csv"),
    ]);
    expect(batch.previews[0].firstCapturedAt).toBeNull();
    expect(batch.previews[1].firstCapturedAt).toBe("2026-09-05T12:00:00Z");
  });
});
