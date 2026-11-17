$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if ($env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:GITHUB_REPOSITORY -ne 'thepackproof/packproof-v2' -or $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or $env:APP_ENV -ne 'development') { throw 'Requires the dedicated fresh GitHub-hosted Windows qualification job.' }
$pin=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'candidate.json') -Raw | ConvertFrom-Json
$repo=Join-Path $env:GITHUB_WORKSPACE 'candidate'
if ((& git -C $repo rev-parse HEAD).Trim() -cne $pin.source) { throw 'Fixture source differs from the installer source.' }
$project=Join-Path $repo 'connect-windows'
$release=Join-Path $project 'release/development/win32-x64'
$unpacked=Join-Path $release 'win-unpacked'
$artifact=Join-Path $env:RUNNER_TEMP 'exact-candidate/contents'
$installer=Join-Path $artifact 'PackProof-Connect-development-Setup-0.5.0.exe'
$install=Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'PackProof Connect Development'
$common=[Environment]::GetFolderPath('CommonApplicationData')
$channelParent=Join-Path $common 'PackProof\Connect'
$data=Join-Path $channelParent 'development'
$name='PackProofConnectDevelopment'
$pipe='PackProofConnect-development-v1'
$binary=Join-Path $install 'resources/service/PackProof.Connect.Service.exe'
$bridge=Join-Path $install 'resources/bridge/PackProof.Connect.Bridge.exe'
$fixture=Join-Path $project 'tests/QueueUpgradeFixture/bin/Release/net10.0/QueueUpgradeFixture.dll'
$reportRoot=New-Item -ItemType Directory -Path (Join-Path $env:RUNNER_TEMP 'restore-report')
$report=[ordered]@{schema='packproof.same-machine-restore/v1';result='failed';artifact=$pin;qualificationCommit=$env:GITHUB_SHA;qualificationRun=$env:GITHUB_RUN_ID;os=[Environment]::OSVersion.VersionString;account='NT AUTHORITY\LocalService';protector='DPAPI CurrentUser';installationIdOrigin='synthetic randomized fixture identity, no live enrollment';scope='One Windows Server 2025 runner, same machine and service account, actual candidate binaries contained in the development installer';checks=@()}
function Passed([string]$check) { $report.checks+=$check; Write-Host $check }
function Hash([string]$path) { (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Text-Hash([string]$text) { [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($text))).ToLowerInvariant() }
function Bridge([string]$op,[hashtable]$payload=@{}) {
 $id=[Guid]::NewGuid().ToString()
 $wire=(@{version=1;id=$id;operation=$op;payload=$payload} | ConvertTo-Json -Depth 5 -Compress) | & $bridge
 if ($LASTEXITCODE -ne 0) { throw "Installed bridge failed at $op" }
 $reply=$wire | ConvertFrom-Json
 if (-not $reply.ok -or $reply.id -ne $id -or $reply.version -ne 1) { throw "Installed service rejected $op" }
 return $reply.result
}
function Stop-Cold {
 $service=Get-CimInstance Win32_Service -Filter "Name='$name'"
 if ($service.StartName -ne 'NT AUTHORITY\LocalService') { throw 'Unexpected installed identity.' }
 $oldProcess=Get-Process -Id $service.ProcessId -ErrorAction SilentlyContinue
 Stop-Service -Name $name
 (Get-Service -Name $name).WaitForStatus('Stopped',[TimeSpan]::FromSeconds(45))
 if ($oldProcess -and -not $oldProcess.WaitForExit(10000)) { throw 'Stopped writer has not released protected storage.' }
}
function Ready {
 $receipt=Wait-ConnectReadiness $name $pipe $binary
 if (-not $receipt.ready -or $receipt.dataReset -or $receipt.checks.Count -lt 8) { throw 'The installed LocalService failed its DPAPI and SQLite readiness checks.' }
 $report.readinessChecks=@($receipt.checks)
}
function Queue-Receipt {
 $json=& dotnet $fixture verify
 if ($LASTEXITCODE -ne 0) { throw 'SQLite retained row identity check failed.' }
 $receipt=$json|ConvertFrom-Json
 if ($receipt.rowCount -ne 1 -or $receipt.queueVersion -ne 4 -or -not $receipt.metadataPreserved) { throw 'Missing the historical pending original.' }
 return $receipt.metadataSha256
}
function Tree-Manifest([string]$root) {
 $entries=[Collections.Generic.List[object]]::new()
 $pending=[Collections.Generic.Queue[string]]::new()
 $pending.Enqueue($root)
 while ($pending.Count) {
  $item=Get-Item -LiteralPath $pending.Dequeue() -Force
  [PackProofStorageNative]::AssertOrdinary($item.FullName,$item.PSIsContainer)
  $acl=Get-Acl -LiteralPath $item.FullName
  $sddl=$acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]'Access,Owner,Group')
  $digest=if ($item.PSIsContainer) { foreach ($child in Get-ChildItem -LiteralPath $item.FullName -Force) { $pending.Enqueue($child.FullName) }; $null } else { Hash $item.FullName }
  $entries.Add([pscustomobject]@{path=[IO.Path]::GetRelativePath($root,$item.FullName);isDirectory=$item.PSIsContainer;sha256=$digest;security=$sddl})
 }
 return @($entries | Sort-Object -Property path -CaseSensitive)
}
function Copy-Cold([string]$from,[string]$to) {
 if (Test-Path -LiteralPath $to) { throw 'Restore requires a new, empty path.' }
 [void](New-Item -Path $to -ItemType Directory)
 Set-Acl -LiteralPath $to -AclObject (Get-Acl -LiteralPath $from)
 & robocopy $from $to /E /B /COPY:DATSO /DCOPY:DAT /XJ /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
 if ($LASTEXITCODE -gt 7) { throw "Cold copy failed with robocopy code $LASTEXITCODE." }
}
function Matching-Tree($expected,[string]$root) {
 $actual=Tree-Manifest $root
 if (($expected | ConvertTo-Json -Depth 4 -Compress) -cne ($actual | ConvertTo-Json -Depth 4 -Compress)) { throw 'Backup content, owner or ACL differs from the cold state.' }
}
try {
 if ((Get-Service -Name $name -ErrorAction SilentlyContinue) -or (Test-Path -LiteralPath $data) -or (Test-Path -LiteralPath $install)) { throw 'This test requires a fresh runner without Connect state.' }
 if ((Hash $installer) -cne $pin.exeSha256) { throw 'Verified installer changed.' }
 $outer=Join-Path $env:RUNNER_TEMP 'restore-nsis'
 & 7z x $installer "-o$outer" -y -bd | Out-Null
 if ($LASTEXITCODE -ne 0) { throw 'Could not extract the pinned NSIS payload.' }
 $payload=@(Get-ChildItem -Path $outer -Recurse -File -Filter '*64*.7z')
 if ($payload.Count -ne 1) { throw 'Expected one x64 application payload in the installer.' }
 [void](New-Item -ItemType Directory -Path $unpacked -Force)
 & 7z x $payload[0].FullName "-o$unpacked" -y -bd | Out-Null
 if ($LASTEXITCODE -ne 0) { throw 'Could not extract candidate x64 application.' }
 $manifest=Get-Content -LiteralPath (Join-Path $artifact 'release-evidence.json') -Raw | ConvertFrom-Json
 foreach ($relative in @('resources/service/PackProof.Connect.Service.exe','resources/service/PackProof.Connect.Service.dll','resources/bridge/PackProof.Connect.Bridge.exe','resources/bridge/PackProof.Connect.Bridge.dll')) {
  $entry=@($manifest.executables | Where-Object file -CEQ ('win-unpacked/'+$relative))
  if ($entry.Count -ne 1 -or (Hash (Join-Path $unpacked $relative)) -cne $entry[0].sha256) { throw 'Extracted service or bridge differs from recorded executable hashes.' }
 }
 Passed 'Pinned installer SHA-256 and included service and bridge SHA-256 verified.'
 # No customer credentials are involved. The pinned legacy CI writer runs as the real
 # service identity. Its test-only setup writes a fresh synthetic installation ID
 # and a pending encrypted original, then exits with no token and no cloud connection.
 $seed=Join-Path $project 'tests/QueueUpgradeFixture/SeedHistorical.cs.txt'
 $contents=[IO.File]::ReadAllText($seed)
 $anchor='        Save();'
 if ([regex]::Matches($contents,[regex]::Escape($anchor)).Count -ne 1) { throw 'Pinned historical fixture no longer matches the reviewed code.' }
 [IO.File]::WriteAllText($seed,$contents.Replace($anchor,'        state.InstallationId = "ci-restore-" + Guid.NewGuid().ToString("N");'+[Environment]::NewLine+$anchor))
 & (Join-Path $project 'scripts/seed-legacy-queue-ci.ps1')
 if (-not (Test-Path -LiteralPath (Join-Path $release 'legacy-queue-input.json'))) { throw 'Historical queue did not seed.' }
 Copy-Item -LiteralPath $unpacked -Destination $install -Recurse
 $ps51=Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
 $operator=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
 & $ps51 -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File (Join-Path $install 'resources/installer/lifecycle.ps1') -Action Install -InstallRoot $install -OperatorSid $operator -AllowUnsupportedDevelopmentHost
 if ($LASTEXITCODE -ne 0) { throw 'Candidate installation lifecycle failed.' }
 . (Join-Path $install 'resources/installer/storage-health.ps1')
 Ready
 $beforeStatus=Bridge status
 if ($beforeStatus.installationId -cnotmatch '^ci-restore-[a-f0-9]{32}$') { throw 'Installer failed to preserve the protected synthetic installation ID.' }
 $orderFolder=Join-Path $common 'PackProof\Exports\development\restore-orders'
 [void](New-Item -ItemType Directory -Path $orderFolder)
 Copy-Item -LiteralPath (Join-Path $repo 'examples/multisource-journey/fixtures/orders.json') -Destination $orderFolder
 $workspace=(Bridge addWorkspaceSource @{folder=$orderFolder;role='order'}).workspace
 $source=@($workspace.sources | Where-Object folder -EQ $orderFolder)
 if ($source.Count -ne 1 -or $source[0].recognition.state -ne 'recognized') { throw 'Installed service did not read the synthetic order source.' }
 $output=Join-Path $common 'PackProof\restore-proof-output'
 [void](New-Item -ItemType Directory -Path $output)
 & icacls $output /grant ("NT SERVICE\{0}:(OI)(CI)(M)" -f $name) | Out-Null
 if ($LASTEXITCODE -ne 0) { throw 'Cannot grant the service access to its isolated output.' }
 $saved=Bridge setWorkspaceOutput @{folder=$output}
 if ($saved.workspace.outputState -ne 'ready') { throw 'Writer did not qualify the local destination.' }
 Stop-Cold
 $seeded=Get-Content -LiteralPath (Join-Path $release 'legacy-queue-input.json') -Raw | ConvertFrom-Json
 if ((Queue-Receipt) -cne $seeded.metadataSha256) { throw 'Candidate changed the pending queue identity.' }
 $tree=Tree-Manifest $data
 $backup=Join-Path $env:RUNNER_TEMP 'restore-cold-copy'
 $report.backupStartedAt=[DateTimeOffset]::UtcNow.ToString('O')
 $backupClock=[Diagnostics.Stopwatch]::StartNew()
 Copy-Cold $data $backup
 Matching-Tree $tree $backup
 $report.backupMs=$backupClock.ElapsedMilliseconds
 Passed 'Stopped writer; complete cold backup matches every file, directory, owner and DACL.'
 # Retain the original. Move only the validated exact development root to a fresh
 # sibling on the same volume. Reconstitute a new independent tree from the backup.
 $original=Join-Path $channelParent ('held-development-'+[Guid]::NewGuid().ToString('N'))
 if ((Resolve-Path -LiteralPath $data).Path -ine (Join-Path $common 'PackProof\Connect\development') -or
     [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($original)) -ine (Resolve-Path -LiteralPath $channelParent).Path -or
     (Test-Path -LiteralPath $original)) { throw 'Unexpected isolated storage path.' }
 $report.restoreStartedAt=[DateTimeOffset]::UtcNow.ToString('O')
 $clock=[Diagnostics.Stopwatch]::StartNew()
 Move-Item -LiteralPath $data -Destination $original
 Copy-Cold $backup $data
 Matching-Tree $tree $data
 Start-Service -Name $name
 (Get-Service -Name $name).WaitForStatus('Running',[TimeSpan]::FromSeconds(30))
 Ready
 $afterStatus=Bridge status
 if ($afterStatus.installationId -cne $beforeStatus.installationId -or $afterStatus.workspace.outputFolder -ne $output) { throw 'Restored service lost its installation or proof destination.' }
 $after=(Bridge inspectWorkspaceSource @{sourceId=$source[0].id}).workspace.sources | Where-Object id -CEQ $source[0].id
 if ($after.generation -ne $source[0].generation -or $after.recognition.state -ne 'recognized' -or $after.recognition.fileName -ne 'orders.json') { throw 'The restored service could not resume native source inspection.' }
 $report.recoveryTimeMs=$clock.ElapsedMilliseconds
 $report.restoredSourceObservedAt=[DateTimeOffset]::UtcNow.ToString('O')
 Stop-Cold
 if ((Queue-Receipt) -cne $seeded.metadataSha256) { throw 'Restored queue identity, request keys or receipt changed.' }
 foreach ($entry in $seeded.fileHashes.PSObject.Properties) {
  if ((Hash (Join-Path $data $entry.Name)) -ine $entry.Value) { throw 'Restored encrypted original or spool key changed.' }
 }
 Passed 'Restored protected installation ID, source ID/generation, proof destination, queue identity and original bytes; actual LocalService re-opened DPAPI, SQLite and the registered source.'
 $report.protectedInstallationIdSha256=Text-Hash $beforeStatus.installationId
 $report.restoredSourceIdSha256=Text-Hash $after.id
 $report.restoredSourceGeneration=$after.generation
 $report.verifiedColdEntries=$tree.Count
 $report.coldManifestSha256=Text-Hash ($tree | ConvertTo-Json -Depth 4 -Compress)
 $report.retainedQueueMetadataSha256=$seeded.metadataSha256
 $report.encryptedFileSha256=$seeded.fileHashes
 $report.retainedRows=1
 $report.lostCapturedRows=0
 $report.crossMachineRecovery='not exercised'
 $report.cloudEnrollmentAndReplay='not exercised in this same-machine restore'
 $report.result='passed'
} finally {
 $report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $reportRoot 'restore.json') -Encoding utf8NoBOM
}
