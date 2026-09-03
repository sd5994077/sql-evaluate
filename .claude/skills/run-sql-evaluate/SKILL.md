---
name: run-sql-evaluate
description: >-
  Build, launch, screenshot, and drive the SQL Evaluate app (offline React/Vite
  browser tool for sp_WhoIsActive captures and SQL Server execution plans /
  Spill Triage). Use when asked to run, start, serve, smoke-test, screenshot,
  dogfood, or QA SQL Evaluate, or to import a BlitzCache CSV / .sqlplan and read
  the ranked candidates or plan correlation.
---

# Run SQL Evaluate

SQL Evaluate is a **fully offline** single-page React app built with Vite. No
backend, no database, no network — every capture/plan file is parsed in the
browser. The interesting surface is the **Spill Triage** workflow: import a
`sp_BlitzCache` CSV, rank cached plan variants, then correlate the top candidate
to an imported `.sqlplan` by stable identity.

**Environment:** this repo runs on Windows (PowerShell + Git-Bash). There is no
`chromium-cli` / Playwright here. The app is driven through the **Claude Code
Browser pane** (`mcp__Claude_Browser__*` tools). All paths below are relative to
the repo root (`<unit>/` = the directory containing `package.json`).

Two harnesses live beside this file:

| File | What it does | Needs a browser? |
|---|---|---|
| `.claude/skills/run-sql-evaluate/smoke.mjs` | Spawns the dev server, asserts the app boots and serves its modules | no |
| `.claude/skills/run-sql-evaluate/browser-inject.js` | Installs `window.__sqleval.injectFile(...)` to load fixture files past the hidden `<input type=file>` elements | yes (paste into `javascript_tool`) |

## Prerequisites

- Node ≥ 20 (verified on v25.9.0), npm (verified 11.12.1). No OS packages.
- `npm install` (only if `node_modules/` is absent — it was already present here).

## Build / test

```bash
npm run build      # tsc -b && vite build
npm test           # vitest run; exit 0 is the success criterion
```

`npm run check` also exists (`test && build && npm audit`).

## Smoke test (headless, no browser)

```bash
node .claude/skills/run-sql-evaluate/smoke.mjs
```

Expected tail:

```
PASS  index.html served
PASS  entry script referenced
PASS  entry module transforms
PASS  Spill Triage module transforms
[smoke] OK
```

Exit 0 = pass, 1 = a served-content check failed, and 2 = this harness's Vite
child could not start. It launches the checkout's Vite CLI directly on an
OS-assigned loopback port and stops only the process tree it created.

## Run (agent path) — drive the live app

The app needs a real browser to do anything (import parsing, ranking, DOM).
Use the Browser pane.

1. **Launch the dev server + open it.** `.claude/launch.json` already defines
   `sql-evaluate-dev` (→ `npm run dev`, port 5173):

   ```
   mcp__Claude_Browser__preview_start   name="sql-evaluate-dev"
   ```

   Opens tab `seed` at `http://localhost:5173`.

2. **Observe with text tools, NOT screenshots.** `mcp__Claude_Browser__computer`
   `screenshot` returns a **blank dark frame** for this app (see Gotchas). Use
   `read_page`, `get_page_text`, `find`, and `javascript_tool` — they return
   correct content.

3. **Enter Spill Triage.** `find` "Start Spill Triage" → `computer` `left_click`
   its `ref`. Stage 1 ("CANDIDATE SELECTION") appears.

4. **Install the file-injection helper.** Paste the entire contents of
   `.claude/skills/run-sql-evaluate/browser-inject.js` as the `text` of one
   `mcp__Claude_Browser__javascript_tool` call. It returns
   `sqleval inject helpers ready`.

5. **Import fixtures.** Base64 each file in Bash, then inject:

   ```bash
   base64 -w0 <fixture-path>
   ```

   ```
   javascript_tool:  window.__sqleval.injectFile("<BASE64>", "evidence.csv", "text/csv")
   javascript_tool:  window.__sqleval.injectFile("<BASE64>", "evidence.sqlplan", "text/xml")
   ```

   `injectFile` returns `status: "event-dispatched"` plus the stable target,
   accepted extensions, filename, and byte count. This confirms only that the
   browser event was sent. Verify the visible UI result before continuing.

6. **Read results.** After the CSV: `get_page_text` shows the ranked candidate
   table, "Highest cumulative impact" / "Highest per execution" cards, and the
   Data Quality panel. After a `.sqlplan`: Stage 2 shows
   `Exact STABLE-IDENTITY MATCH` + operator/spill evidence when the
   `plan_handle` matches the selected candidate.

7. **Select a different candidate.** `find` "Investigate" → `left_click` a row
   button; the "WHY THIS CANDIDATE" panel and Stage 2 update to that row.

8. **Stop.** `mcp__Claude_Browser__preview_stop` with the `serverId` from
   step 1.

## Run (human path)

```bash
npm run dev     # Vite dev server at http://localhost:5173 , Ctrl-C to stop
```

or the built bundle:

```bash
npm run build && npm start   # node tools/serve.mjs -> random 127.0.0.1 port, auto-opens a browser on Windows
```

`npm start` binds `listen(0)` (random port) and shell-opens a window — fine for
a human, useless for scripting. Use `npm run dev` (fixed 5173) for automation.

## Gotchas

- **Screenshots are blank.** `mcp__Claude_Browser__computer` `screenshot` (full
  or region, tab fronted or not, before/after scroll) returns an empty dark
  image for this app. `read_page` / `get_page_text` / `javascript_tool` work
  perfectly — drive and verify through those.
- **No working drag-drop; all imports are hidden `<input type=file>`.** The
  Browser pane can't service the OS file dialog, so `browser-inject.js` sets
  `input.files` via `DataTransfer` + `Object.defineProperty` + a `change`
  event. This is the only way to load a fixture.
- **There are several file inputs; only one is the Spill Triage importer.** The
  helper selects only `[data-testid="spill-triage-evidence-input"]` and throws
  unless exactly one exists. It never falls back to another input.
- **Port 5173 belongs only to the interactive preview.** The headless smoke
  harness uses an OS-assigned port, so it neither depends on nor stops a process
  already listening on 5173. Stop interactive previews through `preview_stop`
  using the `serverId` returned by `preview_start`.

- **One vitest file is skipped by design** (`Skip optional generated fixture
  test in clean checkouts`) — not a failure.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `preview_start` → "Port 5173 is in use … not a preview server" | Stop the known preview by its `serverId`; do not terminate an arbitrary port owner. |
| `injectFile` says the Spill Triage importer count is 0 | Open a Spill Triage case, re-install the helper, and retry. |
| `smoke.mjs` exits 2 | Its Vite child did not become ready; read the startup diagnostic and run `npm run dev` directly if more detail is needed. |
| Blank screenshot | Expected. Use `get_page_text` / `read_page`. |
