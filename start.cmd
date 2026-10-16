@echo off
rem Headless: just the local web UI (and the opencode service it needs), with a console for logs.
cd /d "%~dp0"
bun run start
