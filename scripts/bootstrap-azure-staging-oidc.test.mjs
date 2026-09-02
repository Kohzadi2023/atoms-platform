import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AZURE_OIDC_APPLY_CONFIRMATION,
  AZURE_OIDC_PLAN_CONFIRMATION,
  AZURE_STAGING_BOUNDARY,
  AZURE_STAGING_ROLES,
  AZURE_STAGING_SECRET_NAMES,
  bootstrapAzureStagingOidc,
  buildGitHubImmutableOidcArguments,
  buildGitHubSecretArguments,
  buildImmutableSubject,
  buildResourceGroupScope,
  buildRoleAssignmentArguments,
  parseAzureOidcBootstrapArguments,
  validateAzureOidcBootstrapOptions,
} from "./bootstrap-azure-staging-oidc.mjs";

const subscriptionId = "11111111-1111-4111-8111-111111111111";
const tenantId = "22222222-2222-4222-8222-222222222222";
const applicationId = "33333333-3333-4333-8333-333333333333";
const applicationObjectId = "44444444-4444-4444-8444-444444444444";
const principalId = "55555555-5555-4555-8555-555555555555";
const budgetEmail = "private-budget@example.test";
const sshSourceCidr = "203.0.113.42/32";
const sshPublicKey =
  "ssh-ed25519 AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA atoms-staging-test";

function options(overrides = {}) {
  return {
    mode: "plan",
    subscriptionId,
    budgetEmail,
    sshSourceCidr,
    sshKeyPath: "/tmp/atoms-staging-test-key",
    confirmation: AZURE_OIDC_PLAN_CONFIRMATION,
    ...overrides,
  };
}

function application() {
  return {
    id: applicationObjectId,
    appId: applicationId,
    displayName: AZURE_STAGING_BOUNDARY.applicationDisplayName,
    signInAudience: "AzureADMyOrg",
  };
}

function repository() {
  return {
    id: Number(AZURE_STAGING_BOUNDARY.repositoryId),
    full_name: AZURE_STAGING_BOUNDARY.repository,
    owner: { id: Number(AZURE_STAGING_BOUNDARY.ownerId) },
  };
}

async function withSshKey(callback) {
  const directory = await mkdtemp(join(tmpdir(), "atoms-azure-oidc-test-"));
  const keyPath = join(directory, "id_ed25519");
  await writeFile(keyPath, "test-private-key-never-uploaded\n", { mode: 0o600 });
  await writeFile(`${keyPath}.pub`, `${sshPublicKey}\n`, { mode: 0o600 });
  try {
    return await callback(keyPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("builds the pinned immutable environment subject from GitHub numeric IDs", () => {
  assert.equal(
    buildImmutableSubject(),
    "repo:Kohzadi2023@149624604/atoms-platform@1319803321:environment:phase3-staging",
  );
});

test("accepts only an explicit subscription, narrow SSH source, and exact acknowledgement", () => {
  assert.deepEqual(validateAzureOidcBootstrapOptions(options()), {
    ok: true,
    violations: [],
  });

  const sensitiveEmail = "do-not-print@example.test";
  const sensitiveCidr = "198.51.100.0/16";
  const result = validateAzureOidcBootstrapOptions(
    options({
      mode: "apply",
      subscriptionId: "current",
      budgetEmail: sensitiveEmail,
      sshSourceCidr: sensitiveCidr,
      confirmation: AZURE_OIDC_PLAN_CONFIRMATION,
    }),
  );
  const output = JSON.stringify(result);

  assert.equal(result.ok, false);
  assert.match(output, /explicit UUID/u);
  assert.match(output, /apply acknowledgement/u);
  assert.match(output, /between \/24 and \/32/u);
  assert.doesNotMatch(output, new RegExp(sensitiveEmail, "u"));
  assert.doesNotMatch(output, new RegExp(sensitiveCidr.replace("/", "\\/"), "u"));
});

test("normalizes the CLI key path and rejects duplicate or unknown options", () => {
  const parsed = parseAzureOidcBootstrapArguments([
    "--mode",
    "plan",
    "--subscription-id",
    subscriptionId,
    "--budget-email",
    budgetEmail,
    "--ssh-source-cidr",
    sshSourceCidr,
    "--ssh-key-path",
    "./operator-key",
    "--confirmation",
    AZURE_OIDC_PLAN_CONFIRMATION,
  ]);
  assert.equal(parsed.sshKeyPath.endsWith("/operator-key"), true);

  assert.throws(
    () =>
      parseAzureOidcBootstrapArguments([
        "--mode",
        "plan",
        "--mode",
        "apply",
      ]),
    /may be supplied only once/u,
  );
  assert.throws(
    () => parseAzureOidcBootstrapArguments(["--unexpected", "value"]),
    /Unknown Azure OIDC bootstrap argument/u,
  );
});

test("builds every Azure role assignment at resource-group scope only", () => {
  const scope = buildResourceGroupScope(subscriptionId);
  assert.equal(
    scope,
    `/subscriptions/${subscriptionId}/resourceGroups/atoms-staging-rg`,
  );

  for (const role of AZURE_STAGING_ROLES) {
    const arguments_ = buildRoleAssignmentArguments({
      principalId,
      roleId: role.id,
      scope,
    });
    assert.equal(arguments_[arguments_.indexOf("--scope") + 1], scope);
    assert.equal(arguments_.includes("LogiCount-RG"), false);
  }
  assert.throws(
    () =>
      buildRoleAssignmentArguments({
        principalId,
        roleId: AZURE_STAGING_ROLES[0].id,
        scope: `/subscriptions/${subscriptionId}`,
      }),
    /scoped to atoms-staging-rg/u,
  );
});

test("enables immutable GitHub subjects and permits only the six environment secret names", () => {
  const oidcArguments = buildGitHubImmutableOidcArguments();
  assert.equal(oidcArguments.includes("use_immutable_subject=true"), true);
  assert.equal(
    oidcArguments.includes(
      `repos/${AZURE_STAGING_BOUNDARY.repository}/actions/oidc/customization/sub`,
    ),
    true,
  );

  for (const name of AZURE_STAGING_SECRET_NAMES) {
    const arguments_ = buildGitHubSecretArguments(name);
    assert.equal(arguments_.includes(AZURE_STAGING_BOUNDARY.environment), true);
    assert.equal(arguments_.includes(AZURE_STAGING_BOUNDARY.repository), true);
  }
  assert.throws(
    () => buildGitHubSecretArguments("AZURE_CLIENT_SECRET"),
    /Unexpected GitHub Environment secret name/u,
  );
});

test("keeps both the Bicep template and workflow at dedicated resource-group scope", async () => {
  const [template, workflow] = await Promise.all([
    readFile(new URL("../infra/azure/staging/main.bicep", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/azure-staging-host.yml", import.meta.url), "utf8"),
  ]);

  assert.match(template, /targetScope = 'resourceGroup'/u);
  assert.doesNotMatch(template, /Microsoft\.Resources\/resourceGroups/u);
  assert.match(workflow, /AZURE_STAGING_RESOURCE_GROUP: atoms-staging-rg/u);
  assert.match(workflow, /az deployment group what-if/u);
  assert.match(workflow, /az deployment group create/u);
  assert.doesNotMatch(workflow, /az deployment sub/u);
  assert.doesNotMatch(`${template}\n${workflow}`, /LogiCount/iu);
});

test("plan mode reads pinned state but performs no Azure or GitHub mutation", async () => {
  await withSshKey(async (keyPath) => {
    const calls = [];
    const logs = [];
    const run = (command, arguments_, runOptions = {}) => {
      calls.push({ command, arguments_, runOptions });
      const joined = `${command} ${arguments_.join(" ")}`;
      if (joined === "az account show --output json") {
        return JSON.stringify({ id: subscriptionId, tenantId, state: "Enabled" });
      }
      if (joined === `gh api repos/${AZURE_STAGING_BOUNDARY.repository}`) {
        return JSON.stringify(repository());
      }
      if (joined === "az group exists --name atoms-staging-rg --output tsv") {
        return "false";
      }
      if (
        joined ===
        `az ad app list --display-name ${AZURE_STAGING_BOUNDARY.applicationDisplayName} --output json`
      ) {
        return "[]";
      }
      if (joined.includes("actions/oidc/customization/sub")) {
        return JSON.stringify({ use_default: true, use_immutable_subject: false });
      }
      if (joined.includes("gh secret list")) return "[]";
      return "";
    };

    const result = await bootstrapAzureStagingOidc(
      options({ sshKeyPath: keyPath }),
      { run, log: (message) => logs.push(message) },
    );

    assert.deepEqual(result, {
      mode: "plan",
      scope: buildResourceGroupScope(subscriptionId),
      changed: false,
    });
    const commands = calls.map(({ command, arguments_ }) => `${command} ${arguments_.join(" ")}`);
    assert.equal(commands.some((command) => /group create/u.test(command)), false);
    assert.equal(commands.some((command) => /role assignment create/u.test(command)), false);
    assert.equal(commands.some((command) => /secret set/u.test(command)), false);
    assert.equal(commands.some((command) => /federated-credential create/u.test(command)), false);
    assert.match(logs.join("\n"), /no Azure or GitHub state was changed/u);
  });
});

test("refuses to adopt an existing resource group without exact ownership tags", async () => {
  await withSshKey(async (keyPath) => {
    const run = (command, arguments_) => {
      const joined = `${command} ${arguments_.join(" ")}`;
      if (joined === "az account show --output json") {
        return JSON.stringify({ id: subscriptionId, tenantId, state: "Enabled" });
      }
      if (joined === `gh api repos/${AZURE_STAGING_BOUNDARY.repository}`) {
        return JSON.stringify(repository());
      }
      if (joined === "az group exists --name atoms-staging-rg --output tsv") {
        return "True";
      }
      if (joined === "az group show --name atoms-staging-rg --output json") {
        return JSON.stringify({
          name: AZURE_STAGING_BOUNDARY.resourceGroup,
          location: AZURE_STAGING_BOUNDARY.location,
          tags: {
            application: "atoms-platform",
            environment: "staging",
            managedBy: "oidc-bootstrap",
            repository: "someone-else/atoms-platform",
          },
        });
      }
      return "";
    };

    await assert.rejects(
      bootstrapAzureStagingOidc(options({ sshKeyPath: keyPath }), {
        run,
        log: () => {},
      }),
      /outside the pinned ownership boundary/u,
    );
  });
});

test("apply mode creates only control-plane OIDC state and sends secret values over stdin", async () => {
  await withSshKey(async (keyPath) => {
    const calls = [];
    const logs = [];
    const run = (command, arguments_, runOptions = {}) => {
      calls.push({ command, arguments_, runOptions });
      const joined = `${command} ${arguments_.join(" ")}`;
      if (joined === "az account show --output json") {
        return JSON.stringify({ id: subscriptionId, tenantId, state: "Enabled" });
      }
      if (joined === `gh api repos/${AZURE_STAGING_BOUNDARY.repository}`) {
        return JSON.stringify(repository());
      }
      if (joined === "az group exists --name atoms-staging-rg --output tsv") {
        return "false";
      }
      if (
        joined ===
        `az ad app list --display-name ${AZURE_STAGING_BOUNDARY.applicationDisplayName} --output json`
      ) {
        return "[]";
      }
      if (joined.includes("az ad app create")) return JSON.stringify(application());
      if (joined.includes("az ad sp list")) return "[]";
      if (joined.includes("az ad sp create")) {
        return JSON.stringify({ id: principalId, appId: applicationId });
      }
      if (joined.includes("az ad app federated-credential list")) return "[]";
      if (joined.includes("actions/oidc/customization/sub") && !joined.includes("PUT")) {
        return JSON.stringify({ use_default: true, use_immutable_subject: true });
      }
      if (joined.includes("az role assignment list")) return "[]";
      if (joined.includes("gh secret list")) {
        return JSON.stringify(AZURE_STAGING_SECRET_NAMES.map((name) => ({ name })));
      }
      return "";
    };

    const result = await bootstrapAzureStagingOidc(
      options({
        mode: "apply",
        sshKeyPath: keyPath,
        confirmation: AZURE_OIDC_APPLY_CONFIRMATION,
      }),
      { run, log: (message) => logs.push(message) },
    );

    assert.equal(result.changed, true);
    const commands = calls.map(({ command, arguments_ }) => `${command} ${arguments_.join(" ")}`);
    assert.equal(commands.some((command) => /deployment (?:sub|group) create/u.test(command)), false);
    assert.equal(commands.some((command) => /\bvm\b|\bdisk\b|public-ip/iu.test(command)), false);
    assert.equal(commands.some((command) => /LogiCount/iu.test(command)), false);

    const roleCreates = calls.filter(
      ({ command, arguments_ }) =>
        command === "az" && arguments_.slice(0, 3).join(" ") === "role assignment create",
    );
    assert.equal(roleCreates.length, AZURE_STAGING_ROLES.length);
    for (const call of roleCreates) {
      assert.equal(
        call.arguments_[call.arguments_.indexOf("--scope") + 1],
        buildResourceGroupScope(subscriptionId),
      );
    }

    const secretSets = calls.filter(
      ({ command, arguments_ }) => command === "gh" && arguments_[0] === "secret" && arguments_[1] === "set",
    );
    assert.equal(secretSets.length, AZURE_STAGING_SECRET_NAMES.length);
    for (const call of secretSets) {
      assert.equal(call.arguments_.includes(budgetEmail), false);
      assert.equal(call.arguments_.includes(sshSourceCidr), false);
      assert.equal(call.arguments_.includes(sshPublicKey), false);
      assert.equal(typeof call.runOptions.input, "string");
    }
    assert.doesNotMatch(logs.join("\n"), new RegExp(budgetEmail, "u"));
    assert.doesNotMatch(logs.join("\n"), new RegExp(sshSourceCidr.replace("/", "\\/"), "u"));
    assert.match(logs.join("\n"), /no VM, disk, IP, or domain was created/u);
  });
});
