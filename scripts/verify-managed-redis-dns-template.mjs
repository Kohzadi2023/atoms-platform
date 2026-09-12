import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

// Verify the compiled ARM template, not only Bicep source text. Compilation and
// this verifier are read-only CI steps: neither logs into nor deploys to Azure.
export function verifyManagedRedisDnsTemplate(template) {
  assert.equal(template.$schema, "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#", "only resource-group deployments are supported");
  assert.equal(template.languageVersion, undefined, "use the standard ARM resource-array template");
  assert.deepEqual(Object.keys(template.parameters).sort(), [
    "privateDnsZoneResourceGroup",
    "privateEndpointName",
  ]);
  for (const parameter of Object.values(template.parameters)) {
    assert.equal(parameter.type, "string");
    assert.equal(parameter.minLength, 1);
    assert.equal(parameter.defaultValue, undefined, "require explicit existing-resource selection");
  }
  assert.equal(Object.keys(template.outputs ?? {}).length, 0, "do not output Redis metadata or secrets");
  assert.equal(Object.keys(template.variables ?? {}).length, 0);
  assert.ok(Array.isArray(template.resources));
  assert.equal(template.resources.length, 1, "only the DNS zone group may be written");
  const [resource] = template.resources;
  assert.deepEqual(Object.keys(resource).sort(), ["apiVersion", "name", "properties", "type"], "no scope override, nested resources, or additional mutations");
  assert.equal(resource.type, "Microsoft.Network/privateEndpoints/privateDnsZoneGroups");
  assert.equal(resource.apiVersion, "2024-07-01");
  assert.equal(resource.name, "[format('{0}/{1}', parameters('privateEndpointName'), 'atoms-managed-redis')]");
  assert.equal(resource.condition, undefined, "do not silently omit the repair");
  assert.deepEqual(Object.keys(resource.properties), ["privateDnsZoneConfigs"]);
  assert.deepEqual(resource.properties.privateDnsZoneConfigs, [{
    name: "managed-redis",
    properties: {
      privateDnsZoneId: "[extensionResourceId(format('/subscriptions/{0}/resourceGroups/{1}', subscription().subscriptionId, parameters('privateDnsZoneResourceGroup')), 'Microsoft.Network/privateDnsZones', 'privatelink.redis.azure.net')]",
    },
  }]);
  assert.equal(resource.resources, undefined, "no nested endpoint, DNS, or deployment mutations");
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(process.argv.length, 3, "usage: node scripts/verify-managed-redis-dns-template.mjs <compiled-template.json>");
  verifyManagedRedisDnsTemplate(JSON.parse(await readFile(process.argv[2], "utf8")));
  console.log("Managed Redis DNS template verified: one zone group, existing PE/zone, no other resource writes");
}
