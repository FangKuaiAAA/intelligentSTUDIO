$names = @('intelligentSTUDIO','intelligentstudio-backend','Onboarding','DonySettings')
$killed = 0
foreach ($n in $names) {
    Get-Process -Name $n -ErrorAction SilentlyContinue | ForEach-Object {
        try { $_.Kill(); $killed++ } catch {}
    }
}
Start-Sleep 3
$left = @(Get-Process -Name $names -ErrorAction SilentlyContinue)
Write-Host ('killed = ' + $killed + '  remaining = ' + $left.Count)

$lock = Join-Path $env:APPDATA 'intelligentSTUDIO\lockfile'
if (Test-Path $lock) { Remove-Item $lock -Force -ErrorAction SilentlyContinue; Write-Host 'lockfile removed' }

$log = Join-Path $env:LOCALAPPDATA 'intelligentSTUDIO\logs\agent.log'
Write-Host ('agent.log exists = ' + (Test-Path $log))
