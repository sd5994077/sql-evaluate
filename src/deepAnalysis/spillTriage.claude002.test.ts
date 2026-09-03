import { File } from "node:buffer";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { addEvidenceFiles, chooseSpillPlanStatement, clearSpillPlanStatement, createDeepCaseArchive, createSpillTriageCase, openDeepCaseArchive, selectSpillCandidate } from "./case";
import { actualSpillOperators, earliestFeedingEstimateError, resolveCandidatePlan } from "./spillTriage";

const fixtureRoot = fileURLToPath(new URL("../../fixtures/CLAUDE-SPILL-002/", import.meta.url));

function fixture(name: string, type = "application/octet-stream"): File {
  return new File([readFileSync(`${fixtureRoot}${name}`)], name, { type });
}

describe("CLAUDE-SPILL-002 fixture integrity", () => {
  it("exercises distinct ranking and stable-identity paths without relying on filenames", async () => {
    const evidence = [
      fixture("spill-review.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
      ...["a", "b", "c", "d", "e"].map((suffix) => fixture(`evidence-${suffix}.sqlplan`, "application/xml")),
    ];
    const result = await addEvidenceFiles(createSpillTriageCase("2026-09-02T15:00:00Z", "claude-spill-002"), evidence, "2026-09-02T15:01:00Z");
    const triage = result.deepCase.spillTriage!;
    const candidate = (objectName: string) => triage.candidates.find((item) => item.objectName === objectName)!;

    expect(triage.imports).toHaveLength(1);
    expect(triage.imports[0]).toMatchObject({
      sheetName: "Spill Review",
      headerRow: 6,
      importedRows: 10,
      ignoredSheets: [
        { sheetName: "Read Me", reason: "No supported spill header was detected." },
        { sheetName: "CPU Snapshot", reason: "No supported spill header was detected." },
      ],
    });
    expect(triage.candidates).toHaveLength(10);
    expect(triage.candidates.slice(0, 2).map((item) => item.objectName)).toEqual(["dbo.AuroraProcess", "dbo.AuroraConflict"]);
    expect(candidate("dbo.BeaconBatch").averageSpillPages).toMatchObject({ value: 70000, state: "derived" });
    expect(candidate("dbo.CipherLookup").identity.queryHash).toBe("0xC400");
    expect(triage.candidates.filter((item) => item.objectName === "dbo.CipherLookup")).toHaveLength(2);
    expect(candidate("dbo.HotelExplicitUnit").totalSpillPages).toMatchObject({ value: 102400, state: "imported" });
    expect(candidate("dbo.HotelExplicitUnit").unknownColumns).not.toEqual(expect.arrayContaining([{ header: "Total Spill MiB", value: 800 }]));

    const queryStore = resolveCandidatePlan(candidate("dbo.AuroraProcess"), triage.plans);
    expect(queryStore).toMatchObject({ connected: true, quality: "Exact" });
    expect(queryStore.reason).toContain("Query Store query 7001 and plan 7101");

    const sqlOffsets = resolveCandidatePlan(candidate("dbo.BeaconBatch"), triage.plans);
    expect(sqlOffsets).toMatchObject({ connected: true, quality: "Exact" });
    expect(sqlOffsets.reason).toContain("sql_handle and statement offsets");

    const cipherCandidates = triage.candidates.filter((item) => item.objectName === "dbo.CipherLookup");
    expect(resolveCandidatePlan(cipherCandidates.find((item) => item.identity.queryPlanHash === "0xC4A")!, triage.plans)).toMatchObject({ connected: true, quality: "Strong" });
    expect(resolveCandidatePlan(cipherCandidates.find((item) => item.identity.queryPlanHash === "0xC4B")!, triage.plans).connected).toBe(false);
    const echo = candidate("dbo.EchoAverageOnly");
    const echoAmbiguity = resolveCandidatePlan(echo, triage.plans);
    expect(echoAmbiguity).toMatchObject({ connected: false, ambiguous: true, quality: "Strong" });
    let manualCase = selectSpillCandidate(result.deepCase, echo.id);
    expect(manualCase.assertions.find((item) => item.id === "plan-captured")?.state).toBe("Not Evaluated");
    manualCase = chooseSpillPlanStatement(manualCase, echo.id, echoAmbiguity.alternatives[0].artifactId, echoAmbiguity.alternatives[0].statementId, "2026-09-02T15:02:00Z");
    expect(manualCase.assertions.find((item) => item.id === "plan-captured")?.state).toBe("Supported");
    expect(resolveCandidatePlan(echo, manualCase.spillTriage!.plans, manualCase.spillTriage!.manualPlanSelections[0])).toMatchObject({ connected: true, selectionMethod: "manual", quality: "Strong" });
    const archive = await createDeepCaseArchive(manualCase, evidence, "2026-09-02T15:02:30Z");
    const archiveBytes = new Uint8Array(archive.bytes.byteLength); archiveBytes.set(archive.bytes);
    const reopened = await openDeepCaseArchive(new File([archiveBytes.buffer], archive.fileName, { type: "application/zip" }));
    expect(reopened.deepCase.schemaVersion).toBe("1.3");
    expect(reopened.deepCase.spillTriage?.manualPlanSelections).toHaveLength(1);
    expect(reopened.deepCase.assertions.find((item) => item.id === "plan-captured")?.state).toBe("Supported");
    manualCase = clearSpillPlanStatement(manualCase, echo.id, "2026-09-02T15:03:00Z");
    expect(manualCase.assertions.find((item) => item.id === "plan-captured")?.state).toBe("Not Evaluated");
    expect(resolveCandidatePlan(candidate("dbo.AuroraConflict"), triage.plans).connected).toBe(false);
    expect(resolveCandidatePlan(candidate("dbo.DeltaQueryHashOnly"), triage.plans)).toMatchObject({ connected: false, quality: "Candidate" });

    const spills = actualSpillOperators(queryStore.evidence!.plan, queryStore.statement!);
    expect(spills).toHaveLength(1);
    expect(spills[0]).toMatchObject({ nodeId: 12, spillDetails: [{ kind: "Sort", spillLevel: 2, spilledThreadCount: 3, tempdbFileCount: 6, pagesWritten: 131072, pagesRead: null, grantedMemoryKb: 2097152, usedMemoryKb: 1966080 }] });
    expect(spills[0].spillDetails?.[0].rawAttributes).toMatchObject({ TempdbFileCount: "6" });
    expect(earliestFeedingEstimateError(queryStore.statement!, spills[0])).toMatchObject({ operator: { nodeId: 27 }, ratio: 1000000, distance: 2 });
    expect(queryStore.evidence?.plan.statements).toHaveLength(2);
    expect(actualSpillOperators(sqlOffsets.evidence!.plan, sqlOffsets.statement!)).toEqual([]);
  });
});
