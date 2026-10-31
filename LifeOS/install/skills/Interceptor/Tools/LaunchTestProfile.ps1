# LaunchTestProfile.ps1 - native-Windows (no bash) version of LaunchTestProfile.sh.
# Opens Chrome's dedicated, non-default test profile in its own window via
# --profile-directory. Refuses to guess a profile: INTERCEPTOR_TEST_CHROME_PROFILE must be
# set in preferences.env. Exit codes: 0 launched; 1 no chrome.exe found; 2 profile unset.
#
# Usage: powershell.exe -NoProfile -ExecutionPolicy Bypass -File Tools\LaunchTestProfile.ps1 [url]

param([string]$Url = 'about:blank')

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Interceptor.Common.ps1')

$r = Start-InterceptorTestProfile -StartUrl $Url
if ($r.Message) { [Console]::Error.WriteLine($r.Message) }
exit $r.Code
