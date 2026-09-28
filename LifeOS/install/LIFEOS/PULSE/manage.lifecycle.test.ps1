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

    $wrongStart = $lock | Select-Object *
    $wrongStart.processStartedAt = $created.AddMinutes(-10).ToString("o")
    Assert-True (-not (Test-ProcessIdentity $wrongStart -AllowStoppedLauncher)) "a reused PID with a different creation time was accepted"

    $wrongExecutable = $lock | Select-Object *
    $wrongExecutable.executablePath = Join-Path $env:WINDIR "System32\not-the-owner.exe"
    Assert-True (-not (Test-ProcessIdentity $wrongExecutable -AllowStoppedLauncher)) "a reused PID with a different executable was accepted"

    $wrongScript = $lock | Select-Object *
    $wrongScript.scriptPath = "C:\not-the-owner\pulse.ts"
    Assert-True (-not (Test-ProcessIdentity $wrongScript -AllowStoppedLauncher)) "a reused PID with a different script was accepted"

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

    Write-Output "manage lifecycle helper tests passed"
} finally {
    Remove-Item Env:LIFEOS_MANAGE_LIBRARY_ONLY -ErrorAction SilentlyContinue
}
