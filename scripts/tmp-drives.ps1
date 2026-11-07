Get-PSDrive -PSProvider FileSystem | ForEach-Object {
  "{0}: Free {1:N1} GB, Used {2:N1} GB" -f $_.Name, ($_.Free/1GB), ($_.Used/1GB)
}
