Get-Process python -ErrorAction SilentlyContinue | ForEach-Object { "PID $($_.Id) CPU $($_.CPU)s WS $([math]::Round($_.WS/1MB))MB" }
$hf = "$env:USERPROFILE\.cache\huggingface"
if (Test-Path $hf) {
  Get-ChildItem $hf -Recurse -Force -ErrorAction SilentlyContinue | Select-Object -First 30 | ForEach-Object { $_.FullName }
} else { "no hf dir" }
netstat -ano | Select-String 'ESTABLISHED' | Select-String '33460' | ForEach-Object { $_.Line }
