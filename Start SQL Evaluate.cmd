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
  echo SQL Evaluate cannot find its dashboard bundle: dist\index.html
  echo.
  echo Extract the entire SQL-Evaluate ZIP to a local folder, then run this file
  echo from that extracted folder. Keep the dist and tools folders beside this file.
  echo.
  echo Normal users do not need to run npm install or npm run build.
  pause
  exit /b 1
)
node tools\serve.mjs
endlocal
