$root = 'D:\OpenCode\APPXInteligent'
$src = Join-Path $root 'release-out\win-unpacked'
$dst = Join-Path $root 'release\win-unpacked'

Get-Process -Name 'intelligentSTUDIO','intelligentstudio-backend','DonySettings','Onboarding','Dony','ImagePlayground','PhotoEditor' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep 2

# 1) 清掉空壳（它只有 resources\backend 两个空目录）
if (Test-Path $dst) {
    cmd /c "rmdir /s /q `"$dst`"" | Out-Null
    Write-Host ('清空壳后存在 = ' + (Test-Path $dst))
}
if (Test-Path $dst) {
    Write-Host '⚠ 空壳删除失败，full 打包会失败'
    exit 1
}

# 2) 从 release-out 复制，**排除** models 里的两个大模型目录：
#    full 的 .iss 会从 ..\models\ 单独复制它们到 {app}\resources\models，
#    这里若带上就会重复一份（约 3 GB）。
Write-Host '复制 release-out -> release（排除 photo / sherpa 模型）...'
robocopy $src $dst /E `
    /XD (Join-Path $src 'resources\models\photo') `
        (Join-Path $src 'resources\models\sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20') `
    /NFL /NDL /NJH /NJS /NP | Out-Null
Write-Host ('robocopy exit = ' + $LASTEXITCODE)

Write-Host ''
Write-Host '=== 结果 ==='
$exe = Join-Path $dst 'intelligentSTUDIO.exe'
Write-Host ('  exe        : ' + (Test-Path $exe))
if (Test-Path $exe) { Write-Host ('  exe 时间   : ' + (Get-Item $exe).LastWriteTime) }
Write-Host ('  backend exe: ' + (Test-Path (Join-Path $dst 'resources\backend\intelligentstudio-backend.exe')))
Write-Host '  models 内容:'
Get-ChildItem (Join-Path $dst 'resources\models') -Directory -ErrorAction SilentlyContinue |
    ForEach-Object { Write-Host ('    ' + $_.Name) }

$size = (Get-ChildItem $dst -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
Write-Host ('  总体积     : {0:N1} GB' -f ($size / 1GB))
