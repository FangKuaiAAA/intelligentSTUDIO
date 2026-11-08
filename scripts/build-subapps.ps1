$ErrorActionPreference = 'Stop'
Set-Location 'D:\OpenCode\APPXInteligent'
$projects = @(
    'onboarding-app\Onboarding.csproj',
    'settings-app\DonySettings.csproj',
    'dony-app\Dony.csproj',
    'playground-app\ImagePlayground.csproj',
    'photo-app\PhotoEditor.csproj'
)
$failed = @()
foreach ($p in $projects) {
    Write-Host ('=== ' + $p)
    $out = dotnet build $p -c Debug -p:Platform=x64 --nologo -v minimal 2>&1
    $errs = $out | Select-String -Pattern ': error ' | Select-Object -First 4
    if ($errs) {
        $failed += $p
        $errs | ForEach-Object { Write-Host ('  ' + $_.Line) }
    } else {
        Write-Host '  ok'
    }
}
if ($failed.Count -gt 0) { throw ('build failed: ' + ($failed -join ', ')) }

# WebView2 的运行缓存会留在 bin 目录里（Local Storage / Sync Data / *.log），
# 而 electron-builder 会把整个 bin 复制进安装包 —— 等于把开发机的浏览状态发给用户。
# 这里统一清掉；程序运行时会在 %LOCALAPPDATA% 重新生成。
$binRel = 'bin\x64\Debug\net8.0-windows10.0.19041.0\win-x64'
foreach ($proj in @('onboarding-app','settings-app','dony-app','playground-app','photo-app')) {
    $binDir = Join-Path $proj $binRel
    if (-not (Test-Path $binDir)) { continue }
    Get-ChildItem $binDir -Directory -Filter '*.exe.WebView2' -ErrorAction SilentlyContinue | ForEach-Object {
        cmd /c "rmdir /s /q `"$($_.FullName)`"" | Out-Null
        Write-Host ('  cleaned webview2 cache: ' + $_.Name)
    }
}

Write-Host 'all subapps built'
