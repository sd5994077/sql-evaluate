# SQL Evaluate

SQL Evaluate is an offline browser dashboard for triaging `sp_WhoIsActive` captures and SQL Server Showplan files. It reports evidence-backed High, Medium, Low, Informational, and Not Evaluated findings. It never connects to SQL Server and never executes remediation.

For a plain-language operating guide, see [How SQL Evaluate Works](HOW_IT_WORKS.md).

For a distributed release, recipients should begin with `START_HERE.txt`. Maintainers can create a clean release ZIP with `tools/package-release.ps1` after running `npm run check`.

## Run on Windows

Double-click **Start SQL Evaluate.cmd**. The launcher binds a small static server to `127.0.0.1`, opens the dashboard in your browser, and keeps all imported data in that browser session. Close the command window to stop it.

The committed `dist` bundle needs Node.js 20 or newer but does not need `npm install`.

## Supported inputs

- CSV/TSV exports, including quoted multiline fields and UTF-8/UTF-16 text
- XLSX/XLS workbooks; the most likely `sp_WhoIsActive` sheet is selected automatically
- SQL Server `.sqlplan` and Showplan XML files
- Embedded `query_plan` XML within a capture
- Previously exported `.sqleval.json` reports
- Previously saved `.sqlevalcase.zip` Deep Analysis cases
- SQL Evaluate server-capability snapshots saved from the generated read-only preflight

Capture files are limited to 100 MB and plan files to 25 MB. Unknown future columns are preserved. Missing optional fields disable only the rules that require them.

Duplicate capture headers are preserved with numbered suffixes and reported as an input warning. Text values such as `NULL` are normalized to missing values for calculations while the original imported values remain available in authorized raw exports.

## Import preview and unfinished work

Fresh captures, plans, and Deep Analysis evidence open a local preview before they are applied. Review file warnings, timestamps, recognized evidence, and worksheets; uncheck files to exclude them. For activity workbooks, choose another recognizable worksheet if needed. Deep Analysis inspects all sheets as before.

Choose **New analysis** or **Add to current analysis** when original capture files remain in this browser session. Reopened redacted reports require the original captures to be selected again. Opening saved reports and cases uses their dedicated validation flow.

Reports and cases show their download state. Replacing unfinished work offers **Download and continue**, **Discard and continue**, or **Cancel**. Leaving or reloading warns while changes remain. **Download prepared** means a download was initiated; check browser downloads because SQL Evaluate cannot verify disk storage. A report JSON or Run ZIP checkpoints the report. Only a working-case ZIP checkpoints a case; redacted case exports do not.

Use **Edit case details** to set the title, ticket reference, plain-text notes, and Investigating / Waiting for evidence / Closed status. These are human tracking fields, not diagnostic findings. Handwritten fields are saved only in the sensitive working-case ZIP and omitted from redacted handoffs. Schema 1.5 cases require the updated app; older schemas 1.0–1.4 continue to open.

## Guided investigation

Consequential reports show a case-level **Start here** guide above the finding list. It summarizes the last observed state, the most important evidence gap, and one primary action; up to four follow-up steps remain collapsed until requested. Each step discloses when it applies, the evidence it should produce, collection cautions, and links to its source findings. Commands are copied for manual DBA review onlyâ€”SQL Evaluate never executes them.

Resource evidence preserves supplied `*_delta` values as interval totals. SQL Evaluate derives per-second rates only from non-decreasing cumulative counters with valid capture timestamps; it does not assume that the time between imported rows equals an unstored delta interval.

When a plan is missing, **Choose plan** analyzes the selected plan together with the original capture files still held in the current browser session. If the user opened an exported report, the original capture must be selected again because a redacted report cannot reconstruct omitted row-level evidence.

## Deep Analysis

The **Deep Analysis** tab turns a consequential finding into a persistent, evidence-led investigation. Ready profiles cover transaction-owned and CPU-backed blocking, worker exhaustion, compilation and plan-cache pressure, execution memory grants, Spill Triage, plan-specific serialization or conversion, and actual-plan acquisition. Each profile separates what was observed, supported, contradicted, and not yet evaluated.

SQL Evaluate displays a bounded, read-only collection script for a DBA to review and run manually in an approved SQL Server tool. The application never connects to SQL Server or executes that script. Export each result grid as CSV/XLSX, and export a same-moment cached or actual plan as XML/`.sqlplan`; then import those files into the case. Deep Analysis also recognizes structured `sp_BlitzCache` exports, existing Query Store exports, and XML/CSV exported from a separately approved Extended Events capture. Direct binary `.xel` parsing is not included. Conflicting evidence stays visible instead of being forced into a conclusion.

Stable SQL Server identities—session/request/transaction IDs, SQL and plan handles, query/plan hashes, statement offsets, or Query Store IDs—are required to connect query-specific evidence. Similar SQL text can suggest where a DBA should look, but it does not establish a causal link. Evidence outside the incident window remains contextual.

The plan-capture escalation ladder is visible in the case: live request plus plan, already-enabled last-known actual plan, existing Query Store history, and only then a narrowly filtered post-execution Showplan Extended Events recipe. The last option is administrative and potentially expensive; it is clearly separated from the read-only recipes and requires independent approval.

Import the generated **Server capability snapshot** before using version-dependent collection paths. It records SQL Server version and edition, the affected database, effective visibility permissions, `LAST_QUERY_PLAN_STATS`, Query Store state, and compatible diagnostic objects in a selected DBA utility database. Routing uses these observed capabilities rather than edition assumptions. SQL Evaluate does not enable features, install tools, or connect to the server.

When Query Store is already active, select a spill candidate and use **Review existing Query Store history**. Run the generated bounded query in the affected database, save its single grid as CSV/XLSX, and import it. The export contains one row per retained plan with stable identity and aggregated runtime history. Query Store plans are persisted compile plans—not actual per-execution plans—and a newly enabled Query Store has no earlier history. See [the diagnostic catalog](docs/diagnostic-tool-catalog.md#query-store-retrieval-process).

The bundled diagnostic catalog covers supported First Responder Kit procedures, `sp_WhoIsActive`, native DMV fallbacks, and read-only inspection of existing Ola Hallengren history. It does not recommend cache eviction, session termination, restores, maintenance execution, installation/update scripts, or external AI options. See [Diagnostic tool catalog](docs/diagnostic-tool-catalog.md).

Use **Save Case ZIP** to preserve the case, imported evidence, file hashes, event history, identity correlation, plan-capture attempts, and current evidence states without a database. A `.sqlevalcase.zip` is a sensitive working archive and is not redacted; store it only in an access-controlled internal location. Deep Analysis can also export redacted JSON, assertion CSV, and printable HTML for handoff. Those handoffs are built from a separate allowlist, omit raw evidence and stable identifiers, and cannot be reopened as working cases.

Use **Investigation History** to import multiple sensitive case archives and count recurring row-estimate, spill, conversion, predicate, and statistics observations by server and portable database object. History remains in memory until explicitly saved as `.sqlevalhistory.zip`; SQL Evaluate does not retain it in browser storage. A server capability snapshot is required before a case contributes to recurrence totals. Statistics maintenance remains operator-reviewed: run and import the generated read-only verification first, then use the guarded Ola Hallengren preview, which defaults to `@Execute = 'N'` and performs no index rebuild or reorganization.

### Spill Triage

Start Spill Triage from the landing page, Deep Analysis, or a runtime spill finding. Import a CSV/XLSX `sp_BlitzCache` result produced with `@SortOrder = 'Spills'`; SQL Evaluate ranks only rows with valid positive spill metrics. The default order is total 8 KB spill pages, average spill pages per execution, last execution, then source row. A separate callout keeps the highest per-execution spiller visible when it differs from the highest cumulative spiller.

The imported row count may be a bounded `@Top` result. Ten rows do not prove that only ten plans spilled. Different plan handles remain separate even when their query hash is the same. Upload a cached or actual Showplan to continue: correlation requires stable SQL Server identity, Query Store IDs require matching database context for an exact match, and similar SQL text never establishes a match. If multiple statements have the same strongest non-conflicting identity, SQL Evaluate blocks automatic correlation and offers a reversible manual choice. Cached/estimated plans provide compile-time shape only; runtime spill pages, grants, operator counts, and upstream estimate errors are shown only from actual-plan evidence.

When a `.sqlplan` omits stable identity, use the **Cached plan with stable provenance** ladder step. Its CSV/XLSX result keeps `query_plan`, plan and SQL handles, paired hashes, statement offsets, and database ID in the same row. SQL Evaluate can attach that sidecar identity to one unambiguous Showplan statement; conflicting identity is preserved as a warning and never overwritten. When validated Query Store sidecar IDs are present, an embedded Showplan statement `sql_handle` is not treated as a plan-cache handle.

`Remove Plan Handle From Cache` values are retained only behind an administrative-source warning. They are not recommended remediation, have no one-click action, and are never executed by SQL Evaluate.

## Diagnostic interpretation

- Positive `blocking_session_id` values are treated as SQL Server session IDs. Negative values (`-2` through `-5`) are SQL Server special owner states and are labeled by meaning instead of being presented as blocker SPIDs.
- Native `wait_info` values support single-task and multi-task forms. Multi-task input retains its task count and supplied durations; malformed parenthesized waits stay in original activity data and are disclosed as input warnings.
- A single blocked session or actionable wait seen in only one capture remains a lower-confidence transient signal. High wait severity requires persistence or repeated capture evidence.
- Showplan predicates are classified by access-path role. An ordinary scan predicate is not called residual or non-SARGable unless explicit residual evidence or a supported conversion/leading-wildcard scan cause is present.
- `tempdb_current` and `tempdb_allocations` are request/session page counters. SQL Evaluate displays their approximate MB or GB equivalent, but these fields do not measure total TempDB used percentage, free space inside the TempDB data files, or free space on the Windows volume.
- Overall TempDB capacity conclusions require a separate capture of file-space usage and volume headroom.

## Privacy and exports

No telemetry or upload code is present. JSON, CSV, printable HTML, and run-bundle exports redact SQL text, plan literals, host, login, program, and database values by default. Default exports also omit normalized row-level activity; aggregate findings and the ordered investigation guide remain. Row-level activity and original source files require the explicit, warning-backed **Include raw details** choice.

When a finding family is capped for bounded rendering, Data Quality and every report export state the rule, retained count, suppressed count, and ordering used.

Use **Save Run ZIP** to download a complete, uniquely named analysis package without a database. A standard package contains:

- `manifest.json` with run identity, application version, source checksums, and counts
- `results/analysis.sqleval.json`
- `results/findings.csv`
- `results/investigation-guide.csv`
- `results/report.html`
- `normalized/activity.csv`
- `diagnostics/processing-log.json`

`normalized/activity.csv` is schema-only in the default redacted archive and is populated only when **Include raw details** is enabled. Original uploaded captures and plans are likewise included under `source/` only after that choice. See [Run archives](docs/run-archives.md) for retention and future database guidance.

## Development

```powershell
npm install
npm run dev
npm test
npm run build
npm run check
```

To run the optional integration check against a local sanitized workbook:

```powershell
$env:SQL_EVALUATE_SAMPLE = 'C:\path\to\capture.xlsx'
npm test
```

Diagnostic thresholds and primary references are defined in `src/rules/catalog.ts`. Rules are advisory and should be validated against workload context.
