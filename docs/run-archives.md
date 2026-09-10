# Run archives

## Investigation History archives

An Investigation History archive uses the `.sqlevalhistory.zip` suffix and schema `1.0`. It contains a hash-verified derived history document and manifest, not imported case archives or their raw plans. The file is still sensitive because server, database, schema, table, index, and statistics names are retained. History is never stored automatically in browser storage.

Deep Analysis case schema `1.6` retains structured plan object and optimizer-statistics identity. Case schemas `1.0` through `1.5` remain supported and are re-inspected from verified evidence when opened.

SQL Evaluate can save each completed analysis as a ZIP file. This is the current persistence method; the application does not write to a database or upload results to a service.

## File name

Each export uses a unique name:

```text
SQL-Evaluate-Run_YYYYMMDD-HHMMSS-<short-id>.zip
```

Existing files are not intentionally reused or overwritten.

## Package contents

```text
manifest.json
results/
  analysis.sqleval.json
  findings.csv
  investigation-guide.csv
  report.html
normalized/
  activity.csv
diagnostics/
  processing-log.json
source/
  <original files>          # raw-details exports only
```

The investigation-guide CSV records the deterministic action order, conditions, expected evidence, cautions, source finding IDs, and optional commands. The normalized CSV has stable column names for activity fields used by the analyzer, but is header-only in a default redacted archive. The JSON report remains the authoritative portable analysis record.

CSV fields that begin with spreadsheet formula characters are prefixed as text, including fields in explicitly authorized raw activity exports.

## Privacy behavior

The default archive is redacted and excludes normalized activity rows and original source files. Aggregate findings, the investigation guide, and redacted parsed plan context remain available for handoff. Enabling **Include raw details** can place row-level activity, SQL text, plans, server names, database names, login names, host names, program names, parameter values, and original uploaded files into the ZIP. Store raw archives in an access-controlled location.

Source SHA-256 checksums are recorded in the manifest whether or not the original files are included. A checksum can verify which source produced a run without exposing its contents.

## Suggested file retention

For a local archive folder:

- Retain at least the runs needed to cover the normal workload cycle and incident-review period.
- A practical starting policy is 90 days or the latest 100 runs, whichever provides more useful coverage.
- Keep incident-related runs under the incident retention policy instead of deleting them with routine files.
- Back up the archive folder if the files are required as operational evidence.

The browser downloads the ZIP but does not delete older files automatically.

## Deep Analysis working cases and handoffs

Deep Analysis uses a separate `.sqlevalcase.zip` format for reopenable working cases. It may contain raw source files, SQL text, plan XML, stable identifiers, database/object names, and manual Spill Triage statement selections, so it must be treated as sensitive. Case schema 1.5 retains private case tracking fields and revalidates a saved manual selection against the current evidence when the case is opened. Schemas 1.0 through 1.4 remain supported for opening.

The Deep Analysis **JSON**, **CSV**, and **Print HTML** actions produce non-reopenable handoff reports from an explicit allowlist. They exclude source names, raw values, SQL, plan XML, identities and hashes, database/object names, administrative source text, and unknown columns. Use these handoffs for wider sharing; use the working-case ZIP only when the recipient is authorized to receive the underlying evidence.

## Future database migration

The manifest includes a stable `runId`, application version, timestamps, source metadata, and row/finding counts. A future database loader should treat `runId` as the parent key and load the manifest, findings, normalized activity, plans, and diagnostics into separate child tables. Keeping raw source files outside the database remains an option even after database indexing is added.
