$src = 'D:\OpenCode\APPXInteligent\backend-dist'
$dst = 'D:\OpenCode\APPXInteligent\release\win-unpacked\resources\backend'

if (-not (Test-Path (Join-Path $src 'intelligentstudio-backend.exe'))) {
    Write-Host 'ERROR: backend-dist missing exe'; exit 1
}
if (-not (Test-Path 'D:\OpenCode\APPXInteligent\release\win-unpacked')) {
    Write-Host 'ERROR: win-unpacked missing'; exit 1
}

Get-Process -Name 'intelligentSTUDIO','intelligentstudio-backend','DonySettings','Onboarding','Dony','ImagePlayground','PhotoEditor' -ErrorAction SilentlyContinue |
    Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep 2

if (Test-Path $dst) { cmd /c "rmdir /s /q `"$dst`"" }
robocopy $src $dst /E /NFL /NDL /NJH /NJS /NP | Out-Null
Write-Host ('robocopy exit = ' + $LASTEXITCODE)

$sel = Join-Path $dst '_internal\backend\agent\selection.py'
if (Test-Path $sel) {
    $c = Get-Content $sel -Raw
    Write-Host ('selection.py has _near_selection : ' + $c.Contains('_near_selection'))
    Write-Host ('selection.py has is_click      : ' + $c.Contains('is_click'))
    Write-Host ('selection.py has _log_event     : ' + $c.Contains('_log_event'))
} else {
    Write-Host 'selection.py not found in package (may be compiled only)'
}
Write-Host ('backend.exe exists : ' + (Test-Path (Join-Path $dst 'intelligentstudio-backend.exe')))
