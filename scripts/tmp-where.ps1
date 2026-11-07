$d1 = (Get-PSDrive D).Free
$i1 = (Get-ChildItem "D:\WorkStation\luban\.kev\hf\hub" -Recurse -File -Force -Filter "*.incomplete" -EA SilentlyContinue | Measure-Object -Sum Length).Sum
Start-Sleep -Seconds 15
$d2 = (Get-PSDrive D).Free
$i2 = (Get-ChildItem "D:\WorkStation\luban\.kev\hf\hub" -Recurse -File -Force -Filter "*.incomplete" -EA SilentlyContinue | Measure-Object -Sum Length).Sum
"D free delta KB: {0:N0}; incomplete delta KB: {1:N0}" -f (($d2-$d1)/1KB), (($i2-$i1)/1KB)
"--- D root level-1 files modified last 5 min ---"
$since = (Get-Date).AddMinutes(-5)
Get-ChildItem "D:\" -File -Force -EA SilentlyContinue | Where-Object { $_.LastWriteTime -gt $since } | ForEach-Object { $_.FullName }
"--- each D:\top dir, level-1 files modified last 5 min, >1MB ---"
Get-ChildItem "D:\" -Directory -Force -EA SilentlyContinue | ForEach-Object {
  $top = $_.FullName
  Get-ChildItem $top -File -Force -EA SilentlyContinue | Where-Object { $_.LastWriteTime -gt $since -and $_.Length -gt 1MB } |
    ForEach-Object { "{0,12:N0} KB  {1}" -f ($_.Length/1KB), $_.FullName }
}
