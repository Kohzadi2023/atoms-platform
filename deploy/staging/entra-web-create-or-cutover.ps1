Clear-Host
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$ExpectedSubscriptionId = "2ac8ed24-166b-4325-89dc-829d64391ce9"
$ForbiddenSubscriptionId = "bbcaf423-9a71-43bc-9fc7-821ef012cd01"
$ExpectedResourceGroup = "atoms-staging-rg"
$ExpectedEnvironmentName = "atoms-staging-env"
$ExpectedRuntimeIdentityName = "atoms-staging-runtime-mi"
$WebAppName = "atoms-staging-web"
$ControlApiName = "atoms-staging-control-api"
$AcrName = "atomsstaging91ce9"
$ExpectedTenantId = "1dda8889-b5fc-43eb-857b-b1549e4b82c3"
$ExpectedAuthority = "https://atomsstaging91ce9.ciamlogin.com/"
$ExpectedWebClientId = "3be3b7af-17db-4a00-8448-04ba55fa76f0"
$ExpectedApiScope = "api://4299c3fb-7ce1-4d23-bd49-26c554b08dac/access_as_user"
$ExpectedPreviewBaseDomain = "preview.proudpond-7f6fcfdd.canadacentral.azurecontainerapps.io"
$ExpectedWebFqdn = "atoms-staging-web.proudpond-7f6fcfdd.canadacentral.azurecontainerapps.io"

$StateDirectory = Join-Path $env:USERPROFILE ".atoms"
$AppsStateFile = Join-Path $StateDirectory "entra-staging-apps.json"
$UserFlowStateFile = Join-Path $StateDirectory "entra-staging-user-flow.json"
$RepositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..")).Path
$env:AZURE_CONFIG_DIR = "$env:USERPROFILE\.azure-atoms"

$TranscriptPath = Join-Path $env:TEMP (
    "atoms-staging-web-create-or-cutover-" + [Guid]::NewGuid().ToString("N") + ".log"
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

function Assert-SubscriptionLock {
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
}

function Assert-VerifiedEntraState {
    Write-Step "Validate verified Entra staging state"

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
        throw "Refusing to continue: Entra state references the forbidden legacy subscription."
    }
    if ([string]$apps.subscriptionId -ne $ExpectedSubscriptionId -or
        [string]$flow.subscriptionId -ne $ExpectedSubscriptionId) {
        throw "Unexpected subscription in Entra state."
    }
    if ([string]$apps.tenantId -ne $ExpectedTenantId -or
        [string]$flow.tenantId -ne $ExpectedTenantId) {
        throw "Unexpected External Tenant in Entra state."
    }
    if ([string]$apps.authority -ne $ExpectedAuthority) {
        throw "Unexpected External Tenant authority in Entra state."
    }
    if ([string]$apps.web.clientId -ne $ExpectedWebClientId -or
        [string]$flow.webClientId -ne $ExpectedWebClientId) {
        throw "Unexpected Web SPA client ID in Entra state."
    }
    if ([string]$apps.controlApi.scope -ne $ExpectedApiScope -or
        [string]$flow.apiScope -ne $ExpectedApiScope) {
        throw "Unexpected delegated API scope in Entra state."
    }
    if ($apps.adminConsentGranted -ne $true) {
        throw "Tenant-wide delegated consent is not recorded as granted."
    }

    Write-Ok "Verified tenant, Web client, delegated scope, user flow, and admin consent"
}

function Assert-RepositoryState {
    Write-Step "Validate clean immutable repository source"

    $git = Get-Command git -ErrorAction SilentlyContinue
    if ($null -eq $git) {
        throw "git was not found."
    }

    $origin = (& $git.Source -C $RepositoryRoot remote get-url origin 2>&1).Trim()
    if ($LASTEXITCODE -ne 0 -or $origin -notmatch "Kohzadi2023/atoms-platform(\.git)?$") {
        throw "Unexpected repository origin: $origin"
    }

    $status = & $git.Source -C $RepositoryRoot status --porcelain
    if ($LASTEXITCODE -ne 0) {
        throw "Could not inspect repository status."
    }
    if (-not [string]::IsNullOrWhiteSpace(($status -join "`n"))) {
        throw "Repository has uncommitted changes. Refusing a non-reproducible staging build."
    }

    $branch = (& $git.Source -C $RepositoryRoot branch --show-current 2>&1).Trim()
    if ($branch -ne "main") {
        throw "Current branch is '$branch'. Run the rollout from main."
    }

    & $git.Source -C $RepositoryRoot fetch origin main
    if ($LASTEXITCODE -ne 0) {
        throw "git fetch origin main failed."
    }

    $head = (& $git.Source -C $RepositoryRoot rev-parse HEAD 2>&1).Trim()
    $originMain = (& $git.Source -C $RepositoryRoot rev-parse origin/main 2>&1).Trim()
    if ($head -ne $originMain) {
        throw "Local main does not match origin/main. Pull with --ff-only before rollout."
    }
    if ($head -notmatch "^[0-9a-f]{40}$") {
        throw "Could not resolve immutable source SHA."
    }

    $dockerfile = Join-Path $RepositoryRoot "apps\web\Dockerfile"
    if (-not (Test-Path -LiteralPath $dockerfile)) {
        throw "apps/web/Dockerfile is missing."
    }

    Write-Ok "Immutable source: $head"
    return $head
}

function Resolve-AzureDependencies {
    Write-Step "Validate Container Apps environment, runtime identity, ACR, and AcrPull"

    $environment = (Invoke-AzCapture -Arguments @(
        "containerapp", "env", "show",
        "--subscription", $ExpectedSubscriptionId,
        "--resource-group", $ExpectedResourceGroup,
        "--name", $ExpectedEnvironmentName,
        "--output", "json",
        "--only-show-errors"
    )) | ConvertFrom-Json

    $identity = (Invoke-AzCapture -Arguments @(
        "identity", "show",
        "--subscription", $ExpectedSubscriptionId,
        "--resource-group", $ExpectedResourceGroup,
        "--name", $ExpectedRuntimeIdentityName,
        "--output", "json",
        "--only-show-errors"
    )) | ConvertFrom-Json

    $acr = (Invoke-AzCapture -Arguments @(
        "acr", "show",
        "--subscription", $ExpectedSubscriptionId,
        "--resource-group", $ExpectedResourceGroup,
        "--name", $AcrName,
        "--output", "json",
        "--only-show-errors"
    )) | ConvertFrom-Json

    $environmentId = [string]$environment.id
    $identityId = [string]$identity.id
    $identityPrincipalId = [string]$identity.principalId
    $acrId = [string]$acr.id
    $acrLoginServer = [string]$acr.loginServer

    foreach ($value in @($environmentId, $identityId, $identityPrincipalId, $acrId, $acrLoginServer)) {
        if ([string]::IsNullOrWhiteSpace($value)) {
            throw "Required Azure dependency metadata is incomplete."
        }
    }

    if ($environmentId -notlike "/subscriptions/$ExpectedSubscriptionId/resourceGroups/$ExpectedResourceGroup/*") {
        throw "Container Apps environment is outside the expected staging resource group/subscription."
    }
    if ($identityId -notlike "/subscriptions/$ExpectedSubscriptionId/resourceGroups/$ExpectedResourceGroup/*") {
        throw "Runtime identity is outside the expected staging resource group/subscription."
    }
    if ($acrId -notlike "/subscriptions/$ExpectedSubscriptionId/resourceGroups/$ExpectedResourceGroup/*") {
        throw "ACR is outside the expected staging resource group/subscription."
    }
    if ($acrLoginServer -ne "$AcrName.azurecr.io") {
        throw "Unexpected ACR login server '$acrLoginServer'."
    }

    $acrPullCountText = Invoke-AzCapture -Arguments @(
        "role", "assignment", "list",
        "--subscription", $ExpectedSubscriptionId,
        "--assignee-object-id", $identityPrincipalId,
        "--scope", $acrId,
        "--query", "[?roleDefinitionName=='AcrPull'] | length(@)",
        "--output", "tsv",
        "--only-show-errors"
    )

    $acrPullCount = 0
    if (-not [int]::TryParse($acrPullCountText, [ref]$acrPullCount) -or $acrPullCount -lt 1) {
        throw "Runtime managed identity does not have AcrPull on the staging ACR. Refusing to use registry credentials."
    }

    $controlApi = (Invoke-AzCapture -Arguments @(
        "containerapp", "show",
        "--subscription", $ExpectedSubscriptionId,
        "--resource-group", $ExpectedResourceGroup,
        "--name", $ControlApiName,
        "--output", "json",
        "--only-show-errors"
    )) | ConvertFrom-Json

    $controlApiFqdn = [string]$controlApi.properties.configuration.ingress.fqdn
    if ([string]::IsNullOrWhiteSpace($controlApiFqdn)) {
        throw "Could not resolve the staging Control API FQDN."
    }

    Write-Ok "Container Apps environment: $ExpectedEnvironmentName"
    Write-Ok "Runtime identity: $ExpectedRuntimeIdentityName (AcrPull verified)"
    Write-Ok "ACR: $acrLoginServer"
    Write-Ok "Control API: https://$controlApiFqdn"

    return [pscustomobject]@{
        EnvironmentId = $environmentId
        IdentityId = $identityId
        AcrId = $acrId
        AcrLoginServer = $acrLoginServer
        ControlApiOrigin = "https://$controlApiFqdn"
    }
}

function Test-WebAppExists {
    $az = Get-AzCommand
    $null = & $az containerapp show `
        --subscription $ExpectedSubscriptionId `
        --resource-group $ExpectedResourceGroup `
        --name $WebAppName `
        --output none `
        --only-show-errors 2>$null

    return ($LASTEXITCODE -eq 0)
}

function Build-WebImage {
    param(
        [Parameter(Mandatory)][string]$GitSha,
        [Parameter(Mandatory)][string]$ControlApiOrigin
    )

    Write-Step "Build and push Web image with verified Entra build-time configuration"

    $az = Get-AzCommand
    $shortSha = $GitSha.Substring(0, 12)
    $imageTag = "entra-$shortSha"
    $image = "$AcrName.azurecr.io/web:$imageTag"

    Push-Location $RepositoryRoot
    try {
        & $az acr build `
            --subscription $ExpectedSubscriptionId `
            --resource-group $ExpectedResourceGroup `
            --registry $AcrName `
            --image "web:$imageTag" `
            --file "apps/web/Dockerfile" `
            --build-arg "NEXT_PUBLIC_CONTROL_API_URL=$ControlApiOrigin" `
            --build-arg "NEXT_PUBLIC_ENTRA_CLIENT_ID=$ExpectedWebClientId" `
            --build-arg "NEXT_PUBLIC_ENTRA_AUTHORITY=$ExpectedAuthority" `
            --build-arg "NEXT_PUBLIC_ENTRA_API_SCOPE=$ExpectedApiScope" `
            --build-arg "NEXT_PUBLIC_STORAGE_ORIGIN=$ControlApiOrigin" `
            --build-arg "NEXT_PUBLIC_PREVIEW_BASE_DOMAIN=$ExpectedPreviewBaseDomain" `
            --only-show-errors `
            .

        if ($LASTEXITCODE -ne 0) {
            throw "ACR Web build failed. No Web Container App change was attempted."
        }
    }
    finally {
        Pop-Location
    }

    Write-Ok "Web image built and pushed: $image"
    return $image
}

function Deploy-WebApp {
    param(
        [Parameter(Mandatory)][string]$Image,
        [Parameter(Mandatory)][pscustomobject]$Dependencies
    )

    $az = Get-AzCommand
    $exists = Test-WebAppExists

    if (-not $exists) {
        Write-Step "Create missing staging Web Container App with managed-identity ACR pull"

        & $az containerapp create `
            --subscription $ExpectedSubscriptionId `
            --resource-group $ExpectedResourceGroup `
            --name $WebAppName `
            --environment $ExpectedEnvironmentName `
            --image $Image `
            --ingress external `
            --target-port 3000 `
            --user-assigned $Dependencies.IdentityId `
            --registry-server $Dependencies.AcrLoginServer `
            --registry-identity $Dependencies.IdentityId `
            --min-replicas 1 `
            --max-replicas 2 `
            --cpu 0.5 `
            --memory 1.0Gi `
            --output none `
            --only-show-errors

        if ($LASTEXITCODE -ne 0) {
            throw "Web Container App creation failed."
        }

        Write-Ok "Created $WebAppName in $ExpectedEnvironmentName"
    }
    else {
        Write-Step "Validate and update existing staging Web Container App"

        $existing = (Invoke-AzCapture -Arguments @(
            "containerapp", "show",
            "--subscription", $ExpectedSubscriptionId,
            "--resource-group", $ExpectedResourceGroup,
            "--name", $WebAppName,
            "--output", "json",
            "--only-show-errors"
        )) | ConvertFrom-Json

        if ([string]$existing.properties.environmentId -ne $Dependencies.EnvironmentId) {
            throw "Existing Web Container App belongs to an unexpected Container Apps environment."
        }

        & $az containerapp identity assign `
            --subscription $ExpectedSubscriptionId `
            --resource-group $ExpectedResourceGroup `
            --name $WebAppName `
            --user-assigned $Dependencies.IdentityId `
            --output none `
            --only-show-errors
        if ($LASTEXITCODE -ne 0) {
            throw "Could not ensure the runtime managed identity on the existing Web Container App."
        }

        & $az containerapp registry set `
            --subscription $ExpectedSubscriptionId `
            --resource-group $ExpectedResourceGroup `
            --name $WebAppName `
            --server $Dependencies.AcrLoginServer `
            --identity $Dependencies.IdentityId `
            --output none `
            --only-show-errors
        if ($LASTEXITCODE -ne 0) {
            throw "Could not ensure managed-identity ACR authentication on the existing Web Container App."
        }

        & $az containerapp ingress enable `
            --subscription $ExpectedSubscriptionId `
            --resource-group $ExpectedResourceGroup `
            --name $WebAppName `
            --type external `
            --target-port 3000 `
            --output none `
            --only-show-errors
        if ($LASTEXITCODE -ne 0) {
            throw "Could not ensure external Web ingress on target port 3000."
        }

        & $az containerapp update `
            --subscription $ExpectedSubscriptionId `
            --resource-group $ExpectedResourceGroup `
            --name $WebAppName `
            --image $Image `
            --output none `
            --only-show-errors
        if ($LASTEXITCODE -ne 0) {
            throw "Web Container App image update failed."
        }

        Write-Ok "Updated existing $WebAppName to $Image"
    }
}

function Verify-WebApp {
    param(
        [Parameter(Mandatory)][string]$ExpectedImage,
        [Parameter(Mandatory)][pscustomobject]$Dependencies
    )

    Write-Step "Verify Web Container App configuration and HTTP readiness"

    $web = (Invoke-AzCapture -Arguments @(
        "containerapp", "show",
        "--subscription", $ExpectedSubscriptionId,
        "--resource-group", $ExpectedResourceGroup,
        "--name", $WebAppName,
        "--output", "json",
        "--only-show-errors"
    )) | ConvertFrom-Json

    if ([string]$web.properties.environmentId -ne $Dependencies.EnvironmentId) {
        throw "Post-deploy environment verification failed."
    }

    $actualImage = [string]$web.properties.template.containers[0].image
    if ($actualImage -ne $ExpectedImage) {
        throw "Post-deploy image verification failed. Expected '$ExpectedImage', got '$actualImage'."
    }

    $webFqdn = [string]$web.properties.configuration.ingress.fqdn
    if ($webFqdn -ne $ExpectedWebFqdn) {
        throw "Unexpected Web FQDN '$webFqdn'. Expected '$ExpectedWebFqdn'."
    }

    $targetPort = [int]$web.properties.configuration.ingress.targetPort
    if ($targetPort -ne 3000) {
        throw "Unexpected Web ingress target port '$targetPort'."
    }

    $webUrl = "https://$webFqdn/"
    $lastError = $null
    $ready = $false

    for ($attempt = 1; $attempt -le 60; $attempt++) {
        try {
            $response = Invoke-WebRequest -Uri $webUrl -Method Get -TimeoutSec 20
            if ($response.StatusCode -eq 200) {
                $ready = $true
                break
            }
            $lastError = "HTTP $($response.StatusCode)"
        }
        catch {
            $lastError = $_.Exception.Message
        }
        Start-Sleep -Seconds 5
    }

    if (-not $ready) {
        throw "Staging Web did not become HTTP-ready. Last error: $lastError"
    }

    Write-Ok "Web image verified: $ExpectedImage"
    Write-Ok "Web ingress verified on target port 3000"
    Write-Ok "Staging Web returned HTTP 200: $webUrl"

    return $webUrl
}

try {
    Start-Transcript -Path $TranscriptPath -Force | Out-Null
    $TranscriptStarted = $true

    Write-Host "Atoms Staging Web Create-or-Cutover v1" -ForegroundColor DarkGray
    Write-Host "Fail-closed: dedicated subscription only; no registry passwords; no auth weakening." -ForegroundColor DarkGray

    Get-AzCommand | Out-Null
    Assert-SubscriptionLock
    Assert-VerifiedEntraState
    $gitSha = Assert-RepositoryState
    $dependencies = Resolve-AzureDependencies
    $image = Build-WebImage -GitSha $gitSha -ControlApiOrigin $dependencies.ControlApiOrigin
    Deploy-WebApp -Image $image -Dependencies $dependencies
    $webUrl = Verify-WebApp -ExpectedImage $image -Dependencies $dependencies

    Write-Host ""
    Write-Host "============================================================" -ForegroundColor Green
    Write-Host "Staging Web Entra deployment completed successfully." -ForegroundColor Green
    Write-Host "============================================================" -ForegroundColor Green
    Write-Host "  Web URL        : $webUrl"
    Write-Host "  Image          : $image"
    Write-Host "  Source SHA     : $gitSha"
    Write-Host "  Entra client   : $ExpectedWebClientId"
    Write-Host "  Entra authority: $ExpectedAuthority"
    Write-Host "  API scope      : $ExpectedApiScope"
    Write-Host ""
    Write-Host "NEXT GATE: perform two real External ID browser sign-ins and run the Entra staging identity smoke." -ForegroundColor Yellow
}
finally {
    try {
        $az = Get-AzCommand
        & $az account set --subscription $ExpectedSubscriptionId 2>$null
        if ($LASTEXITCODE -eq 0) {
            $activeId = (& $az account show --query id --output tsv --only-show-errors 2>$null).Trim()
            if ($activeId -eq $ForbiddenSubscriptionId) {
                throw "Forbidden legacy subscription became active."
            }
        }
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
