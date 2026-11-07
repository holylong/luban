$b = "D:\WorkStation\luban\.kev\hf\hub\models--Qwen--Qwen3.5-4B-Base\blobs"
$m1 = "df547074dce70532a0493e54331252bd17a65efb89088cfabc2e7e2371a93d712"
$m2 = "590fbaac095dd31db886c322d9d2f7df47777966391acf306ddddc3e4e3a15ef"
foreach ($m in @($m1, $m2)) {
  $incs = Get-ChildItem $b -Filter "$m*.incomplete" -File
  $main = $incs | Sort-Object Length -Descending | Select-Object -First 1
  if ($main) {
    $target = Join-Path $b $m
    if (-not (Test-Path $target)) { Move-Item -LiteralPath $main.FullName -Destination $target -Force; "renamed: $($main.Name) -> $m" }
    else { "target exists already: $m" }
  }
  Get-ChildItem $b -Filter "$m*.incomplete" -File | ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force; "deleted leftover: $($_.Name)" }
}
Get-ChildItem $b -File | ForEach-Object { "{0,14:N0}  {1}" -f $_.Length, $_.Name }
