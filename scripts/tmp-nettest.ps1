try {
  $r = Invoke-WebRequest 'https://huggingface.co' -UseBasicParsing -TimeoutSec 15
  "HF OK " + $r.StatusCode
} catch { "HF FAIL: " + $_.Exception.Message }
try {
  $r2 = Invoke-WebRequest 'https://hf-mirror.com' -UseBasicParsing -TimeoutSec 15
  "MIRROR OK " + $r2.StatusCode
} catch { "MIRROR FAIL: " + $_.Exception.Message }
