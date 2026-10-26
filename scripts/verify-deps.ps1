$d = "D:\OpenCode\APPXInteligent\release\win-unpacked\resources\photo-webview\deps"
Write-Host ("onnxruntime-node : " + (Test-Path "$d\onnxruntime-node"))
Write-Host ("sharp            : " + (Test-Path "$d\sharp"))
Write-Host ("node.exe         : " + (Test-Path "D:\OpenCode\APPXInteligent\release\win-unpacked\resources\photo-webview\node.exe"))
Write-Host ("worker.cjs       : " + (Test-Path "D:\OpenCode\APPXInteligent\release\win-unpacked\resources\photo-webview\dist-backend\worker.cjs"))
