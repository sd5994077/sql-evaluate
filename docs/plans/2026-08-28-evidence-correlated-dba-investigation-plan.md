---
date: 2026-08-28
title: Evidence-Correlated DBA Investigation Plan
status: Ready for execution
---

# Evidence-Correlated DBA Investigation Plan

## Outcome

Extend the existing offline Deep Analysis workbench so it can produce a defensible investigation similar to the CPU-backed blocking example when the DBA supplies sufficiently complete, time-aligned evidence from `sp_WhoIsActive`, native SQL Server DMVs, `sp_BlitzCache`, Query Store exports, and Showplan XML.

The result will separate:

- what the files directly prove;
- what multiple sources support;
- what the evidence contradicts;
- what remains unavailable;
- the next collection step most likely to change the conclusion.

The application remains local and file-based. It displays and downloads read-only diagnostic scripts but never connects to SQL Server or executes SQL.

## Feasibility and hard limits

### What the application can produce

- A timestamped root/intermediate/victim blocking graph.
- A determination that the root was runnable and had open transactions at the captured instant.
- Lock-owner and victim-wait-resource correlation when both are supplied.
- Evidence of sustained runnable scheduler queues when repeated scheduler samples are supplied.
- Structured `sp_BlitzCache` findings and calculated plan-cache metrics from recognized exports.
- Exact request/query/plan relationships when stable SQL Server identifiers are available.
- Operator-level explanations from cached, estimated, actual, last-known-actual, or Query Store Showplan XML, with the plan type clearly labeled.
- A causal narrative whose links retain individual evidence states and alternative explanations.
- A portable, integrity-checked case archive and a separately redacted handoff report.

### What the application cannot honestly produce

- It cannot recover a plan that was evicted before any cache, Query Store, last-known-actual-plan, or Extended Events capture retained it.
- It cannot prove CPU starvation from `status = runnable` alone; repeated scheduler-queue or equivalent CPU evidence is required.
- It cannot conclude that an unused grant starved the grant pool without pending grants, `RESOURCE_SEMAPHORE`, or equivalent concurrency evidence.
- It cannot conclude that a serial plan should have been parallel. It can identify the documented nonparallel reason or list the evidence still needed.
- It cannot make Query Store historical claims when Query Store was disabled or did not contain the query.
- Extended Events cannot retrieve a past execution and may add material overhead; it will be a separately approved last-resort recipe, never an automatic action.
- Evidence captured at materially different times cannot establish one causal chain unless stable identifiers and an overlapping incident window connect it.

These limitations do not prevent the expected result. They determine whether the final narrative says **Observed**, **Supported**, **Contradicted**, or **Not Evaluated**.

## Safety and product boundaries

- No database connection, credential handling, SQL execution, session termination, index creation, plan forcing, Query Store changes, or Extended Events changes by the application.
- Every script is visible, downloadable, version-aware, bounded, and labeled with permissions and overhead.
- Query Store and existing Extended Events data are read only when the DBA manually runs an approved recipe.
- Creating a new Extended Events session is presented only as an optional high-overhead escalation with explicit start, stop, cleanup, duration, and filtering instructions.
- Raw evidence remains inside the browser unless the user explicitly saves a sensitive case archive.
- Redacted reports must remove SQL text, literals, plans, database, host, login, program, and parameter data by default.

## Architecture additions

### 1. Versioned evidence contracts

Add additive case-schema `1.1` contracts while retaining `1.0` case import:

- `IncidentWindow`: first/last observation, capture clock, server identity hash, and overlap quality.
- `QueryIdentity`: session/request IDs, transaction ID, SQL/plan handles, query/plan hashes, statement offsets, Query Store IDs, and database ID.
- `EvidenceRecordSet`: adapter ID/version, result-set type, capture timestamp, source-tool version, column mapping, row count, warnings, and artifact hash.
- `EvidenceObservation`: typed metric or fact, unit, timestamp, identity keys, source location, and directness.
- `HypothesisLink`: proposed cause/effect, state, confidence, evidence IDs, contradicting evidence IDs, missing evidence, and evaluation reason.
- `CaptureAttempt`: requested evidence, method, outcome (`Captured`, `Returned null`, `Unavailable`, `Permission denied`, or `Not run`), and follow-up path.

Unknown columns remain attached to their record set for audit and future adapters.

### 2. Deterministic identity and time correlation

Implement a correlation index with this precedence:

1. Same capture set plus session ID, request ID, and transaction ID.
2. SQL handle, plan handle, and statement offsets.
3. Query hash and query-plan hash within the same database and incident window.
4. Query Store query, plan, and runtime-interval IDs.
5. Object and lock-resource identity for blocker/victim ownership.

Normalized SQL text may surface a possible match for human review, but text similarity alone must never upgrade an evidence state or close a causal link.

Every relationship records why it matched. Files outside the incident window remain contextual rather than causal evidence.

## Implementation units

### U1. Strengthen the case and provenance model

**Primary files:** `src/deepAnalysis/types.ts`, `src/deepAnalysis/case.ts`, archive validators, report redaction modules, and new correlation modules.

- Add the schema `1.1` contracts above.
- Preserve the original assertion history rather than overwriting earlier states.
- Add capture-attempt records, including a returned-NULL plan lookup.
- Index observations by session/request, transaction, handle/hash, Query Store ID, capture time, and artifact ID.
- Record clock ambiguity and time-window conflict as explicit limitations.
- Reopen existing schema `1.0` cases by adapting missing fields in memory.

### U2. Add structured native diagnostic ingestion

**Primary files:** new adapters under `src/deepAnalysis/adapters/`, `src/deepAnalysis/profile.ts`, and focused fixtures/tests.

- Add tagged result-set contracts for current requests, schedulers, transactions, locks, memory grants, plan-cache inventory, and compilation counters.
- Modify the downloadable CPU/blocking recipe so every grid includes case ID, evidence-set ID, server time, server-start time, and target SPID.
- Accept CSV, TSV, and multi-sheet XLSX without relying on filenames.
- Calculate repeated scheduler queue values, scheduler-delay deltas, online scheduler count, pending grants, compilation deltas, and batch-request deltas.
- Treat a single nonzero runnable queue as a clue; require repeated/time-aligned samples before supporting sustained scheduler pressure.

### U3. Implement a version-tolerant `sp_BlitzCache` adapter

**Primary files:** new `blitzCacheAdapter.ts`, adapter manifest, sanitized fixtures for supported output variants, and Data Quality UI.

- Detect `sp_BlitzCache` from its output shape and optional version metadata rather than its filename.
- Normalize stable identifiers, database/object context, execution metrics, warnings, memory grants, parallelism indicators, and query/plan handles when present.
- Parse warning tokens individually instead of treating one warning string as a generic plan-cache signal.
- Calculate single-use plan prevalence only from a plan-cache inventory that provides a valid numerator and denominator.
- Distinguish per-plan symptoms from server-level pressure:
  - unused grant is a query symptom;
  - pending grants or `RESOURCE_SEMAPHORE` establish grant-pool pressure;
  - compilation timeout is a query/compile symptom;
  - compilation-to-batch deltas establish workload-level compile pressure;
  - forced serialization is a plan symptom until Showplan explains the reason.
- Unknown or unsupported BlitzCache shapes remain attachable but cannot drive assertions.

### U4. Deepen Showplan and plan-source analysis

**Primary files:** `src/lib/showplan.ts`, plan types, plan rules, and plan fixtures.

- Preserve query hash, plan hash, statement offsets, compile time/CPU/memory, DOP, optimization level, early-abort reason, cardinality model, and `NonParallelPlanReason` when present.
- Parse scalar UDF/function evidence, plan-affecting conversions, residual predicates, row goals, serial zones, hints, spills, grant warnings, scans, sorts, lookups, and estimate errors.
- Record the plan source as cached estimated, estimated, actual, last-known actual, Query Store compile plan, or Extended Events post-execution plan.
- Correlate a plan with the root statement only through stable identity or an explicitly tagged same-moment result.
- Explain serial execution conservatively: report the XML reason when present; otherwise list likely categories without selecting one.

### U5. Add the evidence-escalation ladder

**Primary files:** `src/deepAnalysis/profile.ts`, new recipe catalog, offline knowledge content, and recipe tests.

Provide one prioritized next step at a time:

1. Capture the active request, SQL text, `plan_handle`, and `query_plan` in the same statement.
2. If the plan is NULL, record that failed attempt and inspect whether `sys.dm_exec_query_plan_stats` is already usable.
3. Inspect Query Store state; if already enabled and populated, export bounded query, plan, runtime, and wait evidence.
4. If history is unavailable and repeated live capture still misses the query, offer a narrowly filtered Extended Events post-execution Showplan recipe as a separately approved last resort.

The Extended Events recipe must:

- explain potentially high CPU/storage overhead;
- require a narrow database/query filter;
- specify a short duration and size/rollover limits;
- include explicit stop and cleanup statements;
- never be executed by SQL Evaluate;
- accept exported event XML/CSV in the first implementation. Direct binary `.xel` parsing is deferred unless a safe offline parser is selected and tested.

### U6. Build the evidence-ranked causal evaluator

**Primary files:** new evaluator modules under `src/deepAnalysis/evaluators/`, rule catalog, and narrative renderer.

Evaluate each link independently:

- `blocking chain`: graph and persistence evidence;
- `root transaction`: open count, transaction age, and transaction identity;
- `lock ownership`: granted root resources matched to victim waits;
- `root runnable`: direct request status at the captured instant;
- `scheduler pressure`: repeated runnable queues or scheduler delay within the incident window;
- `plan-cache instability`: valid single-use prevalence and/or repeated cache inventory evidence;
- `compilation pressure`: compilation deltas relative to batch activity and query-level compilation symptoms;
- `serialization`: plan-specific reason, not an assumption that parallelism would be faster;
- `memory-grant symptom`: requested/granted/used evidence for the query;
- `memory-grant pressure`: pending grants or resource-semaphore evidence;
- `root plan explanation`: stable plan match and operator evidence.

Generate the final narrative from link states, not a fixed paragraph. Include the strongest alternative explanation and one next discriminating check. Correlation may raise confidence in a link but must not silently change the severity of an existing finding.

### U7. Expand the Deep Analysis workspace

**Primary files:** `src/components/DeepAnalysisWorkspace.tsx`, new case components, `src/styles.css`, and export modules.

- Add an incident chronology showing source timestamps and capture attempts.
- Show exact identity matches and time overlap for every linked artifact.
- Split the view into Established facts, Supported theory, Contradictions, and Unanswered questions.
- Add source-specific import slots and clear recognition/error feedback.
- Show the failed cached-plan lookup and the selected escalation path.
- Render a concise DBA narrative followed by its evidence table; every sentence must link to assertions/artifacts.
- Include the enhanced case in sensitive ZIP archives and the conclusions/limitations in redacted JSON, CSV, and printable HTML.

### U8. Prove the supplied investigation as an acceptance fixture

Create a fully synthetic, security-safe fixture set modeling:

- four `LCK_M_IX` victims executing fictional `INSERT` statements;
- intermediate SPID 236 and root SPID 104;
- root status `runnable` and `open_tran_count = 2`;
- granted root locks matching the victim resources;
- repeated runnable scheduler queues;
- a 35,600-plan inventory with greater than 98% single-use plans;
- BlitzCache rows containing forced serialization, compilation timeout, unused grant, filter UDF, and non-SARGable warnings;
- a failed after-the-fact cached-plan lookup;
- a later same-moment root plan with a specific, parseable nonparallel reason;
- optional Query Store evidence and a conflicting-evidence variant.

Run the fixture in stages and require these outcomes:

1. **WhoIsActive only:** blocking graph, runnable root, and open transaction are Observed; CPU starvation and systemic causes remain Not Evaluated.
2. **Scheduler + locks:** scheduler pressure becomes Supported and lock ownership becomes Observed.
3. **BlitzCache + cache inventory:** plan-cache and compilation pressure become Supported; unused grant remains a query symptom and does not establish grant-pool starvation.
4. **NULL plan lookup:** plan evidence remains Not Evaluated and the next action becomes a same-moment capture.
5. **Matching Showplan:** the plan and its actual nonparallel reason become Observed; unrelated warnings remain contextual.
6. **Full time-aligned evidence:** the complete causal narrative becomes Supported, never “proven,” because workload causality remains an evidence-backed inference.
7. **Conflicting timestamps or transaction data:** the affected links return to Not Evaluated or Contradicted and the narrative explains why.

## Test and quality plan

- Unit tests for every adapter, alias map, calculation, identity match, time-window rule, and assertion transition.
- Static audits confirming all recipes are read-only and that Extended Events scripts include stop/cleanup safeguards.
- Regression tests for malformed, truncated, oversized, version-shifted, and unsupported evidence.
- Showplan tests for estimated/actual/source distinctions and nonparallel reasons.
- Archive compatibility, evidence hashing, tamper rejection, and redaction-leak tests.
- Determinism tests: file import order must not change conclusions.
- Performance tests with 100,000 activity rows and representative large BlitzCache/plan files using indexed maps rather than cross-product scans.
- Headed-browser tests for the complete staged acceptance case, keyboard access, mobile layout, zero horizontal overflow, copy/download actions, and zero outbound network traffic.
- Full `npm run check` plus the supplied external workbook regression before release.

## Recommended execution order

1. Case schema, identity model, chronology, and correlation indexes.
2. Native result-set adapter and tagged collection recipe.
3. Structured BlitzCache adapter and metric calculations.
4. Showplan identity and nonparallel-reason enhancements.
5. Causal evaluator and evidence-dependent narrative.
6. Query Store and Extended Events manual escalation recipes/imports.
7. Workspace and export enhancements.
8. Staged acceptance fixture, performance testing, browser QA, documentation, and release build.

## Completion criteria

The work is complete only when the synthetic acceptance case can produce a narrative materially equivalent to the supplied example, every claim links to imported evidence, unsupported links remain visibly unresolved, a missing plan follows the correct escalation ladder, the case saves/reopens deterministically, default exports remain redacted, and the application performs no SQL execution or outbound network request.
