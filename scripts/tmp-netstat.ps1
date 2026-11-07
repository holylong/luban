Get-Process python -ErrorAction SilentlyContinue | ForEach-Object { "PID $($_.Id) CPU $([math]::Round($_.CPU,1))s WS $([math]::Round($_.WS/1MB))MB" }
"--- tcp by python pids ---"
$ids = (Get-Process python -ErrorAction SilentlyContinue).Id
netstat -ano -p tcp | Select-String 'ESTABLISHED' | ForEach-Object {
  $line = $_.Line
  foreach ($id in $ids) { if ($line -match "\s$id\s*$") { $line } }
}
"--- incomplete file sizes ---"
Get-ChildItem "D:\WorkStation\luban\.kev\hf\hub" -Recurse -Filter "*.incomplete" -Force -ErrorAction SilentlyContinue |
  ForEach-Object { "{0,12:N0} KB  {1}  {2}" -f ($_.Length/1KB), $_.LastWriteTime.ToString("HH:mm:ss"), $_.Name }
