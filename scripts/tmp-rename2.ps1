$b = "D:\WorkStation\luban\.kev\hf\hub\models--Qwen--Qwen3.5-4B-Base\blobs"
$m = "df547074dce70532a0493e54331252bd17a65efb89088cfabc2e7e2371a93d712"
"listing with filter:"
Get-ChildItem $b -Filter "*$m*" -File -EA SilentlyContinue | ForEach-Object { "  " + $_.Name + "  " + $_.Length }
Get-ChildItem $b -File | Where-Object { $_.Name -like "*df547074*" } | ForEach-Object { "like-match: " + $_.Name + "  " + $_.Length }
$main = Get-ChildItem $b -File | Where-Object { $_.Name -like "*df547074*" -and $_.Name -like "*.b44e7ae5.incomplete" } | Sort-Object Length -Descending | Select-Object -First 1
if ($main) {
  $target = Join-Path $b $m
  "moving $($main.FullName) ($($main.Length))"
  try { Move-Item -LiteralPath $main.FullName -Destination $target -Force -ErrorAction Stop; "moved ok" } catch { "MOVE FAILED: " + $_.Exception.Message }
}
$old = Get-ChildItem $b -File | Where-Object { $_.Name -like "*df547074*" -and $_.Name -ne $m }
$old | ForEach-Object { try { Remove-Item -LiteralPath $_.FullName -Force -EA Stop; "deleted: $($_.Name)" } catch { "DEL FAILED $($_.Name): " + $_.Exception.Message } }
Get-ChildItem $b -File | ForEach-Object { "{0,14:N0}  {1}" -f $_.Length, $_.Name }
