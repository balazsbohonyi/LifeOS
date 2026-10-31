# Interceptor.Common.ps1 - shared logic for the native-Windows (PowerShell) versions of the
# Interceptor test-profile tools. Dot-sourced by PreflightIsolation.ps1, LaunchTestProfile.ps1
# and EnsureTestProfile.ps1. It mirrors PreflightIsolation.sh, LaunchTestProfile.sh and
# EnsureTestProfile.sh (same checks, same exit codes); keep the two sets in step.
#
# For machines with no bash (no Git for Windows, no WSL). Windows PowerShell 5.1+ compatible.
# Keep this file ASCII-only: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI.
#
# preferences.env is READ, never executed: only simple NAME=value lines are understood
# (optional "export", optional single/double quotes, $HOME / ~ expansion). Anything fancier
# in that file is a bash-only feature and is ignored here.

Set-StrictMode -Version 2.0

$script:ToolsDir       = $PSScriptRoot
$script:SkillDir       = Split-Path -Parent $script:ToolsDir
$script:ConfigRoot     = Split-Path -Parent (Split-Path -Parent $script:SkillDir)
$script:UserPrefsPath  = Join-Path $script:ConfigRoot 'LIFEOS\USER\CUSTOMIZATIONS\SKILLS\Interceptor\preferences.env'
$script:MinVersion     = [version]'0.16.9'
$script:Arrow          = [string][char]0x2192

function Format-HomeRelative {
    param([string]$Path)
    if ($Path -and $HOME -and $Path.StartsWith($HOME, [System.StringComparison]::OrdinalIgnoreCase)) {
        return '~' + $Path.Substring($HOME.Length)
    }
    return $Path
}

function Read-InterceptorPrefs {
    param([string]$Path)
    $map = @{}
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $map }
    foreach ($line in [System.IO.File]::ReadAllLines($Path)) {
        if ($line -match '^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$') {
            $name = $Matches[1]
            $raw  = $Matches[2].Trim()
            if     ($raw -match '^"([^"]*)"')  { $val = $Matches[1] }
            elseif ($raw -match "^'([^']*)'")  { $val = $Matches[1] }
            else                               { $val = ($raw -replace '\s+#.*$', '').Trim() }
            $val = $val.Replace('${HOME}', $HOME).Replace('$HOME', $HOME)
            if ($val -eq '~' -or $val.StartsWith('~/') -or $val.StartsWith('~\')) { $val = $HOME + $val.Substring(1) }
            $map[$name] = $val
        }
    }
    return $map
}

# A value in preferences.env wins over the process environment, like sourcing the file in bash.
function Get-InterceptorSetting {
    param($Prefs, [string]$Name)
    if ($Prefs.ContainsKey($Name)) { return [string]$Prefs[$Name] }
    $v = [System.Environment]::GetEnvironmentVariable($Name)
    if ($null -eq $v) { return '' }
    return $v
}

# Run a native program with no console window, capturing stdout+stderr as text.
function Invoke-Native {
    param([string]$Exe, [string[]]$Arguments = @())
    $quoted = @()
    foreach ($a in $Arguments) {
        if ($a -match '[\s"]') { $quoted += ('"' + ($a -replace '"', '\"') + '"') } else { $quoted += $a }
    }
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName               = $Exe
    $psi.Arguments              = ($quoted -join ' ')
    $psi.UseShellExecute        = $false
    $psi.CreateNoWindow         = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError  = $true
    $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $psi.StandardErrorEncoding  = [System.Text.Encoding]::UTF8
    $p = [System.Diagnostics.Process]::Start($psi)
    $outTask = $p.StandardOutput.ReadToEndAsync()
    $errTask = $p.StandardError.ReadToEndAsync()
    $p.WaitForExit()
    return [pscustomobject]@{ ExitCode = $p.ExitCode; Output = ($outTask.Result + $errTask.Result) }
}

function ConvertTo-VersionOrNull {
    param([string]$Text)
    if ($Text -match '^(\d+(?:\.\d+){0,3})') {
        $v = $Matches[1]
        if ($v -notmatch '\.') { $v = $v + '.0' }
        try { return [version]$v } catch { return $null }
    }
    return $null
}

function New-PreflightResult {
    param([int]$Code, $Err, $Out)
    return [pscustomobject]@{ Code = $Code; Stderr = ($Err -join "`n"); Stdout = ($Out -join "`n") }
}

# The isolation gate. Returns { Code; Stderr; Stdout } and prints nothing itself.
# Exit codes: 0 cleared; 2 binary missing; 3 version-parse fail; 4 version too low;
# 5 no contexts connected; 6 pinned context not connected OR pinned Extension stale;
# 7 target is a Default/working profile; 8 test context unset; 9 no Extension at all.
function Invoke-InterceptorPreflight {
    $err = New-Object System.Collections.Generic.List[string]
    $out = New-Object System.Collections.Generic.List[string]

    $prefs     = Read-InterceptorPrefs $script:UserPrefsPath
    $userPrefs = $script:UserPrefsPath
    $extPin    = Join-Path $script:SkillDir 'Extension'
    $required  = Get-InterceptorSetting $prefs 'INTERCEPTOR_TEST_CONTEXT_ID'

    if (-not $required) {
        $err.Add(@"
[PreflightIsolation] FAIL: INTERCEPTOR_TEST_CONTEXT_ID is not set.

REMEDIATION:
  Set INTERCEPTOR_TEST_CONTEXT_ID in
    $userPrefs
  to the pinned Interceptor test context (raw UUID today; durable fix is the
  friendly name "interceptor-test" set once in the extension popup). There is
  no default - running without an explicit pinned context could route a tab to
  the operator's working profile.
"@)
        return New-PreflightResult 8 $err $out
    }

    $working = Get-InterceptorSetting $prefs 'INTERCEPTOR_WORKING_PROFILE_IDS'

    # --- 1. Binary present + version >= MinVersion ---
    $cmd = Get-Command interceptor -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $cmd) {
        $err.Add(@"
[PreflightIsolation] FAIL: interceptor not found on PATH.

REMEDIATION:
  Install Interceptor (see Workflows/Update.md), then verify with:
    interceptor --version
"@)
        return New-PreflightResult 2 $err $out
    }
    $exe = $cmd.Source

    $ver = Invoke-Native $exe @('--version')
    $rawVersion = ($ver.Output -split "\r?\n" | Select-Object -First 1)
    if ($null -eq $rawVersion) { $rawVersion = '' }
    $tokens = @($rawVersion.Trim() -split '\s+')
    $currentText = ''
    if ($tokens.Count -ge 2) { $currentText = $tokens[1] }
    $current = ConvertTo-VersionOrNull $currentText
    if (-not $currentText -or $null -eq $current) {
        $err.Add(@"
[PreflightIsolation] FAIL: could not parse interceptor version.
  raw output: $rawVersion

REMEDIATION:
  Run `interceptor --version` manually and confirm output shape
  matches "interceptor X.Y.Z (sha, date)". If not, reinstall per Workflows/Update.md.
"@)
        return New-PreflightResult 3 $err $out
    }
    if ($current -lt $script:MinVersion) {
        $err.Add(@"
[PreflightIsolation] FAIL: interceptor $currentText is below required $($script:MinVersion).

WHY THIS MATTERS:
  Builds before $($script:MinVersion) silently ignore the --context flag. The daemon
  then falls back to whatever Chrome connection it can find - which is
  usually the operator's Default profile. A tab opens in the wrong window.

REMEDIATION:
  Upgrade via Workflows/Update.md, then:
    interceptor --version          # confirm >= $($script:MinVersion)
"@)
        return New-PreflightResult 4 $err $out
    }

    # --- 2. Pinned test context is connected (exact whole-field match) ---
    $ctx = Invoke-Native $exe @('contexts')
    $contextsOutput = $ctx.Output
    if ($contextsOutput -match '(?i)no browser contexts connected') {
        $err.Add(@"
[PreflightIsolation] FAIL: no browser contexts connected.

WHY THIS MATTERS:
  The Interceptor extension is not currently loaded in any Chrome profile, or
  the daemon was restarted after Chrome (so the extension hasn't re-handshaked).
  Without a connection, browser commands fail or hang.

REMEDIATION (operator action - no auto-launch):
  1. Open the dedicated Interceptor test profile window.
  2. In that profile, open chrome://extensions/. If the Interceptor card is
     missing or shows an error, install the extension (Chrome Web Store, or
     Load Unpacked from the installer's extension folder) and accept any new
     permissions.
  3. Click the Interceptor toolbar icon, set Context ID to the friendly name
     "interceptor-test", Save. Friendly names survive extension reloads; raw
     UUIDs rot on every reload (see preferences.env header).
  4. Set INTERCEPTOR_TEST_CONTEXT_ID in preferences.env to match, then re-run.
"@)
        return New-PreflightResult 5 $err $out
    }

    $headerMarker = $script:Arrow + ' contexts'
    $found = $false
    foreach ($line in ($contextsOutput -split "\r?\n")) {
        if ($line.Contains($headerMarker)) { continue }
        if ($line.Trim() -ceq $required) { $found = $true; break }
    }
    if (-not $found) {
        $current_ctx = (($contextsOutput -split "\r?\n") | ForEach-Object { '  ' + $_ }) -join "`n"
        $err.Add(@"
[PreflightIsolation] FAIL: required context "$required" is not connected.

CURRENT CONTEXTS:
$current_ctx

WHY THIS MATTERS:
  The whole point of the pinned test context is to give browser commands a known
  target that is NEVER the operator's working window. Without it connected, a
  command could land in the wrong profile or fail ambiguously. There is no
  fallback - this is a hard stop.

LIKELY CAUSE: UUID rotation. When Chrome's Interceptor extension reloads
(manifest version bump, "Load Unpacked" again, fresh profile), the auto-assigned
UUID changes and preferences.env still holds the OLD one. The live context in
CURRENT CONTEXTS above is the NEW one.

REMEDIATION (UUID rot - most common):
  1. Compare the UUID(s) above against INTERCEPTOR_TEST_CONTEXT_ID in
       $userPrefs
  2. If the live UUID is the same test profile under a new value, copy it into
     preferences.env and re-run this preflight.

DURABLE FIX (end UUID rot):
  Set the friendly name "interceptor-test" in the extension popup once and pin
  that string in preferences.env. Friendly names survive reloads; raw UUIDs do not.
"@)
        return New-PreflightResult 6 $err $out
    }

    # --- 3. Target-deny: pinned target must NOT be Default or a working profile ---
    $denyHit = ''
    if ($required -match '(?i)(^|[^a-z])default([^a-z]|$)') { $denyHit = 'name matches Default' }
    if (-not $denyHit -and $working) {
        # Whole value plus comma-split plus any-whitespace-split: a superset of the
        # comma-only parse, so this can only add a refusal (same as the bash gate).
        $raw = $working.Trim()
        $cands = @($raw) + @($raw -split ',') + @($raw -split '[,\s]+')
        foreach ($c in $cands) {
            $t = $c.Trim()
            if ($t -and ($t -ceq $required)) { $denyHit = "matches working-profile deny-list entry ($t)"; break }
        }
    }
    if ($denyHit) {
        $err.Add(@"
[PreflightIsolation] FAIL: pinned target "$required" is a denied profile ($denyHit).

WHY THIS MATTERS:
  The pinned test context must never be the operator's Default or any
  working/monitoring profile. This is the isolation contract - a denied target
  is a hard stop, never a "proceed anyway."

REMEDIATION:
  Repin INTERCEPTOR_TEST_CONTEXT_ID in preferences.env to the dedicated
  Interceptor test context, and confirm INTERCEPTOR_WORKING_PROFILE_IDS lists
  every Default/working-profile context ID to keep them denied.
"@)
        return New-PreflightResult 7 $err $out
    }

    # --- 4. Extension present, then fresh (graceful if no upstream reference) ---
    $extCandidates = @((Get-InterceptorSetting $prefs 'INTERCEPTOR_EXT_DIR'), $extPin)
    if ($env:LOCALAPPDATA) { $extCandidates += (Join-Path $env:LOCALAPPDATA 'Programs\Interceptor\extension') }
    $extDir = ''
    foreach ($c in $extCandidates) {
        if ($c -and (Test-Path -LiteralPath (Join-Path $c 'manifest.json') -PathType Leaf)) { $extDir = $c; break }
    }
    if (-not $extDir) { $extDir = $extPin }
    $pinnedFrom = Join-Path $extDir 'PINNED_FROM.txt'

    $src = Get-InterceptorSetting $prefs 'INTERCEPTOR_SRC'
    if ($src) { $upstreamDist = Join-Path $src 'extension\dist' }
    else      { $upstreamDist = Join-Path $HOME 'Projects\interceptor\extension\dist' }
    $upstreamManifest = Join-Path $upstreamDist 'manifest.json'

    if (-not (Test-Path -LiteralPath (Join-Path $extDir 'manifest.json') -PathType Leaf)) {
        $extDisp = Format-HomeRelative $extDir
        $err.Add(@"
[PreflightIsolation] FAIL: no Extension found. Checked INTERCEPTOR_EXT_DIR, the pin
at $extDisp, and the Windows installer path
%LOCALAPPDATA%\Programs\Interceptor\extension

WHY THIS MATTERS:
  Browser control needs the Interceptor extension on disk. The Windows installer
  creates it under %LOCALAPPDATA%\Programs\Interceptor\extension; a from-source pin
  (Tools/Pin.sh, bash only) is the alternative. Chrome may still be running a copy
  from memory right now; an unpacked copy does not survive a restart.

REMEDIATION:
  1. Install Interceptor with its Windows installer, or set INTERCEPTOR_EXT_DIR in
     preferences.env to a folder that contains the extension's manifest.json.
  2. In the test profile: chrome://extensions/ -> Load Unpacked from that folder
     (or install the extension from the Chrome Web Store).
  3. Re-run this preflight.
"@)
        return New-PreflightResult 9 $err $out
    }

    # Prefer the origin the pin was taken from (recorded in PINNED_FROM.txt) when
    # INTERCEPTOR_SRC is unset (public issue #1824).
    if (-not $src -and (Test-Path -LiteralPath $pinnedFrom -PathType Leaf)) {
        $origin = ''
        foreach ($l in [System.IO.File]::ReadAllLines($pinnedFrom)) {
            if ($l -match '(?i)^Pinned from:\s*(.*)$') { $origin = $Matches[1].Trim(); break }
        }
        if ($origin -eq '~' -or $origin.StartsWith('~/') -or $origin.StartsWith('~\')) { $origin = $HOME + $origin.Substring(1) }
        if ($origin -and (Test-Path -LiteralPath (Join-Path $origin 'manifest.json') -PathType Leaf)) {
            $upstreamDist     = $origin
            $upstreamManifest = Join-Path $origin 'manifest.json'
        }
    }

    if ((Test-Path -LiteralPath $pinnedFrom -PathType Leaf) -and (Test-Path -LiteralPath $upstreamManifest -PathType Leaf)) {
        $pinnedText = ''
        foreach ($l in [System.IO.File]::ReadAllLines($pinnedFrom)) {
            if ($l -match '(?i)^Manifest version:\s*(.*)$') { $pinnedText = $Matches[1].Trim(); break }
        }
        $upstreamText = ''
        try { $upstreamText = [string](Get-Content -Raw -LiteralPath $upstreamManifest | ConvertFrom-Json).version } catch { $upstreamText = '' }
        $pinnedV   = ConvertTo-VersionOrNull $pinnedText
        $upstreamV = ConvertTo-VersionOrNull $upstreamText
        # "Stale" means upstream is NEWER than the pin (not merely different).
        if ($null -ne $pinnedV -and $null -ne $upstreamV -and $upstreamV -gt $pinnedV) {
            $err.Add(@"
[PreflightIsolation] FAIL: pinned Extension (manifest $pinnedText) is stale vs upstream ($upstreamText).

WHY THIS MATTERS:
  Chrome disables unpacked extensions on every manifest bump, and a stale loaded
  extension whose bundled screenshot-runner.js doesn't match the daemon produces
  "screenshot-runner.js could not load" failures.

REMEDIATION:
  1. Re-pin via the Update workflow (Tools/Pin.sh, bash only) or update the
     installed extension folder.
  2. In the test profile: chrome://extensions/ -> Interceptor -> Load Unpacked
     from $extPin (or reload if already loaded).
  3. Re-run this preflight.
"@)
            return New-PreflightResult 6 $err $out
        }
    }
    else {
        $upDisp = Format-HomeRelative $upstreamDist
        $err.Add("[PreflightIsolation] WARN: cannot verify extension freshness (upstream dist $upDisp absent or PINNED_FROM.txt missing). Proceeding.")
    }

    $out.Add("[PreflightIsolation] OK - interceptor $currentText, pinned context `"$required`" connected and not denied.")
    return New-PreflightResult 0 $err $out
}

# Open the configured test profile in its own Chrome window. Returns { Code; Message }:
# 0 launched; 1 no chrome.exe found; 2 INTERCEPTOR_TEST_CHROME_PROFILE unset.
function Start-InterceptorTestProfile {
    param([string]$StartUrl = 'about:blank')
    $prefs   = Read-InterceptorPrefs $script:UserPrefsPath
    $profile = Get-InterceptorSetting $prefs 'INTERCEPTOR_TEST_CHROME_PROFILE'

    # NO default profile: guessing one could open the operator's working profile.
    if (-not $profile) {
        return [pscustomobject]@{ Code = 2; Message = @"
LaunchTestProfile: FAIL - no test profile configured.

  INTERCEPTOR_TEST_CHROME_PROFILE is unset/empty. Set it in
    $($script:UserPrefsPath)
  to the dedicated Interceptor test profile's on-disk directory name (e.g.
  "Profile N" - map directory -> friendly name via
  %LOCALAPPDATA%\Google\Chrome\User Data\Local State, profile.info_cache).

  Refusing to launch: defaulting to any concrete profile could open the
  operator's working/monitoring profile by accident.
"@ }
    }
    if ($profile.Contains('"')) {
        return [pscustomobject]@{ Code = 2; Message = 'LaunchTestProfile: FAIL - INTERCEPTOR_TEST_CHROME_PROFILE must not contain a double quote.' }
    }

    $chrome = Get-InterceptorSetting $prefs 'INTERCEPTOR_TEST_BROWSER_BIN'
    if (-not $chrome) {
        $roots = @($env:ProgramFiles, [System.Environment]::GetEnvironmentVariable('ProgramFiles(x86)'), $env:LOCALAPPDATA)
        foreach ($r in $roots) {
            if (-not $r) { continue }
            $cand = Join-Path $r 'Google\Chrome\Application\chrome.exe'
            if (Test-Path -LiteralPath $cand -PathType Leaf) { $chrome = $cand; break }
        }
    }
    if (-not $chrome -or -not (Test-Path -LiteralPath $chrome -PathType Leaf)) {
        return [pscustomobject]@{ Code = 1; Message = "LaunchTestProfile: no chrome.exe found. Set INTERCEPTOR_TEST_BROWSER_BIN in $($script:UserPrefsPath)" }
    }

    # Invoke the binary directly: Chrome's process singleton forwards --profile-directory
    # to a running instance, so the profile window opens whether or not Chrome was up.
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName        = $chrome
    $psi.Arguments       = '--profile-directory="' + $profile + '" --new-window "' + $StartUrl + '"'
    $psi.UseShellExecute = $false
    [void][System.Diagnostics.Process]::Start($psi)
    return [pscustomobject]@{ Code = 0; Message = '' }
}
