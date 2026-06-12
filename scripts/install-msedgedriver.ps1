#requires -version 5.1
<#
.SYNOPSIS
  Download the Edge WebDriver (msedgedriver) matching the installed Edge into
  ./.tools/, where run-local.ps1 picks it up automatically.

.DESCRIPTION
  tauri-driver drives the app's Edge WebView2 window through msedgedriver, which
  must match your Edge major version. This detects that version and downloads
  the right driver. Pass -Version to override.

.EXAMPLE
  ./scripts/install-msedgedriver.ps1
.EXAMPLE
  ./scripts/install-msedgedriver.ps1 -Version 130.0.2849.68
#>
[CmdletBinding()]
param([string]$Version)

$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$toolsDir = Join-Path $repo ".tools"
New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null
$dest = Join-Path $toolsDir "msedgedriver.exe"

function Get-EdgeVersion {
  foreach ($key in @(
      'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Edge\BLBeacon',
      'HKLM:\SOFTWARE\Microsoft\Edge\BLBeacon',
      'HKCU:\SOFTWARE\Microsoft\Edge\BLBeacon')) {
    try { $v = (Get-ItemProperty $key -ErrorAction Stop).version; if ($v) { return $v } } catch {}
  }
  foreach ($exe in @(
      "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
      "${env:ProgramFiles}\Microsoft\Edge\Application\msedge.exe")) {
    if (Test-Path $exe) { return (Get-Item $exe).VersionInfo.ProductVersion }
  }
  return $null
}

if (-not $Version) { $Version = Get-EdgeVersion }
if (-not $Version) {
  throw "Could not detect the installed Edge version. Pass -Version <x.y.z.w> (see edge://settings/help)."
}
Write-Host "Edge version: $Version" -ForegroundColor Cyan

$zip = Join-Path $env:TEMP "edgedriver_win64_$Version.zip"
$urls = @(
  "https://msedgedriver.microsoft.com/$Version/edgedriver_win64.zip",
  "https://msedgedriver.azureedge.net/$Version/edgedriver_win64.zip"
)
$downloaded = $false
foreach ($url in $urls) {
  try {
    Write-Host "Downloading $url" -ForegroundColor Cyan
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
    $downloaded = $true; break
  } catch { Write-Warning "Failed: $($_.Exception.Message)" }
}
if (-not $downloaded) {
  throw ("Could not download msedgedriver for $Version. Download it manually from " +
    "https://developer.microsoft.com/microsoft-edge/tools/webdriver/ and place " +
    "msedgedriver.exe in $toolsDir")
}

$tmp = Join-Path $env:TEMP "edgedriver_$Version"
if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
Expand-Archive -Path $zip -DestinationPath $tmp -Force
Copy-Item (Join-Path $tmp "msedgedriver.exe") $dest -Force
Remove-Item $zip -Force
Remove-Item -Recurse -Force $tmp

Write-Host "Installed: $dest" -ForegroundColor Green
Write-Host "run-local.ps1 uses it automatically. To use it elsewhere: `$env:E2E_NATIVE_DRIVER='$dest'"
