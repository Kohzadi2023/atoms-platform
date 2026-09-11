Clear-Host
Set-StrictMode -Version Latest
$ErrorActionPreference="Stop"
$ProgressPreference="SilentlyContinue"
if($PSVersionTable.PSVersion.Major -lt 7){throw "PowerShell 7+ required."}

$SubscriptionId="2ac8ed24-166b-4325-89dc-829d64391ce9"
$ForbiddenSubscriptionId="bbcaf423-9a71-43bc-9fc7-821ef012cd01"
$Rg="atoms-staging-rg"
$EnvName="atoms-staging-env"
$ApiName="atoms-staging-control-api"
$PreviewName="atoms-staging-preview-gateway"
$Acr="atomsstaging91ce9"
$AcrServer="$Acr.azurecr.io"
$PullIdentity="/subscriptions/$SubscriptionId/resourceGroups/$Rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/atoms-staging-acr-pull"
$PreviewAcrRef="preview-gateway:private-skeleton-0482b37eab42"
$PreviewImage="$AcrServer/$PreviewAcrRef"
$PreviewDigest="sha256:53b70e9f6fa2fee00af2c02d70c6d5fdc281acde31532af1c2ab7d7278c9d994"
$DefaultDomain="proudpond-7f6fcfdd.canadacentral.azurecontainerapps.io"
$InternalFqdn="$PreviewName.internal.$DefaultDomain"
$UiOrigin="https://atoms-staging-web.$DefaultDomain"
$JobName="atoms-stg-pv-smoke-"+([Guid]::NewGuid().ToString("N").Substring(0,6))
$JobCreated=$false
$env:AZURE_CONFIG_DIR="$env:USERPROFILE\.azure-atoms"
$env:AZURE_CORE_ONLY_SHOW_ERRORS="true"
$Transcript=Join-Path $env:TEMP ("atoms-preview-health-"+[Guid]::NewGuid().ToString("N")+".log")
$TranscriptStarted=$false

function Ok($m){Write-Host "    OK: $m" -ForegroundColor Green}
function Step($m){Write-Host "`n==> $m" -ForegroundColor Cyan}
function Az([string[]]$a){
  $o=& az @a 2>&1
  if($LASTEXITCODE -ne 0){throw "Azure CLI failed safely.`n$($o -join "`n")"}
  return ($o -join "`n").Trim()
}
function J([string[]]$a){$r=Az $a;if([string]::IsNullOrWhiteSpace($r)){return $null};return $r|ConvertFrom-Json}
function P($o,$n){if($null-eq$o){return $null};$p=$o.PSObject.Properties[$n];if($null-eq$p){return $null};$p.Value}
function EnvVal($app,$name){
  $c=@(P $app.properties "template"|%{P $_ "containers"})
  if($c.Count-ne1){throw "Expected one container."}
  $m=@((P $c[0] "env")|?{[string](P $_ "name")-eq$name})
  if($m.Count-ne1){return $null};[string](P $m[0] "value")
}
function Lock-Staging{
  [void](Az @("account","set","--subscription",$SubscriptionId,"--only-show-errors"))
  $a=J @("account","show","--subscription",$SubscriptionId,"-o","json","--only-show-errors")
  if([string](P $a "id")-eq$ForbiddenSubscriptionId){throw "Forbidden legacy subscription active."}
  if([string](P $a "id")-ne$SubscriptionId -or [string](P $a "name")-ne"Atoms-Staging"){throw "Subscription lock failed."}
  Ok "Subscription locked to Atoms-Staging ($SubscriptionId)"
}
function Http($uri,$status){
  for($i=1;$i-le4;$i++){
    try{$r=Invoke-WebRequest -Uri $uri -SkipHttpErrorCheck -MaximumRedirection 0 -ConnectionTimeoutSeconds 20;if([int]$r.StatusCode-eq$status){return}}catch{}
    if($i-lt4){Start-Sleep 5}
  }
  throw "HTTP safety probe failed: $uri expected $status"
}
function Verify-Api{
  $a=J @("containerapp","show","--subscription",$SubscriptionId,"-g",$Rg,"-n",$ApiName,"-o","json","--only-show-errors")
  if((EnvVal $a "AUTH_REQUIRED")-ne"true"){throw "AUTH_REQUIRED must remain true."}
  if((EnvVal $a "RUN_EXECUTION_ENABLED")-ne"false"){throw "RUN_EXECUTION_ENABLED must remain false."}
  Http "https://$ApiName.$DefaultDomain/readyz" 200
  Http "https://$ApiName.$DefaultDomain/v1/me" 401
  Ok "AUTH_REQUIRED=true, RUN_EXECUTION_ENABLED=false, readyz=200, unauth /v1/me=401"
  return $a
}
function Verify-PublicBoundary{
  $e=J @("containerapp","env","show","--subscription",$SubscriptionId,"-g",$Rg,"-n",$EnvName,"-o","json","--only-show-errors")
  if([string](P $e.properties "defaultDomain")-ne$DefaultDomain){throw "Default domain changed."}
  $cd=P $e.properties "customDomainConfiguration"
  if($null-ne$cd){
    if(-not[string]::IsNullOrWhiteSpace([string](P $cd "dnsSuffix")) -or $null-ne(P $cd "certificateValue") -or $null-ne(P $cd "certificateKeyVaultProperties")){throw "Custom environment DNS/TLS now exists."}
  }
  $cert=@(J @("containerapp","env","certificate","list","--subscription",$SubscriptionId,"-g",$Rg,"-n",$EnvName,"-o","json","--only-show-errors"))
  if($cert.Count-gt0){throw "Environment certificates now exist."}
  $zones=@(J @("resource","list","--subscription",$SubscriptionId,"-g",$Rg,"--resource-type","Microsoft.Network/dnszones","-o","json","--only-show-errors"))
  if($zones.Count-gt0){throw "Azure DNS public zone now exists."}
  $routes=@(J @("resource","list","--subscription",$SubscriptionId,"-g",$Rg,"--resource-type","Microsoft.App/managedEnvironments/httpRouteConfigs","-o","json","--only-show-errors"))
  if($routes.Count-gt0){throw "Environment HTTP route config exists."}
  Ok "No public DNS/TLS/custom route exposure detected"
}
function Verify-Preview{
  $p=J @("containerapp","show","--subscription",$SubscriptionId,"-g",$Rg,"-n",$PreviewName,"-o","json","--only-show-errors")
  $c=@(P $p.properties.template "containers");if($c.Count-ne1){throw "Expected one preview container."}
  if([string](P $c[0] "image")-ne$PreviewImage){throw "Preview image changed."}
  $d=Az @("acr","repository","show","--subscription",$SubscriptionId,"-n",$Acr,"--image",$PreviewAcrRef,"--query","digest","-o","tsv","--only-show-errors")
  if($d.Trim().ToLowerInvariant()-ne$PreviewDigest){throw "Preview digest changed."}
  $s=P $p.properties.template "scale";if([int](P $s "minReplicas")-ne0 -or [int](P $s "maxReplicas")-ne1){throw "Preview scale must remain 0/1."}
  if((EnvVal $p "PREVIEW_BASE_DOMAIN")-ne"preview.invalid"){throw "PREVIEW_BASE_DOMAIN must remain preview.invalid."}
  if((EnvVal $p "PREVIEW_UI_ORIGIN")-ne$UiOrigin){throw "PREVIEW_UI_ORIGIN changed."}
  $i=P $p.properties.configuration "ingress"
  if($null-eq$i -or [bool](P $i "external") -or [int](P $i "targetPort")-ne3002 -or [bool](P $i "allowInsecure")){throw "Preview ingress safety contract failed."}
  if(@(P $i "customDomains").Count-gt0){throw "Custom domains must remain absent."}
  if([string](P $i "fqdn")-ne$InternalFqdn){throw "Unexpected internal FQDN."}
  Ok "Preview Gateway internal-only ingress, digest, scale 0/1, and preview.invalid verified"
}
function Cleanup{
  if(-not$JobCreated){return}
  Write-Host "    NOTE: deleting ephemeral probe job $JobName"
  & az containerapp job delete --subscription $SubscriptionId -g $Rg -n $JobName --yes --only-show-errors *> $null
  if($LASTEXITCODE-eq0){$script:JobCreated=$false;Ok "Ephemeral probe job deleted"}else{Write-Warning "Review ephemeral job $JobName in Atoms-Staging only."}
}
function Probe($api){
  Step "Create ephemeral same-environment Container Apps Job"
  $c=@(P $api.properties.template "containers");$image=[string](P $c[0] "image")
  if(-not$image.StartsWith("$AcrServer/",[StringComparison]::OrdinalIgnoreCase)){throw "Control API image is not from staging ACR."}
  [void](Az @("identity","show","--subscription",$SubscriptionId,"-g",$Rg,"-n","atoms-staging-acr-pull","--query","id","-o","tsv","--only-show-errors"))
  $url="https://$InternalFqdn/healthz"
  $js='const e=''{"status":"ok"}'';const c=new AbortController();setTimeout(()=>c.abort(),60000);fetch(process.env.TARGET_URL,{signal:c.signal}).then(async r=>{const b=(await r.text()).trim();if(r.status!==200||b!==e){console.error("ATOMS_PREVIEW_HEALTH_FAIL");process.exit(2)}console.log("ATOMS_PREVIEW_HEALTH_OK "+e)}).catch(x=>{console.error("ATOMS_PREVIEW_HEALTH_ERROR "+x);process.exit(3)});'
  [void](Az @("containerapp","job","create","--subscription",$SubscriptionId,"-g",$Rg,"-n",$JobName,"--environment",$EnvName,"--trigger-type","Manual","--replica-timeout","120","--replica-retry-limit","0","--image",$image,"--cpu","0.25","--memory","0.5Gi","--mi-user-assigned",$PullIdentity,"--registry-server",$AcrServer,"--registry-identity",$PullIdentity,"--container-name","preview-health-probe","--command","node","--args","-e",$js,"--env-vars","TARGET_URL=$url","--tags","project=atoms","environment=staging","purpose=preview-internal-health","lifecycle=ephemeral","--output","none","--only-show-errors"))
  $script:JobCreated=$true
  Ok "Ephemeral job created; no ingress and no provider secrets"

  Step "Run internal health probe"
  $exec=Az @("containerapp","job","start","--subscription",$SubscriptionId,"-g",$Rg,"-n",$JobName,"--query","name","-o","tsv","--only-show-errors")
  if([string]::IsNullOrWhiteSpace($exec)){Start-Sleep 3;$exec=Az @("containerapp","job","execution","list","--subscription",$SubscriptionId,"-g",$Rg,"-n",$JobName,"--query","sort_by(@,&properties.startTime)[-1].name","-o","tsv","--only-show-errors")}
  if([string]::IsNullOrWhiteSpace($exec)){throw "Could not resolve probe execution."}
  for($i=1;$i-le36;$i++){
    $x=J @("containerapp","job","execution","show","--subscription",$SubscriptionId,"-g",$Rg,"-n",$JobName,"--job-execution-name",$exec,"-o","json","--only-show-errors")
    $st=[string](P $x.properties "status")
    if($st-eq"Succeeded"){Ok 'Probe required HTTP 200 and exact body {"status":"ok"}';Cleanup;return}
    if($st-in@("Failed","Stopped","Degraded")){throw "Probe job ended with status $st."}
    if($i-lt36){Start-Sleep 5}
  }
  throw "Probe job did not succeed within 180 seconds."
}

try{
  Start-Transcript -Path $Transcript -Force|Out-Null;$TranscriptStarted=$true
  Write-Host "Atoms Staging Preview Gateway Internal Health Smoke v3" -ForegroundColor DarkGray
  Write-Host "Uses a temporary same-environment Container Apps Job. No public ingress, DNS/TLS, run execution, OpenAI, or E2B." -ForegroundColor DarkGray
  Step "Lock Azure to Atoms-Staging";Lock-Staging
  Step "Verify Control API safety";$api=Verify-Api
  Step "Verify public exposure remains absent";Verify-PublicBoundary
  Step "Verify Preview Gateway internal contract";Verify-Preview
  Probe $api
  Step "Re-verify safety";Verify-Preview;Verify-PublicBoundary;[void](Verify-Api);Lock-Staging
  Write-Host "`n============================================================" -ForegroundColor Green
  Write-Host "PREVIEW GATEWAY INTERNAL HEALTH SMOKE SUCCEEDED" -ForegroundColor Green
  Write-Host "============================================================" -ForegroundColor Green
  Write-Host 'Health response       : {"status":"ok"}'
  Write-Host "Ingress               : INTERNAL ONLY"
  Write-Host "PREVIEW_BASE_DOMAIN   : preview.invalid"
  Write-Host "Public exposure       : NONE"
  Write-Host "RUN_EXECUTION_ENABLED : false"
  Write-Host "Provider execution    : NONE"
}finally{
  try{Cleanup}catch{Write-Warning $_.Exception.Message}
  try{& az account set --subscription $SubscriptionId --only-show-errors}catch{}
  if($TranscriptStarted){try{Stop-Transcript|Out-Null;Get-Content $Transcript -Raw|Set-Clipboard;Write-Host "`nFull transcript copied to clipboard.`nTranscript: $Transcript" -ForegroundColor Green}catch{}}
}
