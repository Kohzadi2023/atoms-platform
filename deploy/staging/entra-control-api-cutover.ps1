[CmdletBinding()]
param()

Clear-Host
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$ExpectedSubscriptionId = "2ac8ed24-166b-4325-89dc-829d64391ce9"
$ForbiddenSubscriptionId = "bbcaf423-9a71-43bc-9fc7-821ef012cd01"
$ExpectedResourceGroup = "atoms-staging-rg"
$ControlApiName = "atoms-staging-control-api"

$ExpectedTenantId = "1dda8889-b5fc-43eb-857b-b1549e4b82c3"
$ExpectedTenantDomain = "atomsstaging91ce9.onmicrosoft.com"
$ExpectedAuthorityHost = "atomsstaging91ce9.ciamlogin.com"
$ExpectedIssuerHost = "$ExpectedTenantId.ciamlogin.com"
$ExpectedApiClientId = "4299c3fb-7ce1-4d23-bd49-26c554b08dac"
$ExpectedMetadataUrl = "https://$ExpectedAuthorityHost/$ExpectedTenantId/v2.0/.well-known/openid-configuration"
$ExpectedIssuer = "https://$ExpectedIssuerHost/$ExpectedTenantId/v2.0"

$StateDirectory = Join-Path $env:USERPROFILE ".atoms"
$AppsStateFile = Join-Path $StateDirectory "entra-staging-apps.json"
$UserFlowStateFile = Join-Path $StateDirectory "entra-staging-user-flow.json"
$env:AZURE_CONFIG_DIR = "$env:USERPROFILE\.azure-atoms"

$TranscriptPath = Join-Path $env:TEMP ("atoms-entra-control-api-cutover-" + [Guid]::NewGuid().ToString("N") + ".log")
$TranscriptStarted = $false

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
    if ($null -eq $az) { $az = Get-Command az -ErrorAction SilentlyContinue }
    if ($null -eq $az) { throw "Azure CLI was not found." }
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

function Assert-SafeSubscription {
    $az = Get-AzCommand
    & $az account set --subscription $ExpectedSubscriptionId --only-show-errors
    if ($LASTEXITCODE -ne 0) {
        throw "Could not select Atoms-Staging subscription."
    }

    $account = (Invoke-AzCapture -Arguments @(
        "account", "show",
        "--output", "json",
        "--only-show-errors"
    )) | ConvertFrom-Json

    if ([string]$account.id -eq $ForbiddenSubscriptionId) {
        throw "Refusing to continue: the forbidden legacy subscription is active."
    }
    if ([string]$account.id -ne $ExpectedSubscriptionId) {
        throw "Unexpected active subscription '$($account.id)'."
    }

    Write-Ok "Subscription locked to Atoms-Staging ($ExpectedSubscriptionId)"
}

function Assert-VerifiedEntraState {
    if (-not (Test-Path -LiteralPath $AppsStateFile)) {
        throw "Missing verified Entra app state: $AppsStateFile"
    }
    if (-not (Test-Path -LiteralPath $UserFlowStateFile)) {
        throw "Missing verified External ID user-flow state: $UserFlowStateFile. Run deploy/staging/entra-external-id-user-flow.ps1 first."
    }

    $apps = Get-Content -LiteralPath $AppsStateFile -Raw | ConvertFrom-Json
    $flow = Get-Content -LiteralPath $UserFlowStateFile -Raw | ConvertFrom-Json

    if ([string]$apps.subscriptionId -eq $ForbiddenSubscriptionId -or
        [string]$flow.subscriptionId -eq $ForbiddenSubscriptionId) {
        throw "Refusing to continue: a state file references the forbidden legacy subscription."
    }
    if ([string]$apps.subscriptionId -ne $ExpectedSubscriptionId -or
        [string]$flow.subscriptionId -ne $ExpectedSubscriptionId) {
        throw "Unexpected subscription in verified Entra state."
    }
    if ([string]$apps.tenantId -ne $ExpectedTenantId -or
        [string]$flow.tenantId -ne $ExpectedTenantId) {
        throw "Unexpected External Tenant ID in verified Entra state."
    }
    if ([string]$apps.domainName -ne $ExpectedTenantDomain) {
        throw "Unexpected External Tenant domain in verified Entra app state."
    }
    if ([string]$apps.controlApi.clientId -ne $ExpectedApiClientId) {
        throw "Unexpected Control API client ID in verified Entra state."
    }
    if ($apps.adminConsentGranted -ne $true) {
        throw "Tenant-wide Web -> Control API admin consent is not recorded as granted."
    }
}

function Resolve-VerifiedOidcMetadata {
    Write-Step "Resolve the exact Microsoft Entra External ID OIDC metadata"

    $metadata = Invoke-RestMethod `
        -Uri $ExpectedMetadataUrl `
        -Method Get `
        -TimeoutSec 30

    if ($null -eq $metadata) {
        throw "External ID OpenID metadata response was empty."
    }

    $issuer = [string]$metadata.issuer
    $jwksUrl = [string]$metadata.jwks_uri

    if ($issuer -ne $ExpectedIssuer) {
        throw "Unexpected External ID issuer '$issuer'. Expected exact metadata issuer '$ExpectedIssuer'."
    }
    if ([string]::IsNullOrWhiteSpace($jwksUrl)) {
        throw "External ID metadata did not provide jwks_uri."
    }

    $issuerUri = [Uri]$issuer
    $jwksUri = [Uri]$jwksUrl

    if ($issuerUri.Scheme -ne "https" -or $issuerUri.Host.ToLowerInvariant() -ne $ExpectedIssuerHost.ToLowerInvariant()) {
        throw "External ID issuer is outside the verified tenant GUID CIAM host."
    }
    if ($jwksUri.Scheme -ne "https") {
        throw "External ID jwks_uri must use HTTPS."
    }

    $allowedJwksHosts = @(
        $ExpectedAuthorityHost.ToLowerInvariant(),
        $ExpectedIssuerHost.ToLowerInvariant()
    )
    if ($allowedJwksHosts -notcontains $jwksUri.Host.ToLowerInvariant()) {
        throw "External ID jwks_uri host '$($jwksUri.Host)' is outside the verified CIAM hosts."
    }

    $jwks = Invoke-RestMethod `
        -Uri $jwksUrl `
        -Method Get `
        -TimeoutSec 30

    $keys = @($jwks.keys)
    if ($keys.Count -lt 1) {
        throw "External ID JWKS endpoint did not return signing keys."
    }

    Write-Ok "OIDC metadata issuer exactly matches the tenant GUID CIAM issuer"
    Write-Ok "JWKS endpoint is HTTPS, CIAM-scoped, and currently publishes signing keys"

    return [PSCustomObject]@{
        Issuer = $issuer
        JwksUrl = $jwksUrl
    }
}

try {
    Start-Transcript -Path $TranscriptPath -Force | Out-Null
    $TranscriptStarted = $true

    Write-Host "Atoms Staging Control API Entra Cutover v2" -ForegroundColor DarkGray
    Write-Host "Fail-closed: dedicated staging subscription and metadata-derived External ID issuer only." -ForegroundColor DarkGray

    Write-Step "Lock Azure CLI to the dedicated Atoms-Staging subscription"
    Assert-SafeSubscription

    Write-Step "Validate verified External ID bootstrap state"
    Assert-VerifiedEntraState
    Write-Ok "Tenant, applications, admin consent, and user-flow state are present and match staging"

    $oidc = Resolve-VerifiedOidcMetadata

    Write-Step "Validate the staging Control API and fail closed on AUTH_REQUIRED"
    $app = (Invoke-AzCapture -Arguments @(
        "containerapp", "show",
        "--subscription", $ExpectedSubscriptionId,
        "--resource-group", $ExpectedResourceGroup,
        "--name", $ControlApiName,
        "--output", "json",
        "--only-show-errors"
    )) | ConvertFrom-Json

    if ([string]$app.name -ne $ControlApiName -or
        [string]$app.resourceGroup -ne $ExpectedResourceGroup) {
        throw "Unexpected Container App identity."
    }

    $fqdn = [string]$app.properties.configuration.ingress.fqdn
    if ([string]::IsNullOrWhiteSpace($fqdn)) {
        throw "Control API ingress FQDN is unavailable."
    }

    $currentEnv = @($app.properties.template.containers[0].env)
    $authRequired = @(
        $currentEnv | Where-Object { [string]$_.name -eq "AUTH_REQUIRED" }
    ) | Select-Object -First 1

    if ($null -eq $authRequired -or [string]$authRequired.value -ne "true") {
        throw "AUTH_REQUIRED must already be exactly 'true'. Refusing to weaken authentication."
    }
    Write-Ok "AUTH_REQUIRED=true is already enforced"

    Write-Step "Create a new Control API revision with metadata-derived Entra OIDC settings"
    Assert-SafeSubscription
    $az = Get-AzCommand

    & $az containerapp update `
        --subscription $ExpectedSubscriptionId `
        --resource-group $ExpectedResourceGroup `
        --name $ControlApiName `
        --set-env-vars `
            "AUTH_REQUIRED=true" `
            "AUTH_ISSUER_URL=$($oidc.Issuer)" `
            "AUTH_AUDIENCE=$ExpectedApiClientId" `
            "AUTH_JWKS_URL=$($oidc.JwksUrl)" `
            "AUTH_ALLOWED_ALGORITHMS=RS256" `
        --output none `
        --only-show-errors

    if ($LASTEXITCODE -ne 0) {
        throw "Control API Entra environment update failed."
    }
    Write-Ok "Verified metadata-derived Entra OIDC settings applied"

    Write-Step "Verify runtime settings and readiness"
    $updated = (Invoke-AzCapture -Arguments @(
        "containerapp", "show",
        "--subscription", $ExpectedSubscriptionId,
        "--resource-group", $ExpectedResourceGroup,
        "--name", $ControlApiName,
        "--output", "json",
        "--only-show-errors"
    )) | ConvertFrom-Json

    $updatedEnv = @($updated.properties.template.containers[0].env)
    $expected = @{
        AUTH_REQUIRED = "true"
        AUTH_ISSUER_URL = [string]$oidc.Issuer
        AUTH_AUDIENCE = $ExpectedApiClientId
        AUTH_JWKS_URL = [string]$oidc.JwksUrl
        AUTH_ALLOWED_ALGORITHMS = "RS256"
    }

    foreach ($entry in $expected.GetEnumerator()) {
        $actual = @(
            $updatedEnv | Where-Object { [string]$_.name -eq [string]$entry.Key }
        ) | Select-Object -First 1

        if ($null -eq $actual -or [string]$actual.value -ne [string]$entry.Value) {
            throw "Post-update verification failed for '$($entry.Key)'."
        }
    }

    $readyUrl = "https://$fqdn/readyz"
    $ready = Invoke-WebRequest -Uri $readyUrl -Method Get -TimeoutSec 60
    if ($ready.StatusCode -ne 200) {
        throw "Readiness endpoint returned HTTP $($ready.StatusCode)."
    }

    Write-Ok "Control API is ready with exact metadata-derived Entra OIDC settings"

    Write-Step "Final Azure safety check"
    Assert-SafeSubscription

    Write-Host ""
    Write-Host "Control API Entra cutover is complete." -ForegroundColor Green
    Write-Host "  URL      : https://$fqdn"
    Write-Host "  Audience : $ExpectedApiClientId"
    Write-Host "  Issuer   : $($oidc.Issuer)"
    Write-Host ""
    Write-Host "Next gate: sign in through the staging Web and verify /v1/me plus /v1/workspaces with a real External ID access token." -ForegroundColor Cyan
}
finally {
    try {
        $az = Get-AzCommand
        & $az account set --subscription $ExpectedSubscriptionId --only-show-errors 2>$null
    }
    catch {
        Write-Warning "Could not reassert the Atoms-Staging Azure CLI context."
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
