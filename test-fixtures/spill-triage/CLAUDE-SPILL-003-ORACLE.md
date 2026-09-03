# CLAUDE-SPILL-003 Internal Oracle

This oracle is intentionally outside Claude's allowed fixture scope.

- Workbook: spill header at row 6; one Read Me sheet ignored; five rows imported; four rankable.
- Ranking: Exact first (900,000 pages), CrossDb second (800,000), Ambiguous third (700,000), ValidUnit fourth (8,192); UnitConflict unranked.
- Exact and duplicate plans have identical bytes and must produce one artifact/plan and one Exact Query Store match.
- CrossDb must not connect because Query Store IDs occur in database 22 while the candidate is scoped to database 21.
- Ambiguous must expose two Strong batch-handle alternatives, make no automatic choice, permit an explicit manual selection, label it Supported/manual, persist it, and permit clearing/changing it.
- `800 KB` under `Total Spill MiB` is invalid; `64 MiB` converts to 8,192 8-KB pages.
- Redacted JSON/CSV/HTML contain no `SENTINEL_PRIVATE_9033` and no raw metadata, identity, administrative command, or plan text.
