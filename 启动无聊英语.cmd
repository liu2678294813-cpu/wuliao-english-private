@echo off
cd /d "%~dp0"
set "NODE_EXE="
if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" set "NODE_EXE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not defined NODE_EXE where node.exe >nul 2>nul
if not defined NODE_EXE if not errorlevel 1 set "NODE_EXE=node.exe"
if not defined NODE_EXE (
  echo Node.js was not found. Please install Node.js and try again.
  pause
  exit /b 1
)
"%NODE_EXE%" "scripts\start.mjs"
if errorlevel 1 pause
