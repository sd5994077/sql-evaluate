# SQL Evaluate Diagnostic Tool Catalog

## Policy

SQL Evaluate uses a curated hybrid policy. Prefer an already-installed, compatible, read-only community procedure when it precisely supplies the missing evidence. Use a minimal native read-only query when exact SQL Server identity or capability data is required, when a community tool is absent, or when a stable import contract is needed.

The application remains offline. It only displays or downloads commands for manual DBA review and never connects to SQL Server, installs tools, enables features, or executes SQL.

## Supported diagnostic set

| Provider | Tool | Use in SQL Evaluate | Safety boundary |
|---|---|---|---|
| First Responder Kit | `sp_Blitz` | Prioritized server health context | Run only an installed compatible version during an approved window. |
| First Responder Kit | `sp_BlitzFirst` | Bounded current workload, waits, files, and counters | Avoid output-table writes and keep sampling bounded. |
| First Responder Kit | `sp_BlitzWho` | Active requests, blocking, grants, and optional live cached plans | Plan collection can add overhead and expose sensitive text. |
| First Responder Kit | `sp_BlitzCache` | Cached workload ranking, spills, grants, and stable cache identifiers | Bound `@Top`; ignore cache-removal columns; keep AI options off. |
| First Responder Kit | `sp_BlitzIndex` | Index design and usage context | Generated index definitions are evidence, not automatic remediation. |
| First Responder Kit | `sp_BlitzLock` | Existing deadlocks from supported Extended Events targets | Bound dates and database filters before reading large targets. |
| First Responder Kit | `sp_BlitzAnalysis` | Existing logged `sp_BlitzFirst` history | Do not create or populate history merely for the current diagnosis. |
| Adam Machanic | `sp_WhoIsActive` | Active requests, transactions, blocking, waits, and cached plans | Enable plan, lock, or transaction options only when needed. |
| Ola Hallengren | Existing `CommandLog` and SQL Agent history | Correlate maintenance timing, outcome, database, and object with an incident | Read history only; do not start maintenance as evidence collection. |
| Ola Hallengren | Verified `IndexOptimize` preview | Print a statistics-only command for an exact, independently verified target | Manual remediation artifact only; requires imported verification and `@Execute = 'N'`. |
| Microsoft SQL Server | Native DMVs, Query Store, and last-known actual plans | Capabilities, exact provenance, stable fallback, and retained plan history | Read-only by default; unavailable features remain unavailable. |

## Plan acquisition decision

1. Use evidence already present in the case.
2. If the selected candidate has a `plan_handle`, run **Cached plan with stable provenance** and import the single result grid.
3. If SQL Server 2019 or later reports `LAST_QUERY_PLAN_STATS = ON`, try the exact plan-handle last-known-actual lookup.
4. If Query Store is already enabled and stable query/database identity exists, import its retained plan and runtime aggregates.
5. Capture a controlled actual plan only with an approved statement and execution context.
6. Use narrowly filtered post-execution Showplan Extended Events only as a separately approved last resort.

A zero-row or NULL-plan result is evidence that the requested retained source did not return a plan. It is not an import failure. Similar SQL text never establishes plan correlation.

### Query Store retrieval process

Query Store is a useful retained-plan route, including on SQL Server 2022 Standard Edition, but it is not an actual-plan recorder and it does not backfill activity from before it was enabled.

1. Run and import a fresh **Server capability snapshot** in the affected database. Confirm Query Store reports `READ_WRITE`, `READ_ONLY`, or another active state—not `OFF`, `PERMISSION_REQUIRED`, or `ERROR`.
2. Select the spill candidate. Query Store retrieval requires its exact 8-byte `query_hash` and the correct database context.
3. Open **Review existing Query Store history** in the evidence ladder. Run the generated SQL in the affected database; adjust only the bounded `@Since` window when the incident falls outside the default two hours.
4. Save the one result grid as CSV or XLSX and import it into the same Spill Triage case. The export returns one row per Query Store plan with database/query/plan IDs, Query Store's query and plan hashes, statement offsets when present, the persisted compile plan, and weighted runtime aggregates.
5. Treat a zero-row result as “not retained under that hash/database/window.” If several plans share the strongest stable identity, SQL Evaluate reports ambiguity instead of guessing.

SQL Server 2016-2019 requires `VIEW DATABASE STATE` for these Query Store catalog views. SQL Server 2022 and later supports the narrower `VIEW DATABASE PERFORMANCE STATE`; the broader `VIEW DATABASE STATE` also satisfies the requirement.

## Capability snapshot

Run the generated snapshot in the affected database. Set `@UtilityDatabase` to the database containing community tools when they are not installed in the affected database. The result records:

- SQL Server product version, edition, engine edition, database, and capture time.
- Effective `VIEW SERVER STATE`, `VIEW SERVER PERFORMANCE STATE`, `VIEW DATABASE STATE`, and `VIEW DATABASE PERFORMANCE STATE` visibility.
- Existing `LAST_QUERY_PLAN_STATS` and Query Store states.
- Supported procedure/table presence, parameter signatures, and First Responder Kit version output when the guarded `@VersionCheckMode` contract is available.

Snapshots older than 30 days remain usable as provenance but receive a warning because permissions, configuration, or installed procedures may have changed.

## Excluded operations

SQL Evaluate must not automatically recommend or present these as routine collection:

- `DBCC FREEPROCCACHE`, session termination, `sp_kill`, restore utilities, or other server-state changes.
- Running `DatabaseBackup`, `DatabaseIntegrityCheck`, or `IndexOptimize` merely to troubleshoot an incident.
- Treating a report-only `IndexOptimize` preview as evidence that maintenance is required; it is exposed only after separate read-only verification and DBA review.
- First Responder Kit installation/update scripts or AI options.
- Enabling Query Store, `LAST_QUERY_PLAN_STATS`, or an Extended Events session without separate change approval.

## Maintainer rules

Every runtime recipe has a stable ID, owner, purpose, compatibility statement, required permissions, expected evidence, overhead, safety classification, official source, and fallback where applicable. Add a native query only when the catalog cannot provide the required exact evidence. New community result shapes require versioned adapters and sanitized fixtures before they can change a conclusion.

## Authoritative sources

- [First Responder Kit](https://github.com/BrentOzarULTD/SQL-Server-First-Responder-Kit)
- [Ola Hallengren SQL Server Maintenance Solution](https://github.com/olahallengren/sql-server-maintenance-solution)
- [sp_WhoIsActive](https://github.com/amachanic/sp_whoisactive)
- [Microsoft: sys.dm_exec_query_stats](https://learn.microsoft.com/sql/relational-databases/system-dynamic-management-views/sys-dm-exec-query-stats-transact-sql)
- [Microsoft: sys.dm_exec_query_plan_stats](https://learn.microsoft.com/sql/relational-databases/system-dynamic-management-views/sys-dm-exec-query-plan-stats-transact-sql)
- [Microsoft: sys.query_store_runtime_stats](https://learn.microsoft.com/sql/relational-databases/system-catalog-views/sys-query-store-runtime-stats-transact-sql)
- [Microsoft: Monitor performance with Query Store](https://learn.microsoft.com/sql/relational-databases/performance/monitoring-performance-by-using-the-query-store)
