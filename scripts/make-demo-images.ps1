# 生成「图乐园」演示模式（--demo）用的内置成品图。
# 只在没有配置生图模型时用来预览生成动画，不参与真实生成流程。
# 运行：powershell -ExecutionPolicy Bypass -File scripts\make-demo-images.ps1

Add-Type -AssemblyName System.Drawing

$size = 1024
$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root "playground-app\Assets\Demo"
New-Item -ItemType Directory -Force -Path $out | Out-Null

function New-Canvas([string]$file, [System.Drawing.Color]$c1, [System.Drawing.Color]$c2, [float]$angle) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $rect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $c1, $c2, $angle)
    $g.FillRectangle($brush, $rect)
    $brush.Dispose()
    return @{ Bitmap = $bmp; Graphics = $g }
}

function Add-Glow($g, [float]$cx, [float]$cy, [float]$radius, [System.Drawing.Color]$color, [int]$layers = 40) {
    # 多层低透明度同心圆近似模糊，层数足够多时不会出现明显色阶
    for ($i = $layers; $i -ge 1; $i--) {
        $r = $radius * $i / $layers
        $alpha = [int](3 + 4 * (1 - $i / $layers))
        $c = [System.Drawing.Color]::FromArgb($alpha, $color.R, $color.G, $color.B)
        $b = New-Object System.Drawing.SolidBrush($c)
        $g.FillEllipse($b, $cx - $r, $cy - $r, $r * 2, $r * 2)
        $b.Dispose()
    }
}

function Save-Scene($canvas, [string]$name) {
    $path = Join-Path $out $name
    $canvas.Bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $canvas.Graphics.Dispose()
    $canvas.Bitmap.Dispose()
    Write-Output "written $path"
}

# ---------- 1. 黄昏：暖色天空 + 落日 + 海面反光 ----------
$c = New-Canvas "sunset.png" ([System.Drawing.Color]::FromArgb(255, 48, 20, 78)) ([System.Drawing.Color]::FromArgb(255, 255, 142, 92)) 90.0
$g = $c.Graphics
Add-Glow $g 512 470 260 ([System.Drawing.Color]::FromArgb(255, 255, 236, 190)) 22
$sun = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 255, 246, 214))
$g.FillEllipse($sun, 402, 360, 220, 220)
$sun.Dispose()

$sea = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(150, 38, 18, 62))
$g.FillRectangle($sea, 0, 618, $size, $size - 618)
$sea.Dispose()

for ($i = 0; $i -lt 26; $i++) {
    $alpha = [int](120 - $i * 4)
    $w = [int](360 - $i * 9)
    $y = 632 + $i * 14
    if ($w -le 20 -or $alpha -le 0) { continue }
    $b = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb($alpha, 255, 214, 170))
    $g.FillRectangle($b, 512 - $w / 2, $y, $w, 5)
    $b.Dispose()
}
Save-Scene $c "demo-1.png"

# ---------- 2. 夜空：深蓝到紫 + 光斑 + 星点 ----------
$c = New-Canvas "night.png" ([System.Drawing.Color]::FromArgb(255, 5, 8, 28)) ([System.Drawing.Color]::FromArgb(255, 92, 42, 138)) 120.0
$g = $c.Graphics
$rand = New-Object System.Random(20261019)
$palette = @(
    [System.Drawing.Color]::FromArgb(255, 10, 132, 255),
    [System.Drawing.Color]::FromArgb(255, 191, 90, 242),
    [System.Drawing.Color]::FromArgb(255, 255, 55, 95),
    [System.Drawing.Color]::FromArgb(255, 100, 210, 255)
)
for ($i = 0; $i -lt 7; $i++) {
    $x = $rand.Next(90, 934)
    $y = $rand.Next(120, 780)
    $r = $rand.Next(90, 210)
    Add-Glow $g $x $y $r $palette[$i % $palette.Count] 16
}
for ($i = 0; $i -lt 220; $i++) {
    $x = $rand.Next(0, $size)
    $y = $rand.Next(0, $size)
    $a = $rand.Next(40, 220)
    $b = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb($a, 255, 255, 255))
    $g.FillEllipse($b, $x, $y, 2, 2)
    $b.Dispose()
}
Save-Scene $c "demo-2.png"

# ---------- 3. 晨雾：墨绿到浅绿 + 林线 + 光束 ----------
$c = New-Canvas "forest.png" ([System.Drawing.Color]::FromArgb(255, 12, 42, 34)) ([System.Drawing.Color]::FromArgb(255, 201, 216, 182)) 75.0
$g = $c.Graphics
Add-Glow $g 700 210 320 ([System.Drawing.Color]::FromArgb(255, 246, 255, 224)) 20

$beam = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(38, 255, 255, 235))
$g.FillPolygon($beam, [System.Drawing.PointF[]]@(
    (New-Object System.Drawing.PointF(760, 0)),
    (New-Object System.Drawing.PointF(960, 0)),
    (New-Object System.Drawing.PointF(430, 1024)),
    (New-Object System.Drawing.PointF(210, 1024))
))
$beam.Dispose()

$rand = New-Object System.Random(7)
for ($i = 0; $i -lt 16; $i++) {
    [float]$x = $rand.Next(-40, 1080)
    [float]$h = $rand.Next(220, 470)
    [float]$w = $rand.Next(90, 170)
    [float]$base = 1054.0
    [float]$apexX = $x + $w / 2.0
    $b = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(190, 10, 28, 24))
    $pts = [System.Drawing.PointF[]]@(
        [System.Drawing.PointF]::new($x, $base),
        [System.Drawing.PointF]::new($apexX, $base - $h),
        [System.Drawing.PointF]::new($x + $w, $base)
    )
    $g.FillPolygon($b, $pts)
    $b.Dispose()
}

$mist = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(70, 235, 245, 230))
$g.FillRectangle($mist, 0, 700, $size, 130)
$mist.Dispose()
Save-Scene $c "demo-3.png"

Write-Output "done"
