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

Capture files are limited to 100 MB and plan files to 25 MB. Unknown future columns are preserved. Missing optional fields disable only the rules that require them.

Duplicate capture headers are preserved with numbered suffixes and reported as an input warning. Text values such as `NULL` are normalized to missing values for calculations while the original imported values remain available in authorized raw exports.

## Deep Analysis

The **Deep Analysis** tab turns a consequential finding into a persistent, evidence-led investigation. Ready profiles cover transaction-owned and CPU-backed blocking, worker exhaustion, compilation and plan-cache pressure, execution memory grants and spills, plan-specific serialization or conversion, and actual-plan acquisition. Each profile separates what was observed, supported, contradicted, and not yet evaluated.

SQL Evaluate displays a bounded, read-only collection script for a DBA to review and run manually in an approved SQL Server tool. The application never connects to SQL Server or executes that script. Export each result grid as CSV/XLSX, and export a same-moment cached or actual plan as XML/`.sqlplan`; then import those files into the case. Deep Analysis also recognizes structured `sp_BlitzCache` exports, existing Query Store exports, and XML/CSV exported from a separately approved Extended Events capture. Direct binary `.xel` parsing is not included. Conflicting evidence stays visible instead of being forced into a conclusion.

Stable SQL Server identities—session/request/transaction IDs, SQL and plan handles, query/plan hashes, statement offsets, or Query Store IDs—are required to connect query-specific evidence. Similar SQL text can suggest where a DBA should look, but it does not establish a causal link. Evidence outside the incident window remains contextual.

The plan-capture escalation ladder is visible in the case: live request plus plan, already-enabled last-known actual plan, existing Query Store history, and only then a narrowly filtered post-execution Showplan Extended Events recipe. The last option is administrative and potentially expensive; it is clearly separated from the read-only recipes and requires independent approval.

Use **Save Case ZIP** to preserve the case, imported evidence, file hashes, event history, identity correlation, plan-capture attempts, and current evidence states without a database. A `.sqlevalcase.zip` is a sensitive working archive and is not redacted; store it only in an access-controlled internal location. Deep Analysis can also export redacted JSON, assertion CSV, and printable HTML for handoff.

## Diagnostic interpretation

- Positive `blocking_session_id` values are treated as SQL Server session IDs. Negative values (`-2` through `-5`) are SQL Server special owner states and are labeled by meaning instead of being presented as blocker SPIDs.
- Native `wait_info` values support single-task and multi-task forms. Multi-task input retains its task count and supplied durations; malformed parenthesized waits stay in original activity data and are disclosed as input warnings.
- A single blocked session or actionable wait seen in only one capture remains a lower-confidence transient signal. High wait severity requires persistence or repeated capture evidence.
- Showplan predicates are classified by access-path role. An ordinary scan predicate is not called residual or non-SARGable unless explicit residual evidence or a supported conversion/leading-wildcard scan cause is present.
- `tempdb_current` and `tempdb_allocations` are request/session page counters. SQL Evaluate displays their approximate MB or GB equivalent, but these fields do not measure total TempDB used percentage, free space inside the TempDB data files, or free space on the Windows volume.
- Overall TempDB capacity conclusions require a separate capture of file-space usage and volume headroom.

## Privacy and exports

No telemetry or upload code is present. JSON, CSV, and printable HTML exports redact SQL text, plan literals, host, login, program, and database values by default. Raw export is an explicit, warning-backed choice.

When a finding family is capped for bounded rendering, Data Quality and every report export state the rule, retained count, suppressed count, and ordering used.

Use **Save Run ZIP** to download a complete, uniquely named analysis package without a database. A standard package contains:

- `manifest.json` with run identity, application version, source checksums, and counts
- `results/analysis.sqleval.json`
- `results/findings.csv`
- `results/report.html`
- `normalized/activity.csv`
- `diagnostics/processing-log.json`

The original uploaded capture or plan is included under `source/` only when **Include raw details** is explicitly enabled. See [Run archives](docs/run-archives.md) for retention and future database guidance.

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
