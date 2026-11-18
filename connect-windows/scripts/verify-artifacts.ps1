$ErrorActionPreference='Stop'
$channel=if ($env:APP_ENV) {$env:APP_ENV} else {'development'}
if ($channel -notin @('development','staging','production')) {throw 'Unknown Connect environment.'}
$root=Split-Path $PSScriptRoot -Parent
$output=Join-Path $root ('release\'+$channel+'\win32-x64')
$signed=$channel -ne 'development'
$installer=Get-ChildItem -LiteralPath $output -File -Filter 'PackProof-Connect-*-Setup-*.exe'
if (@($installer).Count -ne 1) {throw 'Exactly one immutable Connect installer is required.'}
$unpacked=Join-Path $output 'win-unpacked'
$ui=@(Get-ChildItem -LiteralPath $unpacked -File -Filter 'PackProof Connect*.exe')
if ($ui.Count -ne 1) { throw 'Exactly one Connect setup UI executable must be shipped.' }
$owned=@($installer)+$ui+@(Get-ChildItem -LiteralPath (Join-Path $unpacked 'resources') -Recurse -File | Where-Object {$_.Name -match '^PackProof\.Connect\.(Service|Bridge)\.(exe|dll)$'})
foreach ($file in $owned) {if ($signed) {& (Join-Path $root '..\desktop\scripts\verify-windows-signature.ps1') -Artifact $file.FullName -Publisher $env:WINDOWS_PUBLISHER_NAME}}
$inventory=@(Get-ChildItem -LiteralPath (Join-Path $output 'win-unpacked') -Recurse -File | Where-Object {$_.Extension -in @('.exe','.dll')} | Sort-Object FullName | ForEach-Object {$signature=Get-AuthenticodeSignature -LiteralPath $_.FullName;@{file=[IO.Path]::GetRelativePath($output,$_.FullName).Replace('\','/');bytes=$_.Length;sha256=(Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLowerInvariant();signatureStatus=$signature.Status.ToString();publisher=if($signature.SignerCertificate){$signature.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false)}else{$null}}})
$sha=(& git -C $root rev-parse HEAD).Trim()
if ($env:GITHUB_SHA -and $sha -ne $env:GITHUB_SHA) {throw 'Artifact source differs from the requested source commit.'}
$artifacts=@($installer | ForEach-Object {@{file=$_.Name;bytes=$_.Length;sha256=(Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLowerInvariant()}})
$runtimePath=Join-Path $root 'dist/main/runtime-config.json'
$runtime=Get-Content -LiteralPath $runtimePath -Raw | ConvertFrom-Json
if ($runtime.sourceCommit -ne $sha -or $runtime.channel -ne $channel) {throw 'Runtime provenance differs from this artifact.'}
$version=(Get-Content (Join-Path $root 'package.json') -Raw|ConvertFrom-Json).version
if ($installer.Name -cne ('PackProof-Connect-'+$channel+'-Setup-'+$version+'.exe')) { throw 'Installer filename differs from the candidate channel or version.' }
$resources=Join-Path $unpacked 'resources'
$layoutJson=& node (Join-Path $root 'scripts/verify-native-layout.mjs') $resources $version $runtimePath
if ($LASTEXITCODE -ne 0) { throw 'Packaged native dependencies or configuration differ from the candidate.' }
$nativeLayout=$layoutJson | ConvertFrom-Json
$installerScripts=@(foreach ($entry in @('installer/lifecycle.ps1','installer/storage-health.ps1','scripts/diagnose-installation.ps1')) {
  $name='installer/'+[IO.Path]::GetFileName($entry)
  $hash=(Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $resources $name)).Hash
  if ($hash -ne (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $root $entry)).Hash) { throw ('Packaged installer script differs from this source: '+$name) }
  @{file=$name;sha256=$hash.ToLowerInvariant()}
})
foreach ($name in @('service/PackProof.Connect.Service.exe','bridge/PackProof.Connect.Bridge.exe','bridge/PackProof.Connect.Bridge.dll')) {
  $info=[Diagnostics.FileVersionInfo]::GetVersionInfo((Join-Path $resources $name))
  if ($info.ProductVersion -cne ($version+'+'+$sha)) { throw ('Packaged component has a different version or source commit: '+$name) }
}
& node (Join-Path $root 'scripts/build-provenance.mjs') verify $root $sha $channel (Join-Path $unpacked 'resources/app.asar')
if ($LASTEXITCODE -ne 0) {throw 'Application asset provenance verification failed.'}
$application=Get-Content -LiteralPath (Join-Path $root 'dist/main/build-provenance.json') -Raw | ConvertFrom-Json
Copy-Item -LiteralPath (Join-Path $root 'dist/main/build-provenance.json') -Destination (Join-Path $output 'build-provenance.json')
$feed=$null
if ($signed) {
 $files=@(($installer.Name+'.blockmap'),'latest.yml')
 $feedFiles=@(foreach ($name in $files) {
  $file=Get-Item -LiteralPath (Join-Path $output $name)
  @{file=$name;bytes=$file.Length;sha256=(Get-FileHash -Algorithm SHA256 -LiteralPath $file.FullName).Hash.ToLowerInvariant()}
 })
 $feed=@{url=$runtime.updateUrl;publisher=$runtime.publisher;apiOrigin=$runtime.apiBaseUrl;webOrigin=$runtime.webBaseUrl;files=$feedFiles}
}
@{schemaVersion=2;feed=$feed;product='PackProof Connect';version=$version;sourceCommit=$sha;sourceDirty=$application.sourceDirty;channel=$channel;signed=$signed;application=$application;publicDistributionAllowed=$false;artifacts=$artifacts;executables=$inventory;nativeLayout=$nativeLayout;installerScripts=$installerScripts;gate='internal-build-only';nativeAcceptance='not_run';customerAcceptance='not_run'} | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $output 'release-evidence.json') -Encoding utf8NoBOM
$artifacts | ForEach-Object {$_.sha256+'  '+$_.file} | Set-Content -LiteralPath (Join-Path $output 'SHA256SUMS') -Encoding ascii
# Record the installer hash separately from the ZIP digest returned by Actions.
foreach ($candidate in $artifacts) {
 $line = "Installer SHA-256 $($candidate.sha256)  $($candidate.file)"
 Write-Output $line
 if ($env:GITHUB_STEP_SUMMARY) { Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Value $line }
}
if (-not $signed) {'INTERNAL DEVELOPMENT BUILD. Unsigned. Not approved for public distribution or customer source activation.' | Set-Content -LiteralPath (Join-Path $output 'DEVELOPMENT-BUILD.txt')}
