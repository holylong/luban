# Register luban for the current user: PATH entry, shortcuts, uninstall entry.
$ErrorActionPreference = "Stop"
$target = $PSScriptRoot
$version = "__LUBAN_VERSION__"
$exe = Join-Path $target "luban.exe"
$icon = Join-Path $target "luban.ico"

# PATH (user scope) so a new terminal can run `luban` from anywhere.
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$entries = @($userPath -split ";" | Where-Object { $_ })
if ($entries -notcontains $target) {
    [Environment]::SetEnvironmentVariable("Path", (@($entries) + $target) -join ";", "User")
}

# Desktop and Start Menu shortcuts point straight at the single-file exe.
$shell = New-Object -ComObject WScript.Shell
$startMenu = Join-Path ([Environment]::GetFolderPath("Programs")) "luban"
if (-not (Test-Path $startMenu)) { New-Item -ItemType Directory -Path $startMenu | Out-Null }
$links = @(
    (Join-Path ([Environment]::GetFolderPath("Desktop")) "luban.lnk"),
    (Join-Path $startMenu "luban.lnk")
)
foreach ($link in $links) {
    $shortcut = $shell.CreateShortcut($link)
    $shortcut.TargetPath = $exe
    $shortcut.WorkingDirectory = $target
    $shortcut.IconLocation = "$icon,0"
    $shortcut.Description = "luban agent"
    $shortcut.Save()
}

# Show up in Settings > Apps with a working uninstall command.
$key = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\luban"
New-Item -Path $key -Force | Out-Null
Set-ItemProperty -Path $key -Name DisplayName -Value "luban"
Set-ItemProperty -Path $key -Name DisplayVersion -Value $version
Set-ItemProperty -Path $key -Name Publisher -Value "luban"
Set-ItemProperty -Path $key -Name InstallLocation -Value $target
Set-ItemProperty -Path $key -Name DisplayIcon -Value $icon
Set-ItemProperty -Path $key -Name UninstallString -Value ('"' + (Join-Path $target "uninstall.cmd") + '"')
Set-ItemProperty -Path $key -Name NoModify -Value 1 -Type DWord
Set-ItemProperty -Path $key -Name NoRepair -Value 1 -Type DWord
Write-Host "Added $target to PATH and created shortcuts."
