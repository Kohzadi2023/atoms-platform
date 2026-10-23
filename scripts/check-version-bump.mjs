import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/u;

export function parseVersion(value) {
  const match = SEMVER.exec(String(value).trim());
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

// Negative when a < b, zero when equal, positive when a > b.
export function compareVersions(a, b) {
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

export function checkVersionBump(baseVersion, headVersion) {
  const base = parseVersion(baseVersion);
  const head = parseVersion(headVersion);
  if (base === undefined) {
    return { ok: false, reason: `base version "${baseVersion}" is not MAJOR.MINOR.PATCH` };
  }
  if (head === undefined) {
    return { ok: false, reason: `version "${headVersion}" is not MAJOR.MINOR.PATCH` };
  }
  if (compareVersions(head, base) <= 0) {
    return {
      ok: false,
      reason:
        `package.json version ${headVersion} must be greater than ${baseVersion} on main. ` +
        "Every merge bumps the version shown in the app footer; raise the patch number " +
        "(and rebase onto main if another PR took this one first).",
    };
  }
  return { ok: true, reason: `version ${baseVersion} -> ${headVersion}` };
}

function readVersion(json) {
  return JSON.parse(json).version;
}

function main() {
  const baseSha = process.argv[2] ?? process.env.BASE_SHA;
  if (baseSha === undefined || baseSha.length === 0) {
    console.error("usage: check-version-bump.mjs <base-sha> (or set BASE_SHA)");
    process.exit(2);
  }
  const baseVersion = readVersion(
    execFileSync("git", ["show", `${baseSha}:package.json`], { encoding: "utf8" }),
  );
  const headVersion = readVersion(readFileSync("package.json", "utf8"));
  const result = checkVersionBump(baseVersion, headVersion);
  if (!result.ok) {
    console.error(`::error::${result.reason}`);
    process.exit(1);
  }
  console.log(result.reason);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
