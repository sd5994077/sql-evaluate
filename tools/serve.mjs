import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exec } from "node:child_process";

const root = fileURLToPath(new URL("../dist/", import.meta.url));
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
    const requested = pathname.replace(/^[/\\]+/, "") || "index.html";
    let target = resolve(root, requested);
    const boundary = relative(root, target);
    if (boundary.startsWith("..") || isAbsolute(boundary)) throw new Error("Invalid path");
    try {
      if ((await stat(target)).isDirectory()) target = join(target, "index.html");
    } catch {
      target = join(root, "index.html");
    }
    const body = await readFile(target);
    response.writeHead(200, {
      "Content-Type": types[extname(target)] ?? "application/octet-stream",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'self'; script-src 'self'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    response.end(body);
  } catch (error) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(error instanceof Error ? error.message : "Not found");
  }
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") return;
  const url = `http://127.0.0.1:${address.port}`;
  console.log(`SQL Evaluate is running at ${url}`);
  console.log("Close this window or press Ctrl+C to stop it.");
  if (process.platform === "win32") exec(`start "" "${url}"`);
});
