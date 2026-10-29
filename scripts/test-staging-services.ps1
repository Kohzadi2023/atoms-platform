Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
. (Join-Path $root "deploy/staging/web-public-origins.ps1")
. (Join-Path $root "deploy/staging/staging-services.ps1")

$script:Checks = 0
function Check($Condition, [string]$Message) {
    if (-not $Condition) { throw "OFFLINE ASSERTION FAILED: $Message" }
    $script:Checks++
}
function Rejects([scriptblock]$Code, [string]$Message, [string]$Pattern = "") {
    $text = $null
    try { & $Code | Out-Null } catch { $text = $_.Exception.Message }
    Check ($null -ne $text) $Message
    if ($Pattern -ne "") { Check ($text -match $Pattern) "$Message (message: $text)" }
}

# --- Service table -------------------------------------------------------------------
$api = Get-StagingServiceSpec -Name "control-api"
Check ($api.AppName -ceq "atoms-staging-control-api" -and $api.Repository -ceq "control-api") "Control API maps to its Container App and repository"
Check ($api.Dockerfile -ceq "apps/control-api/Dockerfile") "Control API builds from its own Dockerfile"
$worker = Get-StagingServiceSpec -Name "orchestrator-worker"
Check ($worker.AppName -ceq "atoms-staging-worker") "The worker's Container App is atoms-staging-worker, not orchestrator-worker"
Check ($worker.Repository -ceq "orchestrator-worker" -and $worker.Dockerfile -ceq "apps/orchestrator-worker/Dockerfile") "The worker builds orchestrator-worker"
Rejects { Get-StagingServiceSpec -Name "web" } "The web app is not a backend service here (it has its own script)" "Unknown staging service"
Rejects { Get-StagingServiceSpec -Name "" } "An empty name is refused"

# --- Image tag -----------------------------------------------------------------------
$sha = "A5E6D13BCEAE2A531DE904510EFB8B02DD86909E"
Check ((New-StagingImageTag -Sha $sha) -ceq "main-a5e6d13bceae") "The tag is main- plus the first 12 hex characters, lower case"
Check ((New-StagingImageTag -Sha $sha.ToLowerInvariant()) -ceq "main-a5e6d13bceae") "Upper and lower case give the same tag"
Rejects { New-StagingImageTag -Sha "a5e6d13" } "A short SHA is refused" "40-character"
Rejects { New-StagingImageTag -Sha ("z" * 40) } "A non-hex SHA is refused"
Rejects { New-StagingImageTag -Sha "" } "An empty SHA is refused"

# --- /readyz verdict -----------------------------------------------------------------
$ready = '{"status":"ready","platformReady":true,"executionReady":false,"execution":{"platformReady":true,"controlPlaneEnabled":true,"preconditionsMet":false,"executionReady":false,"inconsistent":true,"failingGates":["G5","G7"],"workerState":"reporting"}}'
Check (Get-ReadyzVerdict -Json $ready -Service "control-api").Ok "A ready platform passes after a Control API deploy"
Check (Get-ReadyzVerdict -Json $ready -Service "orchestrator-worker").Ok "A reporting worker passes after a worker deploy"
Check ((Get-ReadyzVerdict -Json $ready -Service "control-api").Reason -ceq "ready") "The passing reason is plain"

$silent = $ready.Replace('"workerState":"reporting"', '"workerState":"absent"')
Check (Get-ReadyzVerdict -Json $silent -Service "control-api").Ok "The worker's state is not judged after a Control API deploy"
$verdict = Get-ReadyzVerdict -Json $silent -Service "orchestrator-worker"
Check (-not $verdict.Ok -and $verdict.Reason -match "worker is not reporting.*absent") "A silent worker fails after a worker deploy"

$notReady = '{"status":"degraded","platformReady":false}'
Check (-not (Get-ReadyzVerdict -Json $notReady -Service "control-api").Ok) "A degraded platform fails"
Check (-not (Get-ReadyzVerdict -Json '{"status":"ready","platformReady":false}' -Service "control-api").Ok) "status ready with platformReady false fails"
Check (-not (Get-ReadyzVerdict -Json "" -Service "control-api").Ok) "An empty response fails"
Check ((Get-ReadyzVerdict -Json "<html>502</html>" -Service "control-api").Reason -match "did not return JSON") "A non-JSON gateway page is named as such"
Check (-not (Get-ReadyzVerdict -Json '{}' -Service "control-api").Ok) "An empty object fails without throwing"
Check (-not (Get-ReadyzVerdict -Json 'null' -Service "orchestrator-worker").Ok) "A null body fails without throwing"
# G5/G7 open is the normal state today and must never fail a deploy on its own.
$gatesOpen = $ready.Replace('"inconsistent":true', '"inconsistent":true,"executionReady":false')
Check (Get-ReadyzVerdict -Json $gatesOpen -Service "control-api").Ok "Open G5/G7 gates and inconsistent=true do not fail a deploy"

# --- Waiting for the revision --------------------------------------------------------
function New-FakeAz([string[]]$Ready) {
    $script:ReadySequence = $Ready
    $script:ShowCalls = 0
    return {
        $i = [Math]::Min($script:ShowCalls, $script:ReadySequence.Count - 1)
        $script:ShowCalls++
        return $script:ReadySequence[$i]
    }
}
$wait = @{ Subscription = "sub"; ResourceGroup = "rg"; App = "atoms-staging-worker"; Revision = "atoms-staging-worker--0000005"; PollSeconds = 0 }

$fake = New-FakeAz -Ready @("atoms-staging-worker--main22", "atoms-staging-worker--main22", "atoms-staging-worker--0000005")
Wait-RevisionReady -Az $fake @wait -TimeoutMinutes 5
Check ($script:ShowCalls -eq 3) "Waits while the previous revision is still the ready one"

$fake = New-FakeAz -Ready @("atoms-staging-worker--0000005")
Wait-RevisionReady -Az $fake @wait -TimeoutMinutes 5
Check ($script:ShowCalls -eq 1) "Returns at once when the revision is already ready"

$fake = New-FakeAz -Ready @("atoms-staging-worker--main22")
Rejects { Wait-RevisionReady -Az $fake @wait -TimeoutMinutes 0 } "A revision that never becomes ready times out" "previous revision \('atoms-staging-worker--main22'\) is still the ready one"
Check ($script:ShowCalls -ge 1) "The timeout case really polled"

# --- The script keeps its guards -----------------------------------------------------
$path = Join-Path $root "deploy/staging/deploy-backend-image.ps1"
$text = Get-Content -LiteralPath $path -Raw
$tokens = $null; $errors = $null
[void][Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
Check (@($errors).Count -eq 0) "deploy-backend-image.ps1 parses"
Check ($text.StartsWith("#Requires -Version 7.0")) "deploy-backend-image.ps1 refuses Windows PowerShell 5.1 up front"
Check ($text -match "(?s)\[Parameter\(Mandatory\)\]\s*\[ValidatePattern\(`"\^\[0-9a-fA-F\]\{40\}\$`"\)\]\s*\[string\]\`$ExpectedSourceSha") "The source SHA is mandatory and must be 40 hex characters"
Check ($text -match "(?s)\[Parameter\(Mandatory\)\]\s*\[ValidateSet\(`"control-api`", `"orchestrator-worker`"\)\]") "Only the two backend services can be named"
Check ($text.Contains("2ac8ed24-166b-4325-89dc-829d64391ce9") -and $text.Contains("bbcaf423-9a71-43bc-9fc7-821ef012cd01")) "The staging subscription is locked and the legacy one refused"
Check ($text.Contains("Source SHA mismatch") -and $text.Contains("uncommitted changes")) "A dirty tree or the wrong commit is refused"
Check ($text.Contains("activeRevisionsMode") -and $text.Contains('"Single"')) "Only Single revision mode is accepted"
Check ($text.Contains("-PlanOnly") -or $text.Contains("[switch]`$PlanOnly")) "A plan-only mode exists"
# The argument line itself, not the comment that explains it.
Check ($text -match '(?m)^\s+--no-logs `\r?$') "The build passes --no-logs (a mention in a comment is not enough)"
Check ($text.Contains("Wait-AcrImage") -and $text.Contains("Wait-RevisionReady")) "It waits for the image and for the revision"
Check ($text.Contains("Get-ReadyzVerdict") -and $text.Contains("Rollback")) "It checks /readyz and prints the rollback command"
Check ($text.Contains("`$sameImage") -and $text.Contains("no earlier image to return to")) "It does not offer a rollback to the image the app already runs"
Check ($text.Contains("web-public-origins.ps1") -and $text.Contains("staging-services.ps1")) "It loads both helper files"
Check ($text -notmatch "(?m)^\s*Clear-Host\s*$") "It does not call Clear-Host unguarded"
Check ($text -notmatch "(?i)azurecontainerapps\.io") "It names no raw Container Apps host"
# The PlanOnly return must come before the first thing that changes Azure.
$planOnlyAt = $text.IndexOf("if (`$PlanOnly)")
# (the rollback hint also contains the words "containerapp update", so look for the real calls)
$buildCallAt = $text.IndexOf("& `$az acr build")
$updateCallAt = $text.IndexOf("& `$az containerapp update")
Check ($planOnlyAt -gt 0 -and $buildCallAt -gt $planOnlyAt -and $updateCallAt -gt $planOnlyAt) "-PlanOnly stops before the build and before the update"
Check ($buildCallAt -lt $updateCallAt) "The image is built before the app is updated"

Write-Host "OFFLINE TESTS PASSED: $($script:Checks) assertions; staging service table, image tag, /readyz verdict, revision wait and the deploy script's guards. No Azure requests made."
