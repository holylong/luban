@echo off
setlocal
set "TARGET=%LOCALAPPDATA%\Programs\luban"
echo Installing luban __LUBAN_VERSION__ into "%TARGET%" ...
if not exist "%TARGET%" mkdir "%TARGET%"
xcopy "%~dp0luban\*" "%TARGET%\" /E /I /Y /Q >NUL
if errorlevel 1 (
  echo Failed to copy luban into "%TARGET%".
  pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%TARGET%\install.ps1"
if errorlevel 1 (
  echo luban was copied, but the PATH and shortcut step failed.
  pause
  exit /b 1
)
echo.
echo luban __LUBAN_VERSION__ installed. Open a new terminal and run: luban
pause
exit /b 0
