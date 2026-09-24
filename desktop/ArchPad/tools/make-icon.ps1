<#
.SYNOPSIS
  Draws ArchPad.ico: the toolkit's gradient brand mark with "AP" on it.

.DESCRIPTION
  The icon is drawn rather than checked in as an opaque binary so it can be
  regenerated (new colours, new letters) without an image editor. It matches
  the .brand-mark in web/styles/app.css: a rounded square, accent blue to
  violet, white bold letters.

  Each size is rendered separately instead of scaled from 256 px, because a
  downscaled 16 px "AP" turns to mush; the small sizes get a heavier font and
  a smaller corner radius. Every image is stored PNG-compressed, which every
  Windows since Vista reads.

  build.ps1 runs this when ArchPad.ico is missing.
#>
param(
  [string]$OutFile = (Join-Path $PSScriptRoot '..\ArchPad.ico')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$sizes = 16, 20, 24, 32, 40, 48, 64, 128, 256
$from = [System.Drawing.Color]::FromArgb(255, 0x4d, 0x8d, 0xff)
$to = [System.Drawing.Color]::FromArgb(255, 0x7c, 0x5c, 0xff)

function New-RoundedRect([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = 2 * $r
  $path.AddArc($x, $y, $d, $d, 180, 90)
  $path.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $path.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $path.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  return $path
}

function Get-IconPng([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try {
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $g.Clear([System.Drawing.Color]::Transparent)

    $radius = [Math]::Max(2.0, $size * 0.18)
    $rect = New-Object System.Drawing.RectangleF 0, 0, $size, $size
    $shape = New-RoundedRect 0 0 ($size - 0.5) ($size - 0.5) $radius
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, $from, $to, 45.0
    $g.FillPath($brush, $shape)

    # Small sizes: tighter letters so both still fit at 16 px.
    $fontSize = if ($size -le 24) { $size * 0.56 } else { $size * 0.46 }
    $font = New-Object System.Drawing.Font 'Segoe UI', $fontSize, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
    $format = New-Object System.Drawing.StringFormat
    $format.Alignment = [System.Drawing.StringAlignment]::Center
    $format.LineAlignment = [System.Drawing.StringAlignment]::Center
    $format.FormatFlags = [System.Drawing.StringFormatFlags]::NoWrap -bor [System.Drawing.StringFormatFlags]::NoClip
    $text = New-Object System.Drawing.RectangleF (-$size * 0.1), ($size * 0.02), ($size * 1.2), $size
    $g.DrawString('AP', $font, [System.Drawing.Brushes]::White, $text, $format)
  } finally {
    $g.Dispose()
  }
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  return , $ms.ToArray()
}

$images = foreach ($s in $sizes) { , (Get-IconPng $s) }

# ICO layout: ICONDIR (6 bytes), one ICONDIRENTRY (16 bytes) per image, then the images.
$out = New-Object System.IO.MemoryStream
$w = New-Object System.IO.BinaryWriter $out
$w.Write([UInt16]0)
$w.Write([UInt16]1)
$w.Write([UInt16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $s = $sizes[$i]
  $dim = if ($s -ge 256) { 0 } else { $s }   # 0 means 256 in an ICONDIRENTRY
  $w.Write([Byte]$dim)
  $w.Write([Byte]$dim)
  $w.Write([Byte]0)        # palette colours
  $w.Write([Byte]0)        # reserved
  $w.Write([UInt16]1)      # colour planes
  $w.Write([UInt16]32)     # bits per pixel
  $w.Write([UInt32]$images[$i].Length)
  $w.Write([UInt32]$offset)
  $offset += $images[$i].Length
}
foreach ($img in $images) { $w.Write([byte[]]$img) }
$w.Flush()
[System.IO.File]::WriteAllBytes([System.IO.Path]::GetFullPath($OutFile), $out.ToArray())
Write-Host "Wrote $([System.IO.Path]::GetFullPath($OutFile)) ($($out.Length) bytes, $($sizes.Count) sizes)"
