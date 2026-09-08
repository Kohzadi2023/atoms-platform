[CmdletBinding()]
param()

Clear-Host
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$ExpectedSubscriptionId = "2ac8ed24-166b-4325-89dc-829d64391ce9"
$ForbiddenSubscriptionId = "bbcaf423-9a71-43bc-9fc7-821ef012cd01"
$ExpectedExternalTenantId = "1dda8889-b5fc-43eb-857b-b1549e4b82c3"
$ExpectedExternalTenantDomain = "atomsstaging91ce9.onmicrosoft.com"
$ExpectedWebClientId = "3be3b7af-17db-4a00-8448-04ba55fa76f0"
$ExpectedApiClientId = "4299c3fb-7ce1-4d23-bd49-26c554b08dac"
$ExpectedApiScope = "api://4299c3fb-7ce1-4d23-bd49-26c554b08dac/access_as_user"
$UserFlowDisplayName = "atoms-staging-sign-up-sign-in"

$StateDirectory = Join-Path $env:USERPROFILE ".atoms"
$AppsStateFile = Join-Path $StateDirectory "entra-staging-apps.json"
$UserFlowStateFile = Join-Path $StateDirectory "entra-staging-user-flow.json"
$env:AZURE_CONFIG_DIR = "$env:USERPROFILE\.azure-atoms"

$TranscriptPath = Join-Path $env:TEMP (
    "atoms-entra-user-flow-bootstrap-" + [Guid]::NewGuid().ToString("N") + ".log"
)
$TranscriptStarted = $false
$GraphConnected = $false

function Write-Step {
    param([Parameter(Mandatory)][string]$Message)
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Ok {
    param([Parameter(Mandatory)][string]$Message)
    Write-Host "    OK: $Message" -ForegroundColor Green
}

function Get-AzCommand {
    $az = Get-Command az.cmd -ErrorAction SilentlyContinue
    if ($null -eq $az) {
        $az = Get-Command az -ErrorAction SilentlyContinue
    }
    if ($null -eq $az) {
        throw "Azure CLI was not found."
    }
    return $az.Source
}

function Invoke-AzCapture {
    param([Parameter(Mandatory)][string[]]$Arguments)

    $az = Get-AzCommand
    $output = & $az @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "az $($Arguments -join ' ') failed.`n$($output -join "`n")"
    }
    return (($output | ForEach-Object { "$_" }) -join "`n").Trim()
}

function Assert-AtomsSubscription {
    Write-Step "Lock Azure CLI to the dedicated Atoms-Staging subscription"

    $az = Get-AzCommand
    & $az account set --subscription $ExpectedSubscriptionId
    if ($LASTEXITCODE -ne 0) {
        throw "Could not select the dedicated Atoms-Staging subscription."
    }

    $accountJson = Invoke-AzCapture -Arguments @(
        "account", "show",
        "--output", "json",
        "--only-show-errors"
    )
    $account = $accountJson | ConvertFrom-Json

    if ([string]$account.id -eq $ForbiddenSubscriptionId) {
        throw "Refusing to continue: the forbidden legacy subscription is active."
    }
    if ([string]$account.id -ne $ExpectedSubscriptionId) {
        throw "Unexpected active subscription '$($account.id)'."
    }

    Write-Ok "Subscription locked to Atoms-Staging ($ExpectedSubscriptionId)"
}

function Assert-AppState {
    Write-Step "Validate the verified Entra staging application state"

    if (-not (Test-Path -LiteralPath $AppsStateFile)) {
        throw "Missing Entra application state: $AppsStateFile"
    }

    $state = Get-Content -LiteralPath $AppsStateFile -Raw | ConvertFrom-Json

    if ([string]$state.subscriptionId -eq $ForbiddenSubscriptionId) {
        throw "Refusing to continue: Entra state references the forbidden legacy subscription."
    }
    if ([string]$state.subscriptionId -ne $ExpectedSubscriptionId) {
        throw "Entra state contains an unexpected subscription."
    }
    if ([string]$state.tenantId -ne $ExpectedExternalTenantId) {
        throw "Entra state contains an unexpected External Tenant ID."
    }
    if ([string]$state.domainName -ne $ExpectedExternalTenantDomain) {
        throw "Entra state contains an unexpected External Tenant domain."
    }
    if ([string]$state.web.clientId -ne $ExpectedWebClientId) {
        throw "Entra state contains an unexpected Web application client ID."
    }
    if ([string]$state.controlApi.clientId -ne $ExpectedApiClientId) {
        throw "Entra state contains an unexpected Control API client ID."
    }
    if ([string]$state.controlApi.scope -ne $ExpectedApiScope) {
        throw "Entra state contains an unexpected Control API delegated scope."
    }
    if ($state.adminConsentGranted -ne $true) {
        throw "Tenant-wide Web -> Control API delegated consent is not recorded as granted."
    }

    Write-Ok "Tenant, applications, scope, and admin consent match the verified staging state"
}

function Ensure-GraphAuthenticationModule {
    Write-Step "Ensure Microsoft Graph authentication tooling"

    $module = Get-Module -ListAvailable Microsoft.Graph.Authentication |
        Sort-Object Version -Descending |
        Select-Object -First 1

    if ($null -eq $module) {
        Write-Host "    Microsoft.Graph.Authentication is not installed; installing for CurrentUser." -ForegroundColor Yellow
        Install-Module Microsoft.Graph.Authentication `
            -Scope CurrentUser `
            -Repository PSGallery `
            -Force `
            -AllowClobber
    }

    Import-Module Microsoft.Graph.Authentication -ErrorAction Stop
    Write-Ok "Microsoft.Graph.Authentication is available"
}

function Connect-AtomsExternalGraph {
    Write-Step "Authenticate Microsoft Graph to the Atoms External Tenant"

    Connect-MgGraph `
        -TenantId $ExpectedExternalTenantId `
        -Scopes "EventListener.ReadWrite.All" `
        -NoWelcome

    $script:GraphConnected = $true
    $context = Get-MgContext

    if ($null -eq $context) {
        throw "Microsoft Graph context is unavailable after sign-in."
    }
    if ([string]$context.TenantId -ne $ExpectedExternalTenantId) {
        throw "Microsoft Graph tenant mismatch. Expected '$ExpectedExternalTenantId', got '$($context.TenantId)'."
    }

    $scopes = @($context.Scopes)
    if ($scopes -notcontains "EventListener.ReadWrite.All") {
        throw "Microsoft Graph did not grant EventListener.ReadWrite.All."
    }

    Write-Ok "Microsoft Graph is scoped to the verified Atoms External Tenant"
}

function Invoke-GraphJson {
    param(
        [Parameter(Mandatory)][ValidateSet("GET","POST","PATCH")][string]$Method,
        [Parameter(Mandatory)][string]$Uri,
        [object]$Body
    )

    if ($PSBoundParameters.ContainsKey("Body")) {
        $json = $Body | ConvertTo-Json -Depth 20 -Compress
        return Invoke-MgGraphRequest `
            -Method $Method `
            -Uri $Uri `
            -Body $json `
            -ContentType "application/json" `
            -OutputType PSObject
    }

    return Invoke-MgGraphRequest `
        -Method $Method `
        -Uri $Uri `
        -OutputType PSObject
}

function Get-UserFlows {
    $response = Invoke-GraphJson `
        -Method GET `
        -Uri "https://graph.microsoft.com/v1.0/identity/authenticationEventsFlows"

    if ($null -eq $response -or $null -eq $response.value) {
        return @()
    }

    return @($response.value)
}

function Ensure-UserFlow {
    Write-Step "Create or reuse the Atoms customer sign-up/sign-in user flow"

    $flows = @(Get-UserFlows)
    $matches = @(
        $flows |
            Where-Object { [string]$_.displayName -eq $UserFlowDisplayName }
    )

    if ($matches.Count -gt 1) {
        throw "More than one user flow named '$UserFlowDisplayName' exists. Refusing to guess."
    }

    if ($matches.Count -eq 1) {
        $flow = $matches[0]
        Write-Ok "Reusing user flow: $UserFlowDisplayName"
    }
    else {
        # Request shape follows the Microsoft Graph v1.0 External ID
        # authenticationEventsFlow create example with an attached application.
        $body = @{
            "@odata.type" = "#microsoft.graph.externalUsersSelfServiceSignUpEventsFlow"
            displayName = $UserFlowDisplayName
            conditions = @{
                applications = @{
                    includeApplications = @(
                        @{
                            appId = $ExpectedWebClientId
                        }
                    )
                }
            }
            onAuthenticationMethodLoadStart = @{
                "@odata.type" = "#microsoft.graph.onAuthenticationMethodLoadStartExternalUsersSelfServiceSignUp"
                identityProviders = @(
                    @{
                        id = "EmailPassword-OAUTH"
                    }
                )
            }
            onInteractiveAuthFlowStart = @{
                "@odata.type" = "#microsoft.graph.onInteractiveAuthFlowStartExternalUsersSelfServiceSignUp"
                isSignUpAllowed = $true
            }
            onAttributeCollection = @{
                "@odata.type" = "#microsoft.graph.onAttributeCollectionExternalUsersSelfServiceSignUp"
                attributes = @(
                    @{
                        id = "email"
                        displayName = "Email Address"
                        description = "Email address of the user"
                        userFlowAttributeType = "builtIn"
                        dataType = "string"
                    },
                    @{
                        id = "displayName"
                        displayName = "Display Name"
                        description = "Display Name of the user"
                        userFlowAttributeType = "builtIn"
                        dataType = "string"
                    }
                )
                attributeCollectionPage = @{
                    views = @(
                        @{
                            inputs = @(
                                @{
                                    attribute = "email"
                                    label = "Email Address"
                                    inputType = "Text"
                                    hidden = $true
                                    editable = $false
                                    writeToDirectory = $true
                                    required = $true
                                    validationRegEx = "^[a-zA-Z0-9.!#$%&'*+/=?^_``{|}~-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*$"
                                },
                                @{
                                    attribute = "displayName"
                                    label = "Display Name"
                                    inputType = "Text"
                                    hidden = $false
                                    editable = $true
                                    writeToDirectory = $true
                                    required = $false
                                    validationRegEx = "^[a-zA-Z_][0-9a-zA-Z_ ]*[0-9a-zA-Z_]+$"
                                }
                            )
                        }
                    )
                }
            }
        }

        $flow = Invoke-GraphJson `
            -Method POST `
            -Uri "https://graph.microsoft.com/v1.0/identity/authenticationEventsFlows" `
            -Body $body

        Write-Ok "Created user flow: $UserFlowDisplayName"
    }

    $flowId = [string]$flow.id
    if ($flowId -notmatch "^[0-9a-fA-F-]{36}$") {
        throw "User flow did not return a valid ID."
    }

    Write-Step "Verify Web application association"

    $applicationsResponse = Invoke-GraphJson `
        -Method GET `
        -Uri "https://graph.microsoft.com/v1.0/identity/authenticationEventsFlows/$flowId/conditions/applications/includeApplications"

    $linkedApps = if ($null -eq $applicationsResponse -or $null -eq $applicationsResponse.value) {
        @()
    }
    else {
        @($applicationsResponse.value)
    }

    $isLinked = @(
        $linkedApps |
            Where-Object { [string]$_.appId -eq $ExpectedWebClientId }
    ).Count -eq 1

    if (-not $isLinked) {
        $linkBody = @{
            "@odata.type" = "#microsoft.graph.authenticationConditionApplication"
            appId = $ExpectedWebClientId
        }

        Invoke-GraphJson `
            -Method POST `
            -Uri "https://graph.microsoft.com/v1.0/identity/authenticationEventsFlows/$flowId/conditions/applications/includeApplications" `
            -Body $linkBody | Out-Null

        Write-Ok "Associated atoms-staging-web with the user flow"
    }
    else {
        Write-Ok "atoms-staging-web is already associated with the user flow"
    }

    return $flowId
}

function Save-UserFlowState {
    param([Parameter(Mandatory)][string]$FlowId)

    Write-Step "Save non-secret user flow state"

    New-Item -ItemType Directory -Path $StateDirectory -Force | Out-Null

    [ordered]@{
        subscriptionId = $ExpectedSubscriptionId
        tenantId = $ExpectedExternalTenantId
        tenantDomain = $ExpectedExternalTenantDomain
        displayName = $UserFlowDisplayName
        id = $FlowId
        webClientId = $ExpectedWebClientId
        apiClientId = $ExpectedApiClientId
        apiScope = $ExpectedApiScope
        identityProvider = "EmailPassword-OAUTH"
        signUpAllowed = $true
        graphApiVersion = "v1.0"
        generatedAt = (Get-Date).ToString("o")
    } |
        ConvertTo-Json -Depth 8 |
        Set-Content -LiteralPath $UserFlowStateFile -Encoding utf8NoBOM

    Write-Ok "User flow state saved: $UserFlowStateFile"
}

try {
    Start-Transcript -Path $TranscriptPath -Force | Out-Null
    $TranscriptStarted = $true

    Write-Host "Atoms Entra External User Flow Bootstrap v1" -ForegroundColor DarkGray

    Assert-AtomsSubscription
    Assert-AppState
    Ensure-GraphAuthenticationModule
    Connect-AtomsExternalGraph

    $flowId = Ensure-UserFlow
    Save-UserFlowState -FlowId $flowId

    Write-Host ""
    Write-Host "Atoms Entra External ID user flow is ready" -ForegroundColor Green
    Write-Host "  Tenant          : $ExpectedExternalTenantDomain"
    Write-Host "  User flow       : $UserFlowDisplayName"
    Write-Host "  User flow ID    : $flowId"
    Write-Host "  Web Client ID   : $ExpectedWebClientId"
    Write-Host "  API Scope       : $ExpectedApiScope"
    Write-Host "  Identity method : Email + password"
    Write-Host "  Graph API       : v1.0"
    Write-Host ""
    Write-Host "Next: cut the staging Control API + Web runtime configuration over to these verified Entra values, then perform a real browser sign-up/sign-in smoke." -ForegroundColor Cyan
}
finally {
    if ($GraphConnected) {
        try {
            Disconnect-MgGraph | Out-Null
        }
        catch {
            Write-Warning "Could not disconnect Microsoft Graph cleanly."
        }
    }

    # Reassert the dedicated staging subscription even if Graph bootstrap fails.
    try {
        $az = Get-AzCommand
        & $az account set --subscription $ExpectedSubscriptionId 2>$null
        if ($LASTEXITCODE -eq 0) {
            $activeId = (& $az account show --query id --output tsv --only-show-errors 2>$null).Trim()
            if ($activeId -eq $ForbiddenSubscriptionId) {
                throw "Forbidden legacy subscription became active."
            }
            if ($activeId -eq $ExpectedSubscriptionId) {
                Write-Ok "Azure CLI remains locked to Atoms-Staging"
            }
        }
    }
    catch {
        Write-Warning "Could not reassert Atoms-Staging Azure CLI context: $($_.Exception.Message)"
    }

    if ($TranscriptStarted) {
        try {
            Stop-Transcript | Out-Null
            if (Test-Path -LiteralPath $TranscriptPath) {
                Get-Content -LiteralPath $TranscriptPath -Raw | Set-Clipboard
                Write-Host ""
                Write-Host "Full PowerShell output copied to clipboard." -ForegroundColor Green
                Write-Host "Transcript: $TranscriptPath" -ForegroundColor DarkGray
            }
        }
        catch {
            Write-Warning "Could not copy the transcript to the clipboard."
        }
    }
}
