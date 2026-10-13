$ErrorActionPreference = "Stop"
if ($args.Count -gt 0) { throw "Only the unified full-content APK is supported; no build switches are accepted." }

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

# Inject app version / build number / git commit for Vite env (no app logic change).
$gradleFile = Join-Path $projectRoot "android\app\build.gradle"
$gradleText = Get-Content -LiteralPath $gradleFile -Raw
$versionName = [regex]::Match($gradleText, 'versionName\s+"([^"]+)"').Groups[1].Value
$versionCode = [regex]::Match($gradleText, 'versionCode\s+(\d+)').Groups[1].Value
$env:VITE_APP_VERSION = if ($versionName) { $versionName } else { "0.1.0" }
$env:VITE_APP_BUILD = $versionCode
$env:VITE_TOOLS_ONLY = "0"
$gitHash = git rev-parse --short HEAD 2>$null
if ($LASTEXITCODE -eq 0 -and $gitHash) {
  $env:VITE_GIT_COMMIT = $gitHash.Trim()
}

Push-Location $projectRoot
try {
  if (Get-Command pnpm -ErrorAction SilentlyContinue) {
    & pnpm build
  } else {
    & corepack pnpm build
  }
  if ($LASTEXITCODE -ne 0) { throw "Web build failed." }

  if (Get-Command pnpm -ErrorAction SilentlyContinue) {
    & pnpm exec cap sync android
  } else {
    & corepack pnpm exec cap sync android
  }
  if ($LASTEXITCODE -ne 0) { throw "Capacitor sync failed." }

  $hasReadableStreamCompat = Get-ChildItem -LiteralPath $androidAssets -Filter "*.js" |
    Select-String -Pattern "Symbol\.asyncIterator" -Quiet
  if (-not $hasReadableStreamCompat) {
    throw "Android assets are missing the ReadableStream compatibility layer."
  }

  & $gradle --project-dir (Join-Path $projectRoot "android") assembleDebug
  if ($LASTEXITCODE -ne 0) { throw "Android APK build failed." }

  & (Join-Path $PSScriptRoot "verify-android-apk.ps1") -ApkPath $apkSource

  New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
  Copy-Item -LiteralPath $apkSource -Destination $apkTarget -Force
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [System.IO.Compression.ZipFile]::OpenRead($apkTarget)
  try {
    $readingPdfs = @($archive.Entries | Where-Object { $_.FullName -match '^assets/public/library/.+\.pdf$' }).Count
    $writingFiles = @($archive.Entries | Where-Object { $_.FullName -match '^assets/public/writing/.+' -and $_.Length -gt 0 }).Count
    if ($readingPdfs -eq 0 -or $writingFiles -eq 0) { throw "Bundled reading / Writing resources are missing; publication stopped." }
  } finally { $archive.Dispose() }
  $apkHash = (Get-FileHash -LiteralPath $apkTarget -Algorithm SHA256).Hash.ToLowerInvariant()
  $metadata = [ordered]@{
    package = "com.wuliao.english"; versionName = $versionName; versionCode = [int]$versionCode
    apkFileName = [System.IO.Path]::GetFileName($apkTarget); apkBytes = (Get-Item -LiteralPath $apkTarget).Length
    apkSha256 = $apkHash; minSdkVersion = 24; contentVariant = "full"
    bundledReadingPdfs = $readingPdfs; bundledWritingFiles = $writingFiles
  }
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText((Join-Path $outputDirectory "APK-metadata.json"), ($metadata | ConvertTo-Json), $utf8)
  [System.IO.File]::WriteAllText((Join-Path $outputDirectory "SHA256SUMS.txt"), "$apkHash  $([System.IO.Path]::GetFileName($apkTarget))`n", $utf8)
  $writingCatalog = Get-Content -LiteralPath (Join-Path $projectRoot "src\writing\generatedWritingSampleCatalog.js") -Raw
  $catalogVersion = [regex]::Match($writingCatalog, '"catalogVersion":\s*"([^"]+)"').Groups[1].Value
  $catalogHash = [regex]::Match($writingCatalog, '"contentHash":\s*"([0-9a-f]{64})"').Groups[1].Value
  $catalogItems = ([regex]::Matches($writingCatalog, '"referenceEssay":')).Count
  Write-Output "App: $versionName / versionCode $versionCode"
  Write-Output "Unified distribution: bundled reading, cloze and Writing content."
  Write-Output "Writing sample catalog: $catalogVersion"
  Write-Output "Items: $catalogItems"
  Write-Output "SHA-256: $catalogHash"
  Write-Output $apkTarget
} finally {
  Pop-Location
}
