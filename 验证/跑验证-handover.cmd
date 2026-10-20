@echo off
REM dsh-loop-watcher handover regression suite (single stage, stage 5 only).
REM This file is intentionally 100%% ASCII: a .cmd is decoded with the console
REM code page, so a Chinese literal inside it would reach Node as mojibake.
REM The target script is located by wildcard instead of by name for that reason.
cd /d "%~dp0"
for %%f in (*-handover.mjs) do node "%%f"
echo.
pause