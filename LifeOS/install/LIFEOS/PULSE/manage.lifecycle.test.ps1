$ErrorActionPreference = "Stop"
$env:LIFEOS_MANAGE_LIBRARY_ONLY = "1"
try {
    . (Join-Path $PSScriptRoot "manage.ps1")

    function Assert-True {
        param([bool]$Value, [string]$Message)
        if (-not $Value) { throw $Message }
    }

    # Literal ownership matching must not interpret [] or other wildcard syntax.
    $script:pulseDir = "C:\Temp\LifeOS [main]\PULSE"
    $script:startScript = Join-Path $script:pulseDir "PulseStart.ps1"
    $ownedTask = [pscustomobject]@{
        Actions = @([pscustomobject]@{
            WorkingDirectory = $script:pulseDir
            Arguments = "-NoProfile -File `"$script:startScript`" -ConfigRoot `"C:\Temp\LifeOS [main]`""
        })
    }
    Assert-True (Test-TaskOwnership $ownedTask) "bracketed literal task path was not recognized"
    $ownedTask.Actions[0].Arguments = $ownedTask.Actions[0].Arguments.Replace("LifeOS [main]", "LifeOS x [main]")
    Assert-True (-not (Test-TaskOwnership $ownedTask)) "substring task path was incorrectly accepted"

    # A PID is insufficient. The executable, command-line script, and process
    # creation identity all have to describe this exact process.
    $self = Get-CimInstance Win32_Process -Filter "ProcessId = $PID"
    $created = ConvertTo-ProcessCreationTime $self.CreationDate
    $lock = [pscustomobject]@{
        pid = $PID
        executablePath = $self.ExecutablePath
        scriptPath = "manage.lifecycle.test.ps1"
        processStartedAt = $created.ToString("o")
    }
    Assert-True (Test-ProcessIdentity $lock -AllowStoppedLauncher) "the current process identity did not validate"

    # Windows PowerShell's ConvertFrom-Json can unwrap a UTC ISO string into
    # an Unspecified DateTime. That value must retain UTC semantics rather than
    # being shifted by the local timezone when process ownership is checked.
    $utcFixture = "2026-09-28T23:24:14.311Z"
    $expectedUtc = [DateTimeOffset]::Parse($utcFixture).UtcDateTime
    $jsonDate = ('{"startedAt":"' + $utcFixture + '"}' | ConvertFrom-Json).startedAt
    $normalizedJsonDate = ConvertTo-ProcessCreationTime $jsonDate
    Assert-True ($normalizedJsonDate -and [Math]::Abs(($normalizedJsonDate - $expectedUtc).TotalSeconds) -lt 1) "a JSON-parsed UTC timestamp was shifted by the local timezone"

    $wrongStart = $lock | Select-Object *
    $wrongStart.processStartedAt = $created.AddMinutes(-10).ToString("o")
    Assert-True (-not (Test-ProcessIdentity $wrongStart -AllowStoppedLauncher)) "a reused PID with a different creation time was accepted"

    $wrongExecutable = $lock | Select-Object *
    $wrongExecutable.executablePath = Join-Path $env:WINDIR "System32\not-the-owner.exe"
    Assert-True (-not (Test-ProcessIdentity $wrongExecutable -AllowStoppedLauncher)) "a reused PID with a different executable was accepted"

    $wrongScript = $lock | Select-Object *
    $wrongScript.scriptPath = "C:\not-the-owner\pulse.ts"
    Assert-True (-not (Test-ProcessIdentity $wrongScript -AllowStoppedLauncher)) "a reused PID with a different script was accepted"
    Assert-True (-not (Test-ProcessIdAbsent $PID)) "the current PowerShell process was reported absent"
    Assert-True (Test-ProcessIdAbsent 2147483647) "a nonexistent PID was reported present"

    # Strict service success is stronger than process identity. HTTP 503,
    # missing dashboard assets, and lock/health mismatches all fail; optional
    # degradation in an HTTP-200 response remains healthy.
    $script:lifeosDir = "C:\Temp\LifeOS [main]\LIFEOS"
    $script:ConfigRoot = "C:\Temp\LifeOS [main]"
    $script:ConfigPath = "D:\External Config\LIFEOS_CONFIG.toml"
    $script:pulseDir = Join-Path $script:lifeosDir "PULSE"
    $script:startScript = Join-Path $script:pulseDir "PulseStart.ps1"
    $script:fixtureLock = [pscustomobject]@{
        schemaVersion = 2
        pid = 4242
        instanceId = "instance-a"
        runtimeRoot = $script:lifeosDir
        configPath = $script:ConfigPath
        executablePath = "C:\Tools\bun.exe"
        scriptPath = Join-Path $script:pulseDir "pulse.ts"
        processStartedAt = "2026-01-01T00:00:00.000Z"
        launcherPid = 4343
        launcherExecutablePath = "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
        launcherScriptPath = $script:startScript
        launcherStartedAt = "2026-01-01T00:00:00.000Z"
    }
    $script:fixtureTask = [pscustomobject]@{
        State = "Running"
        Actions = @([pscustomobject]@{
            WorkingDirectory = $script:pulseDir
            Arguments = "-File `"$script:startScript`" -ConfigRoot `"$script:ConfigRoot`" -ConfigPath `"$script:ConfigPath`" -BunPath `"$($script:fixtureLock.executablePath)`""
        })
    }
    $script:fixtureStatus = 503
    $script:fixtureDashboard = "ok"
    $script:fixtureHealthInstance = "instance-a"
    function Get-PulseTask { return $script:fixtureTask }
    function Get-PulseLock { return $script:fixtureLock }
    function Test-ProcessIdentity { return $true }
    function Get-PulseHealthResponse {
        return [pscustomobject]@{
            StatusCode = $script:fixtureStatus
            Body = [pscustomobject]@{
                status = if ($script:fixtureStatus -eq 200) { "degraded" } else { "degraded" }
                lockSchemaVersion = $script:fixtureLock.schemaVersion
                instanceId = $script:fixtureHealthInstance
                pid = $script:fixtureLock.pid
                runtimeRoot = $script:fixtureLock.runtimeRoot
                configPath = $script:fixtureLock.configPath
                executablePath = $script:fixtureLock.executablePath
                scriptPath = $script:fixtureLock.scriptPath
                processStartedAt = $script:fixtureLock.processStartedAt
                launcherPid = $script:fixtureLock.launcherPid
                launcherExecutablePath = $script:fixtureLock.launcherExecutablePath
                launcherScriptPath = $script:fixtureLock.launcherScriptPath
                launcherStartedAt = $script:fixtureLock.launcherStartedAt
                subsystems = [pscustomobject]@{ dashboard = [pscustomobject]@{ status = $script:fixtureDashboard } }
            }
        }
    }

    $validation = Get-InstanceValidation
    Assert-True ($validation.IdentityOk -and -not $validation.Ok) "HTTP 503 was incorrectly accepted as lifecycle success"

    $script:fixtureStatus = 200
    $script:fixtureDashboard = "missing"
    Assert-True (-not (Get-InstanceValidation).Ok) "a missing dashboard was incorrectly accepted"

    $script:fixtureDashboard = "ok"
    Assert-True (Get-InstanceValidation).Ok "HTTP-200 optional degradation was incorrectly rejected"

    $script:fixtureHealthInstance = "instance-b"
    Assert-True (-not (Get-InstanceValidation).Ok) "a health/lock instance mismatch was accepted"

    # Offline uninstall may remove only an unchanged, v2 lock whose worker and
    # launcher PIDs are both provably absent. Exercise the helper using a
    # temporary lock path; never touch the real runtime state directory.
    $cleanupRoot = Join-Path $env:TEMP ("lifeos-lock-cleanup-" + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $cleanupRoot -Force | Out-Null
    $script:lockPath = Join-Path $cleanupRoot "pulse.lock.json"
    $script:fixtureLock = [pscustomobject]@{
        schemaVersion = 2; pid = 4242; instanceId = "cleanup-instance"
        runtimeRoot = $script:lifeosDir; configPath = $script:ConfigPath
        processStartedAt = "2026-01-01T00:00:00.000Z"; launcherPid = 4343
    }
    function Get-PulseLock {
        if (-not (Test-Path -LiteralPath $script:lockPath)) { return $null }
        return (Get-Content -Raw -LiteralPath $script:lockPath | ConvertFrom-Json)
    }
    $script:recordedProcessesAbsent = $true
    function Test-ProcessIdAbsent { return $script:recordedProcessesAbsent }
    try {
        $script:fixtureLock | ConvertTo-Json | Set-Content -LiteralPath $script:lockPath
        Assert-True (Remove-OfflineOwnedLock) "a stale owned lock was not removed"
        Assert-True (-not (Test-Path -LiteralPath $script:lockPath)) "the stale lock remained after safe cleanup"

        $script:fixtureLock | ConvertTo-Json | Set-Content -LiteralPath $script:lockPath
        $script:recordedProcessesAbsent = $false
        try { Remove-OfflineOwnedLock | Out-Null; throw "a live recorded PID did not block lock cleanup" } catch {
            if ($_.Exception.Message -eq "a live recorded PID did not block lock cleanup") { throw }
        }
        Assert-True (Test-Path -LiteralPath $script:lockPath) "a lock with a live/uncertain PID was removed"

        $script:recordedProcessesAbsent = $true
        $foreignLock = $script:fixtureLock | Select-Object *
        $foreignLock.runtimeRoot = "C:\\Other\\LIFEOS"
        $foreignLock | ConvertTo-Json | Set-Content -LiteralPath $script:lockPath
        try { Remove-OfflineOwnedLock | Out-Null; throw "a foreign lock was removed" } catch {
            if ($_.Exception.Message -eq "a foreign lock was removed") { throw }
        }
        Assert-True (Test-Path -LiteralPath $script:lockPath) "a foreign lock was removed"

        $script:fixtureLock | ConvertTo-Json | Set-Content -LiteralPath $script:lockPath
        New-Item -ItemType File -Path "$($script:lockPath).reclaim" | Out-Null
        try { Remove-OfflineOwnedLock | Out-Null; throw "an active mutation guard did not block cleanup" } catch {
            if ($_.Exception.Message -eq "an active mutation guard did not block cleanup") { throw }
        }
        Assert-True (Test-Path -LiteralPath $script:lockPath) "a guarded lock was removed"
    } finally {
        Remove-Item -LiteralPath $cleanupRoot -Recurse -Force -ErrorAction SilentlyContinue
    }

    Write-Output "manage lifecycle helper tests passed"
} finally {
    Remove-Item Env:LIFEOS_MANAGE_LIBRARY_ONLY -ErrorAction SilentlyContinue
}
