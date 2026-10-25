# Helpers shared by the staging Web deploy scripts. None of them changes Azure, so the
# decisions can be tested offline (scripts/test-web-public-origins.ps1).
#
# NEXT_PUBLIC_* values are baked into the Web image when it is built. The browser code
# uses them and so does the Content-Security-Policy (connect-src, frame-src), so they
# must be the origins a browser really uses -- the custom domains -- and not the raw
# *.azurecontainerapps.io hostnames the Container Apps get by default.

function Test-RawContainerAppsHost {
    param([string]$Value)
    return ($Value -match "(?i)azurecontainerapps\.io")
}

function Resolve-ControlApiOrigin {
    param(
        [string]$Explicit,
        [string[]]$CustomDomains = @(),
        [switch]$AllowRaw
    )

    if (-not [string]::IsNullOrWhiteSpace($Explicit)) {
        $candidate = $Explicit.Trim().TrimEnd("/").ToLowerInvariant()
        $source = "-ControlApiOrigin"
    }
    else {
        $names = @(
            $CustomDomains |
                Where-Object { -not [string]::IsNullOrWhiteSpace($_) -and $_ -notmatch "\*" } |
                ForEach-Object { $_.Trim().ToLowerInvariant() } |
                Select-Object -Unique
        )
        if ($names.Count -ne 1) {
            throw "The Control API has $($names.Count) non-wildcard custom domains, so its public origin cannot be chosen automatically. Pass -ControlApiOrigin https://<host>."
        }
        $candidate = "https://$($names[0])"
        $source = "the Control API custom domain"
    }

    $hostPattern = "[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+"
    if ($candidate -notmatch "^https://$hostPattern(:[0-9]{1,5})?$") {
        throw "Control API origin '$candidate' must be an https origin with a host name only (no path, query or wildcard)."
    }
    if ((Test-RawContainerAppsHost $candidate) -and -not $AllowRaw) {
        throw "Control API origin '$candidate' is a raw Container Apps host name. Browsers reach the API through its custom domain; baking the raw host name into the Web image breaks the CSP and CORS. Pass -ControlApiOrigin, or -AllowRawContainerAppsOrigins if this environment really has no custom domain."
    }

    return [pscustomobject]@{ Value = $candidate; Source = $source }
}

function Resolve-PreviewBaseDomain {
    param(
        [string]$Explicit,
        [string]$GatewayConfigured,
        [switch]$AllowRaw
    )

    if (-not [string]::IsNullOrWhiteSpace($Explicit)) {
        $candidate = $Explicit.Trim().Trim(".").ToLowerInvariant()
        $source = "-PreviewBaseDomain"
    }
    elseif (-not [string]::IsNullOrWhiteSpace($GatewayConfigured) -and $GatewayConfigured.Trim() -ne "None") {
        $candidate = $GatewayConfigured.Trim().Trim(".").ToLowerInvariant()
        $source = "the preview gateway's PREVIEW_BASE_DOMAIN"
    }
    else {
        throw "Could not read PREVIEW_BASE_DOMAIN from the preview gateway. Pass -PreviewBaseDomain <host>."
    }

    $hostPattern = "[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+"
    if ($candidate -notmatch "^$hostPattern$") {
        throw "Preview base domain '$candidate' must be a bare host name (no scheme, port, path or wildcard)."
    }
    if ((Test-RawContainerAppsHost $candidate) -and -not $AllowRaw) {
        throw "Preview base domain '$candidate' is a raw Container Apps host name. Previews are served on the preview custom domain; pass -PreviewBaseDomain, or -AllowRawContainerAppsOrigins if this environment really has none."
    }

    return [pscustomobject]@{ Value = $candidate; Source = $source }
}

# `az acr build` streams the build log, and on Windows that crashes with a charmap
# UnicodeEncodeError whenever the output is not a console. az.cmd starts Python with -I,
# so PYTHONUTF8 does not help. Scripts therefore build with --no-logs and call this to
# wait until the tag is really rewritten. $PreviousUpdate is the tag's lastUpdateTime
# read before the build ("" when the tag did not exist), so a leftover image from an
# earlier build of the same commit is never mistaken for the new one.
# $Az is the az executable; tests pass a script block instead.
function Get-AcrImageUpdateTime {
    param(
        [Parameter(Mandatory)]$Az,
        [Parameter(Mandatory)][string]$Subscription,
        [Parameter(Mandatory)][string]$Registry,
        [Parameter(Mandatory)][string]$Image
    )

    $text = & $Az acr repository show --subscription $Subscription --name $Registry --image $Image --query lastUpdateTime --output tsv --only-show-errors 2>$null
    return ([string](@($text) -join "")).Trim()
}

function Wait-AcrImage {
    param(
        [Parameter(Mandatory)]$Az,
        [Parameter(Mandatory)][string]$Subscription,
        [Parameter(Mandatory)][string]$Registry,
        [Parameter(Mandatory)][string]$Image,
        [string]$PreviousUpdate = "",
        [int]$TimeoutMinutes = 20,
        [int]$PollSeconds = 15
    )

    $deadline = (Get-Date).AddMinutes($TimeoutMinutes)
    while ($true) {
        $current = Get-AcrImageUpdateTime -Az $Az -Subscription $Subscription -Registry $Registry -Image $Image
        if (-not [string]::IsNullOrWhiteSpace($current) -and $current -ne $PreviousUpdate) {
            return $current
        }

        $status = ([string](@(& $Az acr task list-runs --subscription $Subscription --registry $Registry --top 1 --query "[0].status" --output tsv --only-show-errors 2>$null) -join "")).Trim()
        if ($status -in @("Failed", "Error", "Canceled", "Timeout")) {
            throw "The most recent ACR run ended as '$status' and '$Image' was not updated."
        }
        if ((Get-Date) -ge $deadline) {
            throw "'$Image' was not (re)built within $TimeoutMinutes minutes."
        }
        if ($PollSeconds -gt 0) { Start-Sleep -Seconds $PollSeconds }
    }
}
