# SQL Evaluate — Spill Triage Identity & Workbook Variance (CLAUDE-SPILL-002)

Black-box review. Evidence: `fixtures/CLAUDE-SPILL-002/` only (`spill-review.xlsx`, `evidence-a…e.sqlplan`).
App driven live at `http://localhost:5173`; state observed through the DOM (screenshots do not render in this harness). No source, tests, git history, other fixtures, prior conversations, plans, or the saved ZIP’s raw contents were inspected. Offline confirmed: no network requests, no DB traffic, console free of application errors.

---

## 1. Workbook import and candidate ranking

**Sheets recognized vs ignored.** The workbook has three sheets — `Read Me`, `CPU Snapshot`, `Spill Review`. The app used **`Spill Review`** (shown as `spill-review.xlsx · Spill Review`) and produced spill candidates only from it. `Read Me` (prose) and `CPU Snapshot` (Captured At / CPU Percent / Runnable Tasks) contributed nothing. **The app never states that two sheets were skipped** — only the used sheet name is shown (see Defect D2).

**Header below worksheet start.** In `Spill Review`, rows 1–5 are preamble (title, Generated, Source, Requested sort, Review note); the column header is **row 6**; data is rows 7–16. The app imported exactly the 10 data rows, so it **did locate the header below the top of the sheet**, but **it does not disclose the offset** (no “header found at row 6” message) (D2).

**Row counts.** `10 rows · 8 rankable · 2 unknown columns preserved`. `RANKING COVERAGE: 8 ranked, 2 warning-only, zero, or malformed` (8 + 2 = 10).

**Ranking order** (caption: *“ordered by cumulative impact, average impact, recency, then source row”*):

| Rank | Object | Total | Per-exec | Exec | Last exec | Identity shown |
|---|---|---|---|---|---|---|
| 1 | dbo.AuroraProcess | 500,000 pg (3.81 GiB) | 50,000 pg | 10 | 2026-09-02 10:00:00 | **Identity incomplete** |
| 2 | dbo.AuroraConflict | 500,000 pg (3.81 GiB) | 50,000 pg | 10 | 2026-09-02 10:00:00 | 0xAA02 · *plan variant retained* |
| 3 | dbo.BeaconBatch | 420,000 pg (3.2 GiB) | 70,000 pg (*Derived: 420000 / 6*) | 6 | 10:10:00 | 0xB3A · query hash |
| 4 | dbo.CipherLookup | 350,000 pg (2.67 GiB) | 70,000 pg | 5 | 10:20:00 | 0xC4A · query hash |
| 5 | dbo.CipherLookup | 340,000 pg (2.59 GiB) | 85,000 pg | 4 | 10:25:00 | 0xC4B · query hash |
| 6 | dbo.DeltaQueryHashOnly | 90,000 pg (0.69 GiB) | 90,000 pg | 1 | 10:30:00 | 0xD600 · query hash |
| 7 | dbo.EchoAverageOnly | **Not supplied** | 120,000 pg (0.92 GiB) | 2 | 10:40:00 | 0xE701 · query hash |
| 8 | dbo.FoxtrotInconsistent | **0 pages (0 GiB)** | 60,000 pg | 4 | 10:45:00 | 0xF800 · *plan variant retained* |
| — | dbo.GolfMalformed | Not supplied | Not supplied | 15 | 10:50:00 | 0xG900 · *plan variant retained* |
| — | dbo.HotelExplicitUnit | Not supplied | Not supplied | 2 | **Not supplied** | 0xH1A · query hash |

**First-candidate reason (verbatim):** *“Rank 1: highest-priority spill candidate — Ranked by cumulative spill impact: 500,000 pages total; 50,000 pages per execution.”*

**Exact-tie resolution.** Rows for AuroraProcess and AuroraConflict are identical on total (500,000), average (50,000), executions (10) and last-execution timestamp (`2026-09-02 10:00:00`). The documented chain is cumulative → average → recency → **source row**. All three tiebreakers tie, so **source-row order decides**: the earlier sheet row (AuroraProcess, row 7) becomes Rank 1, AuroraConflict (row 8) Rank 2.

**Highest cumulative vs highest per-execution — not the same candidate.**
- Highest per-execution: **`0xE701` / dbo.EchoAverageOnly, 120,000 pages/exec** (ranked #7).
- Highest cumulative: the 500,000-page rows (Rank 1/2). The “HIGHEST CUMULATIVE IMPACT” card shows **`No ranked candidate` / 500,000 pages (3.81 GiB)** — a contradiction, since Rank 1 exists with exactly that figure (Defect D1).

**Value-type handling**

| Type | Row | Behavior |
|---|---|---|
| Total-backed | AuroraProcess/Conflict, Cipher×2, Delta | Ranked on cumulative pages. |
| Total present, average missing | BeaconBatch | Ranked; per-exec shown as `Derived: 420000 total pages / 6 executions`. |
| Average-only (total blank) | EchoAverageOnly | Ranked (#7) in the average-backed group; total = `Not supplied`; per-exec from the average column. |
| Zero total, positive average | FoxtrotInconsistent | Ranked (#8) via average; total shown as `0 pages (0 GiB)`; DQ: *“1 row reports zero total spills with a positive average and is ranked only in the average-backed group.”* (WHY-panel wording differs — see D4.) |
| Malformed (`TotalSpills = "many"`) | GolfMalformed | **Unranked**, still listed; DQ: *“1 row contains malformed spill values and cannot use those values for ranking.”* |
| Warning-only (no numeric spill) | GolfMalformed, HotelExplicitUnit | *“2 warning-only rows remain visible but unranked because numeric spill evidence is absent.”* |
| Invalid timestamp (`Last Executed = "recently"`) | HotelExplicitUnit | Last execution shown `Not supplied`; DQ: *“1 last-execution timestamp could not be parsed and did not affect ranking.”* |
| Explicit unit column (`Total Spill MiB = 800`, warning *“Spill volume supplied in MiB”*) | HotelExplicitUnit | The MiB value is **not** interpreted or converted; it is filed under *Unknown columns* and the row stays unranked. Conservative and safe, but 800 MiB of stated spill is dropped from ranking with no dedicated callout (see notes). |
| Missing CPU/duration/reads | all | *“Missing metrics: CPU, duration, reads. Missing values are not treated as zero.”* |

**Unknown columns — disclosed and preserved.** `2 unknown columns preserved`, named in an expandable block: **`Total Spill MiB, Future Spill Class`**.

**Cached plan variants sharing query-level identity stay distinguishable.** CipherLookup rows 10 and 11 share `QueryHash 0xC400` and database context but differ in `QueryPlanHash` (`0xC4A` vs `0xC4B`); they appear as **separate rows Rank 4 and Rank 5**, each tagged “query hash supplied”. Rows carrying a `PlanHandle` additionally show `· plan variant retained`.

**What importing exactly ten rows proves (verbatim).** *“Ten rows were imported. This is consistent with @Top = 10; it does not prove that only ten cached plans spilled.”* (shown as an Import-Boundary note and again in Data Quality).

---

## 2. Plan correlation matrix

Imported in filename order `evidence-a…e`. Match-quality tiers observed: **Exact** (plan_handle, or sql_handle+offsets, or Query Store query+plan) > **Strong** (query_hash + query_plan_hash in compatible DB) > none.

| Candidate | Evidence | Connection state | Match quality | Application’s displayed reason |
|---|---|---|---|---|
| Rank 1 dbo.AuroraProcess | evidence-a.sqlplan (stmt 1) | **Connected** | **Exact STABLE-IDENTITY MATCH** | “Query Store query 7001 and plan 7101 match.” |
| Rank 2 dbo.AuroraConflict | evidence-e.sqlplan (stmt 1) | **Not connected — blocked** | — | “No supported stable identifier matches… Similar SQL text is never used as a match.” Query_hash/query_plan_hash/QS ids all agree, but `PlanHandle` conflicts (`0xAA02` row vs `0xBB02` plan) → connection refused. |
| Rank 3 dbo.BeaconBatch | evidence-b.sqlplan | **Connected** | **Exact STABLE-IDENTITY MATCH** | “The sql_handle and statement offsets match.” |
| Rank 4 dbo.CipherLookup (0xC4A) | evidence-c.sqlplan | **Connected** | **Strong STABLE-IDENTITY MATCH** | “The query_hash and query_plan_hash match in compatible database context.” |
| Rank 5 dbo.CipherLookup (0xC4B) | evidence-c.sqlplan | **Not connected** | — | “No supported stable identifier matches…” — shares `query_hash 0xC400` with evidence-c but `query_plan_hash` differs (`0xC4B` ≠ `0xC4A`), so the shared hash is **not** accepted. |
| Rank 6 dbo.DeltaQueryHashOnly | evidence-e.sqlplan (stmt 2) | **Not connected** | — | “**The query_hash matches, but the plan identity is absent or different.** … Similar SQL text is never used as a match.” (row has no query_plan_hash / plan_handle) |
| Rank 7 dbo.EchoAverageOnly | evidence-d.sqlplan (stmts 1 & 2) | **Not connected — ambiguous** | — | “**Matching plan is ambiguous** — 2 plans or statements share the best stable-identity match. Choose the intended plan explicitly.” (`sql_handle 0xE700` matches both statements) |
| Rank 8 dbo.FoxtrotInconsistent | — | Uncorrelated | — | “No supported stable identifier matches…” (no evidence file carries `0xF8xx`) |
| Unranked dbo.GolfMalformed | — | Uncorrelated | — | “No supported stable identifier matches…” |
| Unranked dbo.HotelExplicitUnit | — | Uncorrelated | — | “No supported stable identifier matches…” |

**Ambiguous / uncorrelated:** Rank 7 (ambiguous, two statements under one `sql_handle`), Ranks 5, 6, 8 and both Unranked rows (uncorrelated).
**Conflicting identifiers blocked a connection:** **Yes** — Rank 2: a `PlanHandle` conflict overrode agreeing `query_hash` + `query_plan_hash` + Query Store ids; the app did not fall back to the weaker matches.
**Query-hash-only / similar SQL text accepted as proof:** **No.** Rank 5 (shared `query_hash`, different `query_plan_hash`) and Rank 6 (`query_hash` only) were both refused, the latter with an explicit “query_hash matches, but the plan identity is absent or different” message. “Similar SQL text is never used as a match” is stated on every non-match.
**Two variants sharing a query hash stay separate:** **Yes** — CipherLookup 0xC4A / 0xC4B remain distinct rows and evidence-c connects to only one (0xC4A) via `query_plan_hash`.

---

## 3. Actual versus estimated evidence

**evidence-a → dbo.AuroraProcess — runtime (actual) evidence.** Header: *“1 spilling operator in the matched actual statement.”*
- Spilling operator / node: **Sort · Node 12**
- Spill level: **2**
- Pages written to tempdb: **131,072 pages (1 GiB)**
- Pages read from tempdb: **Not supplied** (the plan XML omits it — correctly left unavailable, not zero-filled)
- Memory grant: **2,097,152 KB granted / 1,966,080 KB used**
- Thread count: **not shown** (the plan carries `SpilledThreadCount="3"`); `TempdbFileCount="6"` and `DegreeOfParallelism` also not shown — see Defect D3.
- Feeding estimate error: **Node 27 Clustered Index Scan, estimated 5 rows, processed 5,000,000 rows (1,000,000×), 2 input hops before the spill.** Correctly identifies the deepest/largest error in the feeding chain (Node 27 → Node 20 Hash 50,000× → Node 12 Sort).
- **No cross-statement contamination:** evidence-a’s second statement (“synthetic unrelated statement”, Query Store 7999, an Index Seek) is not shown or attributed to the matched statement.

**evidence-b → dbo.BeaconBatch — compile-time only.** *“Estimated/cached plan evidence — This plan can show compile-time shape and estimates. Runtime operator counts and spill volumes are not available and are not inferred from the BlitzCache row.”* No runtime figures invented.

**evidence-c → dbo.CipherLookup (Rank 4) — compile-time only.** Same “Estimated/cached plan evidence” disclosure; “Strong” match, appropriately not labeled “Exact”.

**evidence-d, evidence-e** — never connected (ambiguous / blocked / uncorrelated), so no evidence surface is shown for them.

---

## 4. Persistence, Data Quality, and safety

**Persistence — PASS.** Saved the case (`Save case ZIP` → `SQL-Evaluate-Case_20260902-212802-545cfbcc.sqlevalcase.zip`, 20,984 bytes, valid ZIP). Full page reload → landing screen, **no auto-restore** (working case is not silently persisted). Reopened the ZIP through the app. After reopen, all of the following were byte-identical to pre-save:
- Ranking order and every displayed metric (Rank 1–8 + 2 Unranked).
- **Selected candidate:** `dbo.EchoAverageOnly` (what was selected at save time).
- **Imported plans + correlation state:** AuroraProcess = Exact (QS 7001/7101), BeaconBatch = Exact (sql_handle+offsets), CipherLookup Rank 4 = Strong (hashes), EchoAverageOnly = “Matching plan is ambiguous”.
- Data Quality panel text, counts, and unknown-column list.

**Data Quality disclosures present:** top-N boundary and “does not prove which parameters produced it”; missing-metric list with “not treated as zero”; malformed-row count; warning-only count; unparsed-timestamp count; “3 rows lack enough stable plan identity for automatic correlation”; zero-total/positive-average note; unknown columns named.

**Safety.**
- **Save is gated by an explicit confirmation:** *“This working case may contain raw SQL, plans, identifiers, database names, and parameters. Save the sensitive case ZIP to a protected internal location?”*
- **Cache-removal text is provenance only.** Shown for `dbo.GolfMalformed` inside a collapsed *“Administrative source text — not a recommendation”* block: *“This command came from the source export. It changes SQL Server cache state, is not a recommendation from SQL Evaluate, and is never executed here.”* → `Remove Plan Handle From Cache: DBCC FREEPROCCACHE (0xG900);`. Rendered as inert text — no button, no execution, not framed as advice.
- No SQL Server connection, no query execution, no server mutation observed. Offline throughout.
- No root-cause claim: Rank 1 is labeled a *“highest-priority spill candidate”* ranked by impact; the plan finding is a *“feeding estimate error”*, not a proven cause.

---

## 5. Accessibility and narrow-screen usability

**Keyboard.** Candidate controls are real `<button>` elements, `tabindex 0`, in linear DOM/tab order (…`Open case` → `Import evidence` → `Save case ZIP` → 10 row buttons), no positive tabindex, no focus trap. Selecting a candidate deliberately moves focus to `<section tabindex="-1" aria-labelledby="spill-selected-title">` (the “WHY THIS CANDIDATE” region) — good managed-focus behavior for screen-reader users. Global focus indicator present: `:focus-visible { outline: 2px solid var(--cyan); outline-offset: 3px }`. Selected state is conveyed by **text** (“Selected” vs “Investigate”) **and** `aria-pressed`, not by color alone. *Live Tab/Enter activation could not be exercised end-to-end through this automation harness (synthetic key events were not delivered to the focused control); the markup supports native activation.*

**375 × 812.**
- **No page-level horizontal scroll** (`document.scrollWidth == 375`); no element exceeds the viewport width.
- Candidate table reflows to stacked cards (`display:block`); each cell carries `data-label` and a `::before` label (e.g. “Executions”), so column meaning is preserved.
- Stage 2 evidence (spill level, tempdb written, tempdb read, grant/use, feeding-estimate sentence) renders in full with **no clipping**; Data Quality and the summary cards stack without loss.
- No labels lost, no focus loss to `<body>`, no state conveyed only by color observed at this width.

**Repeat accessibility issue (also present in the prior Spill Triage build):** all ten row action buttons expose the identical accessible name **“Investigate”** with no `aria-label` / `aria-describedby`; only the active one differs (“Selected”). A non-visual user listing controls cannot tell the ten candidates apart. — see Defect D5.

---

## 6. Defects or misleading claims

### D1 — “Highest cumulative impact” card says *No ranked candidate* while Rank 1 holds that value — **Medium**
- **Repro:** Spill Triage → import `spill-review.xlsx` (no plans) → read the “HIGHEST CUMULATIVE IMPACT” summary card vs the candidate table.
- **Observed:** Card shows label **“No ranked candidate”** with value **“500,000 pages (3.81 GiB)”**, while Rank 1 (`dbo.AuroraProcess`) is populated and SELECTED with exactly 500,000 pages cumulative. The top-cumulative row has “Identity incomplete”, which appears to suppress the card’s name — but the card then asserts no ranked candidate exists rather than naming the next identity-bearing row (`0xAA02`, also 500,000) or saying “identity incomplete”.
- **Expected:** The card should name the highest-cumulative ranked candidate (or state “identity incomplete” for it); it must not read as “nothing is ranked” when Rank 1 is present with the shown figure.
- **DBA impact:** A DBA skimming the summary can conclude no cumulative leader was found and mis-prioritise, contradicting the table directly below.

### D2 — Workbook sheet selection and header offset are not disclosed — **Medium**
- **Repro:** Import `spill-review.xlsx` (sheets `Read Me`, `CPU Snapshot`, `Spill Review`; data header on row 6 of the third sheet). Read Data Quality fully.
- **Observed:** Output names only `spill-review.xlsx · Spill Review`. Nothing states that two other sheets were examined and skipped, nor that the header was located at row 6 below five preamble rows. (Behaviour is otherwise correct — right sheet, right 10 rows.)
- **Expected:** For a Data-Quality-centric tool, disclose which sheet was used, which were ignored and why, and the detected header row — so the DBA can catch a wrong-sheet guess.
- **DBA impact:** On a workbook where the heuristic picks the wrong sheet or header row, the error is silent; the DBA has no signal to distrust the candidate list.

### D3 — Available runtime spill fields dropped from the operator card — **Low**
- **Repro:** Import `spill-review.xlsx` + `evidence-a.sqlplan`; select `dbo.AuroraProcess`; read Stage 2.
- **Observed:** `SortSpillDetails` in the plan carries `SpilledThreadCount="3"` and `TempdbFileCount="6"`; `QueryPlan` carries `DegreeOfParallelism="4"`. None appear in the UI (page text contains no “thread”, “file count”, or “parallelism”). Spill level, pages written, grant/use, and the correctly-blank “tempdb read” are shown.
- **Expected:** Show spilled thread count (and ideally tempdb file count / DOP) alongside spill level — the review explicitly calls for thread count where supplied.
- **DBA impact:** Incomplete parallel-spill picture; thread count is a normal input to grant-vs-DOP tuning.

### D4 — Zero-total row: inconsistent wording between the WHY panel and Data Quality — **Low**
- **Repro:** Import `spill-review.xlsx`; select Rank 8 `dbo.FoxtrotInconsistent` (workbook `TotalSpills = 0`, `AverageSpills = 60000`).
- **Observed:** Table cell shows `0 pages (0 GiB)`; Data Quality says *“1 row reports zero total spills with a positive average…”*; the WHY panel says *“Total spill volume was **not supplied**; ranked in the average-only group…”*. “Zero” and “not supplied” are used for the same row.
- **Expected:** One consistent description (the value is zero, not missing).
- **DBA impact:** Minor confusion about whether the source reported 0 or omitted the field.

### D5 — All candidate action buttons share the accessible name “Investigate” — **Medium** (accessibility; also seen in the previous build)
- **Repro:** Import `spill-review.xlsx`; inspect the action column / navigate it by control with a screen reader.
- **Observed:** Ten `<button>`s, accessible name “Investigate” (one “Selected”), no `aria-label`/`aria-describedby`/`title`. Row identity (rank, plan hash, object) is in sibling cells only.
- **Expected:** Each button names its target, e.g. `aria-label="Investigate Rank 3 — 0xB3A / dbo.BeaconBatch"`.
- **DBA impact:** WCAG 2.4.4 / 2.4.9 failure; a non-visual user cannot distinguish the ten candidates when listing controls.

### D6 — No in-product way to resolve an ambiguous match — **Low**
- **Repro:** Import `spill-review.xlsx` + `evidence-d.sqlplan`; select Rank 7 `dbo.EchoAverageOnly` → “Matching plan is ambiguous… Choose the intended plan explicitly.” Click **Choose matching plan**.
- **Observed:** No in-app picker for the two already-imported evidence-d statements appears; the control only offers to import another file (it triggers the OS file dialog, which this harness cannot service, so nothing further was observable). The ambiguity is detected correctly and the app safely refuses to guess — but the only offered resolution is importing more evidence.
- **Expected:** Offer an explicit chooser listing the tied statements (by offset / statement text / node) so the user can bind the intended one.
- **DBA impact:** A legitimately ambiguous case (`sql_handle` shared by two statements) is a dead end even though `query_hash` on the candidate row uniquely identifies statement 1.

### Areas with no defect found
- **Plan correlation correctness:** no false positives. Query-hash-only overlap (Rank 5, Rank 6) rejected; a `plan_handle` conflict blocked an otherwise-strong match (Rank 2); Query Store query+plan accepted as Exact; sql_handle+offsets accepted as Exact; query_hash+query_plan_hash accepted only as “Strong”. Ambiguous `sql_handle` (Rank 7) flagged, not guessed.
- **Compile-time vs runtime separation:** every connected estimated plan is labeled “Estimated/cached plan evidence”; unavailable runtime metrics stay labeled unavailable (`tempdb read: Not supplied`); missing values never zero-filled.
- **Cross-statement attribution:** evidence-a statement 2 not attributed to the matched statement.
- **Persistence:** ranking, selection, plans, correlation, and Data Quality all survive a ZIP save → reload → reopen round-trip.
- **Safety:** export gated by a sensitive-data confirmation; cache-removal command shown as inert provenance; fully offline; no root-cause overclaim.
- **Narrow screen:** no page-level horizontal scroll, no clipped controls, no missing labels, no color-only state at 375×812.
- **Console:** no application errors or warnings (only harness-level dialog/file-chooser suppression messages).

---

## 7. Overall verdict

**Fit for DBA use, with clarity fixes recommended.** SQL Evaluate’s Spill Triage correctly ranks a messy 10-row workbook, is transparent about missing/zero/malformed/average-only data, keeps plan variants separate, and — most importantly — its identity engine is conservative in exactly the right ways: it refuses query-hash-only matches, blocks matches when a stronger identifier conflicts, flags true ambiguity instead of guessing, grades match quality (Exact vs Strong), separates compile-time from runtime evidence, and never presents the cache-removal command as an action. Persistence is reliable and the export is safety-gated.

The gaps are communication, not correctness: a summary card that contradicts the ranked table (**D1**), silent workbook sheet/header selection (**D2**), and a recurring screen-reader labeling gap on the candidate buttons (**D5**) are the items worth fixing before this is handed to a broad DBA audience. **D3/D4/D6** are minor polish. No candidate is presented as a proven root cause, and no evidence here would establish causation if it were.
