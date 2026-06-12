#requires -version 5.1
<#
.SYNOPSIS
  Run the FancyMumble e2e suite locally in HEADED mode (visible app window).

.DESCRIPTION
  Orchestrates a local run: (optionally) build the client binary, bring the
  Docker server up, run mocha with a VISIBLE window (no xvfb / no headless),
  then tear the server down. On Windows the app is the Edge WebView2 window
  driven via msedgedriver.

.PARAMETER Build
  (Re)build the client binary first. Implied when no binary exists.

.PARAMETER Grep
  Only run tests whose title matches this pattern (mocha --grep). Handy for
  watching a single scenario, e.g. -Grep "smoke".

.PARAMETER Bin
  Use an existing client binary at this path (sets E2E_APP_BIN); skips building.

.PARAMETER KeepServer
  Leave the Docker server running afterwards (skip teardown).

.EXAMPLE
  ./scripts/run-local.ps1 -Build

.EXAMPLE
  ./scripts/run-local.ps1 -Grep "smoke" -KeepServer
#>
[CmdletBinding()]
param(
  [switch]$Build,
  [string]$Grep,
  [string]$Bin,
  [switch]$KeepServer
)

$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $repo

function Have($name) { [bool](Get-Command $name -ErrorAction SilentlyContinue) }
function Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

# -- preflight --------------------------------------------------------------
if (-not (Have docker)) { throw "docker not found on PATH" }
if (-not (Have node))   { throw "node not found on PATH" }
if (-not (Have tauri-driver)) {
  throw "tauri-driver not found. Install with: cargo install tauri-driver --locked"
}
if (-not (Have msedgedriver)) {
  Write-Warning ("msedgedriver not on PATH. tauri-driver needs it on Windows " +
    "(match your Edge / WebView2 version): " +
    "https://developer.microsoft.com/microsoft-edge/tools/webdriver/  " +
    "Or set `$env:E2E_NATIVE_DRIVER to its full path.")
}

$exe = "mumble-tauri.exe"
$binPath = if ($Bin) { $Bin } else { Join-Path $repo "vendor/client/target/release/$exe" }
if ($Bin) { $env:E2E_APP_BIN = $Bin }

# -- node deps --------------------------------------------------------------
if (-not (Test-Path (Join-Path $repo "node_modules"))) {
  Step "Installing e2e dependencies"
  npm ci; if ($LASTEXITCODE) { throw "npm ci failed" }
}

# -- build the client binary (visible-window build is the normal release) ---
if ($Build -or -not (Test-Path $binPath)) {
  if ($Bin) { throw "No binary at -Bin path: $Bin" }
  Step "Building client frontend (this takes a few minutes)"
  Push-Location (Join-Path $repo "vendor/client/crates/mumble-tauri/ui")
  try {
    npm ci; if ($LASTEXITCODE) { throw "frontend npm ci failed" }
    npm run build; if ($LASTEXITCODE) { throw "frontend build failed" }
  } finally { Pop-Location }

  Step "Building client binary (cargo tauri build --no-bundle)"
  Push-Location (Join-Path $repo "vendor/client")
  try {
    cargo tauri build --no-bundle; if ($LASTEXITCODE) { throw "cargo tauri build failed" }
  } finally { Pop-Location }
}
if (-not (Test-Path $binPath)) { throw "Client binary missing at $binPath (use -Build or -Bin)" }

# -- server up --------------------------------------------------------------
$compose = "fixtures/docker-compose.e2e.yml"
Step "Starting Mumble test server"
docker compose -f $compose up -d --wait
if ($LASTEXITCODE) { throw "docker compose up failed" }

$code = 0
try {
  Step "Running e2e suite (headed - a window will open)"
  $testArgs = @("--import", "tsx", "--test", "--test-isolation=none")
  if ($Grep) { $testArgs += @("--test-name-pattern", $Grep) }
  $testArgs += "src/tests/**/*.test.ts"
  node @testArgs
  $code = $LASTEXITCODE
} finally {
  if ($KeepServer) {
    Write-Host "Leaving server running (-KeepServer). Stop with: docker compose -f $compose down -v"
  } else {
    Step "Stopping Mumble test server"
    docker compose -f $compose down -v
  }
}

exit $code
