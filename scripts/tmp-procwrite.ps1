Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -EA SilentlyContinue |
  Where-Object { $_.WriteBytesPersec -gt 1MB -or $_.ReadBytesPersec -gt 5MB } |
  ForEach-Object { "PID {0} ({1}): write {2:N0} KB/s, read {3:N0} KB/s" -f $_.IDProcess, $_.Name, ($_.WriteBytesPersec/1KB), ($_.ReadBytesPersec/1KB) }
