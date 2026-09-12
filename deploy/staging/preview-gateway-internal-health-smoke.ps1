Clear-Host
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
if ($PSVersionTable.PSVersion.Major -lt 7) { throw "PowerShell 7+ required." }

$SubscriptionId = "2ac8ed24-166b-4325-89dc-829d64391ce9"
$ForbiddenSubscriptionId = "bbcaf423-9a71-43bc-9fc7-821ef012cd01"
$Rg = "atoms-staging-rg"
$EnvName = "atoms-staging-env"
$EnvironmentId = "/subscriptions/$SubscriptionId/resourceGroups/$Rg/providers/Microsoft.App/managedEnvironments/$EnvName"
$ApiName = "atoms-staging-control-api"
$PreviewName = "atoms-staging-preview-gateway"
$Acr = "atomsstaging91ce9"
$AcrServer = "$Acr.azurecr.io"
$PullIdentity = "/subscriptions/$SubscriptionId/resourceGroups/$Rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/atoms-staging-acr-pull"
$PreviewAcrRef = "preview-gateway:private-skeleton-0482b37eab42"
$PreviewImage = "$AcrServer/$PreviewAcrRef"
$PreviewDigest = "sha256:53b70e9f6fa2fee00af2c02d70c6d5fdc281acde31532af1c2ab7d7278c9d994"
$DefaultDomain = "proudpond-7f6fcfdd.canadacentral.azurecontainerapps.io"
$InternalFqdn = "$PreviewName.internal.$DefaultDomain"
$UiOrigin = "https://atoms-staging-web.$DefaultDomain"
$ProbeId = [Guid]::NewGuid().ToString("N")
$JobName = "atoms-stg-pv-smoke-" + $ProbeId.Substring(0, 12)
$JobMayExist = $false
$JobConfigPath = $null
$AzExecutable = $null
$env:AZURE_CONFIG_DIR = "$env:USERPROFILE\.azure-atoms"
$env:AZURE_CORE_ONLY_SHOW_ERRORS = "true"
$Transcript = Join-Path ([IO.Path]::GetTempPath()) ("atoms-preview-health-$ProbeId.log")
$TranscriptStarted = $false

# JSON is valid YAML. Keep JavaScript out of the Windows/az.cmd command line.
$ProbeJavaScript = @'
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 60000);
(async () => {
  try {
    const response = await fetch(process.env.TARGET_URL, {
      signal: controller.signal,
      redirect: "manual",
    });
    const body = Buffer.from(await response.arrayBuffer());
    const expected = Buffer.from('{"status":"ok"}', "utf8");
    if (response.status !== 200 || !body.equals(expected)) {
      console.error("ATOMS_PREVIEW_HEALTH_FAIL");
      process.exitCode = 2;
      return;
    }
    console.log('ATOMS_PREVIEW_HEALTH_OK {"status":"ok"}');
  } catch {
    console.error("ATOMS_PREVIEW_HEALTH_ERROR");
    process.exitCode = 3;
  } finally {
    clearTimeout(timeout);
  }
})();
'@

function Ok($Message) { Write-Host "    OK: $Message" -ForegroundColor Green }
function Step($Message) { Write-Host "`n==> $Message" -ForegroundColor Cyan }

function Invoke-Az([string[]]$CommandArgs) {
    if ([string]::IsNullOrWhiteSpace($script:AzExecutable)) {
        $command = Get-Command az -CommandType Application -ErrorAction Stop
        $script:AzExecutable = [string]$command.Source
    }
    $stderrPath = [IO.Path]::GetTempFileName()
    try {
        # Warnings/progress on native stderr must never enter JSON stdout.
        $stdout = & $script:AzExecutable @CommandArgs 2> $stderrPath
        $exitCode = $LASTEXITCODE
        if ($exitCode -ne 0) {
            $stderr = [IO.File]::ReadAllText($stderrPath).Trim()
            throw "Azure CLI failed safely (exit $exitCode).`n$stderr"
        }
        return ($stdout -join "`n").Trim()
    } finally {
        Remove-Item -LiteralPath $stderrPath -Force -ErrorAction SilentlyContinue
    }
}

function J([string[]]$CommandArgs) {
    $raw = Invoke-Az $CommandArgs
    if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
    return $raw | ConvertFrom-Json
}

function P($Object, $Name) {
    if ($null -eq $Object) { return $null }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Items($Value) { @($Value | Where-Object { $null -ne $_ }) }

function EnvVal($App, $Name) {
    $containers = @(Items (P $App.properties.template "containers"))
    if ($containers.Count -ne 1) { throw "Expected one container." }
    $matches = @((P $containers[0] "env") | Where-Object { (P $_ "name") -eq $Name })
    if ($matches.Count -ne 1) { return $null }
    return [string](P $matches[0] "value")
}

function Lock-Staging {
    [void](Invoke-Az @("account", "set", "--subscription", $SubscriptionId, "--only-show-errors"))
    $account = J @("account", "show", "--subscription", $SubscriptionId, "-o", "json", "--only-show-errors")
    if ((P $account "id") -eq $ForbiddenSubscriptionId) { throw "Forbidden legacy subscription active." }
    if ((P $account "id") -ne $SubscriptionId -or (P $account "name") -ne "Atoms-Staging" -or (P $account "state") -ne "Enabled") {
        throw "Subscription lock failed."
    }
    Ok "Subscription locked to Atoms-Staging ($SubscriptionId)"
}

function Http($Uri, $Status) {
    for ($attempt = 1; $attempt -le 4; $attempt++) {
        try {
            $response = Invoke-WebRequest -Uri $Uri -SkipHttpErrorCheck -MaximumRedirection 0 -ConnectionTimeoutSeconds 20
            if ([int]$response.StatusCode -eq $Status) { return }
        } catch { }
        if ($attempt -lt 4) { Start-Sleep -Seconds 5 }
    }
    throw "HTTP safety probe failed: $Uri expected $Status"
}

function Verify-Api {
    $api = J @("containerapp", "show", "--subscription", $SubscriptionId, "-g", $Rg, "-n", $ApiName, "-o", "json", "--only-show-errors")
    if ((EnvVal $api "AUTH_REQUIRED") -ne "true") { throw "AUTH_REQUIRED must remain true." }
    if ((EnvVal $api "RUN_EXECUTION_ENABLED") -ne "false") { throw "RUN_EXECUTION_ENABLED must remain false." }
    Http "https://$ApiName.$DefaultDomain/readyz" 200
    Http "https://$ApiName.$DefaultDomain/v1/me" 401
    Ok "AUTH_REQUIRED=true, RUN_EXECUTION_ENABLED=false, readyz=200, unauth /v1/me=401"
    return $api
}

function Verify-PublicBoundary {
    $environment = J @("containerapp", "env", "show", "--subscription", $SubscriptionId, "-g", $Rg, "-n", $EnvName, "-o", "json", "--only-show-errors")
    if ((P $environment "id") -ne $EnvironmentId -or (P $environment.properties "defaultDomain") -ne $DefaultDomain) {
        throw "Environment identity/default domain changed."
    }
    $custom = P $environment.properties "customDomainConfiguration"
    if ($null -ne $custom -and (
        -not [string]::IsNullOrWhiteSpace([string](P $custom "dnsSuffix")) -or
        $null -ne (P $custom "certificateValue") -or $null -ne (P $custom "certificateKeyVaultProperties")
    )) { throw "Custom environment DNS/TLS now exists." }
    $certificates = @(Items (J @("containerapp", "env", "certificate", "list", "--subscription", $SubscriptionId, "-g", $Rg, "-n", $EnvName, "-o", "json", "--only-show-errors")))
    if ($certificates.Count -gt 0) { throw "Environment certificates now exist." }
    $zones = @(Items (J @("resource", "list", "--subscription", $SubscriptionId, "-g", $Rg, "--resource-type", "Microsoft.Network/dnszones", "-o", "json", "--only-show-errors")))
    if ($zones.Count -gt 0) { throw "Azure DNS public zone now exists." }
    $routes = @(Items (J @("resource", "list", "--subscription", $SubscriptionId, "-g", $Rg, "--resource-type", "Microsoft.App/managedEnvironments/httpRouteConfigs", "-o", "json", "--only-show-errors")))
    if ($routes.Count -gt 0) { throw "Environment HTTP route config exists." }
    Ok "No public DNS/TLS/custom route exposure detected"
    return $environment
}

function Verify-Preview {
    $preview = J @("containerapp", "show", "--subscription", $SubscriptionId, "-g", $Rg, "-n", $PreviewName, "-o", "json", "--only-show-errors")
    $containers = @(Items (P $preview.properties.template "containers"))
    if ($containers.Count -ne 1) { throw "Expected one preview container." }
    if ((P $containers[0] "image") -ne $PreviewImage) { throw "Preview image changed." }
    $digest = Invoke-Az @("acr", "repository", "show", "--subscription", $SubscriptionId, "-n", $Acr, "--image", $PreviewAcrRef, "--query", "digest", "-o", "tsv", "--only-show-errors")
    if ($digest.ToLowerInvariant() -ne $PreviewDigest) { throw "Preview digest changed." }
    $scale = P $preview.properties.template "scale"
    if ($null -eq (P $scale "minReplicas") -or (P $scale "minReplicas") -ne 0 -or (P $scale "maxReplicas") -ne 1) {
        throw "Preview scale must remain min=0/max=1."
    }
    if ((EnvVal $preview "PREVIEW_BASE_DOMAIN") -ne "preview.invalid") { throw "PREVIEW_BASE_DOMAIN must remain preview.invalid." }
    if ((EnvVal $preview "PREVIEW_UI_ORIGIN") -ne $UiOrigin) { throw "PREVIEW_UI_ORIGIN changed." }
    if ((EnvVal $preview "PREVIEW_PUBLIC_PROTOCOL") -ne "https" -or (EnvVal $preview "PREVIEW_GATEWAY_PORT") -ne "3002") {
        throw "Preview HTTPS/runtime port contract failed."
    }
    $ingress = P $preview.properties.configuration "ingress"
    if ($null -eq $ingress -or (P $ingress "external") -isnot [bool] -or (P $ingress "external") -ne $false -or
        (P $ingress "targetPort") -ne 3002 -or (P $ingress "allowInsecure") -isnot [bool] -or (P $ingress "allowInsecure") -ne $false) {
        throw "Preview ingress safety contract failed."
    }
    if (@(Items (P $ingress "customDomains")).Count -gt 0) { throw "Custom domains must remain absent." }
    if ((P $ingress "fqdn") -ne $InternalFqdn) { throw "Unexpected internal FQDN." }
    Ok "Preview Gateway external=false, HTTPS-only, immutable digest, min=0/max=1, preview.invalid verified"
}

function ProbeJobs {
    return @(Items (J @("containerapp", "job", "list", "--subscription", $SubscriptionId, "-g", $Rg, "-o", "json", "--only-show-errors")) |
        Where-Object { (P $_ "name") -eq $JobName })
}

function Require-ProbeOwnership($Job) {
    if ((P $Job "name") -ne $JobName -or (P $Job.tags "probeId") -ne $ProbeId -or
        (P $Job.tags "project") -ne "atoms" -or (P $Job.tags "environment") -ne "staging" -or
        (P $Job.tags "purpose") -ne "preview-internal-health" -or (P $Job.tags "lifecycle") -ne "ephemeral" -or
        (P $Job.properties "environmentId") -ne $EnvironmentId) {
        throw "Probe ownership mismatch; do not start or delete this resource."
    }
}

function Cleanup {
    if (-not $script:JobMayExist) { return }
    $jobs = @(ProbeJobs)
    if ($jobs.Count -eq 0) { $script:JobMayExist = $false; return }
    if ($jobs.Count -ne 1) { throw "Ambiguous probe resource; cleanup not confirmed." }
    Require-ProbeOwnership $jobs[0]
    Write-Host "    NOTE: deleting owned ephemeral probe job $JobName"
    [void](Invoke-Az @("containerapp", "job", "delete", "--subscription", $SubscriptionId, "-g", $Rg, "-n", $JobName, "--yes", "--only-show-errors"))
    if (@(ProbeJobs).Count -ne 0) { throw "Ephemeral probe job deletion could not be verified." }
    $script:JobMayExist = $false
    Ok "Ephemeral probe job deletion verified"
}

function New-ProbeConfig($Image, $Location) {
    $identities = @{}
    $identities[$PullIdentity] = @{}
    return [ordered]@{
        name = $JobName
        location = $Location
        identity = @{ type = "UserAssigned"; userAssignedIdentities = $identities }
        tags = @{ project = "atoms"; environment = "staging"; purpose = "preview-internal-health"; lifecycle = "ephemeral"; probeId = $ProbeId }
        properties = @{
            environmentId = $EnvironmentId
            configuration = @{
                triggerType = "Manual"
                replicaTimeout = 120
                replicaRetryLimit = 0
                manualTriggerConfig = @{ parallelism = 1; replicaCompletionCount = 1 }
                registries = @(@{ server = $AcrServer; identity = $PullIdentity })
            }
            template = @{
                containers = @(@{
                    name = "preview-health-probe"
                    image = $Image
                    command = @("node")
                    args = @("--eval", $ProbeJavaScript)
                    env = @(@{ name = "TARGET_URL"; value = "https://$InternalFqdn/healthz" })
                    resources = @{ cpu = 0.25; memory = "0.5Gi" }
                })
            }
        }
    }
}

function Probe($Api, $Environment) {
    Step "Prepare file-based same-environment health probe"
    $containers = @(Items (P $Api.properties.template "containers"))
    if ($containers.Count -ne 1) { throw "Expected one Control API container." }
    $image = [string](P $containers[0] "image")
    if (-not $image.StartsWith("$AcrServer/", [StringComparison]::OrdinalIgnoreCase)) { throw "Control API image is not from staging ACR." }
    if ((P $Environment "id") -ne $EnvironmentId -or [string]::IsNullOrWhiteSpace([string](P $Environment "location"))) {
        throw "Exact staging environment/location required."
    }
    $identity = Invoke-Az @("identity", "show", "--subscription", $SubscriptionId, "-g", $Rg, "-n", "atoms-staging-acr-pull", "--query", "id", "-o", "tsv", "--only-show-errors")
    if ($identity -ne $PullIdentity) { throw "Staging ACR pull identity mismatch." }
    $help = Invoke-Az @("containerapp", "job", "create", "--help")
    if (-not $help.Contains("--yaml")) { throw "Container Apps Job --yaml support required." }
    if (@(ProbeJobs).Count -ne 0) { throw "Probe name already exists; no mutation performed." }

    $script:JobConfigPath = Join-Path ([IO.Path]::GetTempPath()) ("atoms-preview-probe-$ProbeId.yaml")
    $config = New-ProbeConfig $image (P $Environment "location")
    [IO.File]::WriteAllText($script:JobConfigPath, ($config | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
    # Creation may apply even if its CLI response fails. Finally must reconcile.
    $script:JobMayExist = $true
    Step "Create ephemeral same-environment Container Apps Job"
    [void](Invoke-Az @("containerapp", "job", "create", "--subscription", $SubscriptionId, "-g", $Rg, "-n", $JobName, "--yaml", $script:JobConfigPath, "--output", "none", "--only-show-errors"))
    $job = J @("containerapp", "job", "show", "--subscription", $SubscriptionId, "-g", $Rg, "-n", $JobName, "-o", "json", "--only-show-errors")
    Require-ProbeOwnership $job
    # Do not trust a Succeeded execution if ARM returned a changed payload.
    $actual = P $job.properties.template "containers"
    $expected = $config.properties.template.containers
    $pullIds = @($job.identity.userAssignedIdentities.PSObject.Properties.Name)
    $registries = @(Items (P $job.properties.configuration "registries"))
    if (@($actual).Count -ne 1 -or (P $actual[0] "image") -ne $image -or
        (P $job.identity "type") -ne "UserAssigned" -or $pullIds.Count -ne 1 -or $pullIds[0] -ne $PullIdentity -or
        $registries.Count -ne 1 -or (P $registries[0] "server") -ne $AcrServer -or (P $registries[0] "identity") -ne $PullIdentity -or
        $null -ne (P $registries[0] "username") -or $null -ne (P $registries[0] "passwordSecretRef") -or
        (@(P $actual[0] "command") -join "`n") -cne "node" -or
        (@(P $actual[0] "args") -join "`n") -cne ($expected[0].args -join "`n") -or
        @(Items (P $actual[0] "env")).Count -ne 1 -or (P $actual[0].env[0] "name") -cne "TARGET_URL" -or
        (P $actual[0].env[0] "value") -cne "https://$InternalFqdn/healthz" -or
        @(Items (P $job.properties.configuration "secrets")).Count -ne 0 -or
        $null -ne (P $job.properties.configuration "ingress") -or
        @(Items (P $job.properties.template "initContainers")).Count -ne 0 -or
        @(Items (P $job.properties.template "volumes")).Count -ne 0 -or
        (P $job.properties.configuration "triggerType") -ne "Manual" -or
        (P $job.properties.configuration "replicaRetryLimit") -ne 0 -or
        (P $job.properties.configuration "replicaTimeout") -ne 120 -or
        (P $job.properties.configuration.manualTriggerConfig "parallelism") -ne 1 -or
        (P $job.properties.configuration.manualTriggerConfig "replicaCompletionCount") -ne 1) {
        throw "Created probe payload/configuration changed; do not start it."
    }
    Ok "Ephemeral job verified; exact payload, no ingress, secrets, init containers or volumes"

    Step "Run exact internal health probe"
    $execution = Invoke-Az @("containerapp", "job", "start", "--subscription", $SubscriptionId, "-g", $Rg, "-n", $JobName, "--query", "name", "-o", "tsv", "--only-show-errors")
    if ([string]::IsNullOrWhiteSpace($execution)) { throw "Could not resolve this exact probe execution." }
    for ($attempt = 1; $attempt -le 36; $attempt++) {
        $result = J @("containerapp", "job", "execution", "show", "--subscription", $SubscriptionId, "-g", $Rg, "-n", $JobName, "--job-execution-name", $execution, "-o", "json", "--only-show-errors")
        $status = [string](P $result.properties "status")
        if ($status -eq "Succeeded") {
            Cleanup
            Ok 'Probe required HTTP 200 and exact body {"status":"ok"}; cleanup verified'
            return
        }
        if ($status -in @("Failed", "Stopped", "Degraded")) { throw "Probe job ended with status $status." }
        if ($attempt -lt 36) { Start-Sleep -Seconds 5 }
    }
    throw "Probe execution did not succeed within the bounded 180-second window."
}

try {
    Start-Transcript -Path $Transcript -Force | Out-Null
    $TranscriptStarted = $true
    Write-Host "Atoms Staging Preview Gateway Internal Health Smoke v4 (repository)" -ForegroundColor DarkGray
    Write-Host "Temporary same-environment Job; may wake Gateway scale 0 to 1. No public ingress, DNS/TLS, run execution, OpenAI or E2B." -ForegroundColor DarkGray
    Step "Lock Azure to Atoms-Staging"; Lock-Staging
    Step "Verify Control API safety"; $api = Verify-Api
    Step "Verify public exposure remains absent"; $environment = Verify-PublicBoundary
    Step "Verify Preview Gateway internal contract"; Verify-Preview
    Probe $api $environment
    Step "Re-verify safety"; Verify-Preview; [void](Verify-PublicBoundary); [void](Verify-Api); Lock-Staging
    Write-Host "`nPREVIEW GATEWAY INTERNAL HEALTH SMOKE SUCCEEDED" -ForegroundColor Green
    Write-Host 'Health response       : {"status":"ok"}'
    Write-Host "Ingress               : INTERNAL ONLY"
    Write-Host "Replicas              : min 0 / max 1"
    Write-Host "PREVIEW_BASE_DOMAIN   : preview.invalid"
    Write-Host "Public exposure       : NONE"
    Write-Host "RUN_EXECUTION_ENABLED : false"
    Write-Host "Provider execution    : NONE"
    Write-Host "Public preview stays blocked without an owned domain/wildcard TLS."
} finally {
    try { Cleanup } catch { Write-Warning "Cleanup NOT confirmed: $($_.Exception.Message). Review only $JobName in Atoms-Staging." }
    if ($null -ne $JobConfigPath -and [IO.File]::Exists($JobConfigPath)) {
        Remove-Item -LiteralPath $JobConfigPath -Force -ErrorAction SilentlyContinue
    }
    if ($TranscriptStarted) {
        try {
            Stop-Transcript | Out-Null
            Get-Content -LiteralPath $Transcript -Raw | Set-Clipboard
            Write-Host "`nFull transcript copied to clipboard.`nTranscript: $Transcript"
        } catch { Write-Warning "Could not copy transcript to clipboard." }
    }
}
