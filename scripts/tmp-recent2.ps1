$since = (Get-Date).AddMinutes(-6)
$roots = @("D:\WorkStation\luban\.kev")
foreach ($r in $roots) {
  Get-ChildItem $r -Recurse -File -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -gt $since } |
    Sort-Object LastWriteTime -Descending | Select-Object -First 25 |
    ForEach-Object { "{0,12:N0} KB  {1}  {2}" -f ($_.Length/1KB), $_.LastWriteTime.ToString("HH:mm:ss"), $_.FullName }
}
