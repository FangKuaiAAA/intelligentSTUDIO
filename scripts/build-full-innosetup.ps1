$iscc = "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe"
if (-not (Test-Path $iscc)) { $iscc = "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" }
Write-Host "iscc: $iscc  exists=$(Test-Path $iscc)"
if (Test-Path $iscc) {
    & $iscc "D:\OpenCode\APPXInteligent\scripts\intelligentstudio-full.iss"
    Write-Host "iscc exit: $LASTEXITCODE"
} else {
    Write-Host "ISCC not found"
}
