@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul 2>&1
title APPXInteligent Launcher
cd /d "%~dp0"

echo.
echo   ========================================
echo        APPXInteligent One-Click Start
echo   ========================================
echo.

where node >nul 2>&1
if !errorlevel! neq 0 (
    echo [ERROR] Node.js not found in PATH
    pause
    exit /b 1
)
echo   Node.js: OK
echo.

echo   Cleaning up old processes...
rem Kill this project's electron.exe first: while it lives it auto-restarts killed
rem backend services (see main.js restart logic). Path filter avoids touching other
rem Electron apps.
rem QUOTING NOTE (verified by running this file): the whole -Command must sit in ONE
rem pair of double quotes, and the WQL filter must use single quotes with doubled
rem inner single quotes. Both \" and "" inside break cmd parsing and corrupt the rest
rem of this batch file (delayed expansion dies, '!PY!' stops expanding).
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process -Filter 'Name=''electron.exe''' | Where-Object ExecutablePath -like '*APPXInteligent*' | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>&1
rem Then free service ports: 5173 frontend / 8766 voice / 8767 agent / 8768 edge / 8769 app api / 8770 notify.
rem Port 8767 MUST be freed: agent_server exits silently when the port is taken, so
rem re-running start.bat would otherwise keep the OLD backend code running.
for %%p in (5173 8766 8767 8768 8769 8770) do (
    for /f "tokens=5" %%a in ('netstat -ano ^| findstr /R /C:":%%p .*LISTENING" 2^>nul') do (
        taskkill /PID %%a /F >nul 2>&1
    )
)
echo   Done.
echo.

if not exist "node_modules" (
    echo   Installing Node.js deps...
    call npm install
)

if exist ".venv\Scripts\python.exe" (
    set "PY=.venv\Scripts\python.exe"
) else (
    set "PY=python"
)
echo   Python: !PY!

rem ⚠ 告知 Electron：Agent 由本脚本在独立窗口启动，不要再抢占 8767。
rem   否则那份会被 taskkill 掉（见 main.js 的 killPortListener），
rem   表现为"启动几秒就自己退出"的短命窗口。详见 AGENT_EXTERNAL。
set "DONY_AGENT_EXTERNAL=1"

echo   Starting Dony Agent server...
start "DonyAgent" cmd /k !PY! -m backend.agent.agent_server

echo   Starting Dony App API (history/voice/files)...
start "DonyApi" cmd /k !PY! backend\dony_app_api.py

echo   Waiting for Dony Agent (8767)...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$d=(Get-Date).AddSeconds(25); while((Get-Date) -lt $d){ try{ $c=New-Object Net.Sockets.TcpClient; $c.Connect('127.0.0.1',8767); $c.Close(); exit 0 } catch { Start-Sleep -Milliseconds 300 } }; exit 1" >nul 2>&1
if !errorlevel! equ 0 (
    echo   Agent ready.
) else (
    echo   [WARN] Agent not ready in 25s - Electron will start its own.
)

echo   Starting APPXInteligent...
echo.
echo   Alt+Space = typing mode  ^|  Alt+D = voice mode
echo.
start "APPXInteligent" cmd /k npm run electron:dev

if /i "%~1"=="--silent" exit /b 0

echo   ========================================
echo   Keep the new window open
echo   ========================================
echo.
pause
