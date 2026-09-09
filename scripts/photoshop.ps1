# Shared Photoshop discovery, dot-sourced by install.ps1, uninstall.ps1 and
# doctor.ps1.
#
# Detection deliberately does not trust the registry key *name*. Photoshop
# registers itself under HKLM:\SOFTWARE\Adobe\Photoshop\<n> where <n> is an
# internal number, not the product version -- Photoshop 27.0 (2026) registers as
# "200.0", following (major - 7) * 10. That mapping has held for a decade, but
# the authoritative version is the one on Photoshop.exe itself, so that is what
# is used and the registry is treated purely as a way to find installations.

Set-StrictMode -Version Latest

$script:CepFolderName       = 'com.F_know.F_Record.cep'
$script:GeneratorFolderName = 'com.f_know.f_record.generator'

function Get-PhotoshopVersionFromExe {
    param([Parameter(Mandatory)][string] $ExePath)
    try {
        $info = (Get-Item -LiteralPath $ExePath -ErrorAction Stop).VersionInfo
        # FileVersion looks like "27.2.0.123"; only the first two parts matter.
        $parts = ($info.FileVersion -split '[.,\s]+') | Where-Object { $_ -match '^\d+$' }
        if ($parts.Count -ge 2) {
            return [version]::new([int]$parts[0], [int]$parts[1])
        }
        if ($parts.Count -eq 1) {
            return [version]::new([int]$parts[0], 0)
        }
    } catch {
        # Fall through: an unreadable exe is reported as unknown rather than
        # aborting the whole scan.
    }
    return $null
}

function Get-PhotoshopYear {
    param([Parameter(Mandatory)][version] $Version)
    # 21 -> 2020, 22 -> 2021, ... 27 -> 2026
    return $Version.Major + 1999
}

<#
.SYNOPSIS
Finds every Photoshop installation on this machine.

.OUTPUTS
Objects with Path, Version, Year, Variant, CepDir, GeneratorDir, Installed.
#>
function Get-PhotoshopInstallations {
    $candidates = New-Object System.Collections.Generic.List[string]

    foreach ($hive in @('HKLM:\SOFTWARE\Adobe\Photoshop', 'HKLM:\SOFTWARE\WOW6432Node\Adobe\Photoshop')) {
        if (-not (Test-Path $hive)) { continue }
        foreach ($key in (Get-ChildItem $hive -ErrorAction SilentlyContinue)) {
            $appPath = $null
            try {
                $appPath = (Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction Stop).ApplicationPath
            } catch { }
            if ($appPath) { $candidates.Add($appPath.TrimEnd('\')) }
        }
    }

    # Also sweep the conventional locations, so a Photoshop that never wrote a
    # registry entry (or wrote it under another user) is still found.
    foreach ($root in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
        if (-not $root) { continue }
        $adobe = Join-Path $root 'Adobe'
        if (-not (Test-Path $adobe)) { continue }
        foreach ($dir in (Get-ChildItem $adobe -Directory -ErrorAction SilentlyContinue)) {
            if ($dir.Name -like 'Adobe Photoshop*') { $candidates.Add($dir.FullName.TrimEnd('\')) }
        }
    }

    $seen = @{}
    $results = New-Object System.Collections.Generic.List[object]

    foreach ($path in $candidates) {
        $normalized = $path.TrimEnd('\').ToLowerInvariant()
        if ($seen.ContainsKey($normalized)) { continue }
        $seen[$normalized] = $true

        $exe = Join-Path $path 'Photoshop.exe'
        if (-not (Test-Path -LiteralPath $exe)) { continue }

        $version = Get-PhotoshopVersionFromExe -ExePath $exe
        if ($null -eq $version) { continue }

        # Photoshop 2020 is CEP 9 / Chromium 61 and needs the down-compiled
        # bundle; 2021 and later share the modern one.
        $variant = if ($version.Major -le 21) { 'legacy' } else { 'modern' }

        $cepDir = Join-Path $path 'Required\CEP\extensions'
        $generatorDir = Join-Path $path 'Plug-ins\Generator'

        $results.Add([pscustomobject]@{
            Path         = $path
            Version      = $version
            Year         = Get-PhotoshopYear -Version $version
            Variant      = $variant
            Supported    = ($version.Major -ge 21)
            CepDir       = $cepDir
            GeneratorDir = $generatorDir
            CepTarget    = Join-Path $cepDir $script:CepFolderName
            GenTarget    = Join-Path $generatorDir $script:GeneratorFolderName
        })
    }

    return $results | Sort-Object { $_.Version }
}

function Test-IsElevated {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

<#
.SYNOPSIS
Re-launches the calling script with an elevation prompt.

.DESCRIPTION
Photoshop lives under Program Files, so writing the plug-in folders needs
administrator rights. Returns $true when a new elevated process was started and
the caller should exit.
#>
function Request-Elevation {
    param(
        [Parameter(Mandatory)][string] $ScriptPath,
        [string[]] $Arguments = @()
    )
    if (Test-IsElevated) { return $false }

    Write-Host 'Photoshop lives under Program Files, so this needs administrator rights.' -ForegroundColor Yellow
    Write-Host 'Re-launching with an elevation prompt...' -ForegroundColor Yellow

    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$ScriptPath`"") + $Arguments
    try {
        Start-Process -FilePath (Get-Process -Id $PID).Path -Verb RunAs -ArgumentList $argList | Out-Null
        return $true
    } catch {
        Write-Host 'Elevation was declined. Nothing has been changed.' -ForegroundColor Red
        exit 1
    }
}

<#
.SYNOPSIS
Reports whether the two Photoshop preferences the plug-in needs look enabled.

.DESCRIPTION
Deliberately read-only. Photoshop stores these in its own preferences format,
and a botched write can damage a user's entire configuration -- whereas the two
switches take about five seconds to flip by hand. So this reports and instructs
rather than editing anything.
#>
function Get-PhotoshopPreferenceHints {
    param([Parameter(Mandatory)][pscustomobject] $Installation)

    $result = [pscustomobject]@{
        GeneratorEnabled = $null   # $true / $false / $null when unknown
        PrefsFile        = $null
    }

    $prefsRoot = Join-Path $env:APPDATA "Adobe\Adobe Photoshop $($Installation.Year)\Adobe Photoshop $($Installation.Year) Settings"
    if (-not (Test-Path -LiteralPath $prefsRoot)) { return $result }
    $result.PrefsFile = $prefsRoot

    # Generator writes its own marker file once it has run at least once.
    $generatorPrefs = Get-ChildItem -LiteralPath $prefsRoot -Filter '*Generator*' -ErrorAction SilentlyContinue
    if ($generatorPrefs) { $result.GeneratorEnabled = $true }

    return $result
}

function Write-Section {
    param([string] $Text)
    Write-Host ''
    Write-Host $Text -ForegroundColor Cyan
    Write-Host ('-' * $Text.Length) -ForegroundColor DarkGray
}
