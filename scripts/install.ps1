<#
.SYNOPSIS
Installs F_Record into every Photoshop 2020-2026 installation on this machine.

.DESCRIPTION
Finds each Photoshop, reads its real version from Photoshop.exe, and copies the
matching panel build plus the capture plug-in into it:

    Photoshop 2020        -> the 'legacy' panel  (CEP 9, Chromium 61)
    Photoshop 2021..2026  -> the 'modern' panel  (CEP 10/11/12)

Photoshop's own preferences are only *reported* on, never edited: the two
switches involved take seconds to flip by hand, and writing Photoshop's
preference files badly can damage a user's whole configuration.

.PARAMETER Path
Install into one specific Photoshop folder instead of every one found.

.PARAMETER DevMode
Also sets PlayerDebugMode under HKCU:\Software\Adobe\CSXS.* so an unsigned
development build will load. Release builds are signed and do not need this.
Off by default, and it only ever touches the current user's own registry hive.

.PARAMETER WhatIf
Report what would be installed without changing anything.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\install.ps1
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [string] $Path,
    [switch] $DevMode
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
                  $(if ($DevMode) { @('-DevMode') } else { @() })
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

        # ffmpeg ships once at the root rather than inside each panel build, so
        # the download is not carrying two copies of a 76 MB binary.
        $ffmpegSource = Join-Path $distRoot 'ffmpeg\ffmpeg.exe'
        if (Test-Path -LiteralPath $ffmpegSource) {
            $ffmpegTarget = Join-Path $ps.CepTarget 'ffmpeg\ffmpeg.exe'
            if ($PSCmdlet.ShouldProcess($ffmpegTarget, 'Install ffmpeg')) {
                New-Item -ItemType Directory -Path (Split-Path -Parent $ffmpegTarget) -Force | Out-Null
                Copy-Item -LiteralPath $ffmpegSource -Destination $ffmpegTarget -Force
            }
            Write-Host "  ffmpeg     -> $($ps.CepTarget)\ffmpeg" -ForegroundColor Green
        } else {
            Write-Host '  ffmpeg     missing from this package -- export will not work.' -ForegroundColor Yellow
        }

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

if ($failed -gt 0) {
    Write-Host ''
    Write-Host "  $failed installation(s) failed -- see the errors above." -ForegroundColor Red
    exit 1
}

Write-Host ''
Write-Host '  If anything misbehaves, run scripts\doctor.ps1 for a diagnosis.' -ForegroundColor DarkGray
exit 0
