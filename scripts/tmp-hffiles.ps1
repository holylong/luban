$hf = "$env:USERPROFILE\.cache\huggingface\hub"
if (Test-Path $hf) {
  Get-ChildItem $hf -Recurse -Force -File -ErrorAction SilentlyContinue |
    Sort-Object Length -Descending | Select-Object -First 15 |
    ForEach-Object { "{0,10:N0} KB  {1}" -f ($_.Length/1KB), $_.FullName }
} else { "no hub dir yet" }
"--- incomplete downloads ---"
Get-ChildItem "$env:LOCALAPPDATA\Temp" -Filter "tmp*" -Recurse -Depth 1 -ErrorAction SilentlyContinue |
  ForEach-Object { $_.FullName } | Select-Object -First 10
