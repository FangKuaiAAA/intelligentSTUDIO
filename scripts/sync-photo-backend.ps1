$ErrorActionPreference = 'Stop'
Set-Location 'D:\OpenCode\APPXInteligent'

Get-Process -Name 'intelligentSTUDIO','intelligentstudio-backend','PhotoEditor' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep 2

Write-Host '--- 编译 photo-app ---'
$out = dotnet build 'photo-app\PhotoEditor.csproj' -c Debug -p:Platform=x64 --nologo -v minimal 2>&1
$errs = $out | Select-String -Pattern ': error '
if ($errs) {
    $errs | Select-Object -First 5 | ForEach-Object { Write-Host ('  ' + $_.Line) }
    throw 'photo-app 编译失败'
}
Write-Host '  ok'

$bin = 'photo-app\bin\x64\Debug\net8.0-windows10.0.19041.0\win-x64'
$res = 'release-out\win-unpacked\resources'

Write-Host '--- 同步 backend ---'
robocopy 'backend-dist' "$res\backend" /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
Write-Host ('  exit = ' + $LASTEXITCODE)

Write-Host '--- 同步 photo ---'
robocopy $bin "$res\photo" /E /XF '*.pdb' /NFL /NDL /NJH /NJS /NP | Out-Null
Write-Host ('  exit = ' + $LASTEXITCODE)

Write-Host ''
Write-Host '--- 校验 ---'
$mo = Get-Content "$res\backend\_internal\backend\photo\moebius.py" -Raw -Encoding UTF8
Write-Host ('  moebius 羽化 6.0      : ' + $mo.Contains('6.0 * min(win_w, win_h)'))
Write-Host ('  moebius 非正方形窗口   : ' + $mo.Contains('win_w'))
$dll = Join-Path "$res\photo" 'PhotoEditor.dll'
Write-Host ('  PhotoEditor.dll 时间  : ' + (Get-Item $dll).LastWriteTime)
