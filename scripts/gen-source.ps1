$src = 'D:\OpenCode\APPXInteligent'
$staging = Join-Path $src 'build-src-staging'
$final = Join-Path $src 'release\intelligentstudio-source-0.1.1.zip'
$tmp = Join-Path $src 'release\intelligentstudio-source-0.1.1-new.zip'

if (Test-Path $staging) { cmd /c "rmdir /s /q `"$staging`"" }
New-Item -ItemType Directory -Path $staging -Force | Out-Null

$excludeDirs = @(
    'node_modules', '.venv', '.venv-photo', 'models', 'dist', 'release',
    'build-pyi', 'build-pyi-tmp', 'backend-dist', 'build-models-staging',
    'build-src-staging', 'logs', '.git', 'bin', 'obj',
    (Join-Path $src 'assets\office-cert'),
    (Join-Path $src 'assets\photo-webview')
)
robocopy $src $staging /E /XD $excludeDirs /XF *.log *.pyc _backup_*.ico /NFL /NDL /NJH /NJS /NP | Out-Null
Write-Host ('robocopy exit = ' + $LASTEXITCODE)
Write-Host ('staging files = ' + (Get-ChildItem $staging -Recurse -File | Measure-Object).Count)

if (Test-Path $tmp) { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $tmp -Force

if (Test-Path $final) { Remove-Item $final -Force -ErrorAction SilentlyContinue }
if (Test-Path $final) {
    Write-Host 'old zip still locked, kept -new.zip'
} else {
    Move-Item $tmp $final -Force
}

cmd /c "rmdir /s /q `"$staging`"" 2>$null

if (Test-Path $final) {
    $f = Get-Item $final
    Write-Host ('source zip = ' + [math]::Round($f.Length / 1MB, 2) + ' MB  ' + $f.LastWriteTime)
} else {
    Write-Host 'final zip missing'
}
