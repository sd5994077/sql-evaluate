@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo SQL Evaluate needs Node.js 20 or newer.
  echo Download it from https://nodejs.org/ and run this file again.
  pause
  exit /b 1
)
for /f "tokens=1 delims=." %%V in ('node -p "process.versions.node"') do set "SQL_EVALUATE_NODE_MAJOR=%%V"
if %SQL_EVALUATE_NODE_MAJOR% LSS 20 (
  echo SQL Evaluate needs Node.js 20 or newer. Found Node %SQL_EVALUATE_NODE_MAJOR%.
  pause
  exit /b 1
)
if not exist "dist\index.html" (
  echo The production dashboard is missing. Run npm install and npm run build first.
  pause
  exit /b 1
)
node tools\serve.mjs
endlocal
