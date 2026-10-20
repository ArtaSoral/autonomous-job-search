param(
  [ValidateSet('start', 'stop')][string]$Action = 'start',
  [switch]$NoBrowser
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$runScript = Join-Path $PSScriptRoot 'run.ps1'
$runtimeDirectory = Join-Path $projectRoot 'data/launcher'
$statePath = Join-Path $runtimeDirectory 'processes.json'
$url = 'http://127.0.0.1:3000'

# Match both the launch time and command before stopping a saved process ID.
# This also makes old state harmless after a computer restart.
function Get-OwnedProcess($Entry) {
  if (-not $Entry) { return $null }
  try {
    $process = Get-Process -Id $Entry.id -ErrorAction SilentlyContinue
    if (-not $process) { return $null }
    # Windows can reuse a saved PID for a service whose StartTime is unavailable.
    $started = $process.StartTime
    if (-not $started -or $started.ToUniversalTime().Ticks.ToString() -ne $Entry.started) { return $null }
    $command = (Get-CimInstance Win32_Process -Filter "ProcessId = $($Entry.id)" -ErrorAction Stop).CommandLine
  } catch {
    # Inaccessible or exited processes cannot be verified as ours.
    return $null
  }
  if (-not $command -or -not $command.Contains($runScript)) { return $null }
  return $process
}

function Stop-OwnedProcess($Entry) {
  if (Get-OwnedProcess $Entry) {
    & taskkill.exe /PID $Entry.id /T /F | Out-Null
    if ($LASTEXITCODE -ne 0 -and (Get-OwnedProcess $Entry)) { throw 'Could not stop a Job Finder process. Try Stop again.' }
  }
}

function Start-Task([string]$Task, [string]$Name) {
  $process = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') `
    -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $runScript + '"'), $Task) `
    -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $runtimeDirectory "$Name.log") `
    -RedirectStandardError (Join-Path $runtimeDirectory "$Name.error.log")
  return @{ id = $process.Id; started = $process.StartTime.ToUniversalTime().Ticks.ToString() }
}

function Save-State {
  $state | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8
}

# Serialize double-clicks so they cannot create duplicate workers.
$hasher = [System.Security.Cryptography.SHA256]::Create()
$key = [BitConverter]::ToString($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($projectRoot.ToLowerInvariant()))).Replace('-', '')
$hasher.Dispose()
$mutex = New-Object System.Threading.Mutex($false, "Local\JobFinder-$key")
$locked = $false
try {
  try { $locked = $mutex.WaitOne(60000) } catch [System.Threading.AbandonedMutexException] { $locked = $true }
  if (-not $locked) { throw 'Job Finder is already starting or stopping. Try again shortly.' }
  New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null
  $state = @{ app = $null; worker = $null }
  if (Test-Path -LiteralPath $statePath) {
    $saved = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    $state.app = $saved.app
    $state.worker = $saved.worker
  }

  if ($Action -eq 'stop') {
    Stop-OwnedProcess $state.worker
    Stop-OwnedProcess $state.app
    Remove-Item -LiteralPath $statePath -ErrorAction SilentlyContinue
    Write-Host 'Job Finder stopped.'
  } else {
    $newApp = $false
    $newWorker = $false
    try {
      if (-not (Get-OwnedProcess $state.app)) {
        $listener = Get-NetTCPConnection -State Listen -LocalPort 3000 -ErrorAction SilentlyContinue
        if ($listener) { throw 'Port 3000 is already in use. Stop the app in its existing terminal, then run Start Job Finder again.' }
        $task = if (Test-Path -LiteralPath (Join-Path $projectRoot '.next/BUILD_ID')) { 'start' } else { 'dev' }
        $state.app = Start-Task $task 'app'
        $newApp = $true
        Save-State
      }

      Write-Host 'Starting Job Finder...'
      $deadline = (Get-Date).AddSeconds(60)
      $ready = $false
      do {
        if (-not (Get-OwnedProcess $state.app)) { throw "The app exited. See $runtimeDirectory\app.error.log" }
        try {
          $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3
          $ready = $response.StatusCode -eq 200
        } catch { $ready = $false }
        if (-not $ready) { Start-Sleep -Milliseconds 500 }
      } until ($ready -or (Get-Date) -ge $deadline)
      if (-not $ready) { throw "The app did not become ready. See logs in $runtimeDirectory" }

      if (-not (Get-OwnedProcess $state.worker)) {
        $state.worker = Start-Task 'worker' 'worker'
        $newWorker = $true
        Save-State
      }
      $deadline = (Get-Date).AddSeconds(30)
      do {
        if (-not (Get-OwnedProcess $state.worker)) { throw "The worker exited. See $runtimeDirectory\worker.error.log" }
        $ready = [bool](Select-String -LiteralPath (Join-Path $runtimeDirectory 'worker.log') -Pattern 'Worker ready\.' -Quiet -ErrorAction SilentlyContinue)
        if (-not $ready) { Start-Sleep -Milliseconds 500 }
      } until ($ready -or (Get-Date) -ge $deadline)
      if (-not $ready) { throw "The worker did not become ready. See logs in $runtimeDirectory" }

      if (-not $NoBrowser) { Start-Process $url }
      Write-Host "Job Finder is running at $url. Use Stop Job Finder to stop it."
    } catch {
      if ($newWorker) { Stop-OwnedProcess $state.worker; $state.worker = $null }
      if ($newApp) { Stop-OwnedProcess $state.app; $state.app = $null }
      Save-State
      throw
    }
  }
} catch {
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
} finally {
  if ($locked) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
}
