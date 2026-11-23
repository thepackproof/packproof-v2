<#
.SYNOPSIS
  Create and operate a real folder-based PackProof warehouse test lab on Windows.
.DESCRIPTION
  Reuses the repository's vetted deterministic multi-source fixtures. Does not
  connect to PackProof, approve access or fabricate a successful Proof.
  Default output is a new, unique "PackProof Exports ..." folder under Documents,
  where PackProof's consent-based discovery can inspect dedicated source folders.
#>
[CmdletBinding()]
param(
    [ValidateSet("Prepare","Next","Run","Status","SelfTest")]
    [string]$Action = "Prepare",
    [ValidateSet("standard","reordered","burst","consolidated","cancelled")]
    [string]$Variant = "standard",
    [string]$LabPath,
    [string]$Parent,
    [ValidateRange(0,60)]
    [int]$DelaySeconds = 4
)
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$runner = Join-Path $PSScriptRoot "journey.mjs"
if (-not (Test-Path -LiteralPath $runner -PathType Leaf)) { throw "Missing PackProof fixture runner: $runner" }
if (-not (Get-Command "node" -ErrorAction SilentlyContinue)) { throw "Node.js 24 is required for the warehouse lab. Install it before running this command." }

function Invoke-Journey([string[]]$Arguments) {
    $result = & node $runner @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw ("Warehouse fixture command failed: " + (($result | Out-String).Trim()))
    }
    $json = ($result | Out-String).Trim()
    if ([string]::IsNullOrWhiteSpace($json)) { throw "Warehouse fixture returned no result." }
    return ($json | ConvertFrom-Json)
}
function Get-Lab([string]$Location) {
    if ([string]::IsNullOrWhiteSpace($Location)) { throw "Supply -LabPath from the Prepare result." }
    $full = [System.IO.Path]::GetFullPath($Location)
    $manifest = Join-Path $full "scenario.json"
    if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) { throw "No PackProof lab manifest was found at $full" }
    $state = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
    if ($state.schema -ne "packproof.sample-journey/v1") { throw "This is not a PackProof sample lab." }
    return [pscustomobject]@{ FullPath = $full; State = $state }
}
function New-Lab([string]$DestinationParent,[string]$SelectedVariant) {
    $parentFull = [System.IO.Path]::GetFullPath($DestinationParent)
    if (-not (Test-Path -LiteralPath $parentFull -PathType Container)) {
        throw "Parent directory does not exist: $parentFull"
    }
    $staging = Join-Path ([System.IO.Path]::GetTempPath()) ("PackProofLabStage-" + [Guid]::NewGuid().ToString("N"))
    [void](New-Item -ItemType Directory -Path $staging)
    try {
        $generated = Invoke-Journey @("prepare",$staging,$SelectedVariant)
        $source = [System.IO.Path]::GetFullPath([string]$generated.workspace)
        $prefix = [System.IO.Path]::GetFullPath($staging).TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
        if (-not $source.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)) {
            throw "The fixture runner returned an unexpected directory."
        }
        [void](Get-Lab $source)
        $destination = Join-Path $parentFull ("PackProof Exports " + (Get-Date -Format "yyyyMMdd-HHmmss") + "-" + [Guid]::NewGuid().ToString("N").Substring(0,6))
        if (Test-Path -LiteralPath $destination) { throw "The destination already exists. No files were overwritten." }
        Move-Item -LiteralPath $source -Destination $destination
        return $destination
    } finally {
        if (Test-Path -LiteralPath $staging -PathType Container) {
            if ((Get-ChildItem -LiteralPath $staging -Force | Measure-Object).Count -eq 0) {
                Remove-Item -LiteralPath $staging -Force
            }
        }
    }
}
function Show-Result($Result) {
    $Result | ConvertTo-Json -Depth 7
}

if ($Action -eq "SelfTest") {
    $testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("PackProofLabSelfTest-" + [Guid]::NewGuid().ToString("N"))
    [void](New-Item -ItemType Directory -Path $testRoot)
    try {
        $lab = New-Lab $testRoot "standard"
        $one = Invoke-Journey @("next",$lab)
        if ($one.step -ne 1) { throw "First warehouse event did not publish." }
        $rest = Invoke-Journey @("run",$lab)
        $state = (Get-Lab $lab).State
        if ($rest.published -lt 1 -or $state.next -le 1) { throw "Warehouse event replay did not continue." }
        $out = Join-Path $lab "output"
        if (-not (Test-Path -LiteralPath $out -PathType Container)) { throw "Separate output directory is missing." }
        Show-Result ([pscustomobject]@{passed=$true;scenario=$state.schema;published=$state.next;outputIsSeparate=$true})
    } finally {
        # Only the unique, isolated directory generated for this self-test.
        Remove-Item -LiteralPath $testRoot -Force -Recurse
    }
    return
}
if ($Action -eq "Prepare") {
    $location = if ($Parent) { $Parent } else { [Environment]::GetFolderPath("MyDocuments") }
    if (-not $location) { throw "Your Documents folder could not be located. Provide -Parent explicitly." }
    $lab = New-Lab $location $Variant
    Show-Result ([pscustomobject]@{
        lab = $lab; variant = $Variant
        orderFolder = (Join-Path $lab "order")
        packingFolder = (Join-Path $lab "packing")
        shippingFolder = (Join-Path $lab "shipping")
        outputFolder = (Join-Path $lab "output")
        instruction = "Open PackProof Setup, discover and approve each relevant source. Do not treat detection as authorization."
    })
    return
}
$chosen = Get-Lab $LabPath
if ($Action -eq "Status") {
    Show-Result ([pscustomobject]@{
        lab = $chosen.FullPath; variant = $chosen.State.variant
        publishedSteps = $chosen.State.next
        lastPublication = @($chosen.State.observations | Select-Object -Last 1)
        note = "This reports emitted test files, not backend acceptance or completed proofs."
    })
    return
}
if ($Action -eq "Next") {
    Show-Result (Invoke-Journey @("next",$chosen.FullPath))
    return
}
if ($Action -eq "Run") {
    $count = 0
    while ($true) {
        $event = Invoke-Journey @("next",$chosen.FullPath)
        if ($event.PSObject.Properties['done'] -and $event.done -eq $true) { break }
        $count++
        Write-Host ("Published " + $event.step + ": " + $event.name)
        if ($DelaySeconds -gt 0) { Start-Sleep -Seconds $DelaySeconds }
    }
    Show-Result ([pscustomobject]@{
        lab = $chosen.FullPath; publishedNow = $count
        note = "Inspect the installed PackProof UI and backend Proof revisions independently. No success is assumed."
    })
}
