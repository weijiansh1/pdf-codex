@echo off
cd /d "%~dp0"
node --import tsx scripts/open-workbench.ts
if errorlevel 1 pause
