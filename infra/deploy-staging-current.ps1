# Deploy the current git commit to PackProof staging without dropping existing
# optional integration configuration. The underlying deploy.ps1 remains the
# source of truth for foundation/image/ECS rollout; this wrapper snapshots and
# restores optional runtime configuration, binds notification secrets, then
# deploys the matching web bundle.
param(
  [string]$Region = "us-east-1",
  [string]$FoundationStack = "packproof-v2-staging",
  [string]$WebStack = "packproof-v2-staging-web",
  [string]$ApiServiceName = "packproof-v2-staging-api"
)

$ErrorActionPreference = "Stop"
$Aws = "$env:LOCALAPPDATA\Programs\Amazon\AWSCLIV2\aws.exe"
if (-not (Test-Path $Aws)) { $Aws = "aws" }

function Invoke-AwsJson {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$AwsArgs)
  $raw = & $Aws @AwsArgs
  if ($LASTEXITCODE -ne 0) { throw "aws $($AwsArgs -join ' ') failed with exit $LASTEXITCODE" }
  if (-not $raw) { return $null }
  return ($raw | ConvertFrom-Json)
}

function Invoke-Aws {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$AwsArgs)
  & $Aws @AwsArgs
  if ($LASTEXITCODE -ne 0) { throw "aws $($AwsArgs -join ' ') failed with exit $LASTEXITCODE" }
}

function Get-StackOutputs([string]$Name) {
  $map = @{}
  $stack = Invoke-AwsJson cloudformation describe-stacks --stack-name $Name --region $Region
  foreach ($item in $stack.Stacks[0].Outputs) { $map[$item.OutputKey] = $item.OutputValue }
  return $map
}

function Get-ExpressState([string]$ClusterName) {
  $services = Invoke-AwsJson ecs describe-services --cluster $ClusterName --services $ApiServiceName --region $Region
  $serviceArn = $services.services[0].serviceArn
  if (-not $serviceArn) { throw "Express API service $ApiServiceName was not found" }
  $express = Invoke-AwsJson ecs describe-express-gateway-service --service-arn $serviceArn --region $Region
  $container = $express.service.activeConfigurations[0].primaryContainer
  $endpoint = $express.service.activeConfigurations[0].ingressPaths[0].endpoint
  if (-not $endpoint) { throw "Express API service has no active endpoint" }
  $apiUrl = $endpoint.TrimEnd("/")
  if ($apiUrl -notmatch "^https?://") { $apiUrl = "https://$apiUrl" }
  return @{ ServiceArn = $serviceArn; Container = $container; ApiUrl = $apiUrl }
}

function To-EnvironmentMap($items) {
  $map = @{}
  foreach ($item in @($items)) {
    if ($item.name) { $map[$item.name] = [string]$item.value }
  }
  return $map
}

$foundation = Get-StackOutputs $FoundationStack
$web = Get-StackOutputs $WebStack
$webUrl = $web.WebUrl.TrimEnd("/")
$before = Get-ExpressState $foundation.ClusterName
$previousContainer = $before.Container
$previousEnvironment = To-EnvironmentMap $previousContainer.environment
$apiUrl = $before.ApiUrl

Write-Host "Current staging API: $apiUrl"
Write-Host "Current staging web: $webUrl"

$deployParams = @{
  Region = $Region
  FoundationStack = $FoundationStack
  ApiStack = $ApiServiceName
  WebOrigins = $webUrl
  PublicUrl = $apiUrl
}

if (($previousEnvironment["PACKPROOF_EBAY_INTEGRATION_ENABLED"] ?? "").ToLowerInvariant() -eq "true") {
  $required = @(
    "PACKPROOF_EBAY_ENVIRONMENT",
    "PACKPROOF_EBAY_CLIENT_ID",
    "PACKPROOF_EBAY_RUNAME",
    "PACKPROOF_EBAY_APP_CREDENTIAL_REFERENCE"
  )
  foreach ($name in $required) {
    if (-not $previousEnvironment[$name]) {
      throw "Existing eBay staging configuration is incomplete: $name is missing. Refusing to deploy and silently disable eBay."
    }
  }
  $deployParams.EnableEbay = $true
  $deployParams.EbayEnvironment = $previousEnvironment["PACKPROOF_EBAY_ENVIRONMENT"]
  $deployParams.EbayClientId = $previousEnvironment["PACKPROOF_EBAY_CLIENT_ID"]
  $deployParams.EbayRuName = $previousEnvironment["PACKPROOF_EBAY_RUNAME"]
  $deployParams.EbayAppCredentialReference = $previousEnvironment["PACKPROOF_EBAY_APP_CREDENTIAL_REFERENCE"]
}

& (Join-Path $PSScriptRoot "deploy.ps1") @deployParams
if ($LASTEXITCODE -ne 0) { throw "Backend staging deploy failed" }

# The foundation deploy may have created the notification secret for the first
# time. Refresh outputs before binding it to ECS.
$foundation = Get-StackOutputs $FoundationStack
$notificationSecretArn = $foundation.NotificationSecretArn
if (-not $notificationSecretArn) {
  throw "Foundation stack did not expose NotificationSecretArn"
}

$after = Get-ExpressState $foundation.ClusterName
$current = $after.Container
$environment = @()
$environmentNames = @{}
foreach ($item in @($current.environment)) {
  if ($item.name -in @("PACKPROOF_TRACKER_LINK_SECRET", "PACKPROOF_SMTP_USERNAME", "PACKPROOF_SMTP_PASSWORD")) { continue }
  $environment += @{ name = $item.name; value = [string]$item.value }
  $environmentNames[$item.name] = $true
}

# Preserve optional provider/runtime settings that deploy.ps1 does not own.
foreach ($item in @($previousContainer.environment)) {
  if (-not $item.name) { continue }
  if ($item.name -in @("PACKPROOF_TRACKER_LINK_SECRET", "PACKPROOF_SMTP_USERNAME", "PACKPROOF_SMTP_PASSWORD")) { continue }
  if (-not $environmentNames.ContainsKey($item.name)) {
    $environment += @{ name = $item.name; value = [string]$item.value }
    $environmentNames[$item.name] = $true
  }
}

function Add-DefaultEnvironment([string]$Name, [string]$Value) {
  if (-not $environmentNames.ContainsKey($Name)) {
    $script:environment += @{ name = $Name; value = $Value }
    $environmentNames[$Name] = $true
  }
}

Add-DefaultEnvironment "PACKPROOF_SMTP_HOST" "email-smtp.$Region.amazonaws.com"
Add-DefaultEnvironment "PACKPROOF_SMTP_PORT" "465"
Add-DefaultEnvironment "PACKPROOF_EMAIL_FROM" "notifications@thepackproof.com"
Add-DefaultEnvironment "PACKPROOF_SMTP_HELO" "thepackproof.com"

$secrets = @()
$secretNames = @{}
foreach ($item in @($current.secrets)) {
  if (-not $item.name) { continue }
  if ($item.name -in @("PACKPROOF_TRACKER_LINK_SECRET", "PACKPROOF_SMTP_USERNAME", "PACKPROOF_SMTP_PASSWORD")) { continue }
  $secrets += @{ name = $item.name; valueFrom = $item.valueFrom }
  $secretNames[$item.name] = $true
}
foreach ($item in @($previousContainer.secrets)) {
  if (-not $item.name -or $secretNames.ContainsKey($item.name)) { continue }
  if ($item.name -in @("PACKPROOF_TRACKER_LINK_SECRET", "PACKPROOF_SMTP_USERNAME", "PACKPROOF_SMTP_PASSWORD")) { continue }
  $secrets += @{ name = $item.name; valueFrom = $item.valueFrom }
  $secretNames[$item.name] = $true
}
$secrets += @{ name = "PACKPROOF_TRACKER_LINK_SECRET"; valueFrom = "${notificationSecretArn}:trackerLinkSecret::" }
$secrets += @{ name = "PACKPROOF_SMTP_USERNAME"; valueFrom = "${notificationSecretArn}:smtpUsername::" }
$secrets += @{ name = "PACKPROOF_SMTP_PASSWORD"; valueFrom = "${notificationSecretArn}:smtpPassword::" }

$container = @{
  image = $current.image
  containerPort = $current.containerPort
  awsLogsConfiguration = $current.awsLogsConfiguration
  environment = $environment
  secrets = $secrets
}
$containerFile = Join-Path $env:TEMP "packproof-express-preserved-runtime.json"
[System.IO.File]::WriteAllText($containerFile, ($container | ConvertTo-Json -Depth 10))
Invoke-Aws ecs update-express-gateway-service `
  --service-arn $after.ServiceArn `
  --region $Region `
  --health-check-path /health `
  --primary-container "file://$containerFile" | Out-Null
Invoke-Aws ecs update-service --cluster $foundation.ClusterName --service $ApiServiceName --desired-count 1 --force-new-deployment --region $Region | Out-Null
Invoke-Aws ecs wait services-stable --cluster $foundation.ClusterName --services $ApiServiceName --region $Region

$stable = Get-ExpressState $foundation.ClusterName
$apiUrl = $stable.ApiUrl

& (Join-Path $PSScriptRoot "deploy-web.ps1") `
  -Region $Region `
  -FoundationStack $FoundationStack `
  -WebStack $WebStack `
  -ApiServiceName $ApiServiceName `
  -StagingApiUrl $apiUrl
if ($LASTEXITCODE -ne 0) { throw "Web staging deploy failed" }

Write-Host "STAGING_API_URL=$apiUrl"
Write-Host "STAGING_WEB_URL=$webUrl"
