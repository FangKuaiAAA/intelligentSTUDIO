@echo off
rem Silent launcher: starts the main process without an interactive window.
rem Used by startup-at-login (registry Run key) and by the Settings app.
call "%~dp0start.bat" --silent
exit /b 0
