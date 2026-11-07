$src = 'D:\WorkStation\luban\scripts\tmp-restart-luban.bat'
$dst = Join-Path $env:TEMP 'luban-restart.bat'
Copy-Item -LiteralPath $src -Destination $dst -Force
Remove-Item -LiteralPath $src -Force
Write-Output ("copied to: " + $dst)
$p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $dst, '36940', '8' -WindowStyle Hidden -PassThru
Write-Output ("launcher pid: " + $p.Id)