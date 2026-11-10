$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if ($env:APP_ENV -ne 'development' -or $env:GITHUB_ACTIONS -ne 'true') { throw 'This internal foundation smoke is restricted to development CI.' }
$root=Split-Path $PSScriptRoot -Parent
$output=Join-Path $root 'release\development\win32-x64'
$unpacked=Join-Path $output 'win-unpacked'
$install=Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'PackProof Connect Development'
$serviceName='PackProofConnectDevelopment'
$data=Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'PackProof\Connect\development'
$exports=Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'PackProof\Exports\development'
$operatorSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$evidence=[ordered]@{schemaVersion=1;sourceCommit=(& git -C $root rev-parse HEAD).Trim();scope='Native service foundation on the hosted Windows Server runner; not Windows 11/customer/installer acceptance';osBuild=[Environment]::OSVersion.Version.ToString();tests=@();windows11Acceptance='not_run';installerAcceptance='not_run';remotePipeClient='not_run';customerAcceptance='not_run'}
$pipeName='PackProofConnect-development-v1'
$disposableUser=$null
$operatorTemporarilyChanged=$false
$plainProbePassword=$null
function Record-Pass([string]$Name) { $evidence.tests+=@{name=$Name;result='passed'} }
function Invoke-Bridge([string]$Operation,[object]$Payload=$null) {
 $request=@{version=1;id=[Guid]::NewGuid().ToString();operation=$Operation}
 if ($null -ne $Payload) { $request.payload=$Payload }
 $response=($request|ConvertTo-Json -Compress -Depth 8)| & (Join-Path $install 'resources\bridge\PackProof.Connect.Bridge.exe')
 $exitCode=$LASTEXITCODE
 $reply=$null
 try { $reply=$response|ConvertFrom-Json -ErrorAction Stop } catch { throw 'Native verified bridge returned a malformed bounded response.' }
 if ($exitCode -ne 0 -or -not $reply.ok) {
  $safeCode=([string]$reply.error.code -replace '[^A-Z0-9_]', '')
  if ([string]::IsNullOrEmpty($safeCode) -or $safeCode.Length -gt 64) { $safeCode='UNKNOWN_BRIDGE_FAILURE' }
  throw ('Native verified bridge refused trusted service: '+$safeCode)
 }
 if ($reply.id -ne $request.id -or $reply.version -ne 1) { throw 'The installed pipe protocol did not return the expected receipt.' }
 return $reply.result
}
function Run-Lifecycle([string]$Action,[switch]$KeepApprovedOperator) {
 $parameters=@{Action=$Action;InstallRoot=$install;AllowUnsupportedDevelopmentHost=$true}
 if (-not $KeepApprovedOperator) { $parameters.OperatorSid=$operatorSid }
 & (Join-Path $install 'resources\installer\lifecycle.ps1') @parameters
}
try {
 Add-Type -Path (Join-Path $root 'tests\native-security-probes.cs')
 if (Test-Path -LiteralPath $install) { throw 'The isolated Connect foundation smoke directory already exists.' }
 New-Item -Path $install -ItemType Directory | Out-Null
 Copy-Item -Path (Join-Path $unpacked '*') -Destination $install -Recurse -Force
 Run-Lifecycle Install
 $service=Get-CimInstance Win32_Service -Filter "Name='$serviceName'"
 if ($service.StartName -ne 'NT AUTHORITY\LocalService' -or $service.State -ne 'Running') { throw 'The installed collector is not running as LocalService.' }
 Record-Pass 'service starts under LocalService independently of Electron'
  # NSIS uses Windows PowerShell 5.1, not pwsh. Exercise that exact engine.
  $windowsPowerShell=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  if (-not (Test-Path -LiteralPath $windowsPowerShell)) { throw 'Windows PowerShell 5.1 is unavailable for installer regression.' }
  & $windowsPowerShell -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File (Join-Path $install 'resources\installer\lifecycle.ps1') -Action Install -InstallRoot $install -OperatorSid $operatorSid -AllowUnsupportedDevelopmentHost
  if ($LASTEXITCODE -ne 0) { throw 'Windows PowerShell 5.1 service lifecycle install failed.' }
  $configBytes=[IO.File]::ReadAllBytes((Join-Path $install 'resources\service\service-config.json'))
  if ($configBytes.Length -ge 3 -and $configBytes[0] -eq 239 -and $configBytes[1] -eq 187 -and $configBytes[2] -eq 191) { throw 'Installed service config has a UTF-8 BOM.' }
  if (-not (Invoke-Bridge status).health.serviceOnline) { throw 'PowerShell 5.1 service install did not produce a trusted, reachable helper.' }
  Record-Pass 'NSIS PowerShell 5.1 service installation produces BOM-free, reachable helper'

 $status=Invoke-Bridge status
 if (-not $status.health.serviceOnline -or ($status.PSObject.Properties.Name -contains 'installationId' -and $status.installationId)) { throw 'The fresh service must be online without an enrolled grant.' }
 Record-Pass 'verified expected-service peer bridge returns bounded setup-only state'
 $preflight=Invoke-Bridge preflight
 foreach ($checkId in @('identity','storage','disk')) { if (@($preflight.checks | Where-Object { $_.id -eq $checkId -and $_.state -eq 'passed' }).Count -ne 1) { throw ('Native service preflight failed: '+$checkId) } }
 Record-Pass 'actual LocalService identity DPAPI round trip and disk reserve'
 $temporary=Join-Path $exports 'setup.tmp'
 [IO.File]::WriteAllText($temporary,"Reference,Description,Quantity`r`n000123,CI synthetic shipment,1`r`n",[Text.UTF8Encoding]::new($false))
 Move-Item -LiteralPath $temporary -Destination (Join-Path $exports 'setup.csv')
 $selected=Invoke-Bridge selectFolder @{folder=$exports}
 if (-not $selected.source.accessible) { throw 'The actual service identity cannot access its prepared export folder.' }
 $preview=Invoke-Bridge localPreview @{fileName='setup.csv'}
 if ($preview.source.samples[0].Reference -ne '000123' -or ($preview.PSObject.Properties.Name -contains 'preview' -and $preview.preview)) { throw 'Local preview must preserve identifiers and must not upload a cloud original.' }
 Record-Pass 'actual service read-only immutable CSV local preview preserves leading zeros'
 $stateHash=(Get-FileHash -LiteralPath (Join-Path $data 'state.bin') -Algorithm SHA256).Hash
 Run-Lifecycle Stop
 Start-Service -Name $serviceName
 (Get-Service -Name $serviceName).WaitForStatus('Running',[TimeSpan]::FromSeconds(30))
 $restarted=Invoke-Bridge status
 if (-not $restarted.source.accessible -or $restarted.source.selectedFileName -ne 'setup.csv') { throw 'The restarted service did not recover the protected setup state.' }
 if ((Get-FileHash -LiteralPath (Join-Path $data 'state.bin') -Algorithm SHA256).Hash -ne $stateHash) { throw 'Restart unexpectedly replaced the protected setup state.' }
 Record-Pass 'service restart recovers identity-protected configuration without an interactive UI'
 Run-Lifecycle Install -KeepApprovedOperator
 $repaired=Invoke-Bridge status
 if ($repaired.source.selectedFileName -ne 'setup.csv') { throw 'Repair reset the protected setup state.' }
 $repairedConfig=Get-Content -LiteralPath (Join-Path $install 'resources\service\service-config.json') -Raw | ConvertFrom-Json
 if ($repairedConfig.operatorsSid -ne $operatorSid -or (Get-Item -LiteralPath 'HKLM:\SOFTWARE\PackProofConnect\development').GetValue('OperatorsSid') -ne $operatorSid) { throw 'Repair replaced the originally approved local operator.' }
 Record-Pass 'same-source service repair preserves protected state'
 Record-Pass 'repair without an override preserves the approved operator SID'
 # These are real Windows token/ACL checks against the running packaged service.
 # Passwords stay in this process and are never written to a script, log or bundle.
 $probeName='ppconnect'+[Guid]::NewGuid().ToString('N').Substring(0,10)
 $plainProbePassword='Aa1!'+[Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(24))
 $secureProbePassword=ConvertTo-SecureString $plainProbePassword -AsPlainText -Force
 try { $disposableUser=New-LocalUser -Name $probeName -Password $secureProbePassword -Description 'Isolated Connect CI access probe' -AccountNeverExpires -PasswordNeverExpires }
 finally { $secureProbePassword.Dispose() }
 $usersGroup=Get-LocalGroup -SID ([Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'))
 if (-not (Get-LocalGroupMember -Group $usersGroup.Name | Where-Object { $_.SID.Value -eq $disposableUser.SID.Value })) { Add-LocalGroupMember -Group $usersGroup.Name -Member $disposableUser }
 $denied=[ConnectNativeSecurityProbe]::CheckIdentity($probeName,$plainProbePassword,2,$disposableUser.SID.Value,$pipeName,(Join-Path $data 'state.bin'))
 if ($denied.PipeAccess -ne 'denied' -or $denied.ProtectedFileAccess -ne 'denied') { throw 'An unapproved standard user reached the service pipe or protected state.' }
 [void](Invoke-Bridge status)
 Record-Pass 'unapproved standard-user token denied pipe access and protected state bytes'
 $operatorTemporarilyChanged=$true
 try {
  & (Join-Path $install 'resources\installer\lifecycle.ps1') -Action Install -InstallRoot $install -OperatorSid $disposableUser.SID.Value -AllowUnsupportedDevelopmentHost
  $approved=[ConnectNativeSecurityProbe]::CheckIdentity($probeName,$plainProbePassword,2,$disposableUser.SID.Value,$pipeName,(Join-Path $data 'state.bin'))
  if ($approved.PipeAccess -ne 'allowed_status' -or $approved.ProtectedFileAccess -ne 'denied') { throw 'The explicitly approved standard user did not receive bounded status while protected files remained denied.' }
  Record-Pass 'explicitly approved standard user reads bounded service status without direct protected-file access'
  # Exercise the packaged bridge under the disposable non-admin account.
  [ConnectNativeSecurityProbe]::AssertVerifiedBridgeAsStandardUser($probeName,$plainProbePassword,(Join-Path $install 'resources\bridge\PackProof.Connect.Bridge.exe'))
  Record-Pass 'packaged bridge authenticates service under real non-administrator Windows logon'
  $network=[ConnectNativeSecurityProbe]::CheckIdentity($probeName,$plainProbePassword,3,$disposableUser.SID.Value,$pipeName,(Join-Path $data 'state.bin'))
  if (-not $network.IsNetworkLogon -or $network.PipeAccess -ne 'denied' -or $network.ProtectedFileAccess -ne 'denied') { throw 'The approved identity network-logon token was not denied by the local pipe policy.' }
  $evidence.networkTokenPolicy='passed; actual remote-machine transport not exercised'
  Record-Pass 'NETWORK token is denied even when the same standard identity is approved interactively'
 } finally { Run-Lifecycle Install; $operatorTemporarilyChanged=$false }
 [void](Invoke-Bridge status)
 Remove-LocalUser -SID $disposableUser.SID
 $disposableUser=$null
 $plainProbePassword=$null
 # SCM must be stopped and its old process gone before the counterfeit fixture
 # can own the name. The fake must accept the actual helper and receive zero bytes.
 $oldServicePid=(Get-CimInstance Win32_Service -Filter "Name='$serviceName'").ProcessId
 Run-Lifecycle Stop
 $oldProcess=Get-Process -Id $oldServicePid -ErrorAction SilentlyContinue
 if ($null -ne $oldProcess -and -not $oldProcess.WaitForExit(5000)) { throw 'The stopped service process did not exit before peer-impersonation testing.' }
 [ConnectNativeSecurityProbe]::AssertCounterfeitPeerRejected($pipeName,(Join-Path $install 'resources\bridge\PackProof.Connect.Bridge.exe'))
 Record-Pass 'counterfeit pipe with stopped registered service receives zero helper request bytes'
 Start-Service -Name $serviceName
 (Get-Service -Name $serviceName).WaitForStatus('Running',[TimeSpan]::FromSeconds(30))
 [void](Invoke-Bridge status)
 # Record an observed idle interval, not a reference-PC budget or percentile claim.
 $process=Get-Process -Id ((Get-CimInstance Win32_Service -Filter "Name='$serviceName'").ProcessId)
 $cpuBefore=$process.TotalProcessorTime.TotalMilliseconds
 $watch=[Diagnostics.Stopwatch]::StartNew()
 Start-Sleep -Seconds 6
 $process.Refresh(); $watch.Stop()
 $evidence.idleObservation=@{elapsedSeconds=$watch.Elapsed.TotalSeconds;logicalProcessors=[Environment]::ProcessorCount;workingSetBytes=$process.WorkingSet64;processorMilliseconds=$process.TotalProcessorTime.TotalMilliseconds-$cpuBefore;normalizedCpuPercent=100*($process.TotalProcessorTime.TotalMilliseconds-$cpuBefore)/$watch.Elapsed.TotalMilliseconds/[Environment]::ProcessorCount;scope='Single service-idle observation on hosted Windows Server; no load or reference-PC qualification'}
 [void](Invoke-Bridge status)
 Record-Pass 'captured bounded real service idle memory and normalized CPU observation'
 Run-Lifecycle Remove
 if (-not (Test-Path -LiteralPath (Join-Path $data 'state.bin')) -or -not (Test-Path -LiteralPath (Join-Path $data 'spool-key.bin')) -or -not (Test-Path -LiteralPath (Join-Path $exports 'setup.csv'))) { throw 'Removal discarded protected state, encryption key or source export.' }
 Record-Pass 'service removal preserves encrypted data keys and source original'
 $evidence.result='passed'
} catch { $evidence.result='failed';$evidence.failureCategory='native_foundation';throw }
finally {
 if ($operatorTemporarilyChanged -and (Test-Path -LiteralPath $install)) { try { Run-Lifecycle Install } catch {} }
 if ($null -ne $disposableUser) { try { Remove-LocalUser -SID $disposableUser.SID } catch {} }
 $plainProbePassword=$null
 if (Get-Service -Name $serviceName -ErrorAction SilentlyContinue) { try { Run-Lifecycle Remove } catch {} }
 $evidence|ConvertTo-Json -Depth 8|Set-Content -LiteralPath (Join-Path $output 'native-foundation-smoke.json') -Encoding utf8NoBOM
}
