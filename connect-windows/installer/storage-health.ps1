# Dot-sourced by the elevated installer. Never run against shipment source folders.
# Windows PowerShell 5.1-compatible; no PowerShell 7-only constructors or syntax.
if (-not ('PackProofStorageNative' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Diagnostics;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class PackProofStorageNative {
 [StructLayout(LayoutKind.Sequential)] private struct FileInformation {
  public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
  public uint Serial, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
 }
 [DllImport("kernel32.dll", EntryPoint="CreateFileW", CharSet=CharSet.Unicode, SetLastError=true)]
 private static extern SafeFileHandle CreateFile(string path,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
 [DllImport("kernel32.dll", SetLastError=true)] [return: MarshalAs(UnmanagedType.Bool)]
 private static extern bool GetFileInformationByHandle(SafeFileHandle file,out FileInformation information);
 [DllImport("kernel32.dll", SetLastError=true)] [return: MarshalAs(UnmanagedType.Bool)]
 private static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe,out uint processId);
 public static void AssertOrdinary(string path,bool directory) {
  using(var handle=CreateFile(path,0,7,IntPtr.Zero,3,0x00200000|0x02000000,IntPtr.Zero)) {
   FileInformation information;
   if(handle.IsInvalid || !GetFileInformationByHandle(handle,out information)) throw new IOException("Protected entry metadata could not be inspected safely.");
   if((information.Attributes&0x400)!=0 || (!directory&&information.Links!=1)) throw new IOException("Storage repair refuses reparse points and hard-linked files.");
   if(((information.Attributes&0x10)!=0)!=directory) throw new IOException("Protected entry type changed during inspection.");
  }
 }
 public static string Query(string pipeName,uint expectedPid,string nonce) {
  using(var pipe=new NamedPipeClientStream(".",pipeName,PipeDirection.InOut,PipeOptions.Asynchronous)) {
   pipe.Connect(1000); uint serverPid;
   if(!GetNamedPipeServerProcessId(pipe.SafePipeHandle,out serverPid)||serverPid!=expectedPid) throw new IOException("Readiness peer does not match the registered service process.");
   var request=Encoding.ASCII.GetBytes(nonce+"\n");pipe.Write(request,0,request.Length);pipe.Flush();
   using(var result=new MemoryStream()) {
    var timer=Stopwatch.StartNew();var buffer=new byte[1];
    while(result.Length<8192 && timer.ElapsedMilliseconds<12000) {
     var read=pipe.ReadAsync(buffer,0,1);
     if(!read.Wait(Math.Max(1,12000-(int)timer.ElapsedMilliseconds))) throw new IOException("Service readiness response timed out.");
     if(read.Result!=1) throw new IOException("Service readiness response ended early.");
     if(buffer[0]==10)return Encoding.UTF8.GetString(result.ToArray());
     result.WriteByte(buffer[0]);
    }
    throw new IOException("Service readiness response exceeded its bounded limit.");
   }
  }
 }
}
'@
}
function Repair-ConnectStoragePermissions([string]$Root,[string]$ServiceSid) {
 $trusted=@('S-1-5-18','S-1-5-32-544','S-1-5-19',$ServiceSid)
 $entries=New-Object 'System.Collections.Generic.List[System.IO.FileSystemInfo]'
 $pending=New-Object 'System.Collections.Generic.Queue[string]'
 $pending.Enqueue($Root)
 while($pending.Count -gt 0) {
  $directory=$pending.Dequeue()
  foreach($entry in @(Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop)) {
   if($entries.Count -ge 30000) { throw 'STORAGE_REPAIR_LIMIT: Too many protected entries for an automatic repair. Nothing was reset.' }
   if(($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'PROTECTED_STORAGE_LINK: Repair refused a link. Existing data was preserved.' }
   if($entry.PSIsContainer) {
    if($directory -ne $Root -or $entry.Name -ne 'spool') { throw 'PROTECTED_STORAGE_LAYOUT: An unknown protected directory needs review. Nothing was reset.' }
    $pending.Enqueue($entry.FullName)
   } elseif($directory -eq $Root -and $entry.Name -notmatch '^(state\.bin(?:\.new)?|spool-key\.bin(?:\.new)?|queue\.sqlite(?:-wal|-shm)?|recovery-[a-f0-9]{32}\.bin(?:\.new)?|\.readiness-[a-f0-9]{32}(?:\.new)?)$') {
    throw 'PROTECTED_STORAGE_LAYOUT: An unknown protected file needs review. Nothing was reset.'
   }
   [PackProofStorageNative]::AssertOrdinary($entry.FullName,[bool]$entry.PSIsContainer)
   $acl=Get-Acl -LiteralPath $entry.FullName -ErrorAction Stop
   if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $trusted) { throw 'PROTECTED_STORAGE_OWNER: Automatic repair refused an untrusted file owner. Preserve the data for review.' }
   foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
    if($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Deny) { throw 'PROTECTED_STORAGE_POLICY: Automatic repair will not remove an explicit deny rule. No key or record was reset.' }
    if($rule.IdentityReference.Value -notin $trusted) { throw 'PROTECTED_STORAGE_POLICY: An unexpected protected-file access rule needs review. No key or record was reset.' }
   }
   $entries.Add($entry)
  }
 }
 # Validate the entire tree BEFORE changing even its root ACL: inherited ACL
 # propagation can otherwise modify a hard-linked external target indirectly.
 foreach($entry in $entries) {
  [PackProofStorageNative]::AssertOrdinary($entry.FullName,[bool]$entry.PSIsContainer)
  if($entry.PSIsContainer) {
   Set-DirectoryPermissions $entry.FullName @(@('S-1-5-18','FullControl'),@('S-1-5-32-544','FullControl'),@($ServiceSid,'Modify'))
  } else {
   $acl=New-Object Security.AccessControl.FileSecurity
   $acl.SetAccessRuleProtection($true,$false)
   $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))
   foreach($sid in @('S-1-5-18','S-1-5-32-544')) { $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($sid)),'FullControl','Allow'))) }
   $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($ServiceSid)),'Modify','Allow')))
   Set-Acl -LiteralPath $entry.FullName -AclObject $acl -ErrorAction Stop
  }
 }
}
function Initialize-ConnectStorageRoot([string]$Root,[string]$ServiceSid) {
 # New roots are born with their final ACL, not created writable and secured later.
 $acl=New-Object Security.AccessControl.DirectorySecurity
 $acl.SetAccessRuleProtection($true,$false)
 $acl.SetOwner((New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))
 foreach($sid in @('S-1-5-18','S-1-5-32-544')) { $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($sid)),'FullControl','ContainerInherit,ObjectInherit','None','Allow'))) }
 $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($ServiceSid)),'Modify','ContainerInherit,ObjectInherit','None','Allow')))
 $parent=Split-Path $Root -Parent
 if(-not (Test-Path -LiteralPath $parent)) { New-Item -Path $parent -ItemType Directory -Force | Out-Null }
 $directory=New-Object IO.DirectoryInfo($Root)
 if($PSVersionTable.PSVersion.Major -le 5) { $directory.Create($acl) }
 else { [IO.FileSystemAclExtensions]::Create($directory,$acl) }
 [PackProofStorageNative]::AssertOrdinary($Root,$true)
 $current=Get-Acl -LiteralPath $Root -ErrorAction Stop
 if($current.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin @('S-1-5-18','S-1-5-32-544')) { throw 'PROTECTED_STORAGE_OWNER: The private storage root has an untrusted owner. No retained data was changed.' }
 $writes=[Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
 foreach($rule in $current.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
  if($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Deny) { throw 'PROTECTED_STORAGE_POLICY: Repair will not remove a private-root deny rule.' }
  if(-not ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -and $rule.IdentityReference.Value -notin @('S-1-5-18','S-1-5-32-544',$ServiceSid) -and ($rule.FileSystemRights -band $writes)) { throw 'PROTECTED_STORAGE_POLICY: An untrusted writer can change the private storage root. Preserve retained work for review.' }
 }
 Repair-ConnectStoragePermissions $Root $ServiceSid
 Set-DirectoryPermissions $Root @(@('S-1-5-18','FullControl'),@('S-1-5-32-544','FullControl'),@($ServiceSid,'Modify'))
}
function Wait-ConnectReadiness([string]$ServiceName,[string]$PipeName,[string]$ExpectedBinary) {
 $watch=[Diagnostics.Stopwatch]::StartNew()
 $lastFailure='The installed service readiness endpoint is not available.'
 while($watch.Elapsed.TotalSeconds -lt 35) {
  $service=Get-CimInstance Win32_Service -Filter ("Name='"+$ServiceName+"'") -ErrorAction Stop
  if($null -eq $service -or $service.StartName -ne 'NT AUTHORITY\LocalService' -or $service.PathName -ne ('"'+$ExpectedBinary+'"')) { throw 'SERVICE_IDENTITY_INVALID: The registered service identity or executable does not match the installation.' }
  if($service.State -ne 'Running' -or $service.ProcessId -eq 0) { Start-Sleep -Milliseconds 200;continue }
  $nonce=[Guid]::NewGuid().ToString('N')
  try { $reply=[PackProofStorageNative]::Query($PipeName+'-readiness',[uint32]$service.ProcessId,$nonce)|ConvertFrom-Json -ErrorAction Stop }
  catch { $lastFailure='The registered service did not return its authenticated storage-readiness response.';Start-Sleep -Milliseconds 200;continue }
  if($reply.schema -ne 'packproof.connect-readiness/v1' -or $reply.nonce -ne $nonce -or $reply.processId -ne $service.ProcessId) { throw 'SERVICE_READINESS_INVALID: An incompatible or stale readiness response was rejected.' }
  if(-not $reply.ready) {
   $code=([string]$reply.code -replace '[^A-Z0-9_]','')
   throw ($code+': '+[string]$reply.message+' No customer data or encryption key was reset.')
  }
  $current=Get-CimInstance Win32_Service -Filter ("Name='"+$ServiceName+"'") -ErrorAction Stop
  if($current.State -ne 'Running' -or $current.ProcessId -ne $service.ProcessId) { throw 'SERVICE_READINESS_CHANGED: The service restarted during validation. Rerun the installer.' }
  return $reply
 }
 throw ('SERVICE_READINESS_TIMEOUT: '+$lastFailure+' The installer cannot report success. Existing data and keys were preserved.')
}
