@echo off
rem Kelly Page launcher: starts the IP bridge on the radio's COM port and opens Kelly in the browser.
rem   start-kelly.bat            -> COM5 @ 19200
rem   start-kelly.bat COM7       -> another port
rem Close this window (or Ctrl+C) to stop the bridge and free the COM port.
setlocal
set PORT=%1
if "%PORT%"=="" set PORT=COM5
cd /d "%~dp0"

rem Python: the project's own venv when run from the repo, else the Python launcher, else python.
set PY=
if exist "%~dp0..\.venv\Scripts\python.exe" set PY="%~dp0..\.venv\Scripts\python.exe"
if not defined PY ( py -3 --version >nul 2>&1 && set PY=py -3 )
if not defined PY ( python --version >nul 2>&1 && set PY=python )
if not defined PY (
  echo Python 3 is not installed. Get it from https://www.python.org/downloads/ ^(tick "Add python.exe to PATH"^),
  echo or skip the bridge: open index.html in Chrome or Edge and connect by Serial.
  pause
  exit /b 1
)

rem The bridge needs pyserial for the COM port -- install it once if it's missing.
%PY% -c "import serial" >nul 2>&1
if errorlevel 1 (
  echo Installing pyserial ^(first run only^)...
  %PY% -m pip install --user --quiet pyserial
)

start "" /min cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:8025/?connect=ip"
%PY% "%~dp0bridge\kelly_bridge.py" --serial %PORT%
pause
