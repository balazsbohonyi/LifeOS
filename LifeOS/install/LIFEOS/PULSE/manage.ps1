# LifeOS Pulse — native Windows per-user lifecycle manager.
# Usage: powershell -ExecutionPolicy Bypass -File manage.ps1 <command> [-Json] [-Handoff]

param(
    [ValidateSet("install", "start", "stop", "restart", "status", "repair", "uninstall")]
    [string]$Command = "status",
    [switch]$Json,
    [switch]$Handoff,
    [string]$ConfigRoot,
    [string]$ConfigPath,
    [string]$BunPath,
    [string]$TaskName = "Pulse",
    [string]$TaskPath = "\LifeOS\",
    [string]$NotificationShortcut,
    [string]$HealthUrl = "http://127.0.0.1:31337/healthz",
    [int]$StartupTimeoutSeconds = 20,
    [int]$RestartDelaySeconds = 60
)

$ErrorActionPreference = "Stop"
$pulseDir = $PSScriptRoot
$lifeosDir = Split-Path -Parent $pulseDir
if (-not $ConfigRoot) { $ConfigRoot = Split-Path -Parent $lifeosDir }
if (-not $ConfigPath) {
    $ConfigPath = if ($env:LIFEOS_CONFIG_PATH) { $env:LIFEOS_CONFIG_PATH } else { Join-Path $lifeosDir "USER\CONFIG\LIFEOS_CONFIG.toml" }
}
$startScript = Join-Path $pulseDir "PulseStart.ps1"
$pulseScript = Join-Path $pulseDir "pulse.ts"
$toastInstaller = Join-Path $pulseDir "InstallToastShortcut.ps1"
$toastScript = Join-Path $pulseDir "WindowsToast.ps1"
$lockPath = Join-Path $pulseDir "state\pulse.lock.json"
$shortcutPath = if ($NotificationShortcut) { $NotificationShortcut } else { Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\LifeOS Pulse.lnk" }
$legacyTaskName = "LifeOS Pulse"
$legacyTaskPath = "\"

function Resolve-CanonicalPath {
    param([string]$Path)
    if (-not $Path) { return $null }
    try { return (Resolve-Path -LiteralPath $Path).Path.TrimEnd("\") } catch { return [IO.Path]::GetFullPath($Path).TrimEnd("\") }
}

$ConfigRoot = Resolve-CanonicalPath $ConfigRoot
$ConfigPath = Resolve-CanonicalPath $ConfigPath
$pulseDir = Resolve-CanonicalPath $pulseDir
$lifeosDir = Resolve-CanonicalPath $lifeosDir
$startScript = Resolve-CanonicalPath $startScript
$pulseScript = Resolve-CanonicalPath $pulseScript

function Test-PathEqual {
    param([string]$Left, [string]$Right)
    if (-not $Left -or -not $Right) { return $false }
    return [string]::Equals((Resolve-CanonicalPath $Left), (Resolve-CanonicalPath $Right), [StringComparison]::OrdinalIgnoreCase)
}

function Resolve-BunPath {
    param([string]$Requested)
    $candidates = @(
        $Requested,
        $env:LIFEOS_BUN_PATH,
        (Join-Path $env:USERPROFILE ".bun\bin\bun.exe"),
        (Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links\bun.exe"),
        (Join-Path $env:LOCALAPPDATA "bun\bin\bun.exe")
    )
    try { $candidates += (Get-Command bun.exe -ErrorAction Stop).Source } catch { }
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { return (Resolve-Path -LiteralPath $candidate).Path }
    }
    return $null
}

function Get-NamedArgument {
    param([string]$Arguments, [string]$Name)
    if (-not $Arguments) { return $null }
    $escapedName = [Regex]::Escape($Name)
    $pattern = "(?i)(?:^|\s)-$escapedName(?:\s+|:)(?:`"([^`"]*)`"|'([^']*)'|(\S+))"
    $match = [Regex]::Match($Arguments, $pattern)
    if (-not $match.Success) { return $null }
    foreach ($index in 1..3) { if ($match.Groups[$index].Success) { return $match.Groups[$index].Value } }
    return $null
}

function Get-PulseTask {
    param([string]$Name = $TaskName, [string]$Path = $TaskPath)
    Get-ScheduledTask -TaskName $Name -TaskPath $Path -ErrorAction SilentlyContinue
}

function Test-TaskOwnership {
    param($Task)
    if (-not $Task) { return $false }
    foreach ($action in @($Task.Actions)) {
        $fileArgument = Get-NamedArgument $action.Arguments "File"
        if ((Test-PathEqual $action.WorkingDirectory $pulseDir) -and (Test-PathEqual $fileArgument $startScript)) { return $true }
    }
    return $false
}

function Get-TaskPulseRoot {
    param($Task)
    if (-not $Task) { return $null }
    foreach ($action in @($Task.Actions)) {
        $fileArgument = Get-NamedArgument $action.Arguments "File"
        if ($fileArgument) {
            $candidatePulse = Split-Path -Parent (Resolve-CanonicalPath $fileArgument)
            return Resolve-CanonicalPath (Split-Path -Parent $candidatePulse)
        }
    }
    return $null
}

function Test-TaskConfiguration {
    param($Task, [string]$ResolvedBun)
    if (-not (Test-TaskOwnership $Task)) { return $false }
    foreach ($action in @($Task.Actions)) {
        if (-not (Test-PathEqual (Get-NamedArgument $action.Arguments "File") $startScript)) { continue }
        return (Test-PathEqual (Get-NamedArgument $action.Arguments "ConfigRoot") $ConfigRoot) -and
            (Test-PathEqual (Get-NamedArgument $action.Arguments "ConfigPath") $ConfigPath) -and
            ((-not $ResolvedBun) -or (Test-PathEqual (Get-NamedArgument $action.Arguments "BunPath") $ResolvedBun))
    }
    return $false
}

function Get-PulseHealthResponse {
    try {
        $response = Invoke-WebRequest -Uri $HealthUrl -TimeoutSec 2 -UseBasicParsing
        return [pscustomobject]@{ StatusCode = [int]$response.StatusCode; Body = ($response.Content | ConvertFrom-Json) }
    } catch {
        try {
            $response = $_.Exception.Response
            if (-not $response) { return $null }
            $content = [string]$_.ErrorDetails.Message
            if (-not $content) {
                $reader = New-Object IO.StreamReader($response.GetResponseStream())
                $content = $reader.ReadToEnd()
            }
            return [pscustomobject]@{ StatusCode = [int]$response.StatusCode; Body = ($content | ConvertFrom-Json) }
        } catch { return $null }
    }
}

function Get-PulseLock {
    if (-not (Test-Path -LiteralPath $lockPath)) { return $null }
    try { return (Get-Content -Raw -LiteralPath $lockPath | ConvertFrom-Json) } catch { return $null }
}

function ConvertTo-ProcessCreationTime {
    param($Value)
    if ($Value -is [DateTimeOffset]) { return $Value.UtcDateTime }
    if ($Value -is [DateTime]) {
        # Windows PowerShell ConvertFrom-Json turns ISO-8601 UTC strings ending
        # in Z into DateTime values with Kind=Unspecified. Preserve those clock
        # fields as UTC instead of interpreting them in the machine's timezone.
        if ($Value.Kind -eq [DateTimeKind]::Unspecified) {
            return [DateTime]::SpecifyKind($Value, [DateTimeKind]::Utc)
        }
        return $Value.ToUniversalTime()
    }
    try {
        return ([DateTimeOffset]::Parse([string]$Value, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)).UtcDateTime
    } catch {
        try { return [Management.ManagementDateTimeConverter]::ToDateTime([string]$Value).ToUniversalTime() } catch { return $null }
    }
}

function Test-ProcessIdentity {
    param($Lock, [switch]$AllowStoppedLauncher)
    if (-not $Lock -or -not $Lock.pid -or -not $Lock.executablePath -or -not $Lock.scriptPath -or -not $Lock.processStartedAt) { return $false }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$Lock.pid)" -ErrorAction SilentlyContinue
    if (-not $process) { return $false }
    if (-not (Test-PathEqual $process.ExecutablePath $Lock.executablePath)) { return $false }
    if (([string]$process.CommandLine).IndexOf([string]$Lock.scriptPath, [StringComparison]::OrdinalIgnoreCase) -lt 0) { return $false }
    $actualStart = ConvertTo-ProcessCreationTime $process.CreationDate
    $claimedStart = ConvertTo-ProcessCreationTime $Lock.processStartedAt
    if (-not $actualStart -or [Math]::Abs(($actualStart - $claimedStart).TotalSeconds) -gt 5) { return $false }
    if (-not $AllowStoppedLauncher) {
        if (-not $Lock.launcherPid -or -not $Lock.launcherExecutablePath -or -not $Lock.launcherScriptPath -or -not $Lock.launcherStartedAt) { return $false }
        if ([int]$process.ParentProcessId -ne [int]$Lock.launcherPid) { return $false }
        $launcher = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$Lock.launcherPid)" -ErrorAction SilentlyContinue
        if (-not $launcher -or -not (Test-PathEqual $launcher.ExecutablePath $Lock.launcherExecutablePath)) { return $false }
        if (([string]$launcher.CommandLine).IndexOf([string]$Lock.launcherScriptPath, [StringComparison]::OrdinalIgnoreCase) -lt 0) { return $false }
        $actualLauncherStart = ConvertTo-ProcessCreationTime $launcher.CreationDate
        $claimedLauncherStart = ConvertTo-ProcessCreationTime $Lock.launcherStartedAt
        if (-not $actualLauncherStart -or [Math]::Abs(($actualLauncherStart - $claimedLauncherStart).TotalSeconds) -gt 5) { return $false }
    }
    return $true
}

function Get-InstanceValidation {
    $task = Get-PulseTask
    $healthResponse = Get-PulseHealthResponse
    $health = if ($healthResponse) { $healthResponse.Body } else { $null }
    $lock = Get-PulseLock
    $taskOwned = Test-TaskOwnership $task
    $taskRunning = [bool]($task -and [string]$task.State -eq "Running")
    $lockOwned = [bool]($lock -and [int]$lock.schemaVersion -eq 2 -and (Test-PathEqual $lock.runtimeRoot $lifeosDir) -and (Test-PathEqual $lock.configPath $ConfigPath))
    $resolvedBun = if ($lock) { [string]$lock.executablePath } else { $null }
    $taskConfigured = Test-TaskConfiguration $task $resolvedBun
    $identityAgreement = [bool]($health -and $lock -and
        [int]$health.lockSchemaVersion -eq [int]$lock.schemaVersion -and
        [string]$health.instanceId -eq [string]$lock.instanceId -and
        [int]$health.pid -eq [int]$lock.pid -and
        (Test-PathEqual $health.runtimeRoot $lock.runtimeRoot) -and
        (Test-PathEqual $health.configPath $lock.configPath) -and
        (Test-PathEqual $health.executablePath $lock.executablePath) -and
        (Test-PathEqual $health.scriptPath $lock.scriptPath) -and
        [string]$health.processStartedAt -eq [string]$lock.processStartedAt -and
        [int]$health.launcherPid -eq [int]$lock.launcherPid -and
        (Test-PathEqual $health.launcherExecutablePath $lock.launcherExecutablePath) -and
        (Test-PathEqual $health.launcherScriptPath $lock.launcherScriptPath) -and
        [string]$health.launcherStartedAt -eq [string]$lock.launcherStartedAt)
    $legacyIdentityAgreement = [bool]($health -and $lock -and [int]$lock.schemaVersion -lt 2 -and
        [string]$health.instanceId -eq [string]$lock.instanceId -and
        [int]$health.pid -eq [int]$lock.pid -and
        (Test-PathEqual $health.runtimeRoot $lock.runtimeRoot) -and
        (Test-PathEqual $lock.runtimeRoot $lifeosDir))
    $processOwned = Test-ProcessIdentity $lock
    $dashboardAvailable = [bool]($health -and $health.subsystems -and $health.subsystems.dashboard -and $health.subsystems.dashboard.status -eq "ok")
    $responding = [bool]$healthResponse
    $httpOk = [bool]($healthResponse -and $healthResponse.StatusCode -eq 200)
    $identityOk = [bool]($taskOwned -and $taskRunning -and $lockOwned -and $identityAgreement -and $processOwned)
    $serviceOk = [bool]($identityOk -and $taskConfigured -and $responding -and $httpOk -and $dashboardAvailable)

    [pscustomobject]@{
        Ok = $serviceOk
        IdentityOk = $identityOk
        Task = $task
        TaskOwned = $taskOwned
        TaskRunning = $taskRunning
        TaskConfigured = $taskConfigured
        Lock = $lock
        LockOwned = $lockOwned
        HealthResponse = $healthResponse
        Health = $health
        Responding = $responding
        HttpOk = $httpOk
        DashboardAvailable = $dashboardAvailable
        IdentityAgreement = $identityAgreement
        LegacyIdentityAgreement = $legacyIdentityAgreement
        ProcessOwned = $processOwned
    }
}

function Stop-VerifiedProcessTree {
    param($Validation)
    if (-not $Validation.IdentityOk) { throw "ownership-conflict: refusing to terminate Pulse without task/lock/health/process identity agreement" }
    $lock = $Validation.Lock
    $rootPid = [int]$lock.pid
    Stop-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction SilentlyContinue
    $deadline = (Get-Date).AddSeconds(3)
    while ((Get-Process -Id $rootPid -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 100 }
    if (-not (Get-Process -Id $rootPid -ErrorAction SilentlyContinue)) { return $true }
    if (-not (Test-ProcessIdentity $lock -AllowStoppedLauncher)) { throw "ownership-conflict: process identity changed after task stop; refusing force termination" }
    $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    $ids = New-Object System.Collections.Generic.List[int]
    $ids.Add($rootPid)
    for ($i = 0; $i -lt $ids.Count; $i++) {
        foreach ($child in $all | Where-Object { $_.ParentProcessId -eq $ids[$i] }) {
            if (-not $ids.Contains([int]$child.ProcessId)) { $ids.Add([int]$child.ProcessId) }
        }
    }
    foreach ($id in @($ids | Sort-Object -Descending)) { Stop-Process -Id $id -Force -ErrorAction Stop }
    return $true
}

function Remove-LockForInstance {
    param([string]$InstanceId)
    $current = Get-PulseLock
    if (-not $current) { return }
    if ([string]$current.instanceId -ne $InstanceId -or -not (Test-PathEqual $current.runtimeRoot $lifeosDir)) {
        throw "ownership-conflict: refusing to remove a lock whose identity changed"
    }
    if ([int]$current.schemaVersion -eq 2) {
        # The schema-v2 lock also identifies the supervising launcher. Reuse
        # guarded, quarantined cleanup so a surviving launcher or concurrent
        # starter cannot lose its lock.
        if (-not (Remove-OfflineOwnedLock)) { return }
        return
    }
    if (-not (Test-ProcessIdAbsent ([int]$current.pid))) { throw "refusing to remove the lock while its verified process is alive" }
    Remove-Item -LiteralPath $lockPath -Force
}

function Test-ProcessIdAbsent {
    param([int]$ProcessId)
    if ($ProcessId -le 0) { throw "refusing to check an invalid process id in the Pulse lock" }
    $process = $null
    try {
        $process = [Diagnostics.Process]::GetProcessById($ProcessId)
        # Force a handle lookup. If the process exists but its identity cannot
        # be inspected, fail closed rather than treating access trouble as absence.
        $null = $process.Handle
        return $false
    } catch [ArgumentException] {
        return $true
    } catch {
        throw "unable to verify whether Pulse lock process $ProcessId is absent: $($_.Exception.Message)"
    } finally {
        if ($process) { $process.Dispose() }
    }
}

function Remove-OfflineOwnedLock {
    if (-not (Test-Path -LiteralPath $lockPath -PathType Leaf)) { return $false }
    $initial = Get-PulseLock
    if (-not $initial) { throw "Pulse lock exists but cannot be parsed; preserving it for inspection" }
    if ([int]$initial.schemaVersion -ne 2 -or -not $initial.instanceId -or
        -not (Test-PathEqual $initial.runtimeRoot $lifeosDir) -or
        -not (Test-PathEqual $initial.configPath $ConfigPath)) {
        throw "ownership-conflict: refusing to remove a stale lock with a foreign or incomplete identity"
    }

    $guardPath = "$lockPath.reclaim"
    $quarantinePath = "$lockPath.uninstall-$([Guid]::NewGuid().ToString('N'))"
    $guardStream = $null
    $moved = $false
    try {
        try {
            # Match Pulse's exclusive .reclaim guard. A concurrent starter will
            # wait rather than publish a lock while this one is being removed.
            $guardStream = [IO.File]::Open($guardPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        } catch {
            throw "Pulse lock is being mutated; refusing offline cleanup"
        }

        $current = Get-PulseLock
        if (-not $current -or [string]$current.instanceId -ne [string]$initial.instanceId -or
            [int]$current.pid -ne [int]$initial.pid -or
            [string]$current.processStartedAt -ne [string]$initial.processStartedAt -or
            [string]$current.runtimeRoot -ne [string]$initial.runtimeRoot -or
            [string]$current.configPath -ne [string]$initial.configPath) {
            throw "ownership-conflict: Pulse lock identity changed before offline cleanup"
        }

        $processIds = @([int]$current.pid)
        if ($current.launcherPid) { $processIds += [int]$current.launcherPid }
        foreach ($processId in $processIds) {
            if (-not (Test-ProcessIdAbsent $processId)) {
                throw "refusing to remove the Pulse lock while recorded process $processId still exists"
            }
        }

        [IO.File]::Move($lockPath, $quarantinePath)
        $moved = $true
        $quarantined = Get-Content -Raw -LiteralPath $quarantinePath | ConvertFrom-Json
        if ([string]$quarantined.instanceId -ne [string]$current.instanceId -or
            [int]$quarantined.pid -ne [int]$current.pid -or
            [string]$quarantined.processStartedAt -ne [string]$current.processStartedAt) {
            throw "ownership-conflict: quarantined Pulse lock identity changed; preserving it"
        }
        foreach ($processId in $processIds) {
            if (-not (Test-ProcessIdAbsent $processId)) {
                throw "refusing to remove the Pulse lock because recorded process $processId reappeared"
            }
        }
        Remove-Item -LiteralPath $quarantinePath -Force
        $moved = $false
        return $true
    } finally {
        # Restore the original bytes whenever cleanup did not reach its safe
        # deletion point. If the lock name was unexpectedly reused, keep the
        # quarantined copy instead of overwriting a possible successor.
        if ($moved -and (Test-Path -LiteralPath $quarantinePath) -and -not (Test-Path -LiteralPath $lockPath)) {
            try { [IO.File]::Move($quarantinePath, $lockPath) } catch { }
        }
        if ($guardStream) {
            $guardStream.Dispose()
            Remove-Item -LiteralPath $guardPath -Force -ErrorAction SilentlyContinue
        }
    }
}

function Assert-ReplacementPrerequisites {
    param([string]$ResolvedBun)
    foreach ($required in @($pulseDir, $startScript, $pulseScript, $ConfigRoot, $ConfigPath, $ResolvedBun, $toastInstaller, $toastScript)) {
        if (-not $required -or -not (Test-Path -LiteralPath $required)) { throw "replacement prerequisite missing: $required" }
    }
    $dashboardIndex = Join-Path $pulseDir "Observability\out\index.html"
    if (-not (Test-Path -LiteralPath $dashboardIndex -PathType Leaf)) { throw "replacement prerequisite missing: dashboard build $dashboardIndex" }
    $shortcutParent = Split-Path -Parent $shortcutPath
    if (-not (Test-Path -LiteralPath $shortcutParent -PathType Container)) { throw "replacement prerequisite missing: shortcut directory $shortcutParent" }
}

function Register-PulseTask {
    param([string]$ResolvedBun)
    $userId = if ($env:USERDOMAIN) { "$env:USERDOMAIN\$env:USERNAME" } else { $env:USERNAME }
    $arguments = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$startScript`" -ConfigRoot `"$ConfigRoot`" -ConfigPath `"$ConfigPath`" -BunPath `"$ResolvedBun`" -RestartDelaySeconds $RestartDelaySeconds"
    $taskAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arguments -WorkingDirectory $pulseDir
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
    $principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
        -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
    Register-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -Action $taskAction -Trigger $trigger `
        -Principal $principal -Settings $settings -Description "LifeOS Pulse native Windows daemon" -Force | Out-Null
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $toastInstaller -ShortcutPath $shortcutPath -AppUserModelId "LifeOS.Pulse"
    if ($LASTEXITCODE -ne 0) { throw "failed to install the LifeOS toast identity shortcut" }
}

function Wait-PulseValidation {
    param([int]$TimeoutSeconds = $StartupTimeoutSeconds)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        $validation = Get-InstanceValidation
        if ($validation.Ok) { return $validation }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    return $validation
}

function Get-StatusResult {
    param($Validation = (Get-InstanceValidation))
    $health = $Validation.Health
    $lock = $Validation.Lock
    [ordered]@{
        ok = [bool]$Validation.Ok
        command = $Command
        task = if ($Validation.Task) { [string]$Validation.Task.State } else { "not-installed" }
        taskOwned = [bool]$Validation.TaskOwned
        taskRunning = [bool]$Validation.TaskRunning
        taskConfigured = [bool]$Validation.TaskConfigured
        taskName = "$TaskPath$TaskName"
        configRoot = $ConfigRoot
        configPath = $ConfigPath
        runtimeRoot = $lifeosDir
        responding = [bool]$Validation.Responding
        httpStatus = if ($Validation.HealthResponse) { [int]$Validation.HealthResponse.StatusCode } else { $null }
        dashboardAvailable = [bool]$Validation.DashboardAvailable
        identityAgreement = [bool]$Validation.IdentityAgreement
        processOwned = [bool]$Validation.ProcessOwned
        instanceId = if ($health) { $health.instanceId } else { $null }
        healthStatus = if ($health) { $health.status } else { "offline" }
        pid = if ($lock) { $lock.pid } else { $null }
        lockOwned = [bool]$Validation.LockOwned
    }
}

function Save-TaskBackup {
    param($Task)
    if (-not $Task) { return $null }
    [pscustomobject]@{
        Xml = Export-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath
        WasRunning = [string]$Task.State -eq "Running"
    }
}

function Restore-TaskBackup {
    param($Backup)
    Stop-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -Confirm:$false -ErrorAction SilentlyContinue
    if (-not $Backup) { return }
    Register-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -Xml $Backup.Xml -Force | Out-Null
    if ($Backup.WasRunning) { Start-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath }
}

function Install-OrRepair {
    $bun = Resolve-BunPath $BunPath
    if (-not $bun) { throw "Bun was not found. Install Bun or pass -BunPath." }
    Assert-ReplacementPrerequisites $bun

    $existing = Get-PulseTask
    $existingOwned = Test-TaskOwnership $existing
    if ($existing -and -not $existingOwned -and -not $Handoff) {
        throw "ownership-conflict: $TaskPath$TaskName belongs to another Pulse root; re-run with -Handoff"
    }
    $currentHealth = Get-PulseHealthResponse
    if ($currentHealth -and $currentHealth.Body -and -not (Test-PathEqual $currentHealth.Body.runtimeRoot $lifeosDir)) {
        if (-not $Handoff) { throw "ownership-conflict: port 31337 belongs to Pulse at $($currentHealth.Body.runtimeRoot); re-run with -Handoff" }
        if (-not $existing -or -not (Test-PathEqual (Get-TaskPulseRoot $existing) $currentHealth.Body.runtimeRoot)) {
            throw "ownership-conflict: the responding foreign Pulse is not owned by the task selected for handoff"
        }
    }

    $backup = Save-TaskBackup $existing
    $oldValidation = if ($existingOwned) { Get-InstanceValidation } else { $null }
    $replacementValidation = $null
    try {
        if ($existing) {
            $safeLegacyUpgradeAttempt = [bool]($existingOwned -and $oldValidation -and $oldValidation.LegacyIdentityAgreement)
            if ([string]$existing.State -eq "Running" -and (-not $oldValidation -or (-not $oldValidation.IdentityOk -and -not $safeLegacyUpgradeAttempt))) {
                throw "ownership-conflict: refusing replacement of a running task without complete process identity agreement"
            }
            $oldInstanceId = if ($currentHealth -and $currentHealth.Body) { [string]$currentHealth.Body.instanceId } else { $null }
            Stop-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction SilentlyContinue
            $deadline = (Get-Date).AddSeconds(5)
            do {
                $remainingHealth = Get-PulseHealthResponse
                $sameOldInstance = [bool]($remainingHealth -and $remainingHealth.Body -and [string]$remainingHealth.Body.instanceId -eq $oldInstanceId)
                if ($sameOldInstance) { Start-Sleep -Milliseconds 100 }
            } while ($sameOldInstance -and (Get-Date) -lt $deadline)
            if ($sameOldInstance) {
                if ($oldValidation -and $oldValidation.IdentityOk) { Stop-VerifiedProcessTree $oldValidation | Out-Null }
                else { throw "ownership-conflict: the previous task stopped but its unverified process is still serving Pulse" }
            }
            Unregister-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -Confirm:$false
        }
        Register-PulseTask $bun
        Start-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath
        $replacementValidation = Wait-PulseValidation
        if (-not $replacementValidation.Ok) {
            $evidence = (Get-StatusResult $replacementValidation | ConvertTo-Json -Compress -Depth 5)
            $taskInfo = Get-ScheduledTaskInfo -TaskName $TaskName -TaskPath $TaskPath -ErrorAction SilentlyContinue
            $taskResult = if ($taskInfo) { [string]$taskInfo.LastTaskResult } else { "unavailable" }
            throw "replacement failed strict lifecycle validation (LastTaskResult=$taskResult): $evidence"
        }
        return Get-StatusResult $replacementValidation
    } catch {
        $failure = $_
        $cleanupFailure = $null
        try {
            if ($replacementValidation -and $replacementValidation.IdentityOk) {
                Stop-VerifiedProcessTree $replacementValidation | Out-Null
                Remove-LockForInstance ([string]$replacementValidation.Lock.instanceId)
            }
        } catch { $cleanupFailure = $_.Exception.Message }
        Restore-TaskBackup $backup
        $rollback = if ($backup) { "the previous task was restored" } else { "the partial replacement was removed" }
        $cleanupDetail = if ($cleanupFailure) { "; replacement cleanup warning: $cleanupFailure" } else { "" }
        throw "Pulse replacement failed and $rollback`: $($failure.Exception.Message)$cleanupDetail"
    }
}

function Assert-LegacyMigrationAllowed {
    $legacy = Get-PulseTask $legacyTaskName $legacyTaskPath
    if ($legacy -and -not (Test-TaskOwnership $legacy) -and -not $Handoff) {
        throw "ownership-conflict: legacy task '$legacyTaskName' belongs to another runtime; re-run with -Handoff"
    }
}

function Remove-OwnedLegacyTask {
    $legacy = Get-PulseTask $legacyTaskName $legacyTaskPath
    if (-not $legacy) { return }
    if (-not (Test-TaskOwnership $legacy) -and -not $Handoff) {
        throw "ownership-conflict: legacy task '$legacyTaskName' belongs to another runtime; re-run with -Handoff"
    }
    Stop-ScheduledTask -TaskName $legacyTaskName -TaskPath $legacyTaskPath -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $legacyTaskName -TaskPath $legacyTaskPath -Confirm:$false
}

function Write-Result {
    param($Result)
    if ($Json) { $Result | ConvertTo-Json -Depth 8 -Compress }
    else { $Result.GetEnumerator() | ForEach-Object { Write-Host ("{0}: {1}" -f $_.Key, $_.Value) } }
}

# Focused unit tests dot-source this file to exercise identity and literal-path
# helpers without querying or mutating Task Scheduler.
if ($env:LIFEOS_MANAGE_LIBRARY_ONLY -eq "1") { return }

try {
    $result = $null
    switch ($Command) {
        "install" {
            Assert-LegacyMigrationAllowed
            $result = Install-OrRepair
            Remove-OwnedLegacyTask
        }
        "repair" {
            Assert-LegacyMigrationAllowed
            $result = Install-OrRepair
            Remove-OwnedLegacyTask
        }
        "start" {
            $task = Get-PulseTask
            if (-not $task -or -not (Test-TaskOwnership $task)) { throw "Pulse task is missing or unowned; run manage.ps1 install" }
            Start-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath
            $validation = Wait-PulseValidation
            $result = Get-StatusResult $validation
        }
        "stop" {
            $validation = Get-InstanceValidation
            if (-not $validation.Task -or -not $validation.TaskOwned) { throw "ownership-conflict: refusing to stop a missing or unowned task" }
            if ($validation.Responding) {
                Stop-VerifiedProcessTree $validation | Out-Null
                Remove-LockForInstance ([string]$validation.Lock.instanceId)
            } else {
                Stop-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction Stop
            }
            $result = Get-StatusResult
            $result.ok = -not $result.responding
        }
        "restart" {
            $validation = Get-InstanceValidation
            if (-not $validation.IdentityOk) { throw "ownership-conflict: refusing restart without complete instance identity agreement" }
            Stop-VerifiedProcessTree $validation | Out-Null
            Remove-LockForInstance ([string]$validation.Lock.instanceId)
            Start-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath
            $result = Get-StatusResult (Wait-PulseValidation)
        }
        "status" { $result = Get-StatusResult }
        "uninstall" {
            $validation = Get-InstanceValidation
            if ($validation.Task -and -not $validation.TaskOwned) { throw "ownership-conflict: refusing to remove an unowned task" }
            if ($validation.Responding) {
                Stop-VerifiedProcessTree $validation | Out-Null
                Remove-LockForInstance ([string]$validation.Lock.instanceId)
            } elseif ($validation.Task) {
                Stop-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction SilentlyContinue
            }
            if ($validation.Task) { Unregister-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -Confirm:$false }
            $removedOfflineLock = if (-not $validation.Responding) { Remove-OfflineOwnedLock } else { $false }
            Remove-OwnedLegacyTask
            if (Test-Path -LiteralPath $shortcutPath) { Remove-Item -LiteralPath $shortcutPath -Force }
            $result = [ordered]@{ ok = $true; command = $Command; removedTask = [bool]$validation.Task; removedOfflineLock = [bool]$removedOfflineLock; preservedRuntime = $pulseDir; preservedUserData = (Join-Path $lifeosDir "USER") }
        }
    }
    Write-Result $result
    if (-not $result.ok) { exit 1 }
} catch {
    $errorResult = [ordered]@{ ok = $false; command = $Command; error = $_.Exception.Message; runtimeRoot = $lifeosDir; configPath = $ConfigPath }
    Write-Result $errorResult
    exit 1
}
