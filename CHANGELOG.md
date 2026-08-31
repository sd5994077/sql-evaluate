# Changelog

All notable changes to SQL Evaluate are documented here.

## Unreleased — 2026-08-31

### Added

- Added configurable **threshold profiles**: every diagnostic threshold (blocking, resources, waits, worker exhaustion, compilation pressure, transactions, and plans) is now supplied by a validated, versioned, SHA-256–digested profile. The built-in `builtin.default` profile preserves SQL Evaluate 1.3.0 behavior exactly.
- Added a **Threshold Profile Manager** panel: size-limited import with a store-before-activate preview, export of the active profile, cloning of the published defaults, deletion of custom profiles, an exact-thresholds disclosure, and a reminder that profile names appear in reports and exports. Profiles and the active selection persist locally; invalid or conflicting stored profiles are quarantined with a warning rather than blocking startup.
- Recorded the resolved threshold profile (name, id, version, and SHA-256 digest) in every report and in the Data Quality view, JSON, CSV, printable HTML, and run archive; report export is refused when no profile was resolved.
- Added **supplemental evidence** recognition in the base analysis: scheduler, worker-thread, compilation, memory, and Query Store counter exports (CSV/TSV) are now recognized and used to corroborate findings instead of being rejected as non-`sp_WhoIsActive` input.
- Added the **`WIA-SCHEDULER-PRESSURE`** rule: it correlates a runnable, CPU-consuming head blocker with sustained `SOS_SCHEDULER_YIELD` waits and three independently rising server scheduler counters, and frames the blocking chain as a downstream effect of CPU pressure rather than the primary condition.
- Added a **Critical** severity level. Worker-thread pool exhaustion is raised to Critical only when supplemental worker counters confirm active workers reached the configured ceiling while the work queue was still growing; compilation-pressure confidence rises when compilation/batch counters corroborate the wait.
- Added an explicit **healthy-capture** result: when at least two capture points contain no actionable finding, the report states a clean baseline instead of leaving it unsaid.
- Added **compile and optimizer context** as finding qualifications — compile time, compile CPU, compile memory, optimizer early-abort reason, and optimization level are surfaced as "context only" or "observed" and are never interpreted as severity.
- Added a twelve-case opaque **stress-test suite** (`fixtures/STRESS-01`–`STRESS-12`) and a `tools/stress-run.ts` runner covering threshold boundaries, special negative blocking owners, conflicting `THREADPOOL`/compile-semaphore waits, benign-wait suppression, missing-column Not Evaluated behavior, awkward-but-valid ingestion (multi-sheet workbooks, UTF-16LE tab-delimited files, grouped-integer wait strings, duplicate headers), and embedded-vs-standalone plan correlation.

### Fixed

- Parsed native single-task and multi-task `sp_WhoIsActive` wait strings without losing task count or individual durations; malformed parenthesized waits now produce a data-quality warning instead of a fabricated wait type.
- Rejected malformed comma-grouped wait durations and invalid native task counts; worker and compilation findings now expose the maximum native task count when supplied.
- Separated ordinary predicates, seek predicates, explicit residuals, and supported non-SARGable scan causes so clean scans and scalar-UDF plans are not mislabeled.
- Recognized Unicode `LIKE N'%…'` leading-wildcard predicates as supported non-SARGable scan evidence.
- Reset finding and activity filters when a new capture or saved report is opened, preventing stale record IDs from hiding the new report's activity.
- Neutralized spreadsheet-formula prefixes in CSV exports and rejected invalid cap metadata during report import.
- Disclosed the analyzed workbook and worksheet name in Data Quality and every export so multi-sheet workbook selection is auditable.
- Listed "Runtime plan checks" among the Not Evaluated rule groups whenever an estimated-only plan yields `PLAN-RUNTIME-UNAVAILABLE`, so the count of unavailable groups is complete.
- Stopped treating a hash join's `ProbeResidual` equality verification as an access-path residual predicate, preventing a spurious residual-predicate finding on clean hash joins.
- Rejected non-finite, negative, or non-numeric Showplan `CompileTime`, `CompileCPU`, and `CompileMemory` attributes with a plan warning instead of coercing them.
- Constrained optimizer tokens and compile values echoed into findings and exports to a safe character set, with a redaction fallback, and validated the new qualification and compile fields (bounded lengths, ordered kinds) during report import.

### Improved

- Centralized resource, wait, and transaction finding caps and disclosed retained count, suppressed count, rule, and ordering in Data Quality, JSON, CSV, printable HTML, and run archives.
- Added accessible tab semantics and Left/Right/Home/End navigation.
- Kept every tab's controlled panel target in the DOM and added automated UI coverage for tab relationships, keyboard focus, and report-state reset.
- Added session filtering, sortable columns, 100-row paging, and direct affected-row navigation to the Activity view.

### Changed

- `processInputFiles` now requires a threshold-profile snapshot in its options and verifies its digest before analysis; `analyze` accepts the resolved profile and optional supplemental evidence; `findingsCsv` accepts the full report; report validation is split into a synchronous `validateReportShape` and an async `validateReport` that performs digest verification. Imported reports without a resolved profile are marked legacy rather than rejected.

### Verified

- Full suite: 199 passed, 1 intentionally skipped; `tsc -b` type-check, production build, and dependency audit all clean (zero vulnerabilities).
- `tools/stress-run.ts` reports all twelve `STRESS` packages passing against the built-in default profile.
- Headless desktop and 390×844 checks passed for keyboard tabs, affected-row navigation, activity paging/filtering/sorting, cap disclosure, console errors, and horizontal overflow.
- Browser traffic remained limited to `127.0.0.1` during verification.

## 1.3.0 — 2026-08-28

### Added

- Added case schema 1.1 with incident windows, stable query identities, typed observations, plan-capture attempts, assertion history, and evidence-dependent narratives.
- Added deterministic correlation using session/request/transaction IDs, SQL and plan handles, query/plan hashes, statement offsets, Query Store IDs, and capture-time overlap.
- Added structured native diagnostic adapters for repeated scheduler samples, exact lock-resource matches, memory grants, and compilation/batch counter deltas.
- Added a version-tolerant `sp_BlitzCache` adapter that keeps individual warnings distinct and calculates single-use percentages only from valid plan-cache inventories.
- Added Showplan parsing for query identity, compile context, DOP, `NonParallelPlanReason`, scalar functions, and residual predicates.
- Added live, last-known-actual, Query Store, and separately approved Extended Events plan-capture recipes.
- Added a generated DBA investigation narrative, capture-attempt history, escalation ladder, artifact recognition details, and redacted case JSON/CSV/HTML exports.
- Added a staged synthetic acceptance case for root SPID 104, intermediate blocking, four victims, scheduler pressure, a 35,600-plan cache, a NULL lookup, and a later matching plan.

### Correctness

- A single runnable scheduler observation no longer supports sustained CPU pressure.
- An unused memory grant does not establish server-level memory-grant pressure.
- Forced serialization is not presented as a reason to add parallelism; the exact plan reason is reported only when matching Showplan supplies it.
- SQL-text similarity cannot upgrade a causal link.
- Evidence outside the incident window remains contextual.

## 1.2.0 — 2026-08-27

### Added

- Added a **Deep Analysis** workbench with a ready CPU-backed blocking investigation profile.
- Added a causal evidence rail that distinguishes Observed, Supported, Contradicted, and Not Evaluated claims.
- Added a bounded, read-only manual collection recipe covering requests, same-moment cached plans, schedulers, transactions, locks, memory grants, and compilation counters.
- Added imports for CSV, TSV, XLSX, XML, SQLPLAN, JSON, and text evidence files.
- Added sensitive `.sqlevalcase.zip` archives with evidence hashes, an audit history, integrity validation, and reopen support.
- Added direct Deep Analysis launch actions to blocking finding details and focused recommendations for consequential blockers.

### Improved

- Conflicting time-window evidence now prevents the application from presenting a causal theory as established.
- An unused memory grant no longer implies server-level memory-grant pressure without pending grants or `RESOURCE_SEMAPHORE` evidence.
- Plan-cache symptoms, scheduler pressure, lock ownership, transaction state, and plan availability are evaluated independently before being connected.

### Verified

- Tested the CPU-backed blocking scenario using synthetic scheduler, lock, and plan-cache evidence.
- Verified case save/reopen integrity and rejection of tampered evidence.
- Verified the production build in a headed browser at desktop and mobile sizes.

## 1.1.3 — 2026-08-25

### Improved

- Increased typography across the main dashboard, including findings rows, KPI captions, tabs, filters, activity tables, data-quality details, buttons, and footer text.
- Increased findings-row height and table spacing to preserve legibility with the larger type.
- Improved secondary-text contrast without changing the dashboard's established visual design.
- Added a standalone operating guide that explains local runtime, inputs, analysis limits, privacy, exports, and development workflow using fictional test objects only.
- Added recipient quick-start and troubleshooting instructions, third-party notices, bundled license handling, release-file checksums, and an automated clean-release packaging script.

## 1.1.2 — 2026-08-25

### Improved

- Increased the findings drawer width from 640px to 700px on larger screens.
- Increased body, evidence, limitation, timeline, diagnostic-tool, command, reference, and caution text sizes in the findings drawer.
- Improved secondary-text contrast while preserving the existing diagnostic-console design.

## 1.1.1 — 2026-08-25

### Fixed

- SQL Server negative `blocking_session_id` values (`-2` through `-5`) are now classified as special owner states instead of being presented as blocker SPIDs.
- `blocking_session_id = -5` is reported as an informational unidentified latch-owner state and is no longer counted as direct blocking evidence.
- A one-victim block observed in one capture is now Low instead of Medium.
- A wait observed in only one capture no longer becomes High solely because a blocking relationship is present; High requires persistence or repeated capture evidence.

### Improved

- TempDB current usage is displayed as pages plus calculated MB or GB in findings and activity rows.
- Data Quality now explains that per-session TempDB pages cannot establish overall TempDB utilization, free space inside the data files, or Windows volume headroom.
- The activity signal no longer treats negative SQL Server blocking-owner codes as user-session blocking.

### Verified

- Re-evaluated `capture2.xlsx` after the rule corrections and reconciled the row count, collection span, duplicate columns, TempDB leader, and finding distribution against the source capture.

## 1.1.0 — 2026-08-25

### Added

- Added **Save Run ZIP** for one-file archival of each completed analysis without database storage.
- Added a versioned run manifest with a unique run ID, timestamps, source SHA-256 checksums, input/output counts, and the application version.
- Added normalized activity CSV and processing diagnostics to run archives.
- Added regression coverage for workbooks shaped like the extended SQL Agent capture export, including duplicate WhoIsActive column blocks and text `NULL` values.
- Added phase-specific worker processing errors and browser message-transfer diagnostics.

### Changed

- Duplicate headers are now identified in Data Quality while all duplicate values remain preserved with numbered suffixes.
- Raw source files are included in run archives only after the user enables **Include raw details** and accepts the warning.
- The footer now displays the application version.

### Verified

- Imported and analyzed `capture2.xlsx`: 454 activity rows and 85 collection points.
- Confirmed the workbook succeeds through both the development server and the production bundle.

## 1.0.0 — 2026-08-23

- Initial offline WhoIsActive and Showplan analyzer.
- Added evidence-based findings, data-quality reporting, redacted JSON/CSV/HTML exports, and local-only browser processing.
