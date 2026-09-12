param([Parameter(Mandatory)][string]$SourcePath)
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($SourcePath, [ref]$tokens, [ref]$errors)
if ($errors.Count -ne 0) { throw "Health smoke parser errors: $($errors -join '; ')" }
$entry = @($ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.TryStatementAst] })
if ($entry.Count -ne 1) { throw "Expected exactly one live entry point." }
# Load only definitions/constants. NEVER execute the live try/finally entry.
$definitions = [IO.File]::ReadAllText($SourcePath).Substring(0, $entry[0].Extent.StartOffset)
Invoke-Expression ($definitions -replace '^Clear-Host\r?\n', '')
$cases = [Collections.Generic.List[string]]::new()
function Check($Condition, $Message) { if (-not $Condition) { throw $Message } }
function Throws([scriptblock]$Action, [string]$Pattern) {
    $caught = $false
    try { & $Action } catch {
        $caught = $true
        if ($_.Exception.Message -notmatch $Pattern) { throw "Unexpected error: $($_.Exception.Message)" }
    }
    if (-not $caught) { throw "Expected failure: $Pattern" }
}
function Case([string]$Name, [scriptblock]$Action) {
    & $Action
    $cases.Add($Name)
}

# Exercise the real native wrapper with this same PowerShell binary as a fake
# CLI. It only prints fixture JSON/stderr; no Azure executable or login is used.
$script:AzExecutable = (Get-Process -Id $PID).Path
Case "native stderr cannot corrupt JSON stdout" {
    $fixture = '[Console]::Error.WriteLine("non-secret-warning");[Console]::Out.WriteLine(''{"value":7}'');exit 0'
    $result = J @("-NoProfile", "-Command", $fixture)
    Check ($result.value -eq 7) "JSON stdout was corrupted"
}
Case "native failure never becomes passing JSON" {
    Throws { J @("-NoProfile", "-Command", '[Console]::Error.WriteLine("fixture-native-failure");exit 9') } "exit 9"
}

$script:FixtureEnvironment = [pscustomobject]@{ id = $EnvironmentId; location = "canadacentral"; properties = [pscustomobject]@{ defaultDomain = $DefaultDomain } }
$script:FixtureApi = [pscustomobject]@{ properties = [pscustomobject]@{ template = [pscustomobject]@{ containers = @([pscustomobject]@{
    image = "$AcrServer/control-api:local-fixture"
    env = @([pscustomobject]@{ name = "DO_NOT_COPY"; value = "local-fixture-not-for-job" })
}) } } }
function Reset-Case {
    if ($null -ne $script:JobConfigPath -and [IO.File]::Exists($script:JobConfigPath)) { Remove-Item -LiteralPath $script:JobConfigPath -Force }
    $script:JobConfigPath = $null
    $script:JobMayExist = $false
    $script:Jobs = @()
    $script:Status = "Succeeded"
    $script:FailCreate = $false
    $script:FailDelete = $false
    $script:Linger = $false
    $script:ChangePayload = $false
    $script:ChangeIdentity = $false
    $script:StartCalls = 0
    $script:DeleteCalls = 0
    $script:SleepCalls = 0
    $script:ExecutionChecks = 0
    $script:Calls = [Collections.Generic.List[object]]::new()
    $script:AccountId = $SubscriptionId
    $script:AccountState = "Enabled"
}
function Invoke-Az([string[]]$CommandArgs) {
    $script:Calls.Add($CommandArgs)
    if ($CommandArgs[0] -eq "identity") { return $PullIdentity }
    if ($CommandArgs -contains "--help") { return "--yaml" }
    if ($CommandArgs[0] -eq "account") {
        if ($CommandArgs[1] -eq "set") { return "" }
        return ([pscustomobject]@{ id = $script:AccountId; name = "Atoms-Staging"; state = $script:AccountState } | ConvertTo-Json -Compress)
    }
    if ($CommandArgs[0] -eq "acr") { return $PreviewDigest }
    if ($CommandArgs[0] -eq "containerapp" -and $CommandArgs[1] -eq "show") { return ($script:FixturePreview | ConvertTo-Json -Depth 20 -Compress) }
    if ($CommandArgs[0] -eq "containerapp" -and $CommandArgs[1] -eq "env") {
        if ($CommandArgs[2] -eq "show") { return ($script:FixtureEnvironment | ConvertTo-Json -Depth 20 -Compress) }
        return "[]"
    }
    if ($CommandArgs[0] -eq "resource") { return "[]" }
    if ($CommandArgs[0] -ne "containerapp" -or $CommandArgs[1] -ne "job") { throw "Unexpected mock command" }
    switch ($CommandArgs[2]) {
        "list" { return (ConvertTo-Json -InputObject @($script:Jobs) -Depth 20 -Compress) }
        "create" {
            Check ($CommandArgs -contains "--yaml") "Inline CLI payload regression"
            Check (-not ($CommandArgs -contains "--args")) "Node arguments must stay in the file"
            $path = $CommandArgs[[Array]::IndexOf($CommandArgs, "--yaml") + 1]
            $job = [IO.File]::ReadAllText($path) | ConvertFrom-Json
            Check ($job.properties.template.containers[0].args[1] -ceq $ProbeJavaScript) "JSON changed JavaScript"
            $script:Jobs = @($job)
            if ($script:ChangePayload) { $job.properties.template.containers[0].args[1] = 'console.log("incorrect-success")' }
            if ($script:ChangeIdentity) { $job.identity.type = "SystemAssigned" }
            if ($script:FailCreate) { throw "fixture-create-response-failure" }
            return ""
        }
        "show" { return ($script:Jobs[0] | ConvertTo-Json -Depth 20 -Compress) }
        "start" { $script:StartCalls++; return "$JobName-execution" }
        "execution" {
            Check ($CommandArgs[3] -eq "show") "Unexpected execution command"
            Check ($CommandArgs -contains "--job-execution-name") "Exact execution must be pinned"
            $script:ExecutionChecks++
            return ([pscustomobject]@{ properties = [pscustomobject]@{ status = $script:Status } } | ConvertTo-Json -Compress)
        }
        "delete" {
            $script:DeleteCalls++
            if ($script:FailDelete) { throw "fixture-delete-failure" }
            if (-not $script:Linger) { $script:Jobs = @() }
            return ""
        }
        default { throw "Unexpected mock job command" }
    }
}
function Start-Sleep { param($Seconds) $script:SleepCalls++ }

Case "success requires exact YAML payload and verified deletion" {
    Reset-Case
    Probe $script:FixtureApi $script:FixtureEnvironment
    Check ($script:StartCalls -eq 1 -and $script:DeleteCalls -eq 1 -and -not $script:JobMayExist) "Success/cleanup contract failed"
}
Case "create response failure still reconciles an applied resource" {
    Reset-Case; $script:FailCreate = $true
    Throws { try { Probe $script:FixtureApi $script:FixtureEnvironment } finally { Cleanup } } "fixture-create-response-failure"
    Check ($script:DeleteCalls -eq 1 -and $script:StartCalls -eq 0 -and -not $script:JobMayExist) "Applied create was not cleaned up"
}
Case "delete failure cannot report a passing probe" {
    Reset-Case; $script:FailDelete = $true
    Throws { Probe $script:FixtureApi $script:FixtureEnvironment } "fixture-delete-failure"
    Check ($script:JobMayExist) "Failed deletion lost its retry guard"
    $script:FailDelete = $false; Cleanup
    Check (-not $script:JobMayExist -and $script:DeleteCalls -eq 2) "Finally cleanup retry failed"
}
Case "successful delete response must also remove the resource" {
    Reset-Case; $script:Linger = $true
    Throws { Probe $script:FixtureApi $script:FixtureEnvironment } "deletion could not be verified"
    Check ($script:JobMayExist) "Unconfirmed deletion lost its guard"
    $script:Linger = $false; Cleanup
}
Case "pre-existing name collision is never mutated or deleted" {
    Reset-Case
    $script:Jobs = @((New-ProbeConfig "$AcrServer/control-api:fixture" "canadacentral" | ConvertTo-Json -Depth 20 | ConvertFrom-Json))
    Throws { try { Probe $script:FixtureApi $script:FixtureEnvironment } finally { Cleanup } } "already exists"
    Check ($script:DeleteCalls -eq 0 -and $script:StartCalls -eq 0) "Pre-existing resource was touched"
}
Case "ownership mismatch prevents deletion" {
    Reset-Case; $script:JobMayExist = $true
    $job = New-ProbeConfig "$AcrServer/control-api:fixture" "canadacentral" | ConvertTo-Json -Depth 20 | ConvertFrom-Json
    $job.tags.probeId = "not-this-probe"
    $script:Jobs = @($job)
    Throws { Cleanup } "ownership mismatch"
    Check ($script:DeleteCalls -eq 0) "Unowned resource was deleted"
}
Case "ARM payload changes prevent execution" {
    Reset-Case; $script:ChangePayload = $true
    Throws { try { Probe $script:FixtureApi $script:FixtureEnvironment } finally { Cleanup } } "payload/configuration changed"
    Check ($script:StartCalls -eq 0 -and $script:DeleteCalls -eq 1) "Changed payload was started"
}
Case "changed pull identity prevents execution" {
    Reset-Case; $script:ChangeIdentity = $true
    Throws { try { Probe $script:FixtureApi $script:FixtureEnvironment } finally { Cleanup } } "payload/configuration changed"
    Check ($script:StartCalls -eq 0 -and $script:DeleteCalls -eq 1) "Changed identity was used"
}
Case "terminal failed execution cannot pass" {
    Reset-Case; $script:Status = "Failed"
    Throws { try { Probe $script:FixtureApi $script:FixtureEnvironment } finally { Cleanup } } "status Failed"
    Check ($script:ExecutionChecks -eq 1 -and $script:DeleteCalls -eq 1) "Terminal failure/cleanup incorrect"
}
Case "running execution polling is bounded" {
    Reset-Case; $script:Status = "Running"
    Throws { try { Probe $script:FixtureApi $script:FixtureEnvironment } finally { Cleanup } } "bounded 180-second"
    Check ($script:ExecutionChecks -eq 36 -and $script:SleepCalls -eq 35 -and $script:DeleteCalls -eq 1) "Polling was not bounded"
}
Case "disabled or legacy subscriptions are rejected" {
    Reset-Case; $script:AccountState = "Disabled"
    Throws { Lock-Staging } "lock failed"
    $script:AccountState = "Enabled"; $script:AccountId = $ForbiddenSubscriptionId
    Throws { Lock-Staging } "Forbidden legacy"
}
Case "null domain lists are empty, not public exposure" {
    Reset-Case
    $script:FixturePreview = [pscustomobject]@{ properties = [pscustomobject]@{
        template = [pscustomobject]@{
            scale = [pscustomobject]@{ minReplicas = 0; maxReplicas = 1 }
            containers = @([pscustomobject]@{ image = $PreviewImage; env = @(
                [pscustomobject]@{ name = "PREVIEW_BASE_DOMAIN"; value = "preview.invalid" },
                [pscustomobject]@{ name = "PREVIEW_UI_ORIGIN"; value = $UiOrigin },
                [pscustomobject]@{ name = "PREVIEW_PUBLIC_PROTOCOL"; value = "https" },
                [pscustomobject]@{ name = "PREVIEW_GATEWAY_PORT"; value = "3002" }
            ) })
        }
        configuration = [pscustomobject]@{ ingress = [pscustomobject]@{ external = $false; allowInsecure = $false; targetPort = 3002; fqdn = $InternalFqdn; customDomains = $null } }
    } }
    Verify-Preview
    [void](Verify-PublicBoundary)
}
Case "absent ingress isolation metadata fails closed" {
    $script:FixturePreview.properties.configuration.ingress.PSObject.Properties.Remove("external")
    Throws { Verify-Preview } "ingress safety"
}

Reset-Case
$sample = New-ProbeConfig "$AcrServer/control-api:fixture" "canadacentral"
if ($null -ne $script:JobConfigPath -and [IO.File]::Exists($script:JobConfigPath)) { Remove-Item -LiteralPath $script:JobConfigPath -Force }
Write-Output ("ATOMS_HEALTH_TEST_RESULT " + (@{ cases = @($cases); config = $sample } | ConvertTo-Json -Depth 20 -Compress))
