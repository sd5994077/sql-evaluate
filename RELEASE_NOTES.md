# SQL Evaluate 1.3.0

Release date: 2026-08-28

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
