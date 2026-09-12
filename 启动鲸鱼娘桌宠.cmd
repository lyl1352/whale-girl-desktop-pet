@echo off
rem Launch the whale-girl desktop pet (transparent, always-on-top floating window).
rem ASCII-only on purpose: cmd.exe parses this file as ANSI.
setlocal
start "" "C:\Users\PC\whale-pet-desktop\electron\electron.exe" "C:\Users\PC\whale-pet-desktop"
exit /b 0
