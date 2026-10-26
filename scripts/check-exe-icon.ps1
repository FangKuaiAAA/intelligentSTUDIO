Add-Type -AssemblyName System.Drawing
$exe = "D:\OpenCode\APPXInteligent\settings-app\bin\x64\Debug\net8.0-windows10.0.19041.0\win-x64\DonySettings.exe"
Write-Host ("exe exists: " + (Test-Path $exe))
if (Test-Path $exe) {
    Write-Host ("exe mtime: " + (Get-Item $exe).LastWriteTime)
    $ic = [System.Drawing.Icon]::ExtractAssociatedIcon($exe)
    if ($ic) {
        Write-Host ("icon size: " + $ic.Width + "x" + $ic.Height)
        $bmp = $ic.ToBitmap()
        $px = $bmp.GetPixel(0, 0)
        Write-Host ("corner ARGB: A=" + $px.A + " R=" + $px.R + " G=" + $px.G + " B=" + $px.B)
        $bmp.Dispose(); $ic.Dispose()
    }
}
Write-Host ("ico mtime: " + (Get-Item "D:\OpenCode\APPXInteligent\assets\icons\intelligentSTUDIO.ico").LastWriteTime)
