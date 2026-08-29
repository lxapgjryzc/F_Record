<#
.SYNOPSIS
Removes F_Record from every Photoshop installation on this machine.

.DESCRIPTION
Deletes only the two folders the installer created. Your recordings live in
%APPDATA%\F_Record and are never touched -- pass -RemoveData if you genuinely
want those gone too, and it will ask first.

.PARAMETER RemoveData
Also delete settings and recorded frames from %APPDATA%\F_Record. Prompts for
confirmation, because captured frames are not recoverable.
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [string] $Path,
    [switch] $RemoveData
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $scriptDir 'photoshop.ps1')

# A -WhatIf run changes nothing, so it must not demand administrator rights.
if (-not $WhatIfPreference) {
    if (Request-Elevation -ScriptPath $MyInvocation.MyCommand.Path -Arguments $(
            @() + $(if ($Path) { @('-Path', "`"$Path`"") } else { @() }) +
                  $(if ($RemoveData) { @('-RemoveData') } else { @() })
        )) {
        exit 0
    }
}

Write-Host 'F_Record uninstaller' -ForegroundColor Green

$installations = @(Get-PhotoshopInstallations)
if ($Path) {
    $wanted = $Path.TrimEnd('\').ToLowerInvariant()
    $installations = @($installations | Where-Object { $_.Path.TrimEnd('\').ToLowerInvariant() -eq $wanted })
}

$removed = 0
foreach ($ps in $installations) {
    $targets = @($ps.CepTarget, $ps.GenTarget) | Where-Object { Test-Path -LiteralPath $_ }
    if ($targets.Count -eq 0) { continue }

    Write-Section "Photoshop $($ps.Year)  ($($ps.Version))"
    foreach ($target in $targets) {
        if ($PSCmdlet.ShouldProcess($target, 'Remove')) {
            Remove-Item -LiteralPath $target -Recurse -Force
        }
        Write-Host "  Removed $target" -ForegroundColor Green
        $removed++
    }
}

if ($removed -eq 0) {
    Write-Host ''
    Write-Host '  F_Record was not installed in any Photoshop found here.' -ForegroundColor Yellow
}

$dataDir = Join-Path $env:APPDATA 'F_Record'
if ($RemoveData) {
    if (Test-Path -LiteralPath $dataDir) {
        Write-Section 'Recorded data'
        Write-Host "  $dataDir" -ForegroundColor Yellow
        Write-Host '  This contains your settings and every captured frame.' -ForegroundColor Yellow
        Write-Host '  Deleting it cannot be undone.' -ForegroundColor Yellow
        $answer = Read-Host '  Type DELETE to confirm'
        if ($answer -ceq 'DELETE') {
            if ($PSCmdlet.ShouldProcess($dataDir, 'Remove recorded data')) {
                Remove-Item -LiteralPath $dataDir -Recurse -Force
            }
            Write-Host '  Deleted.' -ForegroundColor Green
        } else {
            Write-Host '  Left alone.' -ForegroundColor Green
        }
    }
} elseif (Test-Path -LiteralPath $dataDir) {
    Write-Host ''
    Write-Host "  Your recordings are still at $dataDir" -ForegroundColor DarkGray
    Write-Host '  Pass -RemoveData if you want those removed as well.' -ForegroundColor DarkGray
}

Write-Host ''
Write-Host '  Restart Photoshop to finish.' -ForegroundColor Green
