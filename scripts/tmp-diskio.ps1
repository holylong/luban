"--- pagefiles ---"
Get-CimInstance Win32_PageFileUsage -EA SilentlyContinue | ForEach-Object { "$($_.Name) current $($_.CurrentUsage) MB peak $($_.PeakUsage) MB" }
Get-CimInstance Win32_PageFileSetting -EA SilentlyContinue | ForEach-Object { "setting: $($_.Name) $($_.MinSize)-$($_.MaxSize) MB" }
"--- disk write bytes over 15s ---"
$c1 = Get-Counter '\PhysicalDisk(*)\Disk Bytes Written' -EA SilentlyContinue
Start-Sleep -Seconds 15
$c2 = Get-Counter '\PhysicalDisk(*)\Disk Bytes Written' -EA SilentlyContinue
foreach ($s in $c2.CounterSamples) {
  $inst = $s.InstanceName
  $prev = $c1.CounterSamples | Where-Object { $_.InstanceName -eq $inst }
  if ($prev) { "{0}: {1:N0} KB in 15s" -f $inst, (($s.CookedValue - $prev.CookedValue)/1KB) }
}
"--- python process IO ---"
Get-Process python -EA SilentlyContinue | ForEach-Object { "PID $($_.Id) WS $([math]::Round($_.WS/1MB))MB CPU $([math]::Round($_.CPU))s" }
