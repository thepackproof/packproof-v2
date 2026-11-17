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
# Exercise the exact header reader against an isolated synthetic TEMP file.
# No SQLite engine is loaded and no real queue header is changed by this test.
$headerFunction=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Read-ConnectQueueHeader'},$true)
if($null -eq $headerFunction) { throw 'The bounded header reader is missing.' }
. ([scriptblock]::Create($headerFunction.Extent.Text))
$fixtureRoot=Join-Path ([IO.Path]::GetTempPath()) ('packproof-header-diagnostic-'+[Guid]::NewGuid().ToString('N'))
$fixturePath=Join-Path $fixtureRoot 'synthetic.sqlite'
try {
 [void][IO.Directory]::CreateDirectory($fixtureRoot)
 $bytes=New-Object byte[] 196
 [Array]::Copy([Text.Encoding]::ASCII.GetBytes("SQLite format 3`0"),0,$bytes,0,16)
 $bytes[63]=2;$bytes[68]=128;$bytes[71]=1
 [IO.File]::WriteAllBytes($fixturePath,$bytes)
 $beforeFixture=(Get-FileHash -LiteralPath $fixturePath -Algorithm SHA256).Hash
 $header=Read-ConnectQueueHeader $fixturePath
 if($header.HeaderSchemaVersion -ne 2 -or $header.ApplicationId -ne -2147483647 -or $header.BytesRead -ne 100) { throw 'The SQLite header fields were not read as signed big-endian integers.' }
 if((Get-FileHash -LiteralPath $fixturePath -Algorithm SHA256).Hash -ne $beforeFixture) { throw 'The header reader changed its synthetic file.' }
 $bytes[60]=255;$bytes[61]=255;$bytes[62]=255;$bytes[63]=255
 [IO.File]::WriteAllBytes($fixturePath,$bytes)
 if((Read-ConnectQueueHeader $fixturePath).HeaderSchemaVersion -ne -1) { throw 'Signed negative user_version was not preserved.' }
 $bytes[0]=0;[IO.File]::WriteAllBytes($fixturePath,$bytes)
 $rejected=$false;try { Read-ConnectQueueHeader $fixturePath|Out-Null } catch { $rejected=$_.Exception.Message.Contains('QUEUE_HEADER_SIGNATURE_INVALID') }
 if(-not $rejected) { throw 'The queue header reader accepted an invalid SQLite signature.' }
 [IO.File]::WriteAllBytes($fixturePath,(New-Object byte[] 99))
 $rejected=$false;try { Read-ConnectQueueHeader $fixturePath|Out-Null } catch { $rejected=$_.Exception.Message.Contains('QUEUE_HEADER_TRUNCATED') }
 if(-not $rejected) { throw 'The queue header reader accepted a truncated header.' }
 $target=Join-Path $fixtureRoot 'target';$junction=Join-Path $fixtureRoot 'linked'
 [void][IO.Directory]::CreateDirectory($target);[IO.File]::WriteAllBytes((Join-Path $target 'synthetic.sqlite'),$bytes)
 & "$env:SystemRoot\System32\cmd.exe" /d /c "mklink /J `"$junction`" `"$target`"" | Out-Null
 if($LASTEXITCODE -ne 0) { throw 'The isolated reparse-point fixture could not be created.' }
 try {
  $rejected=$false;try { Read-ConnectQueueHeader (Join-Path $junction 'synthetic.sqlite')|Out-Null } catch { $rejected=$_.Exception.Message.Contains('QUEUE_HEADER_REPARSE_REFUSED') }
  if(-not $rejected) { throw 'The queue header reader followed a reparse-point ancestor.' }
 } finally { [IO.Directory]::Delete($junction) }
} finally { if([IO.Directory]::Exists($fixtureRoot)) { [IO.Directory]::Delete($fixtureRoot,$true) } }
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
[ordered]@{schema='packproof.connect-installation-diagnostic-test/v1';result='passed';powerShell=$report.host.powerShellVersion;runtimeArchitecture=$report.host.runtimeInformationArchitecture;forcedClientExpression=$report.host.forcedClientBuildArchitectureExpression;actualProductType=$report.host.productType;protectedByteComparison=$canCompare;readinessRequested=$report.readiness.requested;syntheticHeaderCheck='passed'}|ConvertTo-Json
