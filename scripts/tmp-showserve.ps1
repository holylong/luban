$lines = Get-Content '.kev\kev\kev\serve.py'
for ($i = 300; $i -lt [Math]::Min(400, $lines.Count); $i++) {
  "{0,4}: {1}" -f ($i + 1), $lines[$i]
}
