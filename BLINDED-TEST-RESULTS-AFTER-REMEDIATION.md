# SQL Evaluate post-remediation fixture results

Test date: 2026-08-29  
Application: SQL Evaluate production build after diagnostic-accuracy remediation  
Method: All opaque `fixtures/CASE-*` packages were loaded through `processInputFiles`, the same production ingestion and analysis boundary used by the browser worker. Companion counters for CASE-004 and CASE-005 were then imported through their routed Deep Analysis cases. The original blinded baseline was preserved unchanged.

## Automated production-path results

| Case | Rows | Captures | Plans | High | Medium | Low | Info | Not evaluated | Primary result |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| CASE-001 | 78 | 46 | 0 | 0 | 0 | 0 | 0 | 1 | Healthy capture remains quiet |
| CASE-002 | 182 | 42 | 0 | 7 | 0 | 5 | 0 | 1 | Sleeping open-transaction root; transaction-owned blocking profile |
| CASE-003 | 200 | 50 | 0 | 5 | 3 | 1 | 0 | 1 | Runnable root; CPU-backed blocking profile |
| CASE-004 | 417 | 40 | 1 | 1 | 0 | 0 | 0 | 0 | Consolidated compilation-memory/plan-cache-pressure finding |
| CASE-005 | 664 | 45 | 0 | 1 | 0 | 0 | 0 | 1 | Consolidated High worker-exhaustion finding |
| CASE-006 | 35 | 35 | 1 | 3 | 1 | 1 | 0 | 0 | High oversized grant, estimate error, and direct spill finding |
| CASE-007 | 32 | 32 | 1 | 2 | 0 | 1 | 0 | 0 | Forced serialization and scalar UDF surfaced directly |
| CASE-008 | 36 | 36 | 1 | 1 | 3 | 2 | 0 | 0 | Plan-affecting conversion and non-SARGable predicates surfaced |
| CASE-009 | 82 | 48 | 0 | 0 | 0 | 0 | 1 | One concise transient blocking observation |
| CASE-010 | 1 | 1 | 1 | 0 | 0 | 0 | 0 | 1 | Runtime checks Not Evaluated; actual-plan profile offered |

## Deep Analysis evidence routing

- CASE-002 routes to `transaction-blocking`; it is never titled CPU-backed blocking.
- CASE-003 retains the `cpu-backed-blocking` profile.
- CASE-004 routes to `compile-pressure`. Its companion counter file supports compilation pressure and the combined causal theory.
- CASE-005 routes to `worker-exhaustion`. Its companion counters support the worker-ceiling assertion and combined causal theory.
- CASE-006 routes grant and spill evidence to `memory-grants`.
- CASE-007 and CASE-008 route direct Showplan causes to `plan-specific`.
- CASE-010 routes to `actual-plan` and does not invent runtime findings.

## Corrected fixture interpretation

The fixture millisecond truncation remains a fixture-quality issue, but it was not the primary cause of the CASE-004/005 failures. SQL Evaluate now parses `waittime=` directly from `wait_info`; specialized high-risk reasoning also uses recurrence, capture persistence, visible concurrency, task evidence, and companion counters.

## Verification

- Opaque fixture regression tests: passing.
- Full automated suite after Phase 8 and the post-review quality pass: 87 passed, 1 intentionally skipped.
- Production build: passing.
- Dependency audit: zero vulnerabilities.
- Headless production-browser verification: all ten fixture packages loaded successfully; CASE-004/005 companion evidence reached Supported Deep Analysis narratives; no page or console errors were reported.
- Responsive layout: desktop and 390×844 mobile checks passed with no horizontal overflow after correcting report-header intrinsic sizing.

## Final quality-pass closure

- Default redaction now removes complete SQL text, raw original-column values, plan predicates, query identities, object names, conversion expressions, and sensitive finding evidence. A production-browser CASE-008 JSON export contained the expected redaction markers and none of the fixture's distinctive SQL literals, identifiers, hashes, or conversion expression.
- CASE-009 now has zero Deep Analysis recommendations, no stored Deep Analysis profile, and no drawer launch action for its isolated Informational blocking observation.
- QueryPlan-level conversion warnings are correlated to the responsible predicate-bearing operator. CASE-008 now reports the conversion on the `Index Scan`, not the enclosing `Filter`.
- Worker and compilation profiles now generate two timestamped, adapter-compatible samples. Compilation collection also emits a recognized single-use-plan inventory.
- The actual-plan profile now separates an already-enabled last-known-actual lookup from an explicit, approval-gated controlled-execution workflow.
- A 20,000-row short-transaction regression protects linear-time grouping and blocker lookup behavior.
- Deep Analysis archives are rejected from central-directory expansion metadata before extraction when their declared expansion exceeds 200 MB; the post-extraction size check remains in place as a second guard.
- Final headless verification loaded CASE-001 through CASE-010 without page errors or horizontal overflow. The CASE-010 mobile Deep Analysis workflow was visually checked at 390×844.

## Phase 8 post-review closure

- Native multi-task wait grammar is covered through both parser-level and production-file ingestion tests; CASE-004 and CASE-005 compatibility inputs remain green.
- Ordinary predicates no longer imply residual evaluation. Explicit residual predicates and supported conversion/leading-wildcard scan causes remain structured, directly testable evidence; CASE-007 and CASE-008 retain their intended diagnoses.
- Synthetic over-cap resource, wait, and transaction inputs report exact retained and suppressed counts. The same metadata is covered in JSON, CSV, printable HTML, run-bundle, and browser audit paths.
- Headless desktop and 390×844 checks verified ARIA tab state, Left/Right/Home/End navigation, affected-row navigation, 100-row paging, session filtering, sortable activity columns, cap disclosure, and zero document overflow.
- A browser-discovered stale-filter defect was corrected: new captures and reopened reports now reset report-scoped finding and activity filters.
- The post-review pass tightened malformed native-wait rejection, added Unicode leading-wildcard coverage, exposed native task counts in specialized findings, neutralized CSV formula prefixes, validated cap metadata, and automated the tab/state-reset UI regressions.
- Final gate: 87 passed, 1 intentionally skipped; production build passed; dependency audit reported zero vulnerabilities; observed browser requests were limited to `127.0.0.1`.
