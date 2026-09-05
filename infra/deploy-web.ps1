# Deploy the PackProof V2 web reference client to staging CloudFront.
# Updates PACKPROOF_WEB_ORIGINS on the existing Express API. Does not rebuild the API image.
param(
  [string]$Region = "us-east-1",
  [string]$FoundationStack = "packproof-v2-staging",
  [string]$WebStack = "packproof-v2-staging-web",
  [string]$ApiServiceName = "packproof-v2-staging-api",
  [string]$StagingApiUrl = "https://pa-5faf90eb81cb4764b37bd3dc259a5ac4.ecs.us-east-1.on.aws"
)

$ErrorActionPreference = "Stop"
$Aws = "$env:LOCALAPPDATA\Programs\Amazon\AWSCLIV2\aws.exe"
if (-not (Test-Path $Aws)) {
  $Aws = "aws"
}

function Invoke-Aws {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$AwsArgs)
  & $Aws @AwsArgs
  if ($LASTEXITCODE -ne 0) {
    throw "aws $($AwsArgs -join ' ') failed with exit $LASTEXITCODE"
  }
}

function Invoke-AwsJson {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$AwsArgs)
  $raw = & $Aws @AwsArgs
  if ($LASTEXITCODE -ne 0) {
    throw "aws $($AwsArgs -join ' ') failed with exit $LASTEXITCODE"
  }
  if (-not $raw) {
    return $null
  }
  return ($raw | ConvertFrom-Json)
}

function Get-StackOutputs([string]$Name) {
  $map = @{}
  $stack = Invoke-AwsJson cloudformation describe-stacks --stack-name $Name --region $Region
  foreach ($item in $stack.Stacks[0].Outputs) {
    $map[$item.OutputKey] = $item.OutputValue
  }
  return $map
}

. (Join-Path $PSScriptRoot "deployment-helpers.ps1")

$RepoRoot = Split-Path -Parent $PSScriptRoot
$WebRoot = Join-Path $RepoRoot "web"
$WebTemplate = Join-Path $PSScriptRoot "web.yaml"
$Foundation = Get-StackOutputs $FoundationStack

Write-Host "Validating $WebTemplate"
Invoke-Aws cloudformation validate-template --template-body "file://$WebTemplate" --region $Region | Out-Null

Write-Host "Deploying $WebStack"
Invoke-Aws cloudformation deploy `
  --stack-name $WebStack `
  --template-file $WebTemplate `
  --region $Region `
  --no-fail-on-empty-changeset

$Web = Get-StackOutputs $WebStack
$WebUrl = $Web.WebUrl.TrimEnd("/")
Write-Host "WEB_URL=$WebUrl"

Write-Host "Building web client against $StagingApiUrl"
$env:VITE_PACKPROOF_API_BASE_URL = $StagingApiUrl
$env:VITE_PACKPROOF_AUTH_MODE = "cognito"
$env:VITE_PACKPROOF_COGNITO_USER_POOL_ID = $Foundation.CognitoUserPoolId
$env:VITE_PACKPROOF_COGNITO_CLIENT_ID = $Foundation.CognitoClientId
$env:VITE_PACKPROOF_COGNITO_REGION = $Region
Push-Location $WebRoot
try {
  npm run build
  if ($LASTEXITCODE -ne 0) {
    throw "web production build failed"
  }
} finally {
  Pop-Location
}

$Dist = Join-Path $WebRoot "dist"
if (-not (Test-Path (Join-Path $Dist "index.html"))) {
  throw "web/dist/index.html is missing"
}
$releaseSha = (git -C $RepoRoot rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $releaseSha -notmatch '^[0-9a-f]{40}$') { throw "Could not resolve web release commit" }
# Publish exact build identity; generic UI strings cannot identify a release.
$releaseAssets = @(Get-ChildItem (Join-Path $Dist "assets") -File | ForEach-Object {
  @{ path = "assets/$($_.Name)"; sha256 = (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
})
@{
  commit = $releaseSha
  environment = "staging"
  apiUrl = $StagingApiUrl
  indexSha256 = (Get-FileHash (Join-Path $Dist "index.html") -Algorithm SHA256).Hash.ToLowerInvariant()
  assets = $releaseAssets
} | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $Dist "release.json") -Encoding utf8

# Keep prior content-addressed assets so open tabs can still load their chunks
# while the new index propagates through CloudFront.
Write-Host "Uploading $Dist to s3://$($Web.WebBucketName)"
Invoke-Aws s3 sync $Dist "s3://$($Web.WebBucketName)/" --region $Region --cache-control "public,max-age=31536000,immutable" --exclude "index.html" --exclude "release.json" --exclude "new/privacy/index.html" --exclude "new/terms/index.html"
Invoke-Aws s3 cp (Join-Path $Dist "index.html") "s3://$($Web.WebBucketName)/index.html" --region $Region --cache-control "no-cache,no-store,must-revalidate" --content-type "text/html"
Invoke-Aws s3 cp (Join-Path $Dist "new\privacy\index.html") "s3://$($Web.WebBucketName)/new/privacy/index.html" --region $Region --cache-control "no-cache,no-store,must-revalidate" --content-type "text/html"
Invoke-Aws s3 cp (Join-Path $Dist "new\terms\index.html") "s3://$($Web.WebBucketName)/new/terms/index.html" --region $Region --cache-control "no-cache,no-store,must-revalidate" --content-type "text/html"

Invoke-Aws s3 cp (Join-Path $Dist "release.json") "s3://$($Web.WebBucketName)/release.json" --region $Region --cache-control "no-cache,no-store,must-revalidate" --content-type "application/json"
Write-Host "Invalidating CloudFront $($Web.DistributionId)"
$invalidation = Invoke-AwsJson cloudfront create-invalidation --distribution-id $Web.DistributionId --paths "/*" --region $Region
Invoke-Aws cloudfront wait invalidation-completed --distribution-id $Web.DistributionId --id $invalidation.Invalidation.Id --region $Region

Write-Host "Updating API CORS for $WebUrl"
$services = Invoke-AwsJson ecs describe-services --cluster $Foundation.ClusterName --services $ApiServiceName --region $Region
$serviceArn = $services.services[0].serviceArn
if (-not $serviceArn) {
  throw "Express API service $ApiServiceName was not found"
}
$express = Invoke-AwsJson ecs describe-express-gateway-service --service-arn $serviceArn --region $Region
$current = $express.service.activeConfigurations[0].primaryContainer
$previousDefinition = @($services.services[0].deployments | Where-Object status -eq "PRIMARY")[0].taskDefinition
$existingOrigins = @($current.environment | Where-Object name -eq "PACKPROOF_WEB_ORIGINS")[0].value
if ($existingOrigins -ne $WebUrl) {
  $environment = @()
  $replaced = $false
  foreach ($item in $current.environment) {
    if ($item.name -eq "PACKPROOF_WEB_ORIGINS") {
      $environment += @{ name = "PACKPROOF_WEB_ORIGINS"; value = $WebUrl }
      $replaced = $true
    } else {
      $environment += @{ name = $item.name; value = $item.value }
    }
  }
  if (-not $replaced) {
    $environment += @{ name = "PACKPROOF_WEB_ORIGINS"; value = $WebUrl }
  }
  $container = @{
    image = $current.image
    containerPort = $current.containerPort
    awsLogsConfiguration = $current.awsLogsConfiguration
    environment = $environment
    secrets = $current.secrets
  }
  $containerFile = Join-Path $env:TEMP "packproof-express-web-cors.json"
  [System.IO.File]::WriteAllText($containerFile, ($container | ConvertTo-Json -Depth 8))
  Invoke-Aws ecs update-express-gateway-service `
    --service-arn $serviceArn `
    --region $Region `
    --health-check-path /health `
    --primary-container "file://$containerFile" | Out-Null

  [void](Wait-ExpressDeployment -ClusterName $Foundation.ClusterName -ServiceName $ApiServiceName -ServiceArn $serviceArn -ExpectedImage $current.image -PreviousTaskDefinition $previousDefinition -Region $Region)
} else {
  Write-Host "API CORS already matches; no additional API rollout is needed"
}

Write-Host "STAGING_WEB_URL=$WebUrl"
Write-Host "STAGING_API_URL=$StagingApiUrl"
Write-Host "CORS=$WebUrl"
