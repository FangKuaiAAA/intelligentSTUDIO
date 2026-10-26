@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul 2>&1
title intelligentSTUDIO 首次启动设置
cd /d "%~dp0"

set "PROJ=onboarding-app\Onboarding.csproj"
set "EXE=onboarding-app\bin\x64\Debug\net8.0-windows10.0.19041.0\win-x64\Onboarding.exe"

echo.
echo   ========================================
echo        intelligentSTUDIO 首次启动设置（11 页）
echo   ========================================
echo.

rem 带 --rebuild 参数时强制重新编译
if /i "%~1"=="--rebuild" if exist "%EXE%" del /q "%EXE%"

if not exist "%EXE%" (
    where dotnet >nul 2>&1
    if !errorlevel! neq 0 (
        echo   [ERROR] 未找到 dotnet，请先安装 .NET 8 SDK。
        pause
        exit /b 1
    )
    echo   [1/2] 首次运行，正在编译引导应用...
    dotnet build "%PROJ%" -c Debug -p:Platform=x64 --nologo -v minimal
    if !errorlevel! neq 0 (
        echo   [ERROR] 编译失败，请检查上方输出。
        pause
        exit /b 1
    )
) else (
    echo   [1/2] 已找到已编译的应用，跳过编译
)

echo   [2/2] 启动引导
if /i "%~1"=="--step" (
    start "" "%EXE%" --step %~2
) else (
    start "" "%EXE%"
)

echo.
echo   完成。关闭本窗口不会关闭应用。
rem 用 ping 代替 timeout：timeout 在输入被重定向时会直接报错退出
ping -n 3 127.0.0.1 >nul 2>&1
exit /b 0
