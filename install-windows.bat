@echo off
setlocal
cd /d "%~dp0"
powershell -ExecutionPolicy Bypass -NoProfile -File "%~dp0scripts\install-anticodex.ps1" %*
set "code=%ERRORLEVEL%"
echo.
if "%code%"=="0" (
  echo Anti-Codex install finished.
  echo You can launch Anti-Codex from the desktop shortcut or Start Menu.
) else (
  echo Anti-Codex install failed with exit code %code%.
)
echo.
if "%~1"=="" pause
exit /b %code%
