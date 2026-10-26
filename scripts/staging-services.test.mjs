import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("backend deploy script: service table, image tag, readiness verdict, revision wait and guards", async () => {
  const output = await new Promise((resolve, reject) => {
    execFile(
      process.env.PWSH_PATH ?? "pwsh",
      ["-NoProfile", "-File", fileURLToPath(new URL("scripts/test-staging-services.ps1", root))],
      { cwd: fileURLToPath(root), timeout: 90000, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`pwsh failed: ${stderr || stdout || error.message}`));
        else resolve(stdout);
      },
    );
  });

  assert.match(output, /OFFLINE TESTS PASSED/);
  assert.match(output, /No Azure requests made/);
});
