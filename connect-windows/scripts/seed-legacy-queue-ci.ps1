$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if ($env:APP_ENV -ne 'development' -or $env:GITHUB_ACTIONS -ne 'true' -or -not [OperatingSystem]::IsWindows()) { throw 'Run this fixture only on the fresh Windows development CI host.' }
$root=Split-Path $PSScriptRoot -Parent
$project=Split-Path $root -Parent
$output=Join-Path $root 'release\development\win32-x64'
$install=Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'PackProof Connect Development'
$data=Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'PackProof\Connect\development'
$service='PackProofConnectDevelopment'
$archived=$install+' archived CI writer'
if ((Test-Path -LiteralPath $install) -or (Test-Path -LiteralPath $archived) -or (Test-Path -LiteralPath $data) -or (Get-Service -Name $service -ErrorAction SilentlyContinue)) { throw 'Refusing to seed over an existing installation or retained data.' }
$writer='edd2254b1e7590c114e5e62d12365a743186f7ce'
$temp=New-Item -ItemType Directory -Path (Join-Path $env:RUNNER_TEMP ('packproof-writer-'+[Guid]::NewGuid().ToString('N')))
$archive=Join-Path $temp 'source.zip'
& git -C $project fetch --no-tags --depth=1 origin $writer
if ($LASTEXITCODE -ne 0) { throw 'Could not fetch the pinned historical queue writer.' }
& git -C $project archive -o $archive $writer connect-windows/service backend/src/records/connect-csv-rules.json
if ($LASTEXITCODE -ne 0) { throw 'The pinned previous service source is unavailable.' }
Expand-Archive -LiteralPath $archive -DestinationPath $temp
$historical=Join-Path $temp 'connect-windows\service'
Copy-Item -LiteralPath (Join-Path $root 'tests\QueueUpgradeFixture\SeedHistorical.cs.txt') -Destination (Join-Path $historical 'SeedHistorical.cs')
$entry=Join-Path $historical 'Program.cs'
$source=Get-Content -LiteralPath $entry -Raw
$anchor='var bridge = pipe.Run(stoppingToken);'
if (-not $source.Contains($anchor)) { throw 'Historical service startup no longer matches the pinned fixture.' }
$source.Replace($anchor,"agent.SeedHistoricalFixture();`n        " + $anchor) | Set-Content -LiteralPath $entry -Encoding utf8NoBOM
$serviceBuild=Join-Path $temp 'published'
& dotnet publish (Join-Path $historical 'PackProof.Connect.Service.csproj') -c Release -r win-x64 --self-contained true -o $serviceBuild
if ($LASTEXITCODE -ne 0) { throw 'Failed to compile the historical fixture.' }
Copy-Item -LiteralPath (Join-Path $output 'win-unpacked') -Destination $install -Recurse
Copy-Item -Path (Join-Path $serviceBuild '*') -Destination (Join-Path $install 'resources\service') -Force
$lifecycle=Join-Path $install 'resources\installer\lifecycle.ps1'
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& $lifecycle -Action Install -InstallRoot $install -OperatorSid $sid -AllowUnsupportedDevelopmentHost
& $lifecycle -Action Remove -InstallRoot $install -OperatorSid $sid -AllowUnsupportedDevelopmentHost
if (Get-Service -Name $service -ErrorAction SilentlyContinue) { throw 'Historical service must be removed before current installation.' }
$fixture=Join-Path $root 'tests\QueueUpgradeFixture\QueueUpgradeFixture.csproj'
& dotnet build $fixture -c Release --nologo
if ($LASTEXITCODE -ne 0) { throw 'The historical fixture validation program did not build.' }
$wire=& dotnet (Join-Path $root 'tests\QueueUpgradeFixture\bin\Release\net10.0\QueueUpgradeFixture.dll') upgrade
if ($LASTEXITCODE -ne 0) { throw 'The literal historical migration failed.' }
$row=$wire | ConvertFrom-Json
$files=@(Get-ChildItem -LiteralPath (Join-Path $data 'spool') -File)
if ($row.rowCount -ne 1 -or $row.queueVersion -ne 2 -or $files.Count -ne 1 -or $files[0].Name -notmatch '^[a-f0-9]{32}\.bin$') { throw 'The historical writer did not retain one pending encrypted original.' }
$hashes=@{}
foreach ($name in @('spool-key.bin',('spool/'+$files[0].Name))) { $hashes[$name]=(Get-FileHash -LiteralPath (Join-Path $data $name) -Algorithm SHA256).Hash }
@{sourceCommit=(& git -C $project rev-parse HEAD).Trim();queueWriterCommit=$writer;partitionMigrationCommit=$row.partitionMigrationCommit;queueVersion=$row.queueVersion;rowCount=$row.rowCount;metadataSha256=$row.metadataSha256;fileHashes=$hashes} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $output 'legacy-queue-input.json') -Encoding utf8NoBOM
Move-Item -LiteralPath $install -Destination $archived
