[CmdletBinding()]
param(
    [switch]$Apply,
    [switch]$CheckOnly,
    [string]$AzureConfigDirectory = "",
    [string]$RecoveryCheckpoint = ""
)

# Atoms Staging Preview Gateway private request rejection smoke v19.
# Default invocation is a read-only Azure preflight. -Apply temporarily changes
# only min replicas/revision suffix (0 -> 1 -> 0), stages a non-secret probe in
# /tmp of the exact replica, and writes exactly one random Redis session record.
# The record has a maximum initial TTL of 60 seconds and is deleted/verified absent
# in the probe finally block. A remaining ambiguous record still auto-expires.
# The probe uses a loopback-only mock upstream in the existing Gateway container
# and validates production positive routing/header control, invalid/expired ticket rejection,
# missing/revoked sessions, HTTP/WebSocket origin-override rejection, and cleanup.
# It does NOT copy/retrieve/print secrets, create a Job, build/push/deploy an
# image, enable public ingress/domain/DNS/TLS, enable run/provider execution, or
# contact OpenAI/E2B. The host never receives secret values, signed URLs, Redis
# hostnames/private IPs, session IDs, fixture headers, or raw exec output.
# Recovery after a host interruption uses only this run's printed checkpoint:
#   pwsh -NoProfile -File .\atoms-staging-preview-gateway-private-rejection-smoke-v19.ps1 -RecoveryCheckpoint C:\exact\v19-checkpoint.json
# Run with PowerShell 7+, using the existing .azure-atoms profile. Never run
# concurrently with another Gateway deployment or smoke.

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
if ($PSVersionTable.PSVersion.Major -lt 7) { throw "PowerShell 7+ is required." }
if (($CheckOnly -and ($Apply -or $RecoveryCheckpoint)) -or ($Apply -and $RecoveryCheckpoint)) {
    throw "Use -CheckOnly alone, -RecoveryCheckpoint alone, or optional -Apply."
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
$DefaultDomain = "proudpond-7f6fcfdd.canadacentral.azurecontainerapps.io"
$InternalFqdn = "$PreviewName.internal.$DefaultDomain"
$UiOrigin = "https://atoms-staging-web.$DefaultDomain"
$SourceSha = "b7947fa783f45b0dcbf96036f0313ba387812da9"
$SourceTree = "311bee9e6ac159fa2b0937817c8cd761e6325f6b"
$CiRunId = 34709196072
$GitHubRepo = "Kohzadi2023/atoms-platform"
$AcrRunId = "cxg"
$DeployedTag = "private-runtime-b7947fa783f4-e95400a79f02"
$DeployedDigest = "sha256:5b23a82293be920654d9c65b95d4ebfa9ea9bb2601045698d17375b9d8f69d0b"
$DeployedImage = "$AcrServer/preview-gateway@$DeployedDigest"
$AppApiVersion = "2025-01-01"
$RedisApiVersion = "2025-07-01"
$PreviewUrl = "https://management.azure.com" + $PreviewId + "?api-version=$AppApiVersion"
$RunId = [Guid]::NewGuid().ToString("N")
$RevisionPrefix = "pvneg-" + $RunId.Substring(0, 12)
$StageFile = "/tmp/atoms-pvneg-$RunId.b64"
$RunRoot = ""
$CheckpointPath = ""
$TranscriptPath = ""
$TranscriptStarted = $false
$Original = $null
$RedisMetadataHash = ""
$ProbeCarrier = $null
$Stage = "initialization"
$ExitStatus = 0
$AzLaunch = $null
$LastExecAt = $null
$ScaleMutationMayHaveApplied = $false
$StageFileMayExist = $false
$CommitSucceeded = $false

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
    try { Invoke-RestMethod -Uri ("https://api.github.com/repos/" + $GitHubRepo + "/" + $Path) -Headers @{ Accept = "application/vnd.github+json"; "User-Agent" = "Atoms-Private-Live-Session-Smoke-v19" } -TimeoutSec 30 }
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

function Verify-DeployedArtifact($App) {
    $acr = J @("acr", "show", "--subscription", $SubscriptionId, "-g", $ResourceGroup, "-n", $AcrName, "-o", "json", "--only-show-errors")
    if ((P $acr "id") -ine "$ScopeRoot/providers/Microsoft.ContainerRegistry/registries/$AcrName" -or
        (P $acr "loginServer") -cne $AcrServer) { throw "Exact staging ACR mismatch." }
    $run = J @("acr", "task", "show-run", "--subscription", $SubscriptionId, "-g", $ResourceGroup, "-r", $AcrName,
        "--run-id", $AcrRunId, "-o", "json", "--only-show-errors")
    $platform = P $run "platform"
    $outputs = @(Items (P $run "outputImages"))
    if ((P $run "runId") -cne $AcrRunId -or (P $run "status") -cne "Succeeded" -or
        (P $platform "os") -ine "linux" -or (P $platform "architecture") -ine "amd64" -or $outputs.Count -ne 1 -or
        (P $outputs[0] "repository") -cne "preview-gateway" -or (P $outputs[0] "tag") -cne $DeployedTag -or
        (P $outputs[0] "digest") -cne $DeployedDigest -or
        ((P $outputs[0] "registry") -and (P $outputs[0] "registry") -cne $AcrServer)) {
        throw "Deployed ACR run/digest provenance changed."
    }
    $digest = Az @("acr", "repository", "show", "--subscription", $SubscriptionId, "-n", $AcrName,
        "--image", ("preview-gateway:" + $DeployedTag), "--query", "digest", "-o", "tsv", "--only-show-errors")
    if ($digest.Trim() -cne $DeployedDigest -or (P (Container $App) "image") -cne $DeployedImage) {
        throw "Current Gateway image or immutable repository digest changed."
    }
    $execHelp = Az @("containerapp", "exec", "--help")
    if (-not $execHelp.Contains("--replica")) { throw "Required Container Apps exec capability is unavailable; no extension is installed automatically." }
    Ok "Exact deployed source/run cxg/Linux-amd64 digest and current Gateway image verified; build/push/deploy operations=NONE"
}

function Capture-Baseline($App) {
    Verify-PrivateApp $App
    $properties = P $App "properties"
    $template = P $properties "template"
    $mode = Env-Record $App "PREVIEW_REDIS_MODE"
    $expectedMode = @{ name = "PREVIEW_REDIS_MODE"; value = "oss-cluster" }
    $suffix = [string](P $template "revisionSuffix")
    if ((P (Container $App) "image") -cne $DeployedImage -or
        (P (P $template "scale") "minReplicas") -ne 0 -or
        (Fingerprint $mode) -cne (Fingerprint $expectedMode) -or
        $suffix -notmatch "^[a-z0-9][a-z0-9-]{0,62}$" -or
        (P $properties "provisioningState") -cne "Succeeded" -or
        -not (P $properties "latestRevisionName") -or
        (P $properties "latestReadyRevisionName") -cne (P $properties "latestRevisionName")) {
        throw "Deployed Gateway is not the successful v17 image/OSSCluster/min=0 baseline."
    }
    return @{ invariants = App-Invariants $App; image = $DeployedImage; mode = Copy-Data $mode; suffix = $suffix }
}

function Require-SmokeState($App) {
    Verify-PrivateApp $App
    if ($null -eq $script:Original -or (App-Invariants $App) -cne (P $script:Original "invariants")) {
        throw "Gateway configuration drift detected; refusing to overwrite unrelated changes."
    }
    $template = P (P $App "properties") "template"
    $image = [string](P (Container $App) "image")
    $mode = Env-Record $App "PREVIEW_REDIS_MODE"
    $minimum = P (P $template "scale") "minReplicas"
    $suffix = [string](P $template "revisionSuffix")
    if ($image -cne $DeployedImage -or (Fingerprint $mode) -cne (Fingerprint (P $script:Original "mode"))) {
        throw "Gateway image or Redis mode drifted outside this smoke."
    }
    $allowed = ($suffix -ceq (P $script:Original "suffix") -and $minimum -eq 0) -or
        ($suffix -ceq "$($script:RevisionPrefix)-a" -and $minimum -eq 1) -or
        ($suffix -in @("$($script:RevisionPrefix)-z", "$($script:RevisionPrefix)-r") -and $minimum -eq 0)
    if (-not $allowed) { throw "Gateway is not the original or exact script-owned scale state." }
}

function Save-Checkpoint([string]$Phase) {
    if ($script:RunId -notmatch "^[a-f0-9]{32}$" -or $script:RevisionPrefix -cne ("pvneg-" + $script:RunId.Substring(0, 12)) -or
        $null -eq $script:Original) { throw "Live-session checkpoint identity is incomplete." }
    $data = @{
        format = "ATOMS_PREVIEW_PRIVATE_REJECTION_SMOKE_V19"; sourceSha = $SourceSha
        imageDigest = $DeployedDigest; previewId = $PreviewId; attemptId = $script:RunId
        revisionPrefix = $script:RevisionPrefix; original = $script:Original; phase = $Phase
        createdAtUtc = [DateTime]::UtcNow.ToString("o")
    }
    $temp = Own-File ("checkpoint-" + [Guid]::NewGuid().ToString("N") + ".json") $data
    if (-not $script:CheckpointPath) { $script:CheckpointPath = Join-Path $script:RunRoot "recovery-checkpoint.json" }
    [IO.File]::Move($temp, $script:CheckpointPath, $true)
}

function Import-RecoveryCheckpoint([string]$Path) {
    if (-not [IO.File]::Exists($Path)) { throw "V19 recovery checkpoint file missing." }
    $data = Parse-Json ([IO.File]::ReadAllText($Path))
    $expectedKeys = @("attemptId", "createdAtUtc", "format", "imageDigest", "original", "phase", "previewId", "revisionPrefix", "sourceSha")
    if ($data -isnot [Collections.IDictionary] -or
        (@($data.Keys | Sort-Object -CaseSensitive) -join "|") -cne ($expectedKeys -join "|") -or
        (P $data "format") -cne "ATOMS_PREVIEW_PRIVATE_REJECTION_SMOKE_V19" -or
        (P $data "sourceSha") -cne $SourceSha -or (P $data "imageDigest") -cne $DeployedDigest -or
        (P $data "previewId") -ine $PreviewId) { throw "Recovery checkpoint is not for this exact v19 staging smoke." }
    $attempt = [string](P $data "attemptId")
    $prefix = if ($attempt -match "^[a-f0-9]{32}$") { "pvneg-" + $attempt.Substring(0, 12) } else { "" }
    $original = P $data "original"
    $mode = P $original "mode"
    $allowedPhases = @("preflight", "scale-may-apply", "scale-confirmed", "payload-staging", "probe-finished", "restoring", "restored", "succeeded")
    if (-not $prefix -or (P $data "revisionPrefix") -cne $prefix -or (P $data "phase") -notin $allowedPhases -or
        $original -isnot [Collections.IDictionary] -or
        (@($original.Keys | Sort-Object -CaseSensitive) -join "|") -cne "image|invariants|mode|suffix" -or
        (P $original "image") -cne $DeployedImage -or (P $original "invariants") -notmatch "^[a-f0-9]{64}$" -or
        (P $original "suffix") -notmatch "^[a-z0-9][a-z0-9-]{0,62}$" -or
        (Fingerprint $mode) -cne (Fingerprint @{ name = "PREVIEW_REDIS_MODE"; value = "oss-cluster" })) {
        throw "Recovery checkpoint fields are outside the narrow v19 scale-only contract."
    }
    $script:RunId = $attempt
    $script:RevisionPrefix = $prefix
    $script:StageFile = "/tmp/atoms-pvneg-$attempt.b64"
    $script:Original = $original
}

function Patch-Scale([int]$Minimum, [string]$Suffix) {
    if (($Minimum -eq 1 -and $Suffix -cne "$($script:RevisionPrefix)-a") -or
        ($Minimum -eq 0 -and $Suffix -notin @("$($script:RevisionPrefix)-z", "$($script:RevisionPrefix)-r"))) {
        throw "Unapproved scale/revision patch."
    }
    $current = Get-Preview
    Require-SmokeState $current
    $patch = @{ location = "canadacentral"; properties = @{ template = @{ scale = @{ minReplicas = $Minimum }; revisionSuffix = $Suffix } } }
    $path = Own-File ("scale-patch-" + [Guid]::NewGuid().ToString("N") + ".json") $patch
    $script:ScaleMutationMayHaveApplied = $true
    Save-Checkpoint "scale-may-apply"
    $arguments = @("rest", "--method", "patch", "--subscription", $SubscriptionId, "--url", $PreviewUrl,
        "--body", ("@" + $path), "--only-show-errors", "-o", "none")
    $etag = [string](P $current "etag")
    if ($etag) { $arguments += @("--headers", ("If-Match=" + $etag)) }
    [void](Az $arguments)
    for ($attempt = 1; $attempt -le 60; $attempt++) {
        $app = Get-Preview
        Require-SmokeState $app
        $properties = P $app "properties"
        $template = P $properties "template"
        if ((P $properties "provisioningState") -in @("Failed", "Canceled")) { throw "Gateway scale revision provisioning failed." }
        if ((P $properties "provisioningState") -ceq "Succeeded" -and
            (P (P $template "scale") "minReplicas") -eq $Minimum -and (P $template "revisionSuffix") -ceq $Suffix) {
            Save-Checkpoint "scale-confirmed"
            return $app
        }
        if ($attempt -lt 60) { Start-Sleep -Seconds 5 }
    }
    throw "Gateway scale patch was not confirmed."
}

function Wait-ReadyRevision([string]$Suffix) {
    $expected = "$PreviewName--$Suffix"
    for ($attempt = 1; $attempt -le 48; $attempt++) {
        $app = Get-Preview
        Require-SmokeState $app
        $properties = P $app "properties"
        if ((P $properties "provisioningState") -ceq "Succeeded" -and
            (P $properties "latestRevisionName") -ceq $expected -and (P $properties "latestReadyRevisionName") -ceq $expected) {
            $active = @(J @("containerapp", "revision", "list", "--subscription", $SubscriptionId, "-g", $ResourceGroup,
                "-n", $PreviewName, "-o", "json", "--only-show-errors") | Where-Object {
                    $rp = P $_ "properties"; if ($null -eq $rp) { $rp = $_ }; (P $rp "active") -eq $true
                })
            if ($active.Count -eq 1 -and (P $active[0] "name") -ceq $expected) { return }
        }
        if ($attempt -lt 48) { Start-Sleep -Seconds 5 }
    }
    throw "Exact final private revision readiness was not confirmed."
}

function Restore-Scale([string]$Suffix) {
    $current = Get-Preview
    Require-SmokeState $current
    $template = P (P $current "properties") "template"
    if ((P (P $template "scale") "minReplicas") -eq 0) {
        $currentSuffix = [string](P $template "revisionSuffix")
        if ($currentSuffix -in @("$($script:RevisionPrefix)-z", "$($script:RevisionPrefix)-r")) {
            Wait-ReadyRevision $currentSuffix
        } else {
            $properties = P $current "properties"
            if ((P $properties "provisioningState") -cne "Succeeded" -or
                (P $properties "latestReadyRevisionName") -cne (P $properties "latestRevisionName")) {
                throw "Original min=0 revision readiness is not confirmed."
            }
        }
        $script:ScaleMutationMayHaveApplied = $false
        Save-Checkpoint "restored"
        Ok "Gateway already at min=0/max=1; image, OSSCluster mode and internal ingress unchanged"
        return
    }
    Note "Restoring only min replicas 1 -> 0 with the exact deployed image/configuration unchanged."
    Save-Checkpoint "restoring"
    [void](Patch-Scale 0 $Suffix)
    Wait-ReadyRevision $Suffix
    $script:ScaleMutationMayHaveApplied = $false
    Save-Checkpoint "restored"
    Ok "Gateway scale-to-zero restored; image, OSSCluster mode and internal ingress unchanged"
}

function Find-ExactReplica {
    $revision = "$PreviewName--$($script:RevisionPrefix)-a"
    for ($attempt = 1; $attempt -le 60; $attempt++) {
        $app = Get-Preview
        Require-SmokeState $app
        $revisions = @(J @("containerapp", "revision", "list", "--subscription", $SubscriptionId, "-g", $ResourceGroup,
            "-n", $PreviewName, "-o", "json", "--only-show-errors"))
        $exact = @($revisions | Where-Object { (P $_ "name") -ceq $revision })
        if ($exact.Count -eq 1) {
            $rp = P $exact[0] "properties"; if ($null -eq $rp) { $rp = $exact[0] }
            $containers = @(Items (P (P $rp "template") "containers"))
            if ($containers.Count -ne 1 -or (P $containers[0] "image") -cne $DeployedImage) { throw "Exact smoke revision image changed." }
            if ((P $rp "active") -eq $true -and (P $rp "provisioningState") -ceq "Provisioned" -and
                (P $rp "healthState") -in @("Healthy", "None", $null, "")) {
                $replicas = @(J @("containerapp", "replica", "list", "--subscription", $SubscriptionId, "-g", $ResourceGroup,
                    "-n", $PreviewName, "--revision", $revision, "-o", "json", "--only-show-errors"))
                if ($replicas.Count -eq 1) {
                    $replicaName = [string](P $replicas[0] "name")
                    $pp = P $replicas[0] "properties"; if ($null -eq $pp) { $pp = $replicas[0] }
                    $containerName = [string](P (Container $app) "name")
                    $running = @((Items (P $pp "containers")) | Where-Object {
                        (P $_ "name") -ceq $containerName -and (P $_ "runningState") -in @("Running", "running")
                    })
                    if ($replicaName.StartsWith("$revision-", [StringComparison]::Ordinal) -and $running.Count -eq 1) {
                        Ok "Exact script-owned revision/replica/container resolved"
                        return @{ Revision = $revision; Replica = $replicaName; Container = $containerName }
                    }
                }
            }
        }
        if ($attempt % 6 -eq 1) { Note "Waiting for only the exact script-owned private replica; no previous-revision fallback." }
        if ($attempt -lt 60) { Start-Sleep -Seconds 5 }
    }
    throw "Exact private rejection smoke replica did not become ready."
}


# Synced from scripts/preview-smoke/v19-rejection.cjs. The embedded source itself
# contains no secret values and reads the existing replica environment only.
$LiveJavaScript = @'
// Runs only inside the exact private Gateway replica. K is supplied by the
// nonce-bound carrier. Existing credentials and signed hosts never leave it.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const { randomBytes, randomUUID } = require("node:crypto");
const { createRequire } = require("node:module");
const { pathToFileURL } = require("node:url");

let phase = "PACKAGE", client, sessionId, owned = false, failure;
const servers = [], sockets = new Set();
const token = name => console.log(`ATOMS_PVNEG_${name}:${K.nonce}`);
const bounded = async (promise, milliseconds = 5000) => {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error()), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
};
let deadline = Infinity;

function requestGateway(host, path, upgrade = false) {
  assert.ok(Date.now() < deadline);
  return bounded(new Promise((resolve, reject) => {
    const headers = {
      host, connection: upgrade ? "Upgrade" : "close",
      "x-atoms-preview-smoke": "caller-spoof",
      "x-forwarded-host": "caller.invalid", "x-forwarded-proto": "http",
    };
    if (upgrade) Object.assign(headers, {
      upgrade: "websocket", "sec-websocket-version": "13",
      "sec-websocket-key": randomBytes(16).toString("base64"),
    });
    const request = http.request({ host: "127.0.0.1", port: K.port,
      method: "GET", path, headers, agent: false }, response => {
      let size = 0;
      const chunks = [];
      response.on("data", chunk => {
        size += chunk.length;
        if (size > 2048) request.destroy(new Error());
        else chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode,
        headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    // An unexpected accepted upgrade is a failure, never a hanging probe.
    request.on("upgrade", (_response, socket) => { socket.destroy(); reject(new Error()); });
    request.setTimeout(Math.min(4000, Math.max(1, deadline - Date.now())), () => request.destroy(new Error()));
    request.on("error", reject);
    request.end();
  }));
}

async function upstream(headerValue, expectedHost, positive) {
  const counts = { connections: 0, requests: 0, upgrades: 0 };
  const server = http.createServer((request, response) => {
    counts.requests++;
    const valid = positive && request.url === "/positive" &&
      request.headers["x-atoms-preview-smoke"] === headerValue &&
      request.headers["x-forwarded-host"] === expectedHost &&
      request.headers["x-forwarded-proto"] === "https";
    response.writeHead(valid ? 200 : 500);
    response.end(valid ? `POSITIVE:${K.nonce}` : "unexpected");
  });
  servers.push(server);
  server.on("connection", socket => {
    counts.connections++; sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
  });
  server.on("upgrade", (_request, socket) => {
    counts.upgrades++;
    socket.end("HTTP/1.1 500 Unexpected\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  });
  await bounded(new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  }));
  return { port: server.address().port, counts };
}

(async () => {
  try {
    assert.notEqual(process.getuid(), 0);
    assert.equal(process.env.PREVIEW_REDIS_MODE, "oss-cluster");
    assert.equal(process.env.PREVIEW_BASE_DOMAIN, "preview.invalid");
    assert.equal(process.env.PREVIEW_PUBLIC_PROTOCOL, "https");
    assert.equal(fs.existsSync(K.file), false);
    token("PAYLOAD_CLEAN_OK");
    const previewPath = createRequire("/app/package.json").resolve("@atoms/preview");
    const preview = await import(pathToFileURL(previewPath).href);
    const { Cluster } = createRequire(previewPath)("ioredis");
    const config = preview.previewRedisClusterConfiguration(process.env.REDIS_URL);
    client = new Cluster(config.nodes, { ...config.options, lazyConnect: true });
    client.on("error", () => {});
    await bounded(client.connect(), 25000);
    const store = new preview.RedisPreviewSessionStore({ client, redisMode: "oss-cluster" });
    const signerOptions = { secret: process.env.PREVIEW_SIGNING_SECRET,
      baseDomain: "preview.invalid", publicProtocol: "https" };
    const signer = new preview.PreviewTicketSigner(signerOptions);
    token("PACKAGE_OK");

    phase = "FIXTURE";
    sessionId = randomUUID();
    const key = `atoms:preview:${sessionId}`;
    assert.equal(await bounded(client.get(key)), null);
    const expiresAt = new Date(Date.now() + 60000);
    const host = new URL(signer.issue(sessionId, expiresAt)).host;
    const header = randomBytes(16).toString("hex");
    const selected = await upstream(header, host, true);
    const decoy = await upstream("", "", false);
    owned = true; // SET may apply even if its reply is lost.
    await bounded(store.put({ sessionId, workspaceId: randomUUID(),
      projectId: randomUUID(), runId: randomUUID(),
      upstreamUrl: `http://127.0.0.1:${selected.port}`,
      requestHeaders: { "x-atoms-preview-smoke": header }, expiresAt: expiresAt.toISOString() }));
    const ttl = await bounded(client.pttl(key));
    assert.ok(ttl > 0 && ttl <= 60000);
    deadline = Date.now() + Math.min(35000, ttl - 5000);
    token("REDIS_WRITE_OK");

    phase = "POSITIVE";
    const positive = await requestGateway(host, "/positive");
    assert.equal(positive.status, 200);
    assert.equal(positive.body, `POSITIVE:${K.nonce}`);
    assert.equal(positive.headers["x-atoms-preview-smoke"], undefined);
    assert.deepEqual(selected.counts, { connections: 1, requests: 1, upgrades: 0 });
    token("POSITIVE_CONTROL_OK");
    const selectedBefore = { ...selected.counts };
    const checkIsolation = () => {
      assert.deepEqual(selected.counts, selectedBefore);
      assert.deepEqual(decoy.counts, { connections: 0, requests: 0, upgrades: 0 });
    };
    const reject = async (candidate, path, status, upgrade = false) => {
      const response = await requestGateway(candidate, path, upgrade);
      assert.equal(response.status, status);
      if (!upgrade) {
        const messages = { 401: "Invalid preview URL", 404: "Preview not found",
          410: "Preview expired", 400: "Invalid preview request" };
        assert.deepEqual(JSON.parse(response.body), { error: messages[status] });
        assert.equal(response.headers["cache-control"], "no-store");
      }
      assert.ok(!response.body.includes(header));
      checkIsolation();
    };
    const label = host.split(".")[0];
    const tampered = `${label.slice(0, -1)}${label.at(-1) === "0" ? "1" : "0"}.preview.invalid`;
    const oldSigner = new preview.PreviewTicketSigner({ ...signerOptions,
      now: () => new Date(Date.now() - 120000) });
    const expired = new URL(oldSigner.issue(sessionId, new Date(Date.now() - 60000))).host;
    const missingId = randomUUID();
    assert.equal(await bounded(client.get(`atoms:preview:${missingId}`)), null);
    const missing = new URL(signer.issue(missingId, expiresAt)).host;
    const invalid = [["unsigned.preview.invalid", 401], [tampered, 401],
      [host.replace("preview.invalid", "elsewhere.invalid"), 401], [expired, 410], [missing, 404]];
    for (const upgrade of [false, true]) {
      phase = upgrade ? "WS_REJECTION" : "HTTP_REJECTION";
      for (const [candidate, status] of invalid) await reject(candidate, "/denied", status, upgrade);
      token(upgrade ? "WS_REJECTION_OK" : "HTTP_REJECTION_OK");
    }

    const paths = [`http://127.0.0.1:${decoy.port}/absolute`,
      `//127.0.0.1:${decoy.port}/authority`, `/\\127.0.0.1:${decoy.port}/backslash`];
    for (const upgrade of [false, true]) {
      phase = upgrade ? "ORIGIN_WS" : "ORIGIN_HTTP";
      for (const path of paths) await reject(host, path, 400, upgrade);
      token(upgrade ? "ORIGIN_WS_OK" : "ORIGIN_HTTP_OK");
    }

    phase = "REVOKED";
    signer.verifyHost(host); // The ticket itself must still be valid.
    assert.ok(await bounded(client.pttl(key)) > 0);
    await bounded(store.delete(sessionId));
    assert.equal(await bounded(client.get(key)), null);
    await reject(host, "/revoked", 404);
    token("REVOKED_HTTP_OK");
    await reject(host, "/revoked", 404, true);
    token("REVOKED_WS_OK");
    checkIsolation();
    token("UPSTREAM_ISOLATION_OK");
  } catch { failure = phase; }
  finally {
    try {
      if (client && owned) {
        const key = `atoms:preview:${sessionId}`;
        await bounded(client.del(key));
        assert.equal(await bounded(client.get(key)), null);
      }
      token("REDIS_CLEANUP_OK");
    } catch { failure = "CLEANUP"; }
    try {
      for (const socket of sockets) socket.destroy();
      for (const server of servers) {
        server.closeAllConnections();
        if (server.listening) await bounded(new Promise(resolve => server.close(resolve)));
      }
      if (client) await bounded(client.quit());
      token("CLIENT_CLOSED_OK");
    } catch {
      client?.disconnect();
      if (failure !== "CLEANUP") failure = "CLOSE";
    }
    token(failure ? `FAILED_${failure}` : "REJECTION_OK");
    process.exitCode = failure ? 1 : 0;
  }
})();
'@

function New-ProbeCarrier {
    if ($script:StageFile -notmatch "^/tmp/atoms-pvneg-[a-f0-9]{32}[.]b64$") { throw "Unsafe in-container staging path." }
    $context = @{ nonce = $script:RunId; port = 3002; file = $script:StageFile }
    $source = "const K=" + (ConvertTo-Json -InputObject $context -Compress -Depth 5) + ";" + [Environment]::NewLine + $LiveJavaScript
    $memory = [IO.MemoryStream]::new()
    $gzip = [IO.Compression.GZipStream]::new($memory, [IO.Compression.CompressionLevel]::SmallestSize, $true)
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($source)
        $gzip.Write($bytes, 0, $bytes.Length)
    } finally { $gzip.Dispose() }
    try {
        $compressed = $memory.ToArray()
    } finally { $memory.Dispose() }
    $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($compressed)).ToLowerInvariant()
    $encoded = [Convert]::ToBase64String($compressed).TrimEnd("=").Replace("+", "-").Replace("/", "_")
    if ($encoded -notmatch "^[A-Za-z0-9_-]+$" -or $hash -notmatch "^[a-f0-9]{64}$") { throw "Probe carrier encoding failed." }
    $chunkSize = 1675
    $chunks = @()
    for ($offset = 0; $offset -lt $encoded.Length; $offset += $chunkSize) {
        $chunks += $encoded.Substring($offset, [Math]::Min($chunkSize, $encoded.Length - $offset))
    }
    if ($chunks.Count -lt 1 -or $chunks.Count -gt 3) { throw "Probe carrier must require one to three bounded chunks." }
    $quote = [char]34
    $commands = @()
    for ($index = 0; $index -lt $chunks.Count; $index++) {
        $method = if ($index -eq 0) { "writeFileSync" } else { "appendFileSync" }
        $options = if ($index -eq 0) { ",{flag:'wx',mode:0o600}" } else { "" }
        $command = "node -e " + $quote + "require('fs').$method('$($script:StageFile)','$($chunks[$index])'$options)" + $quote
        if ($command.Length -gt 1800) { throw "A staging command exceeded the reviewed 1800-character ceiling." }
        $commands += $command
    }
    $finalSource = "const s=require('fs'),c=require('crypto'),z=require('zlib'),f='$($script:StageFile)',b=Buffer.from(s.readFileSync(f,'utf8'),'base64url');s.rmSync(f);if(c.createHash('sha256').update(b).digest('hex')!=='$hash')process.exit(72);eval(z.gunzipSync(b).toString('utf8'))"
    $finalCommand = "node -e " + $quote + $finalSource + $quote
    if ($finalCommand.Length -gt 1800) { throw "Final probe command exceeded the reviewed 1800-character ceiling." }
    return @{
        SourceLength = $source.Length
        EncodedLength = $encoded.Length
        Commands = $commands
        FinalCommand = $finalCommand
        MaxCommandLength = (@(@($commands | ForEach-Object { $_.Length })) + @($finalCommand.Length) | Measure-Object -Maximum).Maximum
    }
}

function Get-LiveOutcome([string]$Output) {
    $plain = [regex]::Replace($Output, ([char]27 + "\[[0-?]*[ -/]*[@-~]"), "")
    $required = @("PAYLOAD_CLEAN_OK", "PACKAGE_OK", "REDIS_WRITE_OK", "POSITIVE_CONTROL_OK",
        "HTTP_REJECTION_OK", "WS_REJECTION_OK", "ORIGIN_HTTP_OK", "ORIGIN_WS_OK",
        "REVOKED_HTTP_OK", "REVOKED_WS_OK", "UPSTREAM_ISOLATION_OK", "REDIS_CLEANUP_OK", "CLIENT_CLOSED_OK", "REJECTION_OK")
    $failurePattern = "(?<![A-Za-z0-9_])ATOMS_PVNEG_FAILED_(PACKAGE|FIXTURE|POSITIVE|HTTP_REJECTION|WS_REJECTION|ORIGIN_HTTP|ORIGIN_WS|REVOKED|CLEANUP|CLOSE):" +
        [regex]::Escape($script:RunId) + "(?![A-Za-z0-9_])"
    $failures = [regex]::Matches($plain, $failurePattern)
    $counts = @{}
    $recognized = $failures.Count
    $duplicate = $failures.Count -gt 1
    foreach ($name in $required) {
        $pattern = "(?<![A-Za-z0-9_])ATOMS_PVNEG_" + $name + ":" + [regex]::Escape($script:RunId) + "(?![A-Za-z0-9_])"
        $counts[$name] = [regex]::Matches($plain, $pattern).Count
        $recognized += $counts[$name]
        if ($counts[$name] -gt 1) { $duplicate = $true }
    }
    $cleanup = $counts["REDIS_CLEANUP_OK"] -eq 1
    $payloadClean = $counts["PAYLOAD_CLEAN_OK"] -eq 1
    $writeObserved = $counts["REDIS_WRITE_OK"] -eq 1
    if ($failures.Count -eq 1 -and $counts["REJECTION_OK"] -eq 0 -and -not $duplicate) {
        return @{ Kind = "Failure"; Code = ("ATOMS_LIVE_PROBE_FAILED_" + $failures[0].Groups[1].Value);
            Cleanup = $cleanup; PayloadClean = $payloadClean; WriteObserved = $writeObserved }
    }
    if ($failures.Count -eq 0 -and -not $duplicate -and @($required | Where-Object { $counts[$_] -ne 1 }).Count -eq 0) {
        return @{ Kind = "Success"; Code = "ATOMS_LIVE_SESSION_OK"; Cleanup = $true; PayloadClean = $true; WriteObserved = $true }
    }
    if ($duplicate -or ($failures.Count -gt 0 -and $counts["REJECTION_OK"] -gt 0)) {
        return @{ Kind = "Ambiguous"; Code = "ATOMS_LIVE_SIGNAL_AMBIGUOUS"; Cleanup = $cleanup; PayloadClean = $payloadClean; WriteObserved = $writeObserved }
    }
    if ($recognized -gt 0) {
        return @{ Kind = "Incomplete"; Code = "ATOMS_LIVE_OUTPUT_INCOMPLETE"; Cleanup = $cleanup; PayloadClean = $payloadClean; WriteObserved = $writeObserved }
    }
    return @{ Kind = "None"; Code = "ATOMS_LIVE_SIGNAL_ABSENT"; Cleanup = $false; PayloadClean = $false; WriteObserved = $false }
}

function Wait-ExecSpacing {
    if ($null -ne $script:LastExecAt) {
        $elapsed = ([DateTimeOffset]::UtcNow - $script:LastExecAt).TotalSeconds
        if ($elapsed -lt 15) { Start-Sleep -Seconds ([int][Math]::Ceiling(15 - $elapsed)) }
    }
    $script:LastExecAt = [DateTimeOffset]::UtcNow
}

function Invoke-ExactExec($Target, [string]$Command, [int]$TimeoutSeconds = 180) {
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        Wait-ExecSpacing
        $result = Invoke-AzProcess @("containerapp", "exec", "--subscription", $SubscriptionId, "-g", $ResourceGroup,
            "-n", $PreviewName, "--revision", $Target.Revision, "--replica", $Target.Replica,
            "--container", $Target.Container, "--command", $Command, "--only-show-errors") $TimeoutSeconds
        $combined = ([string](P $result "Stdout")) + [Environment]::NewLine + ([string](P $result "Stderr"))
        if ($result.ExitCode -eq 0) { return @{ Result = $result; Combined = $combined; Target = $Target } }
        if ($combined -match "Handshake status 429|TooManyRequests|Too Many Requests") {
            $retry = [regex]::Match($combined, "(?i)retry-after['\s:]+(\d{1,6})")
            if ($retry.Success) { Note ("Azure exec rate limit: Retry-After " + $retry.Groups[1].Value + " seconds; no retry is attempted.") }
            throw "ATOMS_AZURE_RATE_LIMITED"
        }
        if ($combined -match "Handshake status 404|status.?404.*Not Found") {
            if ($attempt -lt 3) {
                $delay = @(20, 40)[$attempt - 1]
                Note ("Azure exec handshake returned 404 on attempt $attempt/3; waiting $delay seconds and resolving only the exact smoke revision.")
                Start-Sleep -Seconds $delay
                $Target = Find-ExactReplica
                continue
            }
            throw "ATOMS_AZURE_EXEC_HANDSHAKE_NOT_READY"
        }
        return @{ Result = $result; Combined = $combined; Target = $Target }
    }
    throw "ATOMS_AZURE_EXEC_HANDSHAKE_NOT_READY"
}

function Run-LiveSessionProbe {
    $target = Find-ExactReplica
    Note "Allowing 15 seconds for Azure's exec websocket route to stabilize."
    Start-Sleep -Seconds 15
    $script:LastExecAt = $null
    Save-Checkpoint "payload-staging"
    for ($index = 0; $index -lt @($script:ProbeCarrier.Commands).Count; $index++) {
        if ($index -eq 0) { $script:StageFileMayExist = $true }
        $stageResult = Invoke-ExactExec $target $script:ProbeCarrier.Commands[$index] 120
        $target = P $stageResult "Target"
        if ((P (P $stageResult "Result") "ExitCode") -ne 0) {
            throw (Failure-Class ([string](P $stageResult "Combined")))
        }
    }
    Ok ("Non-secret in-container probe payload staged in " + @($script:ProbeCarrier.Commands).Count + " bounded chunks")
    $execution = Invoke-ExactExec $target $script:ProbeCarrier.FinalCommand 150
    $outcome = Get-LiveOutcome ([string](P $execution "Combined"))
    if ((P $outcome "PayloadClean") -eq $true) { $script:StageFileMayExist = $false }
    if ((P $outcome "Kind") -ceq "Success") {
        if ((P (P $execution "Result") "ExitCode") -ne 0) {
            Note "Azure CLI returned nonzero only after every exact nonce-bound success token; accepting complete proof."
        }
        Save-Checkpoint "probe-finished"
        Ok "Positive routing/header control; HTTP/WebSocket invalid, expired, missing, revoked and origin-override rejection; upstream isolation and cleanup passed"
        return
    }
    if (((P $outcome "WriteObserved") -eq $true -and (P $outcome "Cleanup") -ne $true) -or
        (P $outcome "Code") -ceq "ATOMS_LIVE_PROBE_FAILED_CLEANUP") {
        throw "ATOMS_LIVE_REDIS_CLEANUP_UNCONFIRMED"
    }
    if ((P $outcome "Kind") -ceq "Failure") { throw (P $outcome "Code") }
    throw (P $outcome "Code")
}

function Initialize-Audit {
    if (-not $script:AzureConfigDirectory) {
        if ($env:AZURE_CONFIG_DIR) { $script:AzureConfigDirectory = $env:AZURE_CONFIG_DIR }
        elseif ($env:USERPROFILE) { $script:AzureConfigDirectory = Join-Path $env:USERPROFILE ".azure-atoms" }
        else { throw "Specify the existing -AzureConfigDirectory used for the authorized Atoms-Staging profile." }
    }
    if (-not [IO.Directory]::Exists($script:AzureConfigDirectory)) {
        throw "Existing staging Azure profile directory missing; no login or profile is created."
    }
    $script:AzureConfigDirectory = [IO.Path]::GetFullPath($script:AzureConfigDirectory)
    $script:RunRoot = Join-Path ([IO.Path]::GetTempPath()) ("atoms-preview-private-rejection-v19-" + [Guid]::NewGuid().ToString("N"))
    [void][IO.Directory]::CreateDirectory($script:RunRoot)
    $script:TranscriptPath = Join-Path $script:RunRoot "transcript.log"
    Start-Transcript -LiteralPath $script:TranscriptPath | Out-Null
    $script:TranscriptStarted = $true
}

function Safe-Error($ErrorRecord) {
    $match = [regex]::Match([string]$ErrorRecord.Exception.Message, "ATOMS_[A-Z_]+")
    if ($match.Success) { return $match.Value }
    if ([string]$ErrorRecord.Exception.Message -match "drift|not the original or exact script-owned") { return "ATOMS_CONFIGURATION_DRIFT_REFUSED" }
    if ([string]$ErrorRecord.Exception.Message -match "profile directory|AzureConfigDirectory") { return "ATOMS_EXISTING_AZURE_PROFILE_REQUIRED" }
    return "ATOMS_GUARD_OR_OPERATION_FAILED"
}

function Invoke-LiveSessionSmoke {
    try {
        Initialize-Audit
        Write-Host "Atoms Staging Preview Gateway private HTTP/WebSocket rejection smoke v19"
        Write-Host "One TTL-bounded Redis fixture key; loopback upstream only; no build, secret retrieval/copy, public exposure, run/provider execution, OpenAI or E2B."
        Step "Lock the existing Azure profile to Atoms-Staging"; Lock-Staging

        if ($RecoveryCheckpoint) {
            Step "Validate the exact narrow v19 recovery checkpoint"; Import-RecoveryCheckpoint $RecoveryCheckpoint
            Step "Verify public/execution boundaries and deployed artifact"; $environment = Verify-Boundaries
            $preview = Get-Preview; Gateway-IdentitySummary $preview; Verify-DeployedArtifact $preview
            $redis = Get-RedisBaseline $environment
            Require-SmokeState $preview
            $script:ScaleMutationMayHaveApplied = $true
            Step "Restore scale-to-zero only"; Restore-Scale "$($script:RevisionPrefix)-r"
            Step "Re-verify the unchanged private/public safety boundaries"
            $environment = Verify-Boundaries
            $finalRedis = Get-RedisBaseline $environment
            if ((P $finalRedis "MetadataHash") -cne (P $redis "MetadataHash")) { throw "Redis/private-network metadata drift during recovery." }
            $preview = Get-Preview; Require-SmokeState $preview; Verify-DeployedArtifact $preview; Lock-Staging
            $script:CommitSucceeded = $true
            Write-Host "PRIVATE REJECTION SMOKE RECOVERY CONFIRMED" -ForegroundColor Green
            return
        }

        Step "Verify pinned source/tree and full-main CI"; Verify-Source
        Step "Verify public/execution boundaries"; $environment = Verify-Boundaries
        Step "Capture the exact deployed v17 image/OSSCluster/min=0 baseline"
        $preview = Get-Preview
        Gateway-IdentitySummary $preview
        Verify-DeployedArtifact $preview
        $script:Original = Capture-Baseline $preview
        $redis = Get-RedisBaseline $environment
        $script:RedisMetadataHash = [string](P $redis "MetadataHash")
        $script:ProbeCarrier = New-ProbeCarrier
        Save-Checkpoint "preflight"
        Ok ("Probe carrier prepared before mutation: chunks=" + @($script:ProbeCarrier.Commands).Count +
            ", encoded=" + $script:ProbeCarrier.EncodedLength + ", max-command=" + $script:ProbeCarrier.MaxCommandLength + "/1800")
        Ok "Fixture scope: one random Redis key, maximum initial TTL=60s, explicit revocation, DEL+GET(null) cleanup"
        if (-not $Apply) {
            Write-Host ""
            Write-Host "READ-ONLY PRIVATE REJECTION PREFLIGHT SUCCEEDED" -ForegroundColor Green
            Write-Host "Redis write/scale/exec/build/deployment: NOT STARTED. Re-run this same script with -Apply."
            return
        }

        Step "Re-check for concurrent configuration/network drift before the smoke"
        $environment = Verify-Boundaries
        $preview = Get-Preview
        Require-SmokeState $preview
        Verify-DeployedArtifact $preview
        $currentRedis = Get-RedisBaseline $environment
        if ((P $currentRedis "MetadataHash") -cne $script:RedisMetadataHash) { throw "Redis/private-network metadata drift; no smoke mutation." }

        Step "Temporarily scale the exact private Gateway from min=0 to min=1"
        [void](Patch-Scale 1 "$($script:RevisionPrefix)-a")
        Step "Run the bounded private rejection probe inside the exact replica"
        Run-LiveSessionProbe
        Step "Restore and verify min=0/max=1"
        [void](Patch-Scale 0 "$($script:RevisionPrefix)-z")
        Wait-ReadyRevision "$($script:RevisionPrefix)-z"
        $script:ScaleMutationMayHaveApplied = $false
        Save-Checkpoint "restored"

        Step "Re-verify the deployed image, Redis topology and every safety boundary"
        $environment = Verify-Boundaries
        $finalRedis = Get-RedisBaseline $environment
        if ((P $finalRedis "MetadataHash") -cne $script:RedisMetadataHash) { throw "Final Redis/private-network metadata differs." }
        $preview = Get-Preview
        Require-SmokeState $preview
        Verify-DeployedArtifact $preview
        Lock-Staging
        Save-Checkpoint "succeeded"
        $script:CommitSucceeded = $true

        Write-Host ""
        Write-Host "PRIVATE HTTP/WEBSOCKET REJECTION SMOKE SUCCEEDED" -ForegroundColor Green
        Write-Host "Gateway image          : $DeployedImage"
        Write-Host "Positive HTTP control  : LIVE ROUTING + HEADER OVERRIDE VERIFIED"
        Write-Host "HTTP/WS ticket checks  : UNSIGNED/TAMPERED/WRONG-DOMAIN=401; EXPIRED=410"
        Write-Host "HTTP/WS session checks : MISSING/REVOKED=404; ORIGIN OVERRIDE=400"
        Write-Host "Rejected upstream hits : NONE ON SELECTED OR DECOY LOOPBACK FIXTURE"
        Write-Host "Redis fixture          : ONE RANDOM KEY / TTL <=60s / REVOKED / DELETED / ABSENT"
        Write-Host "Redis public network   : DISABLED"
        Write-Host "Gateway ingress / scale: INTERNAL HTTPS ONLY / min 0 max 1"
        Write-Host "Public domain/TLS      : NONE"
        Write-Host "RUN/provider execution : DISABLED / NONE"
        Write-Host "OpenAI / E2B           : NONE"
        Write-Host "Secret values exposed  : NONE"
        Write-Host "Public preview remains blocked without an owned domain and wildcard TLS."
    } catch {
        $script:ExitStatus = 1
        Write-Host ""
        Write-Host "PRIVATE REJECTION SMOKE NOT SUCCEEDED" -ForegroundColor Red
        Write-Host ("Safe stage: " + $script:Stage)
        Write-Host ("Safe error: " + (Safe-Error $_))
    } finally {
        if ($script:ScaleMutationMayHaveApplied -and -not $script:CommitSucceeded) {
            try { Restore-Scale "$($script:RevisionPrefix)-r" }
            catch {
                $script:ExitStatus = 1
                Write-Warning ("SCALE-TO-ZERO RESTORE NOT CONFIRMED: " + (Safe-Error $_))
                Write-Warning "Stop; use the printed recovery checkpoint with the existing authorized staging profile."
            }
        }
        if ($script:StageFileMayExist) {
            Note "Temporary payload is non-secret; direct file deletion was not confirmed. Refer to the scale restoration result above."
        }
        if ($script:CheckpointPath) { Write-Host ("Checkpoint: " + $script:CheckpointPath) }
        if ($script:TranscriptStarted) {
            try { Stop-Transcript | Out-Null } catch { }
            Write-Host ("Transcript: " + $script:TranscriptPath)
            try { [IO.File]::ReadAllText($script:TranscriptPath) | Set-Clipboard; Write-Host "Full transcript copied to clipboard." } catch { }
        }
    }
}

if ($CheckOnly) {
    $carrier = New-ProbeCarrier
    Write-Host ("CHECK ONLY PASSED: PowerShell parsed; rejection carrier chunks=" + @($carrier.Commands).Count +
        ", encoded=" + $carrier.EncodedLength + ", max-command=" + $carrier.MaxCommandLength + "/1800. No Azure, filesystem mutation, or Redis operation was performed.")
    return
}
Invoke-LiveSessionSmoke
exit $script:ExitStatus
