# Installs rgd-git for every repo on this machine. Uses Node.js when present,
# otherwise the prebuilt executable from the latest release. Re-run to update.
#
#   irm https://raw.githubusercontent.com/CannibalToast/RGD-Git/main/install.ps1 | iex
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'  # the progress bar makes Invoke-WebRequest very slow
$repo = 'https://github.com/CannibalToast/RGD-Git'
$dir = Join-Path $env:LOCALAPPDATA 'rgd-git'
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'rgd-git needs Git: https://git-scm.com' }

if (Get-Command node -ErrorAction SilentlyContinue) {
    # ponytail: tracks main; pin to a release tag if the text format ever changes.
    $tmp = Join-Path ([IO.Path]::GetTempPath()) "rgd-git-$([guid]::NewGuid())"
    New-Item -ItemType Directory -Force $tmp | Out-Null
    Invoke-WebRequest "$repo/archive/refs/heads/main.zip" -OutFile "$tmp\src.zip"
    Expand-Archive "$tmp\src.zip" $tmp
    if (Test-Path $dir) { Remove-Item $dir -Recurse -Force }
    Move-Item (Get-ChildItem $tmp -Directory | Select-Object -First 1).FullName $dir
    Remove-Item $tmp -Recurse -Force
    & node "$dir\rgd-git.js" setup --global
} else {
    Write-Host 'Node.js not found; downloading the standalone rgd-git executable...'
    New-Item -ItemType Directory -Force $dir | Out-Null
    Invoke-WebRequest "$repo/releases/latest/download/rgd-git-windows-x64.exe" -OutFile "$dir\rgd-git.exe"
    & "$dir\rgd-git.exe" setup --global
}
if ($LASTEXITCODE) { throw "rgd-git setup failed ($LASTEXITCODE)" }
