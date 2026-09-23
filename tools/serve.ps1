<#
.SYNOPSIS
    Serve ArchToolKit's prebuilt pages with nothing but Windows PowerShell.

.DESCRIPTION
    For a machine with no Node: a locked-down work PC, a jump box, an
    air-gapped network. The built JavaScript is committed in web/lib, so a
    copy of the repository downloaded as a ZIP already has everything the
    pages need. All that is missing is something to serve them, because
    browsers refuse to load ES modules from file://.

    This is that something. It listens on localhost only, serves files from
    web/ and nothing outside it, and needs no administrator rights and no
    installation. Windows PowerShell 5.1 and PowerShell 7 both run it.

    It does not build. Whatever is in web/lib is what you get, which is why
    the repository keeps web/lib committed and current.

.PARAMETER Port
    The first port to try. The next eleven are tried if it is taken.

.PARAMETER NoOpen
    Do not open a browser.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\serve.ps1
#>
[CmdletBinding()]
param(
    [int]$Port = 8080,
    [switch]$NoOpen
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$web = [System.IO.Path]::GetFullPath((Join-Path $root 'web'))
# With the separator, so a sibling such as web-old cannot pass the prefix check.
$webPrefix = $web.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar

if (-not (Test-Path (Join-Path $web 'lib'))) {
    Write-Host ''
    Write-Host '  ERROR: web\lib is missing, so there is nothing built to serve.' -ForegroundColor Red
    Write-Host '  This copy was not downloaded whole, or was built somewhere and not committed.'
    Write-Host ''
    exit 1
}

$mime = @{
    '.html' = 'text/html; charset=utf-8'
    '.js' = 'text/javascript; charset=utf-8'
    '.mjs' = 'text/javascript; charset=utf-8'
    '.css' = 'text/css; charset=utf-8'
    '.json' = 'application/json; charset=utf-8'
    '.svg' = 'image/svg+xml'
    '.png' = 'image/png'
    '.jpg' = 'image/jpeg'
    '.jpeg' = 'image/jpeg'
    '.gif' = 'image/gif'
    '.webp' = 'image/webp'
    '.ico' = 'image/x-icon'
    '.woff' = 'font/woff'
    '.woff2' = 'font/woff2'
    '.ttf' = 'font/ttf'
    '.map' = 'application/json; charset=utf-8'
    '.txt' = 'text/plain; charset=utf-8'
    '.csv' = 'text/csv; charset=utf-8'
    '.yaml' = 'text/yaml; charset=utf-8'
    '.yml' = 'text/yaml; charset=utf-8'
    '.pdf' = 'application/pdf'
}

# "localhost" rather than 127.0.0.1: an ordinary user may listen on a
# localhost prefix without a URL reservation, and nothing else on the network
# can reach it.
$listener = $null
$url = $null
for ($p = $Port; $p -le $Port + 11; $p++) {
    $candidate = New-Object System.Net.HttpListener
    $candidate.Prefixes.Add("http://localhost:$p/")
    try {
        $candidate.Start()
        $listener = $candidate
        $url = "http://localhost:$p/"
        break
    } catch {
        $candidate.Close()
    }
}
if (-not $listener) {
    Write-Host ''
    Write-Host "  ERROR: could not listen on any port from $Port to $($Port + 11)." -ForegroundColor Red
    Write-Host '  Try another range:  start.bat --port 9000'
    Write-Host ''
    exit 1
}

Write-Host ''
Write-Host "  ArchToolKit is at $url" -ForegroundColor Green
Write-Host '  Serving the prebuilt pages with PowerShell (no Node on this machine).'
Write-Host '  Close this window, or press Ctrl-C, to stop.'
Write-Host ''

if (-not $NoOpen) { Start-Process $url }

function Send-Text($response, [int]$status, [string]$text) {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
    $response.StatusCode = $status
    $response.ContentType = 'text/plain; charset=utf-8'
    $response.ContentLength64 = $bytes.Length
    $response.OutputStream.Write($bytes, 0, $bytes.Length)
}

try {
    while ($listener.IsListening) {
        # GetContextAsync with a short wait keeps Ctrl-C responsive; a plain
        # GetContext() blocks the console until the next request arrives.
        $task = $listener.GetContextAsync()
        while (-not $task.AsyncWaitHandle.WaitOne(500)) { }
        $context = $task.GetAwaiter().GetResult()
        $request = $context.Request
        $response = $context.Response
        try {
            if ($request.HttpMethod -ne 'GET' -and $request.HttpMethod -ne 'HEAD') {
                Send-Text $response 405 'Method not allowed'
                continue
            }

            $path = [System.Uri]::UnescapeDataString($request.Url.AbsolutePath)
            if ($path.EndsWith('/')) { $path += 'index.html' }
            $full = [System.IO.Path]::GetFullPath((Join-Path $web ($path.TrimStart('/') -replace '/', [System.IO.Path]::DirectorySeparatorChar)))

            # Nothing outside web\ is served, whatever the path says.
            if (-not $full.StartsWith($webPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
                Send-Text $response 403 'Forbidden'
                continue
            }
            if ((Test-Path -LiteralPath $full -PathType Container)) {
                $full = Join-Path $full 'index.html'
            }
            if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
                Send-Text $response 404 "Not found: $path"
                continue
            }

            $ext = [System.IO.Path]::GetExtension($full).ToLowerInvariant()
            $type = $mime[$ext]
            if (-not $type) { $type = 'application/octet-stream' }

            $bytes = [System.IO.File]::ReadAllBytes($full)
            $response.StatusCode = 200
            $response.ContentType = $type
            $response.Headers['Cache-Control'] = 'no-store'
            $response.Headers['X-Content-Type-Options'] = 'nosniff'
            $response.ContentLength64 = $bytes.Length
            if ($request.HttpMethod -eq 'GET') {
                $response.OutputStream.Write($bytes, 0, $bytes.Length)
            }
        } catch {
            try { Send-Text $response 500 $_.Exception.Message } catch { }
        } finally {
            try { $response.OutputStream.Close() } catch { }
        }
    }
} finally {
    $listener.Stop()
    $listener.Close()
}
