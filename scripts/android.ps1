<#
.SYNOPSIS
  Put the client on an Android device or emulator, for looking at the Nebula
  design pack by hand.

.DESCRIPTION
  Nebula is the default pack for a profile that has no stored preference
  (`ui/registry.ts`), so a *fresh install* opens in Nebula with nothing to
  configure. That is what -Fresh is for: it uninstalls first, so the run starts
  from that state rather than from whatever the last session left behind.

  Two modes:

    (default)  Build a debug APK, install it, launch it. Self-contained - the
               UI is bundled, so nothing has to keep running on this machine.
    -Dev       `cargo tauri android dev`: the Vite dev server with hot reload.
               Edits to ui/src land without a rebuild. Holds the terminal.
               Note the default (no -Dev) build CANNOT hot-reload: it bundles
               ui/dist into the APK and the webview loads tauri.localhost.

  The server is a separate terminal: `npm run server:android`.

.PARAMETER Avd
  Emulator to start if no device is attached. Defaults to the first AVD.

.PARAMETER Dev
  Hot-reload mode instead of an installed APK.

.PARAMETER DevHost
  With -Dev, override the address the dev server is reached on. Defaults to
  127.0.0.1, carried to the device by `adb reverse`, which is the only value
  that resolves from both this machine and the device. Only pass something else
  if you know why.

.PARAMETER Fresh
  Uninstall the app before installing, so it opens on a first-run profile.

.PARAMETER Logcat
  Follow the app's log after launching.

.PARAMETER Symbols
  Keep native debug symbols in the Rust library. Off by default: they make the
  APK ~40x larger, which an emulator will refuse to install.

.PARAMETER NoWatch
  With -Dev, pass --no-watch. The CLI then exits as soon as the app launches,
  leaving Vite running unsupervised - the terminal comes back and Ctrl+C has
  nothing to stop. Rarely what you want: the crate's .taurignore already keeps
  UI edits from triggering a rebuild.

.EXAMPLE
  ./scripts/android.ps1 -Fresh -Logcat
#>
[CmdletBinding()]
param(
    [string]$Avd,
    [switch]$Dev,
    [string]$DevHost,
    [switch]$Fresh,
    [switch]$Logcat,
    [switch]$Symbols,
    [switch]$NoWatch
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$tauriDir = Join-Path $repoRoot 'vendor/client/crates/mumble-tauri'
$appId = 'com.fancymumble.app'

if (-not $env:ANDROID_HOME) { throw 'ANDROID_HOME is not set - see vendor/client/ANDROID_DEV.md' }
$sdk = $env:ANDROID_HOME
$adb = Join-Path $sdk 'platform-tools/adb.exe'
$emulator = Join-Path $sdk 'emulator/emulator.exe'

# The Tauri CLI and the Gradle `rust` plugin both resolve the NDK from the
# environment. Pick the newest installed one rather than pinning a version the
# machine may not have: CI pins 27.0.12077973, which is not what is installed
# here, and a stale pin fails at link time with an unresolved libc++.
if (-not $env:NDK_HOME) {
    $ndk = Get-ChildItem (Join-Path $sdk 'ndk') -Directory |
        Sort-Object { [version]$_.Name } -Descending |
        Select-Object -First 1
    if (-not $ndk) { throw "No NDK under $sdk\ndk - install one via the SDK Manager" }
    $env:NDK_HOME = $ndk.FullName
}
$env:ANDROID_NDK_HOME = $env:NDK_HOME
Write-Host "NDK: $env:NDK_HOME" -ForegroundColor DarkGray

# A debug build carries full DWARF for the Rust library, and Gradle's debug
# packaging is told to keep it (`jniLibs.keepDebugSymbols`). That is a 430 MB
# libmumble_tauri_lib.so in a 438 MB APK, which an emulator with a used
# /data partition simply refuses: INSTALL_FAILED_INSUFFICIENT_STORAGE. Without
# the symbols it is a fortieth of that. They only buy native stack frames for
# Rust crashes, which is not what a UI pass is for - pass -Symbols to keep
# them (and expect a full rebuild, since this changes every crate's profile).
if (-not $Symbols) {
    $env:CARGO_PROFILE_DEV_DEBUG = '0'
    $env:CARGO_PROFILE_DEV_STRIP = 'symbols'
}

function Get-Device {
    # `adb devices` lists one device per line after a header; anything not in
    # state "device" (offline, unauthorized) is not usable yet.
    (& $adb devices) | Select-Object -Skip 1 |
        Where-Object { $_ -match '^(\S+)\s+device$' } |
        ForEach-Object { $Matches[1] } |
        Select-Object -First 1
}

$device = Get-Device
if (-not $device) {
    if (-not $Avd) {
        $avds = @(& $emulator -list-avds | Where-Object { $_ })
        if (-not $avds) { throw 'No device attached and no AVD to start - see vendor/client/ANDROID_DEV.md' }
        # Prefer Pixel_9: the other AVDs on this machine have 4-9 GB of /data
        # in use and refuse the install with INSTALL_FAILED_INSUFFICIENT_STORAGE,
        # which reads as a build problem and is not one.
        $Avd = if ($avds -contains 'Pixel_9') { 'Pixel_9' } else { $avds[0] }
    }
    Write-Host "No device attached; starting emulator $Avd..." -ForegroundColor Cyan
    Start-Process -FilePath $emulator -ArgumentList @('-avd', $Avd) -WindowStyle Normal

    & $adb wait-for-device
    # wait-for-device returns as soon as adb can talk to it, which is well
    # before the launcher is up; installing into that window fails with
    # "Package manager has died".
    $deadline = (Get-Date).AddMinutes(5)
    while ((Get-Date) -lt $deadline) {
        if ((& $adb shell getprop sys.boot_completed 2>$null) -match '1') { break }
        Start-Sleep -Seconds 2
    }
    $device = Get-Device
    if (-not $device) { throw 'Emulator did not come up' }
}
Write-Host "Device: $device" -ForegroundColor Cyan

if ($Fresh) {
    Write-Host "Uninstalling $appId (first-run profile => Nebula)..." -ForegroundColor Cyan
    & $adb -s $device uninstall $appId 2>&1 | Out-Null
}

Push-Location $tauriDir
try {
    if ($Dev) {
        # The dev-server address has to resolve from BOTH sides, and that is the
        # whole difficulty. The CLI polls the dev URL from *this machine* before
        # it will build, while the webview fetches it from *the device*. So
        # 10.0.2.2 (the emulator's alias for this host) hangs the CLI forever on
        # "Waiting for your frontend dev server to start", and a LAN address
        # needs the right adapter picked out of seven plus a firewall rule.
        #
        # 127.0.0.1 is the one address that works on both: here it is Vite, and
        # on the device `adb reverse` carries it back to Vite. That also covers
        # a phone on USB, where there is no LAN address to guess at.
        #
        # Windows makes the override compulsory: without --host the CLI replaces
        # devUrl with "the public network address" and prompts when the machine
        # has several, which a script cannot answer.
        $devHostToUse = if ($DevHost) { $DevHost } else { '127.0.0.1' }

        # 1420 belongs to the desktop `cargo tauri dev`, which cannot move: the
        # port is baked into `build.devUrl` in tauri.conf.json and Vite is
        # strictPort, so a desktop session whose port is occupied dies with
        # "Port 1420 is already in use" and nothing to configure. This one CAN
        # move - it passes its own devUrl - so it starts at 1421 and leaves
        # 1420 alone whether or not anything is on it right now. Taking a free
        # 1420 would only mean breaking the next desktop session that starts.
        $devPort = 1421
        while (Get-NetTCPConnection -LocalPort $devPort -State Listen -ErrorAction SilentlyContinue) {
            $devPort++
            if ($devPort -gt 1440) { throw 'No free port for the dev server in 1421-1440' }
        }
        $env:VITE_PORT = $devPort
        Write-Host "Vite on $devPort (1420 is left for a desktop 'cargo tauri dev')" -ForegroundColor DarkGray

        & $adb -s $device reverse "tcp:$devPort" "tcp:$devPort" | Out-Null
        $devUrl = "http://${devHostToUse}:$devPort"

        # The watcher stays ON. The crate's own `.taurignore` already keeps it
        # off `ui/`, so a UI edit reloads through Vite without a Rust rebuild,
        # and a Rust edit still rebuilds the way it should. --no-watch instead
        # makes the CLI exit the moment the app launches - the terminal comes
        # back, Vite is left orphaned with nothing supervising it, the next run
        # finds the port taken, and "Ctrl+C to stop" is a lie. -NoWatch is
        # there if you want that anyway.

        # --config takes a JSON string or a path, and the path is what survives:
        # PowerShell strips the inner double quotes when it hands a JSON literal
        # to a native exe, and the CLI rejects `{build:{devUrl:...}}`.
        # Written through .NET rather than Set-Content: Windows PowerShell's
        # `-Encoding utf8` prepends a BOM, and the CLI's JSON parser rejects it
        # with "expected value at line 1 column 1" - which reads like the file
        # is malformed rather than like it has three bytes too many.
        $configFile = Join-Path ([System.IO.Path]::GetTempPath()) 'fancy-android-dev.json'
        $configJson = @{ build = @{ devUrl = $devUrl } } | ConvertTo-Json -Compress
        [System.IO.File]::WriteAllText($configFile, $configJson, (New-Object System.Text.UTF8Encoding($false)))

        Write-Host "cargo tauri android dev -> $devUrl (Ctrl+C to stop)..." -ForegroundColor Cyan
        if ($NoWatch) {
            Write-Host 'Watcher off: UI edits reload through Vite; Rust edits need a re-run. The CLI exits once the app launches and Vite keeps serving.' -ForegroundColor DarkGray
        } else {
            Write-Host 'UI edits reload through Vite; Rust edits rebuild the app.' -ForegroundColor DarkGray
        }
        # One explicit array, splatted. A one-element array assigned out of an
        # `if` collapses to a bare string, and splatting that hands cargo a lone
        # "-" instead of "--no-watch".
        $devArgs = [System.Collections.ArrayList]@(
            'tauri', 'android', 'dev',
            '--host', $devHostToUse,
            '--config', $configFile
        )
        if ($NoWatch) { [void]$devArgs.Add('--no-watch') }
        & cargo @devArgs
        return
    }

    Write-Host 'Building debug APK (x86_64)...' -ForegroundColor Cyan
    # Gradle repackages an existing APK in place and can leave the previous
    # entries behind as slack - a 72 MB payload in a 438 MB file, which then
    # fails to install for want of room. Removing the output first is the
    # difference between a 64 MB APK and that.
    Remove-Item 'gen/android/app/build/outputs/apk' -Recurse -Force -ErrorAction SilentlyContinue
    & cargo tauri android build --apk --debug --target x86_64
    if ($LASTEXITCODE -ne 0) { throw "Android build failed ($LASTEXITCODE)" }

    $apk = Get-ChildItem 'gen/android/app/build/outputs/apk' -Recurse -Filter '*.apk' |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $apk) { throw 'Build reported success but produced no APK' }
    Write-Host "APK: $($apk.FullName)" -ForegroundColor DarkGray

    & $adb -s $device install -r $apk.FullName
    if ($LASTEXITCODE -ne 0) { throw "adb install failed ($LASTEXITCODE)" }
}
finally {
    Pop-Location
}

& $adb -s $device shell monkey -p $appId -c android.intent.category.LAUNCHER 1 | Out-Null
Write-Host ''
Write-Host 'Launched. Connect the client to:' -ForegroundColor Green
Write-Host '  host 10.0.2.2   port 64738   (emulator -> this machine)' -ForegroundColor Green
Write-Host '  start the server with: npm run server:android' -ForegroundColor Green

if ($Logcat) {
    & $adb -s $device logcat -c
    $appPid = (& $adb -s $device shell pidof -s $appId).Trim()
    if ($appPid) { & $adb -s $device logcat --pid=$appPid } else { & $adb -s $device logcat }
}
