Get-ChildItem "C:\pagefile.sys","D:\pagefile.sys","C:\swapfile.sys" -Force -ErrorAction SilentlyContinue |
  ForEach-Object { "{0}  {1:N0} MB  write {2}" -f $_.FullName, ($_.Length/1MB), $_.LastWriteTime }
"--- counters ---"
$s = Get-Counter '\Memory\Pool Paged Bytes','\Memory\Committed Bytes' -ErrorAction SilentlyContinue
$s.CounterSamples | ForEach-Object { "{0}: {1:N0}" -f $_.Path, $_.CookedValue }
