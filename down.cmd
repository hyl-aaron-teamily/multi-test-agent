@echo off
rem Stop the platform: running tasks are stopped and this session's runs and reports are deleted (saved/ stays)
setlocal
cd /d "%~dp0"
node --import tsx scripts\ctl.ts stop %*
set rc=%errorlevel%
if not %rc%==0 echo %cmdcmdline% | findstr /i /c:"%~nx0" >/dev/null && timeout /t 20
exit /b %rc%
