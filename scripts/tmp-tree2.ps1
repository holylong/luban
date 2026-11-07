$p = "D:\WorkStation\luban\.kev\hf\hub\models--Qwen--Qwen3.5-4B-Base\trees\1001bb4d826a52d1f399e183466143f4da7b741b.json"
$s = Get-Content $p -Raw
$s.Substring(0, [Math]::Min(3000, $s.Length))
