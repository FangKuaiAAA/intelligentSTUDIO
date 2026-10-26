$w = "D:\OpenCode\APPXInteligent\photo-app\webview\dist-backend\worker.cjs"
if (Test-Path $w) { Write-Host ("worker.cjs size: " + [math]::Round((Get-Item $w).Length/1MB, 2) + " MB") }
Get-ChildItem "D:\OpenCode\APPXInteligent\photo-app\webview" -ErrorAction SilentlyContinue | Select-Object Name, Length | Format-Table -AutoSize | Out-String -Width 120

Write-Host "=== ico frame alphas ==="
& "D:\OpenCode\APPXInteligent\.venv\Scripts\python.exe" -c @"
from PIL import Image
img = Image.open('assets/icons/intelligentSTUDIO.ico')
for sz in [(16,16),(32,32),(48,48),(256,256)]:
    try:
        im = img.ico.getimage(sz)
        w,h = im.size
        px = im.load()
        corners = [px[0,0][3], px[w-1,0][3], px[0,h-1][3], px[w-1,h-1][3]]
        print(sz, 'mode', im.mode, 'corners', corners)
    except Exception as e:
        print(sz, 'ERR', e)
"@
