$uv = Get-ChildItem "$env:LOCALAPPDATA\uv\cache" -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Sum Length
"uv cache MB: " + [math]::Round($uv.Sum/1MB)
$hf = Get-ChildItem "$env:USERPROFILE\.cache\huggingface" -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Sum Length
"hf cache MB: " + [math]::Round($hf.Sum/1MB)
