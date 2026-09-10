Clear-Host

[CmdletBinding()]
param(
    [string]$WebOrigin = "https://atoms-staging-web.proudpond-7f6fcfdd.canadacentral.azurecontainerapps.io",
    [string]$ControlApiOrigin = "https://atoms-staging-control-api.proudpond-7f6fcfdd.canadacentral.azurecontainerapps.io"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$TranscriptPath = Join-Path $env:TEMP (
    "atoms-staging-public-smoke-" + [Guid]::NewGuid().ToString("N") + ".log"
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

function Invoke-HttpCheck {
    param(
        [Parameter(Mandatory)][string]$Uri,
        [Parameter(Mandatory)][int]$ExpectedStatus,
        [string]$Label = $Uri
    )

    $response = Invoke-WebRequest `
        -Uri $Uri `
        -Method Get `
        -TimeoutSec 30 `
        -SkipHttpErrorCheck

    if ([int]$response.StatusCode -ne $ExpectedStatus) {
        throw "$Label returned HTTP $($response.StatusCode); expected $ExpectedStatus."
    }

    return $response
}

function Get-HeaderValue {
    param(
        [Parameter(Mandatory)]$Response,
        [Parameter(Mandatory)][string]$Name
    )

    $value = $Response.Headers[$Name]
    if ($null -eq $value) {
        return ""
    }
    if ($value -is [System.Array]) {
        return (($value | ForEach-Object { "$_" }) -join ", ")
    }
    return [string]$value
}

try {
    Start-Transcript -Path $TranscriptPath -Force | Out-Null
    $TranscriptStarted = $true

    Write-Host "Atoms Staging Public Smoke" -ForegroundColor DarkGray
    Write-Host "Read-only: no Azure, Entra, Graph, database, Supabase, queue, OpenAI, or E2B mutation." -ForegroundColor DarkGray

    $WebOrigin = $WebOrigin.TrimEnd("/")
    $ControlApiOrigin = $ControlApiOrigin.TrimEnd("/")

    Write-Step "Verify public Web routes"
    $root = Invoke-HttpCheck -Uri "$WebOrigin/" -ExpectedStatus 200 -Label "Web root"
    $redirect = Invoke-HttpCheck -Uri "$WebOrigin/redirect" -ExpectedStatus 200 -Label "MSAL redirect bridge"
    $readiness = Invoke-HttpCheck -Uri "$WebOrigin/project-readiness" -ExpectedStatus 200 -Label "Project readiness"

    foreach ($response in @($root, $readiness)) {
        $csp = Get-HeaderValue -Response $response -Name "Content-Security-Policy"
        if ([string]::IsNullOrWhiteSpace($csp)) {
            throw "A protected Web route is missing Content-Security-Policy."
        }
    }

    $redirectCoop = Get-HeaderValue -Response $redirect -Name "Cross-Origin-Opener-Policy"
    if (-not [string]::IsNullOrWhiteSpace($redirectCoop)) {
        throw "/redirect unexpectedly has Cross-Origin-Opener-Policy '$redirectCoop'."
    }

    Write-Ok "Web root HTTP 200 + CSP"
    Write-Ok "/project-readiness HTTP 200 + CSP"
    Write-Ok "/redirect HTTP 200 with MSAL COOP exception"

    Write-Step "Verify Control API public authentication boundary"
    [void](Invoke-HttpCheck -Uri "$ControlApiOrigin/readyz" -ExpectedStatus 200 -Label "Control API /readyz")
    [void](Invoke-HttpCheck -Uri "$ControlApiOrigin/v1/me" -ExpectedStatus 401 -Label "Unauthenticated /v1/me")
    [void](Invoke-HttpCheck -Uri "$ControlApiOrigin/v1/workspaces" -ExpectedStatus 401 -Label "Unauthenticated /v1/workspaces")

    Write-Ok "/readyz HTTP 200"
    Write-Ok "Unauthenticated /v1/me HTTP 401"
    Write-Ok "Unauthenticated /v1/workspaces HTTP 401"

    Write-Step "Verify exact Web-origin CORS"
    $cors = Invoke-WebRequest `
        -Uri "$ControlApiOrigin/v1/workspaces" `
        -Method Options `
        -Headers @{
            Origin = $WebOrigin
            "Access-Control-Request-Method" = "GET"
            "Access-Control-Request-Headers" = "authorization"
        } `
        -TimeoutSec 30 `
        -SkipHttpErrorCheck

    if ([int]$cors.StatusCode -lt 200 -or [int]$cors.StatusCode -ge 300) {
        throw "CORS preflight returned HTTP $($cors.StatusCode)."
    }

    $allowOrigin = Get-HeaderValue -Response $cors -Name "Access-Control-Allow-Origin"
    if ($allowOrigin -ne $WebOrigin) {
        throw "CORS origin mismatch. Expected '$WebOrigin', got '$allowOrigin'."
    }

    Write-Ok "Exact staging Web origin accepted by Control API CORS"

    Write-Host ""
    Write-Host "============================================================" -ForegroundColor Green
    Write-Host "STAGING PUBLIC SMOKE SUCCEEDED" -ForegroundColor Green
    Write-Host "============================================================" -ForegroundColor Green
    Write-Host "Web root          : HTTP 200"
    Write-Host "Project readiness : HTTP 200"
    Write-Host "MSAL redirect     : HTTP 200, COOP exception preserved"
    Write-Host "Control API ready : HTTP 200"
    Write-Host "Unauth boundaries : HTTP 401"
    Write-Host "CORS              : exact Web origin accepted"
}
finally {
    if ($TranscriptStarted) {
        try {
            Stop-Transcript | Out-Null
            if (Test-Path -LiteralPath $TranscriptPath) {
                Get-Content -LiteralPath $TranscriptPath -Raw | Set-Clipboard
                Write-Host ""
                Write-Host "Full safe transcript copied to clipboard." -ForegroundColor Green
                Write-Host "Transcript: $TranscriptPath" -ForegroundColor DarkGray
            }
        }
        catch {
            Write-Warning "Could not copy the transcript to the clipboard."
        }
    }
}
