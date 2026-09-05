# Shared deployment logic. Loading this file performs no AWS operations.
function Merge-ContainerRuntime {
  param(
    [hashtable]$Desired,
    $Previous,
    [string]$NotificationSecretArn,
    [string]$Region = "us-east-1"
  )

  $environment = @{}
  $secrets = @{}
  foreach ($item in @($Previous.environment)) {
    if ($item.name) { $environment[$item.name] = [string]$item.value }
  }
  foreach ($item in @($Previous.secrets)) {
    if ($item.name) {
      $environment.Remove($item.name)
      $secrets[$item.name] = [string]$item.valueFrom
    }
  }
  # Explicit deployment settings override preserved settings. Each name may
  # appear in environment or secrets, never both.
  foreach ($item in @($Desired.environment)) {
    $secrets.Remove($item.name)
    $environment[$item.name] = [string]$item.value
  }
  foreach ($item in @($Desired.secrets)) {
    $environment.Remove($item.name)
    $secrets[$item.name] = [string]$item.valueFrom
  }
  if ($NotificationSecretArn) {
    $bindings = @{
      PACKPROOF_TRACKER_LINK_SECRET = "trackerLinkSecret"
      PACKPROOF_SMTP_USERNAME = "smtpUsername"
      PACKPROOF_SMTP_PASSWORD = "smtpPassword"
    }
    foreach ($name in $bindings.Keys) {
      $environment.Remove($name)
      $secrets[$name] = "${NotificationSecretArn}:$($bindings[$name])::"
    }
    $defaults = @{
      PACKPROOF_SMTP_HOST = "email-smtp.$Region.amazonaws.com"
      PACKPROOF_SMTP_PORT = "465"
      PACKPROOF_EMAIL_FROM = "notifications@thepackproof.com"
      PACKPROOF_SMTP_HELO = "thepackproof.com"
    }
    foreach ($name in $defaults.Keys) {
      if (-not $environment.ContainsKey($name) -and -not $secrets.ContainsKey($name)) {
        $environment[$name] = $defaults[$name]
      }
    }
  }
  $Desired.environment = @($environment.Keys | Sort-Object | ForEach-Object { @{ name = $_; value = $environment[$_] } })
  $Desired.secrets = @($secrets.Keys | Sort-Object | ForEach-Object { @{ name = $_; valueFrom = $secrets[$_] } })
  return $Desired
}

function Write-DeploymentDiagnostics {
  param([string]$ClusterName, [string]$ServiceName, [string]$Region)
  # Deliberately select status fields: never print container environment or secrets.
  try {
    $response = Invoke-AwsJson ecs describe-services --cluster $ClusterName --services $ServiceName --region $Region
    $service = $response.services[0]
    Write-Host ($service | Select-Object status, desiredCount, runningCount, pendingCount | ConvertTo-Json -Compress)
    Write-Host ($service.deployments | Select-Object id, status, rolloutState, rolloutStateReason, failedTasks | ConvertTo-Json -Depth 5)
    Write-Host ($service.events | Select-Object -First 10 createdAt, message | ConvertTo-Json -Depth 5)
    $stopped = Invoke-AwsJson ecs list-tasks --cluster $ClusterName --service-name $ServiceName --desired-status STOPPED --region $Region
    $arns = @($stopped.taskArns | Select-Object -First 10)
    if ($arns.Count -gt 0) {
      $tasks = Invoke-AwsJson ecs describe-tasks --cluster $ClusterName --tasks $arns --region $Region
      foreach ($task in $tasks.tasks) {
        Write-Host ($task | Select-Object taskArn, stopCode, stoppedReason | ConvertTo-Json -Compress)
        Write-Host ($task.containers | Select-Object name, image, exitCode, reason | ConvertTo-Json -Compress)
      }
    }
  } catch {
    Write-Warning "Could not retrieve all ECS diagnostics: $($_.Exception.Message)"
  }
}

function Wait-ExpressDeployment {
  param(
    [string]$ClusterName,
    [string]$ServiceName,
    [string]$ServiceArn,
    [string]$ExpectedImage,
    [string]$PreviousTaskDefinition = "",
    [string]$Region = "us-east-1",
    [int]$TimeoutSeconds = 1800
  )
  # Express canary/bake/drain periods can exceed the generic ten-minute ECS
  # waiter. Require the intended running image and completed deployment, with a
  # bounded thirty-minute budget and useful status output on each iteration.
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  try {
    while ([DateTime]::UtcNow -lt $deadline) {
      $express = Invoke-AwsJson ecs describe-express-gateway-service --service-arn $ServiceArn --region $Region
      $endpoint = $express.service.activeConfigurations[0].ingressPaths[0].endpoint
      $response = Invoke-AwsJson ecs describe-services --cluster $ClusterName --services $ServiceName --region $Region
      $service = $response.services[0]
      $primary = @($service.deployments | Where-Object status -eq "PRIMARY")[0]
      if ($primary.rolloutState -eq "FAILED") { throw "ECS rollout failed: $($primary.rolloutStateReason)" }
      $listed = Invoke-AwsJson ecs list-tasks --cluster $ClusterName --service-name $ServiceName --desired-status RUNNING --region $Region
      $arns = @($listed.taskArns | Where-Object { $_ })
      $tasks = @()
      if ($arns.Count -gt 0) {
        $described = Invoke-AwsJson ecs describe-tasks --cluster $ClusterName --tasks $arns --region $Region
        $tasks = @($described.tasks)
      }
      $wrong = @($tasks | Where-Object {
        $_.lastStatus -ne "RUNNING" -or $_.taskDefinitionArn -ne $primary.taskDefinition -or $_.containers[0].image -ne $ExpectedImage
      })
      $extra = @($service.deployments | Where-Object { $_.status -ne "PRIMARY" -and ($_.runningCount -gt 0 -or $_.pendingCount -gt 0) })
      Write-Host "Service desired=$($service.desiredCount) running=$($service.runningCount) pending=$($service.pendingCount) rollout=$($primary.rolloutState) mismatchedTasks=$($wrong.Count) oldDeployments=$($extra.Count)"
      if ($service.desiredCount -eq 0) {
        Invoke-Aws ecs update-service --cluster $ClusterName --service $ServiceName --desired-count 1 --region $Region | Out-Null
      }
      if (
        $endpoint -and $service.desiredCount -ge 1 -and
        $service.runningCount -eq $service.desiredCount -and $service.pendingCount -eq 0 -and
        $tasks.Count -eq $service.runningCount -and $wrong.Count -eq 0 -and $extra.Count -eq 0 -and
        $primary.rolloutState -eq "COMPLETED" -and
        (-not $PreviousTaskDefinition -or $primary.taskDefinition -ne $PreviousTaskDefinition)
      ) { return $endpoint }
      Start-Sleep -Seconds 15
    }
    throw "ECS did not complete deployment of $ExpectedImage within $TimeoutSeconds seconds"
  } catch {
    Write-DeploymentDiagnostics -ClusterName $ClusterName -ServiceName $ServiceName -Region $Region
    throw
  }
}
