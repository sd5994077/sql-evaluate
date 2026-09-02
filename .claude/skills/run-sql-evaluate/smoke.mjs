#!/usr/bin/env node
/**
 * Headless smoke test for SQL Evaluate.
 *
 * No browser, no Playwright. Spawns the Vite dev server, waits for it to
 * listen, fetches the HTML shell + the transformed entry module + one lazy
 * chunk, asserts they load, then shuts the server down.
 *
 * This is the "does the app still boot and serve" check. It does NOT
 * exercise UI (import a CSV, rank candidates, correlate a plan) -- that
 * needs a real browser; see SKILL.md "Run (agent path)" for driving the
 * running app through the Claude Code Browser pane.
 *
 * Usage:  node .claude/skills/run-sql-evaluate/smoke.mjs
 * Exit 0 = all checks passed. Exit 1 = a check failed. Exit 2 = server never came up.
 */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const PORT = 5173;
const BASE = `http://localhost:${PORT}`;
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

let failed = false;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? ` -- ${detail}` : ""}`);
  if (!ok) failed = true;
};

console.log(`[smoke] repo: ${repoRoot}`);
console.log(`[smoke] starting: ${npmCmd} run dev  (port ${PORT})`);
// Node >=20 on Windows needs shell:true to spawn npm.cmd (EINVAL otherwise).
// That combo emits a harmless DEP0190 warning -- ignore it.
const server = spawn(npmCmd, ["run", "dev", "--", "--port", String(PORT), "--strictPort"], {
  cwd: repoRoot,
  stdio: ["ignore", "pipe", "pipe"],
  shell: process.platform === "win32",
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));

const waitForServer = async () => {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(BASE + "/", { signal: AbortSignal.timeout(1000) });
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  return false;
};

let code = 0;
try {
  const up = await waitForServer();
  if (!up) {
    console.error("[smoke] dev server never responded on " + BASE);
    console.error(serverLog.slice(-2000));
    code = 2;
  } else {
    // 1. HTML shell
    const html = await (await fetch(BASE + "/")).text();
    check("index.html served", html.includes('<div id="root">'), "missing #root");
    check("entry script referenced", html.includes("/src/main.tsx"));

    // 2. Vite transforms the TSX entry (proves the toolchain, not just static files)
    const entry = await fetch(BASE + "/src/main.tsx");
    const entryBody = await entry.text();
    check("entry module transforms", entry.ok && /import|createRoot|React/.test(entryBody), `status ${entry.status}`);

    // 3. The Spill Triage workspace module resolves
    const ws = await fetch(BASE + "/src/components/DeepAnalysisWorkspace.tsx");
    check("Spill Triage workspace module resolves", ws.ok, `status ${ws.status}`);

    // 4. No obvious server-side error banner in the log
    check("no Vite startup error", !/error:|failed to load config/i.test(serverLog), serverLog.slice(0, 200));
  }
} finally {
  await new Promise((done) => {
    server.once("exit", done);
    if (process.platform === "win32" && server.pid) {
      spawn("taskkill", ["/pid", String(server.pid), "/t", "/f"], { stdio: "ignore" });
    } else {
      server.kill("SIGTERM");
    }
    setTimeout(done, 3000).unref(); // don't hang if the tree is already gone
  });
}

if (code === 0 && failed) code = 1;
console.log(`[smoke] ${code === 0 ? "OK" : "FAILURES (exit " + code + ")"}`);
process.exitCode = code;
