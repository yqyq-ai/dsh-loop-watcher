@echo off
rem Entry point: runs the full five-stage suite.
rem The real script is verify.ps1, which is UTF-8 with BOM so it may contain Chinese.
rem This .cmd stays ASCII-only: a .cmd is decoded with the console code page,
rem so a Chinese literal here would be mangled before PowerShell ever sees it.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0verify.ps1"
echo.
pause