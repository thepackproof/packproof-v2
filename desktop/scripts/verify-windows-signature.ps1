param([Parameter(Mandatory=$true)][string]$Artifact, [Parameter(Mandatory=$true)][string]$Publisher)
$ErrorActionPreference = 'Stop'
$signature = Get-AuthenticodeSignature -LiteralPath $Artifact
if ($signature.Status -ne 'Valid') { throw "Invalid Authenticode signature: $([IO.Path]::GetFileName($Artifact))" }
$actual = $signature.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
if ($actual -cne $Publisher) { throw 'The signing certificate publisher does not match WINDOWS_PUBLISHER_NAME.' }
if ($null -eq $signature.TimeStamperCertificate) { throw 'The Authenticode signature must have a trusted timestamp.' }
Write-Output "Verified signed artifact: $([IO.Path]::GetFileName($Artifact))"
