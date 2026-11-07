$since = (Get-Date).AddMinutes(-5)
"--- D:\WorkStation\luban (incl .kev) ---"
Get-ChildItem "D:\WorkStation\luban" -Recurse -File -Force -ErrorAction SilentlyContinue |
  Where-Object { $_.LastWriteTime -gt $since } |
  Sort-Object LastWriteTime -Descending | Select-Object -First 30 |
  ForEach-Object { "{0,12:N0} KB  {1}  {2}" -f ($_.Length/1KB), $_.LastWriteTime.ToString("HH:mm:ss"), $_.FullName }
