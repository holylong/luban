Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.X, $b.Y, 0, 0, $b.Size)
$g.Dispose()
$w = 640
$h = [int]([double]$bmp.Height * $w / $bmp.Width)
$small = New-Object System.Drawing.Bitmap $w, $h
$g2 = [System.Drawing.Graphics]::FromImage($small)
$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g2.DrawImage($bmp, 0, 0, $w, $h)
$g2.Dispose()
$bmp.Dispose()
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$ep = New-Object System.Drawing.Imaging.EncoderParameters 1
$ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]50)
$small.Save('C:\Users\Public\shot.jpg', $codec, $ep)
$small.Dispose()
$bytes = [System.IO.File]::ReadAllBytes('C:\Users\Public\shot.jpg')
[IO.File]::WriteAllText((Join-Path $env:TEMP 'shot.b64'), [Convert]::ToBase64String($bytes))
Write-Output ('BYTES=' + $bytes.Length)
