<#
.SYNOPSIS
Diagnoses a F_Record installation.

.DESCRIPTION
Answers the question "why did it stop recording?" without needing to know where
Photoshop hides its logs. Reports each Photoshop found, whether both halves of
the plug-in are installed and which build variant, whether the capture engine is
currently running, and the tail of its log.

Read-only: it changes nothing and needs no administrator rights.

.PARAMETER LogLines
How many log lines to print. Default 30.
#>
[CmdletBinding()]
param(
    [int] $LogLines = 30
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $scriptDir 'photoshop.ps1')

Write-Host 'F_Record doctor' -ForegroundColor Green
Write-Host ("{0}  |  PowerShell {1}" -f [datetime]::Now.ToString('yyyy-MM-dd HH:mm:ss'), $PSVersionTable.PSVersion) -ForegroundColor DarkGray

Write-Section 'Photoshop installations'

$installations = @(Get-PhotoshopInstallations)
if ($installations.Count -eq 0) {
    Write-Host '  None found.' -ForegroundColor Red
    Write-Host '  Looked in HKLM:\SOFTWARE\Adobe\Photoshop and under Program Files\Adobe.' -ForegroundColor Yellow
}

$anyInstalled = $false

foreach ($ps in $installations) {
    # CEP version, which determines the Chromium and Node the panel gets.
    $cepVersion = 'unknown'
    $cefVersion = ''
    $engine = Join-Path $ps.Path 'Required\CEP\CEPHtmlEngine\CEPHtmlEngine.exe'
    if (Test-Path -LiteralPath $engine) {
        try { $cepVersion = (Get-Item -LiteralPath $engine).VersionInfo.FileVersion } catch { }
    }
    $libcef = Join-Path $ps.Path 'Required\CEP\CEPHtmlEngine\libcef.dll'
    if (Test-Path -LiteralPath $libcef) {
        try { $cefVersion = (Get-Item -LiteralPath $libcef).VersionInfo.FileVersion } catch { }
    }

    Write-Host ''
    Write-Host ("  Photoshop {0}  (version {1})" -f $ps.Year, $ps.Version) -ForegroundColor White
    Write-Host ("    Path            {0}" -f $ps.Path) -ForegroundColor DarkGray
    Write-Host ("    CEP             {0}{1}" -f $cepVersion, $(if ($cefVersion) { "  /  $cefVersion" } else { '' })) -ForegroundColor DarkGray
    Write-Host ("    Expected build  {0}" -f $ps.Variant) -ForegroundColor DarkGray

    # Generator itself: without convert.exe, generator-core refuses to start at
    # all, which would look exactly like the plug-in being broken.
    $convert = Join-Path $ps.Path 'convert.exe'
    $generatorCore = Join-Path $ps.Path 'Required\Generator-builtin'
    Write-Host ("    Generator core  {0}" -f $(if (Test-Path $generatorCore) { 'present' } else { 'MISSING' })) `
        -ForegroundColor $(if (Test-Path $generatorCore) { 'DarkGray' } else { 'Red' })
    Write-Host ("    convert.exe     {0}" -f $(if (Test-Path $convert) { 'present' } else { 'MISSING - Generator cannot start' })) `
        -ForegroundColor $(if (Test-Path $convert) { 'DarkGray' } else { 'Red' })

    # Our two halves.
    $panelOk = Test-Path -LiteralPath (Join-Path $ps.CepTarget 'index.html')
    $genOk = Test-Path -LiteralPath (Join-Path $ps.GenTarget 'index.js')

    if ($panelOk) {
        $installedVariant = 'unknown'
        $manifest = Join-Path $ps.CepTarget 'CSXS\manifest.xml'
        if (Test-Path -LiteralPath $manifest) {
            $text = Get-Content -LiteralPath $manifest -Raw
            if ($text -match '\[21\.0,21\.9\]') { $installedVariant = 'legacy' }
            elseif ($text -match '\[22\.0,99\.9\]') { $installedVariant = 'modern' }
        }
        $variantMatches = ($installedVariant -eq $ps.Variant)
        Write-Host ("    Panel           installed ({0} build)" -f $installedVariant) `
            -ForegroundColor $(if ($variantMatches) { 'Green' } else { 'Yellow' })
        if (-not $variantMatches -and $installedVariant -ne 'unknown') {
            Write-Host ("      ! expected the {0} build here; re-run install.ps1" -f $ps.Variant) -ForegroundColor Yellow
        }
    } else {
        Write-Host '    Panel           not installed' -ForegroundColor Yellow
    }

    Write-Host ("    Capture plug-in {0}" -f $(if ($genOk) { 'installed' } else { 'not installed' })) `
        -ForegroundColor $(if ($genOk) { 'Green' } else { 'Yellow' })

    if ($panelOk -and $genOk) { $anyInstalled = $true }

    if ($panelOk -and -not $genOk) {
        Write-Host '      ! The panel is installed but the capture plug-in is not.' -ForegroundColor Yellow
        Write-Host '        The panel will open and report "Generator not running".' -ForegroundColor Yellow
    }
}

Write-Section 'ffmpeg (export)'

# Mirrors the search order in cep/src/node/locate.ts. ffmpeg is no longer
# shipped inside the package, so "export does nothing" is now most often just
# "there is no ffmpeg on this machine" -- worth saying plainly.
$ffmpegFound = $null
$ffmpegVia = $null

$overridePath = $env:F_RECORD_FFMPEG
if ($overridePath -and (Test-Path -LiteralPath $overridePath)) {
    $ffmpegFound = $overridePath
    $ffmpegVia = 'F_RECORD_FFMPEG override'
}

if (-not $ffmpegFound) {
    $shared = Join-Path $env:ProgramData 'F_Record\ffmpeg\ffmpeg.exe'
    if (Test-Path -LiteralPath $shared) {
        $ffmpegFound = $shared
        $ffmpegVia = 'installed by install.ps1'
    }
}

if (-not $ffmpegFound) {
    $onPath = @(Get-Command 'ffmpeg.exe' -CommandType Application -ErrorAction SilentlyContinue)
    if ($onPath.Count -gt 0) {
        $ffmpegFound = $onPath[0].Source
        $ffmpegVia = 'on PATH'
    }
}

if (-not $ffmpegFound) {
    $others = @()
    if ($env:LOCALAPPDATA) { $others += (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\ffmpeg.exe') }
    if ($env:ProgramData)  { $others += (Join-Path $env:ProgramData 'chocolatey\bin\ffmpeg.exe') }
    if ($env:ProgramFiles) { $others += (Join-Path $env:ProgramFiles 'ffmpeg\bin\ffmpeg.exe') }
    $others += 'C:\ffmpeg\bin\ffmpeg.exe'
    foreach ($candidate in $others) {
        if (Test-Path -LiteralPath $candidate) {
            $ffmpegFound = $candidate
            $ffmpegVia = 'common install location'
            break
        }
    }
}

if ($ffmpegFound) {
    Write-Host ("  ffmpeg          {0}" -f $ffmpegFound) -ForegroundColor Green
    Write-Host ("                  ({0})" -f $ffmpegVia) -ForegroundColor DarkGray
    try {
        $versionLine = (& $ffmpegFound -hide_banner -version 2>&1 | Select-Object -First 1)
        Write-Host ("                  {0}" -f $versionLine) -ForegroundColor DarkGray
    } catch {
        Write-Host '                  ! found, but it would not run' -ForegroundColor Red
    }
} else {
    Write-Host '  ffmpeg          not found' -ForegroundColor Yellow
    Write-Host '                  Recording works; exporting a video does not.' -ForegroundColor Yellow
    Write-Host '                  Run install.cmd again to fetch it, or install' -ForegroundColor Yellow
    Write-Host '                  ffmpeg yourself and put it on PATH.' -ForegroundColor Yellow
}

Write-Section 'Capture engine'

$dataDir = Join-Path $env:APPDATA 'F_Record'
$bridgeFile = Join-Path $dataDir 'bridge.json'

if (Test-Path -LiteralPath $bridgeFile) {
    try {
        $bridge = Get-Content -LiteralPath $bridgeFile -Raw | ConvertFrom-Json
        $alive = $null -ne (Get-Process -Id $bridge.pid -ErrorAction SilentlyContinue)
        if ($alive) {
            Write-Host '  Running' -ForegroundColor Green
            Write-Host ("    Plug-in version {0}  (protocol {1})" -f $bridge.pluginVersion, $bridge.protocolVersion) -ForegroundColor DarkGray
            Write-Host ("    Listening on    127.0.0.1:{0}  (pid {1})" -f $bridge.port, $bridge.pid) -ForegroundColor DarkGray
            Write-Host ("    Started         {0}" -f ([datetimeoffset]::FromUnixTimeMilliseconds([long]$bridge.startedAt).LocalDateTime)) -ForegroundColor DarkGray
            # Which Node Photoshop handed the generator, and which compatibility
            # fallbacks that forced. Photoshop 2020 ships Node 8.6 and 2026
            # ships 22, and an export that only misbehaves on old Photoshop is
            # almost always one of these. StrictMode makes a plain property
            # access throw when an older bridge.json predates the field.
            $nodeProperty = $bridge.PSObject.Properties['node']
            if ($nodeProperty -and $nodeProperty.Value) {
                Write-Host ("    Runtime         {0}" -f $nodeProperty.Value) -ForegroundColor DarkGray
            }
        } else {
            Write-Host '  Not running: bridge.json is stale (that process has exited).' -ForegroundColor Yellow
            Write-Host '  This is normal when Photoshop is closed.' -ForegroundColor DarkGray
        }
    } catch {
        Write-Host "  bridge.json is unreadable: $($_.Exception.Message)" -ForegroundColor Red
    }
} else {
    Write-Host '  Not running (no bridge.json).' -ForegroundColor Yellow
    if ($anyInstalled) {
        Write-Host '  If Photoshop is open, check Edit > Preferences > Plug-ins > Enable Generator,' -ForegroundColor Yellow
        Write-Host '  then restart Photoshop.' -ForegroundColor Yellow
    }
}

Write-Section 'Settings and recordings'

if (Test-Path -LiteralPath $dataDir) {
    Write-Host ("  Data folder     {0}" -f $dataDir) -ForegroundColor DarkGray

    $configFile = Join-Path $dataDir 'config.json'
    $framesRoot = $null
    if (Test-Path -LiteralPath $configFile) {
        try {
            $config = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
            $framesRoot = $config.processImageFolderPath
            Write-Host ("    Recording       {0}" -f $(if ($config.enabled) { 'on' } else { 'off' })) `
                -ForegroundColor $(if ($config.enabled) { 'Green' } else { 'DarkGray' })
            Write-Host ("    Auto-start      {0}" -f $(if ($config.autoStart) { 'on' } else { 'off' })) -ForegroundColor DarkGray
            Write-Host ("    Resolution      {0}p, quality {1}, interval {2} ms" -f $config.resolution, $config.quality, $config.minIntervalMs) -ForegroundColor DarkGray
            Write-Host ("    Frames folder   {0}" -f $framesRoot) -ForegroundColor DarkGray
        } catch {
            Write-Host "    config.json is unreadable: $($_.Exception.Message)" -ForegroundColor Red
        }
    } else {
        Write-Host '    No config.json yet (the plug-in has never run).' -ForegroundColor DarkGray
    }

    if ($framesRoot -and (Test-Path -LiteralPath $framesRoot)) {
        $sessions = @(Get-ChildItem -LiteralPath $framesRoot -Directory -ErrorAction SilentlyContinue)
        $totalFrames = 0
        $totalBytes = 0
        foreach ($session in $sessions) {
            $frames = @(Get-ChildItem -LiteralPath $session.FullName -Filter '*.jpg' -ErrorAction SilentlyContinue)
            $totalFrames += $frames.Count
            foreach ($f in $frames) { $totalBytes += $f.Length }
        }
        Write-Host ("    Recordings      {0} session(s), {1} frames, {2:N1} MB" -f $sessions.Count, $totalFrames, ($totalBytes / 1MB)) -ForegroundColor DarkGray
    }
} else {
    Write-Host '  No data folder yet -- the plug-in has never run.' -ForegroundColor Yellow
}

Write-Section "Plug-in log (last $LogLines lines)"

$logFile = Join-Path $dataDir 'logs\generator.log'
if (Test-Path -LiteralPath $logFile) {
    Write-Host "  $logFile" -ForegroundColor DarkGray
    Write-Host ''
    Get-Content -LiteralPath $logFile -Tail $LogLines | ForEach-Object {
        $colour = if ($_ -match '\[ERROR\]') { 'Red' } elseif ($_ -match '\[WARN\]') { 'Yellow' } else { 'Gray' }
        Write-Host "  $_" -ForegroundColor $colour
    }
} else {
    Write-Host '  No log yet.' -ForegroundColor Yellow
}

Write-Section "Photoshop's own Generator log"

foreach ($ps in $installations) {
    $psLogDir = Join-Path $env:APPDATA "Adobe\Adobe Photoshop $($ps.Year)\Logs"
    if (-not (Test-Path -LiteralPath $psLogDir)) { continue }

    # Photoshop has moved these around between releases: some versions write
    # 'Generator*.log' straight into Logs, newer ones use a Logs\Generator
    # subdirectory. Search both, and only ever consider files.
    $searchDirs = @($psLogDir)
    $generatorSubdir = Join-Path $psLogDir 'Generator'
    if (Test-Path -LiteralPath $generatorSubdir -PathType Container) {
        $searchDirs += $generatorSubdir
    }

    $psLog = $searchDirs |
             ForEach-Object { Get-ChildItem -LiteralPath $_ -File -Filter '*enerator*' -ErrorAction SilentlyContinue } |
             Sort-Object LastWriteTime -Descending | Select-Object -First 1

    if (-not $psLog -and (Test-Path -LiteralPath $generatorSubdir -PathType Container)) {
        # The subdirectory's files are not always named "generator" themselves.
        $psLog = Get-ChildItem -LiteralPath $generatorSubdir -File -ErrorAction SilentlyContinue |
                 Sort-Object LastWriteTime -Descending | Select-Object -First 1
    }

    if ($psLog) {
        Write-Host ("  {0}" -f $psLog.FullName) -ForegroundColor DarkGray
        Get-Content -LiteralPath $psLog.FullName -Tail 10 -ErrorAction SilentlyContinue |
            ForEach-Object { Write-Host "    $_" -ForegroundColor Gray }
    }
}

Write-Host ''
Write-Host 'Done.' -ForegroundColor Green
