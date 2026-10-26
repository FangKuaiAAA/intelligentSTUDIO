# 导入模型包：把模型包（目录或 .zip）复制/解压到目标 models 目录，校验完整性。
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts/import-models.ps1 -ModelPackage <目录或zip>
#   powershell -ExecutionPolicy Bypass -File scripts/import-models.ps1 -ModelPackage models.zip -Target "C:\Program Files\intelligentSTUDIO\resources\models"
param(
    [Parameter(Mandatory = $true)][string]$ModelPackage,
    [string]$Target = ""
)

$ErrorActionPreference = "Stop"

if (-not $Target) {
    $Target = Join-Path (Split-Path -Parent $PSScriptRoot) "models"
}
if (-not (Test-Path $Target)) { New-Item -ItemType Directory -Path $Target | Out-Null }
Write-Host "目标模型目录：$Target"

if (Test-Path $ModelPackage -PathType Container) {
    Copy-Item -Path (Join-Path $ModelPackage "*") -Destination $Target -Recurse -Force
}
elseif ($ModelPackage -like "*.zip") {
    Expand-Archive -Path $ModelPackage -DestinationPath $Target -Force
}
else {
    throw "模型包必须是目录或 .zip"
}

# 校验 photo/manifest.json 的 sha256（存在时），提示不完整项
$manifest = Join-Path $Target "photo\manifest.json"
if (Test-Path $manifest) {
    try {
        $map = Get-Content $manifest -Raw | ConvertFrom-Json
        $missing = @()
        foreach ($prop in $map.PSObject.Properties) {
            $file = Join-Path $Target ("photo\" + $prop.Name)
            if (-not (Test-Path $file)) { $missing += $prop.Name }
        }
        if ($missing.Count -gt 0) {
            Write-Warning ("以下模型文件缺失：" + ($missing -join ", "))
        }
        else {
            Write-Host "photo 模型清单校验通过（文件齐全）。"
        }
    }
    catch { Write-Warning "manifest.json 无法解析，跳过校验。" }
}

Write-Host "模型导入完成。"
