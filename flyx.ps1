###############################################################################
# Flyx 2.0 - One-Command Setup (Windows)
#
# Run PowerShell as Administrator:
#   .\flyx.ps1              - Build + start
#   .\flyx.ps1 stop         - Stop
#   .\flyx.ps1 restart      - Restart
#   .\flyx.ps1 logs         - Tail logs
#   .\flyx.ps1 status       - Show status
#   .\flyx.ps1 clean        - Stop + remove data
###############################################################################

param(
    [Parameter(Position=0)]
    [ValidateSet("start", "stop", "restart", "status", "logs", "clean", "")]
    [string]$Command = "start"
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$EnvFile = Join-Path $ScriptDir "docker\.env"
$EnvExample = Join-Path $ScriptDir "docker\.env.example"
$ComposeFile = Join-Path $ScriptDir "docker-compose.yml"

function Write-Log { param([string]$Msg) Write-Host "[flyx] $Msg" -ForegroundColor Green }
function Write-Warn { param([string]$Msg) Write-Host "[flyx] $Msg" -ForegroundColor Yellow }

function Get-LanIP {
    $ip = (Get-NetIPAddress -AddressFamily IPv4 |
        Where-Object {
            $_.InterfaceAlias -notmatch "Loopback|vEthernet|WSL|Docker" -and
            $_.IPAddress -notmatch "^127\." -and
            $_.IPAddress -notmatch "^169\.254\." -and
            $_.PrefixOrigin -ne "WellKnown"
        } |
        Sort-Object -Property InterfaceMetric |
        Select-Object -First 1).IPAddress
    if (-not $ip) { $ip = "127.0.0.1" }
    return $ip
}

function Ensure-EnvFile {
    if (-not (Test-Path $EnvFile)) {
        Write-Log "Creating docker/.env from template..."
        Copy-Item $EnvExample $EnvFile

        Write-Host ""
        Write-Host "  A TMDB API key is REQUIRED for Flyx to work." -ForegroundColor Red
        Write-Host "  Get a free one at: https://www.themoviedb.org/settings/api" -ForegroundColor Yellow
        Write-Host ""
        $tmdbKey = ""
        while (-not $tmdbKey) {
            $tmdbKey = Read-Host "Enter your TMDB API key (v3)"
            if (-not $tmdbKey) {
                Write-Host "  TMDB key cannot be empty. Flyx needs it to fetch movie/show data." -ForegroundColor Red
            }
        }
        $content = Get-Content $EnvFile -Raw
        $content = $content -replace "NEXT_PUBLIC_TMDB_API_KEY=.*", "NEXT_PUBLIC_TMDB_API_KEY=$tmdbKey"
        $content = $content -replace "TMDB_API_KEY=.*", "TMDB_API_KEY=$tmdbKey"
        Set-Content -Path $EnvFile -Value $content -NoNewline

        # Generate random secrets
        $content = Get-Content $EnvFile -Raw
        foreach ($secret in @("JWT_SECRET", "SIGNING_SECRET", "WATERMARK_SECRET", "ADMIN_SECRET")) {
            $rand = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 32 | ForEach-Object { [char]$_ })
            $content = $content -replace "$secret=change-me.*", "$secret=$rand"
        }
        Set-Content -Path $EnvFile -Value $content -NoNewline
        Write-Log "Generated random security secrets."
    }
}

function Set-HostsEntry {
    param([string]$IP)
    $HostsFile = "$env:SystemRoot\System32\drivers\etc\hosts"
    $Marker = "# flyx-self-hosted"
    $Entry = "$IP  flyx.local $Marker"

    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        Write-Warn "Not admin - cannot update hosts file. Add manually:"
        Write-Host "  $Entry" -ForegroundColor Cyan
        return
    }

    $content = Get-Content $HostsFile -ErrorAction SilentlyContinue
    if ($content -match [regex]::Escape($Marker)) {
        $content = $content -replace ".*$([regex]::Escape($Marker)).*", $Entry
        Set-Content -Path $HostsFile -Value $content -Force
    } else {
        Add-Content -Path $HostsFile -Value "`n$Entry" -Force
    }
    ipconfig /flushdns | Out-Null
    Write-Log "Added flyx.local -> $IP to hosts file"
}

function Start-Flyx {
    Ensure-EnvFile
    $ip = Get-LanIP

    Set-HostsEntry -IP $ip

    Write-Log "Building and starting Flyx..."
    # --env-file makes Compose read docker/.env for build-arg interpolation
    # (${NEXT_PUBLIC_*}); without it those values never reach the client bundle.
    docker compose --env-file $EnvFile -f $ComposeFile up -d --build

    Write-Log "Waiting for startup..."
    $retries = 0
    while ($retries -lt 30) {
        try {
            $null = Invoke-WebRequest -Uri "http://localhost:3000/" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
            break
        } catch { Start-Sleep -Seconds 3; $retries++ }
    }

    Write-Host ""
    Write-Host "================================================" -ForegroundColor Cyan
    Write-Host "  Flyx is running!" -ForegroundColor Green
    Write-Host ""
    Write-Host "  http://flyx.local    " -ForegroundColor Green -NoNewline
    Write-Host "(via hosts file)"
    Write-Host "  http://localhost     (direct on this machine)"
    Write-Host "  http://$ip     (LAN access from other devices)"
    Write-Host "================================================" -ForegroundColor Cyan
    Write-Host ""
}

switch ($Command) {
    "start"   { Start-Flyx }
    "stop"    { docker compose -f $ComposeFile down }
    "restart" { docker compose -f $ComposeFile down; Start-Flyx }
    "status"  { docker compose -f $ComposeFile ps }
    "logs"    { docker compose -f $ComposeFile logs -f }
    "clean"   { docker compose -f $ComposeFile down -v }
    ""        { Start-Flyx }
}
