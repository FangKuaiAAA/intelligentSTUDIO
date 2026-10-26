Write-Host ""
Write-Host "  ========================================" -ForegroundColor Cyan
Write-Host "       APPXInteligent 一键启动" -ForegroundColor White
Write-Host "  ========================================" -ForegroundColor Cyan
Write-Host ""

# Check prerequisites
$pythonOk = $true
try { $null = Get-Command python -ErrorAction Stop } catch { $pythonOk = $false }
if (-not $pythonOk) {
    Write-Host "ERROR: Python not found in PATH!" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

$nodeOk = $true
try { $null = Get-Command node -ErrorAction Stop } catch { $nodeOk = $false }
if (-not $nodeOk) {
    Write-Host "ERROR: Node.js not found in PATH!" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

Write-Host "  Python: OK | Node.js: OK" -ForegroundColor Green
Write-Host ""

# Prompt
$apiUrl = Read-Host "API Base URL (Enter = https://api.openai.com/v1)"
if (-not $apiUrl) { $apiUrl = "https://api.openai.com/v1" }

$modelName = Read-Host "Model name (Enter = gpt-4o-mini)"
if (-not $modelName) { $modelName = "gpt-4o-mini" }

$apiKey = Read-Host "API Key"
if (-not $apiKey) {
    Write-Host "ERROR: API Key required!" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

# Save config to temp file
$configFile = Join-Path $env:TEMP "appx_config.txt"
$env:OPENAI_API_KEY = $apiKey
$env:OPENAI_API_BASE = $apiUrl
$env:OPENAI_MODEL = $modelName

# Write as KEY=VALUE pairs for CMD compatibility
"OPENAI_API_KEY=$apiKey" | Out-File -LiteralPath $configFile -Encoding ASCII
"OPENAI_API_BASE=$apiUrl" | Out-File -LiteralPath $configFile -Encoding ASCII -Append
"OPENAI_MODEL=$modelName" | Out-File -LiteralPath $configFile -Encoding ASCII -Append

Write-Host "  Cleaning up old processes..." -ForegroundColor Gray
# 5173 被上一次的僵尸 vite 占住时，vite(strictPort) 会直接退出，wait-on 永远等不到、electron 起不来
Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique |
    ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
Write-Host "  Done." -ForegroundColor Gray
Write-Host ""

Write-Host ""
Write-Host "[1/2] Starting Python backend..." -ForegroundColor Green

# 优先使用项目内虚拟环境 .venv（含 pyaudio/sherpa-onnx/edge-tts 等依赖）
$venvPy = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
$py = if (Test-Path $venvPy) { $venvPy } else { "python" }
Write-Host "  Python: $py" -ForegroundColor Green

# Use CMD to launch backend (avoids PowerShell quoting nightmares)
$backendCmd = "cd /d `"$PSScriptRoot`" && for /f `"usebackq tokens=1,* delims==`" %a in (`"$configFile`") do set `"%a=%b`" && `"$py`" backend\main.py"
Start-Process cmd -ArgumentList "/k", $backendCmd

Write-Host "  Waiting 3s for backend..." -ForegroundColor Gray
Start-Sleep -Seconds 3

Write-Host "[2/3] Starting Dony Agent server..." -ForegroundColor Green
$agentCmd = "cd /d `"$PSScriptRoot`" && for /f `"usebackq tokens=1,* delims==`" %a in (`"$configFile`") do set `"%a=%b`" && `"$py`" -m backend.agent.agent_server"
Start-Process cmd -ArgumentList "/k", $agentCmd

Write-Host "  Starting Dony App API (8769)..." -ForegroundColor Green
$appApiCmd = "cd /d `"$PSScriptRoot`" && `"$py`" backend\dony_app_api.py"
Start-Process cmd -ArgumentList "/k", $appApiCmd

Write-Host "[3/3] Starting Electron frontend..." -ForegroundColor Green

# 告诉 Electron：Agent 已在独立窗口启动，不要再抢占 8767（否则那份会被 taskkill）
$env:DONY_AGENT_EXTERNAL = "1"
$frontendCmd = "cd /d `"$PSScriptRoot`" && npm run electron:dev"
Start-Process cmd -ArgumentList "/k", $frontendCmd

Write-Host ""
Write-Host "  ========================================" -ForegroundColor Cyan
Write-Host "  Done! Press Alt+Space to wake assistant" -ForegroundColor White
Write-Host "  Keep both new windows open" -ForegroundColor Yellow
Write-Host "  ========================================" -ForegroundColor Cyan
Write-Host ""

Read-Host "Press Enter to close this window"
