import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// The least-privilege role for the certificate renewal identity (issue #93). These tests cannot
// prove the role is sufficient: only a real bind with Contributor removed can. They pin what the
// role must never grant, and that it grants what the workflow's `az` commands visibly call.
const read = (path) =>
  readFileSync(new URL(path, import.meta.url), "utf8")
    .replaceAll("\r\n", "\n")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|#)/u.test(line))
    .join("\n");
const bicep = read("../infra/azure/staging/preview-cert-renewal-role.bicep");
const workflow = read("../.github/workflows/preview-cert-renew.yml");

const actionsBlock = bicep.match(/actions: \[\n([\s\S]*?)\n\s*\]\n\s*notActions/u)?.[1] ?? "";
const actions = [...actionsBlock.matchAll(/'([^']+)'/gu)].map((match) => match[1]);

// Every name here appears literally in Microsoft's "Azure permissions for Compute" reference
// (Microsoft.App) or in the DNS Zone Contributor built-in role (resourceGroups/read), except
// managedEnvironments/checkNameAvailability/action: that one was named by Azure's own
// AuthorizationFailed error when the renewal ran without Contributor (2026-10-20).
const VERIFIED_ACTIONS = [
  "Microsoft.App/containerApps/listCustomHostNameAnalysis/action",
  "Microsoft.App/containerApps/read",
  "Microsoft.App/containerApps/write",
  "Microsoft.App/managedEnvironments/certificates/delete",
  "Microsoft.App/managedEnvironments/certificates/read",
  "Microsoft.App/managedEnvironments/certificates/write",
  "Microsoft.App/managedEnvironments/checkNameAvailability/action",
  "Microsoft.App/managedEnvironments/join/action",
  "Microsoft.App/managedEnvironments/read",
  "Microsoft.Resources/subscriptions/resourceGroups/read",
];

test("the role grants exactly the verified actions and nothing else", () => {
  assert.ok(actions.length > 0, "the actions list could be parsed");
  assert.deepEqual([...actions].sort(), VERIFIED_ACTIONS);
});

test("the role has no wildcard, cannot list secrets, and has no data actions or exclusions to hide behind", () => {
  assert.doesNotMatch(actionsBlock, /\*/u);
  assert.ok(!actions.some((action) => /listsecrets/iu.test(action)));
  assert.ok(!actions.some((action) => /\/(delete|write)$/u.test(action) && !/certificates|containerApps\/write/u.test(action)));
  assert.match(bicep, /notActions: \[\]/u);
  assert.match(bicep, /dataActions: \[\]/u);
  assert.match(bicep, /notDataActions: \[\]/u);
});

test("the role is a custom role assignable only in the staging resource group", () => {
  assert.match(bicep, /^targetScope = 'subscription'/mu);
  assert.match(bicep, /type: 'CustomRole'/u);
  assert.match(bicep, /@allowed\(\[\n {2}'atoms-staging-rg'\n\]\)/u);
  assert.match(bicep, /assignableScopes: \[\n {6}'\$\{subscription\(\)\.id\}\/resourceGroups\/\$\{resourceGroupName\}'\n {4}\]/u);
  assert.equal(bicep.match(/Microsoft\.Authorization\/roleDefinitions@/gu)?.length, 1);
  assert.doesNotMatch(bicep, /roleAssignments@/u, "assigning the role is a separate, reviewed step");
});

test("the role covers every Azure call the renewal workflow visibly makes", () => {
  const calls = [
    [/containerapp env certificate upload/u, "Microsoft.App/managedEnvironments/certificates/write"],
    [/containerapp env certificate upload/u, "Microsoft.App/managedEnvironments/checkNameAvailability/action"],
    [/containerapp env certificate delete/u, "Microsoft.App/managedEnvironments/certificates/delete"],
    [/containerapp env certificate list/u, "Microsoft.App/managedEnvironments/certificates/read"],
    [/containerapp hostname list/u, "Microsoft.App/containerApps/read"],
    [/containerapp hostname bind/u, "Microsoft.App/containerApps/write"],
    [/containerapp hostname bind/u, "Microsoft.App/managedEnvironments/join/action"],
  ];
  let checked = 0;
  for (const [pattern, action] of calls) {
    if (!pattern.test(workflow)) continue;
    checked += 1;
    assert.ok(actions.includes(action), `the workflow runs ${String(pattern)} so the role needs ${action}`);
  }
  assert.ok(checked >= 4, "the workflow's az commands were found");
});

test("the workflow makes no other az call that the role would block silently", () => {
  const verbs = new Set([...workflow.matchAll(/\baz ([a-z]+(?: [a-z-]+){0,3})/gu)].map((match) => match[1].split(" ").slice(0, 3).join(" ")));
  for (const verb of verbs) {
    assert.match(
      verb,
      /^containerapp (env certificate|hostname)/u,
      `az ${verb} is not covered by the renewal role; add its action to the role or remove the call`,
    );
  }
});
