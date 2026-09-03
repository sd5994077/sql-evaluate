import { File } from "node:buffer";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { addEvidenceFiles, createDeepCaseArchive, createSpillTriageCase, openDeepCaseArchive } from "./case";
import { deepCaseFindingsCsv, deepCaseJson, deepCasePrintableHtml } from "./report";
import { actualSpillOperators, earliestFeedingEstimateError, resolveCandidatePlan } from "./spillTriage";

function fixture(name: string, type: string): File {
  const path = fileURLToPath(new URL(`../../test-fixtures/spill-triage/${name}`, import.meta.url));
  return new File([readFileSync(path)], name, { type });
}

describe("Spill Triage integration", () => {
  it("ranks a BlitzCache export and diagnoses a stably matched actual plan", async () => {
    let deepCase = createSpillTriageCase("2026-09-02T15:00:00Z", "spill-integration");
    deepCase = (await addEvidenceFiles(deepCase, [fixture("current-expert.csv", "text/csv")], "2026-09-02T15:01:00Z")).deepCase;
    const first = deepCase.spillTriage!.candidates[0];
    expect(first.identity.planHandle).toBe("0xAAA");
    expect(first.rankReason).toContain("158,870 pages total");
    expect(deepCase.spillTriage!.candidates[1].identity.planHandle).toBe("0xBBB");
    expect(deepCaseJson(deepCase)).not.toMatch(/FREEPROCCACHE|0xAAA/);
    expect(deepCaseFindingsCsv(deepCase)).toContain("158870 total 8 KB pages");
    expect(deepCasePrintableHtml(deepCase)).toContain("Spill candidates");

    deepCase = (await addEvidenceFiles(deepCase, [fixture("actual-spills.sqlplan", "application/xml")], "2026-09-02T15:02:00Z")).deepCase;
    const resolution = resolveCandidatePlan(first, deepCase.spillTriage!.plans);
    expect(resolution).toMatchObject({ connected: true, quality: "Exact" });
    expect(deepCase.assertions.find((item) => item.id === "spill-candidates")?.state).toBe("Observed");
    expect(deepCase.assertions.find((item) => item.id === "plan-captured")?.state).toBe("Observed");
    expect(deepCase.narrative?.headline).toMatch(/Rank 1/i);
    const spills = actualSpillOperators(resolution.evidence!.plan, resolution.statement!);
    expect(spills).toHaveLength(2);
    expect(spills[0].spillDetails?.[0]).toMatchObject({ kind: "Sort", pagesWritten: 158870, grantedMemoryKb: 2751080 });
    expect(earliestFeedingEstimateError(resolution.statement!, spills[0])?.operator.nodeId).toBe(3);
  });

  it("connects an estimated plan without producing runtime spill operators", async () => {
    let deepCase = createSpillTriageCase("2026-09-02T15:00:00Z", "spill-estimated");
    deepCase = (await addEvidenceFiles(deepCase, [fixture("current-expert.csv", "text/csv"), fixture("cached-estimated.sqlplan", "application/xml")], "2026-09-02T15:01:00Z")).deepCase;
    const resolution = resolveCandidatePlan(deepCase.spillTriage!.candidates[0], deepCase.spillTriage!.plans);
    expect(resolution.connected).toBe(true);
    expect(resolution.evidence?.plan.isActual).toBe(false);
    expect(actualSpillOperators(resolution.evidence!.plan, resolution.statement!)).toEqual([]);
  });

  it("finds a version-tolerant result shape in a multi-sheet XLSX workbook", async () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["Instructions"], ["Export sp_BlitzCache results from SSMS."]]), "Read Me");
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
      ["Report generated locally"],
      ["TotalSpills", "AverageSpills", "Execution Count", "PlanHandle", "QueryHash", "QueryPlanHash", "Unknown Future Field"],
      [4096, 1024, 4, "0xXLSX", "0xX1", "0xX2", "preserved"],
    ]), "Spills");
    const bytes = XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
    const result = await addEvidenceFiles(createSpillTriageCase("2026-09-02T15:00:00Z", "xlsx-case"), [new File([bytes], "alternate.xlsx")], "2026-09-02T15:01:00Z");
    expect(result.deepCase.spillTriage?.candidates[0]).toMatchObject({ sheetName: "Spills", rank: 1 });
    expect(result.deepCase.spillTriage?.candidates[0].unknownColumns).toEqual([{ header: "Unknown Future Field", value: "preserved" }]);
  });

  it("round-trips a manual Spill Triage case and re-derives rankings from verified evidence", async () => {
    const evidence = fixture("current-expert.csv", "text/csv");
    const evaluated = await addEvidenceFiles(createSpillTriageCase("2026-09-02T15:00:00Z", "portable-spill"), [evidence], "2026-09-02T15:01:00Z");
    const archive = await createDeepCaseArchive(evaluated.deepCase, [evidence], "2026-09-02T15:02:00Z");
    const bytes = new Uint8Array(archive.bytes.byteLength); bytes.set(archive.bytes);
    const reopened = await openDeepCaseArchive(new File([bytes.buffer], archive.fileName, { type: "application/zip" }));
    expect(reopened.deepCase.schemaVersion).toBe("1.3");
    expect(reopened.deepCase.origin).toMatchObject({ kind: "manual" });
    expect(reopened.deepCase.spillTriage?.candidates[0]).toMatchObject({ rank: 1, totalSpillPages: { value: 158870 } });
  });
});
