$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Vendor = Join-Path $Root "vendor"
$Bundle = Join-Path $Vendor "cmaps.bundle.json.gz"
$HashList = Join-Path $Vendor "SHA256SUMS.txt"

$required = @(
  @{ Name="pdf-lib.esm.js"; Path=(Join-Path $Vendor "pdf-lib.esm.js"); Min=1000000 },
  @{ Name="pdf.min.mjs"; Path=(Join-Path $Vendor "pdf.min.mjs"); Min=200000 },
  @{ Name="pdf.worker.min.mjs"; Path=(Join-Path $Vendor "pdf.worker.min.mjs"); Min=500000 },
  @{ Name="OpenJPEG WASM"; Path=(Join-Path (Join-Path $Vendor "wasm") "openjpeg.wasm"); Min=200000 },
  @{ Name="OpenJPEG JS fallback"; Path=(Join-Path (Join-Path $Vendor "wasm") "openjpeg_nowasm_fallback.js"); Min=400000 },
  @{ Name="qcms WASM"; Path=(Join-Path (Join-Path $Vendor "wasm") "qcms_bg.wasm"); Min=80000 },
  @{ Name="CMap bundle"; Path=$Bundle; Min=1000000 }
)

$ok = $true
Write-Host "PDFかんたん編集 v1.3.1 - オフライン構成チェック"
Write-Host ""

foreach ($item in $required) {
    if (-not (Test-Path $item.Path)) {
        Write-Host "[NG] $($item.Name) がありません。" -ForegroundColor Red
        $ok = $false
        continue
    }
    $size = (Get-Item $item.Path).Length
    if ($size -lt $item.Min) {
        Write-Host "[NG] $($item.Name) のサイズが想定より小さいです: $size bytes" -ForegroundColor Red
        $ok = $false
    } else {
        Write-Host "[OK] $($item.Name) : $size bytes" -ForegroundColor Green
    }
}

if (-not (Test-Path $HashList)) {
    Write-Host "[NG] vendor/SHA256SUMS.txt がありません。" -ForegroundColor Red
    $ok = $false
} else {
    $hashEntries = Get-Content $HashList | Where-Object { $_.Trim().Length -gt 0 }
    foreach ($line in $hashEntries) {
        if ($line -notmatch '^\uFEFF?([0-9A-Fa-f]{64})\s{2}(.+)$') {
            Write-Host "[NG] SHA256SUMS.txt の形式が不正です: $line" -ForegroundColor Red
            $ok = $false
            continue
        }

        $expected = $Matches[1].ToUpperInvariant()
        $relative = $Matches[2].Replace('/', [IO.Path]::DirectorySeparatorChar)
        $target = Join-Path $Vendor $relative

        if (-not (Test-Path $target)) {
            Write-Host "[NG] SHA-256対象ファイルがありません: $relative" -ForegroundColor Red
            $ok = $false
            continue
        }

        $actual = (Get-FileHash -Algorithm SHA256 -Path $target).Hash.ToUpperInvariant()
        if ($actual -ne $expected) {
            Write-Host "[NG] SHA-256不一致: $relative" -ForegroundColor Red
            Write-Host "     expected: $expected"
            Write-Host "     actual  : $actual"
            $ok = $false
        } else {
            Write-Host "[OK] SHA-256: $relative" -ForegroundColor Green
        }
    }
}

$pdfJsVersion = "5.3.31"
foreach ($fileName in @("pdf.min.mjs", "pdf.worker.min.mjs")) {
    $pdfJsPath = Join-Path $Vendor $fileName
    if ((Test-Path $pdfJsPath) -and ((Get-Content $pdfJsPath -Raw) -match [regex]::Escape($pdfJsVersion))) {
        Write-Host "[OK] $fileName : PDF.js $pdfJsVersion" -ForegroundColor Green
    } else {
        Write-Host "[NG] $fileName のPDF.jsバージョンが $pdfJsVersion と一致しません。" -ForegroundColor Red
        $ok = $false
    }
}

$legacyDirs = @("cmaps", "cmaps_packed", "standard_fonts")
foreach ($d in $legacyDirs) {
    if (Test-Path (Join-Path $Vendor $d)) {
        Write-Host "[NG] 旧CMap構成の不要ディレクトリが残っています: vendor/$d" -ForegroundColor Red
        $ok = $false
    }
}

Write-Host ""
$runtimeFiles = @("index.html","app.css","app.js","web.config")
$networkPattern = 'https?://'
$runtimeMatches = @()
foreach ($f in $runtimeFiles) {
    $p = Join-Path $Root $f
    if (Test-Path $p) {
        $matches = Select-String -Path $p -Pattern $networkPattern -AllMatches
        foreach ($m in $matches) {
            if ($m.Line -notmatch 'http://www\.w3\.org/2000/svg') {
                $runtimeMatches += "$f : $($m.Line.Trim())"
            }
        }
    }
}

if ($runtimeMatches.Count -eq 0) {
    Write-Host "[OK] ブラウザ実行ファイルに外部HTTP/HTTPS参照はありません。" -ForegroundColor Green
} else {
    Write-Host "[NG] 外部URLらしき記述が見つかりました。" -ForegroundColor Red
    $runtimeMatches | ForEach-Object { Write-Host $_ }
    $ok = $false
}

$csp = Get-Content (Join-Path $Root "web.config") -Raw
if ($csp -match "connect-src 'self'" -and $csp -notmatch 'connect-src[^"]*https?://') {
    Write-Host "[OK] CSP: connect-src 'self'（同一オリジンのみ）を確認しました。" -ForegroundColor Green
} else {
    Write-Host "[NG] CSPの connect-src 'self' が確認できません。" -ForegroundColor Red
    $ok = $false
}

if ($csp -match 'fileExtension="\.gz"' -and $csp -match 'fileExtension="\.wasm"' -and $csp -match 'mimeType="application/wasm"' -and $csp -notmatch 'fileExtension="\.cmap"' -and $csp -notmatch 'fileExtension="\.bcmap"') {
    Write-Host "[OK] IIS MIME: .gz / .wasm / 旧CMap MIME削除を確認しました。" -ForegroundColor Green
} else {
    Write-Host "[NG] IISのCMap bundle用MIME設定を確認してください。" -ForegroundColor Red
    $ok = $false
}

$appJs = Get-Content (Join-Path $Root "app.js") -Raw
if ($appJs -match 'BundledTextCMapReaderFactory' -and $appJs -match 'cmaps\.bundle\.json\.gz' -and $appJs -match 'DecompressionStream' -and $appJs -match 'vendor/wasm/' -and $appJs -match 'useWasm:\s*true' -and $appJs -match 'useWorkerFetch:\s*false') {
    Write-Host "[OK] PDF.js CMap bundle / OpenJPEG・qcmsローカル構成を確認しました。" -ForegroundColor Green
} else {
    Write-Host "[NG] PDF.js CMap bundle構成が確認できません。" -ForegroundColor Red
    $ok = $false
}

Write-Host ""
if ($ok) {
    Write-Host "チェック完了: IISへ配置できる状態です。" -ForegroundColor Green
    exit 0
} else {
    Write-Host "チェックNG: 上記を確認してください。" -ForegroundColor Red
    exit 1
}
