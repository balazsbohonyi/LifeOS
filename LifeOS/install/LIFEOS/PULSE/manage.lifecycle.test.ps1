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

    # PulseStart.ps1 starts Bun through cmd.exe, so the launcher is Bun's grandparent. The
    # launcher check must accept that chain, and reject any chain that does not end at the
    # launcher or that passes through something other than the system cmd.exe. These use
    # real processes: this test process is the launcher.
    $selfCreated = ConvertTo-ProcessCreationTime $self.CreationDate
    $psExe = (Get-Process -Id $PID).Path
    $chainPids = New-Object System.Collections.Generic.List[int]
    function New-ChainLock($Process, $LauncherPid) {
        [pscustomobject]@{
            pid = $Process.ProcessId; executablePath = $Process.ExecutablePath; scriptPath = "Start-Sleep"
            processStartedAt = (ConvertTo-ProcessCreationTime $Process.CreationDate).ToString("o")
            launcherPid = $LauncherPid; launcherExecutablePath = $self.ExecutablePath
            launcherScriptPath = "manage.lifecycle.test.ps1"; launcherStartedAt = $selfCreated.ToString("o")
        }
    }
    function Wait-ChildProcess([int]$ParentId, [string]$Name) {
        for ($i = 0; $i -lt 50; $i++) {
            $child = Get-CimInstance Win32_Process -Filter "ParentProcessId = $ParentId AND Name = '$Name'" -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($child) { return $child }
            Start-Sleep -Milliseconds 100
        }
        throw "no $Name child of $ParentId appeared"
    }
    try {
        $sleep = "-NoProfile -Command Start-Sleep -Seconds 60"
        # launcher -> cmd.exe -> process (the real Pulse shape)
        $cmdProc = Start-Process -FilePath (Join-Path $env:SystemRoot "System32\cmd.exe") -ArgumentList "/d /s /c `"`"$psExe`" $sleep`"" -PassThru -WindowStyle Hidden
        $chainPids.Add($cmdProc.Id)
        $viaCmd = Wait-ChildProcess $cmdProc.Id "powershell.exe"
        Assert-True (Test-ProcessIdentity (New-ChainLock $viaCmd $PID)) "a process started through cmd.exe was not recognized as launched by the launcher"
        Assert-True (-not (Test-ProcessIdentity (New-ChainLock $viaCmd 4))) "a launcher PID that is not in the parent chain was accepted"

        # launcher -> process (no cmd.exe hop) keeps working
        $direct = Start-Process -FilePath $psExe -ArgumentList $sleep -PassThru -WindowStyle Hidden
        $chainPids.Add($direct.Id)
        $directProc = Get-CimInstance Win32_Process -Filter "ProcessId = $($direct.Id)"
        Assert-True (Test-ProcessIdentity (New-ChainLock $directProc $PID)) "a direct child of the launcher was not recognized"

        # launcher -> powershell.exe -> process: an intermediate that is not cmd.exe is rejected
        $outer = Start-Process -FilePath $psExe -ArgumentList "-NoProfile -Command & `"$psExe`" $sleep" -PassThru -WindowStyle Hidden
        $chainPids.Add($outer.Id)
        $inner = Wait-ChildProcess $outer.Id "powershell.exe"
        Assert-True (-not (Test-ProcessIdentity (New-ChainLock $inner $PID))) "a chain through a non-cmd.exe process was accepted"
    } finally {
        foreach ($id in $chainPids) { & taskkill.exe /PID $id /T /F 2>&1 | Out-Null }
    }

    # Stopping the scheduled task can leave the PowerShell launcher running, and that orphan
    # restarts Pulse. Stop-VerifiedLauncher must end it, but only while the PID still matches
    # the launcher recorded in the lock. These use a real stand-in process.
    function New-LauncherLock($Process) {
        [pscustomobject]@{
            launcherPid = $Process.ProcessId; launcherExecutablePath = $Process.ExecutablePath
            launcherScriptPath = "Start-Sleep"
            launcherStartedAt = (ConvertTo-ProcessCreationTime $Process.CreationDate).ToString("o")
        }
    }
    $launcherPids = New-Object System.Collections.Generic.List[int]
    try {
        $standIn = Start-Process -FilePath $psExe -ArgumentList $sleep -PassThru -WindowStyle Hidden
        $launcherPids.Add($standIn.Id)
        $standInInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $($standIn.Id)"
        $goodLock = New-LauncherLock $standInInfo
        Assert-True (Test-LauncherIdentity $goodLock) "a matching launcher was not recognized"

        $badStart = New-LauncherLock $standInInfo
        $badStart.launcherStartedAt = (ConvertTo-ProcessCreationTime $standInInfo.CreationDate).AddMinutes(-10).ToString("o")
        $badExe = New-LauncherLock $standInInfo
        $badExe.launcherExecutablePath = Join-Path $env:WINDIR "System32\not-the-launcher.exe"
        $badScript = New-LauncherLock $standInInfo
        $badScript.launcherScriptPath = "C:\not-the-owner\PulseStart.ps1"
        $noStart = New-LauncherLock $standInInfo
        $noStart.launcherStartedAt = $null
        $gonePid = New-LauncherLock $standInInfo
        $gonePid.launcherPid = 2147483647
        foreach ($case in @(@("start time", $badStart), @("executable", $badExe), @("script", $badScript), @("missing start time", $noStart), @("absent pid", $gonePid))) {
            Assert-True (-not (Test-LauncherIdentity $case[1])) "a launcher with a wrong $($case[0]) was accepted"
        }
        Assert-True (-not (Test-LauncherIdentity $null)) "a null lock was accepted as a launcher"

        # The ownership check still enforces the launcher half after sharing this helper.
        $standInProc = Get-CimInstance Win32_Process -Filter "ProcessId = $($standIn.Id)"
        $ownedLock = New-ChainLock $standInProc $PID
        Assert-True (Test-ProcessIdentity $ownedLock) "the ownership check rejected a matching process and launcher"
        $ownedLock.launcherStartedAt = $selfCreated.AddMinutes(-10).ToString("o")
        Assert-True (-not (Test-ProcessIdentity $ownedLock)) "the ownership check accepted a launcher with a different start time"

        # A mismatching lock must never end a process.
        foreach ($case in @($badStart, $badExe, $badScript, $noStart, $gonePid)) { Stop-VerifiedLauncher $case }
        Assert-True ($null -ne (Get-Process -Id $standIn.Id -ErrorAction SilentlyContinue)) "a process that did not match the lock was stopped"

        # A matching lock ends it, and repeating it once it is gone is harmless.
        Stop-VerifiedLauncher $goodLock
        $standIn.WaitForExit(5000) | Out-Null
        Assert-True ($null -eq (Get-Process -Id $standIn.Id -ErrorAction SilentlyContinue)) "the recorded launcher was not stopped"
        Stop-VerifiedLauncher $goodLock
    } finally {
        foreach ($id in $launcherPids) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
    }

    # With Pulse down there is no verified lock to go by (stop, uninstall, repair). The sweep
    # must find this install's launcher by its script path, end it and what it started, and
    # leave every other process alone, including another install's launcher.
    $sweepRoot = Join-Path ([IO.Path]::GetTempPath()) ("PulseSweep [" + [guid]::NewGuid().ToString("N").Substring(0, 8) + "] dir")
    $sweepPids = New-Object System.Collections.Generic.List[int]
    $savedStartScript = $script:startScript
    try {
        $fakeScript = '$null = Start-Process -FilePath powershell.exe -ArgumentList ''-NoProfile -Command Start-Sleep -Seconds 60'' -WindowStyle Hidden' + "`r`n" + 'Start-Sleep -Seconds 60'
        $mine = Join-Path $sweepRoot "mine\LIFEOS\PULSE\PulseStart.ps1"
        $other = Join-Path $sweepRoot "other\LIFEOS\PULSE\PulseStart.ps1"
        foreach ($path in $mine, $other) {
            New-Item -ItemType Directory -Path (Split-Path -Parent $path) -Force | Out-Null
            [IO.File]::WriteAllText($path, $fakeScript)
        }
        $script:startScript = $mine
        $ownLauncher = Start-Process -FilePath $psExe -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "' + $mine + '"') -PassThru -WindowStyle Hidden
        $otherLauncher = Start-Process -FilePath $psExe -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "' + $other + '"') -PassThru -WindowStyle Hidden
        $bystander = Start-Process -FilePath $psExe -ArgumentList $sleep -PassThru -WindowStyle Hidden
        foreach ($p in $ownLauncher, $otherLauncher, $bystander) { $sweepPids.Add($p.Id) }
        $ownChild = Wait-ChildProcess $ownLauncher.Id "powershell.exe"
        $otherChild = Wait-ChildProcess $otherLauncher.Id "powershell.exe"
        foreach ($id in $ownChild.ProcessId, $otherChild.ProcessId) { $sweepPids.Add([int]$id) }

        Stop-PulseLaunchers
        $ownLauncher.WaitForExit(5000) | Out-Null
        Assert-True ($null -eq (Get-Process -Id $ownLauncher.Id -ErrorAction SilentlyContinue)) "this install's launcher was not stopped"
        for ($i = 0; $i -lt 50 -and (Get-Process -Id $ownChild.ProcessId -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 100 }
        Assert-True ($null -eq (Get-Process -Id $ownChild.ProcessId -ErrorAction SilentlyContinue)) "what the launcher started was left running"
        Assert-True ($null -ne (Get-Process -Id $otherLauncher.Id -ErrorAction SilentlyContinue)) "another install's launcher was stopped"
        Assert-True ($null -ne (Get-Process -Id $otherChild.ProcessId -ErrorAction SilentlyContinue)) "another install's child process was stopped"
        Assert-True ($null -ne (Get-Process -Id $bystander.Id -ErrorAction SilentlyContinue)) "an unrelated PowerShell process was stopped"
        Stop-PulseLaunchers
    } finally {
        $script:startScript = $savedStartScript
        foreach ($id in $sweepPids) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
        Start-Sleep -Milliseconds 300
        Remove-Item -LiteralPath $sweepRoot -Recurse -Force -ErrorAction SilentlyContinue
    }

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
