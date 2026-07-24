[CmdletBinding()]
param(
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$gatewayDirectory = Join-Path $repositoryRoot 'agent-gateway'
$gatewayEntry = Join-Path $gatewayDirectory 'dist\server\server\main.js'
$gatewayPidPath = Join-Path $gatewayDirectory 'data\gateway.pid'
$port = 8080

function Enable-UserProxyForNode {
    if (-not [string]::IsNullOrWhiteSpace($env:HTTPS_PROXY) -or -not [string]::IsNullOrWhiteSpace($env:HTTP_PROXY)) {
        if ([string]::IsNullOrWhiteSpace($env:NODE_USE_ENV_PROXY)) {
            $env:NODE_USE_ENV_PROXY = '1'
        }
        return
    }

    try {
        $settings = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction Stop
        if ($settings.ProxyEnable -ne 1 -or [string]::IsNullOrWhiteSpace([string]$settings.ProxyServer)) {
            return
        }
        $proxy = [string]$settings.ProxyServer
        if ($proxy -match '(?i)(?:^|;)https=([^;]+)') {
            $proxy = $Matches[1]
        } elseif ($proxy -match '(?i)(?:^|;)http=([^;]+)') {
            $proxy = $Matches[1]
        }
        $proxy = $proxy.Trim()
        if ([string]::IsNullOrWhiteSpace($proxy)) {
            return
        }
        if ($proxy -notmatch '^[a-z][a-z0-9+.-]*://') {
            $proxy = "http://$proxy"
        }
        $env:HTTPS_PROXY = $proxy
        $env:HTTP_PROXY = $proxy
        if ([string]::IsNullOrWhiteSpace($env:NODE_USE_ENV_PROXY)) {
            $env:NODE_USE_ENV_PROXY = '1'
        }
        Write-Host 'Using the configured Windows user proxy for the Node Gateway.'
    } catch {
        Write-Warning 'Windows user proxy settings could not be read; Gateway networking will use its existing environment.'
    }
}

if (-not (Test-Path -LiteralPath (Join-Path $gatewayDirectory 'package.json'))) {
    throw "Agent Gateway was not found at $gatewayDirectory"
}

Enable-UserProxyForNode

$legacyProcesses = Get-CimInstance Win32_Process -Filter "Name = 'FAtiMA-Server.exe'"
foreach ($legacyProcess in $legacyProcesses) {
    Write-Host "Stopping retired FAtiMA server (PID $($legacyProcess.ProcessId))."
    Stop-Process -Id $legacyProcess.ProcessId -Force
}

foreach ($legacyProcess in $legacyProcesses) {
    Wait-Process -Id $legacyProcess.ProcessId -Timeout 10 -ErrorAction SilentlyContinue
}

$listeners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
$knownGatewayPid = if (Test-Path -LiteralPath $gatewayPidPath) { (Get-Content -LiteralPath $gatewayPidPath -Raw).Trim() } else { '' }
foreach ($listener in $listeners) {
    $owner = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)"
    $isGateway = $owner -ne $null -and $owner.Name -match '^node(\.exe)?$' -and $owner.CommandLine -match 'dist[\\/]+server[\\/]+server[\\/]+main\.js' -and $knownGatewayPid -eq [string]$listener.OwningProcess
    if (-not $isGateway -and $owner -ne $null -and $owner.Name -match '^node(\.exe)?$' -and $knownGatewayPid -eq [string]$listener.OwningProcess) {
        # Some Windows process providers omit CommandLine. Confirm the loopback Gateway
        # health contract before allowing a recorded Node PID to be restarted.
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 1
            $isGateway = $health.ok -eq $true -and $health.model -is [string] -and $health.PSObject.Properties.Name -contains 'realtimeConfigured'
        } catch {
            $isGateway = $false
        }
    }
    if (-not $isGateway) {
        throw "Port $port is occupied by PID $($listener.OwningProcess). The launcher refuses to stop unknown processes."
    }
    Write-Host "Restarting existing DST GPT Agent Gateway (PID $($listener.OwningProcess))."
    Stop-Process -Id $listener.OwningProcess -Force
    Wait-Process -Id $listener.OwningProcess -Timeout 10 -ErrorAction SilentlyContinue
}

$remainingListeners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
if ($remainingListeners.Count -gt 0) {
    $ownerIds = ($remainingListeners | Select-Object -ExpandProperty OwningProcess -Unique) -join ', '
    throw "Port $port is still occupied by PID(s): $ownerIds after the Gateway restart attempt."
}

Push-Location -LiteralPath $gatewayDirectory
try {
    if (-not $SkipBuild) {
        npm run build
    }

    if (-not (Test-Path -LiteralPath $gatewayEntry)) {
        throw "Gateway build output is missing: $gatewayEntry"
    }

    $nodePath = (Get-Command node -ErrorAction Stop).Source
    $dataDirectory = Join-Path $gatewayDirectory 'data'
    New-Item -ItemType Directory -Path $dataDirectory -Force | Out-Null
    $stdoutPath = Join-Path $dataDirectory 'gateway.stdout.log'
    $stderrPath = Join-Path $dataDirectory 'gateway.stderr.log'

    $process = Start-Process -FilePath $nodePath -ArgumentList 'dist/server/server/main.js' -WorkingDirectory $gatewayDirectory -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru
    $healthy = $false
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        Start-Sleep -Milliseconds 250
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 1
            if ($health.ok -eq $true) {
                $healthy = $true
                break
            }
        } catch {
            # Node may still be binding the port.
        }
    }

    if (-not $healthy) {
        if (-not $process.HasExited) {
            Stop-Process -Id $process.Id -Force
        }
        $errorText = if (Test-Path -LiteralPath $stderrPath) { Get-Content -LiteralPath $stderrPath -Raw } else { '' }
        throw "Gateway failed its local health check. $errorText"
    }

    Set-Content -LiteralPath $gatewayPidPath -Value $process.Id -NoNewline
    Write-Host "DST GPT Agent Gateway is running at http://127.0.0.1:$port (PID $($process.Id))."
    Write-Host "Open that address in a browser, then host or restart a local DST world."
} finally {
    Pop-Location
}
