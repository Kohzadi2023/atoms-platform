Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
. (Join-Path $root "deploy/staging/web-public-origins.ps1")

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

# --- Control API origin -------------------------------------------------------------
$api = Resolve-ControlApiOrigin -CustomDomains @("api.genesisco.io")
Check ($api.Value -ceq "https://api.genesisco.io") "A single custom domain becomes the https origin"
Check ($api.Source -match "custom domain") "The origin reports where it came from"

$api = Resolve-ControlApiOrigin -Explicit "HTTPS://API.Genesisco.IO/" -CustomDomains @("other.example.com")
Check ($api.Value -ceq "https://api.genesisco.io") "An explicit origin wins and is normalised"
Check ($api.Source -ceq "-ControlApiOrigin") "An explicit origin reports its source"

$api = Resolve-ControlApiOrigin -CustomDomains @("*.wild.example.com", "api.genesisco.io", " API.GENESISCO.IO ")
Check ($api.Value -ceq "https://api.genesisco.io") "Wildcards are ignored and duplicates collapse"

Rejects { Resolve-ControlApiOrigin -CustomDomains @() } "No custom domain cannot pick an origin" "-ControlApiOrigin"
Rejects { Resolve-ControlApiOrigin -CustomDomains @("a.example.com", "b.example.com") } "Two custom domains cannot pick an origin" "-ControlApiOrigin"
Rejects { Resolve-ControlApiOrigin -CustomDomains @("*.example.com") } "A wildcard-only domain cannot pick an origin"
Rejects { Resolve-ControlApiOrigin -Explicit "http://api.genesisco.io" } "A plain http origin is refused"
Rejects { Resolve-ControlApiOrigin -Explicit "https://api.genesisco.io/v1" } "An origin with a path is refused"
Rejects { Resolve-ControlApiOrigin -Explicit "https://*.genesisco.io" } "A wildcard origin is refused"

$raw = "https://atoms-staging-control-api.proudpond-7f6fcfdd.canadacentral.azurecontainerapps.io"
Rejects { Resolve-ControlApiOrigin -Explicit $raw } "A raw Container Apps origin is refused" "raw Container Apps"
Rejects { Resolve-ControlApiOrigin -CustomDomains @("atoms-staging-control-api.proudpond-7f6fcfdd.canadacentral.azurecontainerapps.io") } "A raw host from the custom domain list is refused"
$api = Resolve-ControlApiOrigin -Explicit $raw -AllowRaw
Check ($api.Value -ceq $raw) "The explicit switch allows a raw origin"

# --- Preview base domain ------------------------------------------------------------
$preview = Resolve-PreviewBaseDomain -GatewayConfigured "preview.genesisco.io"
Check ($preview.Value -ceq "preview.genesisco.io") "The gateway's configured domain is used"
Check ($preview.Source -match "PREVIEW_BASE_DOMAIN") "The domain reports where it came from"

$preview = Resolve-PreviewBaseDomain -Explicit " .Preview.Genesisco.io. " -GatewayConfigured "stale.example.com"
Check ($preview.Value -ceq "preview.genesisco.io") "An explicit domain wins and is normalised"

Rejects { Resolve-PreviewBaseDomain } "No configured or explicit domain is refused" "-PreviewBaseDomain"
Rejects { Resolve-PreviewBaseDomain -GatewayConfigured "None" } "az printing None for a missing variable is treated as unset" "-PreviewBaseDomain"
Rejects { Resolve-PreviewBaseDomain -GatewayConfigured "  " } "A blank configured value is treated as unset" "-PreviewBaseDomain"
Rejects { Resolve-PreviewBaseDomain -Explicit "https://preview.genesisco.io" } "A scheme is refused"
Rejects { Resolve-PreviewBaseDomain -Explicit "*.preview.genesisco.io" } "A wildcard is refused"
Rejects { Resolve-PreviewBaseDomain -Explicit "preview.genesisco.io:443" } "A port is refused"
Rejects { Resolve-PreviewBaseDomain -Explicit "localhost" } "A single-label name is refused"
$rawPreview = "preview.proudpond-7f6fcfdd.canadacentral.azurecontainerapps.io"
Rejects { Resolve-PreviewBaseDomain -GatewayConfigured $rawPreview } "A raw Container Apps domain is refused" "raw Container Apps"
Check ((Resolve-PreviewBaseDomain -GatewayConfigured $rawPreview -AllowRaw).Value -ceq $rawPreview) "The explicit switch allows a raw preview domain"

# --- Waiting for the image ----------------------------------------------------------
# A fake az: the Nth `repository show` returns $script:Times[N], `task list-runs` returns the run status.
function New-FakeAz([string[]]$Times, [string]$RunStatus) {
    $script:Times = $Times
    $script:RunStatus = $RunStatus
    $script:ShowCalls = 0
    return {
        if ($args -contains "repository") {
            $i = [Math]::Min($script:ShowCalls, $script:Times.Count - 1)
            $script:ShowCalls++
            return $script:Times[$i]
        }
        if ($args -contains "list-runs") { return $script:RunStatus }
        throw "unexpected az call: $($args -join ' ')"
    }
}
$wait = @{ Subscription = "sub"; Registry = "acr"; Image = "web:entra-x"; PollSeconds = 0 }

$fake = New-FakeAz -Times @("", "", "2026-10-25T16:34:24Z") -RunStatus "Running"
$updated = Wait-AcrImage -Az $fake @wait -PreviousUpdate "" -TimeoutMinutes 5
Check ($updated -ceq "2026-10-25T16:34:24Z" -and $script:ShowCalls -eq 3) "Waits until the tag appears"

$fake = New-FakeAz -Times @("2026-10-25T16:34:24Z") -RunStatus "Succeeded"
$updated = Wait-AcrImage -Az $fake @wait -PreviousUpdate "" -TimeoutMinutes 5
Check ($updated -ceq "2026-10-25T16:34:24Z" -and $script:ShowCalls -eq 1) "A new tag is accepted at once"

$fake = New-FakeAz -Times @("old", "old", "new") -RunStatus "Running"
$updated = Wait-AcrImage -Az $fake @wait -PreviousUpdate "old" -TimeoutMinutes 5
Check ($updated -ceq "new") "A leftover image from an earlier build of the same tag is not accepted"

$fake = New-FakeAz -Times @("old") -RunStatus "Running"
Rejects { Wait-AcrImage -Az $fake @wait -PreviousUpdate "old" -TimeoutMinutes 0 } "A tag that never changes times out" "was not"

$fake = New-FakeAz -Times @("") -RunStatus "Failed"
Rejects { Wait-AcrImage -Az $fake @wait -PreviousUpdate "" -TimeoutMinutes 5 } "A failed ACR run stops the wait" "ended as 'Failed'"

# --- Both Web deploy scripts use the helper and have lost the stale values -----------
foreach ($name in @("entra-web-cutover.ps1", "entra-web-create-or-cutover.ps1")) {
    $path = Join-Path $root "deploy/staging/$name"
    $text = Get-Content -LiteralPath $path -Raw
    $tokens = $null; $errors = $null
    [void][Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
    Check (@($errors).Count -eq 0) "$name parses"
    Check ($text.Contains("web-public-origins.ps1")) "$name loads the shared helper"
    Check ($text.Contains("Resolve-ControlApiOrigin") -and $text.Contains("Resolve-PreviewBaseDomain")) "$name resolves both public origins"
    Check ($text.Contains("--no-logs") -and $text.Contains("Wait-AcrImage")) "$name builds without streaming logs and waits for the image"
    Check ($text -notmatch "preview\.proudpond") "$name no longer hard-codes the raw preview domain"
    Check ($text -notmatch "(?m)^\s*Clear-Host\s*$") "$name no longer calls Clear-Host unguarded"
    Check ($text.Contains("NEXT_PUBLIC_STORAGE_ORIGIN=") -and $text.Contains("NEXT_PUBLIC_CONTROL_API_URL=") -and $text.Contains("NEXT_PUBLIC_PREVIEW_BASE_DOMAIN=")) "$name still passes the three public origins"
}

Write-Host "OFFLINE TESTS PASSED: $($script:Checks) assertions; Web public origin resolution, ACR wait, and both deploy scripts. No Azure requests made."
