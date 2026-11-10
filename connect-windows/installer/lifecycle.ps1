param([Parameter(Mandatory=$true)][ValidateSet('Install','Stop','Remove')][string]$Action,[Parameter(Mandatory=$true)][string]$InstallRoot,[string]$OperatorSid,[switch]$AllowUnsupportedDevelopmentHost)
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
$productType=(Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\ProductOptions').ProductType
$isSupportedHost=$productType -eq 'WinNT' -and [Environment]::OSVersion.Version.Build -ge 22000 -and [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq 'X64'
if ($AllowUnsupportedDevelopmentHost -and $channel -ne 'development') { throw 'Unsupported-host service smoke is development-only.' }
if (-not $isSupportedHost -and -not $AllowUnsupportedDevelopmentHost) { throw 'Windows 11 x64 is required. Windows Server needs separately qualified support.' }
Stop-Connect
$groupName='PackProof Connect '+$suffix+' Operators'
$group=Get-LocalGroup -Name $groupName -ErrorAction SilentlyContinue
if ($null -eq $group) { $group=New-LocalGroup -Name $groupName -Description 'PackProof Connect setup operators' }
$metadataRoot='HKLM:\SOFTWARE\PackProofConnect'
$metadataPath=Join-Path $metadataRoot $channel
function Assert-OperatorMetadataPermissions([string]$Path) {
 # Windows PowerShell 5.1's Get-Acl registry provider can resolve the PowerShell
 # drive path as a non-existent filesystem path. Read the exact 64-bit registry
 # view through its native handle on both PowerShell 5.1 and PowerShell 7.
 $machine=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine,[Microsoft.Win32.RegistryView]::Registry64)
 $key=$null
 try {
  $key=$machine.OpenSubKey($Path.Substring('HKLM:\'.Length),[Microsoft.Win32.RegistryKeyPermissionCheck]::ReadSubTree,[Security.AccessControl.RegistryRights]::ReadPermissions)
  if ($null -eq $key) { throw 'Protected operator metadata is missing. Repair the PackProof Connect installation.' }
  if ($null -ne $key.PSObject.Methods['GetAccessControl']) { $acl=$key.GetAccessControl() }
  else { $acl=[Microsoft.Win32.RegistryAclExtensions]::GetAccessControl($key) }
 } finally { if ($null -ne $key) { $key.Dispose() };$machine.Dispose() }
 $trusted=@('S-1-5-18','S-1-5-32-544')
 $writes=[Security.AccessControl.RegistryRights]::SetValue -bor [Security.AccessControl.RegistryRights]::CreateSubKey -bor [Security.AccessControl.RegistryRights]::Delete -bor [Security.AccessControl.RegistryRights]::ChangePermissions -bor [Security.AccessControl.RegistryRights]::TakeOwnership
 if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $trusted) { throw 'Connect operator metadata has an untrusted owner. Ask IT to repair the dedicated product registry permissions.' }
 foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
  if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and $rule.IdentityReference.Value -notin $trusted -and -not ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -and ($rule.RegistryRights -band $writes)) { throw 'Connect operator metadata allows non-administrator changes. Ask IT to repair the dedicated product registry permissions.' }
 }
}
function Initialize-OperatorMetadataKey([string]$Path) {
 if (-not (Test-Path -LiteralPath $Path)) {
  # Create only dedicated Connect metadata; never rewrite another product's key.
  New-Item -Path $Path -ErrorAction Stop | Out-Null
  $acl=New-Object Security.AccessControl.RegistrySecurity
  $acl.SetAccessRuleProtection($true,$false)
  $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))
  foreach ($sid in @('S-1-5-18','S-1-5-32-544')) { $acl.AddAccessRule((New-Object Security.AccessControl.RegistryAccessRule((New-Object Security.Principal.SecurityIdentifier($sid)),'FullControl','ContainerInherit','None','Allow'))) }
  $acl.AddAccessRule((New-Object Security.AccessControl.RegistryAccessRule((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-545')),'ReadKey','ContainerInherit','None','Allow')))
  # RegistrySecurity created in memory is not bound to a provider path. Apply
  # it through an explicitly opened native registry handle instead of Set-Acl.
  $machine=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine,[Microsoft.Win32.RegistryView]::Registry64)
  $key=$null
  try {
   $key=$machine.OpenSubKey($Path.Substring('HKLM:\'.Length),[Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree,[Security.AccessControl.RegistryRights]::FullControl)
   if ($null -eq $key) { throw 'The newly created Connect metadata key could not be opened for protected initialization.' }
   if ($null -ne $key.PSObject.Methods['SetAccessControl']) { $key.SetAccessControl($acl) }
   else { [Microsoft.Win32.RegistryAclExtensions]::SetAccessControl($key,$acl) }
   $key.Flush()
  } finally { if ($null -ne $key) { $key.Dispose() };$machine.Dispose() }
 }
 Assert-OperatorMetadataPermissions $Path
}
Initialize-OperatorMetadataKey $metadataRoot
Initialize-OperatorMetadataKey $metadataPath
$storedOperatorSid=(Get-Item -LiteralPath $metadataPath).GetValue('OperatorsSid')
# The interactive shell belongs to the original operator even when UAC uses another administrator account.
# With no interactive shell, an IT-installed service remains inaccessible until IT assigns an exact operator SID.
if (-not ('ConnectShellIdentity' -as [type])) {
Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;public static class ConnectShellIdentity{[DllImport("user32.dll")]public static extern IntPtr GetShellWindow();[DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);}
'@
}
$approvedOperatorSid=$null
if ($OperatorSid) {
 if ($OperatorSid -notmatch '^S-1-5-21-(?:[0-9]+-){3}[0-9]+$') { throw 'Choose an exact local or domain operator SID.' }
 $approvedOperatorSid=(New-Object Security.Principal.SecurityIdentifier($OperatorSid)).Value
 [void](New-Object Security.Principal.SecurityIdentifier($OperatorSid)).Translate([Security.Principal.NTAccount])
}
elseif ($null -ne $storedOperatorSid) {
 if ($storedOperatorSid -isnot [string] -or $storedOperatorSid -notmatch '^S-1-5-21-(?:[0-9]+-){3}[0-9]+$') { throw 'Saved local operator metadata is invalid. Ask IT to explicitly assign the approved operator SID; repair did not choose another account.' }
 $approvedOperatorSid=(New-Object Security.Principal.SecurityIdentifier($storedOperatorSid)).Value
}
[uint32]$shellPid=0
[void][ConnectShellIdentity]::GetWindowThreadProcessId([ConnectShellIdentity]::GetShellWindow(),[ref]$shellPid)
if (-not $approvedOperatorSid -and $shellPid -ne 0) { $shell=Get-CimInstance Win32_Process -Filter "ProcessId=$shellPid";if ($null -ne $shell) { $owner=Invoke-CimMethod -InputObject $shell -MethodName GetOwnerSid;if ($owner.ReturnValue -ne 0 -or $owner.Sid -notmatch '^S-1-5-21-') { throw 'The original operator identity could not be verified.' };$approvedOperatorSid=$owner.Sid;$member=Get-LocalGroupMember -Group $groupName | Where-Object { $_.SID.Value -eq $owner.Sid };if ($null -eq $member) { Add-LocalGroupMember -Group $groupName -Member $owner.Sid } } }
$serviceConfigPath=Join-Path $installPath 'resources\service\service-config.json'
$serviceConfig=Get-Content -LiteralPath $serviceConfigPath -Raw | ConvertFrom-Json
# An exact original-user SID works immediately; newly added group membership requires a new logon token.
$serviceConfig.operatorsSid=if ($approvedOperatorSid) { $approvedOperatorSid } else { $group.SID.Value }
# Windows PowerShell 5.1's -Encoding utf8 writes a BOM. System.Text.Json's UTF-8 byte parser
# rejects a BOM when the service reads service-config.json directly, preventing service startup.
# Write exactly UTF-8 without a BOM; do not change the existing queue or source configuration.
[IO.File]::WriteAllText($serviceConfigPath, ($serviceConfig | ConvertTo-Json -Depth 10), (New-Object System.Text.UTF8Encoding($false)))
$binary=Join-Path $installPath 'resources\service\PackProof.Connect.Service.exe'
if ($null -eq $service) { & "$env:SystemRoot\System32\sc.exe" create $serviceName binPath= ('"'+$binary+'"') obj= 'NT AUTHORITY\LocalService' start= auto DisplayName= ('PackProof Connect '+$suffix) | Out-Null;if ($LASTEXITCODE -ne 0) { throw 'Service creation failed.' } }
else { & "$env:SystemRoot\System32\sc.exe" config $serviceName binPath= ('"'+$binary+'"') obj= 'NT AUTHORITY\LocalService' start= auto | Out-Null;if ($LASTEXITCODE -ne 0) { throw 'Service configuration failed.' } }
# PowerShell 5.1 and 7 differ in how native-command quoting is transmitted to
# sc.exe. Use the SCM API to persist a single explicitly quoted image path.
# This is required even on repair, since older installations may have an
# unquoted service ImagePath. Do not change the service account or protected data.
if (-not ('PackProofConnectServiceImage' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class PackProofConnectServiceImage {
 [DllImport("advapi32.dll", EntryPoint="OpenSCManagerW", CharSet=CharSet.Unicode, SetLastError=true)]
 private static extern IntPtr OpenSCManager(string machine, string database, uint access);
 [DllImport("advapi32.dll", EntryPoint="OpenServiceW", CharSet=CharSet.Unicode, SetLastError=true)]
 private static extern IntPtr OpenService(IntPtr manager, string name, uint access);
 [DllImport("advapi32.dll", EntryPoint="ChangeServiceConfigW", CharSet=CharSet.Unicode, SetLastError=true)]
 [return: MarshalAs(UnmanagedType.Bool)]
 private static extern bool ChangeServiceConfig(IntPtr service, uint serviceType, uint startType, uint errorControl,
   string imagePath, string loadOrderGroup, IntPtr tagId, string dependencies, string startName, string password, string displayName);
 [DllImport("advapi32.dll", SetLastError=true)] [return: MarshalAs(UnmanagedType.Bool)]
 private static extern bool CloseServiceHandle(IntPtr handle);
 public static void Configure(string serviceName, string exactImagePath) {
   IntPtr manager=OpenSCManager(null,null,0x0001);
   if (manager==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "SCM could not be opened for Connect path repair.");
   try {
     IntPtr service=OpenService(manager,serviceName,0x0002);
     if (service==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Connect service configuration could not be opened.");
     try {
       const uint noChange=0xffffffff;
       if (!ChangeServiceConfig(service,noChange,noChange,noChange,exactImagePath,null,IntPtr.Zero,null,null,null,null))
         throw new Win32Exception(Marshal.GetLastWin32Error(), "Connect service executable path could not be registered.");
     } finally { CloseServiceHandle(service); }
   } finally { CloseServiceHandle(manager); }
 }
}
'@
}
$quotedServiceImage='"'+$binary+'"'
[PackProofConnectServiceImage]::Configure($serviceName,$quotedServiceImage)
& "$env:SystemRoot\System32\sc.exe" sidtype $serviceName unrestricted | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Service identity configuration failed.' }
$serviceSid=(New-Object Security.Principal.NTAccount('NT SERVICE\'+$serviceName)).Translate([Security.Principal.SecurityIdentifier])
$dataRoot=Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) ('PackProof\Connect\'+$serviceConfig.environment)
function Assert-NoReparseAncestors([string]$Path,[string]$Boundary) {
 $candidate=[IO.Path]::GetFullPath($Path).TrimEnd('\');$base=[IO.Path]::GetFullPath($Boundary).TrimEnd('\')
 if (-not $candidate.StartsWith($base+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Protected storage must remain beneath ProgramData.' }
 while ($candidate.Length -gt $base.Length) { if ((Test-Path -LiteralPath $candidate) -and ((Get-Item -LiteralPath $candidate -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Protected storage ancestors must not be reparse points.' };$candidate=Split-Path $candidate -Parent }
}
function Assert-ProtectedAncestry([string]$Path,[string]$Boundary) {
 # A protected leaf can still be moved/replaced through an attacker-controlled
 # ancestor. Validate shared parents rather than changing Desktop or IT ACLs.
 $base=[IO.Path]::GetFullPath($Boundary).TrimEnd('\')
 $ancestor=Split-Path ([IO.Path]::GetFullPath($Path).TrimEnd('\')) -Parent
 $trusted=@('S-1-5-18','S-1-5-32-544')
 $dangerous=[Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
 while ($ancestor.Length -ge $base.Length) {
  if (Test-Path -LiteralPath $ancestor) {
   $entry=Get-Item -LiteralPath $ancestor -Force
   if (-not $entry.PSIsContainer -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Protected storage ancestry must contain ordinary local directories. Ask IT to repair the dedicated Connect path.' }
   $acl=Get-Acl -LiteralPath $ancestor
   if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $trusted) { throw 'A shared storage ancestor has an untrusted owner. Ask IT to assign SYSTEM or Administrators ownership and remove ordinary-user replacement rights; PackProof did not change shared parent ACLs.' }
   foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and $rule.IdentityReference.Value -notin $trusted -and -not ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -and ($rule.FileSystemRights -band $dangerous)) { throw 'A shared storage ancestor permits ordinary-user deletion, replacement or permission changes. Ask IT to remove those parent rights; existing Desktop and source ACLs were preserved.' }
   }
  }
  if ($ancestor.Equals($base,[StringComparison]::OrdinalIgnoreCase)) { return }
  $ancestor=Split-Path $ancestor -Parent
 }
 throw 'Protected storage ancestry left its ProgramData boundary.'
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
Assert-ProtectedAncestry $dataRoot ([Environment]::GetFolderPath('CommonApplicationData'))
New-Item -Path $dataRoot -ItemType Directory -Force | Out-Null
Set-DirectoryPermissions $dataRoot @(@('S-1-5-18','FullControl'),@('S-1-5-32-544','FullControl'),@($serviceSid.Value,'Modify'))
Assert-ProtectedAncestry $dataRoot ([Environment]::GetFolderPath('CommonApplicationData'))
# A dedicated prepared export folder is the only producer directory whose ACL this installer changes.
$exports=Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) ('PackProof\Exports\'+$serviceConfig.environment)
Assert-NoReparseAncestors $exports ([Environment]::GetFolderPath('CommonApplicationData'))
Assert-ProtectedAncestry $exports ([Environment]::GetFolderPath('CommonApplicationData'))
if (-not (Test-Path -LiteralPath $exports)) {
 New-Item -Path $exports -ItemType Directory -Force | Out-Null
 $exportRules=@(@('S-1-5-18','FullControl'),@('S-1-5-32-544','FullControl'),@($serviceSid.Value,'ReadAndExecute'),@($group.SID.Value,'Modify'))
 if ($approvedOperatorSid) { $exportRules+=,@($approvedOperatorSid,'Modify') }
 Set-DirectoryPermissions $exports $exportRules
}
Assert-ProtectedAncestry $exports ([Environment]::GetFolderPath('CommonApplicationData'))
Assert-OperatorMetadataPermissions $metadataRoot
Assert-OperatorMetadataPermissions $metadataPath
New-ItemProperty -LiteralPath $metadataPath -Name OperatorsSid -PropertyType String -Value $serviceConfig.operatorsSid -Force | Out-Null
Start-Service -Name $serviceName
(Get-Service -Name $serviceName).WaitForStatus('Running',[TimeSpan]::FromSeconds(30))
