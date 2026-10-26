# 单独打包去模型版 NSIS 安装包（假定 backend-dist 与前端 dist 已就绪）
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
Set-Location D:\OpenCode\APPXInteligent
# 预清理：避免 electron-builder 内部批量删除触发保护，或残留被 files 的 dist/**/* 循环打包
foreach ($d in @("dist\win-unpacked", "release\win-unpacked")) {
    if (Test-Path $d) { cmd /c "rmdir /s /q `"$d`"" }
}
npx electron-builder --win nsis --config.artifactName='intelligentstudio-core-${version}.${ext}'
Write-Host "core done"
