@echo off
setlocal
pushd "%~dp0" || exit /b 1
call npm install
if errorlevel 1 goto failed
call npm run build
if errorlevel 1 goto failed
call npm link
if errorlevel 1 goto failed
popd
exit /b 0

:failed
set "build_exit_code=%errorlevel%"
popd
exit /b %build_exit_code%
