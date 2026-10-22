@echo off
setlocal DisableDelayedExpansion
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\portable.ps1" -Mode Uninstall %*
set "MWS_EXIT=%errorlevel%"
echo.
if not "%MWS_EXIT%"=="0" echo Removal failed. Read the message above.
pause
exit /b %MWS_EXIT%
