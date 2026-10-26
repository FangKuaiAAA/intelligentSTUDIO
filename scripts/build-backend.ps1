# 打包 backend 为 onedir 目录（intelligentstudio-backend），用户无需安装 Python。
# 输出：backend-dist/（供 electron-builder 的 extraResources 引用）。
# 用法：powershell -ExecutionPolicy Bypass -File scripts/build-backend.ps1
#
# 注意：首次打包若报 ModuleNotFoundError，按报错在下方 --collect-all / --hidden-import 补充。

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot

# 优先用主虚拟环境（含 sherpa-onnx / onnxruntime / tokenizers 等）
$Py = $null
foreach ($candidate in @("$Root\.venv\Scripts\python.exe", "$Root\.venv-photo\Scripts\python.exe")) {
    if (Test-Path $candidate) { $Py = $candidate; break }
}
if (-not $Py) { $Py = "python" }
Write-Host "使用 Python: $Py"

Push-Location $Root
try {
    # PyInstaller 默认输出到 dist/，会与 Vite 的 dist/ 冲突，改用独立目录
    $pyiDist = "$Root\build-pyi"
    $pyiWork = "$Root\build-pyi-tmp"
    # 用 cmd rmdir 清理旧产物：避免 PowerShell Remove-Item 触发大目录删除保护
    foreach ($d in @($pyiDist, $pyiWork, "$Root\backend-dist")) {
        if (Test-Path $d) { cmd /c "rmdir /s /q `"$d`"" }
    }

    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    & $Py -m PyInstaller `
        --noconfirm --clean `
        --onedir --name intelligentstudio-backend `
        --distpath $pyiDist `
        --workpath $pyiWork `
        --add-data "backend;backend" `
        --collect-all "uvicorn" `
        --collect-all "fastapi" `
        --collect-all "starlette" `
        --collect-all "pydantic" `
        --collect-all "onnxruntime" `
        --collect-all "onnxruntime_genai" `
        --collect-all "sherpa_onnx" `
        --collect-all "tokenizers" `
        --collect-all "edge_tts" `
        --collect-all "pyaudio" `
        --collect-all "uiautomation" `
        --collect-all "comtypes" `
        --hidden-import "win32com" `
        --hidden-import "win32com.client" `
        --hidden-import "win32com.propsys" `
        --hidden-import "win32clipboard" `
        --hidden-import "win32gui" `
        --hidden-import "win32api" `
        --hidden-import "win32con" `
        --hidden-import "win32process" `
        --hidden-import "win32ui" `
        --collect-all "winsdk" `
        --exclude-module "torch" `
        --exclude-module "torchgen" `
        --exclude-module "functorch" `
        --exclude-module "transformers" `
        "$Root\backend\launcher.py" 2>&1 | Out-Host
    $ErrorActionPreference = $prevEAP

    if ($LASTEXITCODE -ne 0) { throw "PyInstaller 打包失败" }

    Move-Item "$pyiDist\intelligentstudio-backend" "$Root\backend-dist"
    Write-Host "完成：$Root\backend-dist"
}
finally {
    Pop-Location
}
