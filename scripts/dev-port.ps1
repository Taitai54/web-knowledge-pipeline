param(
    [int]$Port = 3010,
    [switch]$StopStuck
)

$ErrorActionPreference = "SilentlyContinue"

if ($StopStuck) {
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
        Where-Object { $_.CommandLine -match "web-knowledge-pipeline" -and $_.CommandLine -match "next" } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
    exit 0
}

$listening = Get-NetTCPConnection -LocalPort $Port -State Listen | Select-Object -First 1
if (-not $listening) {
    Write-Output "FREE"
    exit 0
}

try {
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port" -TimeoutSec 5 -UseBasicParsing
    if ($response.StatusCode -lt 500) {
        Write-Output "READY"
        exit 0
    }
} catch {
    # The port is taken and the app did not answer.
}

Write-Output "STUCK"
exit 0
