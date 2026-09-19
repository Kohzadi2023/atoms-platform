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

// G5 egress probe (docs/adr/production-execution-gate.md). Run once with real
// credentials before enabling live execution, and record the result as evidence:
//   RUN_LIVE_E2B_TESTS=true E2B_API_KEY=... pnpm --filter @atoms/sandbox-provider test
test(
  "live E2B egress: only allowlisted hosts are reachable and code inside cannot widen that",
  { skip: liveEnabled ? false : "requires explicit RUN_LIVE_E2B_TESTS=true and E2B_API_KEY" },
  async () => {
    const apiKey = process.env.E2B_API_KEY;
    assert.ok(apiKey);
    const adapter = new E2BSandboxAdapter({ apiKey });
    const sandbox = await adapter.create({
      ...(process.env.E2B_TEMPLATE === undefined ||
      process.env.E2B_TEMPLATE.length === 0
        ? {}
        : { template: process.env.E2B_TEMPLATE }),
      timeoutMs: 120_000,
      network: { allowedHosts: ["registry.npmjs.org"], allowPublicTraffic: false },
      lifecycle: { onTimeout: "kill", autoResume: false },
    });
    const probe = (url: string) =>
      adapter.exec(sandbox.id, {
        command: `curl -sS -o /dev/null -w "%{http_code}" --max-time 15 ${url}`,
        timeoutMs: 30_000,
      });

    try {
      const allowed = await probe("https://registry.npmjs.org/-/ping");
      assert.equal(allowed.exitCode, 0, `allowlisted host must be reachable: ${allowed.stderr}`);
      assert.match(allowed.stdout, /^2\d\d$/);

      const unknownHost = await probe("https://example.com");
      assert.notEqual(unknownHost.exitCode, 0, "a non-allowlisted hostname must be blocked");

      const arbitraryPublicIp = await probe("https://1.1.1.1");
      assert.notEqual(arbitraryPublicIp.exitCode, 0, "an arbitrary public IP must be blocked");

      // Code running inside the sandbox tries to loosen the firewall; the policy is
      // enforced outside the VM, so the blocked host must stay blocked.
      await adapter.exec(sandbox.id, {
        command: "sh -c 'sudo -n iptables -F; sudo -n nft flush ruleset; true' 2>/dev/null",
        timeoutMs: 30_000,
      });
      const afterTamper = await probe("https://example.com");
      assert.notEqual(afterTamper.exitCode, 0, "in-sandbox tampering must not open egress");
    } finally {
      await adapter.terminate(sandbox.id);
    }
  },
);
