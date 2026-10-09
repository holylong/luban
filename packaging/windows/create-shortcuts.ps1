$ErrorActionPreference = "Stop"
$shell = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath("Desktop")
$launchers = @{ "luban CLI" = "luban.cmd" }
if (Test-Path (Join-Path $PSScriptRoot "luban-desktop.cmd")) {
    $launchers["luban Desktop"] = "luban-desktop.cmd"
}
foreach ($name in $launchers.Keys) {
    $shortcut = $shell.CreateShortcut((Join-Path $desktop "$name.lnk"))
    $shortcut.TargetPath = Join-Path $PSScriptRoot $launchers[$name]
    $shortcut.WorkingDirectory = $PSScriptRoot
    $shortcut.IconLocation = "$(Join-Path $PSScriptRoot 'luban.ico'),0"
    $shortcut.Save()
    Write-Host "Created $name desktop shortcut."
}
