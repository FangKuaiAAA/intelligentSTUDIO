# intelligentSTUDIO Office add-in installer
#
# Called by settings-app (ExtensionInstallService) as:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-office-addin.ps1
# so this script MUST print a machine-readable result:
#   STATUS=READY | STATUS=ALREADY_INSTALLED | STATUS=FAILED
#   REASON=<short_code>
#
# What it does (this exact combination is what made Word 2021 pick the add-in up):
#   1. self-signed cert for https://localhost:8771  -> trusted for CurrentUser (no admin needed)
#   2. manifest copy -> %LOCALAPPDATA%\intelligentSTUDIO\office-addin
#   3. SMB share C:\Users\Public\intelligentSTUDIO-addin (elevates once if missing)
#   4. TrustedCatalogs -> \\<COMPUTERNAME>\IntelligentStudioAddin   (UNC, not file:///)
#   5. WEF\Developer subkey -> local manifest (the form this Office build actually reads)
#   6. clear Office ribbon/icon caches
#
# ASCII-only on purpose: Windows PowerShell 5.1 reads .ps1 as ANSI and mangles
# non-ASCII comments; and here-strings must keep their terminators at column 0.
param(
    [switch]$Uninstall,
    [string]$RepoRoot
)

$ErrorActionPreference = 'Stop'

$Repo = if ($RepoRoot) { $RepoRoot } else { Split-Path -Parent $PSScriptRoot }

$ShareName = 'IntelligentStudioAddin'
$ShareDir = 'C:\Users\Public\intelligentSTUDIO-addin'
$AddinId = '{8E2F4B7A-3C15-4A86-9A1D-6F0B2C9D4E11}'
$CatalogId = '{C3D8E9A1-5B27-4F1C-9E4A-2D6B8F0A1C33}'

$DevKey = 'HKCU:\Software\Microsoft\Office\16.0\WEF\Developer'
$DevSubKey = Join-Path $DevKey $AddinId
$CatalogRoot = 'HKCU:\Software\Microsoft\Office\16.0\WEF\TrustedCatalogs'
$CatalogKey = Join-Path $CatalogRoot $CatalogId

$TargetDir = Join-Path $env:LOCALAPPDATA 'intelligentSTUDIO\office-addin'
$TargetManifest = Join-Path $TargetDir 'manifest.xml'
$RepoManifest = Join-Path $Repo 'office\manifest.xml'
$StaticDir = Join-Path $Repo 'office\dist'

$CertDir = Join-Path $env:APPDATA 'Dony\office-bridge'
$CertFile = Join-Path $CertDir 'cert.pem'
$KeyFile = Join-Path $CertDir 'key.pem'
$CertScript = Join-Path $Repo 'scripts\make-office-cert.py'

$WefRoot = Join-Path $env:LOCALAPPDATA 'Microsoft\Office\16.0\Wef'

function Step([string]$Text) { Write-Host "[office-addin] $Text" }
function Warn([string]$Text) { Write-Host "[office-addin] $Text" }
function Fail([string]$Code, [string]$Text) {
    if ($Text) { Warn $Text }
    Write-Host 'STATUS=FAILED'
    Write-Host "REASON=$Code"
    exit 1
}
function Done([string]$Reason) {
    Write-Host 'STATUS=READY'
    Write-Host "REASON=$Reason"
    exit 0
}

function Clear-OfficeCaches {
    # Ribbon layout cache and icon cache: stale entries are the #1 reason a
    # manifest change "does not show up" even after restarting Office.
    foreach ($sub in @('AppCommands', 'icons')) {
        $path = Join-Path $WefRoot $sub
        if (Test-Path $path) {
            try { [System.IO.Directory]::Delete($path, $true) } catch { Warn "cache locked: $sub" }
        }
    }
}

function Test-Share {
    # 用 UNC 可达性判断共享是否存在：net share 的查询在非提权下会报 error 5，
    # 而 Test-Path 走的是正常访问路径，普通用户也能判断。
    try {
        return (Test-Path ('\\' + $env:COMPUTERNAME + '\' + $ShareName))
    } catch {
        return $false
    }
}

function New-ShareDirect {
    # 原生命令会把拒绝写进 stderr；在 ErrorActionPreference=Stop 下会被当成
    # 终止性错误，所以这里临时降级，只认退出码。
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & net share "$ShareName=$ShareDir" '/GRANT:Everyone,READ' 2>&1 | Out-Null
        return ($LASTEXITCODE -eq 0)
    } finally {
        $ErrorActionPreference = $previous
    }
}

function Ensure-Share {
    if (Test-Share) { return $true }
    if (New-ShareDirect) { return $true }

    # Needs elevation: one UAC prompt, only for this single command.
    Step 'creating SMB share (elevation required)'
    try {
        $inner = "net share $ShareName=`"$ShareDir`" /GRANT:Everyone,READ"
        Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile', '-Command', $inner -Wait -WindowStyle Hidden
    } catch {
        return $false
    }

    return (Test-Share)
}

if ($Uninstall) {
    Step 'removing registry entries'
    if (Test-Path $DevSubKey) { Remove-Item $DevSubKey -Recurse -Force -ErrorAction SilentlyContinue }
    if (Test-Path $DevKey) { Remove-ItemProperty -Path $DevKey -Name $AddinId -ErrorAction SilentlyContinue }
    if (Test-Path $CatalogKey) { Remove-Item $CatalogKey -Recurse -Force -ErrorAction SilentlyContinue }
    Step 'removing share'
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & net share $ShareName /DELETE 2>&1 | Out-Null } finally { $ErrorActionPreference = $previous }
    if (Test-Path $TargetDir) { Remove-Item $TargetDir -Recurse -Force -ErrorAction SilentlyContinue }
    Clear-OfficeCaches
    Done 'uninstalled'
}

if (-not (Test-Path $RepoManifest)) { Fail 'manifest_missing' "missing: $RepoManifest" }
if (-not (Test-Path $StaticDir)) { Warn 'pane assets not built: run npm run office:build' }

# 1. certificate: prefer the bundled one (packaged build has no Python)
if (-not ((Test-Path $CertFile) -and (Test-Path $KeyFile))) {
    $bundled = Join-Path $Repo 'office-cert'
    if ((Test-Path (Join-Path $bundled 'cert.pem')) -and (Test-Path (Join-Path $bundled 'key.pem'))) {
        Step 'using bundled certificate'
        New-Item -ItemType Directory -Force -Path $CertDir | Out-Null
        Copy-Item (Join-Path $bundled 'cert.pem') $CertFile -Force
        Copy-Item (Join-Path $bundled 'key.pem') $KeyFile -Force
    }
    elseif (Test-Path $CertScript) {
        Step 'generating certificate'
        & python $CertScript | Out-Null
        if ($LASTEXITCODE -eq 3) { Warn 'python package cryptography is missing' }
    }
}

$hasCert = (Test-Path $CertFile) -and (Test-Path $KeyFile)
if ($hasCert) {
    $trusted = $false
    try {
        Import-Certificate -FilePath $CertFile -CertStoreLocation 'Cert:\LocalMachine\Root' | Out-Null
        $trusted = $true
    } catch { }
    if (-not $trusted) {
        try {
            Import-Certificate -FilePath $CertFile -CertStoreLocation 'Cert:\CurrentUser\Root' | Out-Null
            $trusted = $true
        } catch { }
    }
    if (-not $trusted) { Warn 'certificate could not be trusted' }
} else {
    Warn 'no certificate: https://localhost:8771 will not be trusted'
}

# 2. manifest copies (share + local)
Step 'copying manifest'
New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null
New-Item -ItemType Directory -Force -Path $ShareDir | Out-Null

$content = Get-Content $RepoManifest -Raw -Encoding UTF8
if (-not $hasCert) {
    # Without a trusted cert Office will refuse https; degrade to http and say so.
    $content = $content -replace 'https://localhost:8771', 'http://localhost:8771'
}
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($TargetManifest, $content, $utf8NoBom)
[System.IO.File]::WriteAllText((Join-Path $ShareDir 'manifest.xml'), $content, $utf8NoBom)

# 3. share
$unc = '\\' + $env:COMPUTERNAME + '\' + $ShareName
if (-not (Ensure-Share)) { Fail 'share_failed' "could not share: $ShareDir" }

# 共享名可能早已被指到别的目录：那样目录登记成功但 Office 读不到清单，
# 表现为"装完还是没条目"。这里直接验证清单在共享根下可达。
if (-not (Test-Path (Join-Path $unc 'manifest.xml'))) {
    Fail 'share_mismatch' "$unc does not expose $ShareDir - delete the stale share and retry"
}

# 4. trusted catalog (UNC - file:/// is silently ignored by Office 2021)
Step "registering catalog: $unc"
if (-not (Test-Path $CatalogRoot)) { New-Item -Path $CatalogRoot -Force | Out-Null }
if (-not (Test-Path $CatalogKey)) { New-Item -Path $CatalogKey -Force | Out-Null }
Set-ItemProperty -Path $CatalogKey -Name 'Url' -Value $unc
Set-ItemProperty -Path $CatalogKey -Name 'Flags' -Value 1 -Type DWord
Set-ItemProperty -Path $CatalogKey -Name 'Id' -Value $CatalogId

# 5. developer entry: subkey + default value (value-name form is ignored here,
#    and having both forms makes the add-in disappear from "My Add-ins")
if (-not (Test-Path $DevKey)) { New-Item -Path $DevKey -Force | Out-Null }
if (-not (Test-Path $DevSubKey)) { New-Item -Path $DevSubKey -Force | Out-Null }
Set-ItemProperty -Path $DevSubKey -Name '(default)' -Value $TargetManifest -Type String
Remove-ItemProperty -Path $DevKey -Name $AddinId -ErrorAction SilentlyContinue

# 6. caches
Clear-OfficeCaches

Step "done: $unc"
if (-not $hasCert) { Done 'installed_no_cert' }
Done 'installed'
