import { File } from "node:buffer";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { addEvidenceFiles, chooseSpillPlanStatement, createSpillTriageCase, selectSpillCandidate } from "./case";
import { deepCaseFindingsCsv, deepCaseJson, deepCasePrintableHtml } from "./report";
import { resolveCandidatePlan } from "./spillTriage";

const fixtureRoot = fileURLToPath(new URL("../../fixtures/CLAUDE-SPILL-003/", import.meta.url));
const sentinel = "SENTINEL_PRIVATE_9033";

function fixture(name: string, type = "application/octet-stream"): File {
  return new File([readFileSync(`${fixtureRoot}${name}`)], name, { type });
}

describe("CLAUDE-SPILL-003 fixture integrity", () => {
  it("covers deduplication, scoped identity, manual ambiguity, units, and redaction", async () => {
    const files = [
      fixture(`${sentinel}-spill-review.xlsx`, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
      fixture("evidence-exact.sqlplan", "application/xml"),
      fixture("evidence-exact-duplicate.sqlplan", "application/xml"),
      fixture("evidence-cross-database.sqlplan", "application/xml"),
      fixture("evidence-ambiguous.sqlplan", "application/xml"),
    ];
    const result = await addEvidenceFiles(createSpillTriageCase("2026-09-02T18:00:00Z", "claude-spill-003"), files, "2026-09-02T18:01:00Z");
    const triage = result.deepCase.spillTriage!;
    expect(result.acceptedFiles).toHaveLength(4);
    expect(result.deepCase.artifacts).toHaveLength(4);
    expect(triage.plans).toHaveLength(3);
    expect(triage.imports[0]).toMatchObject({ headerRow: 6, importedRows: 5, rankableRows: 4 });
    expect(triage.candidates.map((candidate) => [candidate.objectName, candidate.totalSpillPages.value, candidate.rank])).toEqual([
      [`${sentinel}_Exact`, 900000, 1],
      [`${sentinel}_CrossDb`, 800000, 2],
      [`${sentinel}_Ambiguous`, 700000, 3],
      [`${sentinel}_ValidUnit`, 8192, 4],
      [`${sentinel}_UnitConflict`, null, null],
    ]);
    expect(triage.candidates.at(-1)?.totalSpillPages.explanation).toMatch(/conflicts/i);

    const candidate = (suffix: string) => triage.candidates.find((item) => item.objectName === `${sentinel}_${suffix}`)!;
    expect(resolveCandidatePlan(candidate("Exact"), triage.plans)).toMatchObject({ connected: true, quality: "Exact", selectionMethod: "automatic" });
    expect(resolveCandidatePlan(candidate("CrossDb"), triage.plans)).toMatchObject({ connected: false, blockedByConflict: true, quality: "None" });
    const ambiguous = resolveCandidatePlan(candidate("Ambiguous"), triage.plans);
    expect(ambiguous).toMatchObject({ connected: false, ambiguous: true, quality: "Strong" });
    expect(ambiguous.alternatives).toHaveLength(2);

    let manual = selectSpillCandidate(result.deepCase, candidate("Ambiguous").id);
    manual = chooseSpillPlanStatement(manual, candidate("Ambiguous").id, ambiguous.alternatives[1].artifactId, ambiguous.alternatives[1].statementId, "2026-09-02T18:02:00Z");
    expect(manual.assertions.find((assertion) => assertion.id === "plan-captured")?.state).toBe("Supported");
    expect(resolveCandidatePlan(candidate("Ambiguous"), manual.spillTriage!.plans, manual.spillTriage!.manualPlanSelections[0])).toMatchObject({ connected: true, selectionMethod: "manual" });

    const handoffs = [deepCaseJson(manual), deepCaseFindingsCsv(manual), deepCasePrintableHtml(manual)];
    handoffs.forEach((handoff) => expect(handoff).not.toContain(sentinel));
  });
});
