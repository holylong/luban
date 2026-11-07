$dst = "D:\WorkStation\luban\.kev\hf\hub"
$files = Get-ChildItem $dst -Recurse -File -Force -ErrorAction SilentlyContinue
"files: " + $files.Count + "  total MB: " + [math]::Round(($files | Measure-Object -Sum Length).Sum/1MB)
"latest 5:"
$files | Sort-Object LastWriteTime -Descending | Select-Object -First 5 |
  ForEach-Object { "{0,10:N0} KB  {1}  {2}" -f ($_.Length/1KB), $_.LastWriteTime.ToString("HH:mm:ss"), $_.Name }
