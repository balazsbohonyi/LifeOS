# EnsureTestProfile.ps1 - native-Windows (no bash) version of EnsureTestProfile.sh.
# Makes the Interceptor test context available, auto-launching the CONFIGURED test profile
# window if it isn't connected. Auto-recovery for preflight exits 5 / 6 ONLY.
#
# Safety invariant (same as the bash version): this script only ever succeeds after the
# isolation gate itself exits 0, so launching the wrong window can never cause the agent to
# drive it. Exit 7 (target is Default/working) and 8 (context unset) NEVER trigger a launch.
#
# Contract: prints "READY" to stdout and exits 0 when the pinned test context is connected
# and safe. Otherwise surfaces the gate's remediation to stderr and exits with the gate's code.
#
# Usage: powershell.exe -NoProfile -ExecutionPolicy Bypass -File Tools\EnsureTestProfile.ps1

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Interceptor.Common.ps1')

function Write-Err { param([string]$Text) [Console]::Error.WriteLine($Text) }
function Join-Result { param($R) return (@($R.Stderr, $R.Stdout) | Where-Object { $_ }) -join "`n" }

$r = Invoke-InterceptorPreflight
if ($r.Code -eq 0) {
    Write-Err (Join-Result $r)
    [Console]::Out.WriteLine('READY')
    exit 0
}

# Only "context not connected" conditions are auto-launchable (5 = no contexts, 6 = pinned
# context not connected). Everything else (7, 8, 2/3/4, 9) surfaces and stops.
if ($r.Code -ne 5 -and $r.Code -ne 6) {
    Write-Err "[EnsureTestProfile] preflight exit $($r.Code) is not a launchable condition - surfacing, not launching."
    Write-Err (Join-Result $r)
    exit $r.Code
}

$prefs   = Read-InterceptorPrefs $script:UserPrefsPath
$profile = Get-InterceptorSetting $prefs 'INTERCEPTOR_TEST_CHROME_PROFILE'
if (-not $profile) {
    Write-Err "[EnsureTestProfile] test context not connected (exit $($r.Code)) AND INTERCEPTOR_TEST_CHROME_PROFILE is unset -"
    Write-Err "  cannot auto-launch. Set it in $($script:UserPrefsPath) to the test profile's on-disk dir (e.g. `"Profile 4`")."
    Write-Err (Join-Result $r)
    exit $r.Code
}

Write-Err "[EnsureTestProfile] test context not connected (exit $($r.Code)) - launching test profile `"$profile`" and waiting for it to connect..."
$launch = Start-InterceptorTestProfile -StartUrl 'about:blank'
if ($launch.Code -ne 0) {
    Write-Err "[EnsureTestProfile] LaunchTestProfile failed to launch `"$profile`" - surfacing."
    if ($launch.Message) { Write-Err $launch.Message }
    exit $r.Code
}

# Poll for the PINNED test context to connect. A closed-but-not-reloaded profile keeps its
# stable chrome.storage.local UUID, so it reconnects as the same context and the gate passes.
for ($i = 1; $i -le 18; $i++) {
    Start-Sleep -Seconds 1
    $r = Invoke-InterceptorPreflight
    if ($r.Code -eq 0) {
        Write-Err (Join-Result $r)
        [Console]::Out.WriteLine("READY (auto-launched after ${i}s)")
        exit 0
    }
}

# Launched, but the pinned context never connected. Almost always UUID rot. Do NOT proceed.
Write-Err (Join-Result $r)
Write-Err "[EnsureTestProfile] launched `"$profile`" but the pinned test context did not connect within 18s."
Write-Err '  Most likely UUID rot: the Interceptor extension reloaded and the test profile now has a NEW context UUID.'
Write-Err '  Durable fix (do this once, it survives future reloads):'
Write-Err '    1. In the test-profile window, click the Interceptor toolbar icon.'
Write-Err '    2. Set Context ID = "interceptor-test" -> Save.'
Write-Err "    3. Set INTERCEPTOR_TEST_CONTEXT_ID=`"interceptor-test`" in $($script:UserPrefsPath)."
Write-Err "  Not proceeding - never drive an unverified context (it could be the operator's window)."
exit 6
