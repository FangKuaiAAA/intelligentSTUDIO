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
Write-Host 'all subapps built'
