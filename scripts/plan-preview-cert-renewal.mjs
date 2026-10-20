// Decides whether the *.preview.genesisco.io wildcard certificate should be renewed now,
// and names the certificate the renewal would upload (issue #93).
//
//   node scripts/plan-preview-cert-renewal.mjs [--renew-before-days 45] [--force] [--host <name>]
//
// Read-only: one TLS handshake, no credentials. It writes `renew`, `reason`, `days_left`
// and `certificate_name` to $GITHUB_OUTPUT when that is set, and prints the same lines.
//
// The threshold is deliberately larger than the 30-day alert in preview-cert-expiry.yml.
// A weekly schedule then gets about two attempts at renewing before anyone is alerted, and
// the alert means "automatic renewal has failed", not "renewal is due".
//
// Exit codes: 0 a decision was made (renew or not), 2 the check itself could not run.

import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_HOST, daysUntil, fetchCertificate } from "./check-preview-cert-expiry.mjs";

export const DEFAULT_RENEW_BEFORE_DAYS = 45;
export const CERTIFICATE_NAME_PREFIX = "genesisco-preview-wildcard-le";

export function parseArguments(argv) {
  const options = { host: DEFAULT_HOST, renewBeforeDays: DEFAULT_RENEW_BEFORE_DAYS, force: false, timeoutMs: 15_000 };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--host") options.host = argv[(index += 1)];
    else if (argument === "--renew-before-days") options.renewBeforeDays = Number(argv[(index += 1)]);
    else if (argument === "--force") options.force = true;
    else throw new RangeError(`unknown argument: ${argument}`);
  }
  if (typeof options.host !== "string" || !/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(options.host)) {
    throw new RangeError("--host must be a hostname");
  }
  if (!Number.isFinite(options.renewBeforeDays) || options.renewBeforeDays < 31 || options.renewBeforeDays > 80) {
    // Below 31 the renewal would race the 30-day alert; above 80 it would renew a
    // 90-day certificate almost as soon as it was issued.
    throw new RangeError("--renew-before-days must be a number from 31 to 80");
  }
  return options;
}

/**
 * Azure resource names for the uploaded certificate. Each renewal gets a new, unique name so the
 * certificate it replaces stays available for rollback. Lowercase letters, digits and hyphens only.
 */
export function certificateNameFor(now) {
  const iso = now.toISOString(); // 2026-11-02T06:17:09.123Z
  const stamp = `${iso.slice(0, 10).replaceAll("-", "")}-${iso.slice(11, 16).replace(":", "")}`;
  return `${CERTIFICATE_NAME_PREFIX}-${stamp}`;
}

/** Pure decision. `validTo` is the expiry of the certificate currently served. */
export function decide({ validTo, now, renewBeforeDays, force }) {
  const daysLeft = daysUntil(validTo, now);
  let renew = false;
  let reason;
  if (force) {
    renew = true;
    reason = `forced; ${String(daysLeft)} days were left`;
  } else if (daysLeft < 0) {
    renew = true;
    reason = `the certificate has already expired (${String(daysLeft)} days)`;
  } else if (daysLeft <= renewBeforeDays) {
    renew = true;
    reason = `${String(daysLeft)} days left is within the ${String(renewBeforeDays)}-day renewal window`;
  } else {
    reason = `${String(daysLeft)} days left is outside the ${String(renewBeforeDays)}-day renewal window`;
  }
  return { renew, reason, daysLeft, certificateName: certificateNameFor(now) };
}

export function formatOutputs(decision) {
  return [
    `renew=${String(decision.renew)}`,
    `reason=${decision.reason}`,
    `days_left=${String(decision.daysLeft)}`,
    `certificate_name=${decision.certificateName}`,
  ];
}

export async function run(
  argv,
  { fetchCertificateImpl = fetchCertificate, now = () => new Date(), write = console.log, outputFile = process.env.GITHUB_OUTPUT } = {},
) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    write(`usage error: ${error.message}`);
    return 2;
  }
  let certificate;
  try {
    certificate = await fetchCertificateImpl(options.host, options.timeoutMs);
  } catch (error) {
    write(`could not read the certificate from ${options.host}: ${error.message}`);
    return 2;
  }
  let decision;
  try {
    decision = decide({ validTo: certificate.validTo, now: now(), renewBeforeDays: options.renewBeforeDays, force: options.force });
  } catch (error) {
    write(`could not evaluate the certificate: ${error.message}`);
    return 2;
  }
  const lines = formatOutputs(decision);
  for (const line of lines) write(line);
  if (outputFile) appendFileSync(outputFile, `${lines.join("\n")}\n`);
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await run(process.argv.slice(2));
}
