$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
Set-Location D:\OpenCode\APPXInteligent
foreach ($d in @("dist\win-unpacked", "release\win-unpacked")) {
    if (Test-Path $d) { cmd /c "rmdir /s /q `"$d`"" }
}
npx electron-builder --win dir
if ($LASTEXITCODE -ne 0) { throw "dir build failed" }
Write-Host "dir done"
