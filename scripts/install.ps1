<#
.SYNOPSIS
Installs F_Record into every Photoshop 2020-2026 installation on this machine.

.DESCRIPTION
Finds each Photoshop, reads its real version from Photoshop.exe, and copies the
matching panel build plus the capture plug-in into it:

    Photoshop 2020        -> the 'legacy' panel  (CEP 9, Chromium 61)
    Photoshop 2021..2026  -> the 'modern' panel  (CEP 10/11/12)

ffmpeg is no longer shipped inside the package. This script uses whatever
ffmpeg is already on the machine, and downloads one from BtbN/FFmpeg-Builds
only when there is none.

Photoshop's own preferences are only *reported* on, never edited: the two
switches involved take seconds to flip by hand, and writing Photoshop's
preference files badly can damage a user's whole configuration.

.PARAMETER Path
Install into one specific Photoshop folder instead of every one found.

.PARAMETER DevMode
Also sets PlayerDebugMode under HKCU:\Software\Adobe\CSXS.* so an unsigned
development build will load. Release builds are signed and do not need this.
Off by default, and it only ever touches the current user's own registry hive.

.PARAMETER SkipFfmpeg
Do not look for or download ffmpeg. The panel and the capture plug-in install
as usual; exporting will not work until an ffmpeg is available.

.PARAMETER WhatIf
Report what would be installed without changing anything.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\install.ps1
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [string] $Path,
    [switch] $DevMode,
    [switch] $SkipFfmpeg
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $scriptDir 'photoshop.ps1')

# dist/ sits next to scripts/ in the repo, and one level up in a release zip.
$distRoot = $null
foreach ($candidate in @((Join-Path $scriptDir '..\dist'), (Join-Path $scriptDir '..'))) {
    $resolved = [System.IO.Path]::GetFullPath($candidate)
    if ((Test-Path (Join-Path $resolved 'generator')) -and (Test-Path (Join-Path $resolved 'cep-modern'))) {
        $distRoot = $resolved
        break
    }
}

if (-not $distRoot) {
    Write-Host 'Could not find the built files.' -ForegroundColor Red
    Write-Host 'Run "npm run build" first, or run this script from inside the release zip.' -ForegroundColor Red
    exit 1
}

# A -WhatIf run changes nothing, so it must not demand administrator rights.
if (-not $WhatIfPreference) {
    if (Request-Elevation -ScriptPath $MyInvocation.MyCommand.Path -Arguments $(
            @() + $(if ($Path) { @('-Path', "`"$Path`"") } else { @() }) +
                  $(if ($DevMode) { @('-DevMode') } else { @() }) +
                  $(if ($SkipFfmpeg) { @('-SkipFfmpeg') } else { @() })
        )) {
        exit 0
    }
}

Write-Host 'F_Record installer' -ForegroundColor Green
Write-Host "Source: $distRoot" -ForegroundColor DarkGray

$installations = @(Get-PhotoshopInstallations)
if ($Path) {
    $wanted = $Path.TrimEnd('\').ToLowerInvariant()
    $installations = @($installations | Where-Object { $_.Path.TrimEnd('\').ToLowerInvariant() -eq $wanted })
    if ($installations.Count -eq 0) {
        Write-Host "No Photoshop installation found at: $Path" -ForegroundColor Red
        exit 1
    }
}

if ($installations.Count -eq 0) {
    Write-Host ''
    Write-Host 'No Photoshop installation was found.' -ForegroundColor Red
    Write-Host 'Looked in the registry and under Program Files\Adobe. If Photoshop lives' -ForegroundColor Yellow
    Write-Host 'somewhere else, point at it directly:' -ForegroundColor Yellow
    Write-Host '    install.ps1 -Path "D:\Adobe Photoshop 2024"' -ForegroundColor Yellow
    exit 1
}

Write-Section 'Photoshop installations found'
foreach ($ps in $installations) {
    $note = if ($ps.Supported) { "-> $($ps.Variant) build" } else { 'unsupported (needs 2020 or newer)' }
    Write-Host ("  {0,-6} {1,-8} {2}" -f $ps.Year, $ps.Version, $note)
    Write-Host ("         {0}" -f $ps.Path) -ForegroundColor DarkGray
}

function Copy-Tree {
    param([string] $Source, [string] $Destination)
    if (Test-Path -LiteralPath $Destination) {
        Remove-Item -LiteralPath $Destination -Recurse -Force
    }
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    Copy-Item -Path (Join-Path $Source '*') -Destination $Destination -Recurse -Force
}

# ------------------------------------------------------------------ ffmpeg

# 4.0.0 shipped a 75 MB ffmpeg.exe inside the release, which made the download
# almost entirely third-party binary for a plugin whose own code is 419 KB.
# It is now obtained here: used from wherever it already is, or downloaded once.
#
# Installed per machine rather than per Photoshop -- someone with 2020, 2024
# and 2026 side by side would otherwise get three copies of the same binary.
# cep/src/node/locate.ts searches this exact path.
$script:FfmpegDir = Join-Path $env:ProgramData 'F_Record\ffmpeg'
$script:FfmpegExe = Join-Path $script:FfmpegDir 'ffmpeg.exe'

# Pinned deliberately. FFmpeg.org ships no Windows binaries of its own and
# links to third-party builders instead; BtbN is one of the two it lists.
$script:FfmpegApi = 'https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest'

function Find-ExistingFfmpeg {
    if (Test-Path -LiteralPath $script:FfmpegExe) { return $script:FfmpegExe }

    $onPath = @(Get-Command 'ffmpeg.exe' -CommandType Application -ErrorAction SilentlyContinue)
    if ($onPath.Count -gt 0) { return $onPath[0].Source }

    $others = @()
    if ($env:LOCALAPPDATA) { $others += (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\ffmpeg.exe') }
    if ($env:ProgramData)  { $others += (Join-Path $env:ProgramData 'chocolatey\bin\ffmpeg.exe') }
    if ($env:ProgramFiles) { $others += (Join-Path $env:ProgramFiles 'ffmpeg\bin\ffmpeg.exe') }
    $others += 'C:\ffmpeg\bin\ffmpeg.exe'
    foreach ($candidate in $others) {
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    return $null
}

<#
Picks the newest stable release branch, static build.

The 'latest' release carries both master snapshots and the release branches;
only the branch builds (ffmpeg-nX.Y-...) are stable. Static rather than shared
because it is one self-contained exe -- the shared build needs a folder of DLLs
beside it, and a binary that cannot find its DLLs is exactly how Photoshop's
own convert.exe fails on 2026.
#>
function Get-FfmpegAsset {
    $headers = @{ 'User-Agent' = 'F_Record-installer'; 'Accept' = 'application/vnd.github+json' }
    $release = Invoke-RestMethod -Uri $script:FfmpegApi -UseBasicParsing -TimeoutSec 30 -Headers $headers

    $best = $null
    $bestVersion = $null
    foreach ($asset in $release.assets) {
        if ($asset.name -match '^ffmpeg-n(\d+)\.(\d+)-latest-win64-gpl-\d+\.\d+\.zip$') {
            $version = [version]("{0}.{1}" -f $Matches[1], $Matches[2])
            if ($null -eq $bestVersion -or $version -gt $bestVersion) {
                $bestVersion = $version
                $best = $asset
            }
        }
    }
    if ($null -eq $best) {
        throw 'No stable win64 build was listed in the BtbN release; the naming may have changed.'
    }

    # The digest field is newer than this script should assume. StrictMode
    # makes a plain .digest throw when it is absent, so ask the property bag.
    $sha = $null
    $property = $best.PSObject.Properties['digest']
    if ($property -and $property.Value) {
        $digest = [string]$property.Value
        if ($digest.StartsWith('sha256:')) { $sha = $digest.Substring(7).ToLowerInvariant() }
    }

    return [pscustomobject]@{
        Name    = $best.name
        Url     = $best.browser_download_url
        Size    = [int64]$best.size
        Sha256  = $sha
        Version = $bestVersion
    }
}

function Install-Ffmpeg {
    $existing = Find-ExistingFfmpeg
    if ($existing) {
        Write-Host "  Found      $existing" -ForegroundColor Green
        Write-Host '  Already available, nothing to download.' -ForegroundColor DarkGray
        return $true
    }

    Write-Host '  No ffmpeg found on this machine.' -ForegroundColor Yellow

    if (-not $PSCmdlet.ShouldProcess($script:FfmpegExe, 'Download and install ffmpeg')) {
        return $true
    }

    $temp = Join-Path ([System.IO.Path]::GetTempPath()) ('f_record_ffmpeg_' + [guid]::NewGuid().ToString('N') + '.zip')
    try {
        # PowerShell 5.1 still defaults to TLS 1.0, which GitHub refuses.
        try {
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        } catch {
            # Newer hosts negotiate this themselves.
        }

        Write-Host '  Asking BtbN/FFmpeg-Builds for the latest stable build...' -ForegroundColor DarkGray
        $asset = Get-FfmpegAsset
        $mb = [math]::Round($asset.Size / 1MB)
        Write-Host "  $($asset.Name)  ($mb MB)" -ForegroundColor DarkGray
        Write-Host '  Downloading. This is a large file and can take a few minutes...' -ForegroundColor DarkGray

        # The progress bar makes Invoke-WebRequest many times slower.
        $previousProgress = $ProgressPreference
        $ProgressPreference = 'SilentlyContinue'
        try {
            Invoke-WebRequest -Uri $asset.Url -OutFile $temp -UseBasicParsing -TimeoutSec 1800 -Headers @{ 'User-Agent' = 'F_Record-installer' }
        } finally {
            $ProgressPreference = $previousProgress
        }

        if ($asset.Sha256) {
            $actual = (Get-FileHash -LiteralPath $temp -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($actual -ne $asset.Sha256) {
                throw "Checksum mismatch: expected $($asset.Sha256), got $actual. The download was discarded."
            }
            Write-Host '  SHA-256 verified.' -ForegroundColor DarkGray
        } else {
            Write-Host '  GitHub published no checksum for this asset; skipping verification.' -ForegroundColor Yellow
        }

        # Pull out just bin/ffmpeg.exe: the archive also carries ffplay and
        # ffprobe, which this plugin has no use for.
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        New-Item -ItemType Directory -Path $script:FfmpegDir -Force | Out-Null
        $zip = [System.IO.Compression.ZipFile]::OpenRead($temp)
        try {
            $entry = $zip.Entries | Where-Object { $_.FullName -match '(^|/)bin/ffmpeg\.exe$' } | Select-Object -First 1
            if ($null -eq $entry) { throw 'The archive did not contain bin/ffmpeg.exe.' }
            [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $script:FfmpegExe, $true)
        } finally {
            $zip.Dispose()
        }

        Write-Host "  Installed  $script:FfmpegExe" -ForegroundColor Green
        return $true
    } catch {
        Write-Host ''
        Write-Host '  ffmpeg could not be installed.' -ForegroundColor Red
        Write-Host "  $($_.Exception.Message)" -ForegroundColor Red
        Write-Host ''
        Write-Host '  The panel and the capture plug-in still install, but exporting a' -ForegroundColor Yellow
        Write-Host '  video will not work until ffmpeg is available.' -ForegroundColor Yellow
        Write-Host ''
        Write-Host '  Please install ffmpeg yourself, then run this installer again:' -ForegroundColor Yellow
        Write-Host '    1. Download a win64 build from' -ForegroundColor Yellow
        Write-Host '       https://github.com/BtbN/FFmpeg-Builds/releases' -ForegroundColor Yellow
        Write-Host "    2. Put ffmpeg.exe at $script:FfmpegExe" -ForegroundColor Yellow
        Write-Host '       (anywhere on PATH works too)' -ForegroundColor Yellow
        return $false
    } finally {
        if (Test-Path -LiteralPath $temp) {
            Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
        }
    }
}

Write-Section 'ffmpeg'
$ffmpegOk = $true
if ($SkipFfmpeg) {
    Write-Host '  Skipped at your request (-SkipFfmpeg).' -ForegroundColor DarkGray
} else {
    $ffmpegOk = Install-Ffmpeg
}

# --------------------------------------------------------------- the panels

$installed = 0
$failed = 0

foreach ($ps in $installations) {
    Write-Section "Photoshop $($ps.Year)  ($($ps.Version))"

    if (-not $ps.Supported) {
        Write-Host '  Skipped: F_Record requires Photoshop 2020 or newer.' -ForegroundColor Yellow
        continue
    }

    $panelSource = Join-Path $distRoot ("cep-" + $ps.Variant + "\" + $script:CepFolderName)
    $generatorSource = Join-Path $distRoot ("generator\" + $script:GeneratorFolderName)

    if (-not (Test-Path -LiteralPath $panelSource)) {
        Write-Host "  Missing build: $panelSource" -ForegroundColor Red
        $failed++
        continue
    }

    try {
        # Photoshop does not always ship a Plug-ins\Generator folder; creating
        # it is expected and is exactly what the old manual instructions asked
        # users to do by hand.
        foreach ($dir in @($ps.CepDir, $ps.GeneratorDir)) {
            if (-not (Test-Path -LiteralPath $dir)) {
                if ($PSCmdlet.ShouldProcess($dir, 'Create folder')) {
                    New-Item -ItemType Directory -Path $dir -Force | Out-Null
                }
                Write-Host "  Created $dir" -ForegroundColor DarkGray
            }
        }

        if ($PSCmdlet.ShouldProcess($ps.CepTarget, "Install $($ps.Variant) panel")) {
            Copy-Tree -Source $panelSource -Destination $ps.CepTarget
        }
        Write-Host "  Panel      $($ps.Variant) -> $($ps.CepTarget)" -ForegroundColor Green

        if ($PSCmdlet.ShouldProcess($ps.GenTarget, 'Install capture plug-in')) {
            Copy-Tree -Source $generatorSource -Destination $ps.GenTarget
        }
        Write-Host "  Capture    -> $($ps.GenTarget)" -ForegroundColor Green

        $installed++
    } catch {
        Write-Host "  Failed: $($_.Exception.Message)" -ForegroundColor Red
        $failed++
    }
}

if ($DevMode) {
    Write-Section 'Developer mode'
    Write-Host '  Allowing unsigned extensions to load for the current user.' -ForegroundColor Yellow
    # CSXS 9..12 covers Photoshop 2020 through 2026.
    foreach ($n in 9..12) {
        $key = "HKCU:\Software\Adobe\CSXS.$n"
        if ($PSCmdlet.ShouldProcess($key, 'Set PlayerDebugMode=1')) {
            if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
            Set-ItemProperty -Path $key -Name 'PlayerDebugMode' -Value '1' -Type String
        }
        Write-Host "  $key\PlayerDebugMode = 1" -ForegroundColor DarkGray
    }
}

Write-Section 'Next steps'

if ($installed -eq 0) {
    Write-Host '  Nothing was installed.' -ForegroundColor Red
    exit 1
}

Write-Host "  Installed into $installed Photoshop installation(s)." -ForegroundColor Green
Write-Host ''
Write-Host '  1. Quit Photoshop completely, then start it again.'
Write-Host '  2. Check Edit > Preferences > Plug-ins:'
Write-Host '       - "Enable Generator" must be ticked   (this is what does the recording)'
Write-Host '       - "Load Extension Panels" must be ticked, under Legacy Extensions'
Write-Host '     If you had to tick either one, restart Photoshop again.'
Write-Host '  3. Open the panel from Window > Extensions (legacy) > F_Record.'
Write-Host ''
Write-Host '  Recording runs in the background, so once it is switched on the panel'
Write-Host '  does not need to stay open. Turn on "Start recording when Photoshop opens"'
Write-Host '  in Settings and you never have to touch it again.'

if (-not $ffmpegOk) {
    Write-Host ''
    Write-Host '  Recording works, but exporting does not: ffmpeg is still missing.' -ForegroundColor Yellow
    Write-Host '  Install it and run this installer again (see the ffmpeg section above).' -ForegroundColor Yellow
}

if ($failed -gt 0) {
    Write-Host ''
    Write-Host "  $failed installation(s) failed -- see the errors above." -ForegroundColor Red
    exit 1
}

Write-Host ''
Write-Host '  If anything misbehaves, run scripts\doctor.ps1 for a diagnosis.' -ForegroundColor DarkGray
exit 0
