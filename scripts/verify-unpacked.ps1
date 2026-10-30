$root = 'D:\OpenCode\APPXInteligent\release\win-unpacked\resources\backend\_internal\backend\agent'

$uia = Join-Path $root 'tools\uia_screen.py'
$llm = Join-Path $root 'llm.py'

Write-Host '=== uia_screen.py ==='
if (Test-Path $uia) {
    $c = Get-Content $uia -Raw -Encoding UTF8
    Write-Host ('  _click_note 返回 (ok, note) : ' + $c.Contains('def _click_note(x: int, y: int) -> Tuple[bool, str]'))
    Write-Host ('  调用点 ok, note = ...       : ' + $c.Contains('ok, note = _click_note'))
    Write-Host ('  残留 ok=not note            : ' + $c.Contains('ok=not note'))
    Write-Host ('  坐标拦截新增偏移判定        : ' + $c.Contains('return x0 != 0 or y0 != 0'))
    Write-Host ('  uia_click 描述已强调优先    : ' + $c.Contains('要点界面时优先用它'))
} else { Write-Host '  MISSING' }

Write-Host ''
Write-Host '=== llm.py ==='
if (Test-Path $llm) {
    $c2 = Get-Content $llm -Raw -Encoding UTF8
    Write-Host ('  优先直接激活控件            : ' + $c2.Contains('先直接激活控件'))
    Write-Host ('  InvokePattern 说明          : ' + $c2.Contains('InvokePattern'))
    Write-Host ('  禁止反复点同一坐标          : ' + $c2.Contains('不要'))
    Write-Host ('  残留旧文案（第一步必须调用）: ' + $c2.Contains('第一步必须调用 uia_list_controls'))
} else { Write-Host '  MISSING' }

Write-Host ''
$exe = 'D:\OpenCode\APPXInteligent\release\win-unpacked\intelligentSTUDIO.exe'
$asar = 'D:\OpenCode\APPXInteligent\release\win-unpacked\resources\app.asar'
Write-Host ('exe        : ' + (Get-Item $exe).LastWriteTime + '  ' + [math]::Round((Get-Item $exe).Length/1MB,1) + ' MB')
Write-Host ('app.asar   : ' + (Get-Item $asar).LastWriteTime)
Write-Host ('backend dir: ' + (Test-Path (Join-Path $root 'llm.py')))
