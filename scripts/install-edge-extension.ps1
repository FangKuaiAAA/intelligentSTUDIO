# Visual intelligence (Edge extension) - installer
#
# NOTE: this file is intentionally ASCII-only and contains no here-strings.
# Windows PowerShell 5.1 reads .ps1 as ANSI and requires here-string terminators
# to start at column 0; both have bitten us before. Keep it plain.
#
# What it does:
#   1. finds the built extension (repo: extension\dist, packaged: resources\extension)
#   2. copies it to a stable location: %LOCALAPPDATA%\intelligentSTUDIO\edge-extension
#   3. records the install in edge-extension.json (version + path + time)
#   4. opens edge://extensions and puts the path on the clipboard
#
# "Already installed" rule (the settings button must not reinstall every click).
# It must be evidence-based, never "we copied the files once":
#   1. the bridge reports a healthy connection with the SAME version -> skip
#   2. or Edge's profile lists our unpacked extension (location=4) with the SAME version -> skip
#   3. installed but a different version      -> stage the files again + tell the user to reload
#   4. not installed at all (files may still be staged) -> ready to load
# Case 4 is why the recorded state must NOT decide anything: after the user removes the
# extension in edge://extensions the staged folder stays, and "recorded" would lie.
#
# Why not fully silent: Edge does not accept unpacked (MV3) extensions from a
# registry path, and it rejects locally packed CRX files registered as external
# extensions - both verified on this machine. Loading unpacked stays a two-click
# action in edge://extensions, so this script makes the folder ready and opens
# the page instead of pretending to install silently.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/install-edge-extension.ps1
#   ... -NoOpen     (prepare files only, do not touch the browser)
#   ... -Force      (reinstall even if it looks installed)
#   ... -Uninstall  (remove the staged copy and the recorded state)
#
# Output (parsed by settings-app\Services\ExtensionInstallService.cs):
#   STATUS=ALREADY_INSTALLED | READY | FAILED
#   REASON=running | installed | version_changed | copied | <error>
#   VERSION=<manifest version>
#   PATH=<staged folder>

param(
    [string]$RepoRoot = '',
    [switch]$Force,
    [switch]$NoOpen,
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

function StepMsg([string]$Text) { Write-Host "[edge-extension] $Text" -ForegroundColor Cyan }
function WarnMsg([string]$Text) { Write-Host "[edge-extension] $Text" -ForegroundColor Yellow }

$TargetDir = Join-Path $env:LOCALAPPDATA 'intelligentSTUDIO\edge-extension'
$StateFile = Join-Path $env:LOCALAPPDATA 'intelligentSTUDIO\edge-extension.json'
$BridgeHealth = 'http://127.0.0.1:8768/health'

if ($Uninstall) {
    StepMsg "Remove staged copy: $TargetDir"
    if (Test-Path $TargetDir) { Remove-Item $TargetDir -Recurse -Force }
    if (Test-Path $StateFile) { Remove-Item $StateFile -Force }
    StepMsg 'Done. Remove the extension itself in edge://extensions if it is still listed.'
    return
}

# ---------- 1. locate the built extension ----------
$repo = if ($RepoRoot) { $RepoRoot } else { Split-Path -Parent $PSScriptRoot }
$candidates = @(
    (Join-Path $repo 'extension\dist'),
    (Join-Path $repo 'resources\extension'),
    (Join-Path $repo 'extension')
)
$source = $null
foreach ($dir in $candidates) {
    if ((Test-Path (Join-Path $dir 'manifest.json')) -and (Test-Path (Join-Path $dir 'background.js'))) {
        $source = $dir
        break
    }
}
if (-not $source) {
    Write-Output 'STATUS=FAILED'
    Write-Output 'REASON=build_missing'
    WarnMsg 'Extension build not found. Run: npm run build (inside extension folder)'
    exit 1
}
$source = (Resolve-Path $source).Path

$manifest = Get-Content (Join-Path $source 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$version = [string]$manifest.version
StepMsg "Source: $source (version $version)"

# ---------- 2. already installed? ----------
function Get-BridgeHealth {
    try { return Invoke-RestMethod -Uri $BridgeHealth -TimeoutSec 2 -ErrorAction Stop }
    catch { return $null }
}

function Write-State([string]$Status) {
    $dir = Split-Path -Parent $StateFile
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $state = [ordered]@{
        version     = $version
        path        = $TargetDir
        status      = $Status
        installedAt = (Get-Date).ToString('o')
    }
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($StateFile, ($state | ConvertTo-Json), $utf8NoBom)
}

$stagedManifest = Join-Path $TargetDir 'manifest.json'

$health = Get-BridgeHealth
# Only a healthy (heartbeat-backed) connection counts as "in use"; a half-open socket
# keeps reporting connected for a while after the extension is removed.
$live = [bool]($health -and $health.extension_healthy)
$liveVersion = if ($live) { [string]$health.extension_version } else { '' }

# Edge keeps extension state in "Secure Preferences" (list of profiles); entries with
# location=4 are the unpacked ones loaded via "Load unpacked".
function Get-EdgeUnpackedExtension {
    $root = if ($env:EDGE_PROFILES_ROOT) { $env:EDGE_PROFILES_ROOT }
            else { Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\User Data' }
    if (-not (Test-Path $root)) { return $null }
    $found = @()
    foreach ($prof in (Get-ChildItem $root -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -eq 'Default' -or $_.Name -like 'Profile*' })) {
        foreach ($fileName in @('Secure Preferences', 'Preferences')) {
            $file = Join-Path $prof.FullName $fileName
            if (-not (Test-Path $file)) { continue }
            try { $json = Get-Content $file -Raw -Encoding UTF8 | ConvertFrom-Json } catch { continue }
            if (-not $json.extensions) { continue }
            $settings = $json.extensions.settings
            if (-not $settings) { continue }
            foreach ($prop in $settings.PSObject.Properties) {
                $entry = $prop.Value
                if (-not $entry) { continue }
                if (-not $entry.location -or [int]$entry.location -ne 4) { continue }
                $name = if ($entry.manifest) { [string]$entry.manifest.name } else { '' }
                $dir = [string]$entry.path
                $isOurs = ($name -eq 'Visual intelligence') -or
                          ($dir -and ($dir.TrimEnd('\') -ieq $TargetDir.TrimEnd('\')))
                if (-not $isOurs) { continue }
                $ver = if ($entry.manifest) { [string]$entry.manifest.version } else { '' }
                $found += [pscustomobject]@{ version = $ver; path = $dir; id = $prop.Name }
            }
        }
    }
    if (-not $found) { return $null }
    # Several profiles may match: prefer the one pointing at our staged folder
    $preferred = $found | Where-Object { $_.path -and ($_.path.TrimEnd('\') -ieq $TargetDir.TrimEnd('\')) }
    if ($preferred) { return $preferred[0] }
    return $found[0]
}

$installed = Get-EdgeUnpackedExtension

function Complete-AlreadyInstalled([string]$reason, [string]$message) {
    StepMsg $message
    Write-Output 'STATUS=ALREADY_INSTALLED'
    Write-Output ("REASON=" + $reason)
    Write-Output ("VERSION=" + $version)
    Write-Output ("PATH=" + $TargetDir)
}

if (-not $Force) {
    if ($live -and $liveVersion -eq $version) {
        Complete-AlreadyInstalled 'running' "Extension is connected and up to date (version $version). Nothing to do."
        return
    }
    if ($installed -and ([string]$installed.version -eq $version)) {
        Complete-AlreadyInstalled 'installed' "Edge already has version $version loaded (from $($installed.path)). Nothing to do."
        return
    }
}

# ---------- 3. stage the files ----------
StepMsg "Copy to $TargetDir"
if (Test-Path $TargetDir) { Remove-Item $TargetDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null
Copy-Item (Join-Path $source '*') $TargetDir -Recurse -Force

if (-not (Test-Path $stagedManifest)) {
    Write-Output 'STATUS=FAILED'
    Write-Output 'REASON=copy_failed'
    WarnMsg "Copy failed: $stagedManifest is missing."
    exit 1
}
Write-State 'ready'

# Installed but with another version: files are refreshed, the user must click
# "Reload" on the extension card in edge://extensions.
$reason = 'copied'
if ($installed -or $live) { $reason = 'version_changed' }

# ---------- 4. hand over to the browser ----------
if (-not $NoOpen) {
    try { Set-Clipboard -Value $TargetDir } catch { }
    $edge = @(
        (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
        (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe')
    ) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
    if ($edge) {
        StepMsg 'Opening edge://extensions (the folder is on the clipboard)'
        Start-Process -FilePath $edge -ArgumentList 'edge://extensions/'
    }
    else {
        WarnMsg 'msedge.exe not found; open edge://extensions manually.'
    }
}

StepMsg 'Staged. In edge://extensions turn on Developer mode, click "Load unpacked" and paste the folder.'
Write-Output 'STATUS=READY'
Write-Output ("REASON=" + $reason)
Write-Output ("VERSION=" + $version)
Write-Output ("PATH=" + $TargetDir)
