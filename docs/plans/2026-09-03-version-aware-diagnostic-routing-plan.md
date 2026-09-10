# Version-aware Diagnostic Routing Implementation Plan

## Summary

Add a manual server-capability snapshot, a curated diagnostic recipe catalog, capability-aware Spill Triage plan acquisition, and provenance-aware Showplan imports. Preserve the offline evidence-first product boundary and release the backward-compatible workflow as version 1.4.0.

## Implementation

1. Add versioned capability and diagnostic-recipe types to Deep Analysis case schema 1.4, with migration from schemas 1.0-1.3.
2. Generate and parse one read-only capability snapshot covering version, edition, database, permissions, existing plan-history features, and installed diagnostic signatures.
3. Route Spill Triage through capability discovery, exact cached-plan provenance, already-enabled last-known actual plans, existing Query Store, controlled actual capture, and approved Extended Events.
4. Preserve each tabular Showplan with the stable identity from its own row. Enrich only one unambiguous statement and reject conflicts.
5. Add accessible capability, availability, provider, safety, and selection-reason UI states.
6. Publish the catalog policy, agent guardrail, requirements additions, release notes, and application version 1.4.0.

## Verification

- Test SQL Server 2022 Standard, feature-disabled, permission-limited, stale, malformed, installed-tool, and unknown-tool snapshots.
- Test exact plan provenance, multiple statements, conflicting identity, expired handles, routing fallbacks, and case round trips.
- Run unit/integration tests, production build, dependency audit, and narrow-screen headless verification.
