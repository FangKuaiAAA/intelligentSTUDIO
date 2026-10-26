Write-Host "=== photo-app webview ==="
$w = "D:\OpenCode\APPXInteligent\photo-app\webview"
Write-Host ("webview dir      : " + (Test-Path $w))
Write-Host ("dist-backend     : " + (Test-Path "$w\dist-backend"))
Write-Host ("worker.cjs       : " + (Test-Path "$w\dist-backend\worker.cjs"))
if (Test-Path "$w\dist-backend") { Get-ChildItem "$w\dist-backend" | Select-Object -First 8 -ExpandProperty Name }
Write-Host "=== node ==="
$node = Get-Command node -ErrorAction SilentlyContinue
Write-Host ("node             : " + $(if ($node) { $node.Source } else { "NOT FOUND" }))
Write-Host "=== ico small frames alpha ==="
Add-Type -AssemblyName System.Drawing
$p = "D:\OpenCode\APPXInteligent\assets\icons\intelligentSTUDIO.ico"
$b = [System.IO.File]::ReadAllBytes($p)
$count = [BitConverter]::ToUInt16($b, 4)
for ($i = 0; $i -lt $count; $i++) {
    $off = 6 + $i * 16
    $w2 = $b[$off]; if ($w2 -eq 0) { $w2 = 256 }
    $bytesInRes = [BitConverter]::ToUInt32($b, $off + 8)
    $imgOff = [BitConverter]::ToUInt32($b, $off + 12)
    Write-Host ("  frame $i : ${w2}x${w2} bytes=$bytesInRes offset=$imgOff")
}
