# LifeOS Pulse — foreground Windows Task Scheduler entry point.

param(
    [string]$ConfigRoot,
    [string]$BunPath,
    [int]$RestartDelaySeconds = 60,
    [int]$RestartCount = 3
)

$ErrorActionPreference = "Stop"
$pulseDir = $PSScriptRoot
$lifeosDir = Split-Path -Parent $pulseDir
if (-not $ConfigRoot) { $ConfigRoot = Split-Path -Parent $lifeosDir }

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
$env:LIFEOS_CONFIG_PATH = Join-Path $lifeosDir "USER\CONFIG\LIFEOS_CONFIG.toml"
$env:PULSE_DIR = $pulseDir
$env:LIFEOS_BUN_PATH = $bun

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
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$stdoutLog = Join-Path $logDir "pulse-windows.log"
$stderrLog = Join-Path $logDir "pulse-windows-error.log"

Push-Location $pulseDir
try {
    # Stay in the foreground so Task Scheduler owns the actual lifetime.
    # Windows PowerShell 5 promotes native stderr to an ErrorRecord when `*>>`
    # is used under Stop-on-error, terminating an otherwise healthy daemon.
    # Keep streams separate and preserve Bun's real exit code.
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $exitCode = 1
    for ($attempt = 0; $attempt -le $RestartCount; $attempt++) {
        & $bun run pulse.ts 1>> $stdoutLog 2>> $stderrLog
        $exitCode = $LASTEXITCODE
        if ($exitCode -eq 0) { break }
        if ($attempt -lt $RestartCount) {
            "$(Get-Date -Format o) Pulse exited $exitCode; restarting in $RestartDelaySeconds seconds (attempt $($attempt + 1)/$RestartCount)" | Add-Content -LiteralPath $stderrLog
            Start-Sleep -Seconds $RestartDelaySeconds
        }
    }
    $ErrorActionPreference = $previousPreference
    exit $exitCode
} catch {
    $_ | Out-String | Add-Content -LiteralPath $stderrLog
    throw
} finally {
    Pop-Location
}
