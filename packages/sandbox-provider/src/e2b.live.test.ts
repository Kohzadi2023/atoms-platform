import assert from "node:assert/strict";
import test from "node:test";

import { E2BSandboxAdapter } from "./index.js";

const liveEnabled =
  process.env.RUN_LIVE_E2B_TESTS === "true" &&
  typeof process.env.E2B_API_KEY === "string" &&
  process.env.E2B_API_KEY.length > 0;

test(
  "live E2B smoke creates, executes in, and terminates a private sandbox",
  { skip: liveEnabled ? false : "requires explicit RUN_LIVE_E2B_TESTS=true and E2B_API_KEY" },
  async () => {
    const apiKey = process.env.E2B_API_KEY;
    assert.ok(apiKey);
    const adapter = new E2BSandboxAdapter({
      apiKey,
    });
    const sandbox = await adapter.create({
      ...(process.env.E2B_TEMPLATE === undefined ||
      process.env.E2B_TEMPLATE.length === 0
        ? {}
        : { template: process.env.E2B_TEMPLATE }),
      timeoutMs: 60_000,
      network: { allowedHosts: [], allowPublicTraffic: false },
      lifecycle: { onTimeout: "kill", autoResume: false },
    });

    try {
      const result = await adapter.exec(sandbox.id, {
        command: "node --version",
        timeoutMs: 30_000,
      });
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /^v\d+/);
    } finally {
      await adapter.terminate(sandbox.id);
    }
  },
);
