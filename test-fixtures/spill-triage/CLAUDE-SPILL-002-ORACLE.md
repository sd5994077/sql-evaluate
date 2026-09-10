# CLAUDE-SPILL-002 Private Review Oracle

Do not provide this file, its path, or its contents to the blind evaluator.

## Workbook

- `Read Me` and `CPU Snapshot` are not Spill Triage result sets.
- `Spill Review` contains the recognized header after five preamble rows and exactly ten evidence rows.
- The required ten-row disclosure is: “Ten rows were imported. This is consistent with `@Top = 10`; it does not prove that only ten cached plans spilled.”
- `Future Spill Class` is an unknown provenance column.
- `Total Spill MiB` is an explicitly labeled alternative unit. The product contract requires transparent conversion rather than silent loss. 800 MiB equals 102,400 8 KB pages.

## Contract ranking

If explicit-unit conversion is implemented, the expected ranking is:

1. AuroraProcess — 500,000 total / 50,000 average
2. AuroraConflict — identical metrics and timestamp; source order breaks the tie
3. BeaconBatch — 420,000 total / 70,000 derived average
4. CipherLookup A — 350,000 total / 70,000 average
5. CipherLookup B — 340,000 total / 85,000 average
6. HotelExplicitUnit — 102,400 converted total
7. DeltaQueryHashOnly — 90,000 total / 90,000 average
8. EchoAverageOnly — 120,000 average only
9. FoxtrotInconsistent — zero total / 60,000 average only

GolfMalformed remains visible and unranked. EchoAverageOnly is the highest per-execution candidate even though it follows every valid total-backed row.

The first blind run on 2026-09-02 found that the implementation did not recognize `Total Spill MiB`. This fixture now serves as the regression test: HotelExplicitUnit must be converted and ranked as shown above.

## Correlation

| Candidate | Evidence | Expected result |
|---|---|---|
| AuroraProcess | evidence-a | Exact connection through Query Store query 7001 and plan 7101 |
| BeaconBatch | evidence-b | Exact connection through SQL handle `0x0300` and offsets 0–200 |
| CipherLookup A | evidence-c | Strong connection through query hash `0xC400`, plan hash `0xC4A`, and database 7 |
| EchoAverageOnly | evidence-d | Ambiguous: two equally Strong batch-SQL-handle matches |
| AuroraConflict | evidence-e | No automatic connection because plan handles `0xAA02` and `0xBB02` conflict despite shared Query Store IDs |
| DeltaQueryHashOnly | evidence-e | Candidate-only query-hash lead; no automatic connection |
| CipherLookup B | any | No connection; it remains a distinct `0xC4B` plan variant |

A generic “no supported stable identifier” message for AuroraConflict blocks unsafe matching but fails to disclose the actual conflict; report this as a clarity defect if the UI gives no conflict detail.

## Actual and estimated evidence

- Only AuroraProcess has actual runtime evidence.
- The matched statement has Sort node 12, spill level 2, three threads, 131,072 pages written, no pages-read value, 2,097,152 KB granted, and 1,966,080 KB used.
- The earliest qualifying feeding estimate error is node 27, estimated 5 versus 5,000,000 actual rows, ratio 1,000,000×, two input hops from the spill.
- The unrelated second statement in evidence-a must not contribute spill evidence.
- evidence-b and evidence-c are estimated/cached plans and must not display runtime spill volumes or actual row counts.

## Safety, persistence, and accessibility

- The GolfMalformed `DBCC FREEPROCCACHE` command is provenance, not remediation, and must have no execute action.
- Saving and reopening the case must preserve or rederive the workbook candidates, selection, plan evidence, ranking, correlation state, and Data Quality messages.
- Candidate buttons must support Tab and Enter, expose selected state in text/ARIA, and retain focus predictably.
- At 375×812 there must be no document-level horizontal overflow; primary candidate information must remain available without color alone.
- Browser console errors are defects unless clearly caused by the development server tooling rather than SQL Evaluate.

## Grading

Classify each Claude observation as one of: confirmed product defect, correct behavior, fixture defect, evaluator miss, or harmless wording variation. Do not fix behavior until the blind report has been compared with this oracle.
