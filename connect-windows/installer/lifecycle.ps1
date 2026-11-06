param([Parameter(Mandatory=$true)][ValidateSet('Install','Stop','Remove')][string]$Action,[Parameter(Mandatory=$true)][string]$InstallRoot)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$installPath=[IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
$programFiles=[IO.Path]::GetFullPath([Environment]::GetFolderPath('ProgramFiles')).TrimEnd('\')
if (-not $installPath.StartsWith($programFiles+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Connect must be installed beneath Program Files.' }
$cursor=$installPath
while ($cursor.Length -gt $programFiles.Length) { if ((Test-Path -LiteralPath $cursor) -and ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Reparse point installation locations are unsupported.' };$cursor=Split-Path $cursor -Parent }
$bridgeConfig=Get-Content -LiteralPath (Join-Path $installPath 'resources\bridge\bridge-config.json') -Raw | ConvertFrom-Json
$channel=$bridgeConfig.channel
if ($channel -notin @('development','staging','production')) { throw 'Unknown Connect environment.' }
$suffix=$channel.Substring(0,1).ToUpperInvariant()+$channel.Substring(1)
$serviceName='PackProofConnect'+$suffix
$service=Get-Service -Name $serviceName -ErrorAction SilentlyContinue
function Stop-Connect {
 if ($null -ne $service -and $service.Status -ne 'Stopped') {
  # SCM stop is graceful; the worker closes/checkpoints its durable queue before exit.
  Stop-Service -Name $serviceName -ErrorAction Stop
  (Get-Service -Name $serviceName).WaitForStatus('Stopped',[TimeSpan]::FromSeconds(45))
 }
}
if ($Action -eq 'Stop') { Stop-Connect;exit 0 }
if ($Action -eq 'Remove') { Stop-Connect;if ($null -ne $service) { & "$env:SystemRoot\System32\sc.exe" delete $serviceName | Out-Null;if ($LASTEXITCODE -ne 0) { throw 'Service removal failed. Data was preserved.' } };exit 0 }
if (-not ([Environment]::OSVersion.Version.Build -ge 22000) -or -not [Environment]::Is64BitOperatingSystem) { throw 'Windows 11 x64 is required.' }
Stop-Connect
$groupName='PackProof Connect '+$suffix+' Operators'
$group=Get-LocalGroup -Name $groupName -ErrorAction SilentlyContinue
if ($null -eq $group) { $group=New-LocalGroup -Name $groupName -Description 'Approved local users of the PackProof Connect setup application. Cloud administrator approval is separately required.' }
# The interactive shell belongs to the original operator even when UAC uses another administrator account.
# With no interactive shell, an IT-installed service remains inaccessible until IT assigns an exact operator SID.
Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;public static class ConnectShellIdentity{[DllImport("user32.dll")]public static extern IntPtr GetShellWindow();[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);}
'@
[uint32]$shellPid=0
[void][ConnectShellIdentity]::GetWindowThreadProcessId([ConnectShellIdentity]::GetShellWindow(),[ref]$shellPid)
if ($shellPid -ne 0) { $shell=Get-CimInstance Win32_Process -Filter "ProcessId=$shellPid";if ($null -ne $shell) { $owner=Invoke-CimMethod -InputObject $shell -MethodName GetOwnerSid;if ($owner.ReturnValue -ne 0 -or $owner.Sid -notmatch '^S-1-5-21-') { throw 'The original operator identity could not be verified.' };$member=Get-LocalGroupMember -Group $groupName | Where-Object { $_.SID.Value -eq $owner.Sid };if ($null -eq $member) { Add-LocalGroupMember -Group $groupName -Member $owner.Sid } } }
$serviceConfigPath=Join-Path $installPath 'resources\service\service-config.json'
$serviceConfig=Get-Content -LiteralPath $serviceConfigPath -Raw | ConvertFrom-Json
$serviceConfig.operatorsSid=$group.SID.Value
$serviceConfig | ConvertTo-Json | Set-Content -LiteralPath $serviceConfigPath -Encoding utf8
$binary=Join-Path $installPath 'resources\service\PackProof.Connect.Service.exe'
if ($null -eq $service) { & "$env:SystemRoot\System32\sc.exe" create $serviceName binPath= ('"'+$binary+'"') obj= 'NT AUTHORITY\LocalService' start= auto DisplayName= ('PackProof Connect '+$suffix) | Out-Null;if ($LASTEXITCODE -ne 0) { throw 'Service creation failed.' } }
else { & "$env:SystemRoot\System32\sc.exe" config $serviceName binPath= ('"'+$binary+'"') obj= 'NT AUTHORITY\LocalService' start= auto | Out-Null;if ($LASTEXITCODE -ne 0) { throw 'Service configuration failed.' } }
& "$env:SystemRoot\System32\sc.exe" sidtype $serviceName unrestricted | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Service identity configuration failed.' }
$serviceSid=(New-Object Security.Principal.NTAccount('NT SERVICE\'+$serviceName)).Translate([Security.Principal.SecurityIdentifier])
$dataRoot=Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) ('PackProof\Connect\'+$serviceConfig.environment)
function Assert-NoReparseAncestors([string]$Path,[string]$Boundary) {
 $candidate=[IO.Path]::GetFullPath($Path).TrimEnd('\');$base=[IO.Path]::GetFullPath($Boundary).TrimEnd('\')
 if (-not $candidate.StartsWith($base+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Protected storage must remain beneath ProgramData.' }
 while ($candidate.Length -gt $base.Length) { if ((Test-Path -LiteralPath $candidate) -and ((Get-Item -LiteralPath $candidate -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Protected storage ancestors must not be reparse points.' };$candidate=Split-Path $candidate -Parent }
}
function Set-DirectoryPermissions([string]$Path,[array]$Rules) {
 if ((Get-Item -LiteralPath $Path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Protected directories must not be reparse points.' }
 $acl=New-Object Security.AccessControl.DirectorySecurity
 $acl.SetAccessRuleProtection($true,$false)
 $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))
 foreach ($rule in $Rules) { $sid=New-Object Security.Principal.SecurityIdentifier($rule[0]);$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,$rule[1],'ContainerInherit,ObjectInherit','None','Allow'))) }
 Set-Acl -LiteralPath $Path -AclObject $acl
}
Assert-NoReparseAncestors $dataRoot ([Environment]::GetFolderPath('CommonApplicationData'))
New-Item -Path $dataRoot -ItemType Directory -Force | Out-Null
Set-DirectoryPermissions $dataRoot @(@('S-1-5-18','FullControl'),@('S-1-5-32-544','FullControl'),@($serviceSid.Value,'Modify'))
# A dedicated prepared export folder is the only producer directory whose ACL this installer changes.
$exports=Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) ('PackProof\Exports\'+$serviceConfig.environment)
Assert-NoReparseAncestors $exports ([Environment]::GetFolderPath('CommonApplicationData'))
if (-not (Test-Path -LiteralPath $exports)) { New-Item -Path $exports -ItemType Directory -Force | Out-Null;Set-DirectoryPermissions $exports @(@('S-1-5-18','FullControl'),@('S-1-5-32-544','FullControl'),@($serviceSid.Value,'ReadAndExecute'),@($group.SID.Value,'Modify')) }
Start-Service -Name $serviceName
(Get-Service -Name $serviceName).WaitForStatus('Running',[TimeSpan]::FromSeconds(30))
