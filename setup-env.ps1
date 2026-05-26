# BizGraph Windows 环境检查与安装脚本
# 以管理员身份运行 PowerShell，然后执行: .\setup-env.ps1

$Host.UI.RawUI.WindowTitle = "BizGraph 环境配置"

function Write-Status {
    param([string]$Message, [string]$Status)
    switch ($Status) {
        "OK"    { Write-Host "[OK] $Message" -ForegroundColor Green }
        "WARN"  { Write-Host "[!] $Message" -ForegroundColor Yellow }
        "FAIL"  { Write-Host "[X] $Message" -ForegroundColor Red }
        "INFO"  { Write-Host "[*] $Message" -ForegroundColor Cyan }
        default { Write-Host "    $Message" }
    }
}

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "   BizGraph Windows 环境检查与安装脚本   " -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

# 1. 检查 Node.js
$nodeVersion = $null
try {
    $nodeVersion = node -v 2>$null
} catch {}

if ($nodeVersion) {
    Write-Status "Node.js $nodeVersion" "OK"
    $major = [int]($nodeVersion -replace '^v(\d+).*','$1')
    if ($major -lt 20) {
        Write-Status "Node.js 版本过低，建议升级到 v22 LTS" "WARN"
    }
} else {
    Write-Status "Node.js 未安装" "FAIL"
    Write-Host ""
    Write-Status "安装方式 (任选其一):" "INFO"
    Write-Host "  1. 官网下载: https://nodejs.org/dist/v22.14.0/node-v22.14.0-x64.msi"
    Write-Host "  2. Winget:   winget install OpenJS.NodeJS.LTS"
    Write-Host "  3. Chocolatey: choco install nodejs-lts"
    Write-Host ""
    Write-Host "安装完成后重新运行此脚本。" -ForegroundColor Yellow
    Read-Host "按 Enter 退出"
    exit 1
}

# 2. 检查 npm
$npmVersion = $null
try {
    $npmVersion = npm -v 2>$null
} catch {}

if ($npmVersion) {
    Write-Status "npm v$npmVersion" "OK"
} else {
    Write-Status "npm 未找到（Node.js 安装可能不完整）" "FAIL"
    Read-Host "按 Enter 退出"
    exit 1
}

# 3. 检查 Git
try {
    $gitVersion = git --version 2>$null
    Write-Status "$gitVersion" "OK"
} catch {
    Write-Status "Git 未安装（可选，但建议安装）" "WARN"
    Write-Host "  下载: https://git-scm.com/download/win"
}

# 4. 安装项目依赖
Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "   开始安装项目依赖...                    " -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $projectRoot

Write-Status "正在执行 npm install，这可能需要几分钟..." "INFO"
npm install

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Status "依赖安装失败" "FAIL"
    Write-Status "尝试使用国内镜像重新安装..." "INFO"
    npm config set registry https://registry.npmmirror.com
    npm install
    npm config set registry https://registry.npmjs.org
}

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Status "安装仍然失败，请检查网络连接" "FAIL"
    Read-Host "按 Enter 退出"
    exit 1
}

Write-Host ""
Write-Host "==========================================" -ForegroundColor Green
Write-Host "   环境配置完成！                         " -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Green
Write-Host ""

# 5. 可选：检测已安装的 Agent CLI
Write-Status "检测 Agent CLI..." "INFO"

$agents = @(
    @{ Name = "claude"; Display = "Claude Code"; Install = "npm install -g @anthropic-ai/claude-code" },
    @{ Name = "codex"; Display = "Codex CLI"; Install = "npm install -g @openai/codex" },
    @{ Name = "opencode"; Display = "OpenCode"; Install = "npm install -g opencode" }
)

foreach ($agent in $agents) {
    try {
        $ver = & $agent.Name --version 2>$null
        if ($ver) {
            Write-Status "$($agent.Display) 已安装 ($ver)" "OK"
        } else {
            Write-Status "$($agent.Display) 未安装  ->  $($agent.Install)" "WARN"
        }
    } catch {
        Write-Status "$($agent.Display) 未安装  ->  $($agent.Install)" "WARN"
    }
}

Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "   常用命令                               " -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  启动开发模式:  npm run dev"
Write-Host "  构建应用:      npm run build"
Write-Host "  运行测试:      npm run test:e2e"
Write-Host "  代码检查:      npm run lint"
Write-Host ""
Read-Host "按 Enter 退出"
