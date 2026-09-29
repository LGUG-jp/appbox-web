この vendor フォルダはPDFかんたん編集のローカル実行資産です。

必須:
- pdf-lib.esm.js
- pdf.min.mjs
- pdf.worker.min.mjs
- wasm/openjpeg.wasm
- wasm/openjpeg_nowasm_fallback.js
  JPEG 2000 / JPXDecode画像をローカルで復号するOpenJPEG実行資産です。
  通常はWASM版を使用し、WASM初期化に失敗した場合のみJS版へフォールバックします。
- wasm/qcms_bg.wasm
  PDF内のICCカラープロファイルをローカルで処理するqcms実行資産です。
- cmaps.bundle.json.gz
  PDF.jsで日本語等のCIDフォントを表示するためのCMap 239種を、
  配布ファイル数削減のため1ファイルへまとめてgzip圧縮したものです。

取得元・監査固定値:
- pdf-lib 1.17.1
  - 上流プロジェクト固定版: https://github.com/Hopding/pdf-lib/tree/v1.17.1
- PDF.js / pdf.worker 5.3.31
  - 配布物取得元: https://github.com/cdnjs/cdnjs/tree/master/ajax/libs/pdf.js/5.3.31
  - 上流プロジェクト固定版: https://github.com/mozilla/pdf.js/tree/v5.3.31
- OpenJPEG
  - https://github.com/mozilla/pdf.js/tree/v5.3.31/external/openjpeg
- qcms
  - https://github.com/mozilla/pdf.js/tree/v5.3.31/external/qcms
- 実行資産のSHA-256はSHA256SUMS.txtを正本とします。
  PDF.js、OpenJPEG、qcmsの差し替え時は取得元・版・SHA-256・対応する
  ライセンス原文を同時に再確認してください。

アプリ実行時に外部サイトへの通信は行いません。
CMap bundle、OpenJPEG、qcmsもIIS上の同一オリジンからのみ読み込みます。
