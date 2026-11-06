$ErrorActionPreference = 'Stop'
$channel = if ($env:APP_ENV) { $env:APP_ENV } else { 'development' }
if ($channel -notin @('development','staging','production')) { throw 'Unknown Connect channel.' }
if (-not [OperatingSystem]::IsWindows()) { throw 'Native Connect publish requires Windows.' }
$root = Split-Path $PSScriptRoot -Parent
Push-Location $root
try {
  & dotnet publish service/PackProof.Connect.Service.csproj -c Release -r win-x64 --self-contained true -o native/service -p:ContinuousIntegrationBuild=true
  if ($LASTEXITCODE -ne 0) { throw 'Windows service publish failed.' }
  & dotnet publish bridge/PackProof.Connect.Bridge.csproj -c Release -r win-x64 --self-contained true -o native/bridge -p:ContinuousIntegrationBuild=true
  if ($LASTEXITCODE -ne 0) { throw 'Verified pipe bridge publish failed.' }
  $runtime = Get-Content -LiteralPath dist/main/runtime-config.json -Raw | ConvertFrom-Json
  if ($runtime.channel -ne $channel) { throw 'Build runtime before native publish using the same channel.' }
  @{ channel=$channel;publisher=$runtime.publisher } | ConvertTo-Json | Set-Content -LiteralPath native/bridge/bridge-config.json -Encoding utf8NoBOM
  $serviceEnvironment = if ($channel -eq 'production') { 'live' } else { $channel }
  @{ environment=$serviceEnvironment;apiOrigin=$runtime.apiBaseUrl;webOrigin=$runtime.webBaseUrl;operatorsSid='UNCONFIGURED' } | ConvertTo-Json | Set-Content -LiteralPath native/service/service-config.json -Encoding utf8NoBOM
  Copy-Item installer/lifecycle.ps1 native/lifecycle.ps1 -Force
} finally { Pop-Location }
