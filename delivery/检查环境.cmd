@echo off
setlocal DisableDelayedExpansion
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\portable.ps1" -Mode Check %*
set "MWS_EXIT=%errorlevel%"
echo.
pause
exit /b %MWS_EXIT%
