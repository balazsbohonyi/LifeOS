# LifeOS Pulse — foreground Windows Task Scheduler entry point.

param(
    [string]$ConfigRoot,
    [string]$ConfigPath,
    [string]$BunPath,
    [int]$RestartDelaySeconds = 60,
    [int]$RestartCount = 3
)

$ErrorActionPreference = "Stop"
$pulseDir = $PSScriptRoot
$lifeosDir = Split-Path -Parent $pulseDir
if (-not $ConfigRoot) { $ConfigRoot = Split-Path -Parent $lifeosDir }
if (-not $ConfigPath) {
    $ConfigPath = if ($env:LIFEOS_CONFIG_PATH) { $env:LIFEOS_CONFIG_PATH } else { Join-Path $lifeosDir "USER\CONFIG\LIFEOS_CONFIG.toml" }
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
    throw "Bun was not found. Install Bun or pass -BunPath to manage.ps1."
}

$bun = Resolve-BunPath $BunPath
$env:HOME = $env:USERPROFILE
$env:CLAUDE_CONFIG_DIR = $ConfigRoot
$env:LIFEOS_DIR = $lifeosDir
$env:LIFEOS_CONFIG_PATH = $ConfigPath
$env:PULSE_DIR = $pulseDir
$env:LIFEOS_BUN_PATH = $bun
$launcher = Get-CimInstance Win32_Process -Filter "ProcessId = $PID"
$launcherStartedAt = if ($launcher.CreationDate -is [DateTime]) {
    $launcher.CreationDate.ToUniversalTime().ToString("o")
} else {
    [Management.ManagementDateTimeConverter]::ToDateTime([string]$launcher.CreationDate).ToUniversalTime().ToString("o")
}
$env:PULSE_LAUNCHER_PID = [string]$PID
$env:PULSE_LAUNCHER_EXECUTABLE_PATH = [string]$launcher.ExecutablePath
$env:PULSE_LAUNCHER_SCRIPT_PATH = $PSCommandPath
$env:PULSE_LAUNCHER_STARTED_AT = $launcherStartedAt

$pathParts = New-Object System.Collections.Generic.List[string]
$pathParts.Add((Split-Path -Parent $bun))
try {
    $ffplay = (Get-Command ffplay.exe -ErrorAction Stop).Source
    $env:LIFEOS_FFPLAY_PATH = $ffplay
    $pathParts.Add((Split-Path -Parent $ffplay))
} catch { }
$pathParts.Add($env:PATH)
$env:PATH = ($pathParts | Where-Object { $_ } | Select-Object -Unique) -join ";"

$logDir = Join-Path $pulseDir "logs"
[IO.Directory]::CreateDirectory($logDir) | Out-Null
$stdoutLog = Join-Path $logDir "pulse-windows.log"
$stderrLog = Join-Path $logDir "pulse-windows-error.log"

Push-Location -LiteralPath $pulseDir
try {
    # Stay in the foreground so Task Scheduler owns the actual lifetime. Use
    # literal FileStreams: PowerShell redirection treats [] in valid paths as
    # wildcard syntax and can otherwise fail before Bun starts.
    $exitCode = 1
    for ($attempt = 0; $attempt -le $RestartCount; $attempt++) {
        $pulseScript = Join-Path $pulseDir "pulse.ts"
        $startInfo = New-Object Diagnostics.ProcessStartInfo
        $startInfo.FileName = $bun
        $startInfo.Arguments = "run `"$pulseScript`""
        $startInfo.WorkingDirectory = $pulseDir
        $startInfo.UseShellExecute = $false
        $startInfo.CreateNoWindow = $true
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError = $true
        $process = New-Object Diagnostics.Process
        $process.StartInfo = $startInfo
        $stdoutStream = [IO.File]::Open($stdoutLog, [IO.FileMode]::Append, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)
        $stderrStream = [IO.File]::Open($stderrLog, [IO.FileMode]::Append, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)
        try {
            [void]$process.Start()
            $stdoutCopy = $process.StandardOutput.BaseStream.CopyToAsync($stdoutStream)
            $stderrCopy = $process.StandardError.BaseStream.CopyToAsync($stderrStream)
            $process.WaitForExit()
            [Threading.Tasks.Task]::WaitAll(@($stdoutCopy, $stderrCopy))
            $exitCode = $process.ExitCode
        } finally {
            $stdoutStream.Dispose()
            $stderrStream.Dispose()
            $process.Dispose()
        }
        if ($exitCode -eq 0) { break }
        if ($attempt -lt $RestartCount) {
            "$(Get-Date -Format o) Pulse exited $exitCode; restarting in $RestartDelaySeconds seconds (attempt $($attempt + 1)/$RestartCount)" | Add-Content -LiteralPath $stderrLog
            Start-Sleep -Seconds $RestartDelaySeconds
        }
    }
    exit $exitCode
} catch {
    $_ | Out-String | Add-Content -LiteralPath $stderrLog
    throw
} finally {
    Pop-Location
}
