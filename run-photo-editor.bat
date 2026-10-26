@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul 2>&1
title 照片编辑器
cd /d "%~dp0"

set "PROJ=photo-app\PhotoEditor.csproj"
set "EXE=photo-app\bin\x64\Debug\net8.0-windows10.0.19041.0\win-x64\PhotoEditor.exe"
rem 推理环境使用独立目录，避免与主后端（语音/通知）的 onnxruntime 冲突
set "VENV=.venv-photo312"
set "PY=%VENV%\Scripts\python.exe"

echo.
echo   ========================================
echo        照片编辑器（裁剪 · 滤镜 · 消除 · 扩展 · 重构）
echo   ========================================
echo.

where python >nul 2>&1
if !errorlevel! neq 0 (
    echo   [ERROR] 未找到 python，请先安装 Python 3.10 以上版本。
    pause
    exit /b 1
)

if not exist "%PY%" (
    echo   [1/4] 创建独立推理环境...
    set "PYBASE="
    if exist "%APPDATA%\uv\python\cpython-3.12.12-windows-x86_64-none\python.exe" (
        set "PYBASE=%APPDATA%\uv\python\cpython-3.12.12-windows-x86_64-none\python.exe"
    )
    if not defined PYBASE (
        py -3.12 -V >nul 2>&1 && set "PYBASE=py -3.12"
    )
    if not defined PYBASE set "PYBASE=python"

    %PYBASE% -m venv "%VENV%"
    "%PY%" -m pip install --upgrade pip >nul 2>&1
    "%PY%" -m pip install -r backend\photo\requirements.txt --quiet
    if !errorlevel! neq 0 (
        echo   [ERROR] 推理依赖安装失败，请检查网络后重试。
        pause
        exit /b 1
    )
) else (
    echo   [1/4] 推理环境已就绪
)

set "NEED_MODELS="
if not exist "models\photo\sam_encoder.onnx" set "NEED_MODELS=1"
if not exist "models\photo\moebius\unet.fp16x.onnx" set "NEED_MODELS=1"

if defined NEED_MODELS (
    echo   [2/4] 准备本地模型（分割 SAM、修补 Moebius、重建 SHARP）...
    "%PY%" scripts\fetch-photo-models.py
) else (
    echo   [2/4] 本地模型已就绪
)

echo   [3/4] 启动推理服务
start "" /b "%PY%" backend\photo_service.py

if not exist "%EXE%" (
    echo   [4/4] 首次运行，正在编译...
    dotnet build "%PROJ%" -c Debug -p:Platform=x64 --nologo -v minimal
    if !errorlevel! neq 0 (
        echo   [ERROR] 编译失败，请检查上方输出。
        pause
        exit /b 1
    )
) else (
    echo   [4/4] 已找到已编译的应用
)

start "" "%EXE%"

echo.
echo   完成。关闭本窗口不会关闭应用。
ping -n 3 127.0.0.1 >nul 2>&1
exit /b 0
