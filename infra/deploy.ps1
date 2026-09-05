# PackProof V2 staging deploy: foundation CloudFormation + CodeBuild image +
# ECS Express Mode API. Does not create production resources.
param(
  [string]$Region = "us-east-1",
  [string]$FoundationStack = "packproof-v2-staging",
  [string]$ApiStack = "packproof-v2-staging-api",
  [string]$EcrName = "packproof-v2-staging-api",
  [string]$ImageTag = (Get-Date -Format "yyyyMMddHHmmss"),
  [string]$WebOrigins = "",
  [switch]$EnableEbay,
  [string]$EbayEnvironment = "sandbox",
  [string]$EbayClientId = "",
  [string]$EbayRuName = "",
  [string]$EbayAppCredentialReference = "",
  [string]$PublicUrl = ""
)

$ErrorActionPreference = "Stop"
$Aws = "$env:LOCALAPPDATA\Programs\Amazon\AWSCLIV2\aws.exe"
if (-not (Test-Path $Aws)) {
  $Aws = "aws"
}

if ($EnableEbay) {
  $missingEbay = @()
  if (-not $EbayClientId.Trim()) {
    $missingEbay += "EbayClientId"
  }
  if (-not $EbayRuName.Trim()) {
    $missingEbay += "EbayRuName"
  }
  if (-not $EbayAppCredentialReference.Trim()) {
    $missingEbay += "EbayAppCredentialReference"
  }
  if ($missingEbay.Count -gt 0) {
    throw "EnableEbay requires $($missingEbay -join ', ')"
  }
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

$Account = (Invoke-AwsJson sts get-caller-identity).Account
$EcrUri = "$Account.dkr.ecr.$Region.amazonaws.com/$EcrName"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$BackendRoot = Join-Path $RepoRoot "backend"
$ReleaseSha = (git -C $RepoRoot rev-parse HEAD).Trim()
if (-not $ReleaseSha) {
  throw "Could not resolve git HEAD for PACKPROOF_RELEASE_SHA"
}
$FoundationTemplate = Join-Path $PSScriptRoot "staging.yaml"
$ApiTemplate = Join-Path $PSScriptRoot "api-service.yaml"
$BuildBucket = "packproof-v2-staging-build-$Account"

Write-Host "Account=$Account Region=$Region ImageTag=$ImageTag ReleaseSha=$ReleaseSha"

& $Aws ecr describe-repositories --repository-names $EcrName --region $Region 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Host "Creating ECR repository $EcrName"
  Invoke-Aws ecr create-repository --repository-name $EcrName --region $Region --image-scanning-configuration scanOnPush=true --encryption-configuration encryptionType=AES256 | Out-Null
}

$lifecycle = @{
  rules = @(
    @{
      rulePriority = 1
      description = "Keep the last 5 staging images"
      selection = @{
        tagStatus = "any"
        countType = "imageCountMoreThan"
        countNumber = 5
      }
      action = @{ type = "expire" }
    }
  )
} | ConvertTo-Json -Depth 8
$lifecycleFile = Join-Path $env:TEMP "packproof-ecr-lifecycle.json"
Set-Content -Path $lifecycleFile -Value $lifecycle -Encoding ascii
Invoke-Aws ecr put-lifecycle-policy --repository-name $EcrName --region $Region --lifecycle-policy-text "file://$lifecycleFile" | Out-Null

Write-Host "Validating CloudFormation foundation template"
Invoke-Aws cloudformation validate-template --template-body "file://$FoundationTemplate" --region $Region | Out-Null
if (Test-Path $ApiTemplate) {
  Invoke-Aws cloudformation validate-template --template-body "file://$ApiTemplate" --region $Region | Out-Null
}

Write-Host "Deploying $FoundationStack"
Invoke-Aws cloudformation deploy `
  --stack-name $FoundationStack `
  --template-file $FoundationTemplate `
  --region $Region `
  --capabilities CAPABILITY_NAMED_IAM `
  --no-fail-on-empty-changeset

$Outputs = Get-StackOutputs $FoundationStack

Write-Host "Packaging backend image source"
$zip = Join-Path $env:TEMP "packproof-v2-backend-src.zip"
$stage = Join-Path $env:TEMP "packproof-v2-backend-stage"
if (Test-Path $zip) {
  Remove-Item $zip -Force
}
if (Test-Path $stage) {
  Remove-Item $stage -Recurse -Force
}
New-Item -ItemType Directory -Path $stage | Out-Null
foreach ($name in @("Dockerfile", ".dockerignore", "package.json", "package-lock.json", "tsconfig.json", "buildspec.yml", "openapi.json")) {
  Copy-Item (Join-Path $BackendRoot $name) (Join-Path $stage $name)
}
Copy-Item -Recurse (Join-Path $BackendRoot "src") (Join-Path $stage "src")
Copy-Item -Recurse (Join-Path $BackendRoot "migrations") (Join-Path $stage "migrations")
if (-not (Test-Path (Join-Path $stage "src\index.ts"))) {
  throw "Staged backend source is missing src/index.ts"
}
if (-not (Test-Path (Join-Path $stage "migrations\001_init.sql"))) {
  throw "Staged backend source is missing migrations"
}
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::Open($zip, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  Get-ChildItem $stage -Recurse -File | ForEach-Object {
    $relative = [System.IO.Path]::GetRelativePath($stage, $_.FullName).Replace("\", "/")
    [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $_.FullName, $relative)
  }
} finally {
  $archive.Dispose()
}

Write-Host "Uploading source to s3://$BuildBucket/backend-src.zip"
Invoke-Aws s3 cp $zip "s3://$BuildBucket/backend-src.zip" --region $Region | Out-Null

Write-Host "Starting CodeBuild $ImageTag"
$build = Invoke-AwsJson codebuild start-build `
  --project-name packproof-v2-staging-api `
  --region $Region `
  --environment-variables-override "name=IMAGE_TAG,value=$ImageTag,type=PLAINTEXT"
$buildId = $build.build.id
Write-Host "Build $buildId"

do {
  Start-Sleep -Seconds 15
  $status = (Invoke-AwsJson codebuild batch-get-builds --ids $buildId --region $Region).builds[0]
  Write-Host "Build status $($status.buildStatus) phase $($status.currentPhase)"
} while ($status.buildStatus -eq "IN_PROGRESS")

if ($status.buildStatus -ne "SUCCEEDED") {
  throw "CodeBuild $buildId failed with $($status.buildStatus)"
}

$image = "${EcrUri}:${ImageTag}"
Write-Host "Image $image"

# Express Mode CloudFormation (AWS::ECS::ExpressGatewayService) is kept in
# api-service.yaml as the configuration contract. Apply it through the ECS CLI:
# CFN rollbacks while tasks are still starting, and some Express updates reset
# desired count to 0.
$secretArn = $Outputs.DatabaseSecretArn
$container = @{
  image = $image
  containerPort = 3000
  awsLogsConfiguration = @{
    logGroup = $Outputs.LogGroupName
    logStreamPrefix = "api"
  }
  environment = @(
    @{ name = "NODE_ENV"; value = "production" }
    @{ name = "PORT"; value = "3000" }
    @{ name = "PACKPROOF_AUTH_MODE"; value = "cognito" }
    @{ name = "PACKPROOF_OBJECT_STORAGE"; value = "s3" }
    @{ name = "AWS_REGION"; value = "us-east-1" }
    @{ name = "PACKPROOF_S3_BUCKET"; value = $Outputs.EvidenceBucket }
    @{ name = "PACKPROOF_COGNITO_USER_POOL_ID"; value = $Outputs.CognitoUserPoolId }
    @{ name = "PACKPROOF_COGNITO_CLIENT_ID"; value = $Outputs.CognitoClientId }
    @{ name = "PACKPROOF_COGNITO_REGION"; value = "us-east-1" }
    @{ name = "PACKPROOF_DB_HOST"; value = $Outputs.DatabaseEndpoint }
    @{ name = "PACKPROOF_DB_PORT"; value = $Outputs.DatabasePort }
    @{ name = "PACKPROOF_DB_NAME"; value = "packproof_v2" }
    @{ name = "PACKPROOF_DB_SSLMODE"; value = "require" }
    @{ name = "PACKPROOF_CREDENTIAL_STORE"; value = "secrets-manager" }
    @{ name = "PACKPROOF_ENVIRONMENT"; value = "staging" }
    @{ name = "PACKPROOF_RELEASE_SHA"; value = $ReleaseSha }
    @{ name = "PACKPROOF_RELEASE_IMAGE"; value = $ImageTag }
  )
  secrets = @(
    @{ name = "PACKPROOF_DB_USER"; valueFrom = "${secretArn}:username::" }
    @{ name = "PACKPROOF_DB_PASSWORD"; valueFrom = "${secretArn}:password::" }
  )
}
if ($WebOrigins.Trim()) {
  $container.environment += @{ name = "PACKPROOF_WEB_ORIGINS"; value = $WebOrigins.Trim() }
}
if ($EnableEbay) {
  $ebayEnvironment = if ($EbayEnvironment.Trim()) { $EbayEnvironment.Trim() } else { "sandbox" }
  $container.environment += @{ name = "PACKPROOF_EBAY_INTEGRATION_ENABLED"; value = "true" }
  $container.environment += @{ name = "PACKPROOF_EBAY_ENVIRONMENT"; value = $ebayEnvironment }
  $container.environment += @{ name = "PACKPROOF_EBAY_CLIENT_ID"; value = $EbayClientId.Trim() }
  $container.environment += @{ name = "PACKPROOF_EBAY_RUNAME"; value = $EbayRuName.Trim() }
  $container.environment += @{ name = "PACKPROOF_EBAY_APP_CREDENTIAL_REFERENCE"; value = $EbayAppCredentialReference.Trim() }
  $container.environment += @{ name = "PACKPROOF_EBAY_MARKETPLACE_ID"; value = "EBAY_US" }
}
if ($PublicUrl.Trim()) {
  $container.environment += @{ name = "PACKPROOF_PUBLIC_URL"; value = $PublicUrl.Trim() }
}
$network = @{
  subnets = @($Outputs.PublicSubnetA, $Outputs.PublicSubnetB)
}
$scaling = @{ minTaskCount = 1; maxTaskCount = 1 }
# Preserve optional settings before starting the new image. A second rollout
# after this one temporarily disabled integrations and exceeded the 10-minute
# generic ECS waiter during the managed canary deployment.
$existing = Invoke-AwsJson ecs describe-services --cluster $Outputs.ClusterName --services $ApiStack --region $Region
$serviceStatus = $existing.services[0].status
$serviceArn = $existing.services[0].serviceArn
$previousContainer = $null
$previousDefinition = ""
if ($serviceStatus -eq "ACTIVE" -and $serviceArn) {
  $previousExpress = Invoke-AwsJson ecs describe-express-gateway-service --service-arn $serviceArn --region $Region
  $previousContainer = $previousExpress.service.activeConfigurations[0].primaryContainer
  $previousDefinition = @($existing.services[0].deployments | Where-Object status -eq "PRIMARY")[0].taskDefinition
}
$container = Merge-ContainerRuntime -Desired $container -Previous $previousContainer -NotificationSecretArn $Outputs.NotificationSecretArn -Region $Region
$containerFile = Join-Path $env:TEMP "packproof-express-container.json"
$networkFile = Join-Path $env:TEMP "packproof-express-network.json"
$scalingFile = Join-Path $env:TEMP "packproof-express-scaling.json"
[System.IO.File]::WriteAllText($containerFile, ($container | ConvertTo-Json -Depth 8))
[System.IO.File]::WriteAllText($networkFile, ($network | ConvertTo-Json -Depth 8))
[System.IO.File]::WriteAllText($scalingFile, ($scaling | ConvertTo-Json -Depth 8))

if ($serviceStatus -eq "ACTIVE" -and $serviceArn) {
  Write-Host "Updating Express Mode service $ApiStack"
  Invoke-Aws ecs update-express-gateway-service `
    --service-arn $serviceArn `
    --region $Region `
    --health-check-path /health `
    --cpu 256 `
    --memory 1024 `
    --primary-container "file://$containerFile" | Out-Null
} else {
  Write-Host "Creating Express Mode service $ApiStack"
  $created = Invoke-AwsJson ecs create-express-gateway-service `
    --service-name $ApiStack `
    --cluster $Outputs.ClusterName `
    --region $Region `
    --execution-role-arn $Outputs.TaskExecutionRoleArn `
    --infrastructure-role-arn $Outputs.InfrastructureRoleArn `
    --task-role-arn $Outputs.TaskRoleArn `
    --health-check-path /health `
    --cpu 256 `
    --memory 1024 `
    --primary-container "file://$containerFile" `
    --network-configuration "file://$networkFile" `
    --scaling-target "file://$scalingFile"
  $serviceArn = $created.service.serviceArn
}

Write-Host "Ensuring desired count is 1"
Invoke-Aws ecs update-service --cluster $Outputs.ClusterName --service $ApiStack --desired-count 1 --region $Region | Out-Null

$endpoint = Wait-ExpressDeployment -ClusterName $Outputs.ClusterName -ServiceName $ApiStack -ServiceArn $serviceArn -ExpectedImage $image -PreviousTaskDefinition $previousDefinition -Region $Region

$publicUrl = $endpoint.TrimEnd("/")
if ($publicUrl -notmatch "^https?://") {
  $publicUrl = "https://$publicUrl"
}

Write-Host "STAGING_URL=$publicUrl"
Write-Host "IMAGE=$image"
Write-Host "RELEASE_SHA=$ReleaseSha"
Write-Host "DB_ENDPOINT=$($Outputs.DatabaseEndpoint)"
Write-Host "runningNewImage=$ImageTag"