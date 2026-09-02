targetScope = 'resourceGroup'

@description('Azure region selected for the dedicated Atoms staging host.')
@allowed([
  'canadacentral'
])
param location string = 'canadacentral'

@description('Cost-bounded VM size approved for the single-host staging stack.')
@allowed([
  'Standard_B2s_v2'
])
param vmSize string = 'Standard_B2s_v2'

@description('Non-root Linux administrator created on the dedicated staging VM.')
@allowed([
  'atomsadmin'
])
param adminUsername string = 'atomsadmin'

@description('SSH public key installed for the non-root VM administrator.')
@secure()
param adminSshPublicKey string

@description('Narrow IPv4 CIDR allowed to reach TCP 22. The workflow rejects prefixes broader than /24.')
@secure()
param sshSourceCidr string

@description('Email address that receives the dedicated resource-group budget alerts.')
@secure()
param budgetContactEmail string

@description('First day of the current budget month, generated at deployment time.')
param budgetStartDate string = utcNow('yyyy-MM-01')

@description('Approved monthly Azure staging budget in the subscription billing currency (CAD).')
@minValue(80)
@maxValue(80)
param monthlyBudgetCad int = 80

var commonTags = {
  application: 'atoms-platform'
  environment: 'staging'
  managedBy: 'bicep'
  monthlyBudgetCad: string(monthlyBudgetCad)
  repository: 'Kohzadi2023/atoms-platform'
}

module host './host.bicep' = {
  name: 'atoms-staging-host'
  params: {
    location: location
    vmSize: vmSize
    adminUsername: adminUsername
    adminSshPublicKey: adminSshPublicKey
    sshSourceCidr: sshSourceCidr
    tags: commonTags
  }
}

module budget './budget.bicep' = {
  name: 'atoms-staging-budget'
  params: {
    monthlyBudgetCad: monthlyBudgetCad
    budgetContactEmail: budgetContactEmail
    budgetStartDate: budgetStartDate
  }
}

output resourceGroupName string = resourceGroup().name
output vmName string = host.outputs.vmName
output hostFqdn string = host.outputs.hostFqdn
output dataDiskName string = host.outputs.dataDiskName
