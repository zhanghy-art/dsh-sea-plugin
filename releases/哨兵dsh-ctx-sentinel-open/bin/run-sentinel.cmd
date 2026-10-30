@echo off
rem ---------------------------------------------------------------
rem  Context Sentinel launcher (called hidden by boot-sentinel.ps1,
rem  can also be run by hand).
rem    usage: run-sentinel.cmd <node.exe> <ctx-sentinel.js> <out-log>
rem  Keeps the sentinel alive in a hidden window; stdout/stderr go to
rem  the output log (its own log is ctx-sentinel.log).
rem  NOTE: keep this file pure ASCII - cmd.exe reads .cmd in the OEM
rem  code page and non-ASCII bytes break the script.
rem ---------------------------------------------------------------
if "%~1"=="" (
  echo usage: run-sentinel.cmd ^<node.exe^> ^<ctx-sentinel.js^> ^<out-log^>
  exit /b 2
)
"%~1" "%~2" >> "%~3" 2>&1