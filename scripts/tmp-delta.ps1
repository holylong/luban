$pid1 = 37552
$a = Get-Process -Id $pid1 -ErrorAction Stop
$io1 = (Get-CimInstance Win32_Process -Filter "ProcessId=$pid1").ReadTransferCount + (Get-CimInstance Win32_Process -Filter "ProcessId=$pid1").WriteTransferCount
$before = Get-ChildItem "D:\WorkStation\luban\.kev\hf\hub" -Recurse -Filter "*.incomplete" -Force -ErrorAction SilentlyContinue | ForEach-Object { $_.Length } | Measure-Object -Sum
Start-Sleep -Seconds 20
$p2 = Get-CimInstance Win32_Process -Filter "ProcessId=$pid1"
$io2 = $p2.ReadTransferCount + $p2.WriteTransferCount
$after = Get-ChildItem "D:\WorkStation\luban\.kev\hf\hub" -Recurse -Filter "*.incomplete" -Force -ErrorAction SilentlyContinue | ForEach-Object { $_.Length } | Measure-Object -Sum
"process IO delta over 20s: {0:N0} KB" -f (($io2 - $io1)/1KB)
"incomplete files delta over 20s: {0:N0} KB (total {1:N0} KB)" -f (($after.Sum - $before.Sum)/1KB), ($after.Sum/1KB)
