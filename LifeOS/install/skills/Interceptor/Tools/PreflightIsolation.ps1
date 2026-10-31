# PreflightIsolation.ps1 - native-Windows (no bash) version of PreflightIsolation.sh.
# Hard gate before any browser command lands in Chrome: same four checks, same exit codes
# (0 cleared; 2 binary missing; 3 version-parse fail; 4 version too low; 5 no contexts
# connected; 6 pinned context not connected or pinned Extension stale; 7 target is a
# Default/working profile; 8 test context unset; 9 no Extension at all). All logic lives in
# Interceptor.Common.ps1.
#
# Usage: powershell.exe -NoProfile -ExecutionPolicy Bypass -File Tools\PreflightIsolation.ps1

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Interceptor.Common.ps1')

$r = Invoke-InterceptorPreflight
if ($r.Stderr) { [Console]::Error.WriteLine($r.Stderr) }
if ($r.Stdout) { [Console]::Out.WriteLine($r.Stdout) }
exit $r.Code
