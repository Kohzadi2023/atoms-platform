targetScope = 'subscription'

// Least-privilege custom role for the preview wildcard certificate renewal identity (issue #93).
//
// The renewal workflow signs in as a service principal that today holds Contributor on the whole
// staging resource group, which is far more than it uses: it could read every Container App
// secret, reset database credentials, or run commands on the staging VM. This role grants only
// what the workflow's `az` commands call:
//
//   az containerapp env certificate list|upload|delete  -> managedEnvironments + certificates
//   az containerapp hostname list|bind                  -> containerApps read/write, environment
//                                                          join, custom-host-name analysis
//
// Every action below is listed by name in Microsoft's "Azure permissions for Compute" reference.
// There are deliberately NO wildcards: the built-in Container Apps roles use
// `Microsoft.App/containerApps/*/action`, which also grants `listSecrets`.
//
// Not included, because the name could not be verified: the location-level operation-status read
// that Azure Resource Manager may use to poll a long-running bind. If a bind fails with an
// authorization error naming an action, add exactly that action here. See "Narrowing the renewal
// identity's access" in docs/azure-container-apps-preview-staging.md for the safe rollout.
//
// Assigning the role is a separate step (it needs the service principal's object ID), and the
// identity also needs "Managed Identity Operator" on the Gateway's user-assigned identity, because
// updating an app that carries a user-assigned identity requires `assign/action` on that identity.

@description('Resource group the role can be assigned in. The role is not assignable anywhere else.')
@allowed([
  'atoms-staging-rg'
])
param resourceGroupName string = 'atoms-staging-rg'

var roleName = 'Atoms preview certificate renewal'

resource renewalRole 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: guid(subscription().id, roleName)
  properties: {
    roleName: roleName
    description: 'Upload, delete and bind TLS certificates on the Atoms staging Container Apps environment and Preview Gateway. No secret, VM, database or network access.'
    type: 'CustomRole'
    permissions: [
      {
        actions: [
          'Microsoft.App/managedEnvironments/read'
          // Named by an AuthorizationFailed error from the first rehearsal run without Contributor
          // (2026-10-20): `az containerapp env certificate upload` checks the name first.
          'Microsoft.App/managedEnvironments/checkNameAvailability/action'
          'Microsoft.App/managedEnvironments/join/action'
          // Named by an AuthorizationFailed error from the first real bind without Contributor
          // (2026-10-20): `az containerapp hostname bind --certificate <name>` resolves the name
          // through list_certificates, which reads managed certificates as well as uploaded ones.
          'Microsoft.App/managedEnvironments/managedCertificates/read'
          'Microsoft.App/managedEnvironments/certificates/read'
          'Microsoft.App/managedEnvironments/certificates/write'
          'Microsoft.App/managedEnvironments/certificates/delete'
          'Microsoft.App/containerApps/read'
          'Microsoft.App/containerApps/write'
          'Microsoft.App/containerApps/listCustomHostNameAnalysis/action'
          'Microsoft.Resources/subscriptions/resourceGroups/read'
        ]
        notActions: []
        dataActions: []
        notDataActions: []
      }
    ]
    assignableScopes: [
      '${subscription().id}/resourceGroups/${resourceGroupName}'
    ]
  }
}

@description('Role definition ID to assign to the renewal service principal at the resource group scope.')
output roleDefinitionId string = renewalRole.id

@description('Name to pass to `az role assignment create --role`.')
output roleDefinitionName string = roleName
