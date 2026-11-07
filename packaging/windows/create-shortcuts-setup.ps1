$ErrorActionPreference = "Stop"
$shell = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath("Desktop")
$shortcut = $shell.CreateShortcut((Join-Path $desktop "luban.lnk"))
$shortcut.TargetPath = Join-Path $PSScriptRoot "luban.exe"
$shortcut.WorkingDirectory = $PSScriptRoot
$shortcut.IconLocation = "$(Join-Path $PSScriptRoot 'luban.ico'),0"
$shortcut.Description = "luban agent"
$shortcut.Save()
Write-Host "Created luban desktop shortcut."
