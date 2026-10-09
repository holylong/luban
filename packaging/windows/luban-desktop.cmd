@echo off
setlocal
set "ROOT=%~dp0"
set "LUBAN_NODE_BIN=%ROOT%node.exe"
set "LUBAN_CLI=%ROOT%app\dist\cli.js"
start "" "%ROOT%electron\electron.exe" "%ROOT%desktop" %*
