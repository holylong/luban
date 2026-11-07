$since = (Get-Date).AddMinutes(-8)
$roots = @("$env:TEMP", "$env:LOCALAPPDATA\Temp")
$seen = @{}
foreach ($r in $roots) {
  if (-not (Test-Path $r)) { continue }
  Get-ChildItem $r -File -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -gt $since -and $_.Length -gt 100KB } |
    Sort-Object Length -Descending | Select-Object -First 15 |
    ForEach-Object {
      $k = $_.FullName
      if (-not $seen[$k]) { $seen[$k] = 1; "{0,12:N0} KB  {1}  {2}" -f ($_.Length/1KB), $_.LastWriteTime.ToString("HH:mm:ss"), $_.FullName }
    }
}
"--- xet ---"
$xe = "$env:USERPROFILE\.cache\huggingface\xet"
if (Test-Path $xe) { Get-ChildItem $xe -Recurse -File -Force -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -gt $since } | ForEach-Object { "{0,12:N0} KB  {1}" -f ($_.Length/1KB), $_.FullName } }
$xe2 = "D:\WorkStation\luban\.kev\hf\xet"
if (Test-Path $xe2) { Get-ChildItem $xe2 -Recurse -File -Force -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -gt $since } | ForEach-Object { "{0,12:N0} KB  {1}" -f ($_.Length/1KB), $_.FullName } }
