param(
    [string]$AppRoot = "",
    [int]$BackendPort = 8000,
    [int]$FrontendPort = 5173,
    [string]$DataVersion = "v3_final",
    [switch]$NoOpen,
    [switch]$Install,
    [switch]$Reinstall
)

$ErrorActionPreference = "Stop"

function Write-Step {
    param([string]$Message)
    Write-Host "[start-web] $Message" -ForegroundColor Cyan
}

function Test-PortOpen {
    param([int]$Port)

    $client = New-Object Net.Sockets.TcpClient
    try {
        $async = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
        if (-not $async.AsyncWaitHandle.WaitOne(250, $false)) {
            return $false
        }
        $client.EndConnect($async)
        return $true
    }
    catch {
        return $false
    }
    finally {
        $client.Close()
    }
}

function Wait-HttpOk {
    param(
        [string]$Url,
        [int]$Seconds = 35
    )

    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 2
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) {
                return $true
            }
        }
        catch {
            Start-Sleep -Milliseconds 700
        }
    }
    return $false
}

function Find-FreePort {
    param([int]$StartPort)

    for ($port = $StartPort; $port -lt ($StartPort + 100); $port++) {
        if (-not (Test-PortOpen $port)) {
            return $port
        }
    }

    throw "No free port found from $StartPort to $($StartPort + 99)."
}

function Test-AppRoot {
    param([string]$Path)

    if (-not $Path) {
        return $false
    }

    $resolved = Resolve-Path -LiteralPath $Path -ErrorAction SilentlyContinue
    if (-not $resolved) {
        return $false
    }

    $root = $resolved.Path
    $hasFrontend = Test-Path -LiteralPath (Join-Path $root "frontend\dist\index.html")
    $hasBackend = Test-Path -LiteralPath (Join-Path $root "backend\main.py")
    $hasData = Test-Path -LiteralPath (Join-Path $root "data\derived\$DataVersion")

    return ($hasFrontend -and $hasBackend -and $hasData)
}

function Find-AppRoot {
    param([string]$RepoRoot)

    $candidates = @(
        $RepoRoot,
        (Join-Path $RepoRoot "xiyun-vis-run-package"),
        (Join-Path $RepoRoot "temp_result\xiyun-vis-run-package")
    )

    foreach ($candidate in $candidates) {
        if (Test-AppRoot $candidate) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }

    throw "Cannot find app root. Please fully unzip the package and keep frontend, backend, and data folders together."
}

function Get-SystemPythonCommand {
    $candidates = @(
        @{ Exe = "py"; Args = @("-3.14") },
        @{ Exe = "python"; Args = @() }
    )

    foreach ($candidate in $candidates) {
        $cmd = Get-Command $candidate.Exe -ErrorAction SilentlyContinue
        if (-not $cmd) {
            continue
        }

        try {
            $versionText = & $candidate.Exe @($candidate.Args) --version 2>$null
            if ($LASTEXITCODE -eq 0 -and $versionText -match "Python 3\.14") {
                return $candidate
            }
        }
        catch {
        }
    }

    throw "Python 3.14 was not found. Please install 64-bit Python 3.14 for the bundled offline wheels."
}

function Invoke-Python {
    param(
        [hashtable]$PythonCommand,
        [string[]]$Arguments,
        [string]$WorkingDirectory = ""
    )

    if ($WorkingDirectory) {
        Push-Location $WorkingDirectory
        try {
            & $PythonCommand.Exe @($PythonCommand.Args) @Arguments
        }
        finally {
            Pop-Location
        }
    }
    else {
        & $PythonCommand.Exe @($PythonCommand.Args) @Arguments
    }
}

function Test-PythonModule {
    param(
        [hashtable]$PythonCommand,
        [string]$ModuleName
    )

    try {
        Invoke-Python $PythonCommand @("-c", "import importlib.util, sys; sys.exit(0 if importlib.util.find_spec('$ModuleName') else 1)") *> $null
        return $LASTEXITCODE -eq 0
    }
    catch {
        return $false
    }
}

function New-PythonCommandFromExe {
    param([string]$ExePath)
    return @{ Exe = $ExePath; Args = @() }
}

$repoRoot = $PSScriptRoot
if (-not $repoRoot) {
    $repoRoot = (Get-Location).Path
}

if ($AppRoot) {
    if (-not (Test-AppRoot $AppRoot)) {
        throw "The specified AppRoot is incomplete. It must contain frontend\dist, backend\main.py, and data\derived\$DataVersion."
    }
    $resolvedAppRoot = (Resolve-Path -LiteralPath $AppRoot).Path
}
else {
    $resolvedAppRoot = Find-AppRoot $repoRoot
}

$backendDir = Join-Path $resolvedAppRoot "backend"
$frontendDistDir = Join-Path $resolvedAppRoot "frontend\dist"
$venvDir = Join-Path $backendDir ".venv"
$venvPythonPath = Join-Path $venvDir "Scripts\python.exe"
$wheelsDir = Join-Path $backendDir "wheels"
$backendHealthUrl = "http://127.0.0.1:$BackendPort/health"

Write-Step "App root: $resolvedAppRoot"

$systemPython = Get-SystemPythonCommand
$systemPythonText = $systemPython.Exe + " " + (($systemPython.Args -join " ").Trim())
Write-Step "System Python: $systemPythonText"

if ($Reinstall -and (Test-Path -LiteralPath $venvDir)) {
    Write-Step "Removing old backend virtual environment"
    Remove-Item -LiteralPath $venvDir -Recurse -Force
}

if (-not (Test-Path -LiteralPath $venvPythonPath)) {
    Write-Step "Creating backend virtual environment"
    Invoke-Python $systemPython @("-m", "venv", $venvDir)
}

$venvPython = New-PythonCommandFromExe $venvPythonPath
$needInstall = $Install -or -not (Test-PythonModule $venvPython "uvicorn")

if ($needInstall) {
    Write-Step "Installing backend dependencies"
    if (Test-Path -LiteralPath $wheelsDir) {
        Invoke-Python $venvPython @("-m", "pip", "install", "--no-index", "--find-links", $wheelsDir, "-r", (Join-Path $backendDir "requirements.txt"))
    }
    else {
        Invoke-Python $venvPython @("-m", "pip", "install", "-r", (Join-Path $backendDir "requirements.txt"))
    }
}

if (-not (Test-PythonModule $venvPython "uvicorn")) {
    throw "Backend dependency check failed: uvicorn is missing."
}

if (Test-PortOpen $BackendPort) {
    Write-Step "Backend port $BackendPort is already in use. Reusing existing backend."
}
else {
    Write-Step "Starting backend: http://127.0.0.1:$BackendPort"
    Start-Process -FilePath "powershell" -WorkingDirectory $backendDir -WindowStyle Hidden -ArgumentList @(
        "-NoExit",
        "-ExecutionPolicy", "Bypass",
        "-Command",
        "`$env:DATA_VERSION='$DataVersion'; & '$venvPythonPath' -m uvicorn main:app --host 127.0.0.1 --port $BackendPort"
    )
}

if (Wait-HttpOk $backendHealthUrl 45) {
    Write-Step "Backend health check passed: $backendHealthUrl"
}
else {
    throw "Backend failed to start. Check the backend PowerShell window for details."
}

$requestedFrontendPort = $FrontendPort
$FrontendPort = Find-FreePort $FrontendPort
$frontendUrl = "http://127.0.0.1:$FrontendPort"

if ($FrontendPort -ne $requestedFrontendPort) {
    Write-Warning "Frontend port $requestedFrontendPort is busy. Using $FrontendPort instead."
}

Write-Step "Starting frontend static site: $frontendUrl"
Start-Process -FilePath "powershell" -WorkingDirectory $frontendDistDir -WindowStyle Hidden -ArgumentList @(
    "-NoExit",
    "-ExecutionPolicy", "Bypass",
    "-Command",
    "& '$venvPythonPath' -m http.server $FrontendPort --bind 127.0.0.1"
)

if (Wait-HttpOk $frontendUrl 35) {
    Write-Step "Frontend is ready: $frontendUrl"
}
else {
    throw "Frontend failed to start. Please confirm frontend\dist\index.html exists."
}

if (-not $NoOpen) {
    Start-Process $frontendUrl
}

Write-Host ""
Write-Host "Website: $frontendUrl" -ForegroundColor Green
Write-Host "Backend docs: http://127.0.0.1:$BackendPort/docs" -ForegroundColor Green
Write-Host "Stop: close the PowerShell windows started by this script, or end the related python processes." -ForegroundColor DarkGray
