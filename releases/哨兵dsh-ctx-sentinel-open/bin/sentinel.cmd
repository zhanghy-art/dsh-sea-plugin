@echo off
rem ---------------------------------------------------------------
rem  Context Sentinel helper - run the sentinel with any arguments:
rem    sentinel.cmd --status
rem    sentinel.cmd --once
rem    sentinel.cmd --once --export-now
rem    sentinel.cmd --help
rem  Node is taken from %USERPROFILE%\.dsh\sentinel-node.txt (written
rem  at install time), then from the DSH runtime folder.
rem  NOTE: keep this file pure ASCII (cmd.exe reads .cmd in the OEM
rem  code page and non-ASCII bytes break the script).
rem ---------------------------------------------------------------
setlocal
set "ROOT=%USERPROFILE%\.dsh\plugins\dsh-ctx-sentinel"
set "NODE="

if exist "%USERPROFILE%\.dsh\sentinel-node.txt" (
  for /f "usebackq delims=" %%i in ("%USERPROFILE%\.dsh\sentinel-node.txt") do (
    if not defined NODE if exist "%%i" set "NODE=%%i"
  )
)

if not defined NODE (
  for /d %%d in ("%USERPROFILE%\.dsh\dsh-runtimes\*") do (
    if not defined NODE if exist "%%d\dependencies\node\bin\node.exe" set "NODE=%%d\dependencies\node\bin\node.exe"
  )
)

if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"

if not defined NODE (
  echo Cannot find a usable node.exe. Set DSH_CTX_SENTINEL_NODE or write its path into %%USERPROFILE%%\.dsh\sentinel-node.txt
  exit /b 2
)

"%NODE%" "%ROOT%\sentinel\ctx-sentinel.js" %*
exit /b %ERRORLEVEL%