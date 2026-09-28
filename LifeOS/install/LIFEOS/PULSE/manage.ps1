# LifeOS Pulse — native Windows per-user lifecycle manager.
# Usage: powershell -ExecutionPolicy Bypass -File manage.ps1 <command> [-Json] [-Handoff]

param(
    [ValidateSet("install", "start", "stop", "restart", "status", "repair", "uninstall")]
    [string]$Command = "status",
    [switch]$Json,
    [switch]$Handoff,
    [string]$ConfigRoot,
    [string]$BunPath,
    [string]$TaskName = "Pulse",
    [string]$TaskPath = "\LifeOS\",
    [string]$NotificationShortcut,
    [int]$RestartDelaySeconds = 60
)

$ErrorActionPreference = "Stop"
$pulseDir = $PSScriptRoot
$lifeosDir = Split-Path -Parent $pulseDir
if (-not $ConfigRoot) { $ConfigRoot = Split-Path -Parent $lifeosDir }
$startScript = Join-Path $pulseDir "PulseStart.ps1"
$toastInstaller = Join-Path $pulseDir "InstallToastShortcut.ps1"
$lockPath = Join-Path $pulseDir "state\pulse.lock.json"
$shortcutPath = if ($NotificationShortcut) { $NotificationShortcut } else { Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\LifeOS Pulse.lnk" }
$healthUrl = "http://127.0.0.1:31337/healthz"
$legacyTaskName = "LifeOS Pulse"
$legacyTaskPath = "\"

function Resolve-CanonicalPath {
    param([string]$Path)
    if (-not $Path) { return $null }
    try { return (Resolve-Path -LiteralPath $Path).Path.TrimEnd("\") } catch { return [IO.Path]::GetFullPath($Path).TrimEnd("\") }
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
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }
    return $null
}

function Get-OwnedTask {
    Get-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction SilentlyContinue
}

function Get-LegacyTask {
    Get-ScheduledTask -TaskName $legacyTaskName -TaskPath $legacyTaskPath -ErrorAction SilentlyContinue
}

function Test-TaskOwnership {
    param($Task)
    if (-not $Task) { return $false }
    $expectedWorkingDir = Resolve-CanonicalPath $pulseDir
    foreach ($action in @($Task.Actions)) {
        $workingDir = Resolve-CanonicalPath $action.WorkingDirectory
        if ($workingDir -eq $expectedWorkingDir -and $action.Arguments -like "*$startScript*") { return $true }
    }
    return $false
}

function Get-PulseHealth {
    try {
        return Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2 -UseBasicParsing
    } catch {
        try {
            $response = $_.Exception.Response
            if ($response) {
                $reader = New-Object IO.StreamReader($response.GetResponseStream())
                return ($reader.ReadToEnd() | ConvertFrom-Json)
            }
        } catch { }
        return $null
    }
}

function Get-PulseLock {
    if (-not (Test-Path -LiteralPath $lockPath)) { return $null }
    try { return (Get-Content -Raw -LiteralPath $lockPath | ConvertFrom-Json) } catch { return $null }
}

function Stop-OwnedProcessTree {
    $lock = Get-PulseLock
    if (-not $lock -or -not $lock.pid) { return $false }
    if ((Resolve-CanonicalPath $lock.runtimeRoot) -ne (Resolve-CanonicalPath $lifeosDir)) {
        throw "ownership-conflict: lock belongs to $($lock.runtimeRoot), not $lifeosDir"
    }
    $rootPid = [int]$lock.pid
    $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    $ids = New-Object System.Collections.Generic.List[int]
    $ids.Add($rootPid)
    for ($i = 0; $i -lt $ids.Count; $i++) {
        foreach ($child in $all | Where-Object { $_.ParentProcessId -eq $ids[$i] }) {
            if (-not $ids.Contains([int]$child.ProcessId)) { $ids.Add([int]$child.ProcessId) }
        }
    }
    foreach ($id in @($ids | Sort-Object -Descending)) {
        Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
    }
    return $true
}

function Remove-OwnedLock {
    $lock = Get-PulseLock
    if (-not $lock) { return }
    if ((Resolve-CanonicalPath $lock.runtimeRoot) -ne (Resolve-CanonicalPath $lifeosDir)) {
        throw "ownership-conflict: refusing to remove lock owned by $($lock.runtimeRoot)"
    }
    if (Test-Path -LiteralPath $lockPath) { Remove-Item -LiteralPath $lockPath -Force }
}

function Assert-NoOwnershipConflict {
    $task = Get-OwnedTask
    if ($task -and -not (Test-TaskOwnership $task)) {
        if (-not $Handoff) { throw "ownership-conflict: $TaskPath$TaskName is owned by another Pulse root; re-run with -Handoff to replace it" }
        Stop-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -Confirm:$false
    }
    $health = Get-PulseHealth
    if ($health -and $health.runtimeRoot -and (Resolve-CanonicalPath $health.runtimeRoot) -ne (Resolve-CanonicalPath $lifeosDir)) {
        if (-not $Handoff) { throw "ownership-conflict: port 31337 belongs to Pulse at $($health.runtimeRoot); re-run with -Handoff" }
        if ($health.pid) { Stop-Process -Id ([int]$health.pid) -Force -ErrorAction SilentlyContinue }
    }
}

function Remove-OwnedLegacyTask {
    $legacy = Get-LegacyTask
    if (-not $legacy) { return $false }
    if (-not (Test-TaskOwnership $legacy)) {
        if (-not $Handoff) { throw "ownership-conflict: legacy task '$legacyTaskName' belongs to another runtime; re-run with -Handoff to replace it" }
    }
    Stop-ScheduledTask -TaskName $legacyTaskName -TaskPath $legacyTaskPath -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $legacyTaskName -TaskPath $legacyTaskPath -Confirm:$false
    return $true
}

function Register-PulseTask {
    param([string]$ResolvedBun)
    if (-not (Test-Path -LiteralPath $startScript -PathType Leaf)) { throw "missing launcher: $startScript" }
    $userId = if ($env:USERDOMAIN) { "$env:USERDOMAIN\$env:USERNAME" } else { $env:USERNAME }
    $arguments = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$startScript`" -ConfigRoot `"$ConfigRoot`" -BunPath `"$ResolvedBun`" -RestartDelaySeconds $RestartDelaySeconds"
    $taskAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arguments -WorkingDirectory $pulseDir
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
    $principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
        -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
    Register-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -Action $taskAction -Trigger $trigger `
        -Principal $principal -Settings $settings -Description "LifeOS Pulse native Windows daemon" -Force | Out-Null
    if (Test-Path -LiteralPath $toastInstaller) {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $toastInstaller -ShortcutPath $shortcutPath -AppUserModelId "LifeOS.Pulse"
        if ($LASTEXITCODE -ne 0) { throw "failed to install the LifeOS toast identity shortcut" }
    }
}

function Wait-PulseHealth {
    param([int]$TimeoutSeconds = 15)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        $health = Get-PulseHealth
        if ($health -and (Resolve-CanonicalPath $health.runtimeRoot) -eq (Resolve-CanonicalPath $lifeosDir)) { return $health }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    return $null
}

function Get-StatusResult {
    $task = Get-OwnedTask
    $health = Get-PulseHealth
    $lock = Get-PulseLock
    [ordered]@{
        ok = [bool]($task -and (Test-TaskOwnership $task) -and $health -and (Resolve-CanonicalPath $health.runtimeRoot) -eq (Resolve-CanonicalPath $lifeosDir))
        command = $Command
        task = if ($task) { [string]$task.State } else { "not-installed" }
        taskOwned = [bool](Test-TaskOwnership $task)
        taskName = "$TaskPath$TaskName"
        configRoot = Resolve-CanonicalPath $ConfigRoot
        runtimeRoot = Resolve-CanonicalPath $lifeosDir
        responding = [bool]$health
        instanceId = if ($health) { $health.instanceId } else { $null }
        healthStatus = if ($health) { $health.status } else { "offline" }
        pid = if ($lock) { $lock.pid } else { $null }
        lockOwned = [bool]($lock -and (Resolve-CanonicalPath $lock.runtimeRoot) -eq (Resolve-CanonicalPath $lifeosDir))
    }
}

function Write-Result {
    param($Result)
    if ($Json) { $Result | ConvertTo-Json -Depth 8 -Compress }
    else { $Result.GetEnumerator() | ForEach-Object { Write-Host ("{0}: {1}" -f $_.Key, $_.Value) } }
}

try {
    $result = $null
    switch ($Command) {
        "install" {
            Assert-NoOwnershipConflict
            Remove-OwnedLegacyTask | Out-Null
            $bun = Resolve-BunPath $BunPath
            if (-not $bun) { throw "Bun was not found. Install Bun or pass -BunPath." }
            Register-PulseTask $bun
            Start-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath
            $health = Wait-PulseHealth
            $result = Get-StatusResult
            $result.ok = [bool]$health
        }
        "repair" {
            Assert-NoOwnershipConflict
            Remove-OwnedLegacyTask | Out-Null
            $bun = Resolve-BunPath $BunPath
            if (-not $bun) { throw "Bun was not found. Install Bun or pass -BunPath." }
            $existingTask = Get-OwnedTask
            if ($existingTask) {
                Stop-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction SilentlyContinue
                Stop-OwnedProcessTree | Out-Null
                Remove-OwnedLock
            }
            Register-PulseTask $bun
            Start-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath
            $health = Wait-PulseHealth
            $result = Get-StatusResult
            $result.ok = [bool]$health
        }
        "start" {
            $task = Get-OwnedTask
            if (-not $task) { throw "Pulse task is not installed; run manage.ps1 install" }
            if (-not (Test-TaskOwnership $task)) { throw "ownership-conflict: scheduled task belongs to another runtime" }
            Start-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath
            Wait-PulseHealth | Out-Null
            $result = Get-StatusResult
        }
        "stop" {
            $task = Get-OwnedTask
            if ($task -and -not (Test-TaskOwnership $task)) { throw "ownership-conflict: refusing to stop an unowned task" }
            if ($task) { Stop-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction SilentlyContinue }
            Stop-OwnedProcessTree | Out-Null
            Remove-OwnedLock
            $result = Get-StatusResult
            $result.ok = -not $result.responding
        }
        "restart" {
            $task = Get-OwnedTask
            if (-not $task -or -not (Test-TaskOwnership $task)) { throw "Pulse task is missing or unowned; run manage.ps1 repair" }
            Stop-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction SilentlyContinue
            Stop-OwnedProcessTree | Out-Null
            Remove-OwnedLock
            Start-Sleep -Milliseconds 500
            Start-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath
            Wait-PulseHealth | Out-Null
            $result = Get-StatusResult
        }
        "status" { $result = Get-StatusResult }
        "uninstall" {
            $task = Get-OwnedTask
            if ($task -and -not (Test-TaskOwnership $task)) { throw "ownership-conflict: refusing to remove an unowned task" }
            # Resolve legacy ownership before mutating the current task so a
            # conflict cannot leave this runtime only half-uninstalled.
            Remove-OwnedLegacyTask | Out-Null
            if ($task) {
                Stop-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction SilentlyContinue
                Stop-OwnedProcessTree | Out-Null
                Unregister-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -Confirm:$false
            }
            Remove-OwnedLock
            if (Test-Path -LiteralPath $shortcutPath) { Remove-Item -LiteralPath $shortcutPath -Force }
            $result = [ordered]@{ ok = $true; command = $Command; removedTask = [bool]$task; preservedRuntime = $pulseDir; preservedUserData = (Join-Path $lifeosDir "USER") }
        }
    }
    Write-Result $result
    if (-not $result.ok) { exit 1 }
} catch {
    $errorResult = [ordered]@{ ok = $false; command = $Command; error = $_.Exception.Message; runtimeRoot = Resolve-CanonicalPath $lifeosDir }
    Write-Result $errorResult
    exit 1
}
