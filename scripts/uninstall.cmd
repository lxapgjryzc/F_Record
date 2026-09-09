@echo off
setlocal
set "HERE=%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%HERE%uninstall.ps1" %*
echo.
pause
