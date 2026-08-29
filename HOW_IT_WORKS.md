# How SQL Evaluate Works

SQL Evaluate is a local, browser-based review tool for SQL Server activity captures and execution-plan files. It helps a DBA turn captured evidence into an organized investigation. It is advisory only: it does not connect to SQL Server, run queries, change settings, or terminate sessions.

All examples in this guide use fictional test objects.

## What is required

For normal use on Windows:

- Node.js 20 or newer
- A modern browser, such as Microsoft Edge or Google Chrome
- One or more supported input files

To start the application, double-click `Start SQL Evaluate.cmd`. It starts a small local web server on `127.0.0.1` and opens the dashboard in the default browser. Closing the command window stops the local server.

The included `dist` folder is the ready-to-run application bundle. Normal use does not require `npm install`, SQL Server access, or an internet connection.

## Supported input files

| File type | Example test object | What SQL Evaluate reads |
|---|---|---|
| CSV or TSV | `sample-whoisactive.csv` | Tabular `sp_WhoIsActive` output |
| Excel | `sample-whoisactive.xlsx` | The worksheet most likely to contain `sp_WhoIsActive` columns |
| Execution plan | `sample-query.sqlplan` | SQL Server Showplan XML |
| Prior report | `sample-review.sqleval.json` | A previously exported SQL Evaluate report |
| Deep Analysis case | `sample-investigation.sqlevalcase.zip` | A saved case, its evidence ledger, history, and attached result files |

Capture files are limited to 100 MB. Plan files are limited to 25 MB.

## What happens when a file is loaded

1. The browser reads the selected file locally.
2. SQL Evaluate identifies known `sp_WhoIsActive` columns and preserves unfamiliar columns for authorized raw exports.
3. Text values such as `NULL` are treated as missing for calculations.
4. It normalizes activity rows into consistent fields such as session ID, collection time, wait type, CPU, reads, writes, and TempDB pages.
5. It runs deterministic diagnostic rules against the normalized data.
6. It shows findings, evidence, confidence, limitations, and recommended next capture steps.

For example, a fictional test row for session `501` with a long `LCK_M_X` wait may be shown as a locking-wait finding. The result is based on the captured values and the documented rule thresholds; it is not an instruction to kill session `501`.

## What the analysis evaluates

Depending on which columns are present, SQL Evaluate can evaluate:

- Blocking chains and blocked-session breadth
- Current request waits and their duration
- Long-running relative resource consumers
- Open transactions when transaction fields are supplied
- Per-session TempDB allocation and current page usage
- Actual or estimated execution-plan conditions, such as spills, memory grants, estimate errors, implicit conversions, and missing-index suggestions

Severity and confidence are intentionally separate. A High finding means the captured rule threshold was met. Confidence indicates how complete and persistent the supporting evidence is.

## Important limits

SQL Evaluate does not invent missing evidence. If a needed column or plan is not supplied, the related check is marked **Not Evaluated**.

For example:

- Per-session `tempdb_current` pages identify what a request is using; they do not establish total TempDB used percentage, free space inside TempDB files, or free space on a Windows volume.
- A single capture can show that a wait or blocking relationship occurred, but may not prove that it persisted.
- A plan warning identifies a reason to investigate, not an automatic index, configuration, or query change.

Negative `blocking_session_id` values are handled as SQL Server special owner states rather than normal session IDs. For example, a fictional `-5` observation is shown as an unidentified latch-owner condition, not as “session -5.”

## Privacy, network, and AI

SQL Evaluate is local-only at runtime:

- It serves the dashboard only from `127.0.0.1`.
- It does not upload imported files.
- It does not connect to SQL Server.
- It has no telemetry, analytics, or cloud API calls.
- It does not use AI, an LLM, API keys, or model services.

The application includes reference links to external documentation. A browser goes to the internet only if a person chooses to open one of those links. Installing development dependencies with `npm install` may also require internet access; normal use of the included bundle does not.

## Reviewing results

Use the dashboard in this order:

1. Check the summary counts and capture window.
2. Review High findings first, then confirm their confidence and limitations in the detail pane.
3. Use the Activity tab to filter by session, sort columns, and page through normalized captured rows. From a finding, **Show affected activity** opens this view with the relevant record IDs selected.
4. Use Data Quality to identify missing columns, duplicate headers, checks that were not evaluated, malformed wait input, suppressed low-value signals, and any exact finding-cap disclosures.
5. Treat recommendations as investigation guidance. Confirm the finding with current, approved DBA evidence before taking action.

## Deep Analysis workflow

Deep Analysis is for a promising causal theory that needs more evidence, not for repeating the same generic recommendation. The first ready profile investigates CPU-backed blocking:

1. Start a case from a consequential blocking finding or from the Deep Analysis tab.
2. Review the causal rail. Each assertion is labeled **Observed**, **Supported**, **Contradicted**, or **Not Evaluated**.
3. Review and copy the generated read-only collection script. A DBA must approve and run it manually in SSMS or another approved internal SQL client; SQL Evaluate never runs it.
4. Export the result grids as CSV/XLSX and capture the plan in the same sampling window when possible. Import the files into the case.
5. Read the revised conclusion and the next discriminating check. A result that conflicts with the original capture remains visible and prevents an unsupported causal conclusion.
6. Save the case as `.sqlevalcase.zip` and reopen it later without a database.

The working case ZIP can contain raw identifiers, SQL text, plans, and parameters. It is deliberately not a redacted report. Keep it on approved internal storage and use the normal redacted report/run exports for wider sharing.

Deep Analysis correlates sources only through stable SQL Server identifiers and compatible timestamps. Supported identifiers include session/request/transaction IDs, SQL and plan handles, query and plan hashes, statement offsets, and Query Store IDs. Similar statement text is never sufficient by itself.

The CPU-backed blocking profile distinguishes related but different claims:

- A runnable request is observed at one instant; repeated runnable scheduler queues are needed to support sustained CPU pressure.
- An unused memory grant is a query symptom; pending grants or `RESOURCE_SEMAPHORE` evidence are needed to support grant-pool pressure.
- A forced-serialization warning is a clue; matching Showplan XML is needed to report the exact `NonParallelPlanReason`.
- Query Store plans are compile plans unless another source provides runtime counters.
- A plan lookup returning NULL is recorded as evidence rather than treated as a parser failure.

When a live plan returns NULL, the case recommends the next available source in order: an already-enabled last-known actual plan, existing Query Store history, and finally a separately approved, narrowly filtered post-execution Showplan Extended Events capture. The Extended Events script is administrative and may be expensive. SQL Evaluate only displays it and currently accepts exported XML/CSV—not binary `.xel` files.

## Saving a review

Select **Save Run ZIP** to download a local review package. By default, the package contains a redacted report, findings CSV, printable HTML report, normalized activity CSV, manifest, and diagnostic log.

Enabling **Include raw details** is an explicit choice. It can place original source files and sensitive values in the ZIP, so those files should be stored in an access-controlled location.

## Distribution package

The email/shareable release package contains only the ready-to-run application and recipient documentation:

```text
SQL-Evaluate-v<version>/
  dist/
  licenses/
  tools/serve.mjs
  Start SQL Evaluate.cmd
  START_HERE.txt
  HOW_IT_WORKS.md
  RELEASE_NOTES.md
  THIRD_PARTY_NOTICES.md
  SHA256SUMS.txt
```

The release package does not include SQL captures, execution plans, saved run archives, test fixtures, source code, `node_modules`, QA screenshots, or development work files.

Use `tools/package-release.ps1` from the development project to build the release ZIP. The script generates file checksums inside the package and a separate SHA-256 value for the ZIP.

## Troubleshooting

### Node.js is missing or too old

Run `node --version` in a command prompt. Install an organization-approved Node.js 20 or newer release when the command is missing or reports an older major version.

### The browser does not open

The command window displays a local `http://127.0.0.1:<port>` address. Copy that address into Microsoft Edge or Google Chrome.

### The dashboard is blank or reports a missing production bundle

Extract the complete release ZIP before running the launcher. Confirm that `dist/index.html` exists beside the launcher folder structure, then refresh the browser.

### Windows or endpoint protection blocks the launcher

Do not bypass organizational security controls. Verify the sender and published SHA-256 checksum, then follow the approved software-review or exception process.

### The command window was closed

Closing the command window stops the local server. Run `Start SQL Evaluate.cmd` again and reload the input file; browser-session data is not retained after the application is closed.

## For maintainers: development and rebuilding

The application is already built for normal operation. Development work uses:

```powershell
npm install
npm test
npm run build
npm run check
```

`npm run build` regenerates the `dist` folder. `npm run check` runs tests, creates a production build, and checks installed package dependencies for known vulnerabilities.
