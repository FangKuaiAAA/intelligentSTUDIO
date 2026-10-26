$src = "D:\OpenCode\APPXInteligent\photo-app\webview"
$dst = "D:\OpenCode\APPXInteligent\assets\photo-webview"
if (Test-Path $dst) { cmd /c "rmdir /s /q `"$dst`"" }
New-Item -ItemType Directory -Path "$dst\dist-backend" | Out-Null
robocopy "$src\dist-backend" "$dst\dist-backend" /E /NFL /NDL /NJH /NJS /NP | Out-Null
# 依赖目录用 deps：electron-builder 会特殊排除名为 node_modules 的目录
robocopy "$src\node_modules" "$dst\deps" /E /NFL /NDL /NJH /NJS /NP | Out-Null
Copy-Item "C:\Program Files\nodejs\node.exe" "$dst\node.exe" -Force
$s = (Get-ChildItem $dst -Recurse -File | Measure-Object Length -Sum).Sum
Write-Host ("photo-webview copied: " + [math]::Round($s/1MB,1) + " MB")
