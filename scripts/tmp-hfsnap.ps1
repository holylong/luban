$dst = "D:\WorkStation\luban\.kev\hf\hub"
Get-ChildItem $dst -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object {
  $kind = if ($_.LinkType) { $_.LinkType } elseif ($_.PSIsContainer) { "DIR" } else { "FILE" }
  $tgt = if ($_.Target) { $_.Target -join ',' } else { '' }
  "{0}  {1,12}  {2} -> {3}" -f $kind, $_.Length, $_.FullName.Replace($dst, ''), $tgt
}
