$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if ($env:APP_ENV -ne 'development' -or $env:GITHUB_ACTIONS -ne 'true') { throw 'This internal foundation smoke is restricted to development CI.' }
$root=Split-Path $PSScriptRoot -Parent
$output=Join-Path $root 'release\development\win32-x64'
$unpacked=Join-Path $output 'win-unpacked'
$install=Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'PackProof Connect Development'
$serviceName='PackProofConnectDevelopment'
$data=Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'PackProof\Connect\development'
$exports=Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'PackProof\Exports\development'
$operatorSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$evidence=[ordered]@{schemaVersion=1;sourceCommit=(& git -C $root rev-parse HEAD).Trim();scope='Native service foundation on the hosted Windows Server runner; not Windows 11/customer/installer acceptance';osBuild=[Environment]::OSVersion.Version.ToString();tests=@();windows11Acceptance='not_run';installerAcceptance='not_run';remotePipeClient='not_run';customerAcceptance='not_run'}
function Record-Pass([string]$Name) { $evidence.tests+=@{name=$Name;result='passed'} }
function Invoke-Bridge([string]$Operation,[object]$Payload=$null) {
 $request=@{version=1;id=[Guid]::NewGuid().ToString();operation=$Operation}
 if ($null -ne $Payload) { $request.payload=$Payload }
 $response=($request|ConvertTo-Json -Compress -Depth 8)| & (Join-Path $install 'resources\bridge\PackProof.Connect.Bridge.exe')
 if ($LASTEXITCODE -ne 0) { throw 'The installed verified pipe bridge did not complete its native smoke.' }
 $reply=$response|ConvertFrom-Json
 if (-not $reply.ok -or $reply.id -ne $request.id -or $reply.version -ne 1) { throw 'The installed pipe protocol did not return the expected receipt.' }
 return $reply.result
}
function Run-Lifecycle([string]$Action,[switch]$KeepApprovedOperator) {
 $parameters=@{Action=$Action;InstallRoot=$install;AllowUnsupportedDevelopmentHost=$true}
 if (-not $KeepApprovedOperator) { $parameters.OperatorSid=$operatorSid }
 & (Join-Path $install 'resources\installer\lifecycle.ps1') @parameters
}
try {
 if (Test-Path -LiteralPath $install) { throw 'The isolated Connect foundation smoke directory already exists.' }
 New-Item -Path $install -ItemType Directory | Out-Null
 Copy-Item -Path (Join-Path $unpacked '*') -Destination $install -Recurse -Force
 Run-Lifecycle Install
 $service=Get-CimInstance Win32_Service -Filter "Name='$serviceName'"
 if ($service.StartName -ne 'NT AUTHORITY\LocalService' -or $service.State -ne 'Running') { throw 'The installed collector is not running as LocalService.' }
 Record-Pass 'service starts under LocalService independently of Electron'
 $status=Invoke-Bridge status
 if (-not $status.health.serviceOnline -or ($status.PSObject.Properties.Name -contains 'installationId' -and $status.installationId)) { throw 'The fresh service must be online without an enrolled grant.' }
 Record-Pass 'verified expected-service peer bridge returns bounded setup-only state'
 $preflight=Invoke-Bridge preflight
 foreach ($checkId in @('identity','storage','disk')) { if (@($preflight.checks | Where-Object { $_.id -eq $checkId -and $_.state -eq 'passed' }).Count -ne 1) { throw ('Native service preflight failed: '+$checkId) } }
 Record-Pass 'actual LocalService identity DPAPI round trip and disk reserve'
 $temporary=Join-Path $exports 'setup.tmp'
 [IO.File]::WriteAllText($temporary,"Reference,Description,Quantity`r`n000123,CI synthetic shipment,1`r`n",[Text.UTF8Encoding]::new($false))
 Move-Item -LiteralPath $temporary -Destination (Join-Path $exports 'setup.csv')
 $selected=Invoke-Bridge selectFolder @{folder=$exports}
 if (-not $selected.source.accessible) { throw 'The actual service identity cannot access its prepared export folder.' }
 $preview=Invoke-Bridge localPreview @{fileName='setup.csv'}
 if ($preview.source.samples[0].Reference -ne '000123' -or ($preview.PSObject.Properties.Name -contains 'preview' -and $preview.preview)) { throw 'Local preview must preserve identifiers and must not upload a cloud original.' }
 Record-Pass 'actual service read-only immutable CSV local preview preserves leading zeros'
 $stateHash=(Get-FileHash -LiteralPath (Join-Path $data 'state.bin') -Algorithm SHA256).Hash
 Run-Lifecycle Stop
 Start-Service -Name $serviceName
 (Get-Service -Name $serviceName).WaitForStatus('Running',[TimeSpan]::FromSeconds(30))
 $restarted=Invoke-Bridge status
 if (-not $restarted.source.accessible -or $restarted.source.selectedFileName -ne 'setup.csv') { throw 'The restarted service did not recover the protected setup state.' }
 if ((Get-FileHash -LiteralPath (Join-Path $data 'state.bin') -Algorithm SHA256).Hash -ne $stateHash) { throw 'Restart unexpectedly replaced the protected setup state.' }
 Record-Pass 'service restart recovers identity-protected configuration without an interactive UI'
 Run-Lifecycle Install -KeepApprovedOperator
 $repaired=Invoke-Bridge status
 if ($repaired.source.selectedFileName -ne 'setup.csv') { throw 'Repair reset the protected setup state.' }
 $repairedConfig=Get-Content -LiteralPath (Join-Path $install 'resources\service\service-config.json') -Raw | ConvertFrom-Json
 if ($repairedConfig.operatorsSid -ne $operatorSid -or (Get-Item -LiteralPath 'HKLM:\SOFTWARE\PackProofConnect\development').GetValue('OperatorsSid') -ne $operatorSid) { throw 'Repair replaced the originally approved local operator.' }
 Record-Pass 'same-source service repair preserves protected state'
 Record-Pass 'repair without an override preserves the approved operator SID'
 Run-Lifecycle Remove
 if (-not (Test-Path -LiteralPath (Join-Path $data 'state.bin')) -or -not (Test-Path -LiteralPath (Join-Path $data 'spool-key.bin')) -or -not (Test-Path -LiteralPath (Join-Path $exports 'setup.csv'))) { throw 'Removal discarded protected state, encryption key or source export.' }
 Record-Pass 'service removal preserves encrypted data keys and source original'
 $evidence.result='passed'
} catch { $evidence.result='failed';$evidence.failureCategory='native_foundation';throw }
finally {
 if (Get-Service -Name $serviceName -ErrorAction SilentlyContinue) { try { Run-Lifecycle Remove } catch {} }
 $evidence|ConvertTo-Json -Depth 8|Set-Content -LiteralPath (Join-Path $output 'native-foundation-smoke.json') -Encoding utf8NoBOM
}
