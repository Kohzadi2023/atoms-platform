[CmdletBinding()]
param(
    [string]$RepositoryRoot = (Get-Location).Path,
    [ValidatePattern("^[0-9a-fA-F]{40}$")]
    [string]$ExpectedSourceSha
)

Clear-Host
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$ExpectedSubscriptionId = "2ac8ed24-166b-4325-89dc-829d64391ce9"
$ForbiddenSubscriptionId = "bbcaf423-9a71-43bc-9fc7-821ef012cd01"
$ExpectedResourceGroup = "atoms-staging-rg"
$WebAppName = "atoms-staging-web"
$ControlApiName = "atoms-staging-control-api"
$AcrName = "atomsstaging91ce9"
$ExpectedTenantId = "1dda8889-b5fc-43eb-857b-b1549e4b82c3"
$ExpectedAuthority = "https://atomsstaging91ce9.ciamlogin.com/"
$ExpectedWebClientId = "3be3b7af-17db-4a00-8448-04ba55fa76f0"
$ExpectedApiScope = "api://4299c3fb-7ce1-4d23-bd49-26c554b08dac/access_as_user"
$ExpectedPreviewBaseDomain = "preview.proudpond-7f6fcfdd.canadacentral.azurecontainerapps.io"

$StateDirectory = Join-Path $env:USERPROFILE ".atoms"
$AppsStateFile = Join-Path $StateDirectory "entra-staging-apps.json"
$UserFlowStateFile = Join-Path $StateDirectory "entra-staging-user-flow.json"
$env:AZURE_CONFIG_DIR = "$env:USERPROFILE\.azure-atoms"

$TranscriptPath = Join-Path $env:TEMP (
    "atoms-staging-web-entra-cutover-" + [Guid]::NewGuid().ToString("N") + ".log"
)
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

function Assert-VerifiedState {
    Write-Step "Validate the verified Entra staging state"

    if (-not (Test-Path -LiteralPath $AppsStateFile)) {
        throw "Missing Entra app state: $AppsStateFile"
    }
    if (-not (Test-Path -LiteralPath $UserFlowStateFile)) {
        throw "Missing completed External ID user-flow state: $UserFlowStateFile"
    }

    $apps = Get-Content -LiteralPath $AppsStateFile -Raw | ConvertFrom-Json
    $flow = Get-Content -LiteralPath $UserFlowStateFile -Raw | ConvertFrom-Json

    if ([string]$apps.subscriptionId -eq $ForbiddenSubscriptionId -or
        [string]$flow.subscriptionId -eq $ForbiddenSubscriptionId) {
        throw "Refusing to continue: state references the forbidden legacy subscription."
    }

    if ([string]$apps.subscriptionId -ne $ExpectedSubscriptionId -or
        [string]$flow.subscriptionId -ne $ExpectedSubscriptionId) {
        throw "Unexpected subscription in Entra state."
    }
    if ([string]$apps.tenantId -ne $ExpectedTenantId -or
        [string]$flow.tenantId -ne $ExpectedTenantId) {
        throw "Unexpected External Tenant in Entra state."
    }
    if ([string]$apps.web.clientId -ne $ExpectedWebClientId -or
        [string]$flow.webClientId -ne $ExpectedWebClientId) {
        throw "Unexpected Web application client ID in Entra state."
    }
    if ([string]$apps.controlApi.scope -ne $ExpectedApiScope -or
        [string]$flow.apiScope -ne $ExpectedApiScope) {
        throw "Unexpected Control API scope in Entra state."
    }
    if ([string]$apps.authority -ne $ExpectedAuthority) {
        throw "Unexpected External Tenant authority in Entra state."
    }
    if ($apps.adminConsentGranted -ne $true) {
        throw "Tenant-wide delegated consent is not recorded as granted."
    }

    Write-Ok "Verified tenant, Web client, delegated scope, user flow, and admin consent"
}

try {
    Start-Transcript -Path $TranscriptPath -Force | Out-Null
    $TranscriptStarted = $true

    Write-Host "Atoms Staging Web Entra Cutover v2" -ForegroundColor DarkGray

    Write-Step "Lock Azure CLI to the dedicated Atoms-Staging subscription"

    $az = Get-AzCommand
    & $az account set --subscription $ExpectedSubscriptionId
    if ($LASTEXITCODE -ne 0) {
        throw "Could not select Atoms-Staging subscription."
    }

    $account = (Invoke-AzCapture -Arguments @(
        "account", "show", "--output", "json", "--only-show-errors"
    )) | ConvertFrom-Json

    if ([string]$account.id -eq $ForbiddenSubscriptionId) {
        throw "Refusing to continue: the forbidden legacy subscription is active."
    }
    if ([string]$account.id -ne $ExpectedSubscriptionId) {
        throw "Unexpected active subscription '$($account.id)'."
    }

    Write-Ok "Subscription locked to Atoms-Staging ($ExpectedSubscriptionId)"

    Assert-VerifiedState

    Write-Step "Validate repository and immutable source revision"

    $repositoryRootResolved = (Resolve-Path -LiteralPath $RepositoryRoot).Path
    $dockerfile = Join-Path $repositoryRootResolved "apps\web\Dockerfile"
    if (-not (Test-Path -LiteralPath $dockerfile)) {
        throw "apps/web/Dockerfile was not found under '$repositoryRootResolved'."
    }

    $git = Get-Command git -ErrorAction SilentlyContinue
    if ($null -eq $git) {
        throw "git was not found."
    }

    $gitStatus = & $git.Source -C $repositoryRootResolved status --porcelain
    if ($LASTEXITCODE -ne 0) {
        throw "Could not inspect repository status."
    }
    if (-not [string]::IsNullOrWhiteSpace(($gitStatus -join "`n"))) {
        throw "Repository has uncommitted changes. Refusing to build a non-reproducible staging image."
    }

    $gitSha = (& $git.Source -C $repositoryRootResolved rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $gitSha -notmatch "^[0-9a-f]{40}$") {
        throw "Could not resolve an immutable git SHA."
    }

    if (-not [string]::IsNullOrWhiteSpace($ExpectedSourceSha) -and
        $gitSha -ne $ExpectedSourceSha.ToLowerInvariant()) {
        throw "Source SHA mismatch. Expected '$($ExpectedSourceSha.ToLowerInvariant())', got '$gitSha'. Refusing staging build."
    }

    $shortSha = $gitSha.Substring(0, 12)
    $imageTag = "entra-$shortSha"
    $image = "$AcrName.azurecr.io/web:$imageTag"

    Write-Ok "Immutable source: $gitSha"
    if (-not [string]::IsNullOrWhiteSpace($ExpectedSourceSha)) {
        Write-Ok "Exact expected source SHA matched"
    }
    Write-Ok "Target image: $image"

    Write-Step "Resolve current staging public origins"

    $webApp = (Invoke-AzCapture -Arguments @(
        "containerapp", "show",
        "--subscription", $ExpectedSubscriptionId,
        "--resource-group", $ExpectedResourceGroup,
        "--name", $WebAppName,
        "--output", "json",
        "--only-show-errors"
    )) | ConvertFrom-Json

    $controlApi = (Invoke-AzCapture -Arguments @(
        "containerapp", "show",
        "--subscription", $ExpectedSubscriptionId,
        "--resource-group", $ExpectedResourceGroup,
        "--name", $ControlApiName,
        "--output", "json",
        "--only-show-errors"
    )) | ConvertFrom-Json

    $webFqdn = [string]$webApp.properties.configuration.ingress.fqdn
    $controlApiFqdn = [string]$controlApi.properties.configuration.ingress.fqdn

    if ([string]::IsNullOrWhiteSpace($webFqdn) -or
        [string]::IsNullOrWhiteSpace($controlApiFqdn)) {
        throw "Could not resolve staging Container Apps ingress FQDNs."
    }

    $controlApiOrigin = "https://$controlApiFqdn"

    Write-Ok "Web origin: https://$webFqdn"
    Write-Ok "Control API origin: $controlApiOrigin"

    Write-Step "Build and push the Web image with verified Entra build arguments"

    Push-Location $repositoryRootResolved
    try {
        & $az acr build `
            --subscription $ExpectedSubscriptionId `
            --resource-group $ExpectedResourceGroup `
            --registry $AcrName `
            --image "web:$imageTag" `
            --file "apps/web/Dockerfile" `
            --build-arg "NEXT_PUBLIC_CONTROL_API_URL=$controlApiOrigin" `
            --build-arg "NEXT_PUBLIC_ENTRA_CLIENT_ID=$ExpectedWebClientId" `
            --build-arg "NEXT_PUBLIC_ENTRA_AUTHORITY=$ExpectedAuthority" `
            --build-arg "NEXT_PUBLIC_ENTRA_TENANT_ID=$ExpectedTenantId" `
            --build-arg "NEXT_PUBLIC_ENTRA_API_SCOPE=$ExpectedApiScope" `
            --build-arg "NEXT_PUBLIC_STORAGE_ORIGIN=$controlApiOrigin" `
            --build-arg "NEXT_PUBLIC_PREVIEW_BASE_DOMAIN=$ExpectedPreviewBaseDomain" `
            --only-show-errors `
            .

        if ($LASTEXITCODE -ne 0) {
            throw "ACR Web build failed. The existing staging Web revision has not been changed."
        }
    }
    finally {
        Pop-Location
    }

    Write-Ok "Web image built and pushed: $image"

    Write-Step "Deploy the immutable Web image to Azure Container Apps"

    & $az containerapp update `
        --subscription $ExpectedSubscriptionId `
        --resource-group $ExpectedResourceGroup `
        --name $WebAppName `
        --image $image `
        --output none `
        --only-show-errors

    if ($LASTEXITCODE -ne 0) {
        throw "Web Container App update failed."
    }

    Write-Ok "Web Container App updated to $image"

    Write-Step "Verify staging Web readiness"

    $updated = (Invoke-AzCapture -Arguments @(
        "containerapp", "show",
        "--subscription", $ExpectedSubscriptionId,
        "--resource-group", $ExpectedResourceGroup,
        "--name", $WebAppName,
        "--output", "json",
        "--only-show-errors"
    )) | ConvertFrom-Json

    $actualImage = [string]$updated.properties.template.containers[0].image
    if ($actualImage -ne $image) {
        throw "Post-deploy image verification failed. Expected '$image', got '$actualImage'."
    }

    $webUrl = "https://$webFqdn/"
    $response = Invoke-WebRequest -Uri $webUrl -Method Get -TimeoutSec 60
    if ($response.StatusCode -ne 200) {
        throw "Web readiness request returned HTTP $($response.StatusCode)."
    }

    Write-Ok "Staging Web returned HTTP 200"

    Write-Host ""
    Write-Host "Staging Web Entra cutover is complete." -ForegroundColor Green
    Write-Host "  Web URL       : $webUrl"
    Write-Host "  Image         : $image"
    Write-Host "  Source SHA    : $gitSha"
    Write-Host "  Entra client  : $ExpectedWebClientId"
    Write-Host "  Entra authority: $ExpectedAuthority"
    Write-Host "  API scope     : $ExpectedApiScope"
    Write-Host ""
    Write-Host "Next: run scripts/staging-public-smoke.ps1, then perform authenticated browser gates only when auth-sensitive code changed." -ForegroundColor Cyan
}
finally {
    try {
        $az = Get-AzCommand
        & $az account set --subscription $ExpectedSubscriptionId 2>$null
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
