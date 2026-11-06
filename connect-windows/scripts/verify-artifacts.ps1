$ErrorActionPreference='Stop'
$channel=if ($env:APP_ENV) {$env:APP_ENV} else {'development'}
if ($channel -notin @('development','staging','production')) {throw 'Unknown Connect environment.'}
$root=Split-Path $PSScriptRoot -Parent
$output=Join-Path $root ('release\'+$channel+'\win32-x64')
$signed=$channel -ne 'development'
$installer=Get-ChildItem -LiteralPath $output -File -Filter 'PackProof-Connect-*-Setup-*.exe'
if (@($installer).Count -ne 1) {throw 'Exactly one immutable Connect installer is required.'}
$owned=@($installer)+@(Get-ChildItem -LiteralPath (Join-Path $output 'win-unpacked') -File -Filter 'PackProof Connect*.exe')+@(Get-ChildItem -LiteralPath (Join-Path $output 'win-unpacked\resources') -Recurse -File | Where-Object {$_.Name -match '^PackProof\.Connect\.(Service|Bridge)\.(exe|dll)$'})
if ($owned.Count -ne 6) {throw 'The installer, UI, service and verified bridge executable inventory is incomplete.'}
foreach ($file in $owned) {if ($signed) {& (Join-Path $root '..\desktop\scripts\verify-windows-signature.ps1') -Artifact $file.FullName -Publisher $env:WINDOWS_PUBLISHER_NAME}}
$inventory=@(Get-ChildItem -LiteralPath (Join-Path $output 'win-unpacked') -Recurse -File | Where-Object {$_.Extension -in @('.exe','.dll')} | Sort-Object FullName | ForEach-Object {$signature=Get-AuthenticodeSignature -LiteralPath $_.FullName;@{file=[IO.Path]::GetRelativePath($output,$_.FullName).Replace('\','/');bytes=$_.Length;sha256=(Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLowerInvariant();signatureStatus=$signature.Status.ToString();publisher=if($signature.SignerCertificate){$signature.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false)}else{$null}}})
$sha=(& git -C $root rev-parse HEAD).Trim()
if ($env:GITHUB_SHA -and $sha -ne $env:GITHUB_SHA) {throw 'Artifact source differs from the requested source commit.'}
$artifacts=@($installer | ForEach-Object {@{file=$_.Name;bytes=$_.Length;sha256=(Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLowerInvariant()}})
$runtime=Get-Content -LiteralPath (Join-Path $root 'dist\main\runtime-config.json') -Raw | ConvertFrom-Json
if ($runtime.sourceCommit -ne $sha -or $runtime.channel -ne $channel) {throw 'Runtime provenance differs from this artifact.'}
@{schemaVersion=1;product='PackProof Connect';version=(Get-Content (Join-Path $root 'package.json') -Raw|ConvertFrom-Json).version;sourceCommit=$sha;channel=$channel;signed=$signed;publicDistributionAllowed=$false;artifacts=$artifacts;executables=$inventory;gate='internal-build-only';nativeAcceptance='not_run';customerAcceptance='not_run'} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $output 'release-evidence.json') -Encoding utf8NoBOM
$artifacts | ForEach-Object {$_.sha256+'  '+$_.file} | Set-Content -LiteralPath (Join-Path $output 'SHA256SUMS') -Encoding ascii
if (-not $signed) {'INTERNAL DEVELOPMENT BUILD. Unsigned. Not approved for public distribution or customer source activation.' | Set-Content -LiteralPath (Join-Path $output 'DEVELOPMENT-BUILD.txt')}
