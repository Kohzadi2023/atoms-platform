targetScope = 'subscription'

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

var resourceGroupName = 'atoms-staging-rg'
var commonTags = {
  application: 'atoms-platform'
  environment: 'staging'
  managedBy: 'bicep'
  monthlyBudgetCad: string(monthlyBudgetCad)
  repository: 'Kohzadi2023/atoms-platform'
}

resource stagingResourceGroup 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: resourceGroupName
  location: location
  tags: commonTags
}

module host './host.bicep' = {
  name: 'atoms-staging-host'
  scope: stagingResourceGroup
  params: {
    location: location
    vmSize: vmSize
    adminSshPublicKey: adminSshPublicKey
    sshSourceCidr: sshSourceCidr
    tags: commonTags
  }
}

resource monthlyBudget 'Microsoft.Consumption/budgets@2024-08-01' = {
  name: 'atoms-staging-monthly-cad-80'
  scope: stagingResourceGroup
  properties: {
    amount: monthlyBudgetCad
    category: 'Cost'
    timeGrain: 'Monthly'
    timePeriod: {
      startDate: '${budgetStartDate}T00:00:00Z'
    }
    notifications: {
      Actual_50_Percent: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 50
        thresholdType: 'Actual'
        contactEmails: [
          budgetContactEmail
        ]
        contactGroups: []
        contactRoles: [
          'Owner'
        ]
      }
      Forecasted_80_Percent: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 80
        thresholdType: 'Forecasted'
        contactEmails: [
          budgetContactEmail
        ]
        contactGroups: []
        contactRoles: [
          'Owner'
        ]
      }
      Actual_80_Percent: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 80
        thresholdType: 'Actual'
        contactEmails: [
          budgetContactEmail
        ]
        contactGroups: []
        contactRoles: [
          'Owner'
        ]
      }
      Actual_100_Percent: {
        enabled: true
        operator: 'GreaterThanOrEqualTo'
        threshold: 100
        thresholdType: 'Actual'
        contactEmails: [
          budgetContactEmail
        ]
        contactGroups: []
        contactRoles: [
          'Owner'
        ]
      }
    }
  }
}

output resourceGroupName string = stagingResourceGroup.name
output vmName string = host.outputs.vmName
output hostFqdn string = host.outputs.hostFqdn
output dataDiskName string = host.outputs.dataDiskName
