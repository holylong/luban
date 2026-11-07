$p = "D:\WorkStation\luban\.kev\hf\hub\models--Qwen--Qwen3.5-4B-Base\trees\1001bb4d826a52d1f399e183466143f4da7b741b.json"
$j = Get-Content $p -Raw | ConvertFrom-Json
function Walk($nodes) {
  foreach ($n in $nodes) {
    if ($n.type -eq 'directory') { Walk $n.children }
    else {
      $oid = if ($n.lfs) { $n.lfs.oid } else { $n.oid }
      "{0}  {1}  {2}  {3}" -f $n.path, $n.size, $n.type, $oid
    }
  }
}
Walk $j.tree
