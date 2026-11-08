$src = 'D:\OpenCode\APPXInteligent\models'
$dst = 'D:\OpenCode\APPXInteligent\release-out\win-unpacked\resources\models'

if (-not (Test-Path $dst)) { New-Item -ItemType Directory -Path $dst -Force | Out-Null }

foreach ($name in @('photo', 'sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20')) {
    $s = Join-Path $src $name
    $d = Join-Path $dst $name
    if (-not (Test-Path $s)) { Write-Host ('MISSING source: ' + $s); continue }
    Write-Host ('复制 ' + $name + ' ...')
    robocopy $s $d /E /NFL /NDL /NJH /NJS /NP | Out-Null
    Write-Host ('  robocopy exit = ' + $LASTEXITCODE)
}

Write-Host ''
Write-Host '=== 复制后 ==='
Get-ChildItem $dst -Directory | ForEach-Object {
    $cnt = (Get-ChildItem $_.FullName -Recurse -File -ErrorAction SilentlyContinue | Measure-Object).Count
    Write-Host ('  {0,-58} 文件 {1}' -f $_.Name, $cnt)
}
