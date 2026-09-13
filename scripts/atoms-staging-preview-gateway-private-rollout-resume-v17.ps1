[CmdletBinding()]
param(
    [switch]$Apply,
    [switch]$CheckOnly,
    [string]$AzureConfigDirectory = "",
    [string]$ResumeCheckpoint = "",
    [string]$RollbackCheckpoint = ""
)

# Atoms Staging Preview Gateway private full-image rollout resume v17.
# This script resumes only the already-succeeded ACR build run cxg from the
# original v13 preflight checkpoint. It has no code path that queues a build.
# The v13 build nonce remains evidence only; each invocation creates a fresh
# attempt nonce so prior -a/-r revision names and Job names are never reused.
# Default with -ResumeCheckpoint: read-only reconciliation. Adding -Apply
# explicitly permits only Gateway image/mode/revision-suffix/temporary
# minimum-replica changes plus one owned ephemeral internal health Job.
# Runtime probes DO NOT write Redis data, create runs, or contact OpenAI/E2B.
# No secret values are fetched by host-side PowerShell or copied into a Job.
# Rollback uses the known old immutable digest. Never deploy the VM-host workflow.
# Examples (use pwsh, not Windows PowerShell 5):
#   pwsh -NoProfile -File .\atoms-staging-preview-gateway-private-rollout-resume-v17.ps1 -CheckOnly
#   pwsh -NoProfile -File .\atoms-staging-preview-gateway-private-rollout-resume-v17.ps1 -ResumeCheckpoint C:\exact\v13-preflight-checkpoint.json
#   pwsh -NoProfile -File .\atoms-staging-preview-gateway-private-rollout-resume-v17.ps1 -ResumeCheckpoint C:\exact\v13-preflight-checkpoint.json -Apply
# Recovery after interruption uses this run's printed checkpoint path:
#   pwsh -NoProfile -File .\atoms-staging-preview-gateway-private-rollout-resume-v17.ps1 -RollbackCheckpoint C:\exact\v17-checkpoint.json
# The existing v12 profile is USERPROFILE\.azure-atoms unless AZURE_CONFIG_DIR
# or -AzureConfigDirectory specifies another existing authorized profile.
# Do not run concurrently with another Gateway deployment. Auth/permission
# failures STOP; no new credentials, public networking or force-overwrites.
# The existing ACR image/tag and local checkpoint/transcript remain for audit/recovery.
# Guard correction: ARM's region display name "Canada Central" and canonical
# "canadacentral" are equivalent. No other region or resource ID is accepted.
# The confirmed Gateway registry uses atoms-staging-runtime-mi. Preserve it;
# the ephemeral Job separately uses the existing atoms-staging-acr-pull identity.
# No identity, registry credential, role assignment or execution policy is changed.
# First run with -ResumeCheckpoint but WITHOUT -Apply after downloading.
#
# Pinned source: PR #64 merged and all five jobs of CI #174 passed.
# https://github.com/Kohzadi2023/atoms-platform/actions/runs/34709196072
# https://learn.microsoft.com/en-us/azure/container-registry/container-registry-tasks-overview
# https://learn.microsoft.com/en-us/rest/api/resource-manager/containerapps/container-apps/update?view=rest-resource-manager-containerapps-2025-01-01
# https://learn.microsoft.com/en-us/azure/redis/architecture

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
if ($PSVersionTable.PSVersion.Major -lt 7) { throw "PowerShell 7+ is required." }
if (($CheckOnly -and ($Apply -or $ResumeCheckpoint -or $RollbackCheckpoint)) -or
    ($RollbackCheckpoint -and ($Apply -or $ResumeCheckpoint)) -or
    ($Apply -and -not $ResumeCheckpoint)) {
    throw "Use -CheckOnly alone, -RollbackCheckpoint alone, or -ResumeCheckpoint with optional -Apply."
}
if (-not $CheckOnly -and -not $RollbackCheckpoint -and -not $ResumeCheckpoint) {
    throw "Resume requires the exact v13 preflight checkpoint. No build is queued."
}

$SubscriptionId = "2ac8ed24-166b-4325-89dc-829d64391ce9"
$ForbiddenSubscriptionId = "bbcaf423-9a71-43bc-9fc7-821ef012cd01"
$ResourceGroup = "atoms-staging-rg"
$EnvironmentName = "atoms-staging-env"
$PreviewName = "atoms-staging-preview-gateway"
$ApiName = "atoms-staging-control-api"
$AcrName = "atomsstaging91ce9"
$AcrServer = "$AcrName.azurecr.io"
$ScopeRoot = "/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroup"
$EnvironmentId = "$ScopeRoot/providers/Microsoft.App/managedEnvironments/$EnvironmentName"
$PreviewId = "$ScopeRoot/providers/Microsoft.App/containerApps/$PreviewName"
$GatewayPullIdentity = "$ScopeRoot/providers/Microsoft.ManagedIdentity/userAssignedIdentities/atoms-staging-runtime-mi"
$JobPullIdentity = "$ScopeRoot/providers/Microsoft.ManagedIdentity/userAssignedIdentities/atoms-staging-acr-pull"
$DefaultDomain = "proudpond-7f6fcfdd.canadacentral.azurecontainerapps.io"
$InternalFqdn = "$PreviewName.internal.$DefaultDomain"
$UiOrigin = "https://atoms-staging-web.$DefaultDomain"
$SourceSha = "b7947fa783f45b0dcbf96036f0313ba387812da9"
$SourceTree = "311bee9e6ac159fa2b0937817c8cd761e6325f6b"
$CiRunId = 34709196072
$GitHubRepo = "Kohzadi2023/atoms-platform"
$ResumeBuildRunId = "cxg"
$ResumeBuildTag = "private-runtime-b7947fa783f4-e95400a79f02"
$ResumeBuildDigest = "sha256:5b23a82293be920654d9c65b95d4ebfa9ea9bb2601045698d17375b9d8f69d0b"
$OldTag = "preview-gateway:private-skeleton-0482b37eab42"
$OldDigest = "sha256:53b70e9f6fa2fee00af2c02d70c6d5fdc281acde31532af1c2ab7d7278c9d994"
$OldImage = "$AcrServer/$OldTag"
$OldPinnedImage = "$AcrServer/preview-gateway@$OldDigest"
$AppApiVersion = "2025-01-01"
$RedisApiVersion = "2025-07-01"
$PreviewUrl = "https://management.azure.com" + $PreviewId + "?api-version=$AppApiVersion"
$RunId = [Guid]::NewGuid().ToString("N")
$RevisionPrefix = "pvrt-" + $RunId.Substring(0, 12)
$ResumeSourceRunId = ""
$BuildTag = ""
$NewImage = ""
$RunRoot = ""
$CheckpointPath = ""
$TranscriptPath = ""
$TranscriptStarted = $false
$AppMutationMayHaveApplied = $false
$CommitSucceeded = $false
$JobMayExist = $false
$JobName = "atoms-stg-pvrt-" + $RunId.Substring(0, 12)
$JobPayload = $null
$Original = $null
$Stage = "initialization"
$ExitStatus = 0
$AzLaunch = $null

function Step([string]$Text) { $script:Stage = $Text; Write-Host ""; Write-Host "==> $Text" -ForegroundColor Cyan }
function Ok([string]$Text) { Write-Host "    OK: $Text" -ForegroundColor Green }
function Note([string]$Text) { Write-Host "    NOTE: $Text" -ForegroundColor Yellow }
function P($Object, [string]$Name) {
    if ($null -eq $Object) { return $null }
    if ($Object -is [Collections.IDictionary]) { return ,$Object[$Name] }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return ,$property.Value
}
function Items($Value) { @($Value | Where-Object { $null -ne $_ }) }
function Copy-Data($Value) { ConvertTo-Json -InputObject $Value -Depth 100 | ConvertFrom-Json -AsHashtable -Depth 100 -NoEnumerate }
function Canonical($Value) {
    if ($null -eq $Value) { return $null }
    if ($Value -is [Collections.IDictionary]) {
        $sorted = [ordered]@{}
        foreach ($key in @($Value.Keys | Sort-Object -CaseSensitive)) { $sorted[$key] = Canonical $Value[$key] }
        return $sorted
    }
    if ($Value -is [Array] -or $Value -is [Collections.IList]) {
        $array = @(foreach ($item in $Value) { Canonical $item })
        return ,$array
    }
    return $Value
}
function Fingerprint($Value) {
    $json = ConvertTo-Json -InputObject (Canonical $Value) -Depth 100 -Compress
    $hash = [Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($json))
    return [Convert]::ToHexString($hash).ToLowerInvariant()
}
function Failure-Class([string]$Text) {
    if ($Text -match "AuthorizationFailed|Forbidden|does not have authorization|InsufficientPrivileges|status.?403") {
        return "ATOMS_AUTHORIZATION_DENIED: stop; review the configured Azure identity's access."
    }
    if ($Text -match "AADSTS|az login|Please run.*login|AuthenticationFailed|ExpiredAuthenticationToken") {
        return "ATOMS_AZURE_LOGIN_REQUIRED: use the existing staging Azure profile."
    }
    if ($Text -match "TooManyRequests|Too Many Requests|status.?429") {
        return "ATOMS_AZURE_RATE_LIMITED: stop and honor the service Retry-After interval."
    }
    if ($Text -match "Handshake status 404|status.?404.*Not Found") {
        return "ATOMS_AZURE_EXEC_HANDSHAKE_NOT_READY: the exact replica was running, but Azure's exec websocket endpoint was not ready."
    }
    if ($Text -match "ResourceNotFound|ParentResourceNotFound|was not found|could not be found") {
        return "ATOMS_REQUIRED_RESOURCE_NOT_FOUND."
    }
    return "ATOMS_AZURE_COMMAND_FAILED: raw output withheld to protect metadata."
}
function Get-AzLaunch {
    $command = Get-Command az.cmd -CommandType Application -ErrorAction SilentlyContinue
    if ($null -eq $command) { $command = Get-Command az -CommandType Application -ErrorAction SilentlyContinue }
    if ($null -eq $command) { throw "Azure CLI is required; no login or installer is run by this script." }
    $source = [string]$command.Source
    if ([IO.Path]::GetExtension($source) -ieq ".cmd") {
        # Reuse v12's successful MSI entry point; never send JS through cmd.exe.
        $python = [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $source) "..\python.exe"))
        if (-not [IO.File]::Exists($python)) { throw "Azure CLI MSI bundled python.exe was not resolved; no shell fallback is attempted." }
        return @{ FileName = $python; PrefixArgs = @("-Im", "azure.cli") }
    }
    if ([IO.Path]::GetExtension($source) -ieq ".bat") { throw "An Azure CLI native executable or supported MSI installation is required." }
    return @{ FileName = $source; PrefixArgs = @() }
}
function Invoke-AzProcess([string[]]$Arguments, [int]$TimeoutSeconds = 120) {
    if ($null -eq $script:AzLaunch) { $script:AzLaunch = Get-AzLaunch }
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $script:AzLaunch.FileName
    $info.UseShellExecute = $false
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.CreateNoWindow = $true
    foreach ($argument in @($script:AzLaunch.PrefixArgs) + $Arguments) { [void]$info.ArgumentList.Add([string]$argument) }
    $info.Environment["AZURE_CONFIG_DIR"] = $script:AzureConfigDirectory
    $info.Environment["AZURE_CORE_ONLY_SHOW_ERRORS"] = "true"
    $info.Environment["AZURE_CORE_NO_COLOR"] = "true"
    $info.Environment["AZURE_CORE_DISABLE_PROGRESS_BAR"] = "true"
    $info.Environment["AZURE_EXTENSION_USE_DYNAMIC_INSTALL"] = "no"
    $info.Environment["PYTHONUTF8"] = "1"
    $info.Environment["PYTHONIOENCODING"] = "utf-8"
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $info
    try {
        if (-not $process.Start()) { throw "ATOMS_AZURE_PROCESS_START_FAILED." }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        $timer = [Diagnostics.Stopwatch]::StartNew()
        while (-not $process.WaitForExit(500)) {
            if ($timer.Elapsed.TotalSeconds -ge $TimeoutSeconds) {
                try { $process.Kill($true) } catch { }
                throw "ATOMS_AZURE_COMMAND_TIMEOUT: a submitted operation may still require reconciliation."
            }
        }
        return @{ ExitCode = $process.ExitCode; Stdout = $stdoutTask.GetAwaiter().GetResult(); Stderr = $stderrTask.GetAwaiter().GetResult() }
    } finally { $process.Dispose() }
}
function Az([string[]]$Arguments, [int]$TimeoutSeconds = 120) {
    $result = Invoke-AzProcess -Arguments $Arguments -TimeoutSeconds $TimeoutSeconds
    if ($result.ExitCode -ne 0) { throw (Failure-Class ([string]$result.Stderr)) }
    return ([string]$result.Stdout).Trim()
}
function Parse-Json([string]$Raw) {
    $text = [regex]::Replace($Raw.Trim().TrimStart([char]0xFEFF), ([char]27 + "\[[0-?]*[ -/]*[@-~]"), "").Trim()
    if (-not $text) { throw "ATOMS_EMPTY_JSON_RESPONSE." }
    $start = $text.IndexOfAny([char[]]"[{")
    if ($start -gt 0) {
        # Accept only known spinner/whitespace prefix, never discard a suffix.
        if ($text.Substring(0, $start) -notmatch "^[\s/\\|.\-]*$") { throw "ATOMS_NON_JSON_RESPONSE." }
        $text = $text.Substring($start)
    }
    try { return ConvertFrom-Json -InputObject $text -AsHashtable -Depth 100 }
    catch { throw "ATOMS_NON_JSON_RESPONSE: no response content was printed." }
}
function J([string[]]$Arguments) { Parse-Json (Az $Arguments) }
function Arm-Get([string]$Id, [string]$Version) {
    if ($Id -notmatch ("^/subscriptions/" + [regex]::Escape($SubscriptionId) + "/")) { throw "ARM read target is outside Atoms-Staging." }
    J @("rest", "--method", "get", "--url", ("https://management.azure.com" + $Id + "?api-version=$Version"), "--subscription", $SubscriptionId, "--only-show-errors", "-o", "json")
}
function Get-Preview { Arm-Get $PreviewId $AppApiVersion }
function Container($App) {
    $containers = @(Items (P (P (P $App "properties") "template") "containers"))
    if ($containers.Count -ne 1) { throw "Expected exactly one Gateway container." }
    return $containers[0]
}
function Env-Record($App, [string]$Name) {
    $entries = @((Items (P (Container $App) "env")) | Where-Object { (P $_ "name") -ceq $Name })
    if ($entries.Count -gt 1) { throw "Duplicate Gateway environment variable." }
    if ($entries.Count -eq 0) { return $null }
    $record = $entries[0]
    if ($Name -ceq "PREVIEW_REDIS_MODE") {
        $record = Copy-Data $record
        # ARM/CLI may materialize an omitted optional property as null.
        if ($null -eq (P $record "secretRef")) { [void]$record.Remove("secretRef") }
    }
    return $record
}
function Env-Value($App, [string]$Name) { P (Env-Record $App $Name) "value" }
function Require-Flag($App, [string]$Name, [string]$Value) {
    if ((Env-Value $App $Name) -cne $Value) { throw "A required runtime flag changed." }
}
function Require-SecretRef($App, [string]$Name) {
    $entry = Env-Record $App $Name
    if ([string]::IsNullOrWhiteSpace([string](P $entry "secretRef")) -or -not [string]::IsNullOrEmpty([string](P $entry "value"))) {
        throw "Gateway Redis/signing settings must remain secret-reference-only."
    }
}
function Is-CanadaCentral($Location) {
    if ($Location -isnot [string]) { return $false }
    # Explicit known aliases only: no arbitrary stripping, fuzzy matching,
    # fallback region, resource move, or disabled location guard.
    return $Location -ieq "canadacentral" -or $Location -ieq "Canada Central"
}
function Gateway-IdentitySummary($App) {
    $id = P $App "id"; $location = P $App "location"
    $idState = if ($id -isnot [string] -or -not $id) { "MISSING_OR_INVALID" }
        elseif ($id -ieq $PreviewId) { "MATCH" } else { "MISMATCH" }
    $locationState = if ($location -isnot [string] -or -not $location) { "MISSING_OR_INVALID" }
        elseif ($location -ieq "canadacentral") { "CANONICAL_CANADA_CENTRAL" }
        elseif ($location -ieq "Canada Central") { "DISPLAY_CANADA_CENTRAL" } else { "UNEXPECTED_REGION" }
    # Only fixed classification labels are printed; never dump ARM objects,
    # private endpoints/IPs, Redis metadata or secret values.
    Note ("Gateway metadata: exact-resource-id=" + $idState + "; region-form=" + $locationState)
}
function Verify-PrivateApp($App) {
    if ((P $App "id") -isnot [string] -or (P $App "id") -ine $PreviewId) { throw "ATOMS_GATEWAY_RESOURCE_ID_MISMATCH" }
    if (-not (Is-CanadaCentral (P $App "location"))) { throw "ATOMS_GATEWAY_LOCATION_MISMATCH" }
    $properties = P $App "properties"
    if ((P $properties "environmentId") -ine $EnvironmentId) { throw "Gateway environment mismatch." }
    $configuration = P $properties "configuration"
    if ((P $configuration "activeRevisionsMode") -cne "Single") { throw "Single revision mode is required; no traffic configuration is changed." }
    $ingress = P $configuration "ingress"
    if ((P $ingress "external") -isnot [bool] -or (P $ingress "external") -ne $false -or
        (P $ingress "allowInsecure") -isnot [bool] -or (P $ingress "allowInsecure") -ne $false -or
        (P $ingress "targetPort") -ne 3002 -or (P $ingress "fqdn") -cne $InternalFqdn -or
        @(Items (P $ingress "customDomains")).Count -ne 0) { throw "Internal-only HTTPS/domain boundary changed; no ingress repair is attempted." }
    $traffic = @(Items (P $ingress "traffic"))
    if ($traffic.Count -gt 1 -or ($traffic.Count -eq 1 -and
        ((P $traffic[0] "latestRevision") -ne $true -or (P $traffic[0] "weight") -ne 100 -or
         (P $traffic[0] "label") -or (P $traffic[0] "revisionName")))) { throw "Only implicit/latest single-revision traffic is permitted." }
    $template = P $properties "template"
    if ((P (P $template "scale") "maxReplicas") -ne 1) { throw "Gateway maxReplicas must remain 1." }
    if (@(Items (P $template "initContainers")).Count -ne 0 -or @(Items (P $template "volumes")).Count -ne 0) { throw "Unexpected init container or volume; stop and review." }
    $container = Container $App
    if (@(Items (P $container "command")).Count -ne 0 -or @(Items (P $container "args")).Count -ne 0 -or
        @(Items (P $container "volumeMounts")).Count -ne 0) { throw "Image entry-point overrides or mounts exist; none are cleared automatically." }
    $allowed = @("REDIS_URL", "PREVIEW_SIGNING_SECRET", "PREVIEW_BASE_DOMAIN", "PREVIEW_UI_ORIGIN",
        "PREVIEW_PUBLIC_PROTOCOL", "PREVIEW_GATEWAY_HOST", "PREVIEW_GATEWAY_PORT", "PREVIEW_REDIS_MODE", "NODE_ENV")
    $envEntries = @(Items (P $container "env"))
    $names = @($envEntries | ForEach-Object { P $_ "name" })
    if (@($names | Select-Object -Unique).Count -ne $names.Count) { throw "Duplicate Gateway environment names." }
    foreach ($entry in $envEntries) { if ($allowed -cnotcontains (P $entry "name")) { throw "Unexpected Gateway environment variable; no credential or flag is copied." } }
    Require-SecretRef $App "REDIS_URL"
    Require-SecretRef $App "PREVIEW_SIGNING_SECRET"
    Require-Flag $App "PREVIEW_BASE_DOMAIN" "preview.invalid"
    Require-Flag $App "PREVIEW_UI_ORIGIN" $UiOrigin
    Require-Flag $App "PREVIEW_PUBLIC_PROTOCOL" "https"
    Require-Flag $App "PREVIEW_GATEWAY_PORT" "3002"
    if ((Env-Record $App "PREVIEW_GATEWAY_HOST") -and (Env-Value $App "PREVIEW_GATEWAY_HOST") -cne "0.0.0.0") { throw "Gateway bind address changed." }
    if ((Env-Record $App "NODE_ENV") -and (Env-Value $App "NODE_ENV") -cne "production") { throw "Gateway NODE_ENV changed." }
    $registries = @(Items (P $configuration "registries"))
    if ($registries.Count -ne 1) { throw "ATOMS_GATEWAY_REGISTRY_COUNT_MISMATCH" }
    if ((P $registries[0] "server") -cne $AcrServer) { throw "ATOMS_GATEWAY_REGISTRY_SERVER_MISMATCH" }
    if ((P $registries[0] "identity") -ine $GatewayPullIdentity) { throw "ATOMS_GATEWAY_PULL_IDENTITY_MISMATCH" }
    if ((P $registries[0] "username") -or (P $registries[0] "passwordSecretRef")) { throw "ATOMS_GATEWAY_REGISTRY_CREDENTIALS_UNEXPECTED" }
    $identities = P (P $App "identity") "userAssignedIdentities"
    if ($null -eq $identities -or @($identities.Keys | Where-Object { $_ -ieq $GatewayPullIdentity }).Count -ne 1) {
        throw "ATOMS_GATEWAY_PULL_IDENTITY_NOT_ASSIGNED"
    }
}
function App-Invariants($App) {
    Verify-PrivateApp $App
    $configuration = Copy-Data (P (P $App "properties") "configuration")
    # Require-PrivateApp already validates traffic. Normalize its two equivalent
    # implicit/explicit latest-only forms, not arbitrary traffic edits.
    $configuration.ingress.traffic = @(@{ latestRevision = $true; weight = 100 })
    $template = Copy-Data (P (P $App "properties") "template")
    [void]$template.Remove("revisionSuffix")
    [void]$template.scale.Remove("minReplicas")
    [void]$template.containers[0].Remove("image")
    $template.containers[0].env = @((Items $template.containers[0].env) | Where-Object { $_.name -cne "PREVIEW_REDIS_MODE" })
    $properties = P $App "properties"
    return Fingerprint @{
        id = P $App "id"; location = "canadacentral"; tags = P $App "tags"; identity = P $App "identity"
        configuration = $configuration; template = $template; environmentId = P $properties "environmentId"
        workloadProfileName = P $properties "workloadProfileName"; managedBy = P $App "managedBy"
        extendedLocation = P $App "extendedLocation"
    }
}
function Lock-Staging {
    [void](Az @("account", "set", "--subscription", $SubscriptionId, "--only-show-errors"))
    $account = J @("account", "show", "--subscription", $SubscriptionId, "-o", "json", "--only-show-errors")
    if ((P $account "id") -eq $ForbiddenSubscriptionId -or (P $account "id") -ne $SubscriptionId -or
        (P $account "name") -cne "Atoms-Staging" -or (P $account "state") -cne "Enabled") { throw "Atoms-Staging subscription lock failed." }
    Ok "Subscription locked to Atoms-Staging"
}
function Http-Safety([string]$Uri, [int]$Expected) {
    for ($attempt = 1; $attempt -le 4; $attempt++) {
        try {
            $response = Invoke-WebRequest -Uri $Uri -SkipHttpErrorCheck -MaximumRedirection 0 -TimeoutSec 25
            if ([int]$response.StatusCode -eq $Expected) { return }
        } catch { }
        if ($attempt -lt 4) { Note "Control API cold-start/network probe not ready; bounded retry."; Start-Sleep -Seconds 5 }
    }
    throw "Control API public auth/readiness safety probe failed."
}
function Verify-Boundaries {
    $apiId = "$ScopeRoot/providers/Microsoft.App/containerApps/$ApiName"
    $api = Arm-Get $apiId $AppApiVersion
    if ((P $api "id") -ine $apiId -or (P (P $api "properties") "environmentId") -ine $EnvironmentId) { throw "Control API identity/environment mismatch." }
    Require-Flag $api "AUTH_REQUIRED" "true"
    Require-Flag $api "RUN_EXECUTION_ENABLED" "false"
    Http-Safety "https://$ApiName.$DefaultDomain/readyz" 200
    Http-Safety "https://$ApiName.$DefaultDomain/v1/me" 401
    $environment = J @("containerapp", "env", "show", "--subscription", $SubscriptionId, "-g", $ResourceGroup, "-n", $EnvironmentName, "-o", "json", "--only-show-errors")
    if ((P $environment "id") -ine $EnvironmentId -or (P (P $environment "properties") "defaultDomain") -cne $DefaultDomain) { throw "Container Apps environment changed." }
    $custom = P (P $environment "properties") "customDomainConfiguration"
    if ((P $custom "dnsSuffix") -or (P $custom "certificateValue") -or (P $custom "certificateKeyVaultProperties")) { throw "Environment custom DNS/TLS now exists." }
    $certificates = @(J @("containerapp", "env", "certificate", "list", "--subscription", $SubscriptionId, "-g", $ResourceGroup, "-n", $EnvironmentName, "-o", "json", "--only-show-errors"))
    $zones = @(J @("resource", "list", "--subscription", $SubscriptionId, "-g", $ResourceGroup, "--resource-type", "Microsoft.Network/dnszones", "-o", "json", "--only-show-errors"))
    $routes = @(J @("resource", "list", "--subscription", $SubscriptionId, "-g", $ResourceGroup, "--resource-type", "Microsoft.App/managedEnvironments/httpRouteConfigs", "-o", "json", "--only-show-errors"))
    if ($certificates.Count -or $zones.Count -or $routes.Count) { throw "Public DNS/TLS/route boundary changed." }
    Ok "AUTH_REQUIRED=true; RUN_EXECUTION_ENABLED=false; readyz=200; unauth /v1/me=401; no public preview DNS/TLS/routes"
    return $environment
}
function Public-GitHub([string]$Path) {
    try { Invoke-RestMethod -Uri ("https://api.github.com/repos/" + $GitHubRepo + "/" + $Path) -Headers @{ Accept = "application/vnd.github+json"; "User-Agent" = "Atoms-Private-Rollout-Resume-v17" } -TimeoutSec 30 }
    catch { throw "Public GitHub verification failed; no private credentials or alternate source are used." }
}
function Verify-Source {
    $commit = Public-GitHub "git/commits/$SourceSha"
    $run = Public-GitHub "actions/runs/$CiRunId"
    $jobs = Public-GitHub "actions/runs/$CiRunId/jobs?per_page=100"
    if ($commit.sha -cne $SourceSha -or $commit.tree.sha -cne $SourceTree -or
        $run.head_sha -cne $SourceSha -or $run.status -cne "completed" -or $run.conclusion -cne "success" -or
        $run.event -cne "push" -or $run.head_branch -cne "main") { throw "Pinned commit/tree/full-main CI proof mismatch." }
    $expected = @("attachment-storage-integration", "changes", "migration-matrix", "preview-runtime-integration", "verify")
    if (@($jobs.jobs).Count -ne 5 -or (@($jobs.jobs.name | Sort-Object) -join "|") -cne ($expected -join "|") -or
        @($jobs.jobs | Where-Object { $_.status -cne "completed" -or $_.conclusion -cne "success" }).Count) { throw "Required full CI jobs did not all pass." }
    Ok "Pinned public Git source SHA/tree and all five CI #174 jobs verified"
}
function Require-PrivateIp([string]$Address) {
    $ip = $null
    if (-not [Net.IPAddress]::TryParse($Address, [ref]$ip) -or $ip.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) { throw "PE IPv4 metadata missing." }
    $bytes = $ip.GetAddressBytes()
    if (-not ($bytes[0] -eq 10 -or ($bytes[0] -eq 172 -and $bytes[1] -ge 16 -and $bytes[1] -le 31) -or ($bytes[0] -eq 192 -and $bytes[1] -eq 168))) { throw "PE IP is not RFC1918 private." }
}
function Vnet-FromSubnet([string]$Id) {
    if ($Id -notmatch ("^/subscriptions/" + [regex]::Escape($SubscriptionId) + "/resourceGroups/[^/]+/providers/Microsoft.Network/virtualNetworks/[^/]+/subnets/[^/]+$")) { throw "VNet/subnet is outside the authorized subscription or malformed." }
    return $Id.Substring(0, $Id.LastIndexOf("/subnets/", [StringComparison]::OrdinalIgnoreCase))
}
function Get-RedisBaseline($Environment) {
    $roots = @(J @("resource", "list", "--subscription", $SubscriptionId, "-g", $ResourceGroup, "--resource-type", "Microsoft.Cache/redisEnterprise", "-o", "json", "--only-show-errors"))
    if ($roots.Count -ne 1) { throw "Exactly one staging Managed Redis root required." }
    $rootId = [string](P $roots[0] "id")
    if ($rootId -notmatch ("^" + [regex]::Escape($ScopeRoot) + "/providers/Microsoft.Cache/redisEnterprise/[^/]+$")) { throw "Redis resource ID is outside the reviewed staging group." }
    $root = Arm-Get $rootId $RedisApiVersion
    $p = P $root "properties"
    $hostName = ([string](P $p "hostName")).Trim().TrimEnd(".").ToLowerInvariant()
    if ((P $p "provisioningState") -ine "Succeeded" -or (P $p "resourceState") -ine "Running" -or
        (P $p "publicNetworkAccess") -ine "Disabled" -or $hostName -notmatch "^[a-z0-9-]+\.[a-z0-9-]+\.redis\.azure\.net$") { throw "Private Managed Redis baseline changed." }
    $children = Arm-Get ($rootId + "/databases") $RedisApiVersion
    $databases = @(Items (P $children "value"))
    if ($databases.Count -ne 1) { throw "Exactly one Redis database required." }
    $db = P $databases[0] "properties"
    if ((P $db "provisioningState") -ine "Succeeded" -or (P $db "resourceState") -ine "Running" -or
        (P $db "clientProtocol") -ine "Encrypted" -or (P $db "accessKeysAuthentication") -ine "Enabled" -or
        (P $db "clusteringPolicy") -cne "OSSCluster" -or (P $db "port") -ne 10000) { throw "Redis must be running, encrypted OSSCluster with existing key auth and port 10000." }
    $vnet = Vnet-FromSubnet ([string](P (P (P $Environment "properties") "vnetConfiguration") "infrastructureSubnetId"))
    $endpoints = @(J @("network", "private-endpoint", "list", "--subscription", $SubscriptionId, "-g", $ResourceGroup, "-o", "json", "--only-show-errors"))
    $targeted = @(foreach ($endpoint in $endpoints) {
        $connections = @(Items (P $endpoint "privateLinkServiceConnections")) + @(Items (P $endpoint "manualPrivateLinkServiceConnections"))
        if (@($connections | Where-Object { (P $_ "privateLinkServiceId") -ieq $rootId }).Count) { $endpoint }
    })
    if ($targeted.Count -ne 1) { throw "Exactly one Redis-targeted staging private endpoint required." }
    $endpoint = $targeted[0]
    if ((P $endpoint "id") -notmatch ("^" + [regex]::Escape($ScopeRoot) + "/providers/Microsoft.Network/privateEndpoints/[^/]+$")) { throw "PE resource ID is outside the reviewed staging group." }
    $connections = @(Items (P $endpoint "privateLinkServiceConnections")) + @(Items (P $endpoint "manualPrivateLinkServiceConnections"))
    $subnet = [string](P (P $endpoint "subnet") "id")
    if ($connections.Count -ne 1 -or (P $connections[0] "privateLinkServiceId") -ine $rootId -or
        (P (P $connections[0] "privateLinkServiceConnectionState") "status") -ine "Approved" -or
        (@(Items (P $connections[0] "groupIds")) -join "|") -cne "redisEnterprise" -or
        (P $endpoint "provisioningState") -ine "Succeeded" -or (Vnet-FromSubnet $subnet) -ine $vnet) { throw "Redis PE approval/group/same-VNet contract changed." }
    $nics = @(Items (P $endpoint "networkInterfaces"))
    if ($nics.Count -ne 1) { throw "Exactly one Redis PE NIC required." }
    if ((P $nics[0] "id") -notmatch ("^/subscriptions/" + [regex]::Escape($SubscriptionId) + "/resourceGroups/[^/]+/providers/Microsoft.Network/networkInterfaces/[^/]+$")) { throw "PE NIC read target is outside the authorized subscription." }
    $nic = J @("network", "nic", "show", "--subscription", $SubscriptionId, "--ids", ([string](P $nics[0] "id")), "-o", "json", "--only-show-errors")
    $addresses = @(foreach ($configuration in @(Items (P $nic "ipConfigurations"))) {
        if ((P (P $configuration "subnet") "id") -ine $subnet) { throw "PE NIC subnet mismatch." }
        $address = [string](P $configuration "privateIPAddress"); Require-PrivateIp $address; $address
    })
    $ips = @($addresses | Sort-Object -Unique)
    if ($ips.Count -lt 1 -or $ips.Count -gt 4) { throw "Unexpected Redis PE IP set." }
    $groups = @(J @("network", "private-endpoint", "dns-zone-group", "list", "--subscription", $SubscriptionId, "-g", $ResourceGroup, "--endpoint-name", ([string](P $endpoint "name")), "-o", "json", "--only-show-errors"))
    if ($groups.Count -ne 1 -or (P $groups[0] "provisioningState") -ine "Succeeded") { throw "The v12 private DNS repair is not established; no DNS repair is performed here." }
    $configs = @(Items (P $groups[0] "privateDnsZoneConfigs"))
    if ($configs.Count -ne 1 -or ([string](P $configs[0] "privateDnsZoneId")) -notmatch
        ("^/subscriptions/" + [regex]::Escape($SubscriptionId) + "/resourceGroups/[^/]+/providers/Microsoft.Network/privateDnsZones/privatelink\.redis\.azure\.net$")) { throw "Redis private DNS zone attachment changed." }
    Ok "Redis running/private/encrypted OSSCluster; Approved PE in same VNet; existing DNS zone group verified"
    return @{ RootId = $rootId; HostName = $hostName; PrivateIps = $ips; MetadataHash = Fingerprint @{ root = $root; database = $databases[0]; endpoint = $endpoint; nic = $nic; zoneGroups = $groups } }
}
function Own-File([string]$Name, $Data) {
    if (-not $script:RunRoot -or [IO.Path]::GetFileName($Name) -cne $Name) { throw "Unsafe local audit-file target." }
    $path = Join-Path $script:RunRoot $Name
    $json = ConvertTo-Json -InputObject $Data -Depth 100
    $stream = [IO.File]::Open($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $bytes = [Text.Encoding]::UTF8.GetBytes($json); $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
    return $path
}
function Save-Checkpoint([string]$Phase) {
    if ($script:RunId -notmatch "^[a-f0-9]{32}$" -or $script:ResumeSourceRunId -notmatch "^[a-f0-9]{32}$" -or
        $script:RevisionPrefix -cne ("pvrt-" + $script:RunId.Substring(0, 12)) -or
        $script:BuildTag -cne $ResumeBuildTag) { throw "Resume checkpoint identity is incomplete or inconsistent." }
    # Keep the reviewed v15+ recovery schema stable so interrupted v15/v16/v17
    # attempts remain recoverable by the same narrow importer.
    $data = @{
        format = "ATOMS_PREVIEW_PRIVATE_ROLLOUT_RESUME_V15"; sourceSha = $SourceSha
        resumeSourceRunId = $script:ResumeSourceRunId; attemptId = $script:RunId
        previewId = $PreviewId; revisionPrefix = $script:RevisionPrefix; original = $script:Original
        newImage = $script:NewImage; buildTag = $script:BuildTag; phase = $Phase
        createdAtUtc = [DateTime]::UtcNow.ToString("o")
    }
    $temp = Own-File ("checkpoint-" + [Guid]::NewGuid().ToString("N") + ".json") $data
    if (-not $script:CheckpointPath) { $script:CheckpointPath = Join-Path $script:RunRoot "rollback-checkpoint.json" }
    [IO.File]::Move($temp, $script:CheckpointPath, $true)
}
function Capture-Original($App) {
    Verify-PrivateApp $App
    $image = [string](P (Container $App) "image")
    if ($image -cne $OldImage -and $image -cne $OldPinnedImage) { throw "Gateway is not the reviewed private-skeleton baseline; no automatic re-baselining is permitted." }
    $minimum = P (P (P (P $App "properties") "template") "scale") "minReplicas"
    $mode = Env-Record $App "PREVIEW_REDIS_MODE"
    if ($null -eq $minimum -or $minimum -ne 0 -or
        ($null -ne $mode -and (Fingerprint $mode) -cne (Fingerprint @{ name = "PREVIEW_REDIS_MODE"; value = "standalone" }))) { throw "Initial min=0 and absent/literal-standalone Redis mode required." }
    $digest = Az @("acr", "repository", "show", "--subscription", $SubscriptionId, "-n", $AcrName, "--image", $OldTag, "--query", "digest", "-o", "tsv", "--only-show-errors")
    if ($digest.Trim() -cne $OldDigest) { throw "Pinned rollback image digest mismatch." }
    return @{ invariants = App-Invariants $App; mode = Copy-Data $mode; image = $image; suffix = P (P (P $App "properties") "template") "revisionSuffix" }
}
function Resume-BaselineState($Current, $Reviewed) {
    if ((P $Current "invariants") -cne (P $Reviewed "invariants") -or
        (Fingerprint (P $Current "mode")) -cne (Fingerprint (P $Reviewed "mode")) -or
        (P $Current "image") -notin @($OldImage, $OldPinnedImage) -or
        (P $Reviewed "image") -notin @($OldImage, $OldPinnedImage)) {
        return "MISMATCH"
    }
    if ((P $Current "suffix") -ceq (P $Reviewed "suffix")) { return "REVIEWED_ORIGINAL" }
    # A prior rollout rollback intentionally re-pins the known old digest and uses a
    # fresh script-owned -r suffix. Accept only that exact, invariant-equivalent
    # safe baseline so a failed attempt can be resumed without re-baselining.
    if ((P $Current "image") -ceq $OldPinnedImage -and
        (P $Current "suffix") -match "^pvrt-[a-f0-9]{12}-r$") {
        return "CONFIRMED_ROLLOUT_ROLLBACK"
    }
    return "MISMATCH"
}
function Resolve-ReusedBuild {
    if ($script:BuildTag -cne $ResumeBuildTag) { throw "ATOMS_RESUME_BUILD_TAG_MISMATCH" }
    $run = J @("acr", "task", "show-run", "--subscription", $SubscriptionId, "-g", $ResourceGroup, "-r", $AcrName,
        "--run-id", $ResumeBuildRunId, "-o", "json", "--only-show-errors")
    if ((P $run "runId") -cne $ResumeBuildRunId -or (P $run "status") -cne "Succeeded") {
        throw "ATOMS_RESUME_BUILD_RUN_MISMATCH"
    }
    $platform = P $run "platform"
    if ($null -eq $platform -or (P $platform "os") -ine "linux" -or (P $platform "architecture") -ine "amd64") {
        throw "ATOMS_RESUME_BUILD_PLATFORM_MISMATCH"
    }
    $outputs = @(Items (P $run "outputImages"))
    if ($outputs.Count -ne 1) { throw "ATOMS_RESUME_BUILD_OUTPUT_MISMATCH" }
    $output = $outputs[0]
    $reportedRegistry = P $output "registry"
    if (($reportedRegistry -and $reportedRegistry -cne $AcrServer) -or
        (P $output "repository") -cne "preview-gateway" -or
        (P $output "tag") -cne $ResumeBuildTag -or
        (P $output "digest") -cne $ResumeBuildDigest) {
        throw "ATOMS_RESUME_BUILD_OUTPUT_MISMATCH"
    }
    $repositoryDigest = Az @("acr", "repository", "show", "--subscription", $SubscriptionId, "-n", $AcrName,
        "--image", ("preview-gateway:" + $ResumeBuildTag), "--query", "digest", "-o", "tsv", "--only-show-errors")
    if ($repositoryDigest.Trim() -cne $ResumeBuildDigest) { throw "ATOMS_RESUME_REPOSITORY_DIGEST_MISMATCH" }
    Ok "Existing ACR run cxg, Linux/amd64 output tag and immutable repository digest agree; no build was queued"
    return "$AcrServer/preview-gateway@$ResumeBuildDigest"
}
function Require-OwnedState($App) {
    $hash = App-Invariants $App
    if ($hash -cne $script:Original.invariants) { throw "Gateway configuration drift detected; refusing to overwrite unrelated changes." }
    $container = Container $App
    $image = [string](P $container "image")
    $template = P (P $App "properties") "template"
    $suffix = [string](P $template "revisionSuffix")
    $minimum = P (P $template "scale") "minReplicas"
    $mode = Env-Record $App "PREVIEW_REDIS_MODE"
    if (($image -ceq $script:Original.image -or $image -ceq $OldPinnedImage) -and
        $minimum -eq 0 -and (Fingerprint $mode) -ceq (Fingerprint $script:Original.mode)) { return }
    $expectedMode = @{ name = "PREVIEW_REDIS_MODE"; value = "oss-cluster" }
    $expectedMinimum = if ($suffix -ceq "$($script:RevisionPrefix)-a") { 1 } else { 0 }
    if ($image -cne $script:NewImage -or $suffix -notin @("$($script:RevisionPrefix)-a", "$($script:RevisionPrefix)-z") -or
        $minimum -ne $expectedMinimum -or (Fingerprint $mode) -cne (Fingerprint $expectedMode)) {
        throw "Gateway is not an original or exact script-owned state; no rollback overwrite."
    }
}
function Patch-Preview([string]$Image, [int]$Minimum, $Mode, [string]$Suffix) {
    if ($Image -cne $OldPinnedImage -and $Image -cne $script:NewImage) { throw "Unapproved image patch target." }
    if ($Minimum -notin @(0, 1) -or $Suffix -notin @("$($script:RevisionPrefix)-a", "$($script:RevisionPrefix)-z", "$($script:RevisionPrefix)-r")) { throw "Unapproved scale/revision patch." }
    $current = Get-Preview
    Require-OwnedState $current
    $container = Copy-Data (Container $current)
    $container.image = $Image
    $container.env = @((Items (P $container "env")) | Where-Object { (P $_ "name") -cne "PREVIEW_REDIS_MODE" })
    if ($null -ne $Mode) { $container.env += @(Copy-Data $Mode) }
    # JSON Merge Patch preserves omitted configuration/identity/secrets/network.
    # The container array must be sent whole: it is copied only from the freshly
    # guarded current metadata, with exactly image and one mode entry changed.
    $patch = @{
        location = "canadacentral"
        properties = @{ template = @{ containers = @($container); scale = @{ minReplicas = $Minimum }; revisionSuffix = $Suffix } }
    }
    $path = Own-File ("patch-" + [Guid]::NewGuid().ToString("N") + ".json") $patch
    $script:AppMutationMayHaveApplied = $true
    Save-Checkpoint "patch-may-apply"
    $arguments = @("rest", "--method", "patch", "--subscription", $SubscriptionId, "--url", $PreviewUrl, "--body", ("@" + $path), "--only-show-errors", "-o", "none")
    $etag = [string](P $current "etag")
    if ($etag) { $arguments += @("--headers", ("If-Match=" + $etag)) }
    [void](Az $arguments)
    # Do not claim atomic concurrency when the RP exposes no ETag. Both checks
    # and ownership reconciliation are required regardless of ETag availability.
    for ($attempt = 1; $attempt -le 60; $attempt++) {
        $app = Get-Preview
        Require-OwnedState $app
        $p = P $app "properties"
        $template = P $p "template"
        if ((P $p "provisioningState") -in @("Failed", "Canceled")) { throw "Gateway revision provisioning failed." }
        if ((P $p "provisioningState") -ceq "Succeeded" -and (P (Container $app) "image") -ceq $Image -and
            (P (P $template "scale") "minReplicas") -eq $Minimum -and (P $template "revisionSuffix") -ceq $Suffix -and
            (Fingerprint (Env-Record $app "PREVIEW_REDIS_MODE")) -ceq (Fingerprint $Mode)) {
            Save-Checkpoint "patch-confirmed"
            return $app
        }
        if ($attempt -lt 60) { Start-Sleep -Seconds 5 }
    }
    throw "Gateway patch was not confirmed; reconcile and roll back only owned state."
}
function Restore-Original {
    $current = Get-Preview
    Require-OwnedState $current
    $template = P (P $current "properties") "template"
    if (((P (Container $current) "image") -ceq $script:Original.image -or (P (Container $current) "image") -ceq $OldPinnedImage) -and
        (P (P $template "scale") "minReplicas") -eq 0 -and
        (Fingerprint (Env-Record $current "PREVIEW_REDIS_MODE")) -ceq (Fingerprint $script:Original.mode)) {
        Wait-OriginalReady
        $script:AppMutationMayHaveApplied = $false
        Ok "Original image/mode and min=0/max=1 already present"
        return
    }
    Note "Restoring only the reviewed old digest, original Redis mode and min=0; ingress/secrets/network are not patched."
    [void](Patch-Preview $OldPinnedImage 0 $script:Original.mode "$($script:RevisionPrefix)-r")
    Wait-OriginalReady
    $script:AppMutationMayHaveApplied = $false
    Save-Checkpoint "rolled-back"
    Ok "Rollback confirmed: pinned private-skeleton digest, original mode, internal-only HTTPS, min=0/max=1"
}
function Wait-OriginalReady {
    for ($attempt = 1; $attempt -le 48; $attempt++) {
        $app = Get-Preview; Require-OwnedState $app; $p = P $app "properties"
        if ((P (Container $app) "image") -notin @($script:Original.image, $OldPinnedImage) -or
            (P (P (P $p "template") "scale") "minReplicas") -ne 0 -or
            (Fingerprint (Env-Record $app "PREVIEW_REDIS_MODE")) -cne (Fingerprint $script:Original.mode)) { throw "Reviewed original configuration not present." }
        if ((P $p "provisioningState") -in @("Failed", "Canceled")) { throw "Rollback configuration provisioning failed." }
        if ((P $p "provisioningState") -ceq "Succeeded" -and (P $p "latestRevisionName") -and
            (P $p "latestReadyRevisionName") -ceq (P $p "latestRevisionName")) { return }
        if ($attempt -lt 48) { Start-Sleep -Seconds 5 }
    }
    throw "Reviewed original ready revision not confirmed."
}
function Find-Replica {
    $revision = "$PreviewName--$($script:RevisionPrefix)-a"
    for ($attempt = 1; $attempt -le 60; $attempt++) {
        $app = Get-Preview; Require-OwnedState $app
        if ((P (Container $app) "image") -cne $script:NewImage) { throw "Exact new image is not active." }
        $revisions = @(J @("containerapp", "revision", "list", "--subscription", $SubscriptionId, "-g", $ResourceGroup, "-n", $PreviewName, "-o", "json", "--only-show-errors"))
        $exact = @($revisions | Where-Object { (P $_ "name") -ceq $revision })
        if ($exact.Count -eq 1) {
            $r = P $exact[0] "properties"
            if ($null -eq $r) { $r = $exact[0] }
            $rc = @(Items (P (P $r "template") "containers"))
            if ($rc.Count -ne 1 -or (P $rc[0] "image") -cne $script:NewImage) { throw "Exact revision template is not the built immutable image." }
            if ((P $r "active") -eq $true -and (P $r "provisioningState") -ceq "Provisioned" -and (P $r "healthState") -in @("Healthy", "None", $null, "")) {
                $replicas = @(J @("containerapp", "replica", "list", "--subscription", $SubscriptionId, "-g", $ResourceGroup, "-n", $PreviewName,
                    "--revision", $revision, "-o", "json", "--only-show-errors"))
                if ($replicas.Count -eq 1) {
                    $replicaName = [string](P $replicas[0] "name")
                    $rp = P $replicas[0] "properties"; if ($null -eq $rp) { $rp = $replicas[0] }
                    $containers = @(Items (P $rp "containers"))
                    $name = [string](P (Container $app) "name")
                    if ($replicaName.StartsWith("$revision-", [StringComparison]::Ordinal) -and
                        @($containers | Where-Object { (P $_ "name") -ceq $name -and (P $_ "runningState") -in @("Running", "running") }).Count -eq 1) {
                        Ok "Exact script-owned revision/replica/container resolved"
                        return @{ Revision = $revision; Replica = $replicaName; Container = $name }
                    }
                }
            }
        }
        if ($attempt % 6 -eq 1) { Note "Waiting for only the exact new private revision; no latest/old replica fallback." }
        if ($attempt -lt 60) { Start-Sleep -Seconds 5 }
    }
    throw "Exact new private replica did not become ready."
}

# One deliberately short exec session, dependency resolution rooted at /app,
# and fixed nonce-bound tokens only. Repeated Azure websocket 404s correlated
# with the prior 3.8 KB command carrier; keep this carrier below 1.8 KB while
# retaining the package/private-DNS/TLS-cluster/read-only-store/local-health
# release gates. HTTP/WS routing behavior remains covered by pinned CI #174.
# The store receives a read-only adapter, so even an unexpected existing record
# cannot reach its expired-record DEL branch.
$RuntimeJavaScript = @'
const a=require('node:assert/strict'),d=require('node:dns').promises,{randomUUID}=require('node:crypto'),{createRequire}=require('node:module'),{pathToFileURL}=require('node:url');
let p='PACKAGE',c,f=false;const t=x=>console.log('ATOMS_PVRT_'+x+':'+K.nonce),b=(x,m=15000)=>Promise.race([x,new Promise((_,j)=>setTimeout(()=>j(Error()),m))]);
(async()=>{const z=setTimeout(()=>{t('FAILED_TIMEOUT');process.exit(1)},80000);try{
a.notEqual(process.getuid(),0);const r=createRequire('/app/package.json'),q=r.resolve('@atoms/preview'),v=await import(pathToFileURL(q).href),{Cluster:C}=createRequire(q)('ioredis'),u=new URL(process.env.REDIS_URL);
a.equal(process.env.PREVIEW_REDIS_MODE,'oss-cluster');a.equal(u.protocol,'rediss:');a.equal(u.hostname.toLowerCase(),K.host);a.equal(u.port,'10000');
const o=v.previewRedisClusterConfiguration(process.env.REDIS_URL);a.equal(o.options.redisOptions.tls.rejectUnauthorized,true);a.equal(o.options.redisOptions.tls.servername,K.host);t('PACKAGE_OK');
p='PRIVATE_DNS';const h=await b(d.lookup(K.host,{all:true,family:4}));a.deepEqual([...new Set(h.map(x=>x.address))].sort(),[...K.ips].sort());t('PRIVATE_DNS_OK');
p='REDIS_CLUSTER';c=new C(o.nodes,{...o.options,lazyConnect:true});c.on('error',()=>{});await b(c.connect(),25000);const n=c.nodes('master');a.ok(n.length);for(const x of n)a.equal(await b(x.ping()),'PONG');t('REDIS_CLUSTER_OK');
p='STORE_READ';const w=async()=>{throw Error()};const s=new v.RedisPreviewSessionStore({redisMode:'oss-cluster',client:{get:k=>c.get(k),set:w,del:w,quit:async()=>{},disconnect:()=>{}}});a.equal(await b(s.get(randomUUID())),null);t('STORE_READ_OK');
p='LOCAL_HEALTH';const x=await fetch('http://127.0.0.1:3002/healthz',{signal:AbortSignal.timeout(5000)});a.equal(x.status,200);a.equal(await x.text(),'{"status":"ok"}');a.match(String(x.headers.get('cache-control')),/no-store/);t('LOCAL_HEALTH_OK');
}catch{f=true;t('FAILED_'+p)}finally{try{if(c)await b(c.quit(),5000)}catch{f=true;t('FAILED_CLOSE')}finally{if(c)c.disconnect();clearTimeout(z)}}if(!f){t('CLIENT_CLOSED_OK');t('RUNTIME_OK')}process.exit(f?1:0)})();
'@

$HealthJavaScript = @'
const https=require('node:https');
const expected=Buffer.from('{"status":"ok"}');
const timer=setTimeout(()=>process.exit(1),90000);
const request=https.get(process.env.TARGET_URL,{rejectUnauthorized:true,timeout:70000},response=>{
  const chunks=[];let size=0;response.on('data',c=>{size+=c.length;if(size>1024)request.destroy();else chunks.push(c);});
  response.on('error',()=>process.exit(1));
  response.on('end',()=>{clearTimeout(timer);process.exit(response.statusCode===200&&Buffer.concat(chunks).equals(expected)?0:1);});
});
request.on('timeout',()=>request.destroy());request.on('error',()=>process.exit(1));
'@

function Runtime-Command($Redis) {
    $context = @{ host = $Redis.HostName; ips = @($Redis.PrivateIps); nonce = $script:RunId }
    $source = "const K=" + (ConvertTo-Json -InputObject $context -Compress -Depth 5) + ";" + [Environment]::NewLine + $RuntimeJavaScript
    $memory = [IO.MemoryStream]::new()
    $gzip = [IO.Compression.GZipStream]::new($memory, [IO.Compression.CompressionLevel]::SmallestSize, $true)
    try { $bytes = [Text.Encoding]::UTF8.GetBytes($source); $gzip.Write($bytes, 0, $bytes.Length) } finally { $gzip.Dispose() }
    try { $encoded = [Convert]::ToBase64String($memory.ToArray()).TrimEnd("=").Replace("+", "-").Replace("/", "_") } finally { $memory.Dispose() }
    if ($encoded -notmatch "^[A-Za-z0-9_-]+$") { throw "Runtime carrier encoding failed." }
    $quote = [char]34
    $command = "node -e " + $quote + "eval(require('zlib').gunzipSync(Buffer.from('" + $encoded + "','base64url')).toString('utf8'))" + $quote
    if ($command.Length -gt 1800) { throw "Short runtime carrier exceeded the reviewed 1800-character ceiling; no mutation permitted." }
    return $command
}
function Get-RuntimeOutcome([string]$Output) {
    # Azure's exec websocket bridge may route the remote program's terminal
    # frames through either CLI stream. The caller therefore supplies one
    # combined stdout/stderr transcript. The compressed --command argument does
    # not contain literal signal text or the nonce, so bounded token matching
    # cannot mistake an echoed carrier for probe proof.
    # This function deliberately returns only a bounded code; raw exec output is
    # never surfaced because it may contain Azure or private-network metadata.
    $plain = [regex]::Replace($Output, ([char]27 + "\[[0-?]*[ -/]*[@-~]"), "")
    $required = @("PACKAGE_OK", "PRIVATE_DNS_OK", "REDIS_CLUSTER_OK", "STORE_READ_OK",
        "LOCAL_HEALTH_OK", "CLIENT_CLOSED_OK", "RUNTIME_OK")
    $failurePattern = "(?<![A-Za-z0-9_])ATOMS_PVRT_FAILED_(PACKAGE|PRIVATE_DNS|REDIS_CLUSTER|STORE_READ|LOCAL_HEALTH|CLOSE|TIMEOUT):" + [regex]::Escape($script:RunId) + "(?![A-Za-z0-9_])"
    $failures = [regex]::Matches($plain, $failurePattern)
    $counts = @{}
    $recognized = $failures.Count
    $duplicate = $failures.Count -gt 1
    foreach ($name in $required) {
        $pattern = "(?<![A-Za-z0-9_])ATOMS_PVRT_" + $name + ":" + [regex]::Escape($script:RunId) + "(?![A-Za-z0-9_])"
        $counts[$name] = [regex]::Matches($plain, $pattern).Count
        $recognized += $counts[$name]
        if ($counts[$name] -gt 1) { $duplicate = $true }
    }
    if ($failures.Count -eq 1 -and $counts["RUNTIME_OK"] -eq 0 -and -not $duplicate) {
        return @{ Kind = "Failure"; Code = ("ATOMS_RUNTIME_PROBE_FAILED_" + $failures[0].Groups[1].Value) }
    }
    if ($failures.Count -eq 0 -and -not $duplicate -and @($required | Where-Object { $counts[$_] -ne 1 }).Count -eq 0) {
        return @{ Kind = "Success"; Code = "ATOMS_RUNTIME_OK" }
    }
    if ($duplicate -or ($failures.Count -gt 0 -and $counts["RUNTIME_OK"] -gt 0)) {
        return @{ Kind = "Ambiguous"; Code = "ATOMS_RUNTIME_SIGNAL_AMBIGUOUS" }
    }
    if ($recognized -gt 0) {
        return @{ Kind = "Incomplete"; Code = "ATOMS_RUNTIME_OUTPUT_INCOMPLETE" }
    }
    return @{ Kind = "None"; Code = "ATOMS_RUNTIME_SIGNAL_ABSENT" }
}
function Require-RuntimeTokens([string]$Output) {
    $outcome = Get-RuntimeOutcome $Output
    if ((P $outcome "Kind") -ceq "Success") { return }
    throw (P $outcome "Code")
}
function Run-Runtime([string]$Command) {
    $target = Find-Replica
    # A running replica can precede readiness of Azure's websocket exec broker.
    # One stabilization pause plus two increasing backoffs keeps retries bounded
    # and avoids the rapid pattern that previously produced 404/429 responses.
    Note "Allowing 15 seconds for Azure's exec websocket route to stabilize."
    Start-Sleep -Seconds 15
    $backoffSeconds = @(20, 40)
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        $result = Invoke-AzProcess @("containerapp", "exec", "--subscription", $SubscriptionId, "-g", $ResourceGroup, "-n", $PreviewName,
            "--revision", $target.Revision, "--replica", $target.Replica, "--container", $target.Container, "--command", $Command, "--only-show-errors") 150
        # v12 proved that successful Container Apps exec output can arrive on
        # stderr. Parse both captured streams as one secret-withheld transcript;
        # never print either raw stream.
        $execText = ([string](P $result "Stdout")) + [Environment]::NewLine + ([string](P $result "Stderr"))
        $outcome = Get-RuntimeOutcome $execText
        if ((P $outcome "Kind") -ceq "Failure") { throw (P $outcome "Code") }
        if ((P $outcome "Kind") -ceq "Success") {
            if ($result.ExitCode -ne 0) {
                Note "Azure CLI returned nonzero only after every exact nonce-bound success token; accepting the complete probe proof."
            }
            Ok "Production package/non-root entry point, exact private DNS, validated TLS/OSSCluster PONG, read-only store and exact local health passed"
            return
        }
        if ($result.ExitCode -eq 0) { throw (P $outcome "Code") }
        if ($execText -match "429|TooManyRequests|Too Many Requests") {
            $retry = [regex]::Match($execText, "(?i)retry-after['\s:]+(\d{1,6})")
            if ($retry.Success) { Note ("Azure exec rate limit: Retry-After " + $retry.Groups[1].Value + " seconds; no retry is attempted.") }
            throw "ATOMS_AZURE_RATE_LIMITED: exec did not run; stop rather than hammer the endpoint."
        }
        if ($execText -match "Handshake status 404|status.?404.*Not Found") {
            if ($attempt -lt 3) {
                $delay = $backoffSeconds[$attempt - 1]
                Note ("Azure exec handshake returned 404 on attempt $attempt/3; waiting $delay seconds, then re-resolving only the exact script-owned revision.")
                Start-Sleep -Seconds $delay
                $target = Find-Replica
                continue
            }
            throw "ATOMS_AZURE_EXEC_HANDSHAKE_NOT_READY: three bounded attempts could not reach the exact replica; no runtime result was inferred."
        }
        if ((P $outcome "Kind") -in @("Incomplete", "Ambiguous")) { throw (P $outcome "Code") }
        throw (Failure-Class $execText)
    }
    throw "ATOMS_RUNTIME_SUCCESS_UNCONFIRMED."
}
function New-HealthJob {
    if ($script:NewImage -notmatch ("^" + [regex]::Escape($AcrServer) + "/preview-gateway@sha256:[a-f0-9]{64}$")) { throw "Health Job needs the exact new immutable image." }
    $ids = @{}; $ids[$JobPullIdentity] = @{}
    return @{
        name = $script:JobName; location = "canadacentral"
        identity = @{ type = "UserAssigned"; userAssignedIdentities = $ids }
        tags = @{ project = "atoms"; environment = "staging"; purpose = "preview-private-rollout-health"; lifecycle = "ephemeral"; runId = $script:RunId; sourceSha = $SourceSha }
        properties = @{
            environmentId = $EnvironmentId
            configuration = @{
                triggerType = "Manual"; replicaTimeout = 120; replicaRetryLimit = 0
                manualTriggerConfig = @{ parallelism = 1; replicaCompletionCount = 1 }
                registries = @(@{ server = $AcrServer; identity = $JobPullIdentity })
            }
            template = @{ containers = @(@{
                name = "preview-health-probe"; image = $script:NewImage; command = @("node"); args = @("--eval", $HealthJavaScript)
                env = @(@{ name = "TARGET_URL"; value = "https://$InternalFqdn/healthz" })
                resources = @{ cpu = 0.25; memory = "0.5Gi" }
            }) }
        }
    }
}
function Health-Jobs {
    @(J @("containerapp", "job", "list", "--subscription", $SubscriptionId, "-g", $ResourceGroup, "-o", "json", "--only-show-errors") |
        Where-Object { (P $_ "name") -ceq $script:JobName })
}
function Require-JobOwner($Job) {
    if ((P $Job "name") -cne $script:JobName -or (P $Job "id") -ine "$ScopeRoot/providers/Microsoft.App/jobs/$($script:JobName)" -or
        -not (Is-CanadaCentral (P $Job "location")) -or (P (P $Job "properties") "environmentId") -ine $EnvironmentId) { throw "Job ownership mismatch; do not start or delete." }
    $expected = @{ project = "atoms"; environment = "staging"; purpose = "preview-private-rollout-health"; lifecycle = "ephemeral"; runId = $script:RunId; sourceSha = $SourceSha }
    foreach ($key in $expected.Keys) { if ((P (P $Job "tags") $key) -cne $expected[$key]) { throw "Job ownership mismatch; do not start or delete." } }
}
function Require-JobPayload($Job) {
    Require-JobOwner $Job
    $properties = P $Job "properties"; $config = P $properties "configuration"; $template = P $properties "template"
    $containers = @(Items (P $template "containers"))
    $identities = P (P $Job "identity") "userAssignedIdentities"
    $registries = @(Items (P $config "registries"))
    if ($containers.Count -ne 1 -or (P (P $Job "identity") "type") -cne "UserAssigned" -or
        $null -eq $identities -or @($identities.Keys).Count -ne 1 -or @($identities.Keys)[0] -ine $JobPullIdentity -or
        $registries.Count -ne 1 -or (P $registries[0] "server") -cne $AcrServer -or (P $registries[0] "identity") -ine $JobPullIdentity -or
        (P $registries[0] "username") -or (P $registries[0] "passwordSecretRef") -or
        @(Items (P $config "secrets")).Count -or (P $config "ingress") -or
        @(Items (P $template "initContainers")).Count -or @(Items (P $template "volumes")).Count -or
        (P $config "triggerType") -cne "Manual" -or (P $config "replicaTimeout") -ne 120 -or (P $config "replicaRetryLimit") -ne 0 -or
        (P (P $config "manualTriggerConfig") "parallelism") -ne 1 -or (P (P $config "manualTriggerConfig") "replicaCompletionCount") -ne 1) { throw "Job payload/configuration changed; do not start." }
    $container = $containers[0]
    $env = @(Items (P $container "env"))
    if ((P $container "name") -cne "preview-health-probe" -or (P $container "image") -cne $script:NewImage -or
        (Fingerprint (P $container "command")) -cne (Fingerprint @("node")) -or
        (Fingerprint (P $container "args")) -cne (Fingerprint @("--eval", $HealthJavaScript)) -or
        $env.Count -ne 1 -or (P $env[0] "name") -cne "TARGET_URL" -or
        (P $env[0] "value") -cne "https://$InternalFqdn/healthz" -or (P $env[0] "secretRef") -or
        @(Items (P $container "volumeMounts")).Count -or (P (P $container "resources") "cpu") -ne 0.25 -or
        (P (P $container "resources") "memory") -cne "0.5Gi") { throw "Job runtime payload changed; do not start." }
}
function Cleanup-HealthJob {
    if (-not $script:JobMayExist) { return }
    $jobs = @(Health-Jobs)
    if ($jobs.Count -eq 0) { $script:JobMayExist = $false; return }
    if ($jobs.Count -ne 1) { throw "Owned Job cleanup ambiguous; deletion not confirmed." }
    Require-JobOwner $jobs[0]
    [void](Az @("containerapp", "job", "delete", "--subscription", $SubscriptionId, "-g", $ResourceGroup, "-n", $script:JobName, "--yes", "--only-show-errors"))
    if (@(Health-Jobs).Count -ne 0) { throw "Owned Job deletion not confirmed." }
    $script:JobMayExist = $false
    Ok "Owned ephemeral internal-health Job deletion verified"
}
function Run-HealthJob {
    if (@(Health-Jobs).Count -ne 0) { throw "Unique health Job name already exists; no overwrite." }
    $script:JobPayload = New-HealthJob
    $path = Own-File "internal-health-job.yaml" $script:JobPayload
    $script:JobMayExist = $true
    [void](Az @("containerapp", "job", "create", "--subscription", $SubscriptionId, "-g", $ResourceGroup, "-n", $script:JobName, "--yaml", $path, "-o", "none", "--only-show-errors"))
    $job = J @("containerapp", "job", "show", "--subscription", $SubscriptionId, "-g", $ResourceGroup, "-n", $script:JobName, "-o", "json", "--only-show-errors")
    Require-JobPayload $job
    $execution = Az @("containerapp", "job", "start", "--subscription", $SubscriptionId, "-g", $ResourceGroup, "-n", $script:JobName, "--query", "name", "-o", "tsv", "--only-show-errors")
    if ($execution -notmatch ("^" + [regex]::Escape($script:JobName) + "-[a-z0-9-]+$")) { throw "Exact Job execution ID unavailable; no success claim." }
    for ($attempt = 1; $attempt -le 48; $attempt++) {
        $result = J @("containerapp", "job", "execution", "show", "--subscription", $SubscriptionId, "-g", $ResourceGroup, "-n", $script:JobName, "--job-execution-name", $execution, "-o", "json", "--only-show-errors")
        if ((P $result "name") -cne $execution) { throw "Job execution identity mismatch." }
        $status = P (P $result "properties") "status"
        if ($status -ceq "Succeeded") {
            $job = J @("containerapp", "job", "show", "--subscription", $SubscriptionId, "-g", $ResourceGroup, "-n", $script:JobName, "-o", "json", "--only-show-errors")
            Require-JobPayload $job
            Cleanup-HealthJob
            Ok 'Same-environment request after restoring min=0 required HTTP 200 and exact body {"status":"ok"}'
            return
        }
        if ($status -in @("Failed", "Stopped", "Degraded")) { throw "Exact internal health Job did not succeed." }
        if ($attempt -lt 48) { Start-Sleep -Seconds 5 }
    }
    throw "Exact health Job wait expired; no success claim."
}
function Wait-FinalRevision {
    $expected = "$PreviewName--$($script:RevisionPrefix)-z"
    for ($attempt = 1; $attempt -le 48; $attempt++) {
        $app = Get-Preview; Require-OwnedState $app
        $p = P $app "properties"
        if ((P (Container $app) "image") -cne $script:NewImage -or
            (P (P (P $p "template") "scale") "minReplicas") -ne 0) { throw "Final new digest/min=0 contract mismatch." }
        if ((P $p "provisioningState") -ceq "Succeeded" -and (P $p "latestRevisionName") -ceq $expected -and (P $p "latestReadyRevisionName") -ceq $expected) {
            $active = @(J @("containerapp", "revision", "list", "--subscription", $SubscriptionId, "-g", $ResourceGroup, "-n", $PreviewName, "-o", "json", "--only-show-errors") |
                Where-Object { $rp = P $_ "properties"; if ($null -eq $rp) { $rp = $_ }; (P $rp "active") -eq $true })
            if ($active.Count -eq 1 -and (P $active[0] "name") -ceq $expected) { return }
        }
        if ($attempt -lt 48) { Start-Sleep -Seconds 5 }
    }
    throw "Final single active/ready revision was not confirmed."
}
function Import-ResumeCheckpoint([string]$Path) {
    if (-not [IO.File]::Exists($Path)) { throw "V13 resume checkpoint file missing." }
    $data = Parse-Json ([IO.File]::ReadAllText($Path))
    if ($data -isnot [Collections.IDictionary]) { throw "V13 resume checkpoint is not an object." }
    $expectedKeys = @("buildTag", "createdAtUtc", "format", "newImage", "original", "phase", "previewId", "revisionPrefix", "runId", "sourceSha")
    if ((@($data.Keys | Sort-Object -CaseSensitive) -join "|") -cne ($expectedKeys -join "|")) {
        throw "V13 resume checkpoint fields changed."
    }
    if ((P $data "format") -cne "ATOMS_PREVIEW_PRIVATE_ROLLOUT_V13" -or
        (P $data "sourceSha") -cne $SourceSha -or (P $data "previewId") -ine $PreviewId -or
        (P $data "phase") -cne "preflight" -or (P $data "newImage") -isnot [string] -or
        (P $data "newImage") -cne "" -or (P $data "runId") -notmatch "^[a-f0-9]{32}$") {
        throw "V13 resume checkpoint is not the exact pre-build failure checkpoint."
    }
    $run = [string](P $data "runId")
    $prefix = "pvrt-" + $run.Substring(0, 12)
    $expectedTag = "private-runtime-" + $SourceSha.Substring(0, 12) + "-" + $run.Substring(0, 12)
    $original = P $data "original"
    if ($original -isnot [Collections.IDictionary] -or
        (@($original.Keys | Sort-Object -CaseSensitive) -join "|") -cne "image|invariants|mode|suffix") {
        throw "V13 resume checkpoint original-state fields changed."
    }
    $mode = P $original "mode"
    if ((P $data "revisionPrefix") -cne $prefix -or $expectedTag -cne $ResumeBuildTag -or
        (P $data "buildTag") -cne $ResumeBuildTag -or
        (P $original "invariants") -notmatch "^[a-f0-9]{64}$" -or
        (P $original "image") -notin @($OldImage, $OldPinnedImage) -or
        ($null -ne $mode -and (Fingerprint $mode) -cne (Fingerprint @{ name = "PREVIEW_REDIS_MODE"; value = "standalone" }))) {
        throw "V13 resume checkpoint is outside the exact reviewed run cxg contract."
    }
    if ($script:RunId -notmatch "^[a-f0-9]{32}$") { throw "Fresh attempt nonce is invalid." }
    $script:ResumeSourceRunId = $run
    $script:RevisionPrefix = "pvrt-" + $script:RunId.Substring(0, 12)
    $script:Original = $original
    $script:BuildTag = $ResumeBuildTag
    $script:NewImage = ""
    $script:JobName = "atoms-stg-pvrt-" + $script:RunId.Substring(0, 12)
}
function Import-Checkpoint([string]$Path) {
    if (-not [IO.File]::Exists($Path)) { throw "Rollback checkpoint file missing." }
    $data = Parse-Json ([IO.File]::ReadAllText($Path))
    if ($data -isnot [Collections.IDictionary] -or (P $data "sourceSha") -cne $SourceSha -or
        (P $data "previewId") -ine $PreviewId) { throw "Rollback checkpoint is not for this exact reviewed staging rollout." }
    $format = [string](P $data "format")
    if ($format -ceq "ATOMS_PREVIEW_PRIVATE_ROLLOUT_RESUME_V15") {
        $expectedKeys = @("attemptId", "buildTag", "createdAtUtc", "format", "newImage", "original", "phase", "previewId", "resumeSourceRunId", "revisionPrefix", "sourceSha")
        if ((@($data.Keys | Sort-Object -CaseSensitive) -join "|") -cne ($expectedKeys -join "|")) {
            throw "Resume-v15 rollback checkpoint fields changed."
        }
        $attempt = [string](P $data "attemptId")
        $resumeRun = [string](P $data "resumeSourceRunId")
    } elseif ($format -ceq "ATOMS_PREVIEW_PRIVATE_ROLLOUT_V13") {
        # Narrow compatibility for a v14 interruption checkpoint. In v14 the
        # build nonce and deployment-attempt nonce were the same value.
        $expectedKeys = @("buildTag", "createdAtUtc", "format", "newImage", "original", "phase", "previewId", "revisionPrefix", "runId", "sourceSha")
        if ((@($data.Keys | Sort-Object -CaseSensitive) -join "|") -cne ($expectedKeys -join "|")) {
            throw "Legacy rollback checkpoint fields changed."
        }
        $attempt = [string](P $data "runId")
        $resumeRun = $attempt
    } else {
        throw "Rollback checkpoint format is not approved for v17 recovery."
    }
    $original = P $data "original"
    if ($original -isnot [Collections.IDictionary] -or
        (@($original.Keys | Sort-Object -CaseSensitive) -join "|") -cne "image|invariants|mode|suffix") {
        throw "Rollback checkpoint original-state fields changed."
    }
    $mode = P $original "mode"; $image = P $original "image"
    $prefix = if ($attempt -match "^[a-f0-9]{32}$") { "pvrt-" + $attempt.Substring(0, 12) } else { "" }
    $expectedTag = if ($resumeRun -match "^[a-f0-9]{32}$") { "private-runtime-" + $SourceSha.Substring(0, 12) + "-" + $resumeRun.Substring(0, 12) } else { "" }
    $allowedPhases = @("published-reconciled", "patch-may-apply", "patch-confirmed", "recovery-requested", "rolled-back", "succeeded")
    if (-not $prefix -or -not $expectedTag -or $expectedTag -cne $ResumeBuildTag -or
        (P $data "revisionPrefix") -cne $prefix -or (P $original "invariants") -notmatch "^[a-f0-9]{64}$" -or
        $image -notin @($OldImage, $OldPinnedImage) -or
        ($null -ne $mode -and (Fingerprint $mode) -cne (Fingerprint @{ name = "PREVIEW_REDIS_MODE"; value = "standalone" })) -or
        (P $data "newImage") -cne "$AcrServer/preview-gateway@$ResumeBuildDigest" -or
        (P $data "buildTag") -cne $ResumeBuildTag -or (P $data "phase") -notin $allowedPhases) {
        throw "Rollback checkpoint fields are outside the approved narrow recovery contract."
    }
    $script:RunId = $attempt; $script:ResumeSourceRunId = $resumeRun; $script:RevisionPrefix = $prefix
    $script:Original = $original; $script:NewImage = [string](P $data "newImage"); $script:BuildTag = $ResumeBuildTag
    $script:JobName = "atoms-stg-pvrt-" + $attempt.Substring(0, 12)
}
function Initialize-Audit {
    if (-not $script:AzureConfigDirectory) {
        if ($env:AZURE_CONFIG_DIR) { $script:AzureConfigDirectory = $env:AZURE_CONFIG_DIR }
        elseif ($env:USERPROFILE) { $script:AzureConfigDirectory = Join-Path $env:USERPROFILE ".azure-atoms" }
        else { throw "Specify the existing -AzureConfigDirectory used for your successful v12 Azure login." }
    }
    if (-not [IO.Directory]::Exists($script:AzureConfigDirectory)) { throw "Existing staging Azure profile directory missing; supply -AzureConfigDirectory. No login or profile is created." }
    $script:AzureConfigDirectory = [IO.Path]::GetFullPath($script:AzureConfigDirectory)
    $script:RunRoot = Join-Path ([IO.Path]::GetTempPath()) ("atoms-preview-private-rollout-resume-v17-" + [Guid]::NewGuid().ToString("N"))
    [void][IO.Directory]::CreateDirectory($script:RunRoot)
    $script:TranscriptPath = Join-Path $script:RunRoot "transcript.log"
    Start-Transcript -LiteralPath $script:TranscriptPath | Out-Null
    $script:TranscriptStarted = $true
}
function Safe-Error($ErrorRecord) {
    # Never dump an arbitrary exception or CLI traceback into the transcript.
    $match = [regex]::Match([string]$ErrorRecord.Exception.Message, "ATOMS_[A-Z_]+")
    if ($match.Success) { return $match.Value }
    if ([string]$ErrorRecord.Exception.Message -match "drift|not an original or exact script-owned") { return "ATOMS_CONFIGURATION_DRIFT_REFUSED" }
    if ([string]$ErrorRecord.Exception.Message -match "ownership") { return "ATOMS_RESOURCE_OWNERSHIP_REFUSED" }
    if ([string]$ErrorRecord.Exception.Message -match "profile directory|AzureConfigDirectory") { return "ATOMS_EXISTING_AZURE_PROFILE_REQUIRED" }
    return "ATOMS_GUARD_OR_OPERATION_FAILED"
}
function Invoke-Rollout {
    try {
        Initialize-Audit
        Write-Host "Atoms Staging Preview Gateway private full-image rollout resume v17"
        Write-Host "Reuses exact ACR run cxg; dual-stream exec proof; no build, public domain/ingress/DNS/TLS, provider/run execution, secret retrieval or Redis data writes."
        Step "Lock the existing Azure profile to Atoms-Staging"; Lock-Staging
        if ($RollbackCheckpoint) {
            Step "Validate the exact narrow recovery checkpoint"; Import-Checkpoint $RollbackCheckpoint
            [void](Verify-Boundaries)
            $script:AppMutationMayHaveApplied = $true; Save-Checkpoint "recovery-requested"
            Restore-Original
            $script:JobMayExist = $true; Cleanup-HealthJob
            [void](Verify-Boundaries); Require-OwnedState (Get-Preview)
            $script:CommitSucceeded = $true
            Write-Host "PRIVATE ROLLOUT RECOVERY CONFIRMED" -ForegroundColor Green
            return
        }
        Step "Validate the exact v13 preflight checkpoint for ACR run cxg"; Import-ResumeCheckpoint $ResumeCheckpoint
        Step "Verify pinned public Git SHA/tree and complete full-main CI"; Verify-Source
        Step "Verify public/execution boundaries"; $environment = Verify-Boundaries
        Step "Verify exact ACR and required Container Apps CLI capabilities"
        $acr = J @("acr", "show", "--subscription", $SubscriptionId, "-g", $ResourceGroup, "-n", $AcrName, "-o", "json", "--only-show-errors")
        if ((P $acr "id") -ine "$ScopeRoot/providers/Microsoft.ContainerRegistry/registries/$AcrName" -or (P $acr "loginServer") -cne $AcrServer) { throw "Exact staging ACR mismatch." }
        $jobHelp = Az @("containerapp", "job", "create", "--help")
        $execHelp = Az @("containerapp", "exec", "--help")
        if (-not $jobHelp.Contains("--yaml") -or -not $execHelp.Contains("--replica")) { throw "Required Container Apps extension unavailable; no extension is installed automatically." }
        Step "Reconcile the current Gateway with the reviewed v13 original state"
        $preview = Get-Preview
        Gateway-IdentitySummary $preview
        $currentOriginal = Capture-Original $preview
        $baselineState = Resume-BaselineState $currentOriginal $script:Original
        if ($baselineState -ceq "MISMATCH") { throw "ATOMS_RESUME_ORIGINAL_STATE_DRIFT" }
        if ($baselineState -ceq "CONFIRMED_ROLLOUT_ROLLBACK") {
            Ok "Current Gateway matches the exact invariant-equivalent rollback baseline from the prior attempt"
        }
        Ok "Existing Gateway runtime-mi registry identity verified and preserved; the ephemeral Job uses the separate existing acr-pull identity"
        $redis = Get-RedisBaseline $environment
        $runtimeCommand = Runtime-Command $redis
        Ok ("Short runtime carrier prepared: " + $runtimeCommand.Length + " characters; enforced ceiling=1800")
        Ok "Runtime proof parser accepts only this attempt's nonce-bound signals across captured stdout/stderr; raw streams remain withheld"
        Step "Reconcile existing ACR run cxg and its immutable image without building"
        $script:NewImage = Resolve-ReusedBuild
        if (@(Health-Jobs).Count -ne 0) { throw "ATOMS_RESUME_OWNED_JOB_ALREADY_EXISTS" }
        Save-Checkpoint "published-reconciled"
        Ok "All runtime commands and rollback metadata prepared; build operations executed by this script: NONE"
        if (-not $Apply) {
            Write-Host ""; Write-Host "READ-ONLY RESUME PREFLIGHT SUCCEEDED" -ForegroundColor Green
            Write-Host "Existing build: VERIFIED. New build/push/deployment: NOT STARTED. Re-run with the same -ResumeCheckpoint plus -Apply."
            return
        }
        Step "Re-check for concurrent configuration/network drift before rollout"
        $environment = Verify-Boundaries
        $currentRedis = Get-RedisBaseline $environment
        if ($currentRedis.MetadataHash -cne $redis.MetadataHash) { throw "Redis/private network metadata drift; no DNS/secret/network overwrite." }
        Require-OwnedState (Get-Preview)
        $mode = @{ name = "PREVIEW_REDIS_MODE"; value = "oss-cluster" }
        Step "Deploy the exact new digest and OSSCluster mode to one private replica"
        [void](Patch-Preview $script:NewImage 1 $mode "$($script:RevisionPrefix)-a")
        Step "Require the bounded read-only runtime probe in the exact new replica"; Run-Runtime $runtimeCommand
        Step "Restore min=0/max=1 on the new immutable image"
        [void](Patch-Preview $script:NewImage 0 $mode "$($script:RevisionPrefix)-z")
        Step "Require one ephemeral same-environment health Job; no runtime secrets copied"; Run-HealthJob
        Step "Verify final single ready revision and every safety boundary"; Wait-FinalRevision
        $environment = Verify-Boundaries
        $currentRedis = Get-RedisBaseline $environment
        if ($currentRedis.MetadataHash -cne $redis.MetadataHash) { throw "Final Redis/private network metadata differs; no repair outside this rollout." }
        Require-OwnedState (Get-Preview); Lock-Staging
        if ($script:JobMayExist -or @(Health-Jobs).Count) { throw "Ephemeral health Job cleanup is not confirmed." }
        Save-Checkpoint "succeeded"
        $script:CommitSucceeded = $true
        Write-Host ""; Write-Host "PRIVATE FULL-IMAGE ROLLOUT + READ-ONLY RUNTIME SMOKE SUCCEEDED" -ForegroundColor Green
        Write-Host "Source SHA              : $SourceSha"
        Write-Host "ACR build / run          : REUSED / $ResumeBuildRunId"
        Write-Host "Gateway image           : $($script:NewImage)"
        Write-Host "Redis mode / data writes: OSSCluster / NONE"
        Write-Host "Local + internal health : HTTP 200 / exact JSON body"
        Write-Host "Gateway ingress / scale : INTERNAL HTTPS ONLY / min 0 max 1"
        Write-Host "AUTH / RUN execution    : required / disabled"
        Write-Host "Domain/public/providers : NONE"
        Write-Host "Live forwarding/WS/TTL  : NOT tested with a session; synthetic end-to-end evidence is CI #174."
        Write-Host "Public preview remains blocked without an owned domain and wildcard TLS."
    } catch {
        $script:ExitStatus = 1
        Write-Host ""; Write-Host "PRIVATE ROLLOUT NOT SUCCEEDED" -ForegroundColor Red
        Write-Host ("Safe stage: " + $script:Stage)
        Write-Host ("Safe error: " + (Safe-Error $_))
    } finally {
        if ($script:JobMayExist) {
            try { Cleanup-HealthJob }
            catch { $script:ExitStatus = 1; $script:CommitSucceeded = $false; Write-Warning ("Owned ephemeral Job cleanup NOT CONFIRMED: " + (Safe-Error $_)) }
        }
        if ($script:AppMutationMayHaveApplied -and -not $script:CommitSucceeded) {
            try { Restore-Original }
            catch {
                $script:ExitStatus = 1
                Write-Warning ("ROLLBACK / MIN=0 NOT CONFIRMED: " + (Safe-Error $_))
                Write-Warning "Stop. Do not re-run rollout blindly; review the exact staging Gateway and checkpoint with your existing authorized identity."
            }
        }
        if ($script:NewImage -and -not $script:CommitSucceeded) { Note "The reused image remains in ACR; this script never deletes images or unrelated resources." }
        if ($script:CheckpointPath) { Write-Host ("Checkpoint: " + $script:CheckpointPath) }
        if ($script:TranscriptStarted) {
            try { Stop-Transcript | Out-Null } catch { }
            Write-Host ("Transcript: " + $script:TranscriptPath)
            try { [IO.File]::ReadAllText($script:TranscriptPath) | Set-Clipboard; Write-Host "Full transcript copied to clipboard." } catch { }
        }
    }
}

if ($CheckOnly) {
    # No Azure CLI, filesystem mutation, network, build, scale or Redis access.
    $command = Runtime-Command @{ HostName = "check.canadacentral.redis.azure.net"; PrivateIps = @("10.0.0.4") }
    Write-Host "CHECK ONLY PASSED: PowerShell parsed; resume runtime carrier prepared ($($command.Length) characters). No Azure operation or build was performed."
    return
}
Invoke-Rollout
exit $script:ExitStatus
