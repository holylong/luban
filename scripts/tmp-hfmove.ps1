$src = "$env:USERPROFILE\.cache\huggingface"
$dst = "D:\WorkStation\luban\.kev\hf"
New-Item -ItemType Directory -Force -Path $dst | Out-Null
Get-ChildItem $src -Force | ForEach-Object {
  $target = Join-Path $dst $_.Name
  if (Test-Path $target) { "skip (exists): $($_.Name)" }
  else { Move-Item -LiteralPath $_.FullName -Destination $target; "moved: $($_.Name)" }
}
Get-ChildItem $dst -Force | ForEach-Object { "dst has: $($_.Name)" }
