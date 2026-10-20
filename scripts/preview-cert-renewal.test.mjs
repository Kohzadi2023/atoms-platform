import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CERTIFICATE_NAME_PREFIX,
  DEFAULT_RENEW_BEFORE_DAYS,
  certificateNameFor,
  decide,
  formatOutputs,
  parseArguments,
  run,
} from "./plan-preview-cert-renewal.mjs";

// Whole seconds: toUTCString() drops milliseconds, which would shave a day off "46 days left".
const NOW = new Date("2026-11-02T06:17:09.000Z");
const validToIn = (days) => new Date(NOW.getTime() + days * 86_400_000).toUTCString();

test("renewal starts inside the window and not before it", () => {
  assert.equal(decide({ validTo: validToIn(46), now: NOW, renewBeforeDays: 45, force: false }).renew, false);
  assert.equal(decide({ validTo: validToIn(45), now: NOW, renewBeforeDays: 45, force: false }).renew, true);
  assert.equal(decide({ validTo: validToIn(10), now: NOW, renewBeforeDays: 45, force: false }).renew, true);
});

test("an expired certificate is renewed, and force overrides the window", () => {
  const expired = decide({ validTo: validToIn(-3), now: NOW, renewBeforeDays: 45, force: false });
  assert.equal(expired.renew, true);
  assert.match(expired.reason, /already expired/);
  const forced = decide({ validTo: validToIn(80), now: NOW, renewBeforeDays: 45, force: true });
  assert.equal(forced.renew, true);
  assert.match(forced.reason, /forced/);
});

test("the renewal window sits above the 30-day alert so the alert means renewal failed", () => {
  assert.ok(DEFAULT_RENEW_BEFORE_DAYS > 30);
  assert.throws(() => parseArguments(["--renew-before-days", "30"]), RangeError);
  assert.throws(() => parseArguments(["--renew-before-days", "81"]), RangeError);
  assert.throws(() => parseArguments(["--unknown"]), RangeError);
  assert.equal(parseArguments(["--force"]).force, true);
});

test("each renewal gets a new, valid Azure certificate name", () => {
  const name = certificateNameFor(NOW);
  assert.equal(name, `${CERTIFICATE_NAME_PREFIX}-20261102-0617`);
  assert.match(name, /^[a-z0-9][a-z0-9-]{0,62}$/);
  assert.notEqual(name, certificateNameFor(new Date(NOW.getTime() + 60_000)));
  // Never the name already in service, which must stay available for rollback.
  assert.notEqual(name, CERTIFICATE_NAME_PREFIX);
  assert.notEqual(name, `${CERTIFICATE_NAME_PREFIX}-2`);
});

test("outputs are single lines in key=value form", () => {
  const lines = formatOutputs(decide({ validTo: validToIn(20), now: NOW, renewBeforeDays: 45, force: false }));
  assert.deepEqual(lines.map((line) => line.split("=")[0]), ["renew", "reason", "days_left", "certificate_name"]);
  for (const line of lines) assert.ok(!line.includes("\n"));
});

test("run writes the decision to the output file and exits 0, or 2 when the check cannot run", async () => {
  const directory = mkdtempSync(join(tmpdir(), "plan-cert-"));
  try {
    const outputFile = join(directory, "output");
    const written = [];
    const code = await run([], {
      fetchCertificateImpl: async () => ({ validTo: validToIn(20) }),
      now: () => NOW,
      write: (line) => written.push(line),
      outputFile,
    });
    assert.equal(code, 0);
    const text = readFileSync(outputFile, "utf8");
    assert.match(text, /^renew=true$/m);
    assert.match(text, /^certificate_name=genesisco-preview-wildcard-le-20261102-0617$/m);

    const failed = await run([], {
      fetchCertificateImpl: async () => {
        throw new Error("boom");
      },
      now: () => NOW,
      write: () => {},
      outputFile,
    });
    assert.equal(failed, 2);
    assert.equal(await run(["--renew-before-days", "5"], { write: () => {}, outputFile }), 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});


// The workflow cannot run in CI without a real Azure subscription and Let's Encrypt, so these
// pin the properties that make a bad edit dangerous. They do not prove the workflow works; the
// rehearsal does. Each property is checked inside the step it belongs to, with comments removed,
// so a phrase in a comment or in a different step cannot satisfy an assertion.
// Checkouts on Windows may use CRLF; the patterns below assume LF.
const withoutComments = (text, marker) =>
  text
    .replaceAll("\r\n", "\n")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith(marker))
    .join("\n");
const workflow = withoutComments(
  readFileSync(new URL("../.github/workflows/preview-cert-renew.yml", import.meta.url), "utf8"),
  "#",
);
const bicep = withoutComments(
  readFileSync(new URL("../infra/azure/staging/preview-acme-dns.bicep", import.meta.url), "utf8"),
  "//",
);

const [triggers, jobsText] = workflow.split(/^jobs:\n/mu);
const jobBlocks = Object.fromEntries(
  jobsText
    .split(/^ {2}(?=[a-z]+:\n)/mu)
    .filter((block) => block.trim().length > 0)
    .map((block) => [block.slice(0, block.indexOf(":")), block]),
);
const stepsOf = (job) => jobBlocks[job].split(/^ {6}- (?=name:|uses:)/mu).slice(1);
const titleOf = (stepText) => stepText.match(/name: (.*)/u)?.[1] ?? "";
function step(job, title) {
  const found = stepsOf(job).filter((candidate) => candidate.includes(title));
  assert.equal(found.length, 1, `expected exactly one step containing "${title}" in job ${job}`);
  return found[0];
}

test("lego is installed only from a pinned version, with its checksum verified before extraction", () => {
  assert.match(triggers, /LEGO_VERSION: v5\.\d+\.\d+/u);
  assert.match(triggers, /LEGO_SHA256: [0-9a-f]{64}/u);
  const install = step("issue", "Install the pinned lego ACME client");
  const verified = install.indexOf("sha256sum --check --strict");
  assert.ok(verified > 0 && verified < install.indexOf("tar -xzf"), "the checksum is checked before the archive is extracted");
  assert.doesNotMatch(install, /\|\|\s*(true|:)/u, "a failed checksum must fail the step");
});

test("every action is pinned to a full commit SHA, and checkout does not persist credentials", () => {
  const uses = [...workflow.matchAll(/uses:\s*(\S+)@(\S+)/gu)];
  assert.ok(uses.length >= 5, "checkout, setup-node and azure/login are all used");
  for (const [, action, reference] of uses) {
    assert.match(reference, /^[0-9a-f]{40}$/u, `${action} must be pinned to a full commit SHA`);
  }
  for (const job of ["plan", "issue"]) {
    assert.match(step(job, "actions/checkout"), /persist-credentials: false/u);
  }
});

test("only the issue job holds the OIDC permission and the environment, and nothing triggers on a pull request", () => {
  assert.match(triggers, /^permissions:\n {2}contents: read\n/mu);
  assert.doesNotMatch(triggers, /id-token|pull_request/u);
  assert.doesNotMatch(jobBlocks.plan, /id-token|environment:/u);
  assert.match(jobBlocks.issue, /id-token: write/u);
  assert.match(jobBlocks.issue, /environment: preview-cert-renewal/u);
});

test("manual runs default to a rehearsal on the Let's Encrypt staging CA, and only renew mode binds", () => {
  assert.match(triggers, /mode:\n[\s\S]*?default: rehearse\n[\s\S]*?force:/u);
  assert.match(triggers, /LETSENCRYPT_STAGING_URL: https:\/\/acme-staging-v02\.api\.letsencrypt\.org\//u);
  assert.match(
    step("issue", "Issue the certificate"),
    /if \[ "\$MODE" = "rehearse" \]; then export LEGO_SERVER="\$LETSENCRYPT_STAGING_URL"; fi/u,
  );
  const binders = stepsOf("issue").filter((candidate) => candidate.includes("hostname bind"));
  assert.equal(binders.length, 2, "one bind and one rollback bind");
  for (const binder of binders) assert.match(binder, /\n {8}if: .*env\.MODE == 'renew'/u, "every bind is renew-only");
  assert.match(
    step("issue", "Upload the certificate under a new name"),
    /if \[ "\$MODE" = "rehearse" \]; then upload_name="\$\{upload_name\}-rehearsal"; fi/u,
  );
});

test("an upload cannot reuse a name an earlier attempt may have bound, and the steps run in a fixed order", () => {
  const upload = step("issue", "Upload the certificate under a new name");
  assert.match(upload, /\$\{CERT_NAME\}-a\$\{GITHUB_RUN_ATTEMPT\}/u);
  assert.match(upload, /already exists; refusing to overwrite/u);
  assert.match(upload, /NEW_CERT_THUMBPRINT=/u);

  const bind = step("issue", "Bind the new certificate");
  assert.match(bind, /id: bind/u);
  assert.match(bind, /--certificate "\$UPLOADED_NAME"/u);
  assert.doesNotMatch(bind, /\$CERT_NAME|PREVIOUS_CERT_NAME/u);

  const remember = step("issue", "Remember the certificate currently bound");
  assert.match(remember, /if \[ -z "\$previous" \]; then .*exit 1; fi/u, "an unreadable current certificate aborts before binding");

  const titles = stepsOf("issue").map(titleOf);
  const order = [
    "Upload the certificate",
    "Remember the certificate currently bound",
    "Bind the new certificate",
    "Verify the public Gateway",
    "Roll back to the previous certificate",
  ].map((prefix) => titles.findIndex((title) => title.startsWith(prefix)));
  assert.ok(order.every((index) => index >= 0), "all five steps exist");
  assert.deepEqual([...order].sort((a, b) => a - b), order, "they run in this order");
});

test("verification is tied to the certificate just uploaded and cannot change what is bound", () => {
  const verify = step("issue", "Verify the public Gateway serves exactly");
  assert.match(verify, /id: verify/u);
  assert.match(verify, /--expect-fingerprint "\$NEW_CERT_THUMBPRINT"/u);
  assert.match(verify, /Invalid preview URL/u);
  assert.doesNotMatch(verify, /hostname bind|--min-days 80/u);
});

test("rollback is its own always-run step that follows a failed, timed-out or cancelled bind", () => {
  const rollback = step("issue", "Roll back to the previous certificate");
  const condition = rollback.match(/\n {8}if: (.*)\n/u)?.[1] ?? "";
  for (const part of ["always()", "env.MODE == 'renew'", "steps.bind.conclusion != 'skipped'", "steps.verify.outcome != 'success'"]) {
    assert.ok(condition.includes(part), `the rollback condition must include ${part}`);
  }
  assert.match(rollback, /--certificate "\$PREVIOUS_CERT_NAME"/u);
  assert.match(rollback, /if \[ -z "\$\{PREVIOUS_CERT_NAME:-\}" \]/u);
});

test("the only certificate deletion is the rehearsal cleanup, and it cannot target the certificate in service", () => {
  const deletions = stepsOf("issue").filter((candidate) => candidate.includes("certificate delete"));
  assert.equal(deletions.length, 1);
  const [cleanup] = deletions;
  assert.match(cleanup, /\n {8}if: always\(\)/u);
  assert.match(cleanup, /\[ "\$MODE" = "rehearse" \] && \[ -n "\$\{UPLOADED_NAME:-\}" \]/u);
  assert.match(cleanup, /--certificate "\$UPLOADED_NAME"/u);
  assert.doesNotMatch(cleanup, /PREVIOUS_CERT_NAME|\$CERT_NAME\b/u);
  assert.match(cleanup, /rm -rf "\$RUNNER_TEMP\/lego"/u, "key material is removed whatever happened before");
});

test("the PFX password is masked and handled only in the three steps that need it", () => {
  assert.match(step("issue", "Generate a one-time PFX password"), /::add-mask::\$password/u);
  assert.match(step("issue", "Issue the certificate"), /LEGO_PFX_PASSWORD: \$\{\{ env\.PFX_PASSWORD \}\}/u);
  const handlers = stepsOf("issue").filter((candidate) => /PFX_PASSWORD/u.test(candidate)).map(titleOf);
  assert.deepEqual(handlers, [
    "Generate a one-time PFX password",
    "Issue the certificate (DNS-01 through Azure DNS)",
    "Upload the certificate under a new name (never overwrites the one in service)",
  ]);
  assert.doesNotMatch(workflow, /set -x|xtrace/u);
  assert.doesNotMatch(workflow, /\b(echo|printf)\b[^\n]*\$\{?PFX_PASSWORD/u);
  assert.doesNotMatch(workflow, /lego run [^\n]*--pfx/u);
});

test("an existing certificate name is accepted only in renew mode and only in the form this workflow creates", () => {
  const validate = step("plan", "Validate the optional existing certificate name");
  assert.match(validate, /\[ "\$INPUT_MODE" != "renew" \]/u, "it requires renew mode");
  const pattern = validate.match(/=~ (\^\S+\$) \]\]/u)?.[1];
  assert.ok(pattern, "the name pattern could be read from the step");
  const accepted = new RegExp(pattern, "u");
  for (const name of [
    "genesisco-preview-wildcard-le",
    "genesisco-preview-wildcard-le-20261020-1007",
    "genesisco-preview-wildcard-le-20261020-1815-a1",
  ]) assert.ok(accepted.test(name), `${name} should be accepted`);
  for (const name of [
    "genesisco-preview-wildcard-le-20261020-1815-a1-rehearsal",
    "genesisco-preview-wildcard-le-2026102-1815",
    "genesisco-preview-wildcard-le-20261020-1815-a",
    "genesisco-preview-wildcard-le; echo pwned",
    "genesisco-preview-wildcard-le\nother",
    "mc-atoms-staging--www-genesisco-io-5985",
    "",
  ]) assert.ok(name === "" || !accepted.test(name), `${JSON.stringify(name)} must be rejected`);
  const decide = step("plan", "Decide from the certificate the public Preview Gateway serves");
  assert.match(decide, /\[ -n "\$EXISTING" \]/u, "binding a named certificate never waits for the renewal window");
});

test("with an existing certificate nothing is issued or uploaded, and the same verification still applies", () => {
  for (const title of [
    "Install the pinned lego ACME client",
    "Generate a one-time PFX password",
    "Issue the certificate",
    "Upload the certificate under a new name",
  ]) {
    assert.match(step("issue", title), /\n {8}if: env\.EXISTING_CERT == ''/u, `${title} is skipped when an existing certificate is named`);
  }
  const existing = step("issue", "Use a certificate already uploaded to the environment");
  assert.match(existing, /\n {8}if: env\.EXISTING_CERT != ''/u);
  assert.match(existing, /\^\[0-9A-Fa-f\]\{40\}\$/u, "the thumbprint must be read from Azure or the step fails");
  assert.match(existing, /UPLOADED_NAME=\$EXISTING_CERT/u);
  assert.match(existing, /NEW_CERT_THUMBPRINT=\$thumbprint/u);
  assert.doesNotMatch(existing, /certificate upload|certificate delete|hostname bind|lego/u, "it only looks the certificate up");

  const titles = stepsOf("issue").map(titleOf);
  const upload = titles.findIndex((title) => title.startsWith("Upload the certificate"));
  const use = titles.findIndex((title) => title.startsWith("Use a certificate already uploaded"));
  const remember = titles.findIndex((title) => title.startsWith("Remember the certificate currently bound"));
  assert.ok(upload >= 0 && upload < use && use < remember, "lookup follows the upload step and precedes the rollback bookkeeping");
});

test("renewals never overlap on a ref, and no Namecheap credential is involved", () => {
  assert.match(
    triggers,
    /concurrency:\n {2}group: preview-cert-renewal-\$\{\{ github\.ref \}\}\n {2}cancel-in-progress: false/u,
  );
  assert.doesNotMatch(workflow, /NAMECHEAP_[A-Z_]+/u);
});

test("the DNS zone is delegated and scoped: one zone, one role assignment, on that zone only", () => {
  assert.match(bicep, /^targetScope = 'resourceGroup'/mu);
  assert.equal(bicep.match(/Microsoft\.Authorization\/roleAssignments@/gu)?.length, 1);
  assert.equal(bicep.match(/Microsoft\.Network\/dnsZones@/gu)?.length, 1);
  assert.match(bicep, /var dnsZoneContributorRoleId = 'befefa01-2a29-4197-83a8-272ff33ce314'/u);
  assert.match(bicep, /scope: acmeZone/u);
  assert.match(
    bicep,
    /roleDefinitionId: subscriptionResourceId\('Microsoft\.Authorization\/roleDefinitions', dnsZoneContributorRoleId\)/u,
  );
  assert.match(bicep, /@allowed\(\[\n {2}'acme\.genesisco\.io'\n\]\)/u);
});
