@echo off
setlocal
title Building AS Screen Recorder installer
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js is required to BUILD the installer ^(it is NOT needed to use the finished app^).
  echo Install the LTS version from https://nodejs.org then run this file again.
  echo.
  pause
  exit /b 1
)

echo [1/2] Installing build tools ^(first run downloads about 250 MB^)...
call npm install
if errorlevel 1 goto :fail

echo [2/2] Building AS-Screen-Recorder-Setup.exe ...
call npm run dist
if errorlevel 1 goto :fail

echo.
echo ================================================================
echo  DONE:  %~dp0dist\AS-Screen-Recorder-Setup.exe
echo ================================================================
explorer "%~dp0dist"
pause
exit /b 0

:fail
echo.
echo Build failed - see the messages above.
pause
exit /b 1
