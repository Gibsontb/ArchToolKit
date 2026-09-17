$docs = "docs"
$pdf  = "docs/pdf"

if (!(Test-Path $pdf)) {
    New-Item -ItemType Directory $pdf
}

Get-ChildItem "$docs/*.md" | ForEach-Object {

    $name = $_.BaseName
    $out  = "$pdf/$name.pdf"

    pandoc $_.FullName `
        -o $out `
        --pdf-engine=xelatex
}