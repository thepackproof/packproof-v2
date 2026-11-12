$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if ($env:APP_ENV -ne 'development' -or $env:GITHUB_ACTIONS -ne 'true') { throw 'Destructive synthetic fixtures are restricted to isolated development CI.' }
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
. (Join-Path $install 'resources\installer\storage-health.ps1')
$evidence=[ordered]@{schemaVersion=1;sourceCommit=(& git -C $root rev-parse HEAD).Trim();scope='Packaged LocalService and PowerShell 5.1 repair on hosted Windows Server; not a Windows 11/UAC or customer canary';tests=@();windows11Acceptance='not_run';customerAcceptance='not_run'}
$held=$null
$keyBackup=Join-Path $install 'synthetic-key-backup.bin'
$sentinel=Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) ('pp-storage-sentinel-'+[Guid]::NewGuid().ToString('N')+'.bin')
$link=Join-Path $data 'spool\hardlink-fixture.bin'
function Record-Pass([string]$Name) { $evidence.tests+=@{name=$Name;result='passed'} }
function Install-Checked {
 & $windowsPowerShell -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File $lifecycle -Action Install -InstallRoot $install -OperatorSid $operatorSid -AllowUnsupportedDevelopmentHost
 if($LASTEXITCODE -ne 0) { throw 'The PowerShell 5.1 installer did not pass service readiness.' }
}
function Stop-Checked {
 if(Get-Service -Name $serviceName -ErrorAction SilentlyContinue) { Stop-Service -Name $serviceName -ErrorAction Stop; (Get-Service -Name $serviceName).WaitForStatus('Stopped',[TimeSpan]::FromSeconds(45)) }
}
function Start-Checked { Start-Service -Name $serviceName; (Get-Service -Name $serviceName).WaitForStatus('Running',[TimeSpan]::FromSeconds(30)) }
function Expect-Blocked([string]$Code) {
 $blocked=$false
 try { [void](Wait-ConnectReadiness $serviceName $pipeName $binary) }
 catch { if($_.Exception.Message -notlike ('*'+$Code+'*')) { throw };$blocked=$true }
 if(-not $blocked) { throw ('An unhealthy running service was incorrectly accepted: '+$Code) }
}
function Admin-Only([string]$Path,[bool]$Directory) {
 $acl=if($Directory) { New-Object Security.AccessControl.DirectorySecurity } else { New-Object Security.AccessControl.FileSecurity }
 $acl.SetAccessRuleProtection($true,$false);$acl.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))
 foreach($sid in @('S-1-5-18','S-1-5-32-544')) {
  $principal=New-Object Security.Principal.SecurityIdentifier($sid)
  $rule=if($Directory) { New-Object Security.AccessControl.FileSystemAccessRule($principal,'FullControl','ContainerInherit,ObjectInherit','None','Allow') } else { New-Object Security.AccessControl.FileSystemAccessRule($principal,'FullControl','Allow') }
  $acl.AddAccessRule($rule)
 }
 Set-Acl -LiteralPath $Path -AclObject $acl
}
try {
 if(-not (Test-Path -LiteralPath (Join-Path $data 'state.bin'))) { throw 'Run the foundation smoke first; its retained protected state is required.' }
 Install-Checked
 $ready=Wait-ConnectReadiness $serviceName $pipeName $binary
 if(-not $ready.ready -or $ready.dataReset -or $ready.checks.Count -lt 8) { throw 'The readiness report does not establish functional local storage.' }
 Record-Pass 'actual service attests DPAPI, retained key/state, write/replace/delete, SQLite integrity/writer lock and disk reserve'
 Stop-Checked
 $keyHash=(Get-FileHash -LiteralPath (Join-Path $data 'spool-key.bin')).Hash
 $stateHash=(Get-FileHash -LiteralPath (Join-Path $data 'state.bin')).Hash
 $orphan=Join-Path $data 'spool\retained-synthetic-orphan.bin'
 [IO.File]::WriteAllBytes($orphan,[Security.Cryptography.RandomNumberGenerator]::GetBytes(96))
 $orphanHash=(Get-FileHash -LiteralPath $orphan).Hash
 Admin-Only (Join-Path $data 'state.bin') $false
 Admin-Only (Join-Path $data 'spool') $true
 Start-Checked
 Expect-Blocked 'LOCAL_STORAGE_ACCESS_DENIED'
 Record-Pass 'Running LocalService with unreadable retained state is rejected instead of reported installed successfully'
 Stop-Checked
 Install-Checked
 if((Get-FileHash -LiteralPath (Join-Path $data 'spool-key.bin')).Hash -ne $keyHash -or (Get-FileHash -LiteralPath (Join-Path $data 'state.bin')).Hash -ne $stateHash -or (Get-FileHash -LiteralPath $orphan).Hash -ne $orphanHash) { throw 'Permission repair changed retained key, state or orphan bytes.' }
 Record-Pass 'repair fixes trusted descendant ACL drift while retaining key, state and orphan bytes'
 Stop-Checked
 $held=[IO.File]::Open((Join-Path $data 'state.bin'),[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
 Start-Checked
 Expect-Blocked 'LOCAL_STORAGE_BUSY'
 Record-Pass 'exclusive protected-state lock is classified and cannot pass readiness'
 Stop-Checked;$held.Dispose();$held=$null
 Install-Checked
 Record-Pass 'reinstall recovers after a transient external lock without resetting state'
 Stop-Checked
 Move-Item -LiteralPath (Join-Path $data 'spool-key.bin') -Destination $keyBackup
 Start-Checked
 Expect-Blocked 'SPOOL_KEY_MISSING'
 if(Test-Path -LiteralPath (Join-Path $data 'spool-key.bin')) { throw 'The service generated a new key over a retained queue.' }
 Record-Pass 'missing protected key with retained queue fails closed without key regeneration'
 Stop-Checked
 Move-Item -LiteralPath $keyBackup -Destination (Join-Path $data 'spool-key.bin')
 Install-Checked
 # Only local source selection is attempted; no enrollment, upload or commit.
 $request=@{version=1;id=[Guid]::NewGuid().ToString();operation='selectFolder';payload=@{folder=(Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) ('does-not-exist-'+[Guid]::NewGuid().ToString('N')))}}
 $reply=(($request|ConvertTo-Json -Compress -Depth 4)| & (Join-Path $install 'resources\bridge\PackProof.Connect.Bridge.exe'))|ConvertFrom-Json
 if($reply.ok -or $reply.error.code -notin @('SOURCE_NOT_FOUND','SOURCE_ACCESS_DENIED','SOURCE_READ_FAILED')) { throw 'A source-selection failure was confused with internal storage.' }
 [void](Wait-ConnectReadiness $serviceName $pipeName $binary)
 Record-Pass 'unavailable source folder reports a source-specific failure while internal readiness remains healthy'
 Stop-Checked
 [IO.File]::WriteAllBytes($sentinel,[Security.Cryptography.RandomNumberGenerator]::GetBytes(64))
 $sentinelHash=(Get-FileHash -LiteralPath $sentinel).Hash
 $sentinelAcl=(Get-Acl -LiteralPath $sentinel).Sddl
 New-Item -ItemType HardLink -Path $link -Target $sentinel | Out-Null
 & $windowsPowerShell -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File $lifecycle -Action Install -InstallRoot $install -OperatorSid $operatorSid -AllowUnsupportedDevelopmentHost
 if($LASTEXITCODE -eq 0) { throw 'Automatic repair followed a hard link outside its private storage.' }
 if((Get-FileHash -LiteralPath $sentinel).Hash -ne $sentinelHash -or (Get-Acl -LiteralPath $sentinel).Sddl -ne $sentinelAcl) { throw 'Repair changed the linked external fixture.' }
 Record-Pass 'hard-linked private entry blocks repair without modifying the external target'
 Remove-Item -LiteralPath $link;Remove-Item -LiteralPath $sentinel
 Install-Checked
 if((Get-FileHash -LiteralPath (Join-Path $data 'spool-key.bin')).Hash -ne $keyHash -or (Get-FileHash -LiteralPath (Join-Path $data 'state.bin')).Hash -ne $stateHash -or (Get-FileHash -LiteralPath $orphan).Hash -ne $orphanHash) { throw 'Recovery changed original protected bytes.' }
 Record-Pass 'all fault/recovery cycles preserve original key, state and retained orphan bytes'
 $evidence.result='passed'
} catch { $evidence.result='failed';$evidence.failureCategory='storage_repair';throw }
finally {
 if($null -ne $held) { $held.Dispose() }
 try { Stop-Checked } catch {}
 if(Test-Path -LiteralPath $keyBackup) { Move-Item -LiteralPath $keyBackup -Destination (Join-Path $data 'spool-key.bin') }
 if(Test-Path -LiteralPath $link) { Remove-Item -LiteralPath $link }
 if(Test-Path -LiteralPath $sentinel) { Remove-Item -LiteralPath $sentinel }
 if(Get-Service -Name $serviceName -ErrorAction SilentlyContinue) { & $lifecycle -Action Remove -InstallRoot $install }
 $evidence|ConvertTo-Json -Depth 8|Set-Content -LiteralPath (Join-Path $output 'storage-repair-smoke.json') -Encoding utf8NoBOM
}
