@echo off
cd /d "%~dp0"
"C:\Users\fangjiahe\.nuget\packages\microsoft.windowsappsdk\1.6.250205002\tools\net472\XamlCompiler.exe" "obj\Debug\net8.0-windows10.0.19041.0\win-x64\input.json" "obj\Debug\net8.0-windows10.0.19041.0\win-x64\output.json" > _xc.log 2>&1
echo EXIT=%ERRORLEVEL%>> _xc.log
