@echo off
:menu
cls
echo ========================================
echo          MCP BRIDGE CONTROLLER
echo ========================================
echo.
echo [Y] Start Bridge
echo [X] Stop Bridge
echo [Q] Quit this menu
echo.
set /p choice="Enter your choice (Y/X/Q): "

if /i "%choice%"=="Y" goto start_bridge
if /i "%choice%"=="X" goto stop_bridge
if /i "%choice%"=="Q" goto end

echo Invalid choice. Please try again.
timeout /t 2 >nul
goto menu

:start_bridge
echo.
echo Starting bridge in the background...
start "" "C:\Users\hehe\Downloads\web-mcp-bridge-main\server\start_bridge_loop.pyw"
echo Bridge start command sent! (Check your extension to make sure it says "Connected")
timeout /t 3 >nul
goto menu

:stop_bridge
echo.
echo Stopping all background Python bridges...
taskkill /F /IM pythonw.exe >nul 2>&1
if %errorlevel%==0 (
    echo Bridge successfully stopped.
) else (
    echo No bridge was running (or it was already stopped).
)
timeout /t 3 >nul
goto menu

:end
exit