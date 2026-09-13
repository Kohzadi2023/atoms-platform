param([string]$Artifact = "$PSScriptRoot/atoms-staging-preview-gateway-private-rollout-resume-v17.ps1")
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$tokens = $null; $parseErrors = $null
[void][Management.Automation.Language.Parser]::ParseFile($Artifact, [ref]$tokens, [ref]$parseErrors)
if (@($parseErrors).Count) { throw "Parser errors: $(@($parseErrors).Count)" }
. $Artifact -CheckOnly
$script:Checks = 0
function Check($Condition, [string]$Message) {
    if (-not $Condition) { throw "OFFLINE ASSERTION FAILED: $Message" }
    $script:Checks++
}
function Reject([scriptblock]$Code, [string]$Message) {
    $failed = $false; try { & $Code | Out-Null } catch { $failed = $true }
    Check $failed $Message
}
function Node-Check([string]$JavaScript) {
    $info = [Diagnostics.ProcessStartInfo]::new((Get-Command node).Source)
    [void]$info.ArgumentList.Add("--check")
    $info.RedirectStandardInput = $true; $info.RedirectStandardError = $true; $info.RedirectStandardOutput = $true; $info.UseShellExecute = $false
    $process = [Diagnostics.Process]::Start($info)
    $process.StandardInput.Write($JavaScript); $process.StandardInput.Close()
    $errorText = $process.StandardError.ReadToEnd(); $process.WaitForExit()
    Check ($process.ExitCode -eq 0) "Node payload syntax: $errorText"
    $process.Dispose()
}
Node-Check ("const K={host:'check.region.redis.azure.net',ips:['10.0.0.4'],nonce:'check'};" + $RuntimeJavaScript)
Node-Check $HealthJavaScript
$nodeInfo=[Diagnostics.ProcessStartInfo]::new((Get-Command node).Source)
[void]$nodeInfo.ArgumentList.Add("$PSScriptRoot/preview-smoke/test-rollout-payloads.mjs")
$nodeInfo.WorkingDirectory=$PSScriptRoot;$nodeInfo.UseShellExecute=$false
$nodeInfo.RedirectStandardInput=$true;$nodeInfo.RedirectStandardOutput=$true;$nodeInfo.RedirectStandardError=$true
$nodeProcess=[Diagnostics.Process]::Start($nodeInfo)
$nodeProcess.StandardInput.Write((ConvertTo-Json -InputObject @{runtime=$RuntimeJavaScript;health=$HealthJavaScript} -Compress))
$nodeProcess.StandardInput.Close()
$nodeOutputTask=$nodeProcess.StandardOutput.ReadToEndAsync();$nodeErrorTask=$nodeProcess.StandardError.ReadToEndAsync()
$nodeProcess.WaitForExit()
Check ($nodeProcess.ExitCode -eq 0) "Offline Node payload execution: $($nodeErrorTask.GetAwaiter().GetResult())"
Write-Host $nodeOutputTask.GetAwaiter().GetResult().Trim()
$nodeProcess.Dispose()
Check ((Parse-Json ("/ \ " + [Environment]::NewLine + '{"safe":true}')).safe) "Known spinner prefix"
Reject { Parse-Json '{"safe":true} unexpected' } "JSON suffix must not be discarded"
Reject { Parse-Json 'warning secret-before {"safe":true}' } "Arbitrary prefix must not be discarded"
Check ((Failure-Class "AuthorizationFailed DO_NOT_PRINT_SECRET") -notmatch "DO_NOT_PRINT_SECRET") "Secret-safe CLI classification"
Check ((Failure-Class "Handshake status 429 Too Many Requests") -match "RATE_LIMITED") "429 classification"
Check ((Fingerprint @{b=2;a=@(1,2)}) -ceq (Fingerprint @{a=@(1,2);b=2})) "Stable sorted fingerprints"
$subnet = "$ScopeRoot/providers/Microsoft.Network/virtualNetworks/atoms-staging-vnet/subnets/container-apps"
$peSubnet = "$ScopeRoot/providers/Microsoft.Network/virtualNetworks/atoms-staging-vnet/subnets/private-endpoints"
$redisId = "$ScopeRoot/providers/Microsoft.Cache/redisEnterprise/atoms-staging-redis"
$peId = "$ScopeRoot/providers/Microsoft.Network/privateEndpoints/atoms-staging-redis-pe"
$nicId = "$ScopeRoot/providers/Microsoft.Network/networkInterfaces/atoms-staging-redis-nic"
$zoneId = "$ScopeRoot/providers/Microsoft.Network/privateDnsZones/privatelink.redis.azure.net"
$ids = @{}; $ids[$GatewayPullIdentity.ToLowerInvariant()] = @{principalId="fixture-runtime"; clientId="fixture-client"}
$Baseline = @{
    id=$PreviewId;name=$PreviewName;location="canadacentral";tags=@{project="atoms";environment="staging"}
    identity=@{type="UserAssigned";userAssignedIdentities=$ids}
    properties=@{
        environmentId=$EnvironmentId;workloadProfileName="Consumption";provisioningState="Succeeded"
        latestRevisionName="$PreviewName--baseline";latestReadyRevisionName="$PreviewName--baseline"
        configuration=@{
            activeRevisionsMode="Single";ingress=@{external=$false;allowInsecure=$false;targetPort=3002;fqdn=$InternalFqdn;customDomains=@();traffic=@(@{latestRevision=$true;weight=100})}
            secrets=@(@{name="redis-url";keyVaultUrl="https://fixture.vault.azure.net/secrets/redis";identity=$GatewayPullIdentity},@{name="preview-signing-secret";keyVaultUrl="https://fixture.vault.azure.net/secrets/sign";identity=$GatewayPullIdentity})
            registries=@(@{server=$AcrServer;identity=$GatewayPullIdentity.Replace("/resourceGroups/","/resourcegroups/")})
        }
        template=@{
            revisionSuffix="baseline";scale=@{minReplicas=0;maxReplicas=1;rules=@(@{name="http";http=@{metadata=@{concurrentRequests="10"}}})}
            containers=@(@{
                name=$PreviewName;image=$OldImage;resources=@{cpu=0.25;memory="0.5Gi"}
                env=@(
                    @{name="REDIS_URL";secretRef="redis-url"},@{name="PREVIEW_SIGNING_SECRET";secretRef="preview-signing-secret"},
                    @{name="PREVIEW_BASE_DOMAIN";value="preview.invalid"},@{name="PREVIEW_UI_ORIGIN";value=$UiOrigin},
                    @{name="PREVIEW_PUBLIC_PROTOCOL";value="https"},@{name="PREVIEW_GATEWAY_HOST";value="0.0.0.0"},
                    @{name="PREVIEW_GATEWAY_PORT";value="3002"}
                )
                probes=@(@{type="Readiness";httpGet=@{path="/healthz";port=3002;scheme="HTTP"};initialDelaySeconds=3;periodSeconds=5})
            })
        }
    }
}
Verify-PrivateApp $Baseline
Check ($GatewayPullIdentity -ine $JobPullIdentity) "Gateway and Job pull identities are deliberately distinct"
$caseIdentity = Copy-Data $Baseline
$caseIdentity.properties.configuration.registries[0].identity = $GatewayPullIdentity.ToUpperInvariant()
Verify-PrivateApp $caseIdentity
Check $true "Confirmed Gateway ARM identity accepts resource-ID casing without changing it"
$baselineHash = App-Invariants $Baseline
Check ($baselineHash -is [string] -and $baselineHash -match "^[a-f0-9]{64}$") "Fingerprint does not leak Remove return values"
$display = Copy-Data $Baseline; $display.location = "Canada Central"
Verify-PrivateApp $display
Check ((App-Invariants $display) -ceq $baselineHash) "Official ARM display location is equivalent to canonical Canada Central"
Check (Is-CanadaCentral "CANADA CENTRAL") "Location comparison remains case-insensitive"
foreach ($wrongRegion in @("canadaeast","Canada East","eastus","Canada Central Europe"," Canada Central","CanadaCentral-other","")) {
    $wrong = Copy-Data $Baseline; $wrong.location = $wrongRegion
    Reject { Verify-PrivateApp $wrong } "No unrelated or fuzzy region accepted"
}
$wrong = Copy-Data $display; $wrong.id = "$ScopeRoot/providers/Microsoft.App/containerApps/other"
Reject { Verify-PrivateApp $wrong } "Display alias never bypasses exact resource ID"
$wrong = Copy-Data $display; $wrong.properties.environmentId = "$ScopeRoot/providers/Microsoft.App/managedEnvironments/other"
Reject { Verify-PrivateApp $wrong } "Display alias never bypasses exact environment"
$wrong = Copy-Data $display; $wrong.properties.configuration.ingress.external = $true
Reject { Verify-PrivateApp $wrong } "Display alias never bypasses internal ingress"
$changed = Copy-Data $Baseline
$changed.properties.template.revisionSuffix = "pvrt-fixture-a"
$changed.properties.template.scale.minReplicas = 1
$changed.properties.template.containers[0].image = "$AcrServer/preview-gateway@sha256:$('a'*64)"
$changed.properties.template.containers[0].env += @{name="PREVIEW_REDIS_MODE";value="oss-cluster"}
Check ((App-Invariants $changed) -ceq $baselineHash) "Only approved mutable fields excluded"
$changed.properties.template.containers[0].resources.memory = "1Gi"
Check ((App-Invariants $changed) -cne $baselineHash) "Resources drift fingerprinted"
$changed = Copy-Data $Baseline; $changed.properties.configuration.ingress.external = $true
Reject { Verify-PrivateApp $changed } "Public ingress rejected"
$changed = Copy-Data $Baseline; $changed.properties.template.containers[0].command = @("sh")
Reject { Verify-PrivateApp $changed } "Entry-point overrides not silently removed"
$changed = Copy-Data $Baseline; $changed.properties.template.containers[0].env += @{name="OPENAI_API_KEY";value="DO_NOT_COPY"}
Reject { Verify-PrivateApp $changed } "Extra provider credentials rejected"
$changed = Copy-Data $Baseline; $changed.properties.template.scale.maxReplicas = 2
Reject { Verify-PrivateApp $changed } "max=1 retained"
$changed = Copy-Data $Baseline; $changed.properties.configuration.ingress.traffic=@(@{weight=100;revisionName="old"})
Reject { Verify-PrivateApp $changed } "Pinned old traffic rejected"
$script:FixtureEnvironment = @{id=$EnvironmentId;name=$EnvironmentName;location="canadacentral";properties=@{defaultDomain=$DefaultDomain;vnetConfiguration=@{infrastructureSubnetId=$subnet}}}
$script:FixtureApi = @{id="$ScopeRoot/providers/Microsoft.App/containerApps/$ApiName";properties=@{environmentId=$EnvironmentId;template=@{containers=@(@{name=$ApiName;env=@(@{name="AUTH_REQUIRED";value="true"},@{name="RUN_EXECUTION_ENABLED";value="false"})})}}}
$script:FixtureRedis = @{id=$redisId;properties=@{hostName="fixture.canadacentral.redis.azure.net";provisioningState="Succeeded";resourceState="Running";publicNetworkAccess="Disabled"}}
$script:FixtureDb = @{value=@(@{id="$redisId/databases/default";properties=@{provisioningState="Succeeded";resourceState="Running";clientProtocol="Encrypted";accessKeysAuthentication="Enabled";clusteringPolicy="OSSCluster";port=10000}})}
$script:FixturePe = @{id=$peId;name="atoms-staging-redis-pe";provisioningState="Succeeded";subnet=@{id=$peSubnet};networkInterfaces=@(@{id=$nicId});privateLinkServiceConnections=@(@{privateLinkServiceId=$redisId;groupIds=@("redisEnterprise");privateLinkServiceConnectionState=@{status="Approved"}})}
$script:FixtureNic = @{id=$nicId;ipConfigurations=@(@{subnet=@{id=$peSubnet};privateIPAddress="10.41.0.4"})}
$script:FixtureGroup = @{id="$peId/privateDnsZoneGroups/default";name="default";provisioningState="Succeeded";privateDnsZoneConfigs=@(@{privateDnsZoneId=$zoneId})}
$script:CaseRoot = Join-Path ([IO.Path]::GetTempPath()) ("atoms-v13-offline-" + [Guid]::NewGuid().ToString("N"))
[void][IO.Directory]::CreateDirectory($script:CaseRoot)
function Get-Arg([string[]]$Arguments,[string]$Name) {
    $index = [Array]::IndexOf($Arguments,$Name); if ($index -lt 0) { return "" };return $Arguments[$index+1]
}
function Json-Response($Value) { @{ExitCode=0;Stderr="";Stdout=ConvertTo-Json -InputObject $Value -Depth 100 -Compress} }
function Merge-Patch($Target,$Patch) {
    foreach ($key in $Patch.Keys) {
        if ($null -eq $Patch[$key]) { [void]$Target.Remove($key) }
        elseif ($Patch[$key] -is [Collections.IDictionary]) {
            if ($Target[$key] -isnot [Collections.IDictionary]) { $Target[$key]=@{} }
            Merge-Patch $Target[$key] $Patch[$key]
        } else { $Target[$key]=Copy-Data $Patch[$key] }
    }
}
function Initialize-Audit {
    $script:RunRoot=Join-Path $script:CaseRoot $script:CaseName;[void][IO.Directory]::CreateDirectory($script:RunRoot)
    $script:CheckpointPath="";$script:TranscriptStarted=$false
}
$script:ActualSafe = (Get-Command Safe-Error).ScriptBlock
function Safe-Error($Record) { $script:LastFailure=[string]$Record.Exception.Message; & $script:ActualSafe $Record }
function Start-Sleep { param([int]$Seconds,[int]$Milliseconds) }
function Http-Safety([string]$Uri,[int]$Expected) { Check ($Uri -match "^https://atoms-staging-control-api[.]") "Only fixed public safety URL" }
function Public-GitHub([string]$Path) {
    if ($Path.StartsWith("git/commits/")) { return @{sha=$SourceSha;tree=@{sha=$SourceTree}} }
    if ($Path.Contains("/jobs?")) { return @{jobs=@("changes","verify","migration-matrix","attachment-storage-integration","preview-runtime-integration")|ForEach-Object{@{name=$_;status="completed";conclusion="success"}}} }
    return @{head_sha=$SourceSha;status="completed";conclusion="success";event="push";head_branch="main"}
}
function Invoke-AzProcess([string[]]$Arguments,[int]$TimeoutSeconds=120) {
    [void]$script:Calls.Add(@($Arguments))
    if ($Arguments -contains "--help") { return @{ExitCode=0;Stderr="";Stdout="--no-wait --no-logs --timeout --yaml --replica"} }
    Check ((Get-Arg $Arguments "--subscription") -ceq $SubscriptionId) "Every Azure operation scoped to staging"
    $prefix = @($Arguments[0..([Math]::Min(2,$Arguments.Count-1))]) -join " "
    switch -Wildcard ($prefix) {
        "account set*" { return @{ExitCode=0;Stderr="";Stdout=""} }
        "account show*" { return Json-Response @{id=$SubscriptionId;name="Atoms-Staging";state="Enabled"} }
        "acr show*" { return Json-Response @{id="$ScopeRoot/providers/Microsoft.ContainerRegistry/registries/$AcrName";loginServer=$AcrServer} }
        "acr repository show-tags" { return Json-Response @("private-skeleton-0482b37eab42") }
        "acr repository show" {
            $digest = if ((Get-Arg $Arguments "--image") -ceq $OldTag) {$OldDigest}
                elseif ($script:CaseName -ceq "repository-digest-mismatch") {"sha256:"+("b"*64)}
                else {$script:BuiltDigest}
            return @{ExitCode=0;Stderr="";Stdout=$digest}
        }
        "acr build*" { $script:BuildCalls++;throw "Resume script must never invoke az acr build" }
        "acr task show-run" {
            if ($script:CaseName -ceq "permission-denied") { return @{ExitCode=1;Stdout="";Stderr="AuthorizationFailed DO_NOT_PRINT_SECRET"} }
            $runId = if ($script:CaseName -ceq "run-id-mismatch") {"other"} else {$ResumeBuildRunId}
            $status = if ($script:CaseName -ceq "run-status-failed") {"Failed"} else {"Succeeded"}
            $architecture = if ($script:CaseName -ceq "run-platform-mismatch") {"arm64"} else {"amd64"}
            $tag = if ($script:CaseName -ceq "run-tag-mismatch") {"other-tag"} else {$ResumeBuildTag}
            $digest = if ($script:CaseName -ceq "run-output-mismatch") {"sha256:"+("c"*64)} else {$ResumeBuildDigest}
            $output = @{repository="preview-gateway";tag=$tag;digest=$digest}
            if ($script:CaseName -ceq "reported-registry-success") {$output.registry=$AcrServer}
            if ($script:CaseName -ceq "run-registry-mismatch") {$output.registry="other.azurecr.io"}
            return Json-Response @{runId=$runId;status=$status;platform=@{os="linux";architecture=$architecture};outputImages=@($output)}
        }
        "resource list*" {
            if ((Get-Arg $Arguments "--resource-type") -ceq "Microsoft.Cache/redisEnterprise") { return Json-Response @(@{id=$redisId}) }
            return Json-Response @()
        }
        "network private-endpoint list" { return Json-Response @($script:FixturePe) }
        "network private-endpoint dns-zone-group" { return Json-Response @($script:FixtureGroup) }
        "network nic show" { return Json-Response $script:FixtureNic }
        "containerapp env show" { return Json-Response $script:FixtureEnvironment }
        "containerapp env certificate" { return Json-Response @() }
        "containerapp revision list" {
            return Json-Response @(@{name=$script:StateApp.properties.latestRevisionName;properties=@{active=$true;healthState="Healthy";provisioningState="Provisioned";template=Copy-Data $script:StateApp.properties.template}})
        }
        "containerapp replica list" {
            $revision=Get-Arg $Arguments "--revision"
            return Json-Response @(@{name="$revision-replica1";properties=@{containers=@(@{name=$PreviewName;runningState="running"})}})
        }
        "containerapp exec*" {
            $script:ExecCalls++
            Check ((Get-Arg $Arguments "--revision") -ceq "$PreviewName--$($script:RevisionPrefix)-a") "No old revision fallback"
            if ($script:CaseName -ceq "exec-429") { return @{ExitCode=1;Stdout="";Stderr="Handshake status 429 Too Many Requests retry-after': '600' DO_NOT_PRINT_SECRET"} }
            $handshakeFailures = if ($script:CaseName -ceq "exec-404-once") { 1 } elseif ($script:CaseName -ceq "exec-404-twice") { 2 } elseif ($script:CaseName -ceq "exec-404-all") { 3 } else { 0 }
            if ($script:ExecCalls -le $handshakeFailures) { return @{ExitCode=1;Stdout="";Stderr="Handshake status 404 Not Found DO_NOT_PRINT_SECRET"} }
            if ($script:CaseName -ceq "exec-false-zero") { return @{ExitCode=0;Stdout="";Stderr=""} }
            if ($script:CaseName -ceq "runtime-failed") { return @{ExitCode=0;Stdout="ATOMS_PVRT_FAILED_PRIVATE_DNS:$($script:RunId)";Stderr=""} }
            if ($script:CaseName -ceq "runtime-failed-stderr") { return @{ExitCode=0;Stdout="";Stderr="remote frame ATOMS_PVRT_FAILED_PRIVATE_DNS:$($script:RunId) complete"} }
            if ($script:CaseName -ceq "runtime-failed-nonzero") { return @{ExitCode=1;Stdout="ATOMS_PVRT_PACKAGE_OK:$($script:RunId)`nATOMS_PVRT_FAILED_PRIVATE_DNS:$($script:RunId)";Stderr="remote exit DO_NOT_PRINT_SECRET"} }
            if ($script:CaseName -ceq "exec-incomplete-nonzero") { return @{ExitCode=1;Stdout="ATOMS_PVRT_PACKAGE_OK:$($script:RunId)";Stderr="transport DO_NOT_PRINT_SECRET"} }
            if ($script:CaseName -ceq "unrelated-drift") {
                $script:StateApp.properties.template.containers[0].resources.memory="1Gi"
                return @{ExitCode=0;Stdout="ATOMS_PVRT_FAILED_PRIVATE_DNS:$($script:RunId)";Stderr=""}
            }
            if ($script:CaseName -ceq "identity-drift") {
                $script:StateApp.identity.userAssignedIdentities["$ScopeRoot/providers/Microsoft.ManagedIdentity/userAssignedIdentities/concurrent-user-mi"]=@{principalId="concurrent-user"}
                return @{ExitCode=0;Stdout="ATOMS_PVRT_FAILED_PRIVATE_DNS:$($script:RunId)";Stderr=""}
            }
            $names=@("PACKAGE_OK","PRIVATE_DNS_OK","REDIS_CLUSTER_OK","STORE_READ_OK","LOCAL_HEALTH_OK","CLIENT_CLOSED_OK","RUNTIME_OK")
            $successLines = @($names|ForEach-Object{"ATOMS_PVRT_$($_):$($script:RunId)"})
            $successOutput = $successLines -join [Environment]::NewLine
            if ($script:CaseName -ceq "exec-success-stderr") { return @{ExitCode=0;Stdout="";Stderr=("connected"+[Environment]::NewLine+$successOutput)} }
            if ($script:CaseName -ceq "exec-success-split") {
                return @{ExitCode=0;Stdout=($successLines[0..2]-join [Environment]::NewLine);Stderr=($successLines[3..6]-join [Environment]::NewLine)}
            }
            if ($script:CaseName -ceq "exec-success-framed") {
                return @{ExitCode=0;Stdout=(@($successLines|ForEach-Object{"remote frame> $_ complete"})-join [Environment]::NewLine);Stderr=""}
            }
            if ($script:CaseName -ceq "exec-duplicate-across-streams") { return @{ExitCode=0;Stdout=$successOutput;Stderr=$successOutput} }
            if ($script:CaseName -ceq "exec-complete-nonzero") { return @{ExitCode=1;Stderr="transport close DO_NOT_PRINT_SECRET";Stdout=$successOutput} }
            return @{ExitCode=0;Stderr="";Stdout=$successOutput}
        }
        "containerapp job list" { return Json-Response @($script:Jobs) }
        "containerapp job create" {
            Check ($Arguments -contains "--yaml" -and $Arguments -notcontains "--args") "File-only Job payload"
            $job=Parse-Json ([IO.File]::ReadAllText((Get-Arg $Arguments "--yaml")))
            Check (@($job.identity.userAssignedIdentities.Keys).Count -eq 1 -and @($job.identity.userAssignedIdentities.Keys)[0] -ieq $JobPullIdentity) "Job retains its own existing acr-pull identity, not Gateway runtime-mi"
            Check ($job.properties.configuration.registries[0].identity -ieq $JobPullIdentity) "Job registry uses only its separate pull identity"
            Check (@(Items (P $job.properties.configuration "secrets")).Count -eq 0 -and @($job.properties.template.containers[0].env).Count -eq 1) "Gateway secret definitions and credential environment are never copied into Job"
            $job.id="$ScopeRoot/providers/Microsoft.App/jobs/$($script:JobName)"
            $job.properties.template.containers[0].env[0].secretRef=$null
            if ($script:CaseName -ceq "display-success") { $job.location = "Canada Central" }
            $script:Jobs=@($job)
            if ($script:CaseName -ceq "job-payload-changed") { $job.properties.template.containers[0].args=@("--eval","process.exit(0)") }
            if ($script:CaseName -ceq "job-identity-changed") {
                $job.identity.userAssignedIdentities=@{};$job.identity.userAssignedIdentities[$GatewayPullIdentity]=@{}
                $job.properties.configuration.registries[0].identity=$GatewayPullIdentity
            }
            return @{ExitCode=0;Stdout="";Stderr=""}
        }
        "containerapp job show" { return Json-Response $script:Jobs[0] }
        "containerapp job start" { $script:JobStartCalls++;return @{ExitCode=0;Stderr="";Stdout="$($script:JobName)-exec1"} }
        "containerapp job execution" {
            $status=if($script:CaseName -ceq "job-health-failed"){"Failed"}else{"Succeeded"}
            return Json-Response @{name="$($script:JobName)-exec1";properties=@{status=$status}}
        }
        "containerapp job delete" {
            $script:JobDeleteCalls++
            if ($script:CaseName -ceq "job-delete-denied") { return @{ExitCode=1;Stdout="";Stderr="AuthorizationFailed"} }
            $script:Jobs=@();return @{ExitCode=0;Stdout="";Stderr=""}
        }
        "rest --method get" {
            $url=Get-Arg $Arguments "--url"
            if ($url.StartsWith("https://management.azure.com" + $PreviewId + "?")) {
                if ($script:CaseName -like "display-*") { $script:StateApp.location = "Canada Central" }
                return Json-Response $script:StateApp
            }
            if ($url.StartsWith("https://management.azure.com" + $script:FixtureApi.id + "?")) { return Json-Response $script:FixtureApi }
            if ($url.StartsWith("https://management.azure.com" + $redisId + "/databases?")) { return Json-Response $script:FixtureDb }
            if ($url.StartsWith("https://management.azure.com" + $redisId + "?")) { return Json-Response $script:FixtureRedis }
            throw "Unexpected ARM read in offline test"
        }
        "rest --method patch" {
            $script:PatchCalls++
            Check ((Get-Arg $Arguments "--url") -ceq $PreviewUrl) "Exact Gateway only PATCH"
            $body=Parse-Json ([IO.File]::ReadAllText((Get-Arg $Arguments "--body").Substring(1)))
            Check ((@($body.Keys|Sort-Object)-join "|") -ceq "location|properties") "Patch only reviewed root fields"
            Check ($body.location -ceq "canadacentral") "Patch uses the same canonical Canada Central region only"
            Check ((@($body.properties.Keys)-join "|") -ceq "template") "No configuration/secret/network patch"
            Check ((@($body.properties.template.Keys|Sort-Object)-join "|") -ceq "containers|revisionSuffix|scale") "Only container/minimum/suffix"
            Check ((@($body.properties.template.scale.Keys)-join "|") -ceq "minReplicas") "Max/rules never overwritten"
            Check ($body.properties.template.containers[0].env[0].secretRef -ceq "redis-url") "Existing secret references retained"
            Merge-Patch $script:StateApp $body
            foreach($entry in $script:StateApp.properties.template.containers[0].env){
                if($entry.name -ceq "PREVIEW_REDIS_MODE"){$entry.secretRef=$null}
            }
            $script:StateApp.properties.latestRevisionName="$PreviewName--$($script:StateApp.properties.template.revisionSuffix)"
            $script:StateApp.properties.latestReadyRevisionName=$script:StateApp.properties.latestRevisionName
            if ($script:CaseName -ceq "patch-response-failed" -and $script:PatchCalls -eq 1) { return @{ExitCode=1;Stdout="";Stderr="Unexpected response after mutation"} }
            return @{ExitCode=0;Stdout="";Stderr=""}
        }
    }
    throw "Unexpected Azure command in offline test: $prefix"
}
function Reset-Case([string]$Name) {
    $script:CaseName=$Name;$script:StateApp=Copy-Data $Baseline;$script:Calls=[Collections.Generic.List[object]]::new()
    $script:Jobs=@();$script:ExitStatus=0;$script:CommitSucceeded=$false;$script:AppMutationMayHaveApplied=$false;$script:LastFailure=""
    $script:JobMayExist=$false;$script:Original=$null;$script:NewImage="";$script:CheckpointPath=""
    $script:RunId=[Guid]::NewGuid().ToString("N");$script:RevisionPrefix="pvrt-"+$script:RunId.Substring(0,12)
    $script:ResumeSourceRunId="";$script:JobName="atoms-stg-pvrt-"+$script:RunId.Substring(0,12);$script:BuildTag=""
    $script:BuildCalls=0;$script:PatchCalls=0;$script:ExecCalls=0;$script:JobStartCalls=0;$script:JobDeleteCalls=0
    $script:BuiltDigest=$ResumeBuildDigest;$script:Apply=$true;$script:RollbackCheckpoint=""
    $resumeRunId="e95400a79f02"+("0"*20)
    $resumeData=@{
        format="ATOMS_PREVIEW_PRIVATE_ROLLOUT_V13";sourceSha=$SourceSha;runId=$resumeRunId;previewId=$PreviewId
        revisionPrefix="pvrt-e95400a79f02";original=@{invariants=$baselineHash;mode=$null;image=$OldImage;suffix="baseline"}
        newImage="";buildTag=$ResumeBuildTag;phase="preflight";createdAtUtc="2026-09-12T20:49:59.0000000Z"
    }
    $inputPath=Join-Path $script:CaseRoot ("resume-input-"+$Name+".json")
    [IO.File]::WriteAllText($inputPath,(ConvertTo-Json -InputObject $resumeData -Depth 100),[Text.UTF8Encoding]::new($false))
    $script:ResumeCheckpoint=$inputPath
}
$guardCaseCodes = @{
    "wrong-region"="ATOMS_GATEWAY_LOCATION_MISMATCH";"wrong-resource-id"="ATOMS_GATEWAY_RESOURCE_ID_MISMATCH"
    "wrong-pull-identity"="ATOMS_GATEWAY_PULL_IDENTITY_MISMATCH";"system-pull-identity"="ATOMS_GATEWAY_PULL_IDENTITY_MISMATCH"
    "missing-pull-identity"="ATOMS_GATEWAY_PULL_IDENTITY_MISMATCH";"unassigned-pull-identity"="ATOMS_GATEWAY_PULL_IDENTITY_NOT_ASSIGNED"
    "wrong-registry-server"="ATOMS_GATEWAY_REGISTRY_SERVER_MISMATCH"
    "multiple-registries"="ATOMS_GATEWAY_REGISTRY_COUNT_MISMATCH";"missing-registry"="ATOMS_GATEWAY_REGISTRY_COUNT_MISMATCH"
    "registry-username"="ATOMS_GATEWAY_REGISTRY_CREDENTIALS_UNEXPECTED";"registry-password"="ATOMS_GATEWAY_REGISTRY_CREDENTIALS_UNEXPECTED"
}
$resumeGuardCases = @("checkpoint-tampered-tag","checkpoint-has-image","checkpoint-original-mismatch","original-state-drift","run-id-mismatch","run-status-failed","run-platform-mismatch","run-tag-mismatch","run-output-mismatch","run-registry-mismatch","repository-digest-mismatch","permission-denied")
$caseNames = @("success","prior-rollback-success","display-success","reported-registry-success","preflight","display-preflight","wrong-region","wrong-resource-id","wrong-pull-identity","system-pull-identity","missing-pull-identity","unassigned-pull-identity","wrong-registry-server","multiple-registries","missing-registry","registry-username","registry-password") + $resumeGuardCases + @("runtime-failed","runtime-failed-stderr","runtime-failed-nonzero","exec-false-zero","exec-incomplete-nonzero","exec-complete-nonzero","exec-success-stderr","exec-success-split","exec-success-framed","exec-duplicate-across-streams","exec-429","exec-404-once","exec-404-twice","exec-404-all","patch-response-failed","job-payload-changed","job-identity-changed","job-health-failed","job-delete-denied","unrelated-drift","identity-drift")
foreach($name in $caseNames){
    Reset-Case $name
    if($name -in @("preflight","display-preflight")){$script:Apply=$false}
    if($name -ceq "wrong-region"){$script:StateApp.location="Canada East"}
    if($name -ceq "wrong-resource-id"){$script:StateApp.id="$ScopeRoot/providers/Microsoft.App/containerApps/other"}
    if($name -ceq "prior-rollback-success"){
        $script:StateApp.properties.template.containers[0].image=$OldPinnedImage
        $script:StateApp.properties.template.revisionSuffix="pvrt-e95400a79f02-r"
        $script:StateApp.properties.latestRevisionName="$PreviewName--pvrt-e95400a79f02-r"
        $script:StateApp.properties.latestReadyRevisionName=$script:StateApp.properties.latestRevisionName
    }
    switch ($name) {
        "wrong-pull-identity" {$script:StateApp.properties.configuration.registries[0].identity=$JobPullIdentity}
        "system-pull-identity" {$script:StateApp.properties.configuration.registries[0].identity="system"}
        "missing-pull-identity" {[void]$script:StateApp.properties.configuration.registries[0].Remove("identity")}
        "unassigned-pull-identity" {$script:StateApp.identity.userAssignedIdentities=@{}}
        "wrong-registry-server" {$script:StateApp.properties.configuration.registries[0].server="other.azurecr.io"}
        "multiple-registries" {$script:StateApp.properties.configuration.registries+=@{server="other.azurecr.io";identity=$GatewayPullIdentity}}
        "missing-registry" {$script:StateApp.properties.configuration.registries=@()}
        "registry-username" {$script:StateApp.properties.configuration.registries[0].username="DO_NOT_PRINT_SECRET"}
        "registry-password" {$script:StateApp.properties.configuration.registries[0].passwordSecretRef="DO_NOT_PRINT_SECRET"}
        "original-state-drift" {$script:StateApp.properties.template.containers[0].resources.memory="0.75Gi"}
        "checkpoint-tampered-tag" {$data=Parse-Json ([IO.File]::ReadAllText($script:ResumeCheckpoint));$data.buildTag="other";[IO.File]::WriteAllText($script:ResumeCheckpoint,(ConvertTo-Json -InputObject $data -Depth 100))}
        "checkpoint-has-image" {$data=Parse-Json ([IO.File]::ReadAllText($script:ResumeCheckpoint));$data.newImage="$AcrServer/preview-gateway@$ResumeBuildDigest";[IO.File]::WriteAllText($script:ResumeCheckpoint,(ConvertTo-Json -InputObject $data -Depth 100))}
        "checkpoint-original-mismatch" {$data=Parse-Json ([IO.File]::ReadAllText($script:ResumeCheckpoint));$data.original.invariants="f"*64;[IO.File]::WriteAllText($script:ResumeCheckpoint,(ConvertTo-Json -InputObject $data -Depth 100))}
    }
    $expectedIdentityHash = Fingerprint $script:StateApp.identity
    $expectedRegistryHash = Fingerprint $script:StateApp.properties.configuration.registries
    $output = @(Invoke-Rollout *>&1)
    if($name -in @("success","prior-rollback-success","display-success","reported-registry-success","exec-complete-nonzero","exec-success-stderr","exec-success-split","exec-success-framed","exec-404-once","exec-404-twice")){
        Check ($script:ExitStatus -eq 0 -and $script:CommitSucceeded) "$name reports success ($($output -join ' ')) diagnostic=$($script:LastFailure)"
        Check ((P (Container $script:StateApp) "image") -ceq "$AcrServer/preview-gateway@$ResumeBuildDigest") "Final exact reused build digest"
        Check ((Env-Value $script:StateApp "PREVIEW_REDIS_MODE") -ceq "oss-cluster") "Final explicit OSSCluster"
        Check ($script:StateApp.properties.template.scale.minReplicas -eq 0) "Final scale-zero configuration"
        Check ($script:JobStartCalls -eq 1 -and $script:JobDeleteCalls -eq 1 -and @($script:Jobs).Count -eq 0) "Job success and cleanup"
        Check ($script:RevisionPrefix -cne "pvrt-e95400a79f02") "Deployment attempt never reuses the v13/v14 revision prefix"
        if($name -ceq "prior-rollback-success"){Check (($output -join " ") -match "rollback baseline") "Exact prior rollback baseline is explicitly reconciled"}
    }elseif($name -in @("preflight","display-preflight")){
        Check ($script:ExitStatus -eq 0 -and $script:BuildCalls -eq 0 -and $script:PatchCalls -eq 0 -and $script:ExecCalls -eq 0) "Default preflight non-mutating"
        if($name -ceq "display-preflight"){Check (($output -join " ") -match "DISPLAY_CANADA_CENTRAL") "Actual returned region representation is safely classified"}
    }elseif($guardCaseCodes.ContainsKey($name)){
        Check ($script:ExitStatus -eq 1 -and -not $script:CommitSucceeded) "$name cannot pass a genuine guard failure"
        Check ($script:BuildCalls -eq 0 -and $script:PatchCalls -eq 0 -and $script:ExecCalls -eq 0 -and $script:JobStartCalls -eq 0) "$name never starts billable build, app mutation, exec or Job"
        Check (($output -join " ") -match $guardCaseCodes[$name]) "$name separately reports the exact secret-safe guard code"
    }elseif($name -in $resumeGuardCases){
        Check ($script:ExitStatus -eq 1 -and -not $script:CommitSucceeded) "$name cannot pass resume reconciliation"
        Check ($script:PatchCalls -eq 0 -and $script:ExecCalls -eq 0 -and $script:JobStartCalls -eq 0) "$name stops before app/runtime/Job mutation"
    }else{
        Check ($script:ExitStatus -eq 1 -and -not $script:CommitSucceeded) "$name cannot pass"
        if($name -in @("unrelated-drift","identity-drift")){
            Check ($script:PatchCalls -eq 1 -and $script:AppMutationMayHaveApplied) "Drift refuses rollback overwrite"
            if($name -ceq "unrelated-drift"){
                Check ($script:StateApp.properties.template.containers[0].resources.memory -ceq "1Gi") "Concurrent resource change preserved"
            }else{
                Check ($script:StateApp.identity.userAssignedIdentities.ContainsKey("$ScopeRoot/providers/Microsoft.ManagedIdentity/userAssignedIdentities/concurrent-user-mi")) "Concurrent identity change preserved instead of overwritten on rollback"
            }
            Check (($output -join " ") -match "NOT CONFIRMED") "Unconfirmed rollback explicit"
        }else{
            Check ((P (Container $script:StateApp) "image") -in @($OldImage,$OldPinnedImage)) "$name original image restored or untouched"
            Check ($script:StateApp.properties.template.scale.minReplicas -eq 0 -and $null -eq (Env-Record $script:StateApp "PREVIEW_REDIS_MODE")) "$name original mode and min=0"
        }
        if($name -ceq "exec-429"){Check ($script:ExecCalls -eq 1) "429 never immediately retry"}
        if($name -ceq "exec-404-all"){
            Check ($script:ExecCalls -eq 3) "404 retries remain bounded to three attempts"
            Check (($output -join " ") -match "ATOMS_AZURE_EXEC_HANDSHAKE_NOT_READY") "Repeated 404 gets an exact secret-safe classification"
        }
        if($name -ceq "runtime-failed-nonzero"){Check (($output -join " ") -match "ATOMS_RUNTIME_PROBE_FAILED_PRIVATE_DNS") "Nonce-bound runtime failure survives nonzero CLI exit"}
        if($name -ceq "runtime-failed-stderr"){Check (($output -join " ") -match "ATOMS_RUNTIME_PROBE_FAILED_PRIVATE_DNS") "Nonce-bound runtime failure is classified from stderr"}
        if($name -ceq "exec-incomplete-nonzero"){Check (($output -join " ") -match "ATOMS_RUNTIME_OUTPUT_INCOMPLETE") "Incomplete nonce-bound output is classified without raw output"}
        if($name -ceq "exec-false-zero"){Check (($output -join " ") -match "ATOMS_RUNTIME_SIGNAL_ABSENT") "Zero-exit token absence has an exact bounded code"}
        if($name -ceq "exec-duplicate-across-streams"){Check (($output -join " ") -match "ATOMS_RUNTIME_SIGNAL_AMBIGUOUS") "Duplicated cross-stream proof cannot pass"}
        if($name -in @("job-payload-changed","job-identity-changed")){Check ($script:JobStartCalls -eq 0 -and $script:JobDeleteCalls -eq 1) "Mutated Job payload/identity not executed but owned Job cleaned"}
        if($name -ceq "job-delete-denied"){Check ($script:JobMayExist -and -not $script:AppMutationMayHaveApplied) "Unconfirmed cleanup fails deployment with rollback"}
    }
    Check ($script:BuildCalls -eq 0 -and -not @($script:Calls|Where-Object{@($_)[0] -ceq "acr" -and @($_)[1] -ceq "build"}).Count) "$name never queues another ACR build"
    if($name -cne "identity-drift"){Check ((Fingerprint $script:StateApp.identity) -ceq $expectedIdentityHash) "$name preserves the full existing Gateway identity exactly"}
    Check ((Fingerprint $script:StateApp.properties.configuration.registries) -ceq $expectedRegistryHash) "$name preserves the full existing Gateway registry exactly"
    Check (($output -join " ") -notmatch "DO_NOT_PRINT_SECRET") "$name raw errors never printed"
    if($name -ceq "exec-404-once"){Check ($script:ExecCalls -eq 2) "One 404 uses exactly one retry"}
    if($name -ceq "exec-404-twice"){Check ($script:ExecCalls -eq 3) "Two 404s use the final bounded attempt"}
    Check ((App-Invariants $Baseline) -ceq $baselineHash) "Reviewed fixture never mutated"
}
Reset-Case "checkpoint"
$script:Original=Capture-Original $script:StateApp;$script:NewImage="$AcrServer/preview-gateway@$($script:BuiltDigest)"
$script:ResumeSourceRunId="e95400a79f02"+("0"*20);$script:BuildTag=$ResumeBuildTag
Initialize-Audit;Save-Checkpoint "published-reconciled"
$savedPath=$script:CheckpointPath
Import-Checkpoint $savedPath
Check ($script:Original.invariants -ceq $baselineHash) "Own checkpoint round trip"
$bad=Parse-Json ([IO.File]::ReadAllText($savedPath));$bad.previewId="/subscriptions/forbidden/resourceGroups/elsewhere/providers/Microsoft.App/containerApps/other"
$badPath=Own-File "bad-checkpoint.json" $bad
Reject { Import-Checkpoint $badPath } "Tampered checkpoint cannot select another resource"
$bad=Parse-Json ([IO.File]::ReadAllText($savedPath));$bad.original.mode=@{name="OPENAI_API_KEY";value="DO_NOT_COPY"}
$badPath=Own-File "bad-mode-checkpoint.json" $bad
Reject { Import-Checkpoint $badPath } "Recovery mode cannot insert credentials"
Import-Checkpoint $savedPath
$mode=@{name="PREVIEW_REDIS_MODE";value="oss-cluster"}
[void](Patch-Preview $script:NewImage 1 $mode "$($script:RevisionPrefix)-a")
$script:CaseName="manual-recovery";$script:RollbackCheckpoint=$savedPath;$script:Apply=$false
$script:ResumeCheckpoint=""
$script:ExitStatus=0;$script:CommitSucceeded=$false
$output=@(Invoke-Rollout *>&1)
Check ($script:ExitStatus -eq 0 -and $script:CommitSucceeded -and -not $script:AppMutationMayHaveApplied) "Manual exact-checkpoint recovery"
Check ((P (Container $script:StateApp) "image") -ceq $OldPinnedImage -and $null -eq (Env-Record $script:StateApp "PREVIEW_REDIS_MODE")) "Manual recovery old image/mode"
Check ((Fingerprint $script:StateApp.identity) -ceq (Fingerprint $Baseline.identity)) "Manual recovery never writes or changes Gateway identity"
Check ((Fingerprint $script:StateApp.properties.configuration.registries) -ceq (Fingerprint $Baseline.properties.configuration.registries)) "Manual recovery never writes or changes Gateway registry"
Reset-Case "legacy-v14-recovery"
$legacyRun="e95400a79f02"+("0"*20);$script:RunId=$legacyRun;$script:ResumeSourceRunId=$legacyRun
$script:RevisionPrefix="pvrt-e95400a79f02";$script:JobName="atoms-stg-pvrt-e95400a79f02";$script:BuildTag=$ResumeBuildTag
$script:Original=Capture-Original $script:StateApp;$script:NewImage="$AcrServer/preview-gateway@$ResumeBuildDigest"
Initialize-Audit
$legacyData=@{
    format="ATOMS_PREVIEW_PRIVATE_ROLLOUT_V13";sourceSha=$SourceSha;runId=$legacyRun;previewId=$PreviewId
    revisionPrefix=$script:RevisionPrefix;original=$script:Original;newImage=$script:NewImage;buildTag=$ResumeBuildTag
    phase="patch-confirmed";createdAtUtc="2026-09-12T20:10:00.0000000Z"
}
$legacyPath=Own-File "legacy-v14-checkpoint.json" $legacyData
[void](Patch-Preview $script:NewImage 1 @{name="PREVIEW_REDIS_MODE";value="oss-cluster"} "$($script:RevisionPrefix)-a")
$script:RollbackCheckpoint=$legacyPath;$script:ResumeCheckpoint="";$script:Apply=$false
$script:ExitStatus=0;$script:CommitSucceeded=$false
$output=@(Invoke-Rollout *>&1)
Check ($script:ExitStatus -eq 0 -and $script:CommitSucceeded -and -not $script:AppMutationMayHaveApplied) "Legacy v14 checkpoint remains recoverable"
Check ((P (Container $script:StateApp) "image") -ceq $OldPinnedImage -and $null -eq (Env-Record $script:StateApp "PREVIEW_REDIS_MODE")) "Legacy recovery restores only old image/mode/min"
Check ($script:BuildCalls -eq 0) "Legacy recovery never queues a build"
$names=@("PACKAGE_OK","PRIVATE_DNS_OK","REDIS_CLUSTER_OK","STORE_READ_OK","LOCAL_HEALTH_OK","CLIENT_CLOSED_OK","RUNTIME_OK")
$valid=(@($names|ForEach-Object{"ATOMS_PVRT_$($_):$($script:RunId)"})-join [Environment]::NewLine)
Require-RuntimeTokens $valid;Check $true "Complete nonce tokens accepted"
Reject { Require-RuntimeTokens ($valid+[Environment]::NewLine+$valid) } "Duplicated tokens cannot pass"
Require-RuntimeTokens ("remote frame> " + $valid.Replace([Environment]::NewLine,[Environment]::NewLine+"remote frame> "));Check $true "Transport-framed nonce tokens accepted"
Reject { Require-RuntimeTokens $valid.Replace($script:RunId,"othernonce") } "Wrong-run tokens cannot pass"
$carrier=Runtime-Command @{HostName="check.canadacentral.redis.azure.net";PrivateIps=@("10.0.0.4")}
Check (-not $carrier.Contains("ATOMS_PVRT_") -and -not $carrier.Contains($script:RunId)) "Compressed carrier cannot echo literal proof markers or nonce"
Write-Host "OFFLINE TESTS PASSED: $($script:Checks) assertions; parser + both Node payloads; $($caseNames.Count) rollout cases + v17/v15/legacy recovery. No Azure requests made."
