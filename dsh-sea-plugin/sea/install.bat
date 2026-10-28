@echo off
chcp 65001 >nul
title 安装识海启动器到桌面

echo ========================================
echo   识海启动器安装程序
echo ========================================
echo.

set "SEA_DIR=%~dp0"
set "VBS=%TEMP%\install_sea.vbs"

echo 正在创建桌面快捷方式...

> "%VBS%" echo Set ws = CreateObject("WScript.Shell")
>> "%VBS%" echo desktopPath = ws.SpecialFolders("Desktop")
>> "%VBS%" echo Set sc = ws.CreateShortcut(desktopPath ^& "\识海.lnk")
>> "%VBS%" echo sc.TargetPath = "%SEA_DIR%start.bat"
>> "%VBS%" echo sc.WorkingDirectory = "%SEA_DIR%"
>> "%VBS%" echo sc.Description = "DSH 识海面版 - 记忆图谱可视化"
>> "%VBS%" echo sc.Save

cscript //nologo "%VBS%"
del "%VBS%" >nul 2>&1

if exist "%USERPROFILE%\Desktop\识海.lnk" (
    echo.
    echo [成功] 桌面快捷方式已创建：识海
    echo.
    echo 双击桌面「识海」图标即可打开记忆图谱
) else (
    echo.
    echo [提示] 请手动将 start.bat 发送到桌面快捷方式
)

echo.
pause
