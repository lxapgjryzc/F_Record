@echo off
REM Double-clickable wrapper around install.ps1, so users do not have to know
REM about PowerShell execution policy.
setlocal
set "HERE=%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%HERE%install.ps1" %*
echo.
pause
