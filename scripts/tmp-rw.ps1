$pid1 = 37552
$p1 = Get-CimInstance Win32_Process -Filter "ProcessId=$pid1"
$r1 = $p1.ReadTransferCount; $w1 = $p1.WriteTransferCount
Start-Sleep -Seconds 15
$p2 = Get-CimInstance Win32_Process -Filter "ProcessId=$pid1"
"read delta KB:  {0:N0}" -f (($p2.ReadTransferCount - $r1)/1KB)
"write delta KB: {0:N0}" -f (($p2.WriteTransferCount - $w1)/1KB)
"--- cmd dir of incomplete ---"
cmd /c "dir /s D:\WorkStation\luban\.kev\hf\hub\*.incomplete"
