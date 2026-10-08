param(
  [Parameter(Mandatory = $true)]
  [string]$ApkPath
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$jdkRoot = Get-ChildItem -LiteralPath (Join-Path $projectRoot ".android-toolchain\jdk") -Directory |
  Select-Object -First 1 -ExpandProperty FullName
$java = Join-Path $jdkRoot "bin\java.exe"
$apksigner = Join-Path $projectRoot ".android-sdk\build-tools\36.0.0\lib\apksigner.jar"
$apk = (Resolve-Path -LiteralPath $ApkPath).Path

# The certificate of previously installed com.wuliao.english builds.
# A different key cannot replace the installed app while retaining its data.
$expectedCertificate = "cb65f9a54422b71a791dddda1bdff301818d5ee7a34fddf839ff5d33e4e2330a"
# Probe below API 24 so apksigner actually verifies v1 instead of selecting v2.
# This only checks signatures; the app still requires Android 7.0 / API 24.
$verification = & $java -jar $apksigner verify --verbose --print-certs --min-sdk-version 23 $apk 2>&1
if ($LASTEXITCODE -ne 0) {
  throw "APK signature verification failed: $($verification -join [Environment]::NewLine)"
}

foreach ($scheme in @("v1", "v2", "v3")) {
  if (-not ($verification -match "^Verified using $scheme scheme .*: true$")) {
    throw "APK is missing a valid $scheme signature. Rebuild with compatible signing enabled."
  }
}
if (-not ($verification -match "^Number of signers: 1$")) {
  throw "APK must have exactly one signer matching the installed app."
}
$certificate = [regex]::Match(($verification -join "`n"),
  '(?m)^Signer #1 certificate SHA-256 digest: ([0-9a-f]{64})\r?$').Groups[1].Value
if ($certificate -ne $expectedCertificate) {
  throw "APK certificate differs from the installed app. Reuse the original local signing key; do not uninstall or clear app data."
}

Write-Output $verification
Write-Output "APK signing check passed: v1/v2/v3 and the existing installation certificate."
