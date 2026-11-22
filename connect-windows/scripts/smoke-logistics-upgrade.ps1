param(
 [Parameter(Mandatory)][ValidateSet('Clean','Upgrade','SameVersion')][string]$Mode,
 [Parameter(Mandatory)][string]$CandidateDirectory,
 [ValidatePattern('^[a-fA-F0-9]{40}$')][string]$CandidateCommit=$env:GITHUB_SHA,
 [string]$PriorConnectArchive,
 [string]$PriorCommerceDirectory,
 [string]$PriorCommerceSource,
 [string]$PriorUnifiedDirectory
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$isWorkstation=(Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\ProductOptions').ProductType -eq 'WinNT'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:APP_ENV -ne 'development' -or
    ($isWorkstation -and $env:PACKPROOF_DISPOSABLE_WINDOWS11 -ne '1') -or
    (!$isWorkstation -and $env:RUNNER_ENVIRONMENT -ne 'github-hosted')) {
 throw 'Run this rehearsal only on a disposable development Actions machine.'
}
if ($isWorkstation -and ([Environment]::OSVersion.Version.Build -lt 22000 -or [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64')) {
 throw 'The supported installer rehearsal requires Windows 11 x64.'
}
$repo=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$scratch=Join-Path $env:RUNNER_TEMP ('packproof-installed-'+[Guid]::NewGuid().ToString('N'))
$program=Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'PackProof Connect Development'
$data=Join-Path $env:ProgramData 'PackProof\Connect\development'
$profile=Join-Path $env:LOCALAPPDATA 'PackProof Dev'
$serviceName='PackProofConnectDevelopment'
$ui=Join-Path $program 'PackProof Connect Development.exe'
$native=Join-Path $program 'resources\service\PackProof.Connect.Service.exe'
$config=Join-Path $program 'resources\service\service-config.json'
$operator=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$sequence=0
$fixture=$null
$cert=$null
$firewall=$null
$receipt=[ordered]@{schemaVersion=2;mode=$Mode;candidateCommit=$CandidateCommit;rehearsalCommit=$env:GITHUB_SHA;osBuild=[Environment]::OSVersion.Version.ToString();
 connectInstallation=if($isWorkstation){'Windows 11 NSIS'}else{'hosted Server NSIS payload and packaged service lifecycle'};
 windows11Nsis='not_run';
 checks=@();result='failed'}
function Passed([string]$test) { $receipt.checks+=@($test) }
function Release([string]$dir,[string]$pattern,[string]$commit) {
 $manifest=Get-Content -LiteralPath (Join-Path $dir 'release-evidence.json') -Raw | ConvertFrom-Json
 if ($manifest.channel -ne 'development' -or $manifest.signed -or $manifest.sourceCommit -ne $commit) {throw 'Development package provenance failed.'}
 $files=@(Get-ChildItem -LiteralPath $dir -File -Filter $pattern)
 if ($files.Count -ne 1) {throw ('Expected one verified installer named '+$pattern+', found '+$files.Count+'.')}
 $file=$files[0]
 $record=@($manifest.artifacts | Where-Object file -eq $file.Name)
 $sum=(Get-FileHash -LiteralPath $file.FullName).Hash.ToLowerInvariant()
 $lines=Get-Content -LiteralPath (Join-Path $dir 'SHA256SUMS')
 if ($record.Count -ne 1 -or $record[0].sha256 -ne $sum -or $file.Length -ne $record[0].bytes -or
     $lines -notcontains ($sum+'  '+$file.Name)) {throw 'Installer bytes do not match the verified release inventory.'}
 return $file.FullName
}
function Run-Installer([string]$exe,[string[]]$options) {
 $p=Start-Process -FilePath $exe -ArgumentList $options -WindowStyle Hidden -PassThru
 if (!$p.WaitForExit(180000) -or $p.ExitCode -ne 0) {throw 'Silent installation failed or timed out.'}
}
function Install-Connect([string]$exe,[string]$version,[string]$commit) {
 if ($isWorkstation) {
   $receipt.windows11Nsis='attempted'
   Run-Installer $exe @('/S','/allusers')
   $receipt.windows11Nsis='executed'
   $entries=@(Get-ChildItem 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall' |
     ForEach-Object {Get-ItemProperty $_.PSPath} | Where-Object { $_.PSObject.Properties['DisplayName'] -and
       $_.DisplayName -like 'PackProof Connect Development*' -and $_.DisplayVersion -eq $version })
   if ($entries.Count -ne 1) {throw 'The expected machine installer registration was not found.'}
 } else {
   # The released installer deliberately rejects Server. Extract its exact Electron
   # payload and invoke the packaged Windows PowerShell 5.1 development lifecycle.
   $extract=Join-Path $scratch ('payload-'+$version)
   $seven=(Get-Command 7z.exe).Source
   & $seven x -y ('-o'+$extract) $exe '$PLUGINSDIR\app-64.7z' | Out-Null
   $archive=Join-Path $extract '$PLUGINSDIR\app-64.7z'
   if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $archive)) {throw 'The verified NSIS payload could not be extracted.'}
   if (Get-Service -Name $serviceName -ErrorAction SilentlyContinue) {Stop-Service -Name $serviceName -ErrorAction Stop}
   & $seven x -y ('-o'+$program) $archive | Out-Null
   if ($LASTEXITCODE) {throw 'Installing the archived application payload failed.'}
   $installArgs=@('-Action','Install','-InstallRoot',$program,'-AllowUnsupportedDevelopmentHost')
   if (!(Test-Path -LiteralPath 'HKLM:\SOFTWARE\PackProofConnect\development')) {$installArgs+=@('-OperatorSid',$operator)}
   & "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File (Join-Path $program 'resources\installer\lifecycle.ps1') @installArgs
   if ($LASTEXITCODE) {throw 'Packaged service installation failed.'}
 }
 $service=Get-CimInstance Win32_Service -Filter "Name='$serviceName'"
 if (!$service -or $service.StartName -ne 'NT AUTHORITY\LocalService' -or $service.StartMode -ne 'Auto' -or
     $service.State -ne 'Running' -or $service.PathName.Trim('"') -ne $native -or
     [Diagnostics.FileVersionInfo]::GetVersionInfo($native).ProductVersion -ne ($version+'+'+$commit)) {
   throw 'The installed service does not match the package, identity or startup policy.'
 }
}
function Bridge([string]$operation,[object]$payload=$null) {
 $request=@{version=1;id=[Guid]::NewGuid().ToString();operation=$operation}
 if ($null -ne $payload) {$request.payload=$payload}
 $reply=($request | ConvertTo-Json -Depth 8 -Compress) | & (Join-Path $program 'resources\bridge\PackProof.Connect.Bridge.exe') | ConvertFrom-Json
 if ($LASTEXITCODE -or !$reply.ok -or $reply.id -ne $request.id) {
   $code=if ($reply -and $reply.PSObject.Properties['error']) {([string]$reply.error.code -replace '[^A-Z0-9_]','')} else {'UNAVAILABLE'}
   throw ('Verified service bridge failed at '+$operation+' ('+$code+').')
 }
 return $reply.result
}
function Launch-Commerce([string]$exe) {
 $helper=Join-Path $repo 'desktop\scripts\native-launch-smoke.cjs'
 $js='const {launchCycle}=require(process.argv[1]); launchCycle({executable:process.argv[2]},process.argv[3],{}).catch(e=>{console.error(e.message);process.exitCode=1})'
 & node -e $js $helper $exe (Join-Path $profile 'Logs\desktop.log')
 if ($LASTEXITCODE) {throw 'The installed Commerce host failed to launch, open protected storage, render or quit normally.'}
}
function Commerce-Queue([string]$action,[string]$src) {
 $bundle=Join-Path $scratch ($action+'-commerce.cjs')
 $build='const path=require("node:path");const [base,src,out]=process.argv.slice(1);const content=["./src/main/secure-store.ts","./src/main/evidence/engine.ts","./src/main/evidence/store.ts"].map(p=>"export * from "+JSON.stringify(p)).join("\n");require(path.join(base,"node_modules/esbuild")).buildSync({stdin:{contents:content,resolveDir:src,loader:"ts"},outfile:out,bundle:true,platform:"node",target:"node22",format:"cjs",external:["electron"]})'
 & node -e $build $PriorCommerceSource $src $bundle
 if ($LASTEXITCODE) {throw 'Unable to prepare historical/current Commerce queue code.'}
 # Electron is a GUI subsystem binary. Wait for the old/current writer and its
 # exit status before asserting facts about the encrypted queue.
 $run='const {spawnSync}=require("node:child_process");const path=require("node:path");const [src,...args]=process.argv.slice(1);const exe=require(path.join(src,"node_modules/electron"));const p=spawnSync(exe,args,{stdio:"inherit",windowsHide:true,timeout:60000});if(p.error)console.error("Electron launch failed:",p.error.code);process.exitCode=p.status??1'
 & node -e $run $PriorCommerceSource (Join-Path $PSScriptRoot 'upgrade-commerce-queue.cjs') $action $bundle $scratch
 if ($LASTEXITCODE) {
   $progressFile=Join-Path $scratch ('commerce-'+$action+'-progress.json')
   $stage=if (Test-Path -LiteralPath $progressFile) {(Get-Content $progressFile -Raw|ConvertFrom-Json).stage} else {'starting-electron'}
   throw ('Commerce queue '+$action+' failed at '+$stage+'.')
 }
}
function Wait-Fixture([string]$file) {
 $target=Join-Path $scratch $file
 for ($i=0;$i -lt 900;$i++) {
   if (Test-Path -LiteralPath $target) {return (Get-Content -LiteralPath $target -Raw | ConvertFrom-Json)}
   if ($fixture.HasExited) {throw ('Isolated HTTP fixture exited before '+$file+'.')}
   Start-Sleep -Milliseconds 100
 }
 throw ('Timed out awaiting '+$file+'.')
}
function Control([hashtable]$request) {
 $script:sequence++
 $requestPath=Join-Path $scratch ($sequence.ToString()+'.request.json')
 [IO.File]::WriteAllText($requestPath+'.tmp',($request|ConvertTo-Json -Compress))
 [IO.File]::Move($requestPath+'.tmp',$requestPath)
 if ($request.command -ne 'stop') {return Wait-Fixture ($sequence.ToString()+'.result.json')}
}
function Bind-Fixture([string]$origin) {
 if ($origin -notmatch '^https://127\.0\.0\.1:[1-9][0-9]{1,4}$') {throw 'Invalid isolated API origin.'}
 Stop-Service $serviceName
 $settings=Get-Content -LiteralPath $config -Raw | ConvertFrom-Json
 $settings.apiOrigin=$origin
 [IO.File]::WriteAllText($config,($settings|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
 Start-Service $serviceName
 . (Join-Path $program 'resources\installer\storage-health.ps1')
 [void](Wait-ConnectReadiness $serviceName 'PackProofConnect-development-v1' $native)
}
function Stop-ConnectChecked {
 $registered=Get-CimInstance Win32_Service -Filter "Name='$serviceName'"
 Stop-Service -Name $serviceName -ErrorAction Stop
 (Get-Service -Name $serviceName).WaitForStatus('Stopped',[TimeSpan]::FromSeconds(45))
 if($registered.ProcessId -ne 0) {
   $process=Get-Process -Id $registered.ProcessId -ErrorAction SilentlyContinue
   if($null -ne $process -and !$process.WaitForExit(5000)) {throw 'The stopped rehearsal helper has not released its pending originals.'}
 }
}
function Pending-SpoolSnapshot {
 if ((Get-Service -Name $serviceName).Status -ne 'Stopped') {throw 'Stop the rehearsal service before comparing its pending encrypted originals.'}
 $spool=Join-Path $data 'spool'
 [PackProofStorageNative]::AssertOrdinary($spool,$true)
 $key=Join-Path $data 'spool-key.bin'
 [PackProofStorageNative]::AssertOrdinary($key,$false)
 $files=@(Get-ChildItem -LiteralPath $spool -Force | Sort-Object Name)
 if ($files.Count -ne 1) {throw 'The same-version fixture requires exactly one retained encrypted collector original.'}
 $snapshot=[ordered]@{spoolKey=(Get-FileHash -LiteralPath $key -Algorithm SHA256).Hash;originals=[ordered]@{}}
 foreach ($file in $files) {
   [PackProofStorageNative]::AssertOrdinary($file.FullName,$false)
   $snapshot.originals[$file.Name]=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
 }
 return ($snapshot | ConvertTo-Json -Depth 4 -Compress)
}
try {
 foreach ($entry in @($program,$data,$profile,'HKLM:\SOFTWARE\PackProofConnect\development')) {
   if (Test-Path -LiteralPath $entry) {throw 'Existing workstation state detected. Use a fresh, disposable test image.'}
 }
 if (Get-Service -Name $serviceName -ErrorAction SilentlyContinue) {throw 'A service already exists on the test machine.'}
 [void][IO.Directory]::CreateDirectory($scratch)
 $candidate=Release $CandidateDirectory 'PackProof-Connect-development-Setup-0.7.0.exe' $CandidateCommit
 $manifest=Get-Content -LiteralPath (Join-Path $CandidateDirectory 'release-evidence.json') -Raw | ConvertFrom-Json
 if (!$manifest.application.unifiedWindows) {throw 'The upgrade candidate must include the unified Commerce and Logistics host.'}
 if ($Mode -eq 'Clean') {
   Install-Connect $candidate '0.7.0' $CandidateCommit
   $status=Bridge status
   if (!$status.health.serviceOnline -or ($status.PSObject.Properties['installationId'] -and $status.installationId) -or $status.workspace.canReadOrders) {throw 'Clean installation has unexpected enrollment or collection permissions.'}
   Launch-Commerce $ui
   $vault=Join-Path $profile 'Credentials\installation.vault'
   $before=(Get-FileHash -LiteralPath $vault).Hash
   Launch-Commerce $ui
   if ((Get-FileHash -LiteralPath $vault).Hash -ne $before) {throw 'The clean Commerce host replaced its installation credential.'}
   Passed 'Clean unified host launched and reopened the Windows-protected Commerce identity; installed LocalService has no enrollment or collection scope.'
 } else {
   $sameVersion=$Mode -eq 'SameVersion'
   $base=if($sameVersion){'617a58b883328ad04513a48564d33c573b9b7c78'}else{'63843c5616dce4ce5824015f975fd0ac6327012d'}
   $priorMerge=if($sameVersion){$base}else{'3d1e58a4dfbc9dff4506f3bb15eb32f13aa65c37'}
   $priorVersion=if($sameVersion){'0.7.0'}else{'0.6.0'}
   if($sameVersion) {
     $prior=Release $PriorUnifiedDirectory 'PackProof-Connect-development-Setup-0.7.0.exe' $priorMerge
     $priorManifest=Get-Content -LiteralPath (Join-Path $PriorUnifiedDirectory 'release-evidence.json') -Raw | ConvertFrom-Json
     $priorHash='87c99ba8af8a9c831b9a675d39dc3a3894d80b63bf34cfb2910ea55c14ab3dba'
     if (!$priorManifest.application.unifiedWindows -or (Get-FileHash -LiteralPath $prior -Algorithm SHA256).Hash -ne $priorHash -or
         $CandidateCommit -eq $priorMerge -or (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash -eq $priorHash) {
       throw 'Same-version input must be the exact qualified unified 0.7.0 build and the candidate must contain different reviewed source.'
     }
     $receipt.previousCommit=$priorMerge;$receipt.previousInstallerSha256=$priorHash
     $receipt.previousArtifactId=14679037204;$receipt.previousRunId=44836162283
   } else {
     if ((Get-FileHash -LiteralPath $PriorConnectArchive).Hash -ne '00279cff2fc00e14fdaba0126a1c9b7c356b93ed41ed982a60f34ea04dea001e') {throw 'Previous Connect archive digest differs from the verified PR 175 build.'}
     Expand-Archive -LiteralPath $PriorConnectArchive -DestinationPath (Join-Path $scratch 'previous')
     $prior=Release (Join-Path $scratch 'previous') 'PackProof-Connect-development-Setup-0.6.0.exe' $priorMerge
   }
   if ((& git -C $PriorCommerceSource rev-parse HEAD).Trim() -ne $base) {throw 'Commerce baseline writer source differs from the verified revision.'}
   # No real hosted endpoint may receive a rehearsal service request, including
   # while either unchanged installer restores its own packaged API origin.
   $firewall=New-NetFirewallRule -DisplayName ('PackProof disposable rehearsal '+[Guid]::NewGuid()) -Direction Outbound -Action Block -Program $native -Profile Any -RemoteAddress @('0.0.0.0-126.255.255.255','128.0.0.0-255.255.255.255','::2-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff')
   if($sameVersion) {
     Install-Connect $prior $priorVersion $priorMerge
     $oldUi=$ui
   } else {
     $commerceVersion=(Get-Content -LiteralPath (Join-Path $PriorCommerceSource 'package.json') -Raw | ConvertFrom-Json).version
     $commerce=Release $PriorCommerceDirectory ('PackProof-Dev-Setup-'+$commerceVersion+'.exe') $base
     Run-Installer $commerce @('/S','/currentuser')
     $items=@(Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' | ForEach-Object {Get-ItemProperty $_.PSPath} |
       Where-Object {$_.PSObject.Properties['DisplayName'] -and $_.DisplayName -eq ('PackProof Dev '+$commerceVersion) -and $_.DisplayVersion -eq $commerceVersion})
     if ($items.Count -ne 1 -or $items[0].PSChildName -notmatch '^[{]?[a-fA-F0-9-]{36}[}]?$') {throw 'Prior Commerce install registration missing.'}
     $commercePath=(Get-ItemProperty -LiteralPath ('HKCU:\Software\'+$items[0].PSChildName)).InstallLocation
     $oldUi=Join-Path $commercePath 'PackProof Dev.exe'
   }
   Launch-Commerce $oldUi
   Commerce-Queue 'seed' $PriorCommerceSource
   $vault=Join-Path $profile 'Credentials\installation.vault'
   $commerceIdentity=(Get-FileHash -LiteralPath $vault).Hash
   Passed $(if($sameVersion){'The pinned unified 0.7.0 host generated its own DPAPI identity; its exact Commerce writer staged an encrypted recording.'}else{'Previous standalone Commerce NSIS installed, generated its own DPAPI identity and wrote a staged encrypted recording using the previous queue writer.'})
   if(!$sameVersion) {Install-Connect $prior $priorVersion $priorMerge}
   $rsa=[Security.Cryptography.RSA]::Create(2048)
   try {
     $certRequest=[Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=PackProof Disposable Loopback',$rsa,[Security.Cryptography.HashAlgorithmName]::SHA256,[Security.Cryptography.RSASignaturePadding]::Pkcs1)
     $san=[Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
     $san.AddIpAddress([Net.IPAddress]::Loopback)
     $certRequest.CertificateExtensions.Add($san.Build())
     $cert=$certRequest.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-1),[DateTimeOffset]::UtcNow.AddHours(1))
     [IO.File]::WriteAllBytes((Join-Path $scratch 'loopback.pfx'),$cert.Export('Pfx','disposable'))
     $trust=[Security.Cryptography.X509Certificates.X509Store]::new('Root','LocalMachine')
     $trust.Open('ReadWrite')
     try {$trust.Add([Security.Cryptography.X509Certificates.X509Certificate2]::new($cert.Export('Cert')))}finally{$trust.Close()}
   } finally {$rsa.Dispose()}
   $backend=Join-Path $repo 'backend'
   $argsFixture=@('--import','tsx','tests/logistics-installed-upgrade-fixture.ts',('"'+$scratch+'"'))
   $fixture=Start-Process (Get-Command node).Source -WorkingDirectory $backend -ArgumentList $argsFixture -WindowStyle Hidden -PassThru
   $origin=(Wait-Fixture 'ready.json').origin
   Bind-Fixture $origin
   $enrollment=(Bridge beginEnrollment).enrollment
   $decision=Control @{command='enroll';id=$enrollment.id;code=$enrollment.comparisonCode}
   $enrolled=Bridge pollEnrollment
   if (!$decision.installationId -or $enrolled.installationId -ne $decision.installationId -or $enrolled.binding.locationId -ne 'upgrade') {throw 'Previous installed service did not persist its approved enrollment.'}
   $folder=Join-Path $env:ProgramData 'PackProof\Exports\development\upgrade-orders'
   $out=Join-Path $env:ProgramData ('PackProof-upgrade-output-'+[Guid]::NewGuid().ToString('N'))
   foreach ($dir in @($folder,$out)) {[void][IO.Directory]::CreateDirectory($dir)}
   & icacls $out /grant ("NT SERVICE\{0}:(OI)(CI)(M)" -f $serviceName) | Out-Null
   if ($LASTEXITCODE) {throw 'Output permissions unavailable.'}
   $orderFile=Join-Path $folder 'orders.json'
   Copy-Item -LiteralPath (Join-Path $repo 'examples\multisource-journey\fixtures\orders.json') -Destination $orderFile
   $source=(Bridge addWorkspaceSource @{folder=$folder;role='order'}).workspace.sources[0]
   if ($source.recognition.state -ne 'recognized') {throw 'Prior service failed to inspect its real source.'}
   [void](Bridge setWorkspaceOutput @{folder=$out})
   $pending=(Bridge activateWorkspace).workspace
   if ($pending.approvalPath -notmatch '[?&]workspaceSession=([^&]+)') {throw 'Missing independent source approval request.'}
   $workspaceSession=$Matches[1]
   if($sameVersion) {[void](Control @{command='holdObservations'})}
   $grant=Control @{command='approveSources';id=$workspaceSession;source=$source.id}
   for ($i=0;$i -lt 30;$i++) {
     $approved=(Bridge status).workspace
     if ($approved.phase -eq 'active') {break}
     Start-Sleep -Seconds 1
   }
   if ($approved.phase -ne 'active' -or !$approved.canReadOrders) {throw 'The installed previous service did not adopt its approved source scope.'}
   $spoolHash=(Get-FileHash -LiteralPath (Join-Path $data 'spool-key.bin')).Hash
   $original=(Get-FileHash -LiteralPath $orderFile).Hash
   $operatorBefore=(Get-ItemProperty 'HKLM:\SOFTWARE\PackProofConnect\development').OperatorsSid
   Passed 'The verified prior LocalService enrolled, redeemed and acknowledged its credential against a loopback backend; a separate human approval enabled the exact source scope.'
   if($sameVersion) {
     $held=$null
     for($i=0;$i -lt 90;$i++) {
       $held=Control @{command='collectionState'}
       if($held.pendingOriginals -eq 1) {break}
       Start-Sleep -Seconds 1
     }
     $paused=(Bridge pauseWorkspaceSource @{sourceId=$source.id}).workspace.sources[0]
     if(!$held -or $held.pendingOriginals -ne 1 -or $held.acceptedOriginals -ne 0 -or $paused.state -ne 'paused' -or $paused.queued -ne 1) {
       throw 'The previous installed collector must retain exactly one real, unaccepted original before replacement.'
     }
     [void](Bridge checkpoint)
     Stop-ConnectChecked
     $pendingSpool=Pending-SpoolSnapshot
     $receipt.pendingCollectorRequestSha256=$held.requestIdentitySha256
     Passed 'The prior unified 0.7.0 LocalService captured a real source original, retained its pending upload and paused collection without changing its approved source.'
   }
   Install-Connect $candidate '0.7.0' $CandidateCommit
   Bind-Fixture $origin
   $upgraded=Bridge refresh
   if ($upgraded.installationId -ne $decision.installationId -or $upgraded.binding.locationId -ne 'upgrade' -or
     $upgraded.workspace.sources[0].id -ne $source.id -or $upgraded.workspace.sources[0].generation -ne $source.generation -or
     $upgraded.workspace.outputFolder -ne $out -or $upgraded.workspace.viewKey -ne $grant.scopeDigest -or
     (Get-ItemProperty 'HKLM:\SOFTWARE\PackProofConnect\development').OperatorsSid -ne $operatorBefore -or
     (Get-FileHash -LiteralPath (Join-Path $data 'spool-key.bin')).Hash -ne $spoolHash -or (Get-FileHash -LiteralPath $orderFile).Hash -ne $original) {
     throw 'The upgrade did not preserve the enrolled credential, source scope, generation, operator, output, original or spool key.'
   }
   Passed 'Upgraded service authenticated with its persisted installation credential and retained its approved scope, source generation, output, source bytes and spool key.'
   if($sameVersion) {
     if($upgraded.workspace.sources[0].state -ne 'paused' -or $upgraded.workspace.sources[0].queued -ne 1) {throw 'Same-version replacement did not retain the paused pending original.'}
     [void](Bridge checkpoint)
     Stop-ConnectChecked
     if((Pending-SpoolSnapshot) -ne $pendingSpool) {throw 'Same-version replacement changed the encrypted pending original or its spool key.'}
     Start-Service -Name $serviceName
     . (Join-Path $program 'resources\installer\storage-health.ps1')
     [void](Wait-ConnectReadiness $serviceName 'PackProofConnect-development-v1' $native)
     [void](Control @{command='releaseObservations'})
     [void](Bridge resumeWorkspaceSource @{sourceId=$source.id})
     $completed=$null
     for($i=0;$i -lt 90;$i++) {
       $completed=Control @{command='collectionState'}
       if($completed.acceptedOriginals -eq 1 -and (Bridge status).workspace.sources[0].queued -eq 0) {break}
       Start-Sleep -Seconds 1
     }
     if(!$completed -or $completed.acceptedOriginals -ne 1 -or $completed.requestIdentitySha256 -ne $held.requestIdentitySha256 -or
        (Bridge status).workspace.sources[0].queued -ne 0) {throw 'The replacement did not complete the exact retained collector request.'}
     Passed 'Different-source 0.7.0 replacement preserved the encrypted collector original byte-for-byte and replayed its identical request and idempotency key to an accepted receipt.'
   }
   [void](Control @{command='pilotOn'})
   if (!(Bridge refresh).workspace.guidedSetupAvailable) {throw 'Pilot did not become available for the enrolled facility.'}
   $draft=Bridge getFacilityDraft
   if (!$draft.id) {throw 'The enrolled facility draft did not open.'}
   [void](Control @{command='pilotOff'})
   $rollback=Bridge refresh
   if ($rollback.workspace.guidedSetupAvailable -or $rollback.workspace.viewKey -ne $grant.scopeDigest) {throw 'Facility rollback did not retain the separately approved legacy source.'}
   Passed 'Facility pilot enabled then disabled via heartbeat while its separately approved prior configuration remained available.'
   Launch-Commerce $ui
   Commerce-Queue 'replay' (Join-Path $repo 'desktop')
   if ((Get-FileHash -LiteralPath $vault).Hash -ne $commerceIdentity -or !(Test-Path -LiteralPath $oldUi)) {throw 'Prior Commerce installation or identity changed.'}
   Passed 'Installed unified host reopened the previous Commerce identity; current reader decrypted the exact pending original and recovered the same queued job and installation.'
 }
 $receipt.result='passed'
} finally {
 if ($fixture -and !$fixture.HasExited) {
   try {[void](Control @{command='stop'})} catch {}
   if (!$fixture.WaitForExit(5000)) {$fixture.Kill()}
 }
 if ($cert) {
   $trust=[Security.Cryptography.X509Certificates.X509Store]::new('Root','LocalMachine')
   try {$trust.Open('ReadWrite');$trust.Remove($cert)} finally {$trust.Close();$cert.Dispose()}
   $keyFile=Join-Path $scratch 'loopback.pfx'
   if (Test-Path -LiteralPath $keyFile) {Remove-Item -LiteralPath $keyFile}
 }
 if ($firewall) {
   if (Get-Service $serviceName -ErrorAction SilentlyContinue) {Stop-Service $serviceName}
   $firewall | Remove-NetFirewallRule
 }
 $receipt | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $CandidateDirectory ('logistics-install-'+$Mode+'.json')) -Encoding utf8NoBOM
}

