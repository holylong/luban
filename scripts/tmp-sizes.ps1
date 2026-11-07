$b = "D:\WorkStation\luban\.kev\hf\hub\models--Qwen--Qwen3.5-4B-Base\blobs"
Get-ChildItem $b -File | Sort-Object Length -Descending | ForEach-Object {
  $i = Get-Item $_.FullName -Force
  "{0,14:N0}  {1}  {2}" -f $i.Length, $i.LastWriteTime.ToString("HH:mm:ss"), $_.Name
}
