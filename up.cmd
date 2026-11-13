@echo off
rem Start the platform in the background and open the Web console (double-click, or type: up)
setlocal
cd /d "%~dp0"
node --import tsx scripts\ctl.ts start --open %*
set rc=%errorlevel%
rem Double-clicked and failed: keep the window open long enough to read why.
if not %rc%==0 echo %cmdcmdline% | findstr /i /c:"%~nx0" >/dev/null && timeout /t 20
exit /b %rc%
