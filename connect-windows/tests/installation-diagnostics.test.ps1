# Native CI validation only. The diagnostic itself remains safe to run on an
# affected user PC; these optional before/after hashes inspect synthetic CI data.
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if($env:OS -ne 'Windows_NT' -or $env:GITHUB_ACTIONS -ne 'true') { throw 'Run diagnostic qualification only on the native Windows CI runner.' }
$diagnostic=Join-Path (Split-Path $PSScriptRoot -Parent) 'scripts\diagnose-installation.ps1'
$windowsPowerShell=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($diagnostic,[ref]$tokens,[ref]$errors)
if($errors.Count) { throw 'The read-only installation diagnostic did not parse.' }
$forbidden=@('Set-Acl','Set-Item','Set-ItemProperty','New-Item','New-ItemProperty','Remove-Item','Remove-LocalUser','Set-LocalUser','Start-Service','Stop-Service','Restart-Service','Invoke-WebRequest','Invoke-RestMethod','Invoke-Expression')
foreach($command in $ast.FindAll({param($node) $node -is [Management.Automation.Language.CommandAst]},$true)) {
 if($command.GetCommandName() -in $forbidden) { throw 'The read-only diagnostic contains a modifying or network command.' }
}
$data=Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'PackProof\Connect\development'
$before=@{}
$service=Get-Service -Name PackProofConnectDevelopment -ErrorAction SilentlyContinue
$canCompare=$null -eq $service -or $service.Status -eq 'Stopped'
if($canCompare) {
 foreach($name in @('state.bin','spool-key.bin','queue.sqlite')) { $path=Join-Path $data $name;if(Test-Path -LiteralPath $path) { $before[$name]=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash } }
}
$json=(& $windowsPowerShell -NoProfile -NonInteractive -File $diagnostic -Channel development | Out-String)
if($LASTEXITCODE -ne 0) { throw 'The Windows PowerShell 5.1 read-only diagnostic failed.' }
if($json.Length -gt 131072) { throw 'The installation diagnostic exceeded its bounded output budget.' }
$report=$json|ConvertFrom-Json
if($report.schema -ne 'packproof.connect-installation-diagnostic/v1' -or $report.mode -ne 'read_only' -or $report.readiness.requested) { throw 'The diagnostic did not preserve its read-only contract.' }
if($report.host.powerShellVersion -notlike '5.1.*') { throw 'The diagnostic did not exercise Windows PowerShell 5.1.' }
if(-not $report.host.runtimeInformationAvailable -or $report.host.runtimeInformationArchitecture -ne 'X64') { throw 'Windows PowerShell 5.1 cannot evaluate the required x64 architecture operand.' }
# Compute the expected value inside the SAME Windows PowerShell engine, not the
# pwsh caller (their OS manifest/runtime behavior is independently reported).
$expected=(& $windowsPowerShell -NoProfile -NonInteractive -Command "[Environment]::OSVersion.Version.Build -ge 22000 -and [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq 'X64'").Trim()
if([string]$report.host.forcedClientBuildArchitectureExpression -ne $expected) { throw 'The otherwise short-circuited client host operands were not independently evaluated.' }
if($json -match '"(?:token|redeemSecret|samples|mapping|csv|configuration)"\s*:') { throw 'The installation report included an unapproved protected-content field.' }
foreach($name in $before.Keys) { if((Get-FileHash -LiteralPath (Join-Path $data $name) -Algorithm SHA256).Hash -ne $before[$name]) { throw 'Read-only diagnostics changed retained synthetic protected bytes.' } }
[ordered]@{schema='packproof.connect-installation-diagnostic-test/v1';result='passed';powerShell=$report.host.powerShellVersion;runtimeArchitecture=$report.host.runtimeInformationArchitecture;forcedClientExpression=$report.host.forcedClientBuildArchitectureExpression;actualProductType=$report.host.productType;protectedByteComparison=$canCompare;readinessRequested=$report.readiness.requested}|ConvertTo-Json
