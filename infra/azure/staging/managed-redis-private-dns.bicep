targetScope = 'resourceGroup'

// Standalone adoption of the one persistent child resource created by the v12
// staging repair. Do not include this in the VM-host deployment main.bicep.
// Deploy incrementally to the existing Redis private endpoint's resource group.
@description('Name of the existing, approved Managed Redis private endpoint verified by the staging reconciliation gate. No endpoint is created or updated.')
@minLength(1)
param privateEndpointName string

@description('Resource group containing the existing privatelink.redis.azure.net zone and its existing Container Apps VNet link, in the deployment subscription.')
@minLength(1)
param privateDnsZoneResourceGroup string

resource privateEndpoint 'Microsoft.Network/privateEndpoints@2024-07-01' existing = {
  name: privateEndpointName
}

resource managedRedisPrivateZone 'Microsoft.Network/privateDnsZones@2024-06-01' existing = {
  scope: resourceGroup(privateDnsZoneResourceGroup)
  name: 'privatelink.redis.azure.net'
}

// Match v12's names to adopt its zone group instead of creating a second group.
// Azure owns the endpoint A records. No manual A records or VNet links here.
// https://learn.microsoft.com/azure/templates/microsoft.network/privateendpoints/privatednszonegroups
resource managedRedisZoneGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-07-01' = {
  parent: privateEndpoint
  name: 'atoms-managed-redis'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'managed-redis'
        properties: {
          privateDnsZoneId: managedRedisPrivateZone.id
        }
      }
    ]
  }
}
