# 一键构建发布产物：
#   1) 去模型安装包  release/intelligentstudio-core-<ver>.exe（NSIS，≤2GB）
#   2) 含模型安装包  release/intelligentstudio-full-<ver>.exe（NSIS，不限）
#   3) 模型包        release/intelligentstudio-models-<ver>.zip（安装去模型包后复制导入）
#   4) 源码包        release/intelligentstudio-source-<ver>.zip（不含模型，单文件<100MB、总<5GB）
# 用法：powershell -ExecutionPolicy Bypass -File scripts/build-release.ps1 [-Version 1.0.0]
#
# 前置：Node.js、Python（或 .venv）、PyInstaller 已安装；首次打包按报错补 hiddenimports。

param(
    [string]$Version = "0.1.0"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Release = Join-Path $Root "release"

# 国内镜像：避免 GitHub 下载 Electron/NSIS 工具失败
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"

function Ensure-Dir($path) {
    if (-not (Test-Path $path)) { New-Item -ItemType Directory -Path $path | Out-Null }
}

Push-Location $Root
try {
    Ensure-Dir $Release

    # 0) 依赖检查
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "未找到 node" }
    if (-not (Test-Path "$Root\node_modules")) { Write-Host "安装 npm 依赖..."; npm install }

    # 0.5) 编译 WinUI3 子应用（onboarding + settings，供 extraResources 引用）
    if (Get-Command dotnet -ErrorAction SilentlyContinue) {
        Write-Host "`n编译 WinUI3 子应用 ..." -ForegroundColor Cyan
        foreach ($proj in @("onboarding-app\Onboarding.csproj", "settings-app\DonySettings.csproj", "dony-app\Dony.csproj", "playground-app\ImagePlayground.csproj", "photo-app\PhotoEditor.csproj")) {
            dotnet build "$Root\$proj" -c Debug -p:Platform=x64 --nologo -v minimal
            if ($LASTEXITCODE -ne 0) { throw "编译失败：$proj" }
        }
    }
    else {
        Write-Warning "未找到 dotnet，跳过 WinUI3 子应用编译（onboarding/settings 将缺失）"
    }

    # 0.6) 首次启动标记复位：发布版应从「未完成引导」开始
    $cfgPath = Join-Path $Root ".appx_config.json"
    if (Test-Path $cfgPath) {
        $cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $cfg.ONBOARDING_COMPLETED = $false
        $cfg | ConvertTo-Json -Depth 8 | Out-File $cfgPath -Encoding utf8
        Write-Host "已复位 ONBOARDING_COMPLETED=false"
    }

    # 1) 打包 backend（PyInstaller onedir → backend-dist/）
    Write-Host "`n[1/5] 打包 backend ..." -ForegroundColor Cyan
    & powershell -NoProfile -ExecutionPolicy Bypass -File "$Root\scripts\build-backend.ps1"

    # 2) 前端构建
    Write-Host "`n[2/5] 前端构建 ..." -ForegroundColor Cyan
    npm run build

    # 清理旧解包目录：避免 electron-builder 内部批量删除触发保护，或残留被 files 的 dist/**/* 循环打包
    foreach ($d in @("$Root\dist\win-unpacked", "$Root\release\win-unpacked")) {
        if (Test-Path $d) { cmd /c "rmdir /s /q `"$d`"" }
    }

    # 3) 去模型安装包（package.json 默认 extraResources：backend + 文本分类器）
    Write-Host "`n[3/5] 打包去模型安装包 ..." -ForegroundColor Cyan
    npx electron-builder --win nsis --config.artifactName="intelligentstudio-core-`${version}.`${ext}"

    # 4) 含模型版：NSIS 单 exe 有 2GB 上限（mmap 限制），无法打包 4GB 模型。
    #    含模型版 = 去模型安装包 + 模型包 zip：安装去模型包后用 import-models.ps1 导入模型包。
    Write-Host "`n[4/5] 含模型版 ..." -ForegroundColor Cyan
    Write-Host "含模型版不生成单文件安装包（NSIS 有 2GB 上限）。"
    Write-Host "请用「去模型安装包 + 模型包」组合：安装去模型包后执行 scripts\import-models.ps1 导入模型包。"
    $sherpaDir = "models/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20"

    # 5) 模型包（顶层为 photo/ 与 sherpa 目录，解压到 models/ 即对齐）
    Write-Host "`n[5/5] 打包模型包与源码包 ..." -ForegroundColor Cyan
    $modelsStaging = Join-Path $Root "build-models-staging"
    if (Test-Path $modelsStaging) { cmd /c "rmdir /s /q `"$modelsStaging`"" }
    Ensure-Dir $modelsStaging
    if (Test-Path "$Root\models\photo") { Copy-Item "$Root\models\photo" "$modelsStaging\photo" -Recurse }
    if (Test-Path "$Root\models\$($sherpaDir.Split('/')[-1])") {
        Copy-Item "$Root\models\$($sherpaDir.Split('/')[-1])" "$modelsStaging\$($sherpaDir.Split('/')[-1])" -Recurse
    }
    tar -a -c -f "$Release\intelligentstudio-models-$Version.zip" -C "$modelsStaging" "photo" "$($sherpaDir.Split('/')[-1])"

    # 源码包（排除依赖/编译产物/模型/构建产物，保证单文件<100MB、总<5GB）
    $srcStaging = Join-Path $Root "build-src-staging"
    if (Test-Path $srcStaging) { cmd /c "rmdir /s /q `"$srcStaging`"" }
    Ensure-Dir $srcStaging
    $exclude = @("node_modules", ".venv", ".venv-photo", "models", "dist", "release",
                 "build-pyi", "build-pyi-tmp", "backend-dist", "build-models-staging",
                 "build-src-staging", "logs", ".git", "bin", "obj")
    $args = @("$Root", "$srcStaging", "/E", "/XD") + $exclude + @("/NFL", "/NDL", "/NJH", "/NJS", "/NP")
    robocopy @args | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy 源码暂存失败" }
    Compress-Archive -Path "$srcStaging\*" -DestinationPath "$Release\intelligentstudio-source-$Version.zip" -Force

    # 清理临时文件
    foreach ($tmp in @("$Root\build-models-staging", "$Root\build-src-staging", $fullConfigPath)) {
        if (Test-Path $tmp) { cmd /c "rmdir /s /q `"$tmp`"" }
    }

    Write-Host "`n构建完成，产物位于 $Release" -ForegroundColor Green
    Get-ChildItem $Release -File | ForEach-Object {
        "{0,10:N1} MB  {1}" -f ($_.Length / 1MB), $_.Name
    }
}
finally {
    Pop-Location
}
