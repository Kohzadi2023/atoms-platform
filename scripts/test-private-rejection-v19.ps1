param([string]$Artifact = "$PSScriptRoot/atoms-staging-preview-gateway-private-rejection-smoke-v19.ps1")
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$tokens = $null; $parseErrors = $null
[void][Management.Automation.Language.Parser]::ParseFile($Artifact, [ref]$tokens, [ref]$parseErrors)
if (@($parseErrors).Count) { throw "Parser errors: $(@($parseErrors).Count)" }
. $Artifact -CheckOnly

$script:Checks = 0
function Check($Condition, [string]$Message) {
    if (-not $Condition) { throw "V19 OFFLINE ASSERTION FAILED: $Message" }
    $script:Checks++
}
function Reject([scriptblock]$Code, [string]$Message) {
    $failed = $false; try { & $Code | Out-Null } catch { $failed = $true }
    Check $failed $Message
}
function Get-Arg([string[]]$Arguments, [string]$Name) {
    $index = [Array]::IndexOf($Arguments, $Name)
    if ($index -lt 0) { return "" }
    return $Arguments[$index + 1]
}
function Json-Response($Value) {
    return @{ ExitCode = 0; Stderr = ""; Stdout = ConvertTo-Json -InputObject $Value -Depth 100 -Compress }
}
function Merge-Patch($Target, $Patch) {
    foreach ($key in $Patch.Keys) {
        if ($null -eq $Patch[$key]) { [void]$Target.Remove($key) }
        elseif ($Patch[$key] -is [Collections.IDictionary]) {
            if ($Target[$key] -isnot [Collections.IDictionary]) { $Target[$key] = @{} }
            Merge-Patch $Target[$key] $Patch[$key]
        } else { $Target[$key] = Copy-Data $Patch[$key] }
    }
}

$source = [IO.File]::ReadAllText($Artifact)
Check (-not $source.Contains('"acr", "build"')) "Production script has no ACR build code path"
Check (-not $source.Contains('"containerapp", "job"')) "Production script has no Container Apps Job code path"
Check (-not $source.Contains("list-credentials")) "Production script never requests registry/Redis credentials"
Check (-not $source.Contains("external = `$true")) "Production script never enables external ingress"
Check ($source.Contains("maximum initial TTL=60s")) "Bounded Redis TTL is operator-visible"

$subnet = "$ScopeRoot/providers/Microsoft.Network/virtualNetworks/atoms-staging-vnet/subnets/container-apps"
$peSubnet = "$ScopeRoot/providers/Microsoft.Network/virtualNetworks/atoms-staging-vnet/subnets/private-endpoints"
$redisId = "$ScopeRoot/providers/Microsoft.Cache/redisEnterprise/atoms-staging-redis"
$peId = "$ScopeRoot/providers/Microsoft.Network/privateEndpoints/atoms-staging-redis-pe"
$nicId = "$ScopeRoot/providers/Microsoft.Network/networkInterfaces/atoms-staging-redis-nic"
$zoneId = "$ScopeRoot/providers/Microsoft.Network/privateDnsZones/privatelink.redis.azure.net"
$ids = @{}; $ids[$GatewayPullIdentity.ToLowerInvariant()] = @{ principalId = "fixture-runtime"; clientId = "fixture-client" }
$Baseline = @{
    id = $PreviewId; name = $PreviewName; location = "Canada Central"; etag = 'W/"fixture"'; tags = @{ project = "atoms"; environment = "staging" }
    identity = @{ type = "UserAssigned"; userAssignedIdentities = $ids }
    properties = @{
        environmentId = $EnvironmentId; workloadProfileName = "Consumption"; provisioningState = "Succeeded"
        latestRevisionName = "$PreviewName--pvrt-v17fixture-z"; latestReadyRevisionName = "$PreviewName--pvrt-v17fixture-z"
        configuration = @{
            activeRevisionsMode = "Single"
            ingress = @{ external = $false; allowInsecure = $false; targetPort = 3002; fqdn = $InternalFqdn; customDomains = @(); traffic = @(@{ latestRevision = $true; weight = 100 }) }
            secrets = @(@{ name = "redis-url"; keyVaultUrl = "https://fixture.vault.azure.net/secrets/redis"; identity = $GatewayPullIdentity },
                @{ name = "preview-signing-secret"; keyVaultUrl = "https://fixture.vault.azure.net/secrets/sign"; identity = $GatewayPullIdentity })
            registries = @(@{ server = $AcrServer; identity = $GatewayPullIdentity.Replace("/resourceGroups/", "/resourcegroups/") })
        }
        template = @{
            revisionSuffix = "pvrt-v17fixture-z"; scale = @{ minReplicas = 0; maxReplicas = 1; rules = @(@{ name = "http"; http = @{ metadata = @{ concurrentRequests = "10" } } }) }
            containers = @(@{
                name = $PreviewName; image = $DeployedImage; resources = @{ cpu = 0.25; memory = "0.5Gi" }
                env = @(
                    @{ name = "REDIS_URL"; secretRef = "redis-url" }, @{ name = "PREVIEW_SIGNING_SECRET"; secretRef = "preview-signing-secret" },
                    @{ name = "PREVIEW_BASE_DOMAIN"; value = "preview.invalid" }, @{ name = "PREVIEW_UI_ORIGIN"; value = $UiOrigin },
                    @{ name = "PREVIEW_PUBLIC_PROTOCOL"; value = "https" }, @{ name = "PREVIEW_GATEWAY_HOST"; value = "0.0.0.0" },
                    @{ name = "PREVIEW_GATEWAY_PORT"; value = "3002" }, @{ name = "PREVIEW_REDIS_MODE"; value = "oss-cluster" },
                    @{ name = "NODE_ENV"; value = "production" }
                )
                probes = @(@{ type = "Readiness"; httpGet = @{ path = "/healthz"; port = 3002; scheme = "HTTP" }; initialDelaySeconds = 3; periodSeconds = 5 })
            })
        }
    }
}
$script:FixtureEnvironment = @{ id = $EnvironmentId; name = $EnvironmentName; location = "canadacentral"; properties = @{ defaultDomain = $DefaultDomain; vnetConfiguration = @{ infrastructureSubnetId = $subnet } } }
$script:FixtureApi = @{ id = "$ScopeRoot/providers/Microsoft.App/containerApps/$ApiName"; properties = @{ environmentId = $EnvironmentId; template = @{ containers = @(@{ name = $ApiName; env = @(@{ name = "AUTH_REQUIRED"; value = "true" }, @{ name = "RUN_EXECUTION_ENABLED"; value = "false" }) }) } } }
$script:FixtureRedis = @{ id = $redisId; properties = @{ hostName = "fixture.canadacentral.redis.azure.net"; provisioningState = "Succeeded"; resourceState = "Running"; publicNetworkAccess = "Disabled" } }
$script:FixtureDb = @{ value = @(@{ id = "$redisId/databases/default"; properties = @{ provisioningState = "Succeeded"; resourceState = "Running"; clientProtocol = "Encrypted"; accessKeysAuthentication = "Enabled"; clusteringPolicy = "OSSCluster"; port = 10000 } }) }
$script:FixturePe = @{ id = $peId; name = "atoms-staging-redis-pe"; provisioningState = "Succeeded"; subnet = @{ id = $peSubnet }; networkInterfaces = @(@{ id = $nicId }); privateLinkServiceConnections = @(@{ privateLinkServiceId = $redisId; groupIds = @("redisEnterprise"); privateLinkServiceConnectionState = @{ status = "Approved" } }) }
$script:FixtureNic = @{ id = $nicId; ipConfigurations = @(@{ subnet = @{ id = $peSubnet }; privateIPAddress = "10.41.0.4" }) }
$script:FixtureGroup = @{ id = "$peId/privateDnsZoneGroups/default"; name = "default"; provisioningState = "Succeeded"; privateDnsZoneConfigs = @(@{ privateDnsZoneId = $zoneId }) }
$script:CaseRoot = Join-Path ([IO.Path]::GetTempPath()) ("atoms-v19-offline-" + [Guid]::NewGuid().ToString("N"))
[void][IO.Directory]::CreateDirectory($script:CaseRoot)

# Exercise the real ProcessStartInfo wrapper before replacing it with the
# offline ARM mock. Node only echoes argv; no Azure executable is invoked.
$nativeCarrier = New-ProbeCarrier
$nativeArgs = @($nativeCarrier.FinalCommand) + @($nativeCarrier.Commands)
$script:AzureConfigDirectory = $script:CaseRoot
$script:AzLaunch = @{ FileName = (Get-Command node).Source; PrefixArgs = @("-e",
    "process.stderr.write('fixture-warning');process.stdout.write(JSON.stringify(process.argv.slice(1)))") }
$native = Invoke-AzProcess -Arguments $nativeArgs -TimeoutSeconds 20
Check ($native.ExitCode -eq 0 -and $native.Stderr -ceq "fixture-warning") "Native stdout/stderr are captured separately"
$roundTrip = ConvertFrom-Json -InputObject $native.Stdout -NoEnumerate
Check ((Fingerprint $roundTrip) -ceq (Fingerprint $nativeArgs)) "Native argv preserves every quote and carrier byte"
$script:AzLaunch = @{ FileName = (Get-Command node).Source; PrefixArgs = @("-e", "process.exit(9)") }
$native = Invoke-AzProcess -Arguments @() -TimeoutSeconds 20
Check ($native.ExitCode -eq 9) "Native nonzero exit cannot be lost"
$script:AzLaunch = $null

function Initialize-Audit {
    $script:RunRoot = Join-Path $script:CaseRoot $script:CaseName
    [void][IO.Directory]::CreateDirectory($script:RunRoot)
    $script:TranscriptStarted = $false
    $script:TranscriptPath = ""
}
function Start-Sleep { param([int]$Seconds, [int]$Milliseconds) }
function Http-Safety([string]$Uri, [int]$Expected) {
    Check ($Uri -match "^https://atoms-staging-control-api[.]" -and $Expected -in @(200, 401)) "Only fixed Control API safety probes"
}
function Public-GitHub([string]$Path) {
    if ($Path.StartsWith("git/commits/")) { return @{ sha = $SourceSha; tree = @{ sha = $SourceTree } } }
    if ($Path.Contains("/jobs?")) { return @{ jobs = @("changes", "verify", "migration-matrix", "attachment-storage-integration", "preview-runtime-integration") | ForEach-Object { @{ name = $_; status = "completed"; conclusion = "success" } } } }
    return @{ head_sha = $SourceSha; status = "completed"; conclusion = "success"; event = "push"; head_branch = "main" }
}
$script:ActualSafeError = (Get-Command Safe-Error).ScriptBlock
function Safe-Error($Record) { $script:LastFailure = [string]$Record.Exception.Message; & $script:ActualSafeError $Record }

function Success-Tokens {
    $names = @("PAYLOAD_CLEAN_OK", "PACKAGE_OK", "REDIS_WRITE_OK", "POSITIVE_CONTROL_OK", "HTTP_REJECTION_OK", "WS_REJECTION_OK", "ORIGIN_HTTP_OK", "ORIGIN_WS_OK", "REVOKED_HTTP_OK", "REVOKED_WS_OK", "UPSTREAM_ISOLATION_OK", "REDIS_CLEANUP_OK", "CLIENT_CLOSED_OK", "REJECTION_OK")
    return @($names | ForEach-Object { "ATOMS_PVNEG_$($_):$($script:RunId)" }) -join [Environment]::NewLine
}

function Invoke-AzProcess([string[]]$Arguments, [int]$TimeoutSeconds = 120) {
    [void]$script:Calls.Add(@($Arguments))
    if ($Arguments -contains "--help") { return @{ ExitCode = 0; Stderr = ""; Stdout = "--replica --revision --container --command" } }
    Check ((Get-Arg $Arguments "--subscription") -ceq $SubscriptionId) "Every Azure operation is scoped to Atoms-Staging"
    $prefix = @($Arguments[0..([Math]::Min(2, $Arguments.Count - 1))]) -join " "
    switch -Wildcard ($prefix) {
        "account set*" { return @{ ExitCode = 0; Stderr = ""; Stdout = "" } }
        "account show*" { return Json-Response @{ id = $SubscriptionId; name = "Atoms-Staging"; state = "Enabled" } }
        "acr show*" { return Json-Response @{ id = "$ScopeRoot/providers/Microsoft.ContainerRegistry/registries/$AcrName"; loginServer = $AcrServer } }
        "acr task show-run" {
            $digest = if ($script:CaseName -ceq "artifact-mismatch") { "sha256:" + ("a" * 64) } else { $DeployedDigest }
            return Json-Response @{ runId = $AcrRunId; status = "Succeeded"; platform = @{ os = "linux"; architecture = "amd64" }; outputImages = @(@{ repository = "preview-gateway"; tag = $DeployedTag; digest = $digest }) }
        }
        "acr repository show" { return @{ ExitCode = 0; Stderr = ""; Stdout = $DeployedDigest } }
        "resource list*" {
            if ((Get-Arg $Arguments "--resource-type") -ceq "Microsoft.Cache/redisEnterprise") { return Json-Response @(@{ id = $redisId }) }
            return Json-Response @()
        }
        "network private-endpoint list" { return Json-Response @($script:FixturePe) }
        "network private-endpoint dns-zone-group" { return Json-Response @($script:FixtureGroup) }
        "network nic show" { return Json-Response $script:FixtureNic }
        "containerapp env show" { return Json-Response $script:FixtureEnvironment }
        "containerapp env certificate" { return Json-Response @() }
        "containerapp revision list" {
            return Json-Response @(@{ name = $script:StateApp.properties.latestRevisionName; properties = @{ active = $true; healthState = "Healthy"; provisioningState = "Provisioned"; template = Copy-Data $script:StateApp.properties.template } })
        }
        "containerapp replica list" {
            $revision = Get-Arg $Arguments "--revision"
            return Json-Response @(@{ name = "$revision-replica1"; properties = @{ containers = @(@{ name = $PreviewName; runningState = "running" }) } })
        }
        "containerapp exec*" {
            $script:ExecCalls++
            $command = Get-Arg $Arguments "--command"
            Check ($command.Length -le 1800) "Every exec command stays below the reviewed ceiling"
            Check ((Get-Arg $Arguments "--revision") -ceq "$PreviewName--$($script:RevisionPrefix)-a") "Exec never falls back to another revision"
            if ($script:CaseName -ceq "exec-429" -and $script:ExecCalls -eq 1) { return @{ ExitCode = 1; Stdout = ""; Stderr = "Handshake status 429 Too Many Requests retry-after': '600' DO_NOT_PRINT_SECRET" } }
            $notReady = if ($script:CaseName -ceq "exec-404-once") { 1 } elseif ($script:CaseName -ceq "exec-404-all") { 3 } else { 0 }
            if ($script:ExecCalls -le $notReady) { return @{ ExitCode = 1; Stdout = ""; Stderr = "Handshake status 404 Not Found DO_NOT_PRINT_SECRET" } }
            if ($command.Contains("writeFileSync")) { $script:StageChunks = 1; return @{ ExitCode = 0; Stdout = ""; Stderr = "" } }
            if ($command.Contains("appendFileSync")) { $script:StageChunks++; return @{ ExitCode = 0; Stdout = ""; Stderr = "" } }
            Check ($script:StageChunks -eq @($script:ProbeCarrier.Commands).Count -and $command.Contains("createHash('sha256')")) "Final command follows all integrity-checked chunks"
            $success = Success-Tokens
            if ($script:CaseName -ceq "success-stderr") { return @{ ExitCode = 0; Stdout = ""; Stderr = "connected`n$success" } }
            if ($script:CaseName -ceq "success-nonzero") { return @{ ExitCode = 1; Stdout = $success; Stderr = "transport close DO_NOT_PRINT_SECRET" } }
            if ($script:CaseName -ceq "failure-http") {
                return @{ ExitCode = 1; Stderr = "remote exit"; Stdout = "ATOMS_PVNEG_PAYLOAD_CLEAN_OK:$($script:RunId)`nATOMS_PVNEG_PACKAGE_OK:$($script:RunId)`nATOMS_PVNEG_REDIS_WRITE_OK:$($script:RunId)`nATOMS_PVNEG_POSITIVE_CONTROL_OK:$($script:RunId)`nATOMS_PVNEG_REDIS_CLEANUP_OK:$($script:RunId)`nATOMS_PVNEG_CLIENT_CLOSED_OK:$($script:RunId)`nATOMS_PVNEG_FAILED_HTTP_REJECTION:$($script:RunId)" }
            }
            if ($script:CaseName -ceq "cleanup-unconfirmed") {
                return @{ ExitCode = 1; Stderr = "remote exit"; Stdout = "ATOMS_PVNEG_PAYLOAD_CLEAN_OK:$($script:RunId)`nATOMS_PVNEG_PACKAGE_OK:$($script:RunId)`nATOMS_PVNEG_REDIS_WRITE_OK:$($script:RunId)`nATOMS_PVNEG_FAILED_CLEANUP:$($script:RunId)" }
            }
            if ($script:CaseName -ceq "signal-absent") { return @{ ExitCode = 0; Stdout = ""; Stderr = "connected" } }
            if ($script:CaseName -ceq "signal-incomplete") { return @{ ExitCode = 0; Stdout = "ATOMS_PVNEG_PAYLOAD_CLEAN_OK:$($script:RunId)"; Stderr = "" } }
            if ($script:CaseName -ceq "signal-ambiguous") { return @{ ExitCode = 0; Stdout = "$success`n$success"; Stderr = "" } }
            if ($script:CaseName -ceq "unrelated-drift") {
                $script:StateApp.properties.template.containers[0].resources.memory = "1Gi"
                return @{ ExitCode = 1; Stdout = "ATOMS_PVNEG_FAILED_HTTP_REJECTION:$($script:RunId)"; Stderr = "" }
            }
            return @{ ExitCode = 0; Stdout = $success; Stderr = "" }
        }
        "rest --method get" {
            $url = Get-Arg $Arguments "--url"
            if ($url.StartsWith("https://management.azure.com" + $PreviewId + "?")) { return Json-Response $script:StateApp }
            if ($url.StartsWith("https://management.azure.com" + $script:FixtureApi.id + "?")) { return Json-Response $script:FixtureApi }
            if ($url.StartsWith("https://management.azure.com" + $redisId + "/databases?")) { return Json-Response $script:FixtureDb }
            if ($url.StartsWith("https://management.azure.com" + $redisId + "?")) { return Json-Response $script:FixtureRedis }
            throw "Unexpected ARM GET"
        }
        "rest --method patch" {
            $script:PatchCalls++
            Check ((Get-Arg $Arguments "--url") -ceq $PreviewUrl) "Only the exact Gateway is patched"
            Check ($Arguments -contains "--headers") "ETag concurrency guard is retained when available"
            $body = Parse-Json ([IO.File]::ReadAllText((Get-Arg $Arguments "--body").Substring(1)))
            Check ((@($body.Keys | Sort-Object) -join "|") -ceq "location|properties") "Patch has only reviewed roots"
            Check ((@($body.properties.Keys) -join "|") -ceq "template") "Patch never touches configuration/identity/ingress/secrets"
            Check ((@($body.properties.template.Keys | Sort-Object) -join "|") -ceq "revisionSuffix|scale") "Patch changes only scale and revision suffix"
            Check ((@($body.properties.template.scale.Keys) -join "|") -ceq "minReplicas") "Patch never overwrites max/rules"
            Merge-Patch $script:StateApp $body
            $script:StateApp.properties.latestRevisionName = "$PreviewName--$($script:StateApp.properties.template.revisionSuffix)"
            $script:StateApp.properties.latestReadyRevisionName = $script:StateApp.properties.latestRevisionName
            if ($script:CaseName -ceq "patch-response-failed" -and $script:PatchCalls -eq 1) { return @{ ExitCode = 1; Stdout = ""; Stderr = "Unexpected response after mutation DO_NOT_PRINT_SECRET" } }
            return @{ ExitCode = 0; Stdout = ""; Stderr = "" }
        }
    }
    throw "Unexpected Azure command: $prefix"
}

function Reset-Case([string]$Name) {
    $script:CaseName = $Name
    $script:StateApp = Copy-Data $Baseline
    $script:Calls = [Collections.Generic.List[object]]::new()
    $script:RunId = if ($Name -ceq "success-nonzero") { "4293456789abcdef0123456789abcdef" } else { "0123456789abcdef0123456789abcdef" }
    $script:RevisionPrefix = "pvneg-" + $script:RunId.Substring(0, 12)
    $script:StageFile = "/tmp/atoms-pvneg-$($script:RunId).b64"
    $script:Original = $null; $script:ProbeCarrier = $null; $script:RedisMetadataHash = ""
    $script:CheckpointPath = ""; $script:ScaleMutationMayHaveApplied = $false; $script:StageFileMayExist = $false
    $script:CommitSucceeded = $false; $script:ExitStatus = 0; $script:LastFailure = ""; $script:LastExecAt = $null
    $script:PatchCalls = 0; $script:ExecCalls = 0; $script:StageChunks = 0
    $script:Apply = $true; $script:CheckOnly = $false; $script:RecoveryCheckpoint = ""
    $script:AzureConfigDirectory = $script:CaseRoot
}

$successCases = @("success", "success-stderr", "success-nonzero", "exec-404-once")
$failureCases = @("failure-http", "cleanup-unconfirmed", "signal-absent", "signal-incomplete", "signal-ambiguous", "exec-429", "exec-404-all", "patch-response-failed", "artifact-mismatch", "wrong-image", "wrong-mode", "wrong-min", "public-ingress", "unrelated-drift")
$caseNames = $successCases + @("preflight") + $failureCases
foreach ($name in $caseNames) {
    Reset-Case $name
    if ($name -ceq "preflight") { $script:Apply = $false }
    if ($name -ceq "wrong-image") { $script:StateApp.properties.template.containers[0].image = "$AcrServer/preview-gateway@sha256:$('a' * 64)" }
    if ($name -ceq "wrong-mode") {
        $modeFixture = @($script:StateApp.properties.template.containers[0].env | Where-Object { $_.name -ceq "PREVIEW_REDIS_MODE" })[0]
        $modeFixture.value = "standalone"
    }
    if ($name -ceq "wrong-min") { $script:StateApp.properties.template.scale.minReplicas = 1 }
    if ($name -ceq "public-ingress") { $script:StateApp.properties.configuration.ingress.external = $true }
    $identityHash = Fingerprint $script:StateApp.identity
    $registryHash = Fingerprint $script:StateApp.properties.configuration.registries
    $output = @(Invoke-LiveSessionSmoke *>&1)
    if ($name -in $successCases) {
        Check ($script:ExitStatus -eq 0 -and $script:CommitSucceeded) "$name succeeds"
        Check ($script:PatchCalls -eq 2) "$name uses exactly scale-up and scale-down patches"
        Check ($script:ExecCalls -eq (@($script:ProbeCarrier.Commands).Count + 1 + $(if ($name -ceq "exec-404-once") { 1 } else { 0 }))) "$name uses bounded exec calls"
        Check ($script:StateApp.properties.template.scale.minReplicas -eq 0) "$name restores min=0"
        Check ($script:StateApp.properties.template.containers[0].image -ceq $DeployedImage) "$name preserves exact image"
        Check ((Env-Value $script:StateApp "PREVIEW_REDIS_MODE") -ceq "oss-cluster") "$name preserves OSSCluster"
    } elseif ($name -ceq "preflight") {
        Check ($script:ExitStatus -eq 0 -and $script:PatchCalls -eq 0 -and $script:ExecCalls -eq 0) "Default preflight is Azure-read-only"
    } else {
        Check ($script:ExitStatus -eq 1 -and -not $script:CommitSucceeded) "$name cannot pass"
        if ($name -in @("artifact-mismatch", "wrong-image", "wrong-mode", "wrong-min", "public-ingress")) {
            Check ($script:PatchCalls -eq 0 -and $script:ExecCalls -eq 0) "$name stops before mutation"
        } elseif ($name -ceq "unrelated-drift") {
            Check ($script:StateApp.properties.template.containers[0].resources.memory -ceq "1Gi") "Unrelated drift is preserved"
            Check (($output -join " ") -match "RESTORE NOT CONFIRMED") "Unrelated drift makes unconfirmed min=0 explicit"
        } else {
            Check ($script:StateApp.properties.template.scale.minReplicas -eq 0) "$name restores scale-to-zero"
            Check ($script:StateApp.properties.template.containers[0].image -ceq $DeployedImage) "$name never rolls image back"
        }
        if ($name -ceq "cleanup-unconfirmed") { Check (($output -join " ") -match "ATOMS_LIVE_REDIS_CLEANUP_UNCONFIRMED") "Cleanup ambiguity has highest-priority code" }
        if ($name -ceq "failure-http") { Check (($output -join " ") -match "ATOMS_LIVE_PROBE_FAILED_HTTP_REJECTION") "Live phase failure is exact" }
        if ($name -ceq "signal-absent") { Check (($output -join " ") -match "ATOMS_LIVE_SIGNAL_ABSENT") "Absent signal is exact" }
        if ($name -ceq "signal-incomplete") { Check (($output -join " ") -match "ATOMS_LIVE_OUTPUT_INCOMPLETE") "Incomplete signal is exact" }
        if ($name -ceq "signal-ambiguous") { Check (($output -join " ") -match "ATOMS_LIVE_SIGNAL_AMBIGUOUS") "Duplicate signal is rejected" }
        if ($name -ceq "exec-429") { Check ($script:ExecCalls -eq 1 -and ($output -join " ") -match "ATOMS_AZURE_RATE_LIMITED") "429 is never retried" }
        if ($name -ceq "exec-404-all") { Check ($script:ExecCalls -eq 3 -and ($output -join " ") -match "ATOMS_AZURE_EXEC_HANDSHAKE_NOT_READY") "404 retries are bounded"
        }
    }
    Check ((Fingerprint $script:StateApp.identity) -ceq $identityHash) "$name preserves full identity"
    Check ((Fingerprint $script:StateApp.properties.configuration.registries) -ceq $registryHash) "$name preserves registry configuration"
    Check (($output -join " ") -notmatch "DO_NOT_PRINT_SECRET") "$name never prints raw CLI error"
    Check (-not @($script:Calls | Where-Object { @($_)[0] -ceq "acr" -and @($_)[1] -ceq "build" }).Count) "$name never queues a build"
}

Reset-Case "recovery-source"
$script:Apply = $false
[void]@(Invoke-LiveSessionSmoke *>&1)
$recoveryPath = $script:CheckpointPath
$recoveryData = Parse-Json ([IO.File]::ReadAllText($recoveryPath))
$attempt = [string](P $recoveryData "attemptId")
$script:StateApp.properties.template.scale.minReplicas = 1
$script:StateApp.properties.template.revisionSuffix = "pvneg-$($attempt.Substring(0,12))-a"
$script:StateApp.properties.latestRevisionName = "$PreviewName--$($script:StateApp.properties.template.revisionSuffix)"
$script:StateApp.properties.latestReadyRevisionName = $script:StateApp.properties.latestRevisionName
Reset-Case "recovery-run"
# Reset-Case replaces StateApp, so re-apply only the exact checkpoint-owned interrupted state.
$script:StateApp.properties.template.scale.minReplicas = 1
$script:StateApp.properties.template.revisionSuffix = "pvneg-$($attempt.Substring(0,12))-a"
$script:StateApp.properties.latestRevisionName = "$PreviewName--$($script:StateApp.properties.template.revisionSuffix)"
$script:StateApp.properties.latestReadyRevisionName = $script:StateApp.properties.latestRevisionName
$script:RecoveryCheckpoint = $recoveryPath
$script:Apply = $false
$output = @(Invoke-LiveSessionSmoke *>&1)
Check ($script:ExitStatus -eq 0 -and $script:CommitSucceeded) "Exact v19 checkpoint recovers interrupted min=1"
Check ($script:StateApp.properties.template.scale.minReplicas -eq 0) "Recovery restores min=0"
Check ($script:StateApp.properties.template.containers[0].image -ceq $DeployedImage) "Recovery preserves deployed image"
Check ($script:ExecCalls -eq 0) "Recovery never executes the live payload"

$valid = Success-Tokens
$outcome = Get-LiveOutcome $valid
Check ((P $outcome "Kind") -ceq "Success") "Complete tokens accepted"
Check ((P (Get-LiveOutcome ("transport> " + $valid.Replace([Environment]::NewLine, "`ntransport> "))) "Kind") -ceq "Success") "Transport-framed tokens accepted"
Check ((P (Get-LiveOutcome ($valid + "`n" + $valid)) "Kind") -ceq "Ambiguous") "Duplicated proof rejected"
Check ((P (Get-LiveOutcome $valid.Replace($script:RunId, "othernonce")) "Kind") -ceq "None") "Wrong nonce rejected"
$carrier = New-ProbeCarrier
Check (@($carrier.Commands).Count -eq 3 -and $carrier.MaxCommandLength -le 1800) "Carrier uses three bounded staging execs"
Check (-not $carrier.FinalCommand.Contains("ATOMS_PVNEG_") -and
    ([regex]::Matches($carrier.FinalCommand, [regex]::Escape($script:RunId)).Count -eq 1) -and
    $carrier.FinalCommand.Contains($script:StageFile)) "Final command contains no proof token; nonce occurs only in the owned staging path"

Write-Host "V19 OFFLINE POWERSHELL TESTS PASSED: $($script:Checks) assertions; $($caseNames.Count) apply/preflight cases + recovery. No Azure request was made."
