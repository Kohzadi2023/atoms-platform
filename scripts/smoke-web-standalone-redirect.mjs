import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const port = Number(process.env.ATOMS_WEB_SMOKE_PORT ?? "3100");
const hostname = "127.0.0.1";
const origin = `http://${hostname}:${port}`;
const serverPath = "apps/web/.next/standalone/apps/web/server.js";

const server = spawn(process.execPath, [serverPath], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    NODE_ENV: "production",
    HOSTNAME: hostname,
    PORT: String(port),
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
server.stdout.on("data", (chunk) => {
  stdout += chunk.toString();
});
server.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

async function fetchReady(pathname) {
  let lastError;
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    try {
      const response = await fetch(`${origin}${pathname}`, { redirect: "manual" });
      if (response.status < 500) return response;
      lastError = new Error(`${pathname} returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  throw lastError ?? new Error(`Timed out waiting for ${pathname}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  const root = await fetchReady("/");
  assert(root.status === 200, `Expected / to return 200, got ${root.status}`);
  assert(
    root.headers.get("cross-origin-opener-policy") === "same-origin",
    "Expected / to retain Cross-Origin-Opener-Policy: same-origin",
  );

  const redirect = await fetchReady("/redirect");
  assert(
    redirect.status === 200,
    `Expected /redirect to return 200, got ${redirect.status}`,
  );
  assert(
    redirect.headers.get("cross-origin-opener-policy") === null,
    "Expected /redirect to omit Cross-Origin-Opener-Policy for the MSAL v5 bridge",
  );
  assert(
    Boolean(redirect.headers.get("content-security-policy")),
    "Expected /redirect to retain Content-Security-Policy",
  );

  const body = await redirect.text();
  assert(
    body.includes("Completing secure sign-in") || body.includes("Completing secure sign-in…"),
    "Expected /redirect response to contain the dedicated bridge page",
  );

  console.log("Standalone Web redirect smoke passed.");
} catch (error) {
  console.error(error instanceof Error ? error.stack : error);
  if (stdout) console.error("--- standalone stdout ---\n" + stdout);
  if (stderr) console.error("--- standalone stderr ---\n" + stderr);
  process.exitCode = 1;
} finally {
  server.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => server.once("exit", resolve)),
    sleep(5_000),
  ]);
  if (server.exitCode === null) server.kill("SIGKILL");
}
