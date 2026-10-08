@echo off
title Corrupt Scripts F1 Live
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get the LTS version from https://nodejs.org then run this again.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing once...
  call npm install --no-audit --no-fund
)
start "" http://localhost:5050
node f1-live.js
pause
