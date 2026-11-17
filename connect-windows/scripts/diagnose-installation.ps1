# Read-only Windows PowerShell 5.1 diagnostics. No lifecycle, repair, network,
# enrollment, permission, credential, customer-row or key operations.
# The queue inspection reads only its fixed 100-byte SQLite file header.
param([ValidateSet('development','staging','production')][string]$Channel='development')
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if($env:OS -ne 'Windows_NT') { throw 'Run this diagnostic in Windows PowerShell on the affected Windows computer.' }
function Property($Object,[string]$Name) { if($null -ne $Object) { $entry=$Object.PSObject.Properties[$Name];if($null -ne $entry) { return $entry.Value } };return $null }
function Failure($ErrorRecord) {
 $id=([string]$ErrorRecord.FullyQualifiedErrorId -replace '[^A-Za-z0-9_.-]','')
 if($id.Length -gt 100) { $id=$id.Substring(0,100) }
 return @{category=$id;hresult=$ErrorRecord.Exception.HResult}
}
function Read-ConnectQueueHeader([string]$Path) {
 if(-not ('PackProofQueueHeaderDiagnostic' -as [type])) {
Add-Type -TypeDefinition @'
using System;using System.IO;using System.Text;using System.Collections.Generic;using System.Runtime.InteropServices;using Microsoft.Win32.SafeHandles;
public sealed class PackProofQueueHeaderFacts { public int HeaderSchemaVersion;public int ApplicationId;public int BytesRead; }
public static class PackProofQueueHeaderDiagnostic {
 [StructLayout(LayoutKind.Sequential)] private struct FileInformation { public uint Attributes;public System.Runtime.InteropServices.ComTypes.FILETIME Creation,Access,Write;public uint Serial,SizeHigh,SizeLow,Links,IndexHigh,IndexLow; }
 [DllImport("kernel32.dll",EntryPoint="CreateFileW",CharSet=CharSet.Unicode,SetLastError=true)] private static extern SafeFileHandle CreateFile(string path,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
 [DllImport("kernel32.dll",SetLastError=true)] private static extern bool GetFileInformationByHandle(SafeFileHandle file,out FileInformation information);
 private static void Ordinary(SafeFileHandle file,bool directory) {
  FileInformation info;if(file.IsInvalid||!GetFileInformationByHandle(file,out info))throw new IOException("QUEUE_HEADER_PATH_UNAVAILABLE");
  if((info.Attributes&0x400)!=0)throw new IOException("QUEUE_HEADER_REPARSE_REFUSED");
  if(((info.Attributes&0x10)!=0)!=directory)throw new IOException("QUEUE_HEADER_ENTRY_TYPE_INVALID");
 }
 private static int SignedBigEndian(byte[] b,int offset) { return unchecked((int)(((uint)b[offset]<<24)|((uint)b[offset+1]<<16)|((uint)b[offset+2]<<8)|b[offset+3])); }
 public static PackProofQueueHeaderFacts Read(string path) {
  var full=Path.GetFullPath(path);var ancestors=new List<string>();var held=new List<SafeFileHandle>();
  for(var parent=new DirectoryInfo(Path.GetDirectoryName(full));parent!=null;parent=parent.Parent)ancestors.Add(parent.FullName);
  ancestors.Reverse();
  try {
   // Hold ordinary ancestor handles without delete sharing until the read ends,
   // preventing an intervening directory replacement from redirecting the path.
   foreach(var ancestor in ancestors) { var handle=CreateFile(ancestor,0,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero);held.Add(handle);Ordinary(handle,true); }
   // OPEN_REPARSE_POINT refuses a linked file even if it changed after listing.
   using(var file=CreateFile(full,0x80000000,7,IntPtr.Zero,3,0x00200000,IntPtr.Zero)) {
    Ordinary(file,false);using(var stream=new FileStream(file,FileAccess.Read,100,false)) {
     var bytes=new byte[100];var count=0;while(count<100) { var read=stream.Read(bytes,count,100-count);if(read==0)break;count+=read; }
     if(count!=100)throw new IOException("QUEUE_HEADER_TRUNCATED");
     if(Encoding.ASCII.GetString(bytes,0,16)!="SQLite format 3\0")throw new IOException("QUEUE_HEADER_SIGNATURE_INVALID");
     return new PackProofQueueHeaderFacts { HeaderSchemaVersion=SignedBigEndian(bytes,60),ApplicationId=SignedBigEndian(bytes,68),BytesRead=count };
    }
   }
  } finally { foreach(var handle in held)handle.Dispose(); }
 }
}
'@
 }
 return [PackProofQueueHeaderDiagnostic]::Read($Path)
}
$suffix=$Channel.Substring(0,1).ToUpperInvariant()+$Channel.Substring(1)
$serviceName='PackProofConnect'+$suffix
$programFiles=[Environment]::GetFolderPath('ProgramFiles')
$programData=[Environment]::GetFolderPath('CommonApplicationData')
$install=Join-Path $programFiles ('PackProof Connect '+$suffix)
$data=Join-Path $programData ('PackProof\Connect\'+$(if($Channel -eq 'production'){'live'}else{$Channel}))
$exports=Join-Path $programData ('PackProof\Exports\'+$(if($Channel -eq 'production'){'live'}else{$Channel}))
$expectedBinary=Join-Path $install 'resources\service\PackProof.Connect.Service.exe'
$serviceSid=$null
try { $serviceSid=(New-Object Security.Principal.NTAccount('NT SERVICE\'+$serviceName)).Translate([Security.Principal.SecurityIdentifier]).Value } catch {}
$trusted=@('S-1-5-18','S-1-5-32-544')
$replacement=[Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
function Directory-Facts([string]$Path,[bool]$PrivateLeaf=$false) {
 $result=[ordered]@{exists=$false}
 try {
  if(-not (Test-Path -LiteralPath $Path)) { return $result }
  $entry=Get-Item -LiteralPath $Path -Force
  $result.exists=$true;$result.directory=[bool]$entry.PSIsContainer;$result.reparsePoint=[bool]($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)
  $acl=Get-Acl -LiteralPath $Path
  $result.ownerSid=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  $result.ownerTrusted=$result.ownerSid -in $trusted
  $rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
  $result.ruleCount=$rules.Count;$result.rulesTruncated=$rules.Count -gt 24
  $result.rules=@($rules|Select-Object -First 24|ForEach-Object {@{sid=$_.IdentityReference.Value;type=[string]$_.AccessControlType;rights=[string]$_.FileSystemRights;inheritance=[string]$_.InheritanceFlags;propagation=[string]$_.PropagationFlags}})
  $result.unsafeReplacementRuleCount=@($rules|Where-Object {$_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -notin $trusted -and -not ($PrivateLeaf -and $_.IdentityReference.Value -eq $serviceSid) -and -not ($_.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -and ($_.FileSystemRights -band $replacement)}).Count
 } catch { $result.failure=Failure $_ }
 return $result
}
$hostFacts=[ordered]@{powerShellVersion=[string]$PSVersionTable.PSVersion;frameworkVersion=[string][Environment]::Version;environmentOSVersion=[string][Environment]::OSVersion.Version;is64BitOperatingSystem=[Environment]::Is64BitOperatingSystem;is64BitProcess=[Environment]::Is64BitProcess}
try { $hostFacts.productType=(Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\ProductOptions').ProductType } catch { $hostFacts.productTypeFailure=Failure $_ }
try { $version=Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion';$hostFacts.registryBuild=[string](Property $version 'CurrentBuildNumber');$hostFacts.registryUbr=Property $version 'UBR' } catch { $hostFacts.registryVersionFailure=Failure $_ }
# Evaluate the installed host expression before any assembly-loading workaround.
try { $hostFacts.installerHostExpression=($hostFacts.productType -eq 'WinNT' -and [Environment]::OSVersion.Version.Build -ge 22000 -and [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq 'X64') } catch { $hostFacts.installerHostExpressionFailure=Failure $_ }
try { $hostFacts.runtimeInformationArchitecture=[string][Runtime.InteropServices.RuntimeInformation]::OSArchitecture;$hostFacts.runtimeInformationAvailable=$true } catch { $hostFacts.runtimeInformationAvailable=$false;$hostFacts.runtimeInformationFailure=Failure $_ }
try { $hostFacts.forcedClientBuildArchitectureExpression=([Environment]::OSVersion.Version.Build -ge 22000 -and [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq 'X64') } catch { $hostFacts.forcedClientExpressionFailure=Failure $_ }
$report=[ordered]@{schema='packproof.connect-installation-diagnostic/v1';createdAt=[DateTimeOffset]::UtcNow.ToString('o');channel=$Channel;mode='read_only';host=$hostFacts;service=@{};metadata=@{};storage=@{};installedFiles=@{};bridgeStatus=@{requested=$false};readiness=@{requested=$false;reason='The readiness command creates disposable storage probes; this read-only diagnostic does not request it.'}}
try {
 $service=Get-CimInstance Win32_Service -Filter ("Name='"+$serviceName+"'")
 $report.service=@{present=$null -ne $service}
 if($null -ne $service) { $report.service.state=$service.State;$report.service.processId=$service.ProcessId;$report.service.startName=$service.StartName;$report.service.startMode=$service.StartMode;$report.service.exitCode=$service.ExitCode;$report.service.binaryMatchesExpected=$service.PathName -eq ('"'+$expectedBinary+'"') }
} catch { $report.service.failure=Failure $_ }
foreach($part in @(@('product','SOFTWARE\PackProofConnect'),@('channel',('SOFTWARE\PackProofConnect\'+$Channel)))) {
 $facts=[ordered]@{exists=$false};$machine=$null;$key=$null
 try {
  $machine=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine,[Microsoft.Win32.RegistryView]::Registry64)
  $key=$machine.OpenSubKey($part[1],[Microsoft.Win32.RegistryKeyPermissionCheck]::ReadSubTree,[Security.AccessControl.RegistryRights]::ReadPermissions -bor [Security.AccessControl.RegistryRights]::QueryValues)
  if($null -ne $key) {
   $facts.exists=$true
   if($null -ne $key.PSObject.Methods['GetAccessControl']) { $acl=$key.GetAccessControl() } else { $acl=[Microsoft.Win32.RegistryAclExtensions]::GetAccessControl($key) }
   $facts.ownerSid=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value;$facts.ownerTrusted=$facts.ownerSid -in $trusted
   $rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]));$facts.ruleCount=$rules.Count;$facts.rulesTruncated=$rules.Count -gt 24
   $facts.rules=@($rules|Select-Object -First 24|ForEach-Object {@{sid=$_.IdentityReference.Value;type=[string]$_.AccessControlType;rights=[string]$_.RegistryRights;propagation=[string]$_.PropagationFlags}})
   if($part[0] -eq 'channel') { $sid=$key.GetValue('OperatorsSid');$facts.savedOperatorPresent=$null -ne $sid;$facts.savedOperatorFormatSupported=$sid -is [string] -and $sid -match '^S-1-5-21-(?:[0-9]+-){3}[0-9]+$' }
  }
 } catch { $facts.failure=Failure $_ }
 finally { if($null -ne $key) { $key.Dispose() };if($null -ne $machine) { $machine.Dispose() } }
 $report.metadata[$part[0]]=$facts
}
foreach($part in @(@('programData',$programData),@('productParent',(Join-Path $programData 'PackProof')),@('connectParent',(Join-Path $programData 'PackProof\Connect')),@('protectedData',$data),@('spool',(Join-Path $data 'spool')),@('exportParent',(Join-Path $programData 'PackProof\Exports')),@('exports',$exports))) { $report.storage[$part[0]]=Directory-Facts $part[1] ($part[0] -in @('protectedData','spool')) }
$report.storage.protectedFiles=@()
foreach($name in @('state.bin','state.bin.new','spool-key.bin','spool-key.bin.new','queue.sqlite','queue.sqlite-wal','queue.sqlite-shm')) {
 $facts=[ordered]@{name=$name;exists=$false}
 try { $path=Join-Path $data $name;if(Test-Path -LiteralPath $path) { $entry=Get-Item -LiteralPath $path -Force;$facts.exists=$true;$facts.directory=[bool]$entry.PSIsContainer;$facts.attributes=[string]$entry.Attributes;$facts.reparsePoint=[bool]($entry.Attributes -band [IO.FileAttributes]::ReparsePoint);if(-not $entry.PSIsContainer) { $facts.byteSize=$entry.Length };$acl=Get-Acl -LiteralPath $path;$facts.ownerSid=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value } } catch { $facts.failure=Failure $_ }
 $report.storage.protectedFiles+=,$facts
}
# Header metadata is not a SQLite open, schema admission, integrity check or
# migration. A live WAL can contain a newer header than the main file reports.
$queueFacts=@($report.storage.protectedFiles|Where-Object {$_.name -eq 'queue.sqlite'})[0]
$walFacts=@($report.storage.protectedFiles|Where-Object {$_.name -eq 'queue.sqlite-wal'})[0]
$headerFacts=[ordered]@{requested=$false;readOnly=$true;bytesRead=0;source='main_file_header_only';walPresent=[bool]$walFacts.exists;walReparsePoint=[bool]$walFacts['reparsePoint'];walByteSize=$(if($walFacts.exists -and -not $walFacts.directory -and -not $walFacts['reparsePoint']){$walFacts['byteSize']}else{$null});mayLagWal=$true;caveat='The main-file header may lag an active WAL. These values do not prove the current logical schema or authorize opening, migration or reset.'}
if($queueFacts.exists) {
 try {
  $headerFacts.requested=$true
  if($queueFacts.directory -or $queueFacts.reparsePoint) { throw 'QUEUE_HEADER_REPARSE_REFUSED' }
  $header=Read-ConnectQueueHeader (Join-Path $data 'queue.sqlite')
  $headerFacts.signatureValid=$true;$headerFacts.bytesRead=$header.BytesRead;$headerFacts.headerSchemaVersion=$header.HeaderSchemaVersion;$headerFacts.applicationId=$header.ApplicationId
 } catch {
  $headerFacts.failure=Failure $_
  $message=[string]$_.Exception.Message
  foreach($code in @('QUEUE_HEADER_PATH_UNAVAILABLE','QUEUE_HEADER_REPARSE_REFUSED','QUEUE_HEADER_ENTRY_TYPE_INVALID','QUEUE_HEADER_TRUNCATED','QUEUE_HEADER_SIGNATURE_INVALID')) { if($message.Contains($code)) { $headerFacts.failure.code=$code;break } }
 }
}
$report.storage.sqliteHeader=$headerFacts
foreach($part in @(@('service','resources\service\PackProof.Connect.Service.exe'),@('bridge','resources\bridge\PackProof.Connect.Bridge.exe'),@('serviceConfig','resources\service\service-config.json'),@('bridgeConfig','resources\bridge\bridge-config.json'),@('lifecycle','resources\installer\lifecycle.ps1'),@('storageHealth','resources\installer\storage-health.ps1'),@('applicationArchive','resources\app.asar'))) {
 $facts=[ordered]@{exists=$false}
 try { $path=Join-Path $install $part[1];if(Test-Path -LiteralPath $path) { $entry=Get-Item -LiteralPath $path -Force;$facts.exists=$true;$facts.byteSize=$entry.Length;$facts.reparsePoint=[bool]($entry.Attributes -band [IO.FileAttributes]::ReparsePoint);if($part[0] -in @('service','bridge')) { $facts.fileVersion=[Diagnostics.FileVersionInfo]::GetVersionInfo($path).FileVersion } } } catch { $facts.failure=Failure $_ }
 $report.installedFiles[$part[0]]=$facts
}
# Direct native bridge 'status' has no cloud request or consent/mutation. Select
# safe fields only; original preview rows and protected state never enter output.
if($report.installedFiles.bridge.exists -and -not $report.installedFiles.bridge.reparsePoint) {
 try {
  if(-not ('PackProofReadOnlyBridgeDiagnostic' -as [type])) {
Add-Type -TypeDefinition @'
using System;using System.IO;using System.Text;using System.Diagnostics;using System.Threading.Tasks;
public static class PackProofReadOnlyBridgeDiagnostic {
 private static async Task<string> Drain(Stream stream,int limit) {
  using(var saved=new MemoryStream()) { var part=new byte[4096];int n;bool overflow=false;
   while((n=await stream.ReadAsync(part,0,part.Length).ConfigureAwait(false))>0) { if(!overflow&&saved.Length+n<=limit)saved.Write(part,0,n);else overflow=true; }
   if(overflow)throw new InvalidOperationException("Bounded bridge response exceeded.");return Encoding.UTF8.GetString(saved.ToArray()); }
 }
 public static string Status(string binary) {
  var start=new ProcessStartInfo(binary){UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true};
  using(var child=Process.Start(start)) {
   if(child==null)throw new InvalidOperationException("Bridge could not start.");
   var output=Drain(child.StandardOutput.BaseStream,262145);var error=Drain(child.StandardError.BaseStream,16384);
   try { var request=Encoding.UTF8.GetBytes("{\"version\":1,\"id\":\""+Guid.NewGuid().ToString()+"\",\"operation\":\"status\"}\n");var input=child.StandardInput.BaseStream;input.Write(request,0,request.Length);input.Flush();input.Close();
    if(!child.WaitForExit(5000))throw new TimeoutException("Bounded bridge status timed out.");var result=output.GetAwaiter().GetResult();error.GetAwaiter().GetResult();return result;
   } finally { if(!child.HasExited) { child.Kill();child.WaitForExit(1000); } }
  }
 }
}
'@
  }
  $report.bridgeStatus.requested=$true
  $reply=[PackProofReadOnlyBridgeDiagnostic]::Status((Join-Path $install 'resources\bridge\PackProof.Connect.Bridge.exe'))|ConvertFrom-Json
  $report.bridgeStatus.ok=[bool](Property $reply 'ok')
  $fault=Property $reply 'error';$result=Property $reply 'result';$health=Property $result 'health';$startupError=Property $result 'error'
  $report.bridgeStatus.errorCode=([string](Property $fault 'code') -replace '[^A-Z0-9_]','')
  $report.bridgeStatus.state=Property $result 'state';$report.bridgeStatus.installedVersion=Property $result 'installedVersion';$report.bridgeStatus.serviceOnline=Property $health 'serviceOnline';$report.bridgeStatus.queueCount=Property $health 'queueCount'
  $report.bridgeStatus.startupErrorCode=([string](Property $startupError 'code') -replace '[^A-Z0-9_]','');$report.bridgeStatus.lastErrorCode=([string](Property $health 'lastErrorCode') -replace '[^A-Z0-9_]','')
 } catch { $report.bridgeStatus.failure=Failure $_ }
}
$report|ConvertTo-Json -Depth 10
