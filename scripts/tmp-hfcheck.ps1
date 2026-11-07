$src = "$env:USERPROFILE\.cache\huggingface"
$dst = "D:\WorkStation\luban\.kev\hf"
"=== src top level ==="
if (Test-Path $src) { Get-ChildItem $src -Force -Recurse -Depth 2 -ErrorAction SilentlyContinue | Select-Object -First 40 | ForEach-Object { $_.FullName } } else { "src gone" }
"=== dst top level ==="
Get-ChildItem $dst -Force | ForEach-Object { $_.Name }
"=== dst hub depth2 ==="
Get-ChildItem "$dst\hub" -Force -Recurse -Depth 2 -ErrorAction SilentlyContinue | Select-Object -First 40 | ForEach-Object { $_.FullName }
$srcSize = (Get-ChildItem $src -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object -Sum Length).Sum
$dstSize = (Get-ChildItem $dst -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object -Sum Length).Sum
"src MB: " + [math]::Round($srcSize/1MB) + "  dst MB: " + [math]::Round($dstSize/1MB)
