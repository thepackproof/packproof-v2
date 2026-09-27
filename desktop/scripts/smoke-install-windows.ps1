$ErrorActionPreference = 'Stop'
if ($env:APP_ENV -ne 'development' -or $env:CI -ne 'true') { throw 'Installer smoke test is restricted to isolated development CI runners.' }
$product = 'PackProof Dev'
$version = (Get-Content -LiteralPath (Join-Path (Get-Location) 'package.json') -Raw | ConvertFrom-Json).version
$displayName = "$product $version"
$output = Join-Path (Get-Location) 'release/development/win32-x64'
$installer = Join-Path $output 'PackProof-Dev-Setup.exe'
if (-not (Test-Path -LiteralPath $installer)) { throw 'Development installer is missing.' }
$queue = Join-Path $env:LOCALAPPDATA "$product/EvidenceQueue"
$sentinel = Join-Path $queue 'installer-preservation-test.txt'
if (Test-Path -LiteralPath $sentinel) { throw 'Preserving an existing installer-test sentinel. Use a fresh CI runner.' }
New-Item -ItemType Directory -Force -Path $queue | Out-Null
$expected = [Guid]::NewGuid().ToString()
[IO.File]::WriteAllText($sentinel, $expected)

function Install-Candidate {
  $process = Start-Process -FilePath $installer -ArgumentList '/S', '/currentuser' -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw 'Silent current-user installation failed.' }
  # electron-builder's default UNINSTALL_DISPLAY_NAME includes the version.
  $entry = Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' |
    ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object { $_.DisplayName -eq $displayName -and $_.DisplayVersion -eq $version } | Select-Object -First 1
  if ($null -eq $entry) { throw "Current-user uninstall registration is missing for $displayName." }
  # NSIS keeps InstallLocation in Software\APP_GUID, separately from the uninstall metadata.
  if ($entry.PSChildName -notmatch '^[{]?[a-fA-F0-9-]{36}[}]?$') { throw 'Unexpected application install registry key.' }
  $registration = Get-ItemProperty -LiteralPath "HKCU:\Software\$($entry.PSChildName)"
  $installDirectory = $registration.InstallLocation
  if (-not $installDirectory -or -not (Test-Path -LiteralPath (Join-Path $installDirectory "$product.exe"))) { throw 'Registered application executable is missing.' }
  if ([IO.File]::ReadAllText($sentinel) -cne $expected) { throw 'Installer modified the evidence queue sentinel.' }
  return $installDirectory
}

$installDirectory = Install-Candidate
$installDirectory = Install-Candidate
$uninstaller = Get-ChildItem -LiteralPath $installDirectory -Filter 'Uninstall *.exe' | Select-Object -First 1
if ($null -eq $uninstaller) { throw 'Uninstaller is missing.' }
$process = Start-Process -FilePath $uninstaller.FullName -ArgumentList '/S', '/currentuser' -Wait -PassThru
if ($process.ExitCode -ne 0) { throw 'Silent uninstall failed.' }
if ([IO.File]::ReadAllText($sentinel) -cne $expected) { throw 'Uninstall removed pending local evidence.' }
if (Test-Path (Join-Path $installDirectory "$product.exe")) { throw 'Uninstall left the main executable installed.' }
Remove-Item -LiteralPath $sentinel
@{ schemaVersion = 1; sourceCommit = $env:GITHUB_SHA; platform = 'windows'; version = $version; checks = @('silent-current-user-install', 'same-version-reinstall-preserves-sentinel', 'silent-uninstall-preserves-sentinel'); hardwareAcceptance = 'not-tested' } |
  ConvertTo-Json | Set-Content -Encoding utf8 -LiteralPath (Join-Path $output 'installer-smoke.json')
Write-Output 'Windows current-user installation, same-version reinstall and uninstall preserved the evidence queue sentinel.'
