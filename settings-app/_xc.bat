@echo off
cd /d "%~dp0"
set LOG=obj\x64\Debug\net8.0-windows10.0.19041.0\win-x64\_xc.log
"C:\Users\fangjiahe\.nuget\packages\microsoft.windowsappsdk\1.6.250205002\tools\net472\XamlCompiler.exe" "obj\x64\Debug\net8.0-windows10.0.19041.0\win-x64\input.json" "obj\x64\Debug\net8.0-windows10.0.19041.0\win-x64\output.json" > "%LOG%" 2>&1
echo EXIT=%ERRORLEVEL%>> "%LOG%"
