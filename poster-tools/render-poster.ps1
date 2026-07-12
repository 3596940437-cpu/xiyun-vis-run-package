param(
    [int]$Dpi = 300
)

$ErrorActionPreference = "Stop"

$root = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")
$posterDir = Join-Path $root "output\poster"
$htmlPath = Join-Path $posterDir "A0_戏韵千秋海报.html"
$pngPath = Join-Path $posterDir "A0_戏韵千秋海报_${Dpi}dpi.png"
$pdfPath = Join-Path $posterDir "A0_戏韵千秋海报.pdf"

function Find-Chrome {
    $candidates = @(
        "C:\Program Files\Google\Chrome\Application\chrome.exe",
        "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        "C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
    )

    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) {
            return $candidate
        }
    }

    throw "Chrome or Edge was not found."
}

function Invoke-Chrome {
    param(
        [string]$Chrome,
        [string[]]$Arguments,
        [string]$ExpectedPath = ""
    )

    & $Chrome @Arguments
    if ($LASTEXITCODE -ne 0 -and (-not $ExpectedPath -or -not (Test-Path -LiteralPath $ExpectedPath))) {
        throw "Chrome exited with code $LASTEXITCODE."
    }
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "Chrome exited with code $LASTEXITCODE, but the expected output was created."
    }
}

function Find-Python {
    $bundledPython = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
    if (Test-Path -LiteralPath $bundledPython) {
        return $bundledPython
    }

    $pythonCommand = Get-Command python -ErrorAction SilentlyContinue
    if ($pythonCommand) {
        return $pythonCommand.Source
    }

    throw "Python was not found."
}

function Find-Node {
    $bundledNode = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
    if (Test-Path -LiteralPath $bundledNode) {
        return $bundledNode
    }

    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeCommand) {
        return $nodeCommand.Source
    }

    throw "Node.js was not found."
}

function Find-Pdftoppm {
    $bundledPdftoppm = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\native\poppler\Library\bin\pdftoppm.exe"
    if (Test-Path -LiteralPath $bundledPdftoppm) {
        return $bundledPdftoppm
    }

    $pdftoppmCommand = Get-Command pdftoppm.exe -ErrorAction SilentlyContinue
    if ($pdftoppmCommand) {
        return $pdftoppmCommand.Source
    }

    throw "pdftoppm was not found."
}

function Set-PngDensity {
    param(
        [string]$Path,
        [int]$Density,
        [int]$TargetWidth = 0,
        [int]$TargetHeight = 0
    )

    $python = Find-Python
    $tempPath = "$Path.tmp.png"
    $script = @"
import sys
from PIL import Image
Image.MAX_IMAGE_PIXELS = None
input_path, output_path, density = sys.argv[1], sys.argv[2], int(sys.argv[3])
target_width, target_height = int(sys.argv[4]), int(sys.argv[5])
with Image.open(input_path) as img:
    if target_width and target_height and img.size != (target_width, target_height):
        base = Image.new(img.mode, (target_width, target_height), img.getpixel((0, 0)))
        crop = img.crop((0, 0, min(img.width, target_width), min(img.height, target_height)))
        base.paste(crop, (0, 0))
        img = base
    img.save(output_path, format="PNG", dpi=(density, density), compress_level=6)
with Image.open(output_path) as check:
    print({"width": check.width, "height": check.height, "dpi": check.info.get("dpi")})
"@
    $script | & $python - $Path $tempPath $Density $TargetWidth $TargetHeight
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to set PNG density metadata."
    }
    Move-Item -LiteralPath $tempPath -Destination $Path -Force
}

function Test-PngSignature {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        return $false
    }
    if ((Get-Item -LiteralPath $Path).Length -lt 1024KB) {
        return $false
    }
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    return ($bytes.Length -gt 24 -and $bytes[0] -eq 137 -and $bytes[1] -eq 80 -and $bytes[2] -eq 78 -and $bytes[3] -eq 71)
}

function Wait-FileStable {
    param(
        [string]$Path,
        [int]$TimeoutSeconds = 20
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $previous = -1
    while ((Get-Date) -lt $deadline) {
        if (Test-Path -LiteralPath $Path) {
            $current = (Get-Item -LiteralPath $Path).Length
            Start-Sleep -Milliseconds 650
            $next = (Get-Item -LiteralPath $Path).Length
            if ($current -eq $next -and $current -eq $previous) {
                return
            }
            $previous = $next
        }
        else {
            Start-Sleep -Milliseconds 650
        }
    }
}

function Convert-PdfToPng {
    param(
        [string]$PdfPath,
        [string]$PngPath,
        [int]$Density
    )

    $pdftoppm = Find-Pdftoppm
    $tempDir = Join-Path $root "tmp\poster-render"
    New-Item -ItemType Directory -Force -Path $tempDir | Out-Null

    $asciiPdfPath = Join-Path $tempDir "poster.pdf"
    $outputPrefix = Join-Path $tempDir "poster_${Density}dpi"
    $tempPngPath = "$outputPrefix.png"

    Copy-Item -LiteralPath $PdfPath -Destination $asciiPdfPath -Force
    if (Test-Path -LiteralPath $tempPngPath) {
        Remove-Item -LiteralPath $tempPngPath -Force
    }

    & $pdftoppm -png -singlefile -r $Density $asciiPdfPath $outputPrefix
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $tempPngPath)) {
        throw "Failed to rasterize PDF to PNG."
    }

    if (Test-Path -LiteralPath $PngPath) {
        Remove-Item -LiteralPath $PngPath -Force
    }
    Move-Item -LiteralPath $tempPngPath -Destination $PngPath -Force
}

Push-Location $root
try {
    node .\poster-tools\generate-poster.js | Out-Host
}
finally {
    Pop-Location
}

$width = [math]::Round(841 / 25.4 * $Dpi)
$height = [math]::Round(1189 / 25.4 * $Dpi)

Write-Host "[poster] Rendering PDF with Playwright"
$node = Find-Node
$renderScript = Join-Path $PSScriptRoot "render-poster-playwright.js"
& $node $renderScript
if ($LASTEXITCODE -ne 0) {
    throw "Playwright render failed."
}

Wait-FileStable $pdfPath

if (-not (Test-Path -LiteralPath $pdfPath) -or (Get-Item -LiteralPath $pdfPath).Length -lt 1024KB) {
    throw "PDF render failed or was too small."
}

Write-Host "[poster] Rasterizing PDF to PNG at ${width}x${height}"
try {
    Convert-PdfToPng $pdfPath $pngPath $Dpi
}
catch {
    if ($Dpi -gt 150) {
        Write-Warning "300dpi PNG rasterization failed. Retrying at 150dpi."
        & $PSCommandPath -Dpi 150
        return
    }
    throw
}

Wait-FileStable $pngPath

if (-not (Test-PngSignature $pngPath)) {
    if ($Dpi -gt 150) {
        Write-Warning "300dpi PNG render failed or was too small. Retrying at 150dpi."
        & $PSCommandPath -Dpi 150
        return
    }
    throw "PNG render failed."
}
Set-PngDensity $pngPath $Dpi $width $height

Write-Host "[poster] PNG: $pngPath"
Write-Host "[poster] PDF: $pdfPath"
exit 0
