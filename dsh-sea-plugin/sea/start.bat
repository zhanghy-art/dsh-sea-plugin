@echo off
chcp 65001 >nul
title DSH 识海面版

echo ========================================
echo   DSH 识海面版启动中...
echo ========================================
echo.

set "DIR=%~dp0"

:: 检查Python
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 未找到Python，请先安装Python 3.8+
    pause
    exit /b 1
)

:: 检查端口是否已被占用
netstat -ano | findstr ":8765 " | findstr "LISTENING" >nul 2>&1
if %errorlevel% equ 0 (
    echo [提示] 后端服务已在运行
) else (
    echo [启动] 正在启动后端服务...
    start /min "DSH Sea Server" python "%DIR%..\server\sea_server.py"
    timeout /t 2 /nobreak >nul
)

echo [打开] 正在打开识海面版...
start "" http://localhost:8765/

echo.
echo 识海面版已启动
echo 关闭此窗口不会停止后端服务
echo.
pause
