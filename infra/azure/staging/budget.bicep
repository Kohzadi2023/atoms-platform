@description('Approved monthly Azure staging budget in the subscription billing currency (CAD).')
@minValue(80)
@maxValue(80)
param monthlyBudgetCad int

@description('Email address that receives the dedicated resource-group budget alerts.')
@secure()
param budgetContactEmail string

@description('First day of the current budget month.')
param budgetStartDate string

resource monthlyBudget 'Microsoft.Consumption/budgets@2024-08-01' = {
  name: 'atoms-staging-monthly-cad-80'
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
