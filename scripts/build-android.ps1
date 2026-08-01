$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$jdkRoot = Get-ChildItem -LiteralPath (Join-Path $projectRoot ".android-toolchain\jdk") -Directory |
  Select-Object -First 1 -ExpandProperty FullName
$sdkRoot = Join-Path $projectRoot ".android-sdk"
$gradle = Join-Path $projectRoot "android\gradlew.bat"
$apkSource = Join-Path $projectRoot "android\app\build\outputs\apk\debug\app-debug.apk"
$androidAssets = Join-Path $projectRoot "android\app\src\main\assets\public\assets"
$outputDirectory = Join-Path $projectRoot "output\android"
$apkTarget = Join-Path $outputDirectory "wuliao-english-android.apk"

if (-not $jdkRoot -or -not (Test-Path (Join-Path $jdkRoot "bin\java.exe"))) {
  throw "Local Android JDK is missing."
}
if (-not (Test-Path (Join-Path $sdkRoot "platforms\android-36"))) {
  throw "Local Android SDK platform 36 is missing."
}

$env:JAVA_HOME = $jdkRoot
$env:ANDROID_HOME = $sdkRoot
$env:ANDROID_SDK_ROOT = $sdkRoot

Push-Location $projectRoot
try {
  & pnpm build
  if ($LASTEXITCODE -ne 0) { throw "Web build failed." }

  & pnpm exec cap sync android
  if ($LASTEXITCODE -ne 0) { throw "Capacitor sync failed." }

  $hasReadableStreamCompat = Get-ChildItem -LiteralPath $androidAssets -Filter "*.js" |
    Select-String -Pattern "Symbol\.asyncIterator" -Quiet
  if (-not $hasReadableStreamCompat) {
    throw "Android assets are missing the ReadableStream compatibility layer."
  }

  & $gradle --project-dir (Join-Path $projectRoot "android") assembleDebug
  if ($LASTEXITCODE -ne 0) { throw "Android APK build failed." }

  New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
  Copy-Item -LiteralPath $apkSource -Destination $apkTarget -Force
  Write-Output $apkTarget
} finally {
  Pop-Location
}
