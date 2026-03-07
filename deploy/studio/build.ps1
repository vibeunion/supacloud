# SupaCloud Studio Build Script (Windows)
# 构建启用云平台模式的 Studio

param(
    [switch]$Docker,
    [switch]$Push,
    [string]$Tag = "supacloud-studio:latest"
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$SupabaseDir = Join-Path $ScriptDir "..\..\supabase-studio"
$OutputDir = Join-Path $ScriptDir "dist"

Write-Host "=== SupaCloud Studio Build ===" -ForegroundColor Cyan
Write-Host ""

# 检查源码目录
if (-not (Test-Path $SupabaseDir)) {
    Write-Host "Error: Supabase source not found at $SupabaseDir" -ForegroundColor Red
    Write-Host "Please clone: git clone https://github.com/supabase/supabase.git" -ForegroundColor Yellow
    exit 1
}

# 加载环境变量
$envFile = Join-Path $ScriptDir ".env.build"
if (Test-Path $envFile) {
    Write-Host "Loading build environment..." -ForegroundColor Gray
    Get-Content $envFile | Where-Object { $_ -notmatch "^#" -and $_ -match "=" } | ForEach-Object {
        $parts = $_.Split("=", 2)
        [Environment]::SetEnvironmentVariable($parts[0].Trim(), $parts[1].Trim(), "Process")
    }
}

# 显示构建配置
Write-Host "Build Configuration:" -ForegroundColor Yellow
Write-Host "  NEXT_PUBLIC_IS_PLATFORM: $env:NEXT_PUBLIC_IS_PLATFORM"
Write-Host "  NEXT_PUBLIC_API_URL: $env:NEXT_PUBLIC_API_URL"
Write-Host "  NEXT_PUBLIC_SITE_URL: $env:NEXT_PUBLIC_SITE_URL"
Write-Host ""

if ($Docker) {
    # Docker 构建
    Write-Host "=== Building Docker Image ===" -ForegroundColor Cyan
    
    $dockerArgs = @(
        "build",
        "-t", $Tag,
        "-f", (Join-Path $ScriptDir "Dockerfile"),
        "--build-arg", "NEXT_PUBLIC_IS_PLATFORM=true",
        "--build-arg", "NEXT_PUBLIC_API_URL=/api",
        "--build-arg", "NEXT_PUBLIC_SITE_URL=https://studio.esgfarm.cn",
        "--build-arg", "NEXT_PUBLIC_ENVIRONMENT=production",
        $SupabaseDir
    )
    
    & docker $dockerArgs
    
    if ($LASTEXITCODE -eq 0) {
        Write-Host ""
        Write-Host "=== Docker Build Complete ===" -ForegroundColor Green
        Write-Host "Image: $Tag" -ForegroundColor Yellow
        
        if ($Push) {
            Write-Host ""
            Write-Host "Pushing image..." -ForegroundColor Cyan
            & docker push $Tag
        }
    }
} else {
    # 本地构建
    Write-Host "=== Installing dependencies ===" -ForegroundColor Cyan
    
    Push-Location (Join-Path $SupabaseDir "apps\studio")
    
    try {
        # 安装 pnpm
        corepack enable pnpm
        pnpm install --frozen-lockfile
        
        Write-Host ""
        Write-Host "=== Building Studio ===" -ForegroundColor Cyan
        pnpm build
        
        # 创建输出目录
        if (Test-Path $OutputDir) {
            Remove-Item -Recurse -Force $OutputDir
        }
        New-Item -ItemType Directory -Path $OutputDir | Out-Null
        
        # 复制构建产物
        Write-Host ""
        Write-Host "=== Copying build artifacts ===" -ForegroundColor Cyan
        
        Copy-Item -Recurse ".next\standalone" $OutputDir
        Copy-Item -Recurse ".next\static" (Join-Path $OutputDir ".next")
        Copy-Item -Recurse "public" $OutputDir
        
        Write-Host ""
        Write-Host "=== Build Complete ===" -ForegroundColor Green
        Write-Host "Output: $OutputDir" -ForegroundColor Yellow
        Write-Host ""
        Write-Host "To run: cd $OutputDir && node server.js" -ForegroundColor Gray
    }
    finally {
        Pop-Location
    }
}
