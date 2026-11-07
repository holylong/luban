# Remove luban for the current user: PATH entry, shortcuts, registry, folder.
$ErrorActionPreference = "Stop"
$target = $PSScriptRoot

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$entries = @($userPath -split ";" | Where-Object { $_ -and $_ -ne $target })
[Environment]::SetEnvironmentVariable("Path", ($entries -join ";"), "User")

Remove-Item -LiteralPath (Join-Path ([Environment]::GetFolderPath("Desktop")) "luban.lnk") -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path ([Environment]::GetFolderPath("Programs")) "luban") -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\luban" -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "luban removed. Configuration in %USERPROFILE%\.luban was kept."
# A script cannot delete the folder it runs from; hand that to a detached shell.
Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "timeout /t 2 >nul & rd /s /q `"$target`"" -WindowStyle Hidden
