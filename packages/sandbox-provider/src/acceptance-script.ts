import { z } from "zod";

/**
 * G3 - evidence-based acceptance (docs/adr/production-execution-gate.md).
 * Deliberately small: a fixed, operator-authored set of scenarios run inside
 * the sandbox against the preview that preview-health already confirmed is
 * up. Not a general acceptance framework -- there is no scripting language
 * here, only this closed vocabulary of actions, so a manifest can be
 * reviewed like configuration, not audited like code.
 *
 * What a scenario means for release readiness (which of Emma's free-text
 * acceptance criteria it is evidence for, if any) is decided by the caller
 * of `evidenceFromAcceptanceRun` in @atoms/quality, not by this manifest --
 * this file only knows how to execute a named scenario and report pass or
 * fail. See apps/orchestrator-worker/src/acceptance-manifest.ts.
 */

const ScenarioNameSchema = z.string().trim().min(1).max(120);
const RoutePathSchema = z.string().trim().min(1).max(500).refine(
  (value) => value.startsWith("/"),
  "must be a path, not an absolute URL",
);
const SelectorSchema = z.string().trim().min(1).max(300);

const JourneyStepSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("goto"), path: RoutePathSchema }).strict(),
  z.object({ action: z.literal("click"), selector: SelectorSchema }).strict(),
  z.object({
    action: z.literal("fill"), selector: SelectorSchema, value: z.string().max(2_000),
  }).strict(),
  z.object({ action: z.literal("expectText"), text: z.string().trim().min(1).max(500) }).strict(),
  z.object({ action: z.literal("expectPath"), path: RoutePathSchema }).strict(),
]);
export type AcceptanceJourneyStep = z.infer<typeof JourneyStepSchema>;

export const AcceptanceScenarioSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("HEALTH_CHECK"), name: ScenarioNameSchema, path: RoutePathSchema,
  }).strict(),
  z.object({
    kind: z.literal("CRITICAL_ROUTE"), name: ScenarioNameSchema, path: RoutePathSchema,
    expectText: z.string().trim().min(1).max(500).optional(),
  }).strict(),
  z.object({
    kind: z.literal("AUTH_FLOW"), name: ScenarioNameSchema,
    loginPath: RoutePathSchema, usernameSelector: SelectorSchema, passwordSelector: SelectorSchema,
    submitSelector: SelectorSchema, username: z.string().min(1).max(200), password: z.string().min(1).max(200),
    expectPathAfterLogin: RoutePathSchema,
  }).strict(),
  z.object({
    kind: z.literal("PRIMARY_JOURNEY"), name: ScenarioNameSchema,
    steps: z.array(JourneyStepSchema).min(1).max(20),
  }).strict(),
]);
export type AcceptanceScenario = z.infer<typeof AcceptanceScenarioSchema>;

export const AcceptanceManifestSchema = z.object({
  schemaVersion: z.literal("atoms.acceptance-manifest.v1"),
  scenarios: z.array(AcceptanceScenarioSchema).min(1).max(20),
}).strict().refine(
  (value) => new Set(value.scenarios.map((scenario) => scenario.name)).size === value.scenarios.length,
  "Scenario names must be unique",
);
export type AcceptanceManifest = z.infer<typeof AcceptanceManifestSchema>;

export const ACCEPTANCE_SCRIPT_PATH = "/tmp/atoms-acceptance/acceptance-check.mjs";
export const ACCEPTANCE_MANIFEST_PATH = "/tmp/atoms-acceptance/manifest.json";

/**
 * Written as plain ESM text (no template literals) so the runner can write it
 * into the sandbox as is, mirroring preview-viability-script.ts. A scenario
 * failure is business evidence, not an infrastructure problem: the script
 * always exits 0 once it has produced a result for every scenario, whatever
 * those results say. Exit 2 means the manifest itself could not be read.
 * Exit 3 means Chromium/Playwright could not be started -- a template
 * problem, reported separately from a scenario outcome, same convention as
 * preview-viability-script.ts.
 */
export const ACCEPTANCE_SCRIPT = String.raw`import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const port = process.env.ACCEPTANCE_PORT ?? "3000";
const playwrightEntry = process.env.ACCEPTANCE_PLAYWRIGHT_ENTRY;
const manifestPath = process.env.ACCEPTANCE_MANIFEST_PATH;
const base = "http://127.0.0.1:" + port;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const scenarioTimeoutMs = Number(process.env.ACCEPTANCE_SCENARIO_TIMEOUT_MS ?? "15000");

function finish(code, results) {
  console.log(JSON.stringify({ ok: results.every((r) => r.status === "PASSED"), results }));
  process.exit(code);
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (error) {
  console.log(JSON.stringify({ ok: false, results: [], configError: "cannot read manifest: " + String(error) }));
  process.exit(2);
}

if (!playwrightEntry) {
  console.log(JSON.stringify({ ok: false, results: [], configError: "no Playwright entry configured" }));
  process.exit(3);
}
let chromium;
try {
  ({ chromium } = await import(pathToFileURL(playwrightEntry).href));
} catch (error) {
  console.log(JSON.stringify({ ok: false, results: [], configError: "Playwright is not available: " + String(error) }));
  process.exit(3);
}
let browser;
try {
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
} catch (error) {
  console.log(JSON.stringify({ ok: false, results: [], configError: "Chromium could not start: " + String(error) }));
  process.exit(3);
}

async function withTimeout(run) {
  let timer;
  try {
    return await Promise.race([
      run(),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("scenario timed out")), scenarioTimeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function runHealthCheck(scenario) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(base + scenario.path, { signal: controller.signal });
    if (response.status >= 500) throw new AssertionError(scenario.path + " returned " + String(response.status));
  } finally {
    clearTimeout(timer);
  }
}

async function runCriticalRoute(page, scenario) {
  const response = await page.goto(base + scenario.path, { waitUntil: "load", timeout: 15_000 });
  if (response === null || response.status() >= 400) {
    throw new AssertionError(scenario.path + " responded with " + String(response === null ? "no response" : response.status()));
  }
  if (scenario.expectText) {
    const text = await page.evaluate(() => document.body ? document.body.innerText : "");
    if (!text.includes(scenario.expectText)) {
      throw new AssertionError(scenario.path + " did not contain the expected text");
    }
  }
}

async function runAuthFlow(page, scenario) {
  const response = await page.goto(base + scenario.loginPath, { waitUntil: "load", timeout: 15_000 });
  if (response === null || response.status() >= 400) throw new AssertionError("login page did not load");
  await page.fill(scenario.usernameSelector, scenario.username);
  await page.fill(scenario.passwordSelector, scenario.password);
  await Promise.all([
    page.waitForURL("**" + scenario.expectPathAfterLogin, { timeout: 15_000 }).catch(() => undefined),
    page.click(scenario.submitSelector),
  ]);
  await sleep(500);
  const url = new URL(page.url());
  if (url.pathname !== scenario.expectPathAfterLogin) {
    throw new AssertionError("expected " + scenario.expectPathAfterLogin + " after login, landed on " + url.pathname);
  }
}

async function runPrimaryJourney(page, scenario) {
  for (const step of scenario.steps) {
    if (step.action === "goto") {
      const response = await page.goto(base + step.path, { waitUntil: "load", timeout: 15_000 });
      if (response === null || response.status() >= 400) throw new AssertionError(step.path + " did not load");
    } else if (step.action === "click") {
      await page.click(step.selector, { timeout: 10_000 });
    } else if (step.action === "fill") {
      await page.fill(step.selector, step.value, { timeout: 10_000 });
    } else if (step.action === "expectText") {
      const text = await page.evaluate(() => document.body ? document.body.innerText : "");
      if (!text.includes(step.text)) throw new AssertionError("expected page text to include: " + step.text);
    } else if (step.action === "expectPath") {
      const url = new URL(page.url());
      if (url.pathname !== step.path) throw new AssertionError("expected path " + step.path + ", was " + url.pathname);
    }
  }
}

class AssertionError extends Error {}

const results = [];
for (const scenario of manifest.scenarios) {
  const startedAt = Date.now();
  let page;
  try {
    if (scenario.kind !== "HEALTH_CHECK") page = await browser.newPage();
    await withTimeout(async () => {
      if (scenario.kind === "HEALTH_CHECK") await runHealthCheck(scenario);
      else if (scenario.kind === "CRITICAL_ROUTE") await runCriticalRoute(page, scenario);
      else if (scenario.kind === "AUTH_FLOW") await runAuthFlow(page, scenario);
      else if (scenario.kind === "PRIMARY_JOURNEY") await runPrimaryJourney(page, scenario);
    });
    results.push({ scenario: scenario.name, status: "PASSED", durationMs: Date.now() - startedAt });
  } catch (error) {
    const status = error instanceof AssertionError ? "FAILED" : "ERROR";
    results.push({ scenario: scenario.name, status, durationMs: Date.now() - startedAt, note: String(error && error.message ? error.message : error) });
  } finally {
    if (page) await page.close().catch(() => undefined);
  }
}

await browser.close().catch(() => undefined);
finish(0, results);
`;
