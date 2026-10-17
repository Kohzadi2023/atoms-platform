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
// pin the properties that make a bad edit dangerous. They do not prove the workflow works.
const workflow = readFileSync(new URL("../.github/workflows/preview-cert-renew.yml", import.meta.url), "utf8");
const bicep = readFileSync(new URL("../infra/azure/staging/preview-acme-dns.bicep", import.meta.url), "utf8");

test("the workflow installs lego only from a pinned version with a pinned checksum", () => {
  assert.match(workflow, /LEGO_VERSION: v5\.\d+\.\d+/);
  assert.match(workflow, /LEGO_SHA256: [0-9a-f]{64}/);
  assert.match(workflow, /sha256sum --check --strict/);
  assert.match(workflow, /azure\/login@[0-9a-f]{40} # v2/);
});

test("only the issue job can request an OIDC token, and the default is read-only", () => {
  const top = workflow.split(/^jobs:/m)[0];
  assert.match(top, /^permissions:\n {2}contents: read\n/m);
  assert.doesNotMatch(top, /id-token/);
  assert.equal(workflow.match(/id-token: write/g)?.length, 1);
  assert.match(workflow, /environment: preview-cert-renewal/);
});

test("manual runs default to a rehearsal against Let's Encrypt staging that binds nothing", () => {
  assert.match(workflow, /mode:[\s\S]*?default: rehearse/);
  assert.match(workflow, /acme-staging-v02\.api\.letsencrypt\.org/);
  assert.match(workflow, /if: env\.MODE == 'renew'\n\s+run: \|\n\s+set -euo pipefail\n\s+az containerapp hostname bind/);
  const rehearsalUpload = workflow.indexOf('upload_name="${CERT_NAME}-rehearsal"');
  assert.ok(rehearsalUpload > 0, "a rehearsal must upload under a throwaway name");
  assert.match(workflow, /az containerapp env certificate delete/);
});

test("a renewal uploads under a new name, binds only after the upload, and can roll back", () => {
  const upload = workflow.indexOf("az containerapp env certificate upload");
  const remember = workflow.indexOf("PREVIOUS_CERT_NAME=");
  const bind = workflow.indexOf("--certificate \"$CERT_NAME\" --validation-method CNAME");
  const rollback = workflow.indexOf("--certificate \"$PREVIOUS_CERT_NAME\" --validation-method CNAME");
  assert.ok(upload > 0 && remember > upload && bind > remember && rollback > bind);
  assert.doesNotMatch(workflow, /certificate delete[^\n]*PREVIOUS_CERT_NAME/);
  assert.match(workflow, /check-preview-cert-expiry\.mjs --min-days 80/);
  assert.match(workflow, /Invalid preview URL/);
});

test("the PFX password is masked, kept out of argv for lego, and key material is removed", () => {
  assert.match(workflow, /::add-mask::\$password/);
  assert.match(workflow, /LEGO_PFX_PASSWORD: \$\{\{ env\.PFX_PASSWORD \}\}/);
  assert.doesNotMatch(workflow, /lego run [^\n]*--pfx/);
  assert.match(workflow, /if: always\(\)\n\s+run: \|\n\s+rm -rf "\$RUNNER_TEMP\/lego"/);
  assert.doesNotMatch(workflow, /\becho\b[^\n]*\$\{?PFX_PASSWORD/);
});

test("renewals never overlap, and no Namecheap credential is involved", () => {
  assert.match(workflow, /concurrency:\n\s+group: preview-cert-renewal\n\s+cancel-in-progress: false/);
  assert.doesNotMatch(workflow, /NAMECHEAP_[A-Z_]+/);
});

test("the DNS zone is delegated and scoped: one zone, one role, no subscription-wide grant", () => {
  assert.match(bicep, /Microsoft\.Network\/dnsZones@/);
  assert.match(bicep, /dnsZoneContributorRoleId = 'befefa01-2a29-4197-83a8-272ff33ce314'/);
  assert.match(bicep, /scope: acmeZone/);
  assert.doesNotMatch(bicep, /targetScope = '(subscription|managementGroup|tenant)'/);
  assert.match(bicep, /@allowed\(\[\n {2}'acme\.genesisco\.io'\n\]\)/);
});
