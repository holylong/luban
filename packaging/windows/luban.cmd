@echo off
setlocal
set "ROOT=%~dp0"
"%ROOT%node.exe" "%ROOT%app\dist\cli.js" %*
