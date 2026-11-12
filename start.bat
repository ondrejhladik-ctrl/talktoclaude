@echo off
cd /d "%~dp0"
rem Doinstaluje chybejici knihovny (po aktualizaci aplikace); kdyz je vse na miste, trva to vterinu.
call npm install --no-audit --no-fund --loglevel=error
node server.js
pause
