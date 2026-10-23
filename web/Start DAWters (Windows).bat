@echo off
cd /d "%~dp0"
where py >nul 2>nul && (py -3 serve.py & goto :eof)
where python >nul 2>nul && (python serve.py & goto :eof)
echo Python not found - opening the studio directly in your browser.
start "" index.html
