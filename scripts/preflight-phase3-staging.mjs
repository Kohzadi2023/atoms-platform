#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  printUsage();
  process.exit(0);
}

if (options.errors.length > 0) {
  for (const message of options.errors) {
    console.error(`preflight argument error: ${message}`);
  }
  printUsage();
  process.exit(2);
}

const live = options.live;

const durabilityChecks = [
  equals("RUN_PHASE3_DURABILITY_INTEGRATION_TESTS", "true"),
  equals(
    "PHASE3_INTEGRATION_DATABASE_CONFIRMATION",
    "DEDICATED_EPHEMERAL_DATABASE",
  ),
  required("DATABASE_URL"),
  required("REDIS_URL"),
];

const liveChecks = [
  equals("RUN_LIVE_PHASE3_STAGING", "true"),
  equals(
    "PHASE3_STAGING_DESTRUCTIVE_CONFIRMATION",
    "PROVISION_MIGRATE_AND_DESTROY_SUPABASE_STAGING_DATABASE",
  ),
  equals(
    "PHASE3_INTEGRATION_DATABASE_CONFIRMATION",
    "DEDICATED_EPHEMERAL_DATABASE",
  ),
  pattern(
    "PHASE3_STAGING_CHANGE_TICKET",
    /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u,
    "must be a non-empty ticket identifier",
  ),
  pattern(
    "PHASE3_STAGING_MEASURED_COST_CAD",
    /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u,
    "must be a decimal CAD amount with up to 6 fractional digits",
  ),
  required("PHASE3_STAGING_EVIDENCE_PATH"),
  required("DATABASE_URL"),
  required("SUPABASE_ACCESS_TOKEN"),
  required("SUPABASE_ORGANIZATION_SLUG"),
  required("VAULT_ADDR"),
  required("VAULT_TOKEN"),
  required("E2B_API_KEY"),
  oneOf("PHASE3_STAGING_DATABASE_REGION", ["americas", "emea", "apac"]),
  positiveIntOrDefault("PHASE3_STAGING_MIN_OTHER_ORG_CONTROLS", 1),
  positiveIntOrDefault("PHASE3_STAGING_MIN_CUSTOMER_CONTROLS", 1),
];

const checks = live ? [...durabilityChecks, ...liveChecks] : durabilityChecks;
const uniqueChecks = [];
const seenCheckKeys = new Set();
for (const check of checks) {
  const sample = check();
  if (seenCheckKeys.has(sample.key)) {
    continue;
  }
  seenCheckKeys.add(sample.key);
  uniqueChecks.push(check);
}

const results = uniqueChecks.map((check) => check());
const failures = results.filter((result) => result.ok === false);

const mode = live ? "live-provider" : "durability";
const report = {
  schema: "phase3-staging-preflight.v1",
  mode,
  passed: failures.length === 0,
  checkedAt: new Date().toISOString(),
  checks: results,
  failures,
};

if (options.json) {
  console.log(JSON.stringify(report, null, 2));
}

if (options.outputPath !== undefined) {
  const targetPath = resolve(options.outputPath);
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

if (failures.length === 0) {
  console.log(`Phase 3 staging preflight passed for mode: ${mode}`);
  process.exit(0);
}

console.error(`Phase 3 staging preflight failed for mode: ${mode}`);
for (const failure of failures) {
  console.error(`- ${failure.key}: ${failure.reason}`);
}
console.error(
  "Resolve the failed checks before running staging commands. Secrets are intentionally not printed.",
);
process.exit(1);

function required(key) {
  return () => {
    const value = process.env[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return ok(key);
    }
    return fail(key, "is required and must be non-empty");
  };
}

function equals(key, expected) {
  return () => {
    const value = process.env[key];
    if (value === expected) {
      return ok(key);
    }
    return fail(key, `must equal \"${expected}\"`);
  };
}

function oneOf(key, allowed) {
  return () => {
    const value = (process.env[key] ?? "").trim();
    const effective = value.length === 0 ? allowed[0] : value;
    if (allowed.includes(effective)) {
      return ok(key);
    }
    return fail(key, `must be one of: ${allowed.join(", ")}`);
  };
}

function pattern(key, regex, hint) {
  return () => {
    const value = process.env[key];
    if (typeof value === "string" && regex.test(value)) {
      return ok(key);
    }
    return fail(key, hint);
  };
}

function positiveIntOrDefault(key, fallback) {
  return () => {
    const value = process.env[key];
    const normalized = value === undefined || value.trim() === "" ? `${fallback}` : value;
    const parsed = Number.parseInt(normalized, 10);
    if (Number.isInteger(parsed) && parsed > 0 && parsed <= 100) {
      return ok(key);
    }
    return fail(key, "must be a positive integer between 1 and 100");
  };
}

function ok(key) {
  return { ok: true, key, reason: null };
}

function fail(key, reason) {
  return { ok: false, key, reason };
}

function parseArgs(argv) {
  let outputPath;
  const flags = new Set();
  const errors = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      flags.add("--help");
      continue;
    }
    if (token === "--out") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        errors.push("--out requires a file path value");
      } else {
        outputPath = value;
      }
      index += 1;
      continue;
    }
    if (token.startsWith("--out=")) {
      const value = token.slice("--out=".length);
      if (value.length === 0) {
        errors.push("--out= requires a non-empty file path value");
      } else {
        outputPath = value;
      }
      continue;
    }
    if (token === "--json" || token === "--live") {
      flags.add(token);
      continue;
    }
    errors.push(`unknown option: ${token}`);
  }

  return {
    live: flags.has("--live"),
    json: flags.has("--json"),
    outputPath,
    help: flags.has("--help"),
    errors,
  };
}

function printUsage() {
  console.error("Usage: node scripts/preflight-phase3-staging.mjs [--live] [--json] [--out <path>]");
}
