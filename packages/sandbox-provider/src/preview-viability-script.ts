/**
 * Minimum preview viability, run inside the sandbox against the preview that was
 * just started (docs/adr/production-execution-gate.md, G7). It is deliberately
 * small: the process answers, `/` does not 5xx and returns a page, and a real
 * browser loads it without an uncaught exception or a 5xx and shows something.
 * It checks no business workflow; that is G3.
 *
 * Written as plain ESM text (no template literals) so the runner can write it
 * into the sandbox as is. Exit codes: 0 viable, 1 not viable, 3 the browser
 * could not be started (a configuration problem, not an application defect).
 * The last stdout line is a JSON report.
 */
export const PREVIEW_VIABILITY_SCRIPT_PATH =
  "/tmp/atoms-viability/preview-viability.mjs";

/** Where the E2B template is expected to carry Playwright when the check is required. */
export const DEFAULT_PLAYWRIGHT_ENTRY =
  "/opt/atoms-viability/node_modules/playwright/index.mjs";

export const PREVIEW_VIABILITY_SCRIPT = String.raw`import { pathToFileURL } from "node:url";

const port = process.env.VIABILITY_PORT ?? "3000";
const playwrightEntry = process.env.VIABILITY_PLAYWRIGHT_ENTRY;
const base = "http://127.0.0.1:" + port;
const failures = [];
const notes = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function finish(code) {
  console.log(JSON.stringify({ ok: code === 0, failures, notes }));
  process.exit(code);
}

async function get(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(base + path, { signal: controller.signal, redirect: "manual" });
    const text = await response.text();
    return { status: response.status, type: response.headers.get("content-type") ?? "", text };
  } finally {
    clearTimeout(timer);
  }
}

let first = null;
const startAttempts = Number(process.env.VIABILITY_START_ATTEMPTS ?? "60");
for (let attempt = 0; attempt < startAttempts && first === null; attempt += 1) {
  try {
    first = await get("/");
  } catch {
    await sleep(1000);
  }
}
if (first === null) {
  failures.push("the preview process never answered on port " + port);
  finish(1);
}

const samples = [first];
for (let index = 0; index < 2; index += 1) {
  await sleep(500);
  try {
    samples.push(await get("/"));
  } catch (error) {
    failures.push("/ stopped answering after it had responded: " + String(error));
  }
}
for (const sample of samples) {
  if (sample.status >= 500) failures.push("startup 5xx: / returned " + String(sample.status));
}
if (first.status >= 400 && first.status < 500) failures.push("/ returned " + String(first.status));
if (first.status >= 200 && first.status < 300) {
  if (!first.type.includes("text/html")) failures.push("/ is not HTML: " + first.type);
  else if (!/<body[\s>]/i.test(first.text)) failures.push("/ has no <body>");
}

try {
  const health = await get("/api/health");
  if (health.status >= 500) failures.push("/api/health returned " + String(health.status));
  else if (health.status === 404) notes.push("no /api/health endpoint; not required of generated apps");
} catch (error) {
  failures.push("/api/health did not answer: " + String(error));
}

if (failures.length > 0) finish(1);

if (!playwrightEntry) {
  failures.push("no Playwright entry configured for the browser check");
  finish(3);
}
let chromium;
try {
  ({ chromium } = await import(pathToFileURL(playwrightEntry).href));
} catch (error) {
  failures.push("Playwright is not available at " + playwrightEntry + ": " + String(error));
  finish(3);
}
let browser;
try {
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
} catch (error) {
  failures.push("Chromium could not start: " + String(error));
  finish(3);
}

try {
  const page = await browser.newPage();
  page.on("pageerror", (error) => failures.push("uncaught exception in the page: " + String(error && error.message ? error.message : error)));
  page.on("response", (response) => {
    if (response.status() >= 500) failures.push("5xx response while loading: " + response.url() + " " + String(response.status()));
  });
  const response = await page.goto(base + "/", { waitUntil: "load", timeout: 30000 });
  if (response === null || response.status() >= 400) {
    failures.push("the browser got " + String(response === null ? "no response" : response.status()) + " for /");
  }
  await sleep(1500);
  const rendered = await page.evaluate(() => ({
    text: document.body ? document.body.innerText.trim().length : 0,
    elements: document.body ? document.body.children.length : 0,
  }));
  if (rendered.text === 0 && rendered.elements === 0) failures.push("the page rendered blank");
  notes.push("browser rendered " + String(rendered.elements) + " top-level elements");
} catch (error) {
  failures.push("browser check failed: " + String(error));
} finally {
  await browser.close().catch(() => undefined);
}
finish(failures.length > 0 ? 1 : 0);
`;
