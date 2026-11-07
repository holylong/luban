$d1 = (Get-PSDrive D).Free
$c1 = (Get-PSDrive C).Free
$inc1 = (Get-ChildItem "D:\WorkStation\luban\.kev\hf\hub" -Recurse -File -Force -Filter "*.incomplete" -ErrorAction SilentlyContinue | Measure-Object -Sum Length).Sum
Start-Sleep -Seconds 20
$d2 = (Get-PSDrive D).Free
$c2 = (Get-PSDrive C).Free
$inc2 = (Get-ChildItem "D:\WorkStation\luban\.kev\hf\hub" -Recurse -File -Force -Filter "*.incomplete" -ErrorAction SilentlyContinue | Measure-Object -Sum Length).Sum
"20s delta: D free {0:N0} KB, C free {1:N0} KB, incomplete {2:N0} KB" -f (($d2-$d1)/1KB), (($c2-$c1)/1KB), (($inc2-$inc1)/1KB)
