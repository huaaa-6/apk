@echo off
chcp 65001 >nul
title 墨阅 · MOYUE
cd /d "%~dp0"
set "MOYUE_BAT=1"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   没有找到 Node.js。
  echo   请先安装 Node.js 18 或更高版本：https://nodejs.org/
  echo.
  pause
  exit /b 1
)

echo.
echo   正在打开墨阅，请稍候…
node launcher.js
set "MOYUE_EXIT=%errorlevel%"

if "%MOYUE_EXIT%"=="2" (
  echo.
  echo   墨阅已经在运行，已为你打开浏览器。
  echo   这个窗口会在 3 秒后自动关闭。
  ping -n 4 127.0.0.1 >nul
  exit /b 0
)

if not "%MOYUE_EXIT%"=="0" (
  echo.
  echo   墨阅没有顺利启动，请把上面的提示截图或复制下来。
  echo.
  pause
  exit /b %MOYUE_EXIT%
)

exit /b 0
