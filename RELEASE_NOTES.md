# SQL Evaluate 1.3.0

Release date: 2026-08-28

## Spill Triage update — 2026-09-02

- Added a fully offline two-stage Spill Triage workflow for version-tolerant CSV/XLSX `sp_BlitzCache` spill exports.
- Added deterministic cumulative and per-execution spill comparisons with explicit top-N, missing-value, malformed-value, and plan-variant disclosures.
- Added stable-identity-only connection to cached or actual Showplans. Estimated plans remain compile-only; actual plans can show spilling operator nodes, tempdb pages, grant details, and upstream row-estimate errors.
- Kept `Remove Plan Handle From Cache` source text behind a warning and out of routine next actions. SQL Evaluate still never executes SQL or changes cache state.
- Added Deep Analysis case schema 1.3, migration from schemas 1.0–1.2, persisted and revalidated manual statement choices, sanitized multi-shape fixtures, and accessible candidate-table interactions.
- Incorporated the second blind review: explicit byte/KiB/MiB/GiB spill units now convert transparently to 8 KB pages; workbook selection, header position, zero values, and identity conflicts are disclosed; candidate controls have unique accessible names; and actual-plan DOP, spill threads, and tempdb files are visible.
- Completed the post-review hardening: redacted handoffs now come from a structurally separate allowlist and cannot be reopened as working cases; Query Store matching is database-scoped; unrelated plans cannot supply misleading conflicts; duplicate files are removed before parsing; embedded plans honor detected header rows; and ambiguous strong statement matches can be explicitly selected and cleared.
- Added a third blind fixture that plants private sentinels and tests unit contradictions, duplicate plans, cross-database identity, ambiguity, persistence, and all three handoff formats.
- Verification completed with 251 passing tests, 1 intentional skip, a clean production type-check/build, zero audited vulnerabilities, and a 375×812 headless pass with no overflow, console errors, or non-local traffic.

## Post-review correctness update — 2026-08-29

- Native multi-task `sp_WhoIsActive` waits now retain task count and all supplied duration components while preserving the maximum-duration compatibility field.
- Malformed comma-grouped durations and invalid native task counts are rejected; specialized wait findings expose native task-count evidence when supplied.
- Showplan parsing now distinguishes ordinary predicates, seeks, residual predicates, and supported non-SARGable scan causes.
- Unicode leading-wildcard predicates such as `LIKE N'%value'` receive the same supported scan-cause treatment as non-Unicode literals.
- Any bounded finding family now discloses exact retained and suppressed counts in the audit view and exports.
- CSV exports neutralize spreadsheet-formula prefixes, and imported cap metadata is validated before use.
- The Activity view supports session filtering, sortable columns, paging, and direct navigation from a finding to all affected rows.
- Tabs now expose complete ARIA semantics, persistent controlled-panel targets, and keyboard navigation; desktop and 390×844 headless checks passed without console errors or document overflow.
- Automated verification completed with 87 passing tests, 1 intentionally skipped test, a passing production build, and zero audited dependency vulnerabilities.

## Highlights

- Deep Analysis now correlates WhoIsActive, native DMV, structured BlitzCache, Query Store export, and Showplan evidence using stable SQL Server identities and timestamps.
- The CPU-backed blocking narrative distinguishes observed facts, supported theory, contradictions, and unanswered questions.
- Plan capture now follows a visible escalation ladder and records a NULL lookup as evidence.
- Showplan analysis reports a matching query's explicit nonparallel reason instead of assuming parallelism would help.
- Redacted Deep Analysis JSON, CSV, and printable HTML are available separately from the sensitive working-case ZIP.

## Runtime and privacy

- Requires Node.js 20 or newer and a current Microsoft Edge or Google Chrome browser.
- Runs only on `127.0.0.1` and does not connect to SQL Server.
- Does not upload files, collect telemetry, or use AI services.
- Internet access is not required for normal use of the included production bundle.

## Important note

SQL Evaluate is an advisory review tool. Findings must be confirmed against approved, current DBA evidence before operational changes are made.
