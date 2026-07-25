[CmdletBinding()]
param(
    [string]$InstallPath = 'D:\steam\steamapps\common\Don''t Starve Together\mods\DST-AICompanion'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$sourceModPath = Join-Path $repositoryRoot 'DST Mod'
$runtimeRoots = @('modinfo.lua', 'modmain.lua', 'scripts')

if (-not (Test-Path -LiteralPath $sourceModPath -PathType Container)) {
    throw "DST Mod source directory was not found: $sourceModPath"
}

$sourceModPath = (Resolve-Path -LiteralPath $sourceModPath).Path
if (-not (Test-Path -LiteralPath $InstallPath -PathType Container)) {
    New-Item -ItemType Directory -Path $InstallPath -Force | Out-Null
}
$installModPath = (Resolve-Path -LiteralPath $InstallPath).Path

$sourceFiles = [System.Collections.Generic.List[string]]::new()
foreach ($runtimeRoot in $runtimeRoots) {
    $sourcePath = Join-Path $sourceModPath $runtimeRoot
    if (-not (Test-Path -LiteralPath $sourcePath)) {
        throw "Required runtime path is missing: $sourcePath"
    }

    if (Test-Path -LiteralPath $sourcePath -PathType Leaf) {
        $sourceFiles.Add((Resolve-Path -LiteralPath $sourcePath).Path)
        continue
    }

    foreach ($file in Get-ChildItem -LiteralPath $sourcePath -File -Recurse) {
        $sourceFiles.Add($file.FullName)
    }
}

if ($sourceFiles.Count -eq 0) {
    throw 'No DST Mod runtime files were found to copy.'
}

$copied = [System.Collections.Generic.List[object]]::new()
foreach ($sourceFile in $sourceFiles) {
    $relativePath = $sourceFile.Substring($sourceModPath.Length).TrimStart('\', '/')
    $destinationFile = Join-Path $installModPath $relativePath
    $destinationDirectory = Split-Path -Parent $destinationFile
    if (-not (Test-Path -LiteralPath $destinationDirectory -PathType Container)) {
        New-Item -ItemType Directory -Path $destinationDirectory -Force | Out-Null
    }

    # This intentionally copies only explicit runtime files. It never mirrors or
    # deletes files from the user's installed Mod directory.
    Copy-Item -LiteralPath $sourceFile -Destination $destinationFile -Force
    $sourceHash = (Get-FileHash -LiteralPath $sourceFile -Algorithm SHA256).Hash
    $destinationHash = (Get-FileHash -LiteralPath $destinationFile -Algorithm SHA256).Hash
    if ($sourceHash -ne $destinationHash) {
        throw "SHA-256 verification failed for $relativePath"
    }
    $copied.Add([PSCustomObject]@{
        File = $relativePath
        SHA256 = $sourceHash
    })
}

Write-Host "Synced and SHA-256 verified $($copied.Count) DST Mod runtime file(s) to: $installModPath"
$copied | Sort-Object File | Format-Table -AutoSize
