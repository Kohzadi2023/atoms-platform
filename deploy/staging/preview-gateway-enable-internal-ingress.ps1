Clear-Host
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

if ($PSVersionTable.PSVersion.Major -lt 7) {
    throw "PowerShell 7+ is required."
}

$SubscriptionId = "2ac8ed24-166b-4325-89dc-829d64391ce9"
$ForbiddenSubscriptionId = "bbcaf423-9a71-43bc-9fc7-821ef012cd01"
$BaselineSha = "0482b37eab42e274665267d4d49bf18fb83bf0e8"

$ResourceGroup = "atoms-staging-rg"
$EnvironmentName = "atoms-staging-env"
$ControlApiName = "atoms-staging-control-api"
$PreviewGatewayName = "atoms-staging-preview-gateway"
$AcrName = "atomsstaging91ce9"
$PreviewAcrRef = "preview-gateway:private-skeleton-0482b37eab42"
$PreviewImage = "atomsstaging91ce9.azurecr.io/$PreviewAcrRef"
$ExpectedPreviewDigest = "sha256:53b70e9f6fa2fee00af2c02d70c6d5fdc281acde31532af1c2ab7d7278c9d994"
$ExpectedDefaultDomain = "proudpond-7f6fcfdd.canadacentral.azurecontainerapps.io"
$ExpectedUiOrigin = "https://atoms-staging-web.$ExpectedDefaultDomain"
$TargetPort = 3002

# Repository script: deploy/staging -> repository root is ../..
$RepoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))

$env:AZURE_CONFIG_DIR = "$env:USERPROFILE\.azure-atoms"
$env:AZURE_CORE_ONLY_SHOW_ERRORS = "true"
$env:AZURE_CORE_NO_COLOR = "true"
$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"

$TranscriptPath = Join-Path $env:TEMP (
    "atoms-staging-preview-internal-ingress-" +
    [Guid]::NewGuid().ToString("N") +
    ".log"
)
$TranscriptStarted = $false

function Step([string]$Message) {
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Ok([string]$Message) {
    Write-Host "    OK: $Message" -ForegroundColor Green
}

function Note([string]$Message) {
    Write-Host "    NOTE: $Message" -ForegroundColor Yellow
}

function AzPath {
    $cmd = Get-Command az.cmd -ErrorAction SilentlyContinue
    if ($null -eq $cmd) {
        $cmd = Get-Command az -ErrorAction SilentlyContinue
    }
    if ($null -eq $cmd) {
        throw "Azure CLI was not found."
    }
    return [string]$cmd.Source
}

function Invoke-AzProcess(
    [string[]]$CommandArgs,
    [string]$WorkingDirectory = ""
) {
    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = AzPath
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true

    if (-not [string]::IsNullOrWhiteSpace($WorkingDirectory)) {
        if (-not (Test-Path -LiteralPath $WorkingDirectory -PathType Container)) {
            throw "Working directory does not exist: $WorkingDirectory"
        }
        $psi.WorkingDirectory = $WorkingDirectory
    }

    foreach ($arg in $CommandArgs) {
        [void]$psi.ArgumentList.Add([string]$arg)
    }

    $psi.Environment["AZURE_CONFIG_DIR"] = $env:AZURE_CONFIG_DIR
    $psi.Environment["AZURE_CORE_ONLY_SHOW_ERRORS"] = "true"
    $psi.Environment["AZURE_CORE_NO_COLOR"] = "true"
    $psi.Environment["PYTHONUTF8"] = "1"
    $psi.Environment["PYTHONIOENCODING"] = "utf-8"

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $psi
    if (-not $process.Start()) {
        throw "Azure CLI process could not be started."
    }

    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()

    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    $exitCode = $process.ExitCode
    $process.Dispose()

    return [PSCustomObject]@{
        ExitCode = $exitCode
        Stdout = if ($null -eq $stdout) { "" } else { [string]$stdout }
        Stderr = if ($null -eq $stderr) { "" } else { [string]$stderr }
    }
}

function Az([string[]]$CommandArgs) {
    $result = Invoke-AzProcess $CommandArgs
    if ([int]$result.ExitCode -ne 0) {
        $safeStderr = ([string]$result.Stderr).Trim()
        if ([string]::IsNullOrWhiteSpace($safeStderr)) {
            $safeStderr = "<no stderr text>"
        }
        throw "Azure CLI command failed safely.`n$safeStderr"
    }
    return ([string]$result.Stdout).Trim()
}

function AzJson([string[]]$CommandArgs) {
    $raw = Az $CommandArgs
    if ([string]::IsNullOrWhiteSpace($raw)) {
        return @()
    }
    return $raw | ConvertFrom-Json
}

function Prop($Object, [string]$Name) {
    if ($null -eq $Object) { return $null }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function EnvValue($App, [string]$Name) {
    $containers = @(Prop $App.properties.template "containers")
    if (@($containers).Count -ne 1) {
        throw "Expected exactly one container while reading '$Name'."
    }

    $items = @(Prop $containers[0] "env")
    $match = @(
        $items |
            Where-Object { [string](Prop $_ "name") -eq $Name }
    )

    if (@($match).Count -ne 1) {
        return $null
    }

    $value = Prop $match[0] "value"
    if ($null -eq $value) {
        return $null
    }
    return [string]$value
}

function Lock-Staging {
    $set = Invoke-AzProcess @(
        "account","set",
        "--subscription",$SubscriptionId,
        "--only-show-errors"
    )
    if ([int]$set.ExitCode -ne 0) {
        throw "Could not select Atoms-Staging."
    }

    $account = AzJson @(
        "account","show",
        "--subscription",$SubscriptionId,
        "-o","json",
        "--only-show-errors"
    )

    $activeId = [string](Prop $account "id")
    $activeName = [string](Prop $account "name")
    $activeState = [string](Prop $account "state")

    if ($activeId -eq $ForbiddenSubscriptionId) {
        throw "CRITICAL: forbidden legacy subscription is active."
    }
    if ($activeId -ne $SubscriptionId) {
        throw "Unexpected subscription '$activeId'."
    }
    if ($activeName -ne "Atoms-Staging") {
        throw "Expected subscription name Atoms-Staging; got '$activeName'."
    }
    if ($activeState -ne "Enabled") {
        throw "Atoms-Staging subscription is not Enabled."
    }

    Ok "Subscription locked to Atoms-Staging ($SubscriptionId)"
}

function Verify-Repository {
    Step "Verify clean repository and accepted preview source baseline"

    if (-not (Test-Path -LiteralPath $RepoRoot -PathType Container)) {
        throw "Repository root not found: $RepoRoot"
    }

    $git = Get-Command git -ErrorAction Stop

    & $git.Source -C $RepoRoot fetch origin main
    if ($LASTEXITCODE -ne 0) {
        throw "git fetch origin main failed."
    }

    $branch = (& $git.Source -C $RepoRoot branch --show-current).Trim()
    if ($branch -ne "main") {
        throw "Run this gate from the main branch; current branch is '$branch'."
    }

    $dirty = (& $git.Source -C $RepoRoot status --porcelain) -join "`n"
    if (-not [string]::IsNullOrWhiteSpace($dirty)) {
        throw "Repository must be clean."
    }

    $head = (& $git.Source -C $RepoRoot rev-parse HEAD).Trim()
    $originMain = (& $git.Source -C $RepoRoot rev-parse origin/main).Trim()
    if ($head -ne $originMain) {
        throw "Local main must exactly match origin/main."
    }

    & $git.Source -C $RepoRoot merge-base --is-ancestor $BaselineSha $head
    if ($LASTEXITCODE -ne 0) {
        throw "Current main does not contain the accepted preview-ticket baseline $BaselineSha."
    }

    $gatewaySource = Get-Content `
        -LiteralPath (Join-Path $RepoRoot "apps\preview-gateway\src\gateway.ts") `
        -Raw

    foreach ($token in @(
        'request.url === "/healthz"',
        "frame-ancestors",
        "permissions-policy",
        "no-referrer",
        "nosniff"
    )) {
        if (-not $gatewaySource.Contains($token)) {
            throw "Preview security invariant '$token' is missing from current main."
        }
    }

    $ticketSource = Get-Content `
        -LiteralPath (Join-Path $RepoRoot "packages\preview\src\ticket.ts") `
        -Raw

    foreach ($token in @(
        ".length(61)",
        "BASE36_SESSION_WIDTH = 25",
        "BASE36_EXPIRY_WIDTH = 9",
        "BASE36_MAC_WIDTH = 25",
        "MAC_BYTES = 16"
    )) {
        if (-not $ticketSource.Contains($token)) {
            throw "Single-label preview ticket invariant '$token' is missing."
        }
    }

    Ok "Repository main contains accepted single-label preview baseline: $head"
}

function Invoke-HttpProbe(
    [string]$Name,
    [string]$Uri,
    [int]$ExpectedStatus,
    [int]$Attempts = 4,
    [int]$TimeoutSeconds = 20,
    [int]$DelaySeconds = 5
) {
    $lastError = $null

    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        try {
            $response = Invoke-WebRequest `
                -Uri $Uri `
                -Method Get `
                -SkipHttpErrorCheck `
                -MaximumRedirection 0 `
                -ConnectionTimeoutSeconds $TimeoutSeconds

            if ([int]$response.StatusCode -eq $ExpectedStatus) {
                return
            }

            $lastError = "Expected HTTP $ExpectedStatus; got $([int]$response.StatusCode)."
        }
        catch {
            $lastError = $_.Exception.Message
        }

        if ($attempt -lt $Attempts) {
            Write-Host "    Probe '$Name' attempt $attempt/$Attempts did not pass; retrying." -ForegroundColor Yellow
            Start-Sleep -Seconds $DelaySeconds
        }
    }

    throw "Probe '$Name' failed after $Attempts attempts. Last result: $lastError"
}

function Verify-ControlApiSafety {
    Step "Verify auth and run-execution safety boundary"

    $api = AzJson @(
        "containerapp","show",
        "--subscription",$SubscriptionId,
        "-g",$ResourceGroup,
        "-n",$ControlApiName,
        "-o","json",
        "--only-show-errors"
    )

    if ((EnvValue $api "AUTH_REQUIRED") -ne "true") {
        throw "AUTH_REQUIRED must remain true."
    }
    if ((EnvValue $api "RUN_EXECUTION_ENABLED") -ne "false") {
        throw "RUN_EXECUTION_ENABLED must remain false."
    }

    Invoke-HttpProbe `
        -Name "Control API /readyz" `
        -Uri "https://$ControlApiName.$ExpectedDefaultDomain/readyz" `
        -ExpectedStatus 200

    Invoke-HttpProbe `
        -Name "Control API unauthenticated /v1/me" `
        -Uri "https://$ControlApiName.$ExpectedDefaultDomain/v1/me" `
        -ExpectedStatus 401

    Ok "AUTH_REQUIRED=true, RUN_EXECUTION_ENABLED=false, readyz=200, unauth /v1/me=401"
}

function Verify-PublicRoutingStillAbsent {
    Step "Verify public DNS/TLS and environment-route exposure remain absent"

    $environment = AzJson @(
        "containerapp","env","show",
        "--subscription",$SubscriptionId,
        "-g",$ResourceGroup,
        "-n",$EnvironmentName,
        "-o","json",
        "--only-show-errors"
    )

    $properties = Prop $environment "properties"
    if ([string](Prop $properties "defaultDomain") -ne $ExpectedDefaultDomain) {
        throw "Container Apps default domain changed unexpectedly."
    }

    $customConfig = Prop $properties "customDomainConfiguration"
    if ($null -ne $customConfig) {
        $dnsSuffix = [string](Prop $customConfig "dnsSuffix")
        $inlineCertificate = Prop $customConfig "certificateValue"
        $keyVaultCertificate = Prop $customConfig "certificateKeyVaultProperties"

        if (-not [string]::IsNullOrWhiteSpace($dnsSuffix) -or
            $null -ne $inlineCertificate -or
            $null -ne $keyVaultCertificate) {
            throw "Custom environment DNS/certificate configuration now exists; stop and re-plan."
        }
    }

    $certificates = @(
        AzJson @(
            "containerapp","env","certificate","list",
            "--subscription",$SubscriptionId,
            "-g",$ResourceGroup,
            "-n",$EnvironmentName,
            "-o","json",
            "--only-show-errors"
        )
    )
    if (@($certificates).Count -gt 0) {
        throw "Environment certificates now exist; stop and re-plan."
    }

    $zones = @(
        AzJson @(
            "resource","list",
            "--subscription",$SubscriptionId,
            "-g",$ResourceGroup,
            "--resource-type","Microsoft.Network/dnszones",
            "-o","json",
            "--only-show-errors"
        )
    )
    if (@($zones).Count -gt 0) {
        throw "Azure DNS public zones now exist in the staging resource group; stop and re-plan."
    }

    # Internal ingress can be exposed through an environment-level HTTP route.
    # Fail closed if any such route resource already exists.
    $routeConfigs = @(
        AzJson @(
            "resource","list",
            "--subscription",$SubscriptionId,
            "-g",$ResourceGroup,
            "--resource-type","Microsoft.App/managedEnvironments/httpRouteConfigs",
            "-o","json",
            "--only-show-errors"
        )
    )
    if (@($routeConfigs).Count -gt 0) {
        throw "Environment-level HTTP route configs exist; internal ingress cannot be enabled by this gate until those routes are reviewed."
    }

    Ok "No custom DNS suffix, certificates, Azure DNS public zone, or environment HTTP route config"
}

function Get-AcrDigest {
    $digest = Az @(
        "acr","repository","show",
        "--subscription",$SubscriptionId,
        "-n",$AcrName,
        "--image",$PreviewAcrRef,
        "--query","digest",
        "-o","tsv",
        "--only-show-errors"
    )

    $normalized = $digest.Trim().ToLowerInvariant()
    if ($normalized -notmatch "^sha256:[0-9a-f]{64}$") {
        throw "Preview image digest could not be verified."
    }
    return $normalized
}

function Verify-PreviewSkeleton([bool]$ExpectIngressEnabled) {
    $app = AzJson @(
        "containerapp","show",
        "--subscription",$SubscriptionId,
        "-g",$ResourceGroup,
        "-n",$PreviewGatewayName,
        "-o","json",
        "--only-show-errors"
    )

    $containers = @(Prop $app.properties.template "containers")
    if (@($containers).Count -ne 1) {
        throw "Expected exactly one Preview Gateway container."
    }

    if ([string](Prop $containers[0] "image") -ne $PreviewImage) {
        throw "Preview Gateway image changed unexpectedly."
    }

    if ((Get-AcrDigest) -ne $ExpectedPreviewDigest) {
        throw "Preview Gateway immutable ACR digest changed unexpectedly."
    }

    $scale = Prop $app.properties.template "scale"
    if ([int](Prop $scale "minReplicas") -ne 0 -or
        [int](Prop $scale "maxReplicas") -ne 1) {
        throw "Preview Gateway must remain scale-to-zero with min=0/max=1."
    }

    if ((EnvValue $app "PREVIEW_BASE_DOMAIN") -ne "preview.invalid") {
        throw "PREVIEW_BASE_DOMAIN must remain preview.invalid before public DNS/TLS."
    }
    if ((EnvValue $app "PREVIEW_UI_ORIGIN") -ne $ExpectedUiOrigin) {
        throw "PREVIEW_UI_ORIGIN changed unexpectedly."
    }
    if ((EnvValue $app "PREVIEW_PUBLIC_PROTOCOL") -ne "https") {
        throw "PREVIEW_PUBLIC_PROTOCOL must remain https."
    }
    if ((EnvValue $app "PREVIEW_GATEWAY_PORT") -ne "$TargetPort") {
        throw "Preview Gateway target port configuration changed unexpectedly."
    }

    $ingress = Prop $app.properties.configuration "ingress"

    if (-not $ExpectIngressEnabled) {
        if ($null -ne $ingress) {
            throw "Preview Gateway already has ingress. This gate expects the private no-ingress skeleton."
        }
        Ok "Preview Gateway private skeleton verified: no ingress, min=0/max=1, preview.invalid"
        return
    }

    if ($null -eq $ingress) {
        throw "Preview Gateway ingress was not enabled."
    }
    if ([bool](Prop $ingress "external")) {
        throw "CRITICAL: Preview Gateway ingress is external; expected internal-only."
    }
    if ([int](Prop $ingress "targetPort") -ne $TargetPort) {
        throw "Preview Gateway targetPort mismatch."
    }
    if ([bool](Prop $ingress "allowInsecure")) {
        throw "Preview Gateway insecure HTTP must remain disabled."
    }

    $customDomains = @(
        (Prop $ingress "customDomains") |
            Where-Object { $null -ne $_ }
    )
    if (@($customDomains).Count -gt 0) {
        throw "Preview Gateway must not have custom domains before public DNS/TLS approval."
    }

    $fqdn = [string](Prop $ingress "fqdn")
    if ([string]::IsNullOrWhiteSpace($fqdn) -or
        -not $fqdn.Contains(".internal.")) {
        throw "Expected an Azure internal Container Apps FQDN containing '.internal.'."
    }

    Ok "Preview Gateway internal ingress verified: external=false, targetPort=$TargetPort, HTTPS-only, no custom domain"
    Write-Host "    Internal FQDN: $fqdn"
}

try {
    Start-Transcript -Path $TranscriptPath -Force | Out-Null
    $TranscriptStarted = $true

    Write-Host "Atoms Staging Preview Gateway Internal-Ingress Gate" -ForegroundColor DarkGray
    Write-Host "This gate does NOT configure public ingress, DNS, certificates, custom domains, OpenAI, or E2B." -ForegroundColor DarkGray
    Write-Host "It keeps PREVIEW_BASE_DOMAIN=preview.invalid and RUN_EXECUTION_ENABLED=false." -ForegroundColor DarkGray

    Step "Lock Azure CLI to Atoms-Staging"
    Lock-Staging

    Verify-Repository
    Verify-ControlApiSafety
    Verify-PublicRoutingStillAbsent

    Step "Verify current private Preview Gateway skeleton"
    Verify-PreviewSkeleton -ExpectIngressEnabled $false

    Step "Enable INTERNAL-ONLY Container Apps ingress on port $TargetPort"
    [void](Az @(
        "containerapp","ingress","enable",
        "--subscription",$SubscriptionId,
        "-g",$ResourceGroup,
        "-n",$PreviewGatewayName,
        "--type","internal",
        "--target-port","$TargetPort",
        "--transport","auto",
        "--output","none",
        "--only-show-errors"
    ))
    Ok "Internal-only ingress configuration applied"

    Step "Verify post-change safety metadata without waking the scale-to-zero app"
    Verify-PreviewSkeleton -ExpectIngressEnabled $true
    Verify-PublicRoutingStillAbsent
    Verify-ControlApiSafety
    Lock-Staging

    Write-Host ""
    Write-Host "============================================================" -ForegroundColor Green
    Write-Host "PREVIEW GATEWAY INTERNAL-INGRESS GATE SUCCEEDED" -ForegroundColor Green
    Write-Host "============================================================" -ForegroundColor Green
    Write-Host "Preview Gateway       : $PreviewGatewayName"
    Write-Host "Ingress               : INTERNAL ONLY"
    Write-Host "Target port           : $TargetPort"
    Write-Host "Replicas              : min 0 / max 1"
    Write-Host "PREVIEW_BASE_DOMAIN   : preview.invalid"
    Write-Host "Custom domain / TLS   : NOT configured"
    Write-Host "Public exposure       : NONE"
    Write-Host "RUN_EXECUTION_ENABLED : false"
    Write-Host ""
    Write-Host "No health request was sent to the Preview Gateway, so this gate does not intentionally wake the scale-to-zero app." -ForegroundColor Yellow
    Write-Host "Public preview remains blocked until an owned domain, DNS control, and wildcard TLS path are proven." -ForegroundColor Yellow
}
finally {
    try {
        [void](Invoke-AzProcess @(
            "account","set",
            "--subscription",$SubscriptionId,
            "--only-show-errors"
        ))
    }
    catch {}

    if ($TranscriptStarted) {
        try {
            Stop-Transcript | Out-Null
            Get-Content -LiteralPath $TranscriptPath -Raw | Set-Clipboard
            Write-Host ""
            Write-Host "Full transcript copied to clipboard." -ForegroundColor Green
            Write-Host "Transcript: $TranscriptPath" -ForegroundColor DarkGray
        }
        catch {
            Write-Warning "Could not copy transcript to clipboard."
        }
    }
}
