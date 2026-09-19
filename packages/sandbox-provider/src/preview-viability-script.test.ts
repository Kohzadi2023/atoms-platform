import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  PREVIEW_VIABILITY_SCRIPT,
  PREVIEW_VIABILITY_SCRIPT_PATH,
} from "./preview-viability-script.js";

const STUB_PLAYWRIGHT = `
const mode = process.env.STUB_MODE ?? "ok";
export const chromium = {
  async launch() {
    if (mode === "launch-fails") throw new Error("no chromium binary");
    return {
      async newPage() {
        const handlers = {};
        return {
          on(event, handler) { handlers[event] = handler; },
          async goto(url) {
            if (mode === "pageerror") handlers.pageerror(new Error("boom is not defined"));
            if (mode === "response5xx") handlers.response({ status: () => 500, url: () => url + "_next/data.json" });
            return { status: () => (mode === "goto404" ? 404 : 200) };
          },
          async evaluate() {
            return mode === "blank" ? { text: 0, elements: 0 } : { text: 42, elements: 3 };
          },
        };
      },
      async close() {},
    };
  },
};
`;

interface Site {
  readonly root?: { status: number; type?: string; body?: string };
  readonly health?: { status: number };
}

async function withSite<T>(site: Site, run: (port: number) => Promise<T>): Promise<T> {
  const server: Server = createServer((request, response) => {
    if (request.url === "/api/health") {
      response.writeHead(site.health?.status ?? 404).end("{}");
      return;
    }
    const root = site.root ?? { status: 200 };
    response
      .writeHead(root.status, { "content-type": root.type ?? "text/html; charset=utf-8" })
      .end(root.body ?? "<html><body><h1>Hello</h1></body></html>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await run((server.address() as AddressInfo).port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function runScript(options: {
  readonly port: number;
  readonly stubMode?: string;
  readonly playwright?: "stub" | "missing" | "unset";
  readonly attempts?: number;
}): Promise<{ code: number; report: { ok: boolean; failures: string[]; notes: string[] } }> {
  const directory = await mkdtemp(join(tmpdir(), "viability-"));
  try {
    const scriptPath = join(directory, "preview-viability.mjs");
    const stubPath = join(directory, "stub-playwright.mjs");
    await writeFile(scriptPath, PREVIEW_VIABILITY_SCRIPT);
    await writeFile(stubPath, STUB_PLAYWRIGHT);
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      VIABILITY_PORT: String(options.port),
      VIABILITY_START_ATTEMPTS: String(options.attempts ?? 3),
      STUB_MODE: options.stubMode ?? "ok",
    };
    if (options.playwright !== "unset") {
      env.VIABILITY_PLAYWRIGHT_ENTRY =
        options.playwright === "missing" ? join(directory, "absent.mjs") : stubPath;
    }
    return await new Promise((resolve) => {
      execFile(process.execPath, [scriptPath], { env }, (error, stdout) => {
        const code =
          error === null ? 0 : typeof error.code === "number" ? error.code : 99;
        const lastLine = stdout.trim().split("\n").at(-1) ?? "{}";
        resolve({ code, report: JSON.parse(lastLine) });
      });
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("a healthy app passes, and a missing /api/health is only a note", async () => {
  await withSite({}, async (port) => {
    const result = await runScript({ port });

    assert.equal(result.code, 0, JSON.stringify(result.report));
    assert.equal(result.report.ok, true);
    assert.ok(result.report.notes.some((note) => note.includes("no /api/health")));
    assert.ok(result.report.notes.some((note) => note.includes("browser rendered")));
  });
});

test("a health endpoint that answers is accepted, and one that 5xxs fails", async () => {
  await withSite({ health: { status: 200 } }, async (port) => {
    assert.equal((await runScript({ port })).code, 0);
  });
  await withSite({ health: { status: 503 } }, async (port) => {
    const result = await runScript({ port });
    assert.equal(result.code, 1);
    assert.ok(result.report.failures.some((failure) => failure.includes("/api/health returned 503")));
  });
});

test("a startup 5xx on / fails before any browser is started", async () => {
  await withSite({ root: { status: 500 } }, async (port) => {
    const result = await runScript({ port, stubMode: "launch-fails" });

    assert.equal(result.code, 1, "an HTTP failure must win over a browser problem");
    assert.ok(result.report.failures.some((failure) => failure.includes("startup 5xx")));
  });
});

test("a 404 on / fails", async () => {
  await withSite({ root: { status: 404 } }, async (port) => {
    const result = await runScript({ port });
    assert.equal(result.code, 1);
    assert.ok(result.report.failures.some((failure) => failure.includes("/ returned 404")));
  });
});

test("a response that is not HTML, or has no body, fails", async () => {
  await withSite({ root: { status: 200, type: "application/json", body: "{}" } }, async (port) => {
    const result = await runScript({ port });
    assert.equal(result.code, 1);
    assert.ok(result.report.failures.some((failure) => failure.includes("not HTML")));
  });
  await withSite({ root: { status: 200, body: "<html></html>" } }, async (port) => {
    const result = await runScript({ port });
    assert.equal(result.code, 1);
    assert.ok(result.report.failures.some((failure) => failure.includes("no <body>")));
  });
});

test("a redirecting root (for example to a login page) is not a failure by itself", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(307, { location: "/login" }).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const result = await runScript({ port: (server.address() as AddressInfo).port });
    assert.equal(result.code, 0, JSON.stringify(result.report));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a process that never answers fails", async () => {
  const result = await runScript({ port: 1, attempts: 1 });

  assert.equal(result.code, 1);
  assert.ok(result.report.failures.some((failure) => failure.includes("never answered")));
});

test("an uncaught exception in the page fails", async () => {
  await withSite({}, async (port) => {
    const result = await runScript({ port, stubMode: "pageerror" });
    assert.equal(result.code, 1);
    assert.ok(result.report.failures.some((failure) => failure.includes("boom is not defined")));
  });
});

test("a 5xx response while the browser loads the page fails", async () => {
  await withSite({}, async (port) => {
    const result = await runScript({ port, stubMode: "response5xx" });
    assert.equal(result.code, 1);
    assert.ok(result.report.failures.some((failure) => failure.includes("5xx response while loading")));
  });
});

test("a blank page fails, and a browser 404 fails", async () => {
  await withSite({}, async (port) => {
    const blank = await runScript({ port, stubMode: "blank" });
    assert.equal(blank.code, 1);
    assert.ok(blank.report.failures.some((failure) => failure.includes("rendered blank")));

    const notFound = await runScript({ port, stubMode: "goto404" });
    assert.equal(notFound.code, 1);
  });
});

test("a browser that cannot start is a configuration failure (exit 3), not an app defect", async () => {
  await withSite({}, async (port) => {
    const cannotLaunch = await runScript({ port, stubMode: "launch-fails" });
    assert.equal(cannotLaunch.code, 3);
    assert.ok(cannotLaunch.report.failures.some((failure) => failure.includes("Chromium could not start")));

    const missing = await runScript({ port, playwright: "missing" });
    assert.equal(missing.code, 3);
    assert.ok(missing.report.failures.some((failure) => failure.includes("Playwright is not available")));

    const unset = await runScript({ port, playwright: "unset" });
    assert.equal(unset.code, 3);
  });
});

test("the script lives outside the project directory and needs no network", () => {
  assert.equal(PREVIEW_VIABILITY_SCRIPT_PATH.startsWith("/tmp/"), true);
  // Only loopback: the browser check must work with egress denied.
  assert.match(PREVIEW_VIABILITY_SCRIPT, /127\.0\.0\.1/);
  assert.doesNotMatch(PREVIEW_VIABILITY_SCRIPT, /https?:\/\/(?!127\.0\.0\.1)[a-z]/i);
});
