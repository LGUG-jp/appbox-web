const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { commonAssetVersion } = require("../../../tests/helpers.cjs");

const appDir = path.resolve(__dirname, "..");

function read(name) {
  return fs.readFileSync(path.join(appDir, name), "utf8");
}

test("画面は作成・プレビュー保存・詳細カスタマイズの3領域で構成する", () => {
  const html = read("index.html");

  const mainGridStart = html.indexOf('class="main-grid qr-main-grid"');
  const createPanel = html.indexOf('class="panel create-panel appbox-panel--accent"');
  const previewPanel = html.indexOf('class="panel preview-panel appbox-panel--accent"');
  const mainGridEnd = html.indexOf('</div>\n\n    <section class="panel customization-section appbox-panel--accent"');
  const customization = html.indexOf('class="panel customization-section appbox-panel--accent"');

  assert.ok(mainGridStart >= 0);
  assert.ok(createPanel > mainGridStart);
  assert.ok(previewPanel > createPanel);
  assert.ok(mainGridEnd > previewPanel);
  assert.ok(customization > mainGridEnd);
  assert.match(html, /id="customizationTitle">詳細カスタマイズ/);
  assert.doesNotMatch(html, /<summary>詳細カスタマイズ<\/summary>/);
});

test("用途はURL・メール・電話・テキストの通常ラジオボタンでSMSを表示しない", () => {
  const html = read("index.html");
  const css = read("qrcode-ux.css");
  const values = Array.from(
    html.matchAll(/name="contentTypeChoice" value="([^"]+)"/g),
    match => match[1]
  );

  assert.deepEqual(values, ["url", "email", "phone", "text"]);
  assert.doesNotMatch(html, /name="contentTypeChoice" value="sms"/);
  assert.doesNotMatch(html, /<option value="sms"/);
  assert.match(css, /\.type-radio input\s*\{/);
  assert.match(css, /border-radius:\s*50%/);
  assert.match(css, /\.type-radio input:checked/);
});

test("保存ファイル名は右側の保存ボタン直前へ配置する", () => {
  const html = read("index.html");
  const previewIndex = html.indexOf('class="panel preview-panel"');
  const fileNameIndex = html.indexOf('id="saveFileName"');
  const pngIndex = html.indexOf('id="downloadPngBtn"');
  const customizeIndex = html.indexOf('id="customizationPanel"');

  assert.ok(fileNameIndex > previewIndex);
  assert.ok(pngIndex > fileNameIndex);
  assert.ok(customizeIndex > pngIndex);
});

test("PNGとSVGの用途説明はメイン画面から削除する", () => {
  const html = read("index.html");

  assert.doesNotMatch(html, /save-format-guide/);
  assert.doesNotMatch(html, /Word・PowerPoint・Webページなど、普段使いにおすすめ/);
  assert.doesNotMatch(html, /SVG非対応のソフトやシステム/);
});

test("プレビュー領域は左右の高さをそろえやすいコンパクト表示にする", () => {
  const css = read("qrcode-ux.css");

  assert.match(css, /\.preview-body\s*\{[^}]*flex:\s*0 0 auto/s);
  assert.match(css, /\.qr-stage\s*\{[^}]*width:\s*min\(100%, 240px\)/s);
});

test("背景透明はトグル表示し、ON直後に透明プレビューへ即時反映する", () => {
  const html = read("index.html");
  const css = read("qrcode-ux.css");
  const source = read("qrcode-ux.js");

  assert.match(html, /id="transparentBgBtn" aria-pressed="false"/);
  assert.match(css, /\.transparent-bg-button::before/);
  assert.match(css, /\.transparent-bg-button\[aria-pressed="true"\]::before/);
  assert.match(css, /\.transparent-bg-button::before\s*\{[^}]*background-color:\s*var\(--appbox-border\)/s);
  assert.match(source, /function setTransparentBackground/);
  assert.match(source, /ensureTransparentSourceColor\(rerender\);\s*applyTransparentPreview\(\);/s);
  assert.match(source, /transparentBgBtn\.textContent\s*=\s*"背景透明"/);
  assert.doesNotMatch(source, /背景透明：オン/);
  assert.match(source, /dispatchInput\(bgColor\)/);
});

test("メールと電話の互換性注意はインライン表示し、確認ダイアログを使わない", () => {
  const source = read("qrcode-ux.js");

  assert.match(source, /function getCompatibilityWarnings/);
  assert.match(source, /メールアドレスに全角文字または日本語が含まれています/);
  assert.match(source, /電話番号に全角の数字や記号が含まれています/);
  assert.match(source, /digits\.length >= 12/);
  assert.match(source, /digits\.length > 15/);
  assert.match(source, /inputWarning\.textContent/);
  assert.match(source, /inputWarning\.hidden/);
  assert.doesNotMatch(source, /\b(?:alert|confirm)\s*\(/);
});

test("常時表示の詳細カスタマイズにdetails由来のopen操作を残さない", () => {
  const source = read("qrcode-ux.js");

  assert.doesNotMatch(source, /customizationPanel\.open/);
});

test("QRコード化した内容を確認は画面から削除し互換フックだけ非表示で保持する", () => {
  const html = read("index.html");

  assert.doesNotMatch(html, /QRコード化した内容を確認/);
  assert.match(html, /class="legacy-result-hooks" id="resultSummary"/);
  assert.match(html, /id="encodedDetails" hidden/);
  assert.match(html, /id="encodedContent"/);
  assert.match(html, /id="copyContentBtn"/);
});

test("作成情報を表示せず、読み取り確認をプレビュー上部へ表示する", () => {
  const html = read("index.html");

  assert.match(html, /id="resultSummary"[^>]*aria-hidden="true"[^>]*hidden/);
  assert.match(html, /QRコードは読み取り確認をしてください！/);
  assert.match(html, /id="readCheckNotice"/);
  assert.match(html, /appbox-status--warning/);
});

test("変更した固有CSSだけ版数を更新し、共通assetsは正本の版を参照する", () => {
  const html = read("index.html");

  assert.match(html, /qrcode\.css\?v=1\.4\.4/);
  for (const file of ["qrcode-ux.css", "qr-core.js", "qrcode-app.js", "qrcode-ux.js"]) {
    assert.match(html, new RegExp(`${file.replace(".", "\\.")}\\?v=1\\.4\\.1`), file);
  }

  for (const file of [
    "appbox-tokens.css",
    "appbox-themes.css",
    "appbox-base.css",
    "appbox-chrome.css",
    "appbox-components.css",
    "appbox-utilities.js"
  ]) {
    assert.ok(html.includes(`${file}?v=${commonAssetVersion()}`), file);
  }
});

test("新標準のヘッダーと導入部からヘルプ・ポータルへ移動できる", () => {
  const html = read("index.html");
  const help = read("help.html");
  const css = read("qrcode.css");

  assert.match(html, /data-appbox-theme="purple"/);
  assert.match(help, /data-appbox-theme="purple"/);
  assert.match(html, /<header class="appbox-header">/);
  assert.match(html, /<main id="main-content">[\s\S]*class="appbox-app-intro appbox-app-intro--edge"[\s\S]*<div class="appbox-shell">/);
  assert.match(html, /class="appbox-shell"/);
  assert.match(html, /class="panel create-panel appbox-panel--accent"/);
  assert.match(html, /href="\.\/help\.html" target="_blank" rel="noopener"/);
  assert.match(html, /<footer class="appbox-footer">\s*お役立ちアプリBOX \/ QRコード作成 Version 1\.4\.4\s*<\/footer>/);
  assert.match(html, /class="trademark-note"[^>]*>\s*「QRコード」は株式会社デンソーウェーブの登録商標です/);
  assert.doesNotMatch(css, /\.qr-shell\s*\{/);
  assert.match(css, /\.panel\s*\{[^}]*border-top:\s*4px solid var\(--primary\)/);
  assert.match(help, /href="\.\/index\.html">&lt; アプリに戻る<\/a>/);
  assert.match(help, /<div class="appbox-help-header-card">[\s\S]*class="help-callout help-callout-warning"[\s\S]*<\/div>\s*<div class="appbox-help-grid help-panel">/);
  assert.match(help, /class="appbox-help-nav-sublist"/);
  assert.match(help, /class="appbox-help-faq-item"/);
});

test("UX拡張スクリプトは構文エラーなく、透明保存後に既存保存可否を再評価する", () => {
  const source = read("qrcode-ux.js");

  assert.doesNotThrow(() => new Function(source));
  assert.match(source, /function setTransparentSaveState/);
  assert.match(source, /dispatchInput\(qrText\)/);
  assert.doesNotMatch(source, /button\.disabled\s*=\s*false/);
});

test("UI拡張CSSは共通デザイントークンを利用し色リテラルを持たない", () => {
  const css = read("qrcode-ux.css");

  assert.match(css, /--appbox-primary/);
  assert.match(css, /--appbox-status-warning-bg/);
  assert.match(css, /--appbox-focus-ring/);
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i);
  assert.doesNotMatch(css, /rgba?\(/i);
});
