$ErrorActionPreference = "Stop"
$infraRoot = Split-Path -Parent $PSScriptRoot
foreach ($file in Get-ChildItem $infraRoot -Filter *.ps1 -Recurse) {
  $errors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$null, [ref]$errors)
  if ($errors.Count -gt 0) { throw "$($file.Name): $($errors.Message -join '; ')" }
}
. (Join-Path $infraRoot "deployment-helpers.ps1")

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

$desired = @{
  image = "registry/api:new"
  environment = @(@{ name = "PACKPROOF_RELEASE_SHA"; value = "new" })
  secrets = @(@{ name = "PACKPROOF_DB_PASSWORD"; valueFrom = "new-db-arn:password::" })
}
$previous = @{
  environment = @(
    @{ name = "PACKPROOF_RELEASE_SHA"; value = "old" }
    @{ name = "PACKPROOF_GOOGLE_INTEGRATION_ENABLED"; value = "true" }
    @{ name = "PACKPROOF_SMTP_HOST"; value = "custom-smtp.example" }
    @{ name = "PACKPROOF_TRACKER_LINK_SECRET"; value = "legacy-plaintext" }
    @{ name = "PACKPROOF_DB_PASSWORD"; value = "legacy-db-password" }
  )
  secrets = @(
    @{ name = "PACKPROOF_GOOGLE_CLIENT_SECRET"; valueFrom = "provider-secret-arn" }
    @{ name = "PACKPROOF_RELEASE_SHA"; valueFrom = "old-release-secret" }
  )
}
$merged = Merge-ContainerRuntime -Desired $desired -Previous $previous -NotificationSecretArn "notification-arn"
$environment = @{}
foreach ($item in $merged.environment) { $environment[$item.name] = $item.value }
$secrets = @{}
foreach ($item in $merged.secrets) { $secrets[$item.name] = $item.valueFrom }
Assert-True ($merged.image -eq "registry/api:new") "The requested image must be retained"
Assert-True ($environment.PACKPROOF_RELEASE_SHA -eq "new") "New release identity must override preserved settings"
Assert-True ($environment.PACKPROOF_GOOGLE_INTEGRATION_ENABLED -eq "true") "Optional providers must survive the initial rollout"
Assert-True ($environment.PACKPROOF_SMTP_HOST -eq "custom-smtp.example") "Configured SMTP host must survive"
Assert-True ($secrets.PACKPROOF_GOOGLE_CLIENT_SECRET -eq "provider-secret-arn") "Provider secret bindings must survive"
Assert-True ($secrets.PACKPROOF_DB_PASSWORD -eq "new-db-arn:password::") "The current database secret must win"
Assert-True ($secrets.PACKPROOF_TRACKER_LINK_SECRET -eq "notification-arn:trackerLinkSecret::") "Notifications must be bound before rollout"
Assert-True (-not $environment.ContainsKey("PACKPROOF_TRACKER_LINK_SECRET")) "Notification secret must not remain plaintext"
foreach ($name in $secrets.Keys) {
  Assert-True (-not $environment.ContainsKey($name)) "A setting must not appear as both secret and environment"
}

# Stub AWS and sleeps: validate actual waiter behavior without cloud access.
$script:poll = 0
$script:failed = $false
$script:sameImage = $false
$script:mutationCalls = 0
function Start-Sleep { param([int]$Seconds) $script:poll++ }
function Invoke-Aws { param([Parameter(ValueFromRemainingArguments = $true)][string[]]$AwsArgs) $script:mutationCalls++ }
function Invoke-AwsJson {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$AwsArgs)
  $definition = if ($script:poll -eq 0) { "task:old" } else { "task:new" }
  $image = if ($script:poll -eq 0 -and -not $script:sameImage) { "registry/api:old" } else { "registry/api:new" }
  switch ($AwsArgs[1]) {
    "describe-express-gateway-service" {
      return @{ service = @{ activeConfigurations = @(@{ ingressPaths = @(@{ endpoint = "api.example" }) }) } }
    }
    "describe-services" {
      $state = if ($script:failed) { "FAILED" } else { "COMPLETED" }
      return @{ services = @(@{
        desiredCount = 1; runningCount = 1; pendingCount = 0
        deployments = @(@{ status = "PRIMARY"; rolloutState = $state; taskDefinition = $definition; rolloutStateReason = "fixture" })
        events = @()
      }) }
    }
    "list-tasks" {
      if ($AwsArgs -contains "STOPPED") { return @{ taskArns = @() } }
      return @{ taskArns = @("task-arn") }
    }
    "describe-tasks" {
      return @{ tasks = @(@{ lastStatus = "RUNNING"; taskDefinitionArn = $definition; containers = @(@{ image = $image }) }) }
    }
    default { throw "Unexpected AWS operation: $($AwsArgs -join ' ')" }
  }
}
$params = @{ ClusterName = "cluster"; ServiceName = "service"; ServiceArn = "service-arn"; ExpectedImage = "registry/api:new" }
$endpoint = Wait-ExpressDeployment @params
Assert-True ($endpoint -eq "api.example" -and $script:poll -eq 1) "A stable old image must not satisfy the new release"
$script:poll = 0
$script:sameImage = $true
$endpoint = Wait-ExpressDeployment @params -PreviousTaskDefinition "task:old"
Assert-True ($endpoint -eq "api.example" -and $script:poll -eq 1) "A config-only update must wait for its new task definition"
$script:failed = $true
$rejected = $false
try { [void](Wait-ExpressDeployment @params) } catch { $rejected = $_.Exception.Message -like "ECS rollout failed:*" }
Assert-True $rejected "Failed rollout must fail immediately instead of timing out or passing an old image"
Assert-True ($script:mutationCalls -eq 0) "Stable or failed service checks must not trigger a redundant rollout"
Write-Host "PASS: PowerShell syntax, atomic runtime preservation, release convergence, configuration convergence, and failed rollout handling"
