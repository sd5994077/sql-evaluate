# SQL Evaluate: maintainer onboarding notes

Inspected 2026-09-05 at commit `90fe000`, application version `1.4.2` (both `package.json` and `src/version.ts`). These are source-based orientation notes, not a fresh runtime validation or an instruction to resume an older task. Recheck the source and current handoff before making changes.

## 1.5.0 implementation update

The working tree now includes review-before-import workflows, document download checkpoints, and private case tracking. The initial commit/version and historical validation below describe the onboarding baseline, not this new release.

- Main analysis uses prepare/analyze/discard worker requests with request IDs. Prepared data stays in the worker until confirmation; worksheet choices are kept with source files for subsequent analysis.
- Deep Analysis exposes prepareEvidenceFiles/commitEvidenceFiles; addEvidenceFiles remains a convenience wrapper for existing callers. Previews do not mutate the case.
- Case schema 1.5 adds title editing, ticketReference, notes, and status. Metadata validation and edits live in src/deepAnalysis/metadata.ts. Old schemas continue to migrate, preserving manual choices.
- src/lib/useDocumentCheckpoint.ts tracks in-memory document references at successful download initiation or opening. App guards replacement and registers beforeunload protection. This does not verify filesystem storage.
- Shared WorkflowDialog, ImportPreviewDialog, and CaseDetailsEditor components implement the workflows. Handwritten fields remain outside redacted handoff allowlists.
- See docs/releases/1.5.0.md for release behavior. The separate NEXT_STEPS live-lab handoff is unchanged.

## Purpose and boundaries

SQL Evaluate is an offline browser application for reviewing exported SQL Server activity captures and Showplan files. Deterministic rules produce findings, confidence, limitations, and suggested evidence collection. Deep Analysis develops investigations from additional imported evidence. There is no application database, SQL connection, or AI service.

Read [AGENTS.md](../AGENTS.md) first. Source, runtime, build, tests, and CI must never connect to SQL Server. Generated SQL is text for manual operator review and execution outside this repository. Consult [diagnostic-tool-catalog.md](diagnostic-tool-catalog.md) before adding or recommending diagnostic SQL.

The existing [NEXT_STEPS.md](../NEXT_STEPS.md) describes an unfinished, separately authorized live lab campaign in `C:\Users\steph\Documents\Codex\2026-09-03\sql-diagnostic-test-lab`. Reading these notes does not authorize that campaign. Preserve the handoff until its work is completed or superseded; never copy lab evidence into this repo without owner approval.

## Stack and startup

- React 19.2.8 and TypeScript 7.0.2; Vite 8.2.2 builds the browser bundle.
- SheetJS `xlsx` 0.20.3 reads workbooks; `@xmldom/xmldom` parses XML; `fflate` handles ZIP archives.
- Vitest 4.1.11 and React Testing Library cover pure logic, workflows, and components. Vite's test default is Node, with browser-style tests using jsdom where configured.
- `index.html` loads `src/main.tsx`, which mounts `App.tsx` under React StrictMode and imports `styles.css`.
- `npm run dev` starts Vite. `npm start` runs `tools/serve.mjs`, serving the already-built `dist/` on an ephemeral `127.0.0.1` port. This server serves static files, adds security headers, and opens the browser on Windows; it is not an analysis API.
- The Windows launcher and committed `dist/` support recipient use without installing development dependencies. See [HOW_IT_WORKS.md](../HOW_IT_WORKS.md) and [START_HERE.txt](../START_HERE.txt).

## Main analysis flow

1. `src/App.tsx` owns file selection, processing status, results, filters, tabs, threshold selection, exports, and the active Deep Analysis case.
2. Saved `.sqleval.json` reports and `.sqlevalcase.zip` cases are opened through dedicated validation paths, one file at a time.
3. Fresh captures/plans go to `src/analysis.worker.ts` with a threshold-profile snapshot. The worker calls `src/lib/processFiles.ts`, reports progress, and returns the report plus per-file errors. One failed input need not discard successfully parsed files.
4. `src/lib/ingest.ts` routes file formats, enforces capture/plan size limits, selects the likely activity worksheet, and delegates to `csv.ts`, `normalize.ts`, `showplan.ts`, and `supplementalEvidence.ts`. `src/schema.ts` defines recognized column mappings. Capture limits are 100 MB; plans are 25 MB.
5. `src/rules/engine.ts` evaluates normalized records and standalone/embedded plans. Rule families include scheduler pressure, blocking, resources, waits, transactions, and plans. `catalog.ts` supplies diagnostic references; `thresholdProfiles.ts` defines and validates versioned threshold snapshots.
6. `src/rules/investigationGuide.ts` composes the ordered case-level next steps. The report returns to React for findings, activity, and data-quality views.

Core contracts live in `src/types.ts`. UI components in `src/components/` include `DropZone`, `FindingDrawer`, `InvestigationGuide`, `ThresholdProfileManager`, `DeepAnalysisWorkspace`, and `SpillTriagePanel`.

## Deep Analysis flow

- `src/deepAnalysis/types.ts`: case, artifact, observation, assertion, capability, and spill-triage contracts.
- `profile.ts`: investigation profiles and collection-command text.
- `case.ts`: creates cases, imports evidence, manages candidate/plan selection, and saves/reopens working ZIP archives.
- `adapters.ts`: recognizes imported table evidence and extracts observations and stable identities.
- `correlation.ts`: matches stable SQL Server identities and incident timing. Similar SQL text alone is insufficient to establish causality.
- `evaluator.ts`: derives assertion states such as Observed, Supported, Contradicted, and Not Evaluated from the case evidence.
- `spillTriage.ts`: identifies and ranks valid spill candidates, resolves candidate plans, and interprets actual-plan spill operators. Cached plans supply compile-time structure, not execution-specific runtime proof.
- `capabilities.ts` and `toolCatalog.ts`: interpret imported server capabilities and route suitable manual diagnostic recipes. They do not discover capabilities through a connection.
- `report.ts`: separate redacted Deep Analysis handoff exports.

The main worker handles normal capture analysis; Deep Analysis imports are initiated through async case functions from `App.tsx`.

## State, persistence, and integrations

Shared application state is React `useState`/refs in `App.tsx`, passed through props and callbacks. There is no separate Redux/Zustand store in the inspected architecture. Original selected `File` objects remain in browser memory for raw exports and reanalysis. Reports, active cases, and evidence are not automatically persisted across reloads.

Threshold profiles are the persistence exception: `src/rules/thresholdProfileStore.ts` stores custom profiles and the active reference in localStorage under `sql-evaluate.threshold-profiles.v1` and `sql-evaluate.active-threshold-profile.v1`. Loading validates shapes and profile identities/digests and falls back to the built-in default on invalid storage. Browser storage is origin-scoped; because the packaged server chooses an ephemeral port, profile persistence should not be assumed to carry across launches at different ports.

Investigation History does not add another browser-persistence exception. Cross-case observations live in memory and persist only when the operator explicitly downloads a sensitive `.sqlevalhistory.zip` archive.

Durable investigation storage is user-directed file export/import:

- `src/lib/report.ts`: report validation, redaction, JSON/CSV/HTML support, and browser downloads.
- `src/lib/runBundle.ts`: run ZIP with manifest, checksums, results, logs, and optional raw inputs. Default exports redact sensitive values and omit row-level activity; raw detail requires an explicit choice.
- `src/deepAnalysis/case.ts`: working case ZIP retains sensitive evidence and provenance so the case can be reopened. This is distinct from a redacted handoff.

A source search for `fetch`, XMLHttpRequest, WebSocket, IndexedDB, sessionStorage, and localStorage found only the App localStorage access among these runtime APIs. This supports the documented file-only design; it is not a comprehensive security audit. External documentation links are user-opened references, not application API integrations.

## Verification and release orientation

`npm test` runs Vitest. `npm run build` runs TypeScript project builds and Vite. `npm run check` runs tests, build, and npm audit. `.github/workflows/quality-gate.yml` runs that gate on Node 22 after `npm ci`. No live SQL test belongs in this workflow.

Tests sit beside implementation under `src/`, including parsing, thresholds, redaction/archive behavior, correlation, spill workflows, and UI cases. `src/sample.integration.test.ts` supports an optional local sample path documented in README. Fixture and QA areas include `fixtures/`, `test-fixtures/`, and `.qa/`; generated/distribution areas include `dist/`, `outputs/`, and `release/`. Do not assume incidental captures or example files are sanitized.

`tools/package-release.ps1` packages the built app, recipient documentation, licenses, and checksums. It currently removes matching staging/ZIP targets before creating them: obey AGENTS versioning rules and choose a new release version before running it. Keep `package.json`, lockfile, `src/version.ts`, release notes, archives, and checksums consistent; preserve older numbered releases. These onboarding notes alone do not require a version bump.

No tests, builds, app launch, or live campaign were run for this documentation-only onboarding. NEXT_STEPS reports 284 tests passed and 1 skipped, a successful production build, an offline dependency audit, and a Playwright spill-entry smoke check at the inspected commit; those are historical handoff results, not newly verified results.

## Suggested next reading order

1. Product behavior: README and HOW_IT_WORKS, then `App.tsx`.
2. Input contracts: `types.ts`, `schema.ts`, and the ingest/normalize/Showplan modules.
3. Diagnostic decisions: rules engine, threshold profiles, investigation guide, and their tests.
4. Deep Analysis: case lifecycle, adapters, identity correlation, evaluator, then Spill Triage.
5. Persistence and privacy: report redaction, run bundles, working-case archives, and export tests.
6. Delivery: static server, CI gate, release script, and current version/release documents.

At inspection start, `AGENTS.md` was already modified and `NEXT_STEPS.md`, `Examples/`, and four typography screenshots were untracked. Preserve those unrelated changes. The only file created by this onboarding is this document.
