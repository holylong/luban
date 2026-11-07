$since = (Get-Date).AddMinutes(-4)
$found = 0
Get-ChildItem "D:\" -Directory -Force -ErrorAction SilentlyContinue | ForEach-Object {
  Get-ChildItem $_.FullName -Recurse -File -Force -Depth 3 -ErrorAction SilentlyContinue |
    Where-Object { $_.LastWriteTime -gt $since -and $_.Length -gt 512KB } |
    Sort-Object Length -Descending | Select-Object -First 5 |
    ForEach-Object { $found++; "{0,12:N0} KB  {1}  {2}" -f ($_.Length/1KB), $_.LastWriteTime.ToString("HH:mm:ss"), $_.FullName }
}
"found: $found"
