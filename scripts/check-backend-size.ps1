$nm = "D:\OpenCode\APPXInteligent\photo-app\webview\node_modules"
$files = Get-ChildItem $nm -Recurse -File -ErrorAction SilentlyContinue
$size = ($files | Measure-Object Length -Sum).Sum
Write-Host ("node_modules: " + [math]::Round($size/1MB,1) + " MB, files=" + $files.Count)
$node = "C:\Program Files\nodejs\node.exe"
if (Test-Path $node) { Write-Host ("node.exe: " + [math]::Round((Get-Item $node).Length/1MB,1) + " MB") }
$dist = "D:\OpenCode\APPXInteligent\photo-app\webview\dist-backend"
Get-ChildItem $dist -ErrorAction SilentlyContinue | Select-Object Name, Length | Format-Table -AutoSize | Out-String -Width 100
