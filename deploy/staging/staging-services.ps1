# Helpers for deploying the staging backend services (Control API and worker).
# None of them changes Azure by itself; deploy-backend-image.ps1 decides when to call az,
# so every decision here can be tested offline (scripts/test-staging-services.ps1).

function Get-StagingServiceSpec {
    param([Parameter(Mandatory)][string]$Name)

    switch ($Name) {
        "control-api" {
            return [pscustomobject]@{
                Name       = "control-api"
                AppName    = "atoms-staging-control-api"
                Repository = "control-api"
                Dockerfile = "apps/control-api/Dockerfile"
            }
        }
        "orchestrator-worker" {
            return [pscustomobject]@{
                Name       = "orchestrator-worker"
                AppName    = "atoms-staging-worker"
                Repository = "orchestrator-worker"
                Dockerfile = "apps/orchestrator-worker/Dockerfile"
            }
        }
        default { throw "Unknown staging service '$Name'. Expected control-api or orchestrator-worker." }
    }
}

# main-<first 12 hex characters of the commit>, so a tag always names the exact source.
function New-StagingImageTag {
    param([Parameter(Mandatory)][string]$Sha)

    if ($Sha -notmatch "^[0-9a-fA-F]{40}$") {
        throw "A full 40-character git SHA is required to name the image."
    }
    return "main-" + $Sha.ToLowerInvariant().Substring(0, 12)
}

function Get-JsonProperty {
    param($Object, [Parameter(Mandatory)][string]$Name)

    if ($null -eq $Object) { return $null }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

# Judges the Control API's /readyz after a deploy. The platform must be ready, and after a
# worker deploy the worker must be publishing its state again. executionReady and
# inconsistent are deliberately NOT judged: while the live-evidence gates G5 and G7 are open
# they read false/true by design, and they do not block runs.
function Get-ReadyzVerdict {
    param(
        [string]$Json,
        [Parameter(Mandatory)][string]$Service
    )

    try { $body = $Json | ConvertFrom-Json -ErrorAction Stop }
    catch { return [pscustomobject]@{ Ok = $false; Reason = "/readyz did not return JSON" } }

    $status = Get-JsonProperty $body "status"
    if ($status -ne "ready") {
        return [pscustomobject]@{ Ok = $false; Reason = "/readyz status is '$status', expected 'ready'" }
    }
    if ((Get-JsonProperty $body "platformReady") -ne $true) {
        return [pscustomobject]@{ Ok = $false; Reason = "/readyz platformReady is not true" }
    }
    if ($Service -eq "orchestrator-worker") {
        $workerState = Get-JsonProperty (Get-JsonProperty $body "execution") "workerState"
        if ($workerState -ne "reporting") {
            return [pscustomobject]@{ Ok = $false; Reason = "the worker is not reporting yet (workerState is '$workerState')" }
        }
    }
    return [pscustomobject]@{ Ok = $true; Reason = "ready" }
}

# Waits until the Container App's latest *ready* revision is the one the update created.
# In single-revision mode the previous revision keeps serving until then, so a failing new
# revision simply never becomes ready. $Az is the az executable; tests pass a script block.
function Wait-RevisionReady {
    param(
        [Parameter(Mandatory)]$Az,
        [Parameter(Mandatory)][string]$Subscription,
        [Parameter(Mandatory)][string]$ResourceGroup,
        [Parameter(Mandatory)][string]$App,
        [Parameter(Mandatory)][string]$Revision,
        [int]$TimeoutMinutes = 10,
        [int]$PollSeconds = 15
    )

    $deadline = (Get-Date).AddMinutes($TimeoutMinutes)
    while ($true) {
        $ready = ([string](@(& $Az containerapp show --subscription $Subscription --resource-group $ResourceGroup --name $App --query properties.latestReadyRevisionName --output tsv --only-show-errors 2>$null) -join "")).Trim()
        if ($ready -eq $Revision) { return }
        if ((Get-Date) -ge $deadline) {
            throw "Revision '$Revision' of $App did not become ready within $TimeoutMinutes minutes; the previous revision ('$ready') is still the ready one."
        }
        if ($PollSeconds -gt 0) { Start-Sleep -Seconds $PollSeconds }
    }
}
