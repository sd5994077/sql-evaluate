# Diagnostic Accuracy Remediation Plan

## Objective

Raise SQL Evaluate from 1 Pass / 4 Partial / 5 Fail on the blinded suite to dependable DBA triage without adding opaque scoring, database connections, internet access, or automatic remediation.

The private answer key is test evidence, not the product specification. Existing published thresholds remain authoritative where they conflict with the key. In particular:

- SQL Evaluate keeps `High`, `Medium`, `Low`, `Informational`, and `Not Evaluated`; a fixture marked `Critical` maps to `High` with an urgent severity explanation.
- CASE-006's approximately 19x unused grant and more than 700 MB of waste meets the existing High threshold even though the fixture key calls the overall case Medium.

## Phase 1 — Lock the failures into regression tests

- Add an external-fixture integration harness that loads each `fixtures/CASE-*` package through the production ingestion path.
- Encode observable expectations without reading or distributing the private answer-key file at runtime.
- Assert primary diagnosis, severity range, confidence basis, required limitations, prohibited conclusions, Deep Analysis routing, and finding-count ceilings.
- Keep the user's real workbook external and read-only.

Acceptance:

- Every current miss or false positive fails a targeted test before rule changes begin.
- Tests identify a case by opaque case ID, never by embedding a diagnosis in source data.

## Phase 2 — Remove low-value noise and consolidate episodes

Primary files: `src/rules/engine.ts`, `src/lib/normalize.ts`, `src/rules/engine.test.ts`.

- Do not emit 0 ms benign/client waits as concerns.
- Do not flag very short open transactions unless they block, are sleeping with retained work, or cross the configured age threshold.
- Require a meaningful duration, non-zero delta, or corroborating signal before labeling short activity as a resource outlier.
- Prevent `repeated >= 3` from escalating a trivially small request merely because it is capture-relative rank 100.
- Consolidate adjacent observations of the same session/request/query fingerprint into one episode-level finding.
- Represent an isolated sub-second blocking or schema-lock observation as at most one Informational/Low-confidence item with explicit non-persistence language.

Acceptance:

- CASE-001: no High/Medium/Low findings and no Deep Analysis recommendation.
- CASE-009: at most one Informational or Low finding for the isolated blip; no generic resource flood and no Deep Analysis recommendation.
- The original `capture.csv.xlsx` retains its meaningful blocking, compilation-memory-wait, and sustained-resource signals with fewer duplicate rows.

## Phase 3 — Add high-risk wait-family reasoning

Primary files: `src/lib/normalize.ts`, `src/rules/engine.ts`, `src/rules/catalog.ts`.

- Treat `THREADPOOL` as a worker-exhaustion signal rather than a generic duration-based wait.
- Escalate persistent `THREADPOOL` observations using recurrence, concurrency growth, zero-task evidence, and worker counters even when the reported per-row wait duration is zero.
- Treat `RESOURCE_SEMAPHORE_QUERY_COMPILE` separately from query execution memory-grant waits.
- Correlate compile waits with concurrent structurally similar ad-hoc statements, compilation counters, cache-hit movement, and single-use-plan evidence.
- Keep `RESOURCE_SEMAPHORE` mapped to execution memory grants, spills, and pending grant pressure.
- Map urgent worker exhaustion to High while explicitly stating that SQL Evaluate has no Critical severity.

Acceptance:

- CASE-004: compile-memory/plan-cache pressure is the primary Medium-or-High finding with High confidence after counters are imported.
- CASE-005: one consolidated High worker-exhaustion finding replaces per-session Low THREADPOOL findings.
- CASE-004 and CASE-006 can never be conflated solely because both names contain `RESOURCE_SEMAPHORE`.

## Phase 4 — Complete direct Showplan diagnostics

Primary files: `src/lib/showplan.ts`, `src/types.ts`, `src/rules/engine.ts`, `src/lib/showplan.test.ts`.

- Preserve structured warning details rather than only display strings.
- Recognize spills across supported Showplan shapes, including nested `SpillToTempDb`, `SortSpillDetails`, and `HashSpillDetails` elements.
- Add a forced-serialization rule using `DegreeOfParallelism`, `NonParallelPlanReason`, available DOP, and scalar-UDF evidence.
- Capture UDF identity when present without exposing literals in redacted exports.
- Add plan-affecting implicit-conversion findings using `PlanAffectingConvert` and its expression.
- Detect residual predicates and non-SARGable patterns only when the XML directly supplies the expression and access-path evidence.
- Make scan/I/O symptoms secondary related signals when a supported predicate or conversion cause is available.

Acceptance:

- CASE-006: explicit spill, oversized grant, and estimate-error findings are all present and correctly related.
- CASE-007: forced serialization and scalar UDF are the primary diagnosis; generic CPU use is supporting evidence.
- CASE-008: implicit conversion and non-SARGable residual predicate are primary; `PAGEIOLATCH_SH` is described as a possible downstream symptom rather than storage proof.

## Phase 5 — Route findings to the correct Deep Analysis profile

Primary files: `src/deepAnalysis/profile.ts`, `src/deepAnalysis/case.ts`, `src/deepAnalysis/evaluator.ts`, `src/deepAnalysis/adapters.ts`, `src/components/DeepAnalysisWorkspace.tsx`, `src/components/FindingDrawer.tsx`.

- Replace the blocking-only launcher with a profile registry and deterministic applicability rules.
- Split sleeping/open-transaction blocking from CPU-backed blocking.
- Add ready profiles for:
  - Transaction-owned blocking
  - CPU/scheduler-backed blocking
  - Worker exhaustion
  - Compilation and plan-cache pressure
  - Execution memory grants and spills
  - Plan-specific serialization/conversion investigation
  - Actual-plan acquisition for estimated-only evidence
- Allow companion counter files to enter through the applicable case workflow; do not accept them as `sp_WhoIsActive` front-door inputs.
- Generate profile-specific collection SQL, assertions, cautions, and evidence adapters.
- Preserve the evidence ledger states: Observed, Supported, Contradicted, and Not Evaluated.

Acceptance:

- CASE-002 launches transaction-owned blocking, never a case titled CPU-backed blocking.
- CASE-003 continues to support scheduler pressure and contradict an unsupported transaction theory after evidence import.
- CASE-004, CASE-005, and CASE-006 each offer the appropriate Deep Analysis workflow.
- CASE-010 recommends a representative actual plan and does not invent runtime evidence.

## Phase 6 — UI, exports, and compatibility

- Present one primary diagnosis followed by related supporting signals, reducing repetitive findings-grid noise.
- Show why a signal was suppressed or treated as Informational in the data-quality/audit view.
- Include the corrected primary diagnosis, related evidence, limitations, and Deep Analysis profile in JSON, CSV, printable HTML, and case ZIP exports.
- Preserve schema `1.0` report compatibility and existing case schema support.
- Maintain default redaction of SQL, plans, identifiers, and literals.

Acceptance:

- Keyboard navigation, responsive layout, zero horizontal overflow, and copy/export controls remain intact.
- Old `.sqleval.json` and `.sqlevalcase.zip` files reopen normally.
- No raw sensitive fields appear in default exports.

## Phase 7 — Verification gate

- Run unit tests for thresholds, episode grouping, wait specialization, Showplan shapes, routing, adapters, redaction, and backward compatibility.
- Re-run all ten blinded fixtures through the production browser.
- Re-run `capture.csv.xlsx` as the external real-workbook integration test.
- Run the full test/build/audit command and verify no outbound browser requests.
- Save a new comparison report without overwriting the original blinded baseline.

Release acceptance:

- CASE-001, CASE-002, CASE-003, CASE-004, CASE-005, CASE-007, CASE-008, CASE-009, and CASE-010 meet their ground-truth diagnostic intent.
- CASE-006 meets SQL Evaluate's published memory-grant thresholds while also surfacing the missing spill and remediation path.
- No case crashes, no missing-column failure disables unrelated rules, and no fixture requires access to the private answer key at runtime.
- Full tests and production build pass with zero known high-risk dependency vulnerabilities.

## Initial quality-pass closure — completed 2026-08-29, reopened by independent review

- Hardened every default report/export boundary so derived Showplan expressions, query identities, SQL identifiers, literals, and raw original values cannot bypass redaction.
- Removed Deep Analysis routing and launch actions from isolated Informational blocking observations.
- Replaced first-operator warning assignment with expression-aware Showplan correlation.
- Aligned worker, compilation, plan-cache, and actual-plan collection workflows with their evidence adapters and approval model.
- Replaced quadratic grouping and repeated blocker scans with linear-time maps and sets; added a 20,000-row regression.
- Added pre-extraction ZIP expansion validation while retaining post-extraction verification.
- Re-ran all ten fixture packages in the headless production browser, default-export privacy checks, mobile overflow checks, the full automated suite, production build, and dependency audit.

The fixture-focused remediation above remains valid, but the independent teardown identified production-shaped inputs and disclosure paths that the blinded fixtures did not cover. The items below are required before the next release can be described as fully remediated.

## Phase 8 — Post-review correctness and disclosure

Status: **Completed and verified 2026-08-29.** Phase 8E remains deliberately deferred post-release design work.

### 8A — Parse every documented sp_WhoIsActive wait shape — completed

Priority: release blocker.

Primary files: `src/lib/normalize.ts`, `src/types.ts`, `src/lib/normalize.test.ts`, and production-path integration tests.

- [x] Replace the single-duration-only parser with a structured parser supporting:
  - Single-task waits such as `(1200ms)LCK_M_X`.
  - Two-task waits such as `(2x: 1200ms/1800ms)CXPACKET`.
  - Three-or-more-task summaries such as `(4x: 1200ms/1500ms/2000ms)THREADPOOL`.
  - Comma-formatted numbers, optional whitespace, and the documented page-latch or parallel-node detail suffixes.
- [x] Preserve task count and each supplied duration component instead of discarding the multi-task evidence. Continue exposing a maximum duration for existing severity calculations.
- [x] Retain the current `waittime=` fallback for non-native exports and existing fixtures; compatibility input must not override a successfully parsed native value.
- [x] Treat malformed parenthesized values as unparsed data with an explicit data-quality warning. Never emit fragments such as `(4x` as a wait type or finding title.
- [x] Keep specialized THREADPOOL and compile-pressure reasoning based on explicit wait family, recurrence, and concurrency. Do not require a positive duration when the family and persistence evidence are otherwise valid.

Acceptance:

- [x] Unit tests cover single-task, two-task, three-or-more-task, comma-formatted, detailed, and malformed wait strings.
- [x] A native multi-task THREADPOOL sample produces one consolidated worker-exhaustion finding with the correct type, task count, maximum duration, and affected records.
- [x] A native multi-task parallelism wait remains contextual and cannot be mislabeled as `Other`.
- [x] CASE-004 and CASE-005 continue to pass with their existing compatibility encoding.

### 8B — Separate ordinary predicates from residual and non-SARGable evidence — completed

Priority: release blocker.

Primary files: `src/lib/showplan.ts`, `src/types.ts`, `src/rules/engine.ts`, `src/deepAnalysis/case.ts`, `src/lib/showplan.test.ts`, and `src/rules/engine.test.ts`.

- [x] Represent seek predicates, ordinary scan/filter predicates, probe residuals, and explicit residuals as distinct structured fields.
- [x] Remove the unconditional `Residual predicate` warning for every `<Predicate>` element.
- [x] Emit `PLAN-RESIDUAL-PREDICATE` only when Showplan directly supplies residual access-path evidence or when a supported expression pattern establishes a non-SARGable scan cause, such as a plan-affecting conversion or a leading-wildcard search. Function-based causes remain limited to directly supported evidence so CASE-007 is not overcalled.
- [x] Drive the Deep Analysis `non-sargable` signal from the structured causal result, not from a generic display warning.
- [x] Preserve QueryPlan-level conversion correlation and CASE-008's existing conversion finding.

Acceptance:

- [x] A clean Index Scan with an ordinary predicate produces no residual or non-SARGable signal.
- [x] An Index Seek with a separate residual predicate is represented accurately.
- [x] A conversion-bearing scan and a leading-wildcard scan still produce the direct causal finding.
- [x] CASE-007 retains its scalar-UDF and serialization findings without gaining an unsupported non-SARGable assertion.
- [x] CASE-008 retains its conversion and supported non-SARGable findings.

### 8C — Disclose every finding cap — completed

Priority: required trust fix.

Primary files: `src/rules/engine.ts`, `src/types.ts`, `src/lib/report.ts`, `src/lib/runBundle.ts`, `src/App.tsx`, and their tests.

- [x] Keep bounded rendering, but centralize capping so each rule returns both retained findings and the exact suppressed count.
- [x] Add cap disclosures to the data-quality audit and exported report formats.
- [x] State the affected rule, retained count, suppressed count, and ordering used to choose retained findings.
- [x] Prefer aggregation for genuinely instance-wide conditions; do not use a truncation notice as a substitute for worker- or compile-pressure consolidation.

Acceptance:

- [x] Synthetic inputs exceeding the resource, generic-wait, and transaction caps report exact suppressed counts.
- [x] The browser, JSON, CSV, printable HTML, and run-bundle exports disclose the same counts.
- [x] Existing reports without cap metadata remain importable.

### 8D — Complete tab accessibility and activity evidence navigation — completed

Priority: release-quality UI work after the correctness blockers.

Primary files: `src/App.tsx`, `src/components/FindingDrawer.tsx`, `src/styles.css`, and browser tests.

- [x] Implement `tablist`, `tab`, and `tabpanel` semantics with `aria-selected`, `aria-controls`, matching IDs, roving focus, and Left/Right/Home/End keyboard navigation.
- [x] Replace the fixed first-100 activity view with session filtering, sortable columns, and bounded paging.
- [x] Add a `Show affected activity` action from a finding that opens the activity view filtered to its `affectedRecordIds`.
- [x] Preserve mobile layout, keyboard reachability, redaction boundaries, and export behavior. Report-scoped filters now reset when a new capture or saved report is opened.

Acceptance:

- [x] Keyboard-only users can change tabs and identify the active panel.
- [x] A finding whose affected row appears after row 100 can navigate directly to that evidence.
- [x] Desktop and 390x844 browser checks have no console errors or horizontal overflow.

### 8E — Deferred calibration enhancements — not started

Priority: post-release design work; not a blocker for the correctness release.

- Decide whether compile time, compile CPU, compile memory, optimizer early-abort reason, and optimization level should create findings or qualify confidence on existing findings. Require workload-aware tests before adding new severity paths.
- Design local threshold profiles with explicit defaults, validation, schema versioning, and active-profile disclosure in every export.
- Preserve CASE-006's High result under the published default grant thresholds unless those defaults are deliberately versioned and changed.

## Phase 8 verification gate

- [x] Run the full automated suite and production build: 87 passed, 1 intentionally skipped; production build passed.
- [x] Add a production-path fixture containing the official multi-task wait grammar rather than only synthetic parser calls.
- [x] Re-run all ten blinded cases and both CASE-004/005 companion-evidence workflows through the automated production-ingestion boundary.
- [x] Re-run default-export privacy tests because new structured wait and predicate fields may contain diagnostic details.
- [x] Run headless desktop and mobile checks for tab semantics, keyboard navigation, activity filtering, and cap disclosures.
- [x] Confirm 8A, 8B, and 8C are complete before closing Phase 8.

## Post-review code-quality closure

- [x] Reject malformed comma-grouped wait durations and zero or otherwise invalid native task counts instead of accepting ambiguous evidence.
- [x] Recognize Unicode SQL leading-wildcard predicates such as `LIKE N'%value'` as the same supported non-SARGable cause as non-Unicode literals.
- [x] Include native wait task count in worker- and compile-pressure finding evidence, with an explicit `Not supplied` value for compatibility captures.
- [x] Neutralize spreadsheet-formula prefixes in CSV exports and validate cap metadata before serializing it.
- [x] Keep every tab's `aria-controls` target present in the document and add automated DOM tests for tab relationships, keyboard focus, and report-scoped state reset.
- [x] Re-run the release gate and a production-build headless browser smoke test at desktop and 390x844 mobile sizes; no browser errors, external requests, or horizontal overflow were observed.

## Recommended implementation order

1. [x] Add failing native multi-task wait and clean-predicate regression tests.
2. [x] Implement the structured wait parser and compatibility fallback.
3. [x] Correct predicate classification and Deep Analysis signal routing.
4. [x] Centralize caps and expose exact suppression metadata in the UI and exports.
5. [x] Add accessible tab behavior and evidence-focused activity navigation.
6. [x] Re-run blinded, performance, privacy, compatibility, and browser verification. The existing external-workbook regression remains covered by its opt-in test and the earlier recorded quality pass.
7. [ ] Design threshold profiles and optimizer/compile qualifiers separately after the correctness release (Phase 8E).
