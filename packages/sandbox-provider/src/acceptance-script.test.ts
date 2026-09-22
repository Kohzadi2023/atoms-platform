import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ACCEPTANCE_SCRIPT,
  ACCEPTANCE_SCRIPT_PATH,
  AcceptanceManifestSchema,
  type AcceptanceManifest,
} from "./acceptance-script.js";

// A tiny fake single-page app: goto/click/fill/waitForURL/url()/evaluate() all
// share one `path` per page, so a login click can move it and a later
// evaluate/expectPath sees the result, without needing a real browser.
const STUB_PLAYWRIGHT = `
const mode = process.env.STUB_MODE ?? "ok";
export const chromium = {
  async launch() {
    if (mode === "launch-fails") throw new Error("no chromium binary");
    return {
      async newPage() {
        let path = "/";
        return {
          async goto(url) {
            if (mode === "hang") return new Promise(() => {});
            const target = new URL(url);
            if (mode === "goto-404" && target.pathname === "/missing") return { status: () => 404 };
            path = target.pathname;
            return { status: () => 200 };
          },
          async fill() {},
          async click(selector) {
            if (selector === "#submit" && mode !== "login-fails") path = "/dashboard";
          },
          async waitForURL() {},
          url() { return "http://127.0.0.1:3000" + path; },
          async evaluate() {
            return path === "/" ? "Welcome home" : "Dashboard: item created";
          },
          async close() {},
        };
      },
      async close() {},
    };
  },
};
`;

const MANIFEST: AcceptanceManifest = {
  schemaVersion: "atoms.acceptance-manifest.v1",
  scenarios: [
    { kind: "CRITICAL_ROUTE", name: "home-loads", path: "/", expectText: "Welcome home" },
    {
      kind: "AUTH_FLOW", name: "login-works", loginPath: "/login",
      usernameSelector: "#user", passwordSelector: "#pass", submitSelector: "#submit",
      username: "demo", password: "demo", expectPathAfterLogin: "/dashboard",
    },
    {
      kind: "PRIMARY_JOURNEY", name: "create-item",
      steps: [
        { action: "goto", path: "/dashboard" },
        { action: "click", selector: "#new-item" },
        { action: "expectText", text: "item created" },
        { action: "expectPath", path: "/dashboard" },
      ],
    },
  ],
};

interface Site {
  readonly healthStatus?: number;
}

async function withSite<T>(site: Site, run: (port: number) => Promise<T>): Promise<T> {
  const server: Server = createServer((_request, response) => {
    response.writeHead(site.healthStatus ?? 200).end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await run((server.address() as AddressInfo).port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

interface Report {
  readonly ok: boolean;
  readonly results: ReadonlyArray<{ scenario: string; status: string; durationMs: number; note?: string }>;
  readonly configError?: string;
}

async function runScript(options: {
  readonly port: number;
  readonly manifest: AcceptanceManifest;
  readonly stubMode?: string;
  readonly playwright?: "stub" | "missing" | "unset";
  readonly scenarioTimeoutMs?: number;
}): Promise<{ code: number; report: Report }> {
  const directory = await mkdtemp(join(tmpdir(), "acceptance-"));
  try {
    const scriptPath = join(directory, "acceptance-check.mjs");
    const stubPath = join(directory, "stub-playwright.mjs");
    const manifestPath = join(directory, "manifest.json");
    await writeFile(scriptPath, ACCEPTANCE_SCRIPT);
    await writeFile(stubPath, STUB_PLAYWRIGHT);
    await writeFile(manifestPath, JSON.stringify(options.manifest));
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      ACCEPTANCE_PORT: String(options.port),
      ACCEPTANCE_MANIFEST_PATH: manifestPath,
      STUB_MODE: options.stubMode ?? "ok",
      ...(options.scenarioTimeoutMs === undefined
        ? {}
        : { ACCEPTANCE_SCENARIO_TIMEOUT_MS: String(options.scenarioTimeoutMs) }),
    };
    if (options.playwright !== "unset") {
      env.ACCEPTANCE_PLAYWRIGHT_ENTRY =
        options.playwright === "missing" ? join(directory, "absent.mjs") : stubPath;
    }
    return await new Promise((resolve) => {
      execFile(process.execPath, [scriptPath], { env }, (error, stdout) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : 99;
        const lastLine = stdout.trim().split("\n").at(-1) ?? "{}";
        resolve({ code, report: JSON.parse(lastLine) as Report });
      });
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("a healthy route, a working login and a full journey all pass, and the script always exits 0", async () => {
  await withSite({}, async (port) => {
    const result = await runScript({ port, manifest: MANIFEST });
    assert.equal(result.code, 0, JSON.stringify(result.report));
    assert.equal(result.report.ok, true);
    assert.equal(result.report.results.length, 3);
    assert.ok(result.report.results.every((item) => item.status === "PASSED"));
  });
});

test("a scenario assertion that does not hold is FAILED, not ERROR, and other scenarios still run", async () => {
  await withSite({}, async (port) => {
    const result = await runScript({ port, stubMode: "login-fails", manifest: MANIFEST });
    assert.equal(result.code, 0);
    const byName = new Map(result.report.results.map((item) => [item.scenario, item.status]));
    assert.equal(byName.get("login-works"), "FAILED");
    // The failing scenario does not stop the run: a later scenario still executes.
    assert.equal(byName.get("create-item"), "PASSED");
  });
});

test("a health-check scenario uses real fetch, no browser needed for it", async () => {
  await withSite({ healthStatus: 200 }, async (port) => {
    const manifest: AcceptanceManifest = {
      schemaVersion: "atoms.acceptance-manifest.v1",
      scenarios: [{ kind: "HEALTH_CHECK", name: "api-health", path: "/api/health" }],
    };
    const result = await runScript({ port, manifest });
    assert.equal(result.report.results[0]?.status, "PASSED");
  });
  await withSite({ healthStatus: 503 }, async (port) => {
    const manifest: AcceptanceManifest = {
      schemaVersion: "atoms.acceptance-manifest.v1",
      scenarios: [{ kind: "HEALTH_CHECK", name: "api-health", path: "/api/health" }],
    };
    const result = await runScript({ port, manifest });
    assert.equal(result.report.results[0]?.status, "FAILED");
  });
});

test("a scenario that never resolves is reported ERROR by its own timeout, not hung forever", async () => {
  await withSite({}, async (port) => {
    const manifest: AcceptanceManifest = {
      schemaVersion: "atoms.acceptance-manifest.v1",
      scenarios: [{ kind: "CRITICAL_ROUTE", name: "home-loads", path: "/" }],
    };
    const result = await runScript({ port, manifest, stubMode: "hang", scenarioTimeoutMs: 200 });
    assert.equal(result.code, 0);
    assert.equal(result.report.results[0]?.status, "ERROR");
    assert.match(result.report.results[0]?.note ?? "", /timed out/);
  });
});

test("a browser that cannot start is a configuration failure (exit 3), reported before any scenario runs", async () => {
  await withSite({}, async (port) => {
    const cannotLaunch = await runScript({ port, manifest: MANIFEST, stubMode: "launch-fails" });
    assert.equal(cannotLaunch.code, 3);
    assert.equal(cannotLaunch.report.results.length, 0);
    assert.match(cannotLaunch.report.configError ?? "", /Chromium could not start/);

    const missing = await runScript({ port, manifest: MANIFEST, playwright: "missing" });
    assert.equal(missing.code, 3);

    const unset = await runScript({ port, manifest: MANIFEST, playwright: "unset" });
    assert.equal(unset.code, 3);
  });
});

test("an unreadable manifest is exit 2, a configuration problem distinct from a browser problem", async () => {
  await withSite({}, async (port) => {
    const directory = await mkdtemp(join(tmpdir(), "acceptance-bad-manifest-"));
    try {
      const scriptPath = join(directory, "acceptance-check.mjs");
      await writeFile(scriptPath, ACCEPTANCE_SCRIPT);
      const result = await new Promise<{ code: number }>((resolve) => {
        execFile(process.execPath, [scriptPath], {
          env: {
            PATH: process.env.PATH,
            ACCEPTANCE_PORT: String(port),
            ACCEPTANCE_MANIFEST_PATH: join(directory, "does-not-exist.json"),
          },
        }, (error) => resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : 99 }));
      });
      assert.equal(result.code, 2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test("only loopback is addressed and the script lives outside the project directory", () => {
  assert.equal(ACCEPTANCE_SCRIPT_PATH.startsWith("/tmp/"), true);
  assert.doesNotMatch(ACCEPTANCE_SCRIPT, /https?:\/\/(?!127\.0\.0\.1)[a-z]/i);
});

test("the manifest schema accepts every scenario kind and rejects duplicate names", () => {
  AcceptanceManifestSchema.parse(MANIFEST);
  assert.throws(() => AcceptanceManifestSchema.parse({
    ...MANIFEST,
    scenarios: [...MANIFEST.scenarios, MANIFEST.scenarios[0]],
  }));
});
