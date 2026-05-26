@echo off
chcp 65001 >nul
echo ==========================================
echo    BizGraph Windows 环境检查与安装脚本
echo ==========================================
echo.

:: 检查 Node.js
node -v >nul 2>&1
if errorlevel 1 (
    echo [X] Node.js 未安装
    echo.
    echo 请访问 https://nodejs.org 下载并安装 Node.js 22 LTS 版本
    echo 或使用 winget 安装:
    echo   winget install OpenJS.NodeJS.LTS
    echo.
    pause
    exit /b 1
) else (
    for /f "tokens=*" %%a in ('node -v') do echo [OK] Node.js %%a
)

:: 检查 npm
npm -v >nul 2>&1
if errorlevel 1 (
    echo [X] npm 未找到
    pause
    exit /b 1
) else (
    for /f "tokens=*" %%a in ('npm -v') do echo [OK] npm %%a
)

:: 检查 Git
git --version >nul 2>&1
if errorlevel 1 (
    echo [!] Git 未安装（可选，建议安装）
) else (
    for /f "tokens=*" %%a in ('git --version') do echo [OK] %%a
)

echo.
echo ==========================================
echo    开始安装项目依赖...
echo ==========================================
echo.

cd /d "%~dp0"
npm install
if errorlevel 1 (
    echo.
    echo [X] 依赖安装失败
    pause
    exit /b 1
)

echo.
echo ==========================================
echo    依赖安装完成！
echo ==========================================
echo.
echo 可选：安装 Agent CLI
echo   npm install -g @anthropic-ai/claude-code
echo   npm install -g @openai/codex
echo   npm install -g opencode
echo.
echo 启动开发模式：
echo   npm run dev
echo.
pause
