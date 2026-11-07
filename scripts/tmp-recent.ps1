$since = (Get-Date).AddMinutes(-10)
"--- recently modified files >1MB under D:\WorkStation\luban\.kev and $env:TEMP ---"
$roots = @("D:\WorkStation\luban\.kev", $env:TEMP, "$env:LOCALAPPDATA\uv")
foreach ($r in $roots) {
  Get-ChildItem $r -Recurse -File -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -gt $since -and $_.Length -gt 1MB } |
    Sort-Object Length -Descending | Select-Object -First 10 |
    ForEach-Object { "{0,12:N0} KB  {1}  {2}" -f ($_.Length/1KB), $_.LastWriteTime.ToString("HH:mm:ss"), $_.FullName }
}
