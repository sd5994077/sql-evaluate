# Run archives

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
  report.html
normalized/
  activity.csv
diagnostics/
  processing-log.json
source/
  <original files>          # raw-details exports only
```

The normalized CSV has stable column names for activity fields used by the analyzer. The JSON report remains the authoritative portable analysis record.

## Privacy behavior

The default archive is redacted and excludes original source files. Enabling **Include raw details** can place SQL text, plans, server names, database names, login names, host names, program names, parameter values, and original uploaded files into the ZIP. Store raw archives in an access-controlled location.

Source SHA-256 checksums are recorded in the manifest whether or not the original files are included. A checksum can verify which source produced a run without exposing its contents.

## Suggested file retention

For a local archive folder:

- Retain at least the runs needed to cover the normal workload cycle and incident-review period.
- A practical starting policy is 90 days or the latest 100 runs, whichever provides more useful coverage.
- Keep incident-related runs under the incident retention policy instead of deleting them with routine files.
- Back up the archive folder if the files are required as operational evidence.

The browser downloads the ZIP but does not delete older files automatically.

## Future database migration

The manifest includes a stable `runId`, application version, timestamps, source metadata, and row/finding counts. A future database loader should treat `runId` as the parent key and load the manifest, findings, normalized activity, plans, and diagnostics into separate child tables. Keeping raw source files outside the database remains an option even after database indexing is added.
