Clear-Host
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

if ($PSVersionTable.PSVersion.Major -lt 7) {
    throw "PowerShell 7+ is required."
}

$SubscriptionId = "2ac8ed24-166b-4325-89dc-829d64391ce9"
$ForbiddenSubscriptionId = "bbcaf423-9a71-43bc-9fc7-821ef012cd01"
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
$ExpectedInternalFqdn = "atoms-staging-preview-gateway.internal.$ExpectedDefaultDomain"
$TargetPort = 3002

$env:AZURE_CONFIG_DIR = "$env:USERPROFILE\.azure-atoms"
$env:AZURE_CORE_ONLY_SHOW_ERRORS = "true"
$env:AZURE_CORE_NO_COLOR = "true"
$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"

$TranscriptPath = Join-Path $env:TEMP (
    "atoms-preview-internal-health-" +
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
    [int]$TimeoutSeconds = 180
) {
    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = AzPath
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true

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

    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
        try { $process.Kill($true) } catch {}
        try { $process.WaitForExit() } catch {}
        $process.Dispose()
        throw "Azure CLI command timed out after $TimeoutSeconds seconds."
    }

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
    [void](Az @(
        "account","set",
        "--subscription",$SubscriptionId,
        "--only-show-errors"
    ))

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

function Verify-PublicRoutingAbsent {
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
        throw "Environment-level HTTP route configs exist; public exposure boundary changed."
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

function Verify-PreviewInternalIngress {
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
    if ($null -eq $ingress) {
        throw "Preview Gateway internal ingress is missing."
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
    if ($fqdn -ne $ExpectedInternalFqdn) {
        throw "Unexpected Preview Gateway internal FQDN '$fqdn'."
    }

    Ok "Preview Gateway internal ingress metadata verified: external=false, HTTPS-only, min=0/max=1"
    return $fqdn
}

function Invoke-InternalHealthSmoke([string]$InternalFqdn) {
    Step "Wake Preview Gateway only through the internal environment network and verify /healthz"

    $url = "https://$InternalFqdn/healthz"
    $command = "wget -qO- --timeout=30 '$url'"

    $probe = Invoke-AzProcess -TimeoutSeconds 120 -CommandArgs @(
        "containerapp","debug",
        "--subscription",$SubscriptionId,
        "-g",$ResourceGroup,
        "-n",$ControlApiName,
        "--command",$command,
        "--only-show-errors"
    )

    $combined = (([string]$probe.Stdout) + "`n" + ([string]$probe.Stderr)).Trim()

    if ([int]$probe.ExitCode -ne 0) {
        throw "Internal Preview Gateway health probe failed safely.`n$combined"
    }

    if (-not $combined.Contains('{"status":"ok"}')) {
        throw "Internal Preview Gateway health response did not contain the expected JSON body.`n$combined"
    }

    Ok "Internal network request returned Preview Gateway health body: {`"status`":`"ok`"}"
    Note "This request may wake the Preview Gateway from scale 0 to 1 temporarily. No OpenAI/E2B provider call is involved."
}

try {
    Start-Transcript -Path $TranscriptPath -Force | Out-Null
    $TranscriptStarted = $true

    Write-Host "Atoms Staging Preview Gateway Internal Health Smoke v2" -ForegroundColor DarkGray
    Write-Host "This gate performs one internal /healthz request and may temporarily wake the scale-to-zero Preview Gateway." -ForegroundColor DarkGray
    Write-Host "It does NOT enable public ingress, DNS, certificates, custom domains, run execution, OpenAI, or E2B." -ForegroundColor DarkGray
    Write-Host "A browser request to the .internal. FQDN from outside the Container Apps environment is expected to return HTTP 404." -ForegroundColor DarkGray

    Step "Lock Azure CLI to Atoms-Staging"
    Lock-Staging

    Step "Verify Control API auth and execution safety"
    Verify-ControlApiSafety

    Step "Verify public exposure remains absent"
    Verify-PublicRoutingAbsent

    Step "Verify Preview Gateway internal-ingress contract"
    $internalFqdn = Verify-PreviewInternalIngress

    Note "External/browser HTTP 404 for the .internal. FQDN is expected and confirms the isolation boundary; the real probe runs from inside the Container Apps environment."
    Invoke-InternalHealthSmoke -InternalFqdn $internalFqdn

    Step "Re-verify safety boundaries after the internal health request"
    Verify-PreviewInternalIngress | Out-Null
    Verify-PublicRoutingAbsent
    Verify-ControlApiSafety
    Lock-Staging

    Write-Host ""
    Write-Host "============================================================" -ForegroundColor Green
    Write-Host "PREVIEW GATEWAY INTERNAL HEALTH SMOKE SUCCEEDED" -ForegroundColor Green
    Write-Host "============================================================" -ForegroundColor Green
    Write-Host "Preview Gateway       : $PreviewGatewayName"
    Write-Host "Internal FQDN         : $ExpectedInternalFqdn"
    Write-Host "Health endpoint       : /healthz"
    Write-Host "Health response       : {`"status`":`"ok`"}"
    Write-Host "Ingress               : INTERNAL ONLY"
    Write-Host "Replicas              : min 0 / max 1"
    Write-Host "PREVIEW_BASE_DOMAIN   : preview.invalid"
    Write-Host "Custom domain / TLS   : NOT configured"
    Write-Host "Public exposure       : NONE"
    Write-Host "RUN_EXECUTION_ENABLED : false"
    Write-Host "Provider execution    : NONE"
    Write-Host ""
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
