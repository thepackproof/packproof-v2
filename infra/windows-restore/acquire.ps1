$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if ($env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:GITHUB_REPOSITORY -ne 'thepackproof/packproof-v2' -or $env:RUNNER_OS -ne 'Windows') { throw 'Requires the dedicated hosted Windows qualification job.' }
$pin=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'candidate.json') -Raw | ConvertFrom-Json
if ($pin.number -le 0 -or $pin.run -le 0 -or $pin.artifact -lt 1 -or $pin.source -cnotmatch '^[a-f0-9]{40}$' -or $pin.head -cnotmatch '^[a-f0-9]{40}$' -or $pin.zipSha256 -cnotmatch '^[a-f0-9]{64}$' -or $pin.exeSha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'Incomplete candidate pin.' }
$api='https://api.github.com/repos/thepackproof/packproof-v2/actions'
$headers=@{Authorization=('Bearer '+$env:GH_TOKEN);Accept='application/vnd.github+json';'X-GitHub-Api-Version'='2022-11-28'}
$run=Invoke-RestMethod -Uri "$api/runs/$($pin.run)" -Headers $headers
if ($run.head_repository.full_name -ne $env:GITHUB_REPOSITORY -or $run.head_sha -cne $pin.head -or $run.run_number -ne $pin.number -or $run.path -ne '.github/workflows/connect-windows-ci.yml' -or $run.event -ne 'pull_request' -or $run.status -ne 'completed' -or $run.conclusion -ne 'success') { throw 'The upstream candidate build does not match the approved CI run.' }
$artifact=Invoke-RestMethod -Uri "$api/artifacts/$($pin.artifact)" -Headers $headers
$name='packproof-connect-DEVELOPMENT-win32-x64-'+$pin.source
if ($artifact.expired -or $artifact.workflow_run.id -ne $pin.run -or $artifact.name -cne $name -or $artifact.digest -cne ('sha256:'+$pin.zipSha256)) { throw 'The CI artifact no longer matches the recorded source and digest.' }

$dir=Join-Path $env:RUNNER_TEMP 'exact-candidate'
New-Item -ItemType Directory -Path $dir -ErrorAction Stop | Out-Null
$zip=Join-Path $dir 'installer.zip'
# PowerShell strips Authorization on redirects. The signed redirect is never logged.
Invoke-WebRequest -Uri "$api/artifacts/$($pin.artifact)/zip" -Headers $headers -OutFile $zip
if ((Get-FileHash -LiteralPath $zip).Hash.ToLowerInvariant() -cne $pin.zipSha256) { throw 'Downloaded ZIP checksum mismatch.' }
Expand-Archive -LiteralPath $zip -DestinationPath (Join-Path $dir 'contents')
$evidence=Get-Content -LiteralPath (Join-Path $dir 'contents/release-evidence.json') -Raw | ConvertFrom-Json
$exe='PackProof-Connect-development-Setup-0.5.0.exe'
$entry=@($evidence.artifacts | Where-Object file -CEQ $exe)
if ($evidence.sourceCommit -cne $pin.source -or $evidence.channel -ne 'development' -or $evidence.publicDistributionAllowed -ne $false -or $entry.Count -ne 1 -or $entry[0].sha256 -cne $pin.exeSha256) { throw 'Installer evidence does not match the pinned candidate.' }
$checksum=Get-Content -LiteralPath (Join-Path $dir 'contents/SHA256SUMS')
if (@($checksum | Where-Object { $_ -ceq ($pin.exeSha256+'  '+$exe) }).Count -ne 1 -or (Get-FileHash -LiteralPath (Join-Path $dir "contents/$exe")).Hash.ToLowerInvariant() -cne $pin.exeSha256) { throw 'Installer does not match the exact release checksum.' }
"source=$($pin.source)" >> $env:GITHUB_OUTPUT
Write-Host "Verified candidate #$($pin.number), artifact $($pin.artifact), source $($pin.source), SHA-256 $($pin.exeSha256)."
