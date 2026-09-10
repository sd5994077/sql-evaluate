#!/usr/bin/env node
/**
 * Process-owned headless smoke test for SQL Evaluate.
 *
 * Starts this checkout's Vite CLI on an OS-assigned port, waits for the URL
 * emitted by that child, checks the shell and key transformed modules, and
 * stops only the process tree it created.
 *
 * Exit 0 = pass. Exit 1 = a served-content check failed.
 * Exit 2 = this harness's Vite child could not start.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const defaultViteBin = resolve(repoRoot, "node_modules/vite/bin/vite.js");
const viteBin = process.env.SQLEVAL_SMOKE_VITE_BIN || defaultViteBin;
const startupTimeoutMs = Number(process.env.SQLEVAL_SMOKE_TIMEOUT_MS || 30_000);
const viteArgs = [viteBin, "--host", "127.0.0.1", "--port", "0", "--strictPort"];

let failed = false;
let serverLog = "";
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? ` -- ${detail}` : ""}`);
  if (!ok) failed = true;
};

console.log(`[smoke] repo: ${repoRoot}`);
console.log("[smoke] starting checkout Vite on an OS-assigned port");
const server = spawn(process.execPath, viteArgs, {
  cwd: repoRoot,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

const appendLog = (chunk) => {
  serverLog += chunk.toString();
};
server.stdout.on("data", appendLog);
server.stderr.on("data", appendLog);

const waitForOwnedUrl = () => new Promise((resolveUrl, reject) => {
  let settled = false;
  let timeout;
  const finish = (callback, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    server.stdout.off("data", inspectLog);
    server.stderr.off("data", inspectLog);
    server.off("error", onError);
    server.off("exit", onExit);
    callback(value);
  };
  const inspectLog = () => {
    const match = serverLog.match(/Local:\s+(http:\/\/127\.0\.0\.1:\d+\/?)/);
    if (match) finish(resolveUrl, match[1]);
  };
  const onError = (error) => finish(reject, error);
  const onExit = (exitCode, signal) => finish(
    reject,
    new Error(`Vite exited before readiness (code ${exitCode ?? "none"}, signal ${signal ?? "none"})`),
  );
  timeout = setTimeout(
    () => finish(reject, new Error(`Vite did not report readiness within ${startupTimeoutMs}ms`)),
    startupTimeoutMs,
  );
  server.stdout.on("data", inspectLog);
  server.stderr.on("data", inspectLog);
  server.once("error", onError);
  server.once("exit", onExit);
  inspectLog();
});

const fetchText = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  return { response, body: await response.text() };
};

const stopOwnedServer = async () => {
  if (server.exitCode !== null || server.signalCode !== null) return;
  await new Promise((done) => {
    let complete = false;
    let fallbackTimeout;
    const finish = () => {
      if (complete) return;
      complete = true;
      clearTimeout(fallbackTimeout);
      done();
    };
    server.once("exit", finish);
    if (process.platform === "win32" && server.pid) {
      const killer = spawn("taskkill", ["/pid", String(server.pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("error", finish);
    } else {
      server.kill("SIGTERM");
    }
    fallbackTimeout = setTimeout(finish, 3_000);
  });
};

let code = 0;
try {
  let baseUrl;
  try {
    baseUrl = await waitForOwnedUrl();
  } catch (error) {
    console.error(`[smoke] startup failed: ${error instanceof Error ? error.message : String(error)}`);
    console.error(serverLog.slice(-2_000));
    code = 2;
  }

  if (baseUrl) {
    console.log(`[smoke] child ready: ${baseUrl}`);
    try {
      const shell = await fetchText(baseUrl);
      check("index.html served", shell.response.ok && shell.body.includes('<div id="root">'), `status ${shell.response.status}`);
      check("entry script referenced", shell.body.includes("/src/main.tsx"));

      const entry = await fetchText(new URL("/src/main.tsx", baseUrl));
      check("entry module transforms", entry.response.ok && /import|createRoot|React/.test(entry.body), `status ${entry.response.status}`);

      const spillPanel = await fetchText(new URL("/src/components/SpillTriagePanel.tsx", baseUrl));
      check("Spill Triage module transforms", spillPanel.response.ok, `status ${spillPanel.response.status}`);
    } catch (error) {
      check("served content remains reachable", false, error instanceof Error ? error.message : String(error));
    }
  }
} finally {
  await stopOwnedServer();
}

if (code === 0 && failed) code = 1;
console.log(`[smoke] ${code === 0 ? "OK" : `FAILURES (exit ${code})`}`);
process.exitCode = code;
