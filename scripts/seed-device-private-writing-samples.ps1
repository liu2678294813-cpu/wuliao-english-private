[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$InputPath,
    [string]$Serial = "",
    [string]$PackageName = "com.wuliao.english"
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$adbPath = Join-Path $repoRoot ".android-sdk\platform-tools\adb.exe"
$resolvedInput = (Resolve-Path -LiteralPath $InputPath).Path

if (-not (Test-Path -LiteralPath $adbPath -PathType Leaf)) {
    throw "Repository-local adb was not found: $adbPath"
}
$inputFile = Get-Item -LiteralPath $resolvedInput
if ($inputFile.Length -le 0 -or $inputFile.Length -gt 8MB) {
    throw "Private sample seed must be between 1 byte and 8 MB."
}
$payload = Get-Content -LiteralPath $resolvedInput -Raw -Encoding UTF8 | ConvertFrom-Json
if ($payload.format -ne "wuliao-writing-private-samples" -or $payload.version -ne 1 -or $null -eq $payload.items) {
    throw "Input is not a supported wuliao-writing-private-samples v1 payload."
}

Push-Location $repoRoot
try {
    & node --import "./scripts/test-hooks.mjs" "./scripts/validate-writing-private-samples.mjs" $resolvedInput
    if ($LASTEXITCODE -ne 0) {
        throw "Private sample seed failed exact question and runtime-contract validation."
    }
} finally {
    Pop-Location
}

$adbArgs = @()
if ($Serial) { $adbArgs += @("-s", $Serial) }
$state = (& $adbPath @adbArgs get-state 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $state -ne "device") {
    throw "The selected Android device is not ready."
}

$remoteTemp = "/data/local/tmp/wuliao-writing-private-samples-seed.json"
$privateRelativePath = "no_backup/writing-private-samples-seed.json"
try {
    & $adbPath @adbArgs push $resolvedInput $remoteTemp | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Unable to stage the seed on the Android device." }
    & $adbPath @adbArgs shell run-as $PackageName mkdir -p no_backup | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "The installed app is not a debuggable build or no_backup cannot be opened." }
    & $adbPath @adbArgs shell run-as $PackageName cp $remoteTemp $privateRelativePath | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Unable to copy the seed into the app-private no_backup directory." }
    $privateListing = (& $adbPath @adbArgs shell run-as $PackageName ls -l $privateRelativePath 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $privateListing -notmatch "writing-private-samples-seed\.json") {
        throw "The app-private seed could not be verified."
    }
} finally {
    & $adbPath @adbArgs shell rm -f $remoteTemp | Out-Null
}

& $adbPath @adbArgs shell am force-stop $PackageName | Out-Null
& $adbPath @adbArgs shell monkey -p $PackageName -c android.intent.category.LAUNCHER 1 | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Seed copied, but the app could not be relaunched automatically." }

[pscustomobject]@{
    Status = "seeded"
    Package = $PackageName
    Device = $(if ($Serial) { $Serial } else { "default" })
    ImportedItemCandidates = @($payload.items).Count
    PrivateDestination = $privateRelativePath
}
