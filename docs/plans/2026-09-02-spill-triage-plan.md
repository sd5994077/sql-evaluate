# Spill Triage Implementation Plan

## Summary

Add an offline Deep Analysis workflow that imports version-tolerant `sp_BlitzCache` spill exports, identifies the highest-priority cached plan variant through an explainable ordered comparison, and connects the selected row to cached or actual Showplan evidence using stable SQL Server identities.

The MVP has two stages: candidate selection and plan diagnosis. It never connects to SQL Server, executes SQL, evicts plans, or performs network/database writes.

## Implementation Status — 2026-09-02

Implemented and verified, including the post-review remediation. Three blind-test fixture packages are present; the second review is archived under `docs/reviews/2026-09-02-claude-spill-002-evaluation.md`, while `CLAUDE-SPILL-003` is ready for an independent Claude run covering deduplication, unit contradictions, database-scoped Query Store identity, manual statement disambiguation, and handoff redaction sentinels. Case schema 1.3 persists validated manual choices while continuing to migrate 1.0–1.2 cases.

The remediation also replaces spread-based handoff redaction with a separate allowlisted, non-reopenable report DTO; applies one conflict-aware identity matcher; discovers embedded plans from the detected worksheet header; removes duplicate evidence before parsing; clamps pagination; and derives Spill Triage assertions and narrative from the selected candidate. The completed automated suite has 252 tests: 251 passing and 1 intentional skip. The production type-check/build and dependency audit pass with zero vulnerabilities. Headless verification at 375×812 confirmed keyboard activation, manual choice/clear behavior, database-conflict wording, no document overflow, an empty console/error log, and localhost-only traffic.

## Current Behavior and Gaps

- `src/rules/engine.ts:719-790` detects actual-plan row-estimate errors and Sort/Hash spill warnings, but does not expose structured spill volume or feeding-operator topology.
- `src/lib/showplan.ts:50-115` parses runtime rows and warning presence but not tempdb pages, spill levels, operator grant details, or parent/child relationships.
- `src/deepAnalysis/adapters.ts:49-93,290-304` preserves stable identities and BlitzCache warnings but does not normalize or rank numeric spill fields.
- `src/deepAnalysis/correlation.ts:24-50` already supports plan handle, SQL handle/offsets, query/plan hashes, Query Store IDs, and database context without SQL-text matching.
- `src/deepAnalysis/case.ts:361-501` imports evidence but has no row-level spill candidate state or manual case origin.
- `src/components/DeepAnalysisWorkspace.tsx:51-135` has no standalone Spill Triage entry point, ranked candidate list, or candidate-specific plan chooser.
- `src/App.tsx:356-366` separates plans and Data Quality but cannot guide a DBA from a BlitzCache row to operator evidence.

## User Flow and Messaging

1. Start Spill Triage from the landing page, Deep Analysis empty state, or a `PLAN-SPILL` finding.
2. Import CSV/XLSX evidence. Display imported/rankable counts and warn that the result can be a bounded top-N set.
3. Show separate highest cumulative and highest per-execution candidates plus a semantic, keyboard-operable table.
4. Explain the selected rank with actual imported or transparently derived values. Use “highest-priority spill candidate,” never “root cause” or “offending plan.”
5. Attempt stable-identity plan correlation. If absent, weak, conflicting, or ambiguous, keep the evidence visibly uncorrelated and show **Choose matching plan**.
6. For cached/estimated plans, show compile shape only. For actual plans, show spill node, pages read/written, grant details, and the earliest major estimate error in the spilling input subtree.

Required copy includes:

- “Ten rows were imported. This is consistent with `@Top = 10`; it does not prove that only ten cached plans spilled.”
- “SQL Evaluate ranked these imported rows locally. The export does not prove which parameters produced it.”
- “This command came from the source export. It changes SQL Server cache state, is not a recommendation from SQL Evaluate, and is never executed here.”

## Normalization and Ranking

- Detect a header within the first 50 non-empty rows of every sheet using explicit aliases and a compound spill-plus-BlitzCache signature.
- Normalize total/average/minimum/maximum spill pages; executions; last execution; total/average CPU, duration, and reads; database/object context; stable identities; embedded plan XML; warnings; administrative text; and unknown fields.
- Preserve raw header/value, normalized value/unit, and state: imported, derived, missing, zero/nonpositive, or invalid.
- Treat canonical BlitzCache spill values as 8 KB pages. Convert other units only when explicitly supplied.
- Derive average only from valid total pages and a positive execution count when imported average is absent.
- Rank total-backed rows by total pages, average pages, last execution, then source order.
- Rank average-only rows after every total-backed row by average pages, last execution, then source order.
- Keep warning-only, zero, malformed, and missing numeric evidence visible but unranked.
- Keep CPU, duration, and reads as supporting context rather than a synthetic score.
- Retain different plan handles for one query hash as distinct candidates.

## Correlation and Diagnosis

- Correlation precedence: Query Store query/plan IDs; plan handle; SQL handle plus offsets; query hash plus query-plan hash in compatible database context.
- Query hash alone is a candidate lead and never a connection.
- Conflicting shared identities block automatic connection; SQL-text similarity is never used.
- Auto-connect only one unique Exact or Strong plan/statement match.
- Parse operator input topology and structured Sort/Hash spill attributes defensively, preserving unknown attributes.
- For actual plans, traverse only the spilling operator’s descendants and apply the active profile’s medium estimate-ratio and row-count thresholds. Choose the furthest qualifying input toward a data-source leaf; break ties by ratio, actual rows, then node ID.
- Never infer runtime operator evidence from cached plans or imported cumulative BlitzCache values.

## Data Quality, Safety, Accessibility, and Performance

- Disclose recognized sheets/headers, missing metrics, derived values, invalid cells, timestamp limitations, incomplete/conflicting identities, warning-only rows, unknown columns, and top-N ambiguity.
- Preserve unknown fields and administrative text as provenance; omit them from default redacted exports.
- Hide cache-removal commands behind an explicit administrative warning, with no routine copy or execute action.
- Use semantic tables, scoped headers, `aria-sort`, keyboard-operable selection, live status announcements, text-plus-color states, full labels for truncated identities, and responsive stacking.
- Parse each sheet once, rank in `O(n log n)`, index plan identities, defer embedded XML work where practical, paginate at 50 rows, and bound detailed quality examples.

## Implementation Phases

1. Add sanitized fixtures, canonical types, version-tolerant normalization, Data Quality states, deterministic ranking, and unit tests.
2. Add the `spill-triage` profile, manual case origin, schema 1.3 migration, candidate persistence, validated manual statement choices, and archive revalidation.
3. Add landing/Deep Analysis entry points, candidate selection, explanations, top-N disclosure, and case-scoped Data Quality UI.
4. Add Showplan topology and structured spill details while preserving existing finding behavior.
5. Add indexed stable-identity plan resolution, actual/estimated evidence separation, and operator diagnosis.
6. Guard administrative provenance, update redaction/docs/release notes, and complete automated and browser verification.

## Tests and Acceptance

- Cover current, legacy, warning-only, malformed, zero, missing-time, multi-sheet XLSX, unknown-column, top-N, and multiple-plan-variant imports.
- Cover cumulative ordering, average-only ordering, deterministic ties, explanations, and the separate highest-per-execution callout.
- Cover every stable identity path, conflicts, query-hash-only rejection, ambiguity, unmatched plans, and expired-plan wording.
- Cover Sort/Hash attributes, topology, upstream estimate selection, estimated-plan limitations, case migration/round-trip, redaction, accessibility, responsive layout, and large-workbook behavior.
- Run focused Vitest suites, `npm test`, `npm run build`, `npm audit`, and browser interaction checks.

Acceptance requires a supported export to produce an explained ranking; cumulative and per-execution severity to remain distinct; top-N ambiguity to be visible; plan connection to require stable identity; unmatched plans to remain uncorrelated; actual and estimated plans to make different claims; administrative cache commands to remain non-remedial; and all existing spill, estimate, Deep Analysis, privacy, export, and Data Quality tests to continue passing.

## Risks, Defaults, and Non-Goals

- Contain schema variation in an explicit alias registry and preserve unsupported fields.
- Missing values never become zero; weak identities never become matches.
- Default to cumulative impact while highlighting the highest average severity separately.
- Defer alternate ranking views, history/trends, live Query Store retrieval, workers unless benchmarks require one, support for unrelated First Responder Kit result sets, SQL execution, cache eviction, and automated remediation.
