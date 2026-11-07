$blobs = "D:\WorkStation\luban\.kev\hf\hub"
"--- files modified in last 3 min under hub (any name) ---"
$since = (Get-Date).AddMinutes(-3)
Get-ChildItem $blobs -Recurse -File -Force -EA SilentlyContinue | Where-Object { $_.LastWriteTime -gt $since } |
  Sort-Object LastWriteTime -Descending | Select-Object -First 20 |
  ForEach-Object { "{0,12:N0} KB  {1}  {2}" -f ($_.Length/1KB), $_.LastWriteTime.ToString("HH:mm:ss"), $_.FullName }
"--- all blobs dirs sizes ---"
Get-ChildItem "$blobs\models--Qwen--Qwen3.5-4B-Base\blobs" -File -Force -EA SilentlyContinue |
  Sort-Object LastWriteTime -Descending | ForEach-Object { "{0,12:N0} KB  {1}  {2}" -f ($_.Length/1KB), $_.LastWriteTime.ToString("HH:mm:ss"), $_.Name }
"--- env TMP/TEMP/TMPDIR ---"
"TEMP=$env:TEMP"
"TMP=$env:TMP"
