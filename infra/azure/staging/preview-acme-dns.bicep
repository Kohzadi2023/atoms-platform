targetScope = 'resourceGroup'

// Delegated DNS zone that answers Let's Encrypt DNS-01 challenges for the
// *.preview.genesisco.io wildcard certificate (issue #93).
//
// genesisco.io stays at Namecheap. Only two records are added there, once:
//   NS    acme                 -> the four name servers this template outputs
//   CNAME _acme-challenge.preview -> preview.<zoneName>
// Let's Encrypt follows the CNAME, so the renewal workflow writes its TXT
// challenge into this zone and never needs a Namecheap credential. No existing
// record is moved, so a mistake here cannot take the site or the API offline.

@description('Delegated zone that holds only ACME challenge records. A child of the registered domain, delegated by NS records at Namecheap.')
@allowed([
  'acme.genesisco.io'
])
param zoneName string = 'acme.genesisco.io'

@description('Object (principal) ID of the identity the renewal workflow signs in as. Receives DNS Zone Contributor on this zone only.')
param renewalPrincipalId string

// DNS Zone Contributor. https://learn.microsoft.com/azure/role-based-access-control/built-in-roles/networking#dns-zone-contributor
var dnsZoneContributorRoleId = 'befefa01-2a29-4197-83a8-272ff33ce314'

resource acmeZone 'Microsoft.Network/dnsZones@2018-05-01' = {
  name: zoneName
  location: 'global'
  tags: {
    project: 'atoms'
    environment: 'staging'
    purpose: 'preview-wildcard-acme-dns01'
  }
}

resource renewalCanEditZone 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acmeZone.id, renewalPrincipalId, dnsZoneContributorRoleId)
  scope: acmeZone
  properties: {
    principalId: renewalPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', dnsZoneContributorRoleId)
  }
}

@description('Name servers to enter at Namecheap as NS records for the host "acme".')
output nameServers array = acmeZone.properties.nameServers
