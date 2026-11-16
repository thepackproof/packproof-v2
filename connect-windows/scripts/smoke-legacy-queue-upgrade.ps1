$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if ($env:APP_ENV -ne 'development' -or $env:GITHUB_ACTIONS -ne 'true' -or -not [OperatingSystem]::IsWindows()) { throw 'This synthetic queue upgrade is restricted to Windows development CI.' }
$root=Split-Path $PSScriptRoot -Parent
$output=Join-Path $root 'release\development\win32-x64'
$install=Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'PackProof Connect Development'
$data=Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'PackProof\Connect\development'
$serviceName='PackProofConnectDevelopment'
$pipeName='PackProofConnect-development-v1'
$binary=Join-Path $install 'resources\service\PackProof.Connect.Service.exe'
$lifecycle=Join-Path $install 'resources\installer\lifecycle.ps1'
$operatorSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$windowsPowerShell=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$fixtureProject=Join-Path $root 'tests\QueueUpgradeFixture\QueueUpgradeFixture.csproj'
$fixtureDll=Join-Path $root 'tests\QueueUpgradeFixture\bin\Release\net10.0\QueueUpgradeFixture.dll'
$source=(& git -C $root rev-parse HEAD).Trim()
$evidence=[ordered]@{schemaVersion=1;sourceCommit=$source;writerCommit='e680cef33d86ffe6cf920c7a3740e3491872a32c';scope='Synthetic 0.2.0 legacy-only queue format on packaged LocalService and Windows PowerShell 5.1; not Windows 11/customer acceptance';tests=@();windows11Acceptance='not_run';customerAcceptance='not_run'}
function Record-Pass([string]$Name) { $evidence.tests+=@{name=$Name;result='passed'} }
function Stop-Checked {
 if (Get-Service -Name $serviceName -ErrorAction SilentlyContinue) {
  $registered=Get-CimInstance Win32_Service -Filter ("Name='"+$serviceName+"'")
  Stop-Service -Name $serviceName -ErrorAction Stop
  (Get-Service -Name $serviceName).WaitForStatus('Stopped',[TimeSpan]::FromSeconds(45))
  if ($registered.ProcessId -ne 0) {
   $process=Get-Process -Id $registered.ProcessId -ErrorAction SilentlyContinue
   if ($null -ne $process -and -not $process.WaitForExit(5000)) { throw 'CI_QUEUE_UPGRADE_SERVICE_BUSY: The stopped helper process has not released the queue.' }
  }
 }
}
function Install-Checked {
 & $windowsPowerShell -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File $lifecycle -Action Install -InstallRoot $install -OperatorSid $operatorSid -AllowUnsupportedDevelopmentHost
 if ($LASTEXITCODE -ne 0) { throw 'CI_QUEUE_UPGRADE_INSTALL_FAILED: The packaged helper did not pass the PowerShell 5.1 installation check.' }
 $ready=Wait-ConnectReadiness $serviceName $pipeName $binary
 if (-not $ready.ready -or $ready.dataReset) { throw 'CI_QUEUE_UPGRADE_NOT_READY: The installed helper did not attest preserved local storage.' }
}
function Invoke-Fixture([string]$Operation) {
 $wire=& dotnet $fixtureDll $Operation
 if ($LASTEXITCODE -ne 0) { throw 'CI_QUEUE_UPGRADE_FIXTURE_FAILED: The fixed-path fixture rejected its layout or preservation checks.' }
 $result=$wire|ConvertFrom-Json -ErrorAction Stop
 if ($result.schema -ne 'packproof.ci-legacy-queue-upgrade/v1' -or $result.writerCommit -ne $evidence.writerCommit -or $result.queueVersion -ne 2 -or -not $result.metadataPreserved) { throw 'CI_QUEUE_UPGRADE_RECEIPT_INVALID: The fixture did not return its bounded format-two receipt.' }
 return $result
}
function Retained-Snapshot {
 $snapshot=[ordered]@{}
 foreach ($name in @('state.bin','spool-key.bin')) {
  $path=Join-Path $data $name
  [PackProofStorageNative]::AssertOrdinary($path,$false)
  $snapshot[$name]=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
 }
 [PackProofStorageNative]::AssertOrdinary((Join-Path $data 'spool'),$true)
 foreach ($file in @(Get-ChildItem -LiteralPath (Join-Path $data 'spool') -Force | Sort-Object Name)) {
  if ($file.PSIsContainer) { throw 'CI_QUEUE_UPGRADE_LAYOUT_INVALID: The synthetic spool contains an unexpected directory.' }
  [PackProofStorageNative]::AssertOrdinary($file.FullName,$false)
  $snapshot['spool/'+$file.Name]=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
 }
 return ($snapshot|ConvertTo-Json -Compress)
}
function Assert-Preserved([string]$Before) {
 if ((Retained-Snapshot) -ne $Before) { throw 'CI_QUEUE_UPGRADE_PRESERVATION_FAILED: A protected state, key or retained spool byte changed.' }
}
try {
 $foundation=Get-Content -LiteralPath (Join-Path $output 'native-foundation-smoke.json') -Raw|ConvertFrom-Json
 if ($foundation.result -ne 'passed' -or $foundation.sourceCommit -ne $source -or $env:GITHUB_SHA -ne $source) { throw 'CI_QUEUE_UPGRADE_FOUNDATION_REQUIRED: Use the successful synthetic foundation from this exact CI source.' }
 . (Join-Path $install 'resources\installer\storage-health.ps1')
 Stop-Checked
 # A clearly synthetic unreferenced sentinel makes the spool preservation check
 # non-vacuous. It is not represented as uploaded or accepted shipment evidence.
 $sentinel=Join-Path $data 'spool\legacy-upgrade-synthetic-orphan.bin'
 if (Test-Path -LiteralPath $sentinel) { throw 'CI_QUEUE_UPGRADE_FIXTURE_EXISTS: Refusing to replace a retained sentinel.' }
 [IO.File]::WriteAllBytes($sentinel,[Security.Cryptography.RandomNumberGenerator]::GetBytes(64))
 $before=Retained-Snapshot
 & dotnet build $fixtureProject -c Release --nologo
 if ($LASTEXITCODE -ne 0) { throw 'CI_QUEUE_UPGRADE_BUILD_FAILED: The isolated fixture did not build.' }
 $upgraded=Invoke-Fixture upgrade
 Assert-Preserved $before
 Record-Pass 'literal 0.2.0 schema-one-to-two SQL preserves queue row identities and all state, key and retained spool bytes'
 Install-Checked
 $observed=Invoke-Fixture verify
 if ($observed.metadataSha256 -ne $upgraded.metadataSha256 -or $observed.rowCount -ne $upgraded.rowCount) { throw 'CI_QUEUE_UPGRADE_METADATA_CHANGED: The installed helper changed retained queue identities.' }
 Assert-Preserved $before
 Record-Pass 'packaged LocalService opens retained legacy-only format two and passes authenticated PowerShell 5.1 readiness'
 Stop-Checked
 Start-Service -Name $serviceName
 (Get-Service -Name $serviceName).WaitForStatus('Running',[TimeSpan]::FromSeconds(30))
 $ready=Wait-ConnectReadiness $serviceName $pipeName $binary
 if (-not $ready.ready -or $ready.dataReset) { throw 'CI_QUEUE_UPGRADE_RESTART_FAILED: The retained format-two queue did not survive restart.' }
 $restarted=Invoke-Fixture verify
 if ($restarted.metadataSha256 -ne $upgraded.metadataSha256) { throw 'CI_QUEUE_UPGRADE_METADATA_CHANGED: Restart changed retained queue identities.' }
 Assert-Preserved $before
 Record-Pass 'service restart retains format two, protected state, encryption key and synthetic orphan bytes'
 Install-Checked
 $reinstalled=Invoke-Fixture verify
 if ($reinstalled.metadataSha256 -ne $upgraded.metadataSha256) { throw 'CI_QUEUE_UPGRADE_METADATA_CHANGED: Reinstall changed retained queue identities.' }
 Assert-Preserved $before
 Record-Pass 'same-source reinstall preserves format two and all protected retained bytes without reset'
 $evidence.queueVersion=2;$evidence.queueRows=$upgraded.rowCount;$evidence.queueMetadataSha256=$upgraded.metadataSha256
 $evidence.retainedSnapshotSha256=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($before))).ToLowerInvariant()
 $evidence.result='passed'
} catch { $evidence.result='failed';$evidence.failureCategory='legacy_queue_upgrade';throw }
finally {
 try { Stop-Checked } catch {}
 $evidence|ConvertTo-Json -Depth 8|Set-Content -LiteralPath (Join-Path $output 'legacy-queue-upgrade-smoke.json') -Encoding utf8NoBOM
}
