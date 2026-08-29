[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$packageManifest = Get-Content -Raw (Join-Path $projectRoot 'package.json') | ConvertFrom-Json
$releaseName = 'SQL-Evaluate-v{0}' -f $packageManifest.version
$releaseRoot = Join-Path $projectRoot 'release'
$stagingPath = Join-Path $releaseRoot $releaseName
$archivePath = Join-Path $releaseRoot ($releaseName + '.zip')

if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'dist\index.html'))) {
    throw 'The production bundle is missing. Run npm run check before packaging.'
}

if (Test-Path -LiteralPath $stagingPath) {
    Remove-Item -LiteralPath $stagingPath -Recurse -Force
}
if (Test-Path -LiteralPath $archivePath) {
    Remove-Item -LiteralPath $archivePath -Force
}

New-Item -ItemType Directory -Path $stagingPath -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $stagingPath 'licenses') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $stagingPath 'tools') -Force | Out-Null

Copy-Item -LiteralPath (Join-Path $projectRoot 'dist') -Destination (Join-Path $stagingPath 'dist') -Recurse
Copy-Item -LiteralPath (Join-Path $projectRoot 'tools\serve.mjs') -Destination (Join-Path $stagingPath 'tools\serve.mjs') -Force

$releaseFiles = @(
    'Start SQL Evaluate.cmd',
    'START_HERE.txt',
    'HOW_IT_WORKS.md',
    'RELEASE_NOTES.md',
    'THIRD_PARTY_NOTICES.md'
)

foreach ($relativePath in $releaseFiles) {
    Copy-Item -LiteralPath (Join-Path $projectRoot $relativePath) -Destination (Join-Path $stagingPath $relativePath) -Force
}

$licenseFiles = @{
    'react-MIT.txt' = 'node_modules\react\LICENSE'
    'react-dom-MIT.txt' = 'node_modules\react-dom\LICENSE'
    'scheduler-MIT.txt' = 'node_modules\scheduler\LICENSE'
    'xmldom-MIT.txt' = 'node_modules\@xmldom\xmldom\LICENSE'
    'fflate-MIT.txt' = 'node_modules\fflate\LICENSE'
    'sheetjs-Apache-2.0.txt' = 'node_modules\xlsx\LICENSE'
}

foreach ($entry in $licenseFiles.GetEnumerator()) {
    $sourcePath = Join-Path $projectRoot $entry.Value
    if (-not (Test-Path -LiteralPath $sourcePath)) {
        throw "Required third-party license file is missing: $($entry.Value). Run npm install before packaging."
    }
    Copy-Item -LiteralPath $sourcePath -Destination (Join-Path $stagingPath ('licenses\' + $entry.Key)) -Force
}

$hashLines = Get-ChildItem -LiteralPath $stagingPath -File -Recurse |
    Sort-Object FullName |
    ForEach-Object {
        $relativePath = [System.IO.Path]::GetRelativePath($stagingPath, $_.FullName).Replace('\', '/')
        $hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        '{0} *{1}' -f $hash, $relativePath
    }

$hashLines | Set-Content -LiteralPath (Join-Path $stagingPath 'SHA256SUMS.txt') -Encoding ascii
Compress-Archive -LiteralPath $stagingPath -DestinationPath $archivePath -CompressionLevel Optimal

$archiveHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
('{0} *{1}' -f $archiveHash, [System.IO.Path]::GetFileName($archivePath)) |
    Set-Content -LiteralPath ($archivePath + '.sha256') -Encoding ascii

Write-Host "Release created: $archivePath"
Write-Host "Archive SHA-256: $archiveHash"
