---
date: 2026-08-27
topic: offline-connected-sql-investigation
---

# Offline Connected SQL Investigation Requirements

## Summary

SQL Evaluate will add a case-oriented Deep Analysis workflow to its offline file analyzer, followed later by an optional, manually initiated, read-only connection to internal SQL Server instances. It will combine current activity, imported diagnostic results, SQL text, execution plans, locks, transactions, waits, server evidence, and available history into one prioritized incident investigation.

---

## Problem Frame

The current application detects useful signals, but limited captures often omit the evidence needed to identify a cause. Category-level templates then produce repeated recommendations, and independent findings can obscure the relationship among a root blocker, intermediate blockers, victims, waits, transactions, and execution plans.

The supplied 604-row workbook illustrates the problem: it contains 73 capture times but omits SQL text, plans, lock XML, and database context. The current analysis emits many individually valid observations without enough evidence to explain the responsible query or reconstruct a blocking incident reliably.

An internal SQL Server environment can provide stronger evidence without internet research or external services. The product must use that evidence conservatively and preserve DBA control over collection and intervention.

A representative investigation starts with a blocking chain whose root session is runnable with open transactions, then adds plan-cache warnings suggesting compilation, serialization, and memory-grant pressure. The useful outcome is not a confident-sounding story assembled from adjacent facts. The application must separate observed evidence from supported hypotheses, identify the missing scheduler, lock-owner, compilation, memory-pressure, and plan evidence, and guide the DBA toward the next check that can confirm or contradict the working theory.

---

## Key Decisions

- **Two operating modes.** File import remains fully supported; connected capture is an optional internal mode with a visibly different trust boundary.
- **Manual capture first.** A DBA starts a bounded capture for an incident rather than enabling unattended monitoring.
- **Read-only by construction.** SQL Evaluate installs no objects and never changes database, server, query, plan, session, or maintenance state.
- **Native evidence first.** SQL Server DMVs, existing Query Store data, existing `system_health` evidence, `sp_WhoIsActive`, and Showplan are authoritative inputs.
- **Community tools are optional.** SQL Evaluate may detect and consume supported First Responder Kit procedures only when they are already installed.
- **Incidents over alerts.** Related observations are synthesized into a causal investigation instead of presented as repeated standalone findings.
- **Manual Deep Analysis first.** A DBA may run a visible read-only recipe in SSMS and import its result files before connected collection is available.
- **Portable cases instead of persistence.** A versioned local case archive is the source of truth; SQL Evaluate stores no investigation database and keeps no hidden browser history.
- **Evidence states over narrative certainty.** Every causal assertion is classified as observed, supported, contradicted, or not evaluated.
- **Working and sharing artifacts differ.** A reopenable working case may contain sensitive evidence and is warning-backed, while shareable exports remain redacted by default.
- **Offline expertise.** Diagnostic explanations, wait guidance, plan guidance, and troubleshooting playbooks ship with the application and require no internet connection.

---

## Actors

- A1. **DBA operator:** authorizes a connection, starts a capture, reviews evidence, and decides whether to take action outside SQL Evaluate.
- A2. **SQL Evaluate:** collects allowlisted read-only evidence, analyzes it locally, and explains conclusions and limitations.
- A3. **SQL Server instance:** supplies current and historical diagnostic evidence under the connected Windows identity's permissions.

---

## Requirements

**Connection and collection**

- R1. File-only operation must continue to work without SQL Server access or an internet connection.
- R2. Connected mode must use Windows Integrated Authentication by default and must not persist credentials.
- R3. A DBA must explicitly start each connected capture and select a bounded duration, with a recommended range of 30 to 120 seconds.
- R4. The collector must execute only a visible allowlist of read-only diagnostic commands and must never create or alter SQL Server objects.
- R5. The collector must display the target instance, authenticated identity, effective diagnostic permissions, capture duration, and expected overhead before collection begins.
- R6. Missing permissions, unsupported features, timeouts, and unavailable evidence must degrade individual checks to Not Evaluated without aborting the remaining capture.
- R7. Collection must be version-aware across supported SQL Server releases and must avoid unbounded plan-cache, Query Store, or Extended Events scans.

**Evidence sources**

- R8. A guided activity capture must collect repeated snapshots of current requests, SQL text, outer commands, waits, task details, blocking relationships, transaction ownership, lock resources, plans, memory grants, and per-interval resource deltas when permitted.
- R9. Native evidence must include relevant request, session, waiting-task, lock, transaction, memory-grant, scheduler, tempdb, file-I/O, cached-query, and server-health data when available.
- R10. Query Store must be read only when already enabled and must contribute query history, plan changes, execution frequency, resource trends, and query-level wait history.
- R11. Existing `system_health` evidence may contribute deadlocks, long lock waits, severe errors, memory failures, scheduler events, and connectivity evidence without creating or modifying an Extended Events session.
- R12. SQL Evaluate must analyze standalone, embedded, cached, Query Store, estimated, actual, and last-known-actual Showplan evidence while clearly identifying the evidence type.
- R13. If supported First Responder Kit procedures are already installed, SQL Evaluate may offer an explicit read-only collection step and ingest their results; it must never install or update the toolkit.
- R14. Query and plan identifiers must support correlation across evidence sources without relying on raw parameter values or SQL-text similarity alone.

**Incident analysis**

- R15. Blocking analysis must build a per-capture blocking graph, identify true root blockers, label intermediate blockers, show victim branches, and handle cycles or incomplete chains explicitly.
- R16. Repeated observations of the same blocking chain must be grouped into one incident with first seen, last seen, peak fan-out, persistence, and changing participants.
- R17. The analyzer must correlate blocking, lock waits, transaction state, SQL text, plans, resource use, Query Store history, and server pressure only through defensible identifiers or timestamp overlap.
- R18. Each incident must present a concise causal narrative, observed evidence, alternative explanations, confidence basis, limitations, and the next discriminating check.
- R19. The report must separate the primary incident from supporting signals and low-confidence leads so duplicated findings do not overwhelm the operator.
- R20. Recommendations must respond to the observed wait family, blocker state, transaction ownership, dominant resource, plan operators, and missing evidence instead of using one template per category.
- R21. SQL Evaluate must show one tailored recapture or diagnostic recipe per incident and must not repeat the same command in multiple sections.
- R22. When the evidence cannot establish a root cause, the report must say so directly and must not present generic tuning actions as a diagnosis.

**Execution-plan analysis**

- R23. Plan analysis must retain existing checks for estimate errors, spills, grants, missing-index suggestions, and plan-affecting conversions.
- R24. Plan analysis must add evidence-backed interpretation of scans, residual predicates, repeated lookups, sorts, parallelism, row goals, warnings, object access, and operator-level resource use when the plan contains sufficient data.
- R25. Plan findings must distinguish compile-time heuristics from runtime observations and must never infer runtime behavior from an estimated plan.
- R26. Missing-index suggestions must remain hypotheses and must be compared with available existing-index and workload evidence before any recommendation is elevated.
- R27. Query Store or cached-plan history must identify plan regressions and material plan changes without automatically forcing a plan.

**Offline guidance, privacy, and auditability**

- R28. The application must include a versioned offline knowledge pack for wait types, Showplan warnings, common SQL Server failure patterns, evidence interpretation, and conservative remediation playbooks.
- R29. Offline guidance must identify its source and knowledge-pack version even when the linked external page cannot be opened.
- R30. All analysis and capture processing must remain on `127.0.0.1` with no telemetry, cloud AI, external API calls, or automatic internet lookup.
- R31. Captured data must remain temporary unless the DBA explicitly exports it, and default exports must redact SQL text, literals, plans, database names, hosts, logins, programs, and parameters.
- R32. Raw export must remain explicit and warning-backed, and connected mode must not weaken existing redaction behavior.
- R33. The report must retain raw-evidence drill-down for authorized local review and identify the source command and capture time for every conclusion.
- R34. SQL Evaluate must never execute remediation, kill a session, force a plan, create an index, update statistics, enable a feature, or run maintenance.

**Deep Analysis cases**

- R35. A finding or incident may recommend Deep Analysis only when a named evidence gap has a bounded diagnostic check that could change the conclusion.
- R36. A DBA may also open Deep Analysis manually and select a profile without first receiving a recommendation.
- R37. Initial profiles must cover CPU and scheduler pressure, worker-thread exhaustion, memory-grant pressure, blocking and deadlocks, TempDB and storage latency, and query-plan regression or parameter sensitivity.
- R38. Each case must retain its originating findings, working theory, alternative explanations, evidence ledger, diagnostic steps, imported results, conclusions, and remaining limitations.
- R39. Each causal assertion must identify its supporting evidence and state as Observed, Supported, Contradicted, or Not Evaluated.
- R40. Correlation must use stable request, transaction, query, plan, object, and capture identifiers or defensible timestamp overlap; adjacency in a report is insufficient.
- R41. A generated diagnostic recipe must state its purpose, expected evidence, required permissions, supported SQL Server versions, expected overhead, collection duration, and safety caution.
- R42. Manual Deep Analysis must display or download read-only scripts but must never execute them.
- R43. SQL Evaluate must accept multiple returned CSV, XLSX, XML, Showplan, and supported community-tool result files and associate them with the correct case and collection step.
- R44. Imported evidence must move hypotheses between evidence states deterministically and explain why a state changed.
- R45. When uncertainty remains, the case must recommend one next discriminating check rather than repeat the complete collection recipe.
- R46. Plan-capture escalation must prefer same-moment request and plan-handle capture, then already-enabled last-known-actual plans or Query Store history, and treat targeted post-execution Showplan Extended Events as a high-overhead last resort requiring separate DBA approval.
- R47. Query Store plans must be described as persisted compile-time plans with aggregated runtime and wait statistics, not as actual per-execution plans.
- R48. A portable working-case archive must reopen without a database, preserve evidence provenance, and support adding later result files to the same case.
- R49. Working-case export must warn that SQL text, plans, identifiers, and parameters may be sensitive; the separate shareable report must retain default redaction.
- R50. Case archives must include a stable case ID, schema version, application and knowledge-pack versions, source-file hashes, collection-step status, and a manifest of included evidence.

---

## Key Flows

- F1. **Run a guided internal capture**
  - **Trigger:** A DBA selects connected mode and chooses an internal SQL Server instance.
  - **Actors:** A1, A2, A3.
  - **Steps:** SQL Evaluate validates connectivity and permissions, previews the evidence and overhead, collects bounded repeated samples, and records unavailable sources without changing the server.
  - **Outcome:** A local analysis package is available for incident synthesis.
  - **Covered by:** R2-R13, R30-R34.

- F2. **Reconstruct an incident**
  - **Trigger:** A capture contains blocking, waits, resource pressure, transaction state, or plan concerns.
  - **Actors:** A1, A2.
  - **Steps:** SQL Evaluate builds causal relationships, selects the primary incident, attaches supporting signals, compares available history, and explains evidence gaps.
  - **Outcome:** The DBA sees one prioritized investigation rather than repeated findings.
  - **Covered by:** R14-R22.

- F3. **Investigate a query or plan**
  - **Trigger:** An incident links to SQL text or Showplan evidence.
  - **Actors:** A1, A2.
  - **Steps:** SQL Evaluate analyzes compile-time and runtime evidence, correlates plan history when available, and proposes the next safe verification step.
  - **Outcome:** The DBA receives query-specific evidence without an automatic tuning action.
  - **Covered by:** R23-R29, R34.

- F4. **Use the application while disconnected**
  - **Trigger:** No SQL Server connection or internet access is available.
  - **Actors:** A1, A2.
  - **Steps:** The DBA imports captures or plans, and SQL Evaluate analyzes them using the bundled rule and knowledge catalogs.
  - **Outcome:** Existing offline workflows remain functional.
  - **Covered by:** R1, R28-R33.

- F5. **Run a manual Deep Analysis case**
  - **Trigger:** A finding recommends deeper evidence or a DBA selects an investigation profile.
  - **Actors:** A1, A2.
  - **Steps:** SQL Evaluate explains the uncertainty, supplies a bounded read-only recipe, the DBA runs it in SSMS, and the returned files are imported into the case.
  - **Outcome:** The working theory is confirmed, contradicted, or narrowed to one next discriminating check.
  - **Covered by:** R35-R47.

- F6. **Save and resume an investigation**
  - **Trigger:** A DBA needs to pause, transfer, archive, or continue a case later.
  - **Actors:** A1, A2.
  - **Steps:** SQL Evaluate exports a warning-backed working case or a redacted shareable report; the working case can later be reopened and extended with additional evidence.
  - **Outcome:** The investigation remains portable without a database or hidden browser persistence.
  - **Covered by:** R48-R50.

---

## Acceptance Examples

- AE1. **Covers R15-R16.** Given a chain `67 -> 61 -> 74`, when the capture is analyzed, then session 67 is the root blocker and sessions 61 and 74 are labeled as downstream or intermediate participants rather than additional head blockers.
- AE2. **Covers R18-R22.** Given blocking, a locking wait, and an open transaction from the same incident, when the report is opened, then one incident narrative explains the relationship and presents one tailored next action.
- AE3. **Covers R6.** Given access to current-request DMVs but not Query Store or Extended Events, when collection completes, then current analysis succeeds and the unavailable historical checks are marked Not Evaluated with their permission requirements.
- AE4. **Covers R10-R12.** Given Query Store is already enabled, when a regressed query is captured, then the report compares recent plans and runtime intervals without changing Query Store configuration or forcing a plan.
- AE5. **Covers R13.** Given `sp_BlitzFirst` is installed, when the DBA approves optional toolkit collection, then its results are ingested; when it is absent, SQL Evaluate neither installs it nor treats its absence as an application error.
- AE6. **Covers R25.** Given only an estimated plan, when plan analysis runs, then runtime spills, actual rows, and memory use remain Not Evaluated rather than inferred.
- AE7. **Covers R30-R32.** Given a connected capture containing sensitive SQL and plan data, when a default report is exported, then sensitive fields are redacted and no network request leaves the machine.
- AE8. **Covers R34.** Given a high-confidence blocking or plan regression incident, when recommendations are displayed, then all commands that would change server state remain outside executable application behavior.
- AE9. **Covers R35-R47.** Given four `LCK_M_IX` victims blocked through an intermediate session by a runnable root with two open transactions, plus plan-cache warnings for single-use plans, serialization, compilation timeout, unused grants, and non-SARGable code, when Deep Analysis opens, then the blocking chain is Observed while sustained CPU starvation, lock ownership, compilation pressure, grant-pool starvation, and the full causal theory remain Supported or Not Evaluated until corroborating evidence is imported.
- AE10. **Covers R44-R47.** Given a missing cached plan and an imported live capture containing the matching request, plan handle, and plan XML, when the case is re-evaluated, then plan-dependent hypotheses update with the new evidence and the failed after-the-fact cache lookup remains visible in provenance.
- AE11. **Covers R46-R47.** Given Query Store is enabled but no actual plan was captured, when historical evidence is imported, then SQL Evaluate uses persisted plan history and aggregated runtime or waits without describing the Query Store plan as an actual execution plan.
- AE12. **Covers R48-R50.** Given a case with sensitive SQL and plans, when the DBA saves a working case and a shareable report, then the working archive reopens with its evidence and warning while the shareable report remains redacted.

---

## Success Criteria

- The supplied 604-row workbook produces correct root blocking chains and materially fewer primary incidents than its current 99 findings.
- Every connected investigation identifies its primary incident, supporting evidence, confidence, and unresolved evidence gaps.
- Recommendations are distinct when evidence differs and duplicate diagnostic commands are not shown within an incident.
- A permission-limited account can complete partial analysis without application failure.
- File-only and connected captures produce deterministic results from the same evidence.
- Automated tests verify no outbound application traffic and no SQL statement outside the read-only allowlist.
- Existing file imports, saved reports, redacted exports, and Windows one-command launch remain compatible.
- The representative CPU-backed blocking case distinguishes every observed fact from each causal hypothesis and never promotes a hypothesis without the required evidence.
- A working case can be saved, reopened on another approved internal PC, extended with later files, and re-evaluated without a database.
- Different diagnostic profiles produce different evidence requests, evaluators, and next checks rather than renamed copies of one generic recipe.

---

## Scope Boundaries

**Deferred for later**

- Continuous unattended monitoring and alerting.
- Import and deep analysis of arbitrary `.xel`, deadlock `.xdl`, SQLDiag, PSSDiag, or SQL LogScout packages.
- Long-term incident storage inside SQL Evaluate.
- User-configurable rule builders and environment-specific baselines.
- Automatic creation or enabling of Query Store, last-known-actual-plan collection, Extended Events sessions, or other server features.
- Arbitrary community-tool result shapes that do not match a supported, versioned import contract.

**Outside this product's identity**

- Internet research, cloud AI analysis, or external telemetry.
- Automatic remediation or server-state changes.
- Installing or updating third-party SQL Server procedures.
- Replacing enterprise monitoring, Query Store, Extended Events, or established DBA change control.

---

## Dependencies and Assumptions

- The connected Windows identity can authenticate to the target instance and receives only the diagnostic permissions approved by the DBA team.
- Query Store, last-known-actual plans, `system_health`, and First Responder Kit evidence are optional and may be unavailable by version, configuration, platform, or permission.
- SQL text, plans, host names, database names, login names, and parameters are sensitive internal data.
- The first connected release targets supported on-premises SQL Server on Windows; platform variants require explicit compatibility review during planning.
- Collection overhead must remain visible and bounded, especially for plans, lock XML, Query Store, and Extended Events evidence.
- Working-case archives are files under the DBA's control and may contain sensitive evidence; SQL Evaluate does not claim that a raw working case is safe to share.
- Manual result collection may span several files, so every generated recipe and returned evidence set must carry identifiers that allow deterministic case association.

---

## Sources and Research

- Current product constraints and behavior: `README.md`, `HOW_IT_WORKS.md`, `src/lib/ingest.ts`, `src/lib/normalize.ts`, `src/rules/engine.ts`, and `src/lib/report.ts`.
- [Microsoft: Monitor performance with Query Store](https://learn.microsoft.com/en-us/sql/relational-databases/performance/monitoring-performance-by-using-the-query-store)
- [Microsoft: System dynamic management views](https://learn.microsoft.com/en-us/sql/relational-databases/system-dynamic-management-views/system-dynamic-management-views)
- [Microsoft: Use the system_health session](https://learn.microsoft.com/en-us/sql/relational-databases/extended-events/use-the-system-health-session)
- [Microsoft: Last known actual query plans](https://learn.microsoft.com/en-us/sql/relational-databases/system-dynamic-management-objects/sys-dm-exec-query-plan-stats-transact-sql)
- [Microsoft: SQL Server schedulers](https://learn.microsoft.com/en-us/sql/relational-databases/system-dynamic-management-objects/sys-dm-os-schedulers-transact-sql)
- [Microsoft: How Query Store collects data](https://learn.microsoft.com/en-us/sql/relational-databases/performance/how-query-store-collects-data)
- [Microsoft: Extended Event query post execution Showplan](https://learn.microsoft.com/en-us/shows/sql-workshops/extended-event-query-post-execution-showplan-in-sql-server)
- [Adam Machanic: sp_WhoIsActive](https://github.com/amachanic/sp_whoisactive)
- [Brent Ozar Unlimited: First Responder Kit](https://github.com/BrentOzarULTD/SQL-Server-First-Responder-Kit)
