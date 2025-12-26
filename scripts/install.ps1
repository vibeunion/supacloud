# SupaCloud Installer for Windows (PowerShell)
param (
    [switch]$CN
)

$ErrorActionPreference = "Stop"

$Repo = "zuohuadong/supacloud"
$GithubUrl = "https://github.com"
$ApiUrl = "https://api.github.com"

if ($CN -or $env:SUPACLOUD_CN) {
    Write-Host "Using ghproxy.net for faster download in China..."
    $GithubUrl = "https://ghproxy.net/https://github.com"
}

# Determine Architecture
$Arch = $env:PROCESSOR_ARCHITECTURE
if ($Arch -eq "AMD64") {
    $BinaryName = "supacloud-windows-x64.exe"
} elseif ($Arch -eq "ARM64") {
    # Fallback to x64 for now as Bun Windows ARM64 support is experimental
    Write-Host "ARM64 detected. Using x64 binary (emulation)..."
    $BinaryName = "supacloud-windows-x64.exe"
} else {
    Write-Error "Unsupported Architecture: $Arch"
    exit 1
}

Write-Host "Detecting latest release..."
try {
    $LatestRelease = Invoke-RestMethod -Uri "${ApiUrl}/repos/${Repo}/releases/latest"
    $LatestTag = $LatestRelease.tag_name
} catch {
    Write-Error "Failed to fetch latest release tag."
    exit 1
}

$DownloadUrl = "${GithubUrl}/${Repo}/releases/download/${LatestTag}/${BinaryName}"
$InstallDir = "$env:USERPROFILE\.supacloud\bin"
$TargetFile = "$InstallDir\supacloud.exe"

Write-Host "Downloading SupaCloud CLI ($LatestTag)..."
Write-Host "URL: $DownloadUrl"

if (-not (Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
}

Invoke-WebRequest -Uri $DownloadUrl -OutFile $TargetFile

Write-Host "Configuring PATH..."
$CurrentPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($CurrentPath -notlike "*$InstallDir*") {
    [Environment]::SetEnvironmentVariable("Path", "$CurrentPath;$InstallDir", "User")
    Write-Host "✅ Added $InstallDir to User PATH."
    Write-Host "⚠️  You may need to restart your terminal."
} else {
    Write-Host "✅ Already in PATH."
}

Write-Host "✅ SupaCloud CLI installed successfully!"
Write-Host "Run 'supacloud help' to get started."
