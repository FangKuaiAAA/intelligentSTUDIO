@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul 2>&1
title Dony App
cd /d "%~dp0"

echo.
echo   ========================================
echo        Dony 应用（历史会话 / 语音 / 文件访问）
echo   ========================================
echo.

if exist ".venv\Scripts\python.exe" (
    set "PY=.venv\Scripts\python.exe"
) else (
    set "PY=python"
)

rem 后端接口 8769（已在运行则跳过）
netstat -ano | findstr ":8769.*LISTENING" >nul 2>&1
if !errorlevel! neq 0 (
    echo   [1/2] 启动后端接口 !PY! backend\dony_app_api.py
    start "DonyApi" cmd /k !PY! backend\dony_app_api.py
    timeout /t 3 /nobreak >nul
) else (
    echo   [1/2] 后端接口已在运行
)

echo   [2/2] 启动 Dony 应用...
echo.
if exist "dony-app\bin\Debug\net8.0-windows10.0.19041.0\win-x64\Dony.exe" (
    start "" "dony-app\bin\Debug\net8.0-windows10.0.19041.0\win-x64\Dony.exe"
) else (
    pushd dony-app
    dotnet run -c Debug
    popd
)

echo.
echo   完成。关闭本窗口不会关闭应用。
pause
