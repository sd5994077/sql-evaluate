import { File } from "node:buffer";
import * as XLSX from "xlsx";
import { describe, expect, it, vi } from "vitest";
import { createSpillTriageCase, prepareEvidenceFiles, commitEvidenceFiles, createDeepCaseArchive, openDeepCaseArchive } from "./case";
import { updateCaseDetails, validateCaseDetails } from "./metadata";
import { deepCaseJson, deepCaseFindingsCsv, deepCasePrintableHtml } from "./report";
import type { DeepAnalysisCase } from "./types";

describe("case tracking and prepared imports", () => {
  it("round-trips private metadata while omitting it from all redacted handoffs", async () => {
    const original = createSpillTriageCase();
    const edited = updateCaseDetails(original, { title: "PRIVATE TITLE", ticketReference: "SECRET-123", notes: "<img src=x onerror=alert(1)>PRIVATE NOTES", status: "Closed" });
    expect(edited.assertions).toBe(original.assertions);
    expect(edited.events.at(-1)?.summary).not.toContain("PRIVATE");
    const archive = await createDeepCaseArchive(edited, []);
    const reopened = await openDeepCaseArchive(new File([new Uint8Array(archive.bytes)], archive.fileName));
    expect(reopened.deepCase).toMatchObject({ schemaVersion: "1.5", title: edited.title, notes: edited.notes, ticketReference: edited.ticketReference, status: "Closed" });
    for (const output of [deepCaseJson(edited), deepCaseFindingsCsv(edited), deepCasePrintableHtml(edited)]) {
      expect(output).not.toContain("PRIVATE");
      expect(output).not.toContain("SECRET-123");
      expect(output).not.toContain("<img");
    }
    expect(updateCaseDetails(edited, { title: edited.title, notes: edited.notes!, ticketReference: edited.ticketReference!, status: edited.status! })).toBe(edited);
  });

  it.each(["1.0", "1.1", "1.2", "1.3", "1.4"] as const)("opens legacy schema %s with default human tracking fields", async (schemaVersion) => {
    const old: DeepAnalysisCase = { ...createSpillTriageCase(), schemaVersion, notes: undefined, ticketReference: undefined, status: undefined };
    const archive = await createDeepCaseArchive(old, []);
    const reopened = await openDeepCaseArchive(new File([new Uint8Array(archive.bytes)], archive.fileName));
    expect(reopened.deepCase).toMatchObject({ schemaVersion: "1.5", notes: "", ticketReference: "", status: "Investigating", title: old.title });
  });

  it("rejects invalid metadata both in the editor contract and a hash-valid archive", async () => {
    const valid = { title: "Incident", notes: "", ticketReference: "", status: "Investigating" };
    for (const invalid of [{ title: " " }, { title: "x".repeat(201) }, { notes: "x".repeat(20001) }, { notes: null }, { status: "Resolved" }]) {
      expect(() => validateCaseDetails({ ...valid, ...invalid })).toThrow();
    }
    const malformed = { ...createSpillTriageCase(), notes: null } as unknown as DeepAnalysisCase;
    const archive = await createDeepCaseArchive(malformed, []);
    await expect(openDeepCaseArchive(new File([new Uint8Array(archive.bytes)], archive.fileName))).rejects.toThrow("notes");
  });

  it("previews all workbook sheets and commits only selected prepared evidence without rereading", async () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["Total Spills", "Plan Handle"], [100, "0xAAA"]]), "Spills");
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["Explanation"], ["Fictional sample"]]), "Readme");
    const selected = new File([XLSX.write(workbook, { type: "buffer", bookType: "xlsx" })], "spills.xlsx");
    const excluded = new File(["Total Spills,Plan Handle\n900,0xBBB"], "excluded.csv");
    const original = createSpillTriageCase();
    const batch = await prepareEvidenceFiles(original, [selected, excluded]);
    expect(original.artifacts).toHaveLength(0);
    expect(batch.previews[0].worksheets).toEqual(["Spills", "Readme"]);
    const read = vi.spyOn(selected, "arrayBuffer").mockRejectedValue(new Error("Must not reread"));
    const result = commitEvidenceFiles(original, batch, new Set([selected]));
    expect(read).not.toHaveBeenCalled();
    expect(result.deepCase.artifacts).toHaveLength(1);
    expect(result.deepCase.spillTriage?.candidates).toHaveLength(1);
    expect(result.deepCase.spillTriage?.candidates[0].identity.planHandle).toBe("0xAAA");
    expect(() => commitEvidenceFiles(result.deepCase, batch)).toThrow("different case");
    const duplicates = await prepareEvidenceFiles(result.deepCase, [new File([XLSX.write(workbook, { type: "buffer", bookType: "xlsx" })], "renamed.xlsx")]);
    expect(commitEvidenceFiles(result.deepCase, duplicates).deepCase).toBe(result.deepCase);
  });
});
