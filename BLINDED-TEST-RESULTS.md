# SQL Evaluate blinded fixture results

Test date: 2026-08-29  
Application: SQL Evaluate 1.3.0  
Method: Visible production-browser run against the opaque `fixtures/CASE-*` packages. The private answer key was not present or inspected.

## Observed results

| Case | Rows | Captures | Plans | High | Medium | Low | Info | Not evaluated | Deep Analysis |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| CASE-001 | 78 | 46 | 0 | 0 | 0 | 59 | 0 | 1 | 0 |
| CASE-002 | 182 | 42 | 0 | 5 | 2 | 8 | 0 | 1 | 1 |
| CASE-003 | 200 | 50 | 0 | 5 | 0 | 4 | 0 | 1 | 1 |
| CASE-004 | 417 | 40 | 1 | 0 | 0 | 44 | 0 | 0 | 0 |
| CASE-005 | 664 | 45 | 0 | 20 | 0 | 24 | 0 | 1 | 0 |
| CASE-006 | 35 | 35 | 1 | 3 | 0 | 1 | 0 | 0 | 0 |
| CASE-007 | 32 | 32 | 1 | 1 | 0 | 0 | 0 | 0 | 0 |
| CASE-008 | 36 | 36 | 1 | 2 | 0 | 1 | 0 | 0 | 0 |
| CASE-009 | 82 | 48 | 0 | 0 | 0 | 22 | 0 | 1 | 0 |
| CASE-010 | 1 | 1 | 1 | 0 | 0 | 0 | 0 | 1 | 0 |

## Notable application output

- CASE-002: open transaction, root blocker, and sustained resource findings; CPU-backed blocking investigation offered.
- CASE-003: root blocker and sustained resource findings; CPU-backed blocking investigation offered.
- CASE-003 returned evidence: 50 scheduler samples imported successfully. Sustained scheduler pressure became Supported, while the proposed root open transaction became Contradicted.
- CASE-006: oversized memory grant, 700.6x row-estimate error, sustained resource use, and `RESOURCE_SEMAPHORE` detected.
- CASE-008: 1,000x row-estimate error, sustained resource use, and `PAGEIOLATCH_SH` detected.
- CASE-010: runtime-dependent plan checks correctly reported Not Evaluated for estimated-plan evidence.

## Improvement candidates identified without using the answer key

1. CASE-001 generated 59 Low findings from very short open transactions, 0 ms waits, and short capture-relative resource outliers. This is likely too noisy for a healthy or low-impact capture.
2. Repeated rows can become repeated findings with identical session titles, particularly in CASE-001 and CASE-009. Episode-level consolidation should be stronger.
3. CASE-004 and CASE-005 produced generic resource findings but no Deep Analysis path. Their companion counter files therefore had no supported case workflow through which to be evaluated.
4. CASE-007 loaded a plan but produced only an activity resource finding. No plan-specific explanation was surfaced.
5. CASE-008 surfaced the estimate error but no additional plan-specific predicate or conversion explanation.
6. Raw `counters_*.csv` files are correctly rejected as front-door `sp_WhoIsActive` inputs. CASE-003 confirmed they work through Import Evidence after a Deep Analysis case exists.

## Browser integrity

- All ten capture/plan packages imported without application crashes.
- No page or console errors were reported during valid imports.
- No horizontal overflow was detected.
- No external resource origins were observed; resources loaded only from `127.0.0.1`.

## Answer-key comparison

The private answer key was opened only after the blinded browser results above were recorded.

| Case | Score | Comparison with ground truth |
|---|---|---|
| CASE-001 | **Fail** | Ground truth is a healthy baseline. The application produced 59 Low findings from benign 0 ms waits, very short transactions, and short resource observations. |
| CASE-002 | **Partial** | Correctly identified SPID 52 as a sleeping root blocker with an open transaction and four downstream sessions. The Deep Analysis case was incorrectly titled `CPU-backed blocking` and prioritized scheduler/plan collection instead of idle-client or connection-pool confirmation. |
| CASE-003 | **Pass** | Correctly identified the runnable root blocker. After importing the supplied scheduler evidence, it supported sustained scheduler pressure and contradicted the open-transaction theory while retaining appropriate plan limitations. |
| CASE-004 | **Fail** | Missed persistent `RESOURCE_SEMAPHORE_QUERY_COMPILE` and the ad-hoc compilation/plan-cache-pressure diagnosis. It emitted only generic Low resource findings and offered no Deep Analysis path. |
| CASE-005 | **Fail** | Recognized persistent `THREADPOOL` waits but rated each as Low because reported wait duration was 0 ms. It missed worker exhaustion severity and provided no worker-exhaustion investigation. |
| CASE-006 | **Partial** | Detected the oversized grant and severe estimate error, but did not surface the direct runtime spill and over-escalated the overall plan findings relative to the expected Medium concern. No memory-pressure Deep Analysis path was offered. |
| CASE-007 | **Fail** | Missed `NonParallelPlanReason`, the scalar UDF, and the forced-serial causal diagnosis. Only a generic resource finding was produced. |
| CASE-008 | **Fail** | Detected the estimate error and scan-related resource symptoms but missed the direct `PlanAffectingConvert`, residual predicate, and non-SARGable `LIKE` causes. |
| CASE-009 | **Partial** | Kept the isolated blocking observation Low, but produced 22 mostly generic Low findings instead of a concise Informational explanation that the 180 ms blip did not persist. |
| CASE-010 | **Partial** | Correctly marked runtime plan checks Not Evaluated, but did not recommend obtaining an actual execution plan. |

**Score:** 1 Pass, 4 Partial, 5 Fail.

## Prioritized corrective work

1. Suppress 0 ms benign waits and insignificant open transactions; require meaningful duration, persistence, or corroboration before emitting a finding.
2. Consolidate repeated session observations into one episode-level finding.
3. Add special severity logic for persistent `THREADPOOL` and `RESOURCE_SEMAPHORE_QUERY_COMPILE` evidence instead of relying primarily on parsed wait duration.
4. Add and connect Deep Analysis workflows for worker exhaustion, compile pressure, memory grants, and plan-specific problems.
5. Parse direct Showplan evidence for spills, `NonParallelPlanReason`, scalar UDFs, `PlanAffectingConvert`, residual predicates, and non-SARGable expressions.
6. Select the investigation narrative from the root state: sleeping open-transaction blockers must not be labeled CPU-backed.
7. Recommend an actual-plan capture when only estimated-plan evidence is available.
