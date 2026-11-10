# Installs rgd-git for every repo on this machine. Uses Node.js when present,
# otherwise the prebuilt executable from the latest release. Re-run to update.
#
#   irm https://raw.githubusercontent.com/CannibalToast/RGD-Git/main/install.ps1 | iex
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'  # the progress bar makes Invoke-WebRequest very slow
$repo = 'https://github.com/CannibalToast/RGD-Git'
$dir = Join-Path $env:LOCALAPPDATA 'rgd-git'

function Stop-Install($why, $fix) { Write-Host "rgd-git install failed: $why`n  -> $fix" -ForegroundColor Red; exit 1 }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Stop-Install 'git is not installed or not on PATH' 'install Git from https://git-scm.com then re-run' }

# Get-Download <url> <dest> <label>: heartbeat while the file lands so a quiet
# 100 MB fetch never looks stalled. Throws if the file never landed or is
# suspiciously small (a 404 page saved as the binary).
function Get-Download($url, $dest, $label) {
    $wc = New-Object System.Net.WebClient
    $wc.DownloadFileAsync($url, $dest)
    $chars = '-\|/'; $i = 0
    while ($wc.IsBusy) {
        Write-Host "`r$($chars[$i]) $label" -NoNewline
        $i = ($i + 1) % 4; Start-Sleep -Milliseconds 100
    }
    $wc.Dispose()
    Write-Host "`r$(' ' * 50)`r" -NoNewline
    if (-not (Test-Path $dest) -or (Get-Item $dest).Length -lt 10KB) {
        Stop-Install "download did not produce a usable file ($url)" 'check your network, then re-run'
    }
}

try {
    if (Get-Command node -ErrorAction SilentlyContinue) {
        # ponytail: tracks main; pin to a release tag if the text format ever changes.
        $tmp = Join-Path ([IO.Path]::GetTempPath()) "rgd-git-$([guid]::NewGuid())"
        New-Item -ItemType Directory -Force $tmp | Out-Null
        Get-Download "$repo/archive/refs/heads/main.zip" "$tmp\src.zip" 'downloading rgd-git'
        Write-Host 'extracting...'
        Expand-Archive "$tmp\src.zip" $tmp -ErrorAction Stop
        if (Test-Path $dir) { Remove-Item $dir -Recurse -Force }
        Move-Item (Get-ChildItem $tmp -Directory | Select-Object -First 1).FullName $dir -ErrorAction Stop
        Remove-Item $tmp -Recurse -Force
        & node "$dir\rgd-git.js" setup --global
        if ($LASTEXITCODE) { Stop-Install "setup failed (exit $LASTEXITCODE)" "run: node `"$dir\rgd-git.js`" doctor — it prints the broken link and the fix" }
        $upd = "node `"$dir\rgd-git.js`" update"
    } else {
        Write-Host 'Node.js not found; downloading the standalone rgd-git executable...'
        New-Item -ItemType Directory -Force $dir | Out-Null
        Get-Download "$repo/releases/latest/download/rgd-git-windows-x64.exe" "$dir\rgd-git.exe" 'downloading rgd-git (~100 MB)'
        & "$dir\rgd-git.exe" setup --global
        if ($LASTEXITCODE) { Stop-Install "setup failed (exit $LASTEXITCODE)" "run: `"$dir\rgd-git.exe`" doctor — it prints the broken link and the fix" }
        $upd = "`"$dir\rgd-git.exe`" update"
    }
} catch {
    Stop-Install "$($_.Exception.Message)" 're-run this script; if it persists, open an issue at https://github.com/CannibalToast/RGD-Git/issues'
}
Write-Host "rgd-git installed — every repo on this machine is set up. Update later: $upd"
