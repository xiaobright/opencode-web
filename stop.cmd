@echo off
rem Stops the tray icon and the local web UI. The opencode background service keeps running, so the
rem TUI and other clients are unaffected. Pass --service to stop that too.
setlocal enabledelayedexpansion
cd /d "%~dp0"

for %%F in (".tray.pid" ".opencode-web.pid") do (
  if exist "%%~F" (
    set "CHILD_PID="
    set /p CHILD_PID=<"%%~F"
    if defined CHILD_PID (
      taskkill /F /PID !CHILD_PID! >nul 2>&1
      if errorlevel 1 (echo not running: pid !CHILD_PID!) else (echo stopped: pid !CHILD_PID!)
    )
    del "%%~F" >nul 2>&1
  )
)

if /i "%~1"=="--service" (
  echo stopping the opencode background service
  opencode service stop
)

echo done
