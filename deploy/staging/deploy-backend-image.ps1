#Requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet("control-api", "orchestrator-worker")]
    [string]$Service,
    # The exact commit to deploy. Mandatory on purpose: it must equal HEAD of -RepositoryRoot.
    [Parameter(Mandatory)]
    [ValidatePattern("^[0-9a-fA-F]{40}$")]
    [string]$ExpectedSourceSha,
    [string]$RepositoryRoot = (Get-Location).Path,
    # Validate everything and print the plan, rollback image and readiness URL, then stop.
    # Builds nothing and changes nothing in Azure.
    [switch]$PlanOnly,
    # Public origin used for the /readyz check. By default it is the Control API's custom domain.
    [string]$ControlApiOrigin,
    [switch]$AllowRawContainerAppsOrigins
)

# Clear-Host throws when the output is not a console (CI, redirected runs).
if (-not [Console]::IsOutputRedirected) { Clear-Host }
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

. (Join-Path $PSScriptRoot "web-public-origins.ps1")
. (Join-Path $PSScriptRoot "staging-services.ps1")

$ExpectedSubscriptionId = "2ac8ed24-166b-4325-89dc-829d64391ce9"
$ForbiddenSubscriptionId = "bbcaf423-9a71-43bc-9fc7-821ef012cd01"
$ExpectedResourceGroup = "atoms-staging-rg"
$AcrName = "atomsstaging91ce9"
$ControlApiAppName = "atoms-staging-control-api"
$env:AZURE_CONFIG_DIR = "$env:USERPROFILE\.azure-atoms"

$TranscriptPath = Join-Path $env:TEMP (
    "atoms-staging-deploy-$Service-" + [Guid]::NewGuid().ToString("N") + ".log"
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

function Get-ContainerApp {
    param([Parameter(Mandatory)][string]$Name)

    return (Invoke-AzCapture -Arguments @(
        "containerapp", "show",
        "--subscription", $ExpectedSubscriptionId,
        "--resource-group", $ExpectedResourceGroup,
        "--name", $Name,
        "--output", "json",
        "--only-show-errors"
    )) | ConvertFrom-Json
}

function Get-ReadyzText {
    param([Parameter(Mandatory)][string]$Origin)

    try {
        $response = Invoke-WebRequest -Uri "$Origin/readyz" -Method Get -TimeoutSec 60 -SkipHttpErrorCheck
        if ($response.StatusCode -ne 200) { return "" }
        return [string]$response.Content
    }
    catch { return "" }
}

$rollbackHint = ""

try {
    Start-Transcript -Path $TranscriptPath -Force | Out-Null
    $TranscriptStarted = $true

    Write-Host "Atoms Staging backend image deploy: $Service" -ForegroundColor DarkGray

    $spec = Get-StagingServiceSpec -Name $Service
    $az = Get-AzCommand

    Write-Step "Lock Azure CLI to the dedicated Atoms-Staging subscription"
    & $az account set --subscription $ExpectedSubscriptionId --only-show-errors
    if ($LASTEXITCODE -ne 0) { throw "Could not select the Atoms-Staging subscription." }
    $account = (Invoke-AzCapture -Arguments @("account", "show", "--output", "json", "--only-show-errors")) | ConvertFrom-Json
    if ([string]$account.id -eq $ForbiddenSubscriptionId) {
        throw "Refusing to continue: the forbidden legacy subscription is active."
    }
    if ([string]$account.id -ne $ExpectedSubscriptionId) {
        throw "Unexpected active subscription '$($account.id)'."
    }
    Write-Ok "Subscription locked to Atoms-Staging ($ExpectedSubscriptionId)"

    Write-Step "Validate the repository and the exact source commit"
    $root = (Resolve-Path -LiteralPath $RepositoryRoot).Path
    $dockerfile = Join-Path $root ($spec.Dockerfile -replace "/", [IO.Path]::DirectorySeparatorChar)
    if (-not (Test-Path -LiteralPath $dockerfile)) {
        throw "$($spec.Dockerfile) was not found under '$root'."
    }
    $git = Get-Command git -ErrorAction SilentlyContinue
    if ($null -eq $git) { throw "git was not found." }
    $status = & $git.Source -C $root status --porcelain
    if ($LASTEXITCODE -ne 0) { throw "Could not inspect repository status." }
    if (-not [string]::IsNullOrWhiteSpace(($status -join "`n"))) {
        throw "Repository has uncommitted changes. Refusing to build an image that cannot be reproduced."
    }
    $gitSha = (& $git.Source -C $root rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $gitSha -notmatch "^[0-9a-f]{40}$") { throw "Could not resolve an immutable git SHA." }
    if ($gitSha -ne $ExpectedSourceSha.ToLowerInvariant()) {
        throw "Source SHA mismatch. Expected '$($ExpectedSourceSha.ToLowerInvariant())', got '$gitSha'. Refusing to build."
    }
    $tag = New-StagingImageTag -Sha $gitSha
    $newImage = "$AcrName.azurecr.io/$($spec.Repository):$tag"
    Write-Ok "Immutable source: $gitSha"
    Write-Ok "Target image: $newImage"

    Write-Step "Read the running app and the Control API's public origin"
    $app = Get-ContainerApp -Name $spec.AppName
    $mode = [string]$app.properties.configuration.activeRevisionsMode
    if ($mode -ne "Single") {
        throw "$($spec.AppName) runs in '$mode' revision mode. This script assumes Single: the old revision keeps serving until the new one is ready."
    }
    $previousImage = [string]$app.properties.template.containers[0].image
    $previousRevision = [string]$app.properties.latestRevisionName
    if ([string]::IsNullOrWhiteSpace($previousImage)) { throw "Could not read the running image of $($spec.AppName)." }
    # Re-deploying the image the app already runs leaves no earlier image to return to.
    $sameImage = ($previousImage -eq $newImage)
    $rollbackHint = if ($sameImage) { "" } else { "az containerapp update --subscription $ExpectedSubscriptionId --resource-group $ExpectedResourceGroup --name $($spec.AppName) --image $previousImage" }
    $rollbackText = if ($sameImage) { "none (the app already runs this image tag, so there is no earlier image to return to)" } else { $rollbackHint }
    Write-Ok "$($spec.AppName) runs $previousImage (revision $previousRevision)"
    Write-Ok "Rollback: $rollbackText"
    if ($sameImage) {
        Write-Host "    NOTE: the app already runs this image tag; a rebuild will only refresh the tag in ACR." -ForegroundColor Yellow
    }

    $controlApi = if ($Service -eq "control-api") { $app } else { Get-ContainerApp -Name $ControlApiAppName }
    $customDomains = @($controlApi.properties.configuration.ingress.customDomains | ForEach-Object { [string]$_.name })
    $apiOrigin = Resolve-ControlApiOrigin -Explicit $ControlApiOrigin -CustomDomains $customDomains -AllowRaw:$AllowRawContainerAppsOrigins
    Write-Ok "Readiness is checked at $($apiOrigin.Value)/readyz (from $($apiOrigin.Source))"

    if ($PlanOnly) {
        Write-Host ""
        Write-Host "Plan only: nothing was built and nothing in Azure was changed." -ForegroundColor Green
        Write-Host "  Service        : $Service ($($spec.AppName))"
        Write-Host "  Build          : $($spec.Dockerfile) at $gitSha"
        Write-Host "  New image      : $newImage"
        Write-Host "  Current image  : $previousImage"
        Write-Host "  Readiness URL  : $($apiOrigin.Value)/readyz"
        Write-Host "  Rollback       : $rollbackText"
        return
    }

    Write-Step "Build and push the image"
    $imageRef = "$($spec.Repository):$tag"
    $previousUpdate = Get-AcrImageUpdateTime -Az $az -Subscription $ExpectedSubscriptionId -Registry $AcrName -Image $imageRef
    Push-Location $root
    try {
        # --no-logs: streaming the build log crashes az on Windows (charmap UnicodeEncodeError)
        # whenever the output is not a console. The image is awaited below instead.
        & $az acr build `
            --subscription $ExpectedSubscriptionId `
            --resource-group $ExpectedResourceGroup `
            --registry $AcrName `
            --image $imageRef `
            --file $spec.Dockerfile `
            --no-logs `
            --only-show-errors `
            .
        if ($LASTEXITCODE -ne 0) {
            throw "ACR build failed. The running $($spec.AppName) has not been changed."
        }
        $null = Wait-AcrImage -Az $az -Subscription $ExpectedSubscriptionId -Registry $AcrName -Image $imageRef -PreviousUpdate $previousUpdate
    }
    finally {
        Pop-Location
    }
    Write-Ok "Image built and pushed: $newImage"

    Write-Step "Roll the new image out to $($spec.AppName)"
    & $az containerapp update `
        --subscription $ExpectedSubscriptionId `
        --resource-group $ExpectedResourceGroup `
        --name $spec.AppName `
        --image $newImage `
        --output none `
        --only-show-errors
    if ($LASTEXITCODE -ne 0) { throw "Container App update failed." }

    $updated = Get-ContainerApp -Name $spec.AppName
    if ([string]$updated.properties.template.containers[0].image -ne $newImage) {
        throw "Post-update image check failed: the app does not carry '$newImage'."
    }
    $newRevision = [string]$updated.properties.latestRevisionName
    Write-Ok "Latest revision: $newRevision"
    Wait-RevisionReady -Az $az -Subscription $ExpectedSubscriptionId -ResourceGroup $ExpectedResourceGroup -App $spec.AppName -Revision $newRevision
    Write-Ok "Revision $newRevision is ready"

    Write-Step "Verify with the Control API's /readyz"
    $verdict = $null
    for ($attempt = 1; $attempt -le 8; $attempt++) {
        $verdict = Get-ReadyzVerdict -Json (Get-ReadyzText -Origin $apiOrigin.Value) -Service $Service
        if ($verdict.Ok) { break }
        if ($attempt -lt 8) { Start-Sleep -Seconds 15 }
    }
    if (-not $verdict.Ok) { throw "Readiness check failed: $($verdict.Reason)." }
    Write-Ok "/readyz: $($verdict.Reason)"

    Write-Host ""
    Write-Host "Staging $Service deploy is complete." -ForegroundColor Green
    Write-Host "  Image        : $newImage"
    Write-Host "  Revision     : $newRevision"
    Write-Host "  Source SHA   : $gitSha"
    Write-Host "  Previous     : $previousImage"
    Write-Host "  Rollback     : $rollbackText"
}
catch {
    if ($rollbackHint -ne "") {
        Write-Host ""
        Write-Host "If the new revision is unhealthy, roll back with:" -ForegroundColor Yellow
        Write-Host "  $rollbackHint" -ForegroundColor Yellow
    }
    throw
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
