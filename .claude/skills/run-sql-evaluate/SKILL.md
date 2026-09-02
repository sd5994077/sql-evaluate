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
npm run build      # tsc -b && vite build  -> dist/ , ~1s after tsc
npm test           # vitest run  -> 24 files pass, 1 skipped (230 pass / 1 skip)
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
PASS  Spill Triage workspace module resolves
PASS  no Vite startup error
[smoke] OK
```

Exit 0 = pass, 1 = a check failed, 2 = dev server never came up. It launches
`npm run dev` on port **5173** (`--strictPort`) and kills the tree on exit.
`DEP0190` deprecation noise on Windows is expected and harmless.

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
   base64 -w0 fixtures/CLAUDE-SPILL-001/blitzcache-evidence.csv
   ```

   ```
   javascript_tool:  window.__sqleval.injectFile("<BASE64>", "blitzcache-evidence.csv", "text/csv")
   javascript_tool:  window.__sqleval.injectFile("<BASE64>", "evidence-a.sqlplan", "text/xml")
   ```

   `injectFile` returns `{ targeted, file, bytes }`. `targeted` **must** be
   `.csv,.tsv,.xlsx,.xls,.sqlplan,.xml` — if it shows a longer accept list
   ending in `.zip`, the helper hit the wrong input (see Gotchas).

6. **Read results.** After the CSV: `get_page_text` shows the ranked candidate
   table, "Highest cumulative impact" / "Highest per execution" cards, and the
   Data Quality panel. After a `.sqlplan`: Stage 2 shows
   `Exact STABLE-IDENTITY MATCH` + operator/spill evidence when the
   `plan_handle` matches the selected candidate.

7. **Select a different candidate.** `find` "Investigate" → `left_click` a row
   button; the "WHY THIS CANDIDATE" panel and Stage 2 update to that row.

8. **Stop.** `mcp__Claude_Browser__preview_stop` with the `serverId` from
   step 1.

Verified end-to-end this session: 12-row CSV → Rank 1 `0xA100`; `evidence-a.sqlplan`
→ "The plan_handle values match", 2 spilling operators, Node 27 estimate error;
clicking Investigate on Rank 2 selected `0xB200`.

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
- **There are 5 file inputs; only one is the Spill Triage importer.** The
  landing-page dropzone (index 0) also accepts `.csv`/`.sqlplan` **plus**
  `.zip`/`.json` and treats a CSV as a who-is-active capture — injecting there
  does nothing to Stage 1. The InvestigationGuide input has `id="guide-evidence-input"`.
  The helper's `findImportInput()` picks the one that accepts `.sqlplan`,
  rejects `.zip`/`.json`, and has no `id`. Confirm via the returned `targeted`.
- **Node ≥ 20 on Windows needs `shell: true` to spawn `npm.cmd`** (EINVAL
  otherwise). `smoke.mjs` does this and eats the resulting `DEP0190` warning.
- **Lingering dev server on 5173.** If `preview_start` reports port 5173 in use
  by a stray `node.exe` (e.g. after a killed `smoke.mjs`), free it:

  ```bash
  powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id \$_.OwningProcess -Force }"
  ```

- **One vitest file is skipped by design** (`Skip optional generated fixture
  test in clean checkouts`) — not a failure.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `preview_start` → "Port 5173 is in use … not a preview server" | Kill the stray server with the PowerShell one-liner above, retry. |
| `injectFile` returns `targeted` ending in `.zip` / import has no effect on Stage 1 | Wrong input matched — reload the page, re-enter Spill Triage, re-paste `browser-inject.js`, retry. |
| `smoke.mjs` exits 2 | Dev server didn't start; run `npm run dev` directly and read the Vite error. |
| Blank screenshot | Expected. Use `get_page_text` / `read_page`. |
| `spawn EINVAL` from a custom Node script launching npm | Add `shell: process.platform === "win32"` to the `spawn` options. |
