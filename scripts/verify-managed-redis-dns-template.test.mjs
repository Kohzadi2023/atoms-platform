import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { verifyManagedRedisDnsTemplate } from "./verify-managed-redis-dns-template.mjs";

function fixture() {
  return {
    $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
    parameters: {
      privateEndpointName: { type: "string", minLength: 1 },
      privateDnsZoneResourceGroup: { type: "string", minLength: 1 },
    },
    resources: [{
      type: "Microsoft.Network/privateEndpoints/privateDnsZoneGroups",
      apiVersion: "2024-07-01",
      name: "[format('{0}/{1}', parameters('privateEndpointName'), 'atoms-managed-redis')]",
      properties: {
        privateDnsZoneConfigs: [{
          name: "managed-redis",
          properties: {
            privateDnsZoneId: "[extensionResourceId(format('/subscriptions/{0}/resourceGroups/{1}', subscription().subscriptionId, parameters('privateDnsZoneResourceGroup')), 'Microsoft.Network/privateDnsZones', 'privatelink.redis.azure.net')]",
          },
        }],
      },
    }],
  };
}

test("compiled-template verifier accepts only the existing-resource DNS adoption contract", () => {
  assert.doesNotThrow(() => verifyManagedRedisDnsTemplate(fixture()));
});

for (const [name, mutate] of [
  ["creating Redis", (t) => t.resources.push({ type: "Microsoft.Cache/redisEnterprise" })],
  ["replacing the endpoint", (t) => { t.resources[0].type = "Microsoft.Network/privateEndpoints"; }],
  ["a second zone group", (t) => { t.resources[0].name = "another-group"; }],
  ["a wrong private zone", (t) => { t.resources[0].properties.privateDnsZoneConfigs[0].properties.privateDnsZoneId = "privatelink.redis.cache.windows.net"; }],
  ["a second zone attachment", (t) => t.resources[0].properties.privateDnsZoneConfigs.push({ name: "another" })],
  ["manual A records", (t) => { t.resources[0].resources = [{ type: "Microsoft.Network/privateDnsZones/A" }]; }],
  ["secret parameters", (t) => { t.parameters.REDIS_URL = { type: "secureString" }; }],
  ["metadata outputs", (t) => { t.outputs = { hostname: { type: "string", value: "secret-host" } }; }],
  ["guessed resource selection", (t) => { t.parameters.privateEndpointName.defaultValue = "guessed-pe"; }],
  ["silently skipping adoption", (t) => { t.resources[0].condition = false; }],
  ["changing the deployment scope", (t) => { t.$schema = "https://schema.management.azure.com/schemas/2018-05-01/subscriptionDeploymentTemplate.json#"; }],
  ["overriding the endpoint scope", (t) => { t.resources[0].subscriptionId = "out-of-scope"; }],
]) {
  test(`compiled-template verifier rejects ${name}`, () => {
    const template = fixture();
    mutate(template);
    assert.throws(() => verifyManagedRedisDnsTemplate(template));
  });
}

test("CI compiles and verifies the actual standalone Bicep without deploying it", async () => {
  const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(workflow, /az bicep build --file infra\/azure\/staging\/managed-redis-private-dns\.bicep --outfile/);
  assert.match(workflow, /node scripts\/verify-managed-redis-dns-template\.mjs \/tmp\/atoms-managed-redis-private-dns\.json/);
  const main = await readFile(new URL("../infra/azure/staging/main.bicep", import.meta.url), "utf8");
  assert.equal(main.includes("managed-redis-private-dns.bicep"), false, "do not couple adoption to the VM deployment");
});
