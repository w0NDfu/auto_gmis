@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 20 or newer, then reopen this file.
  pause
  exit /b 1
)
if not exist "node_modules\playwright-core\package.json" (
  call npm ci --ignore-scripts --registry=https://registry.npmjs.org
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
node server.js
pause
