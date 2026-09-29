const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { commonAssetVersion } = require("../../../tests/helpers.cjs");

const appDir = path.resolve(__dirname, "..");

function read(name) {
  return fs.readFileSync(path.join(appDir, name), "utf8");
}

test("本体はredテーマと新標準の共通外枠を使用する", () => {
  const html = read("index.html");

  assert.match(html, /data-appbox-theme="red"/);
  assert.match(html, /<header class="appbox-header">/);
  assert.match(html, /class="appbox-header__brand"/);
  assert.match(html, /class="appbox-help-button"/);
  assert.match(html, /class="appbox-back-button" href="\.\.\/\.\.\/">&lt; ポータルに戻る<\/a>/);
  assert.match(html, /<main id="main-content" class="pdf-app-main">/);
  assert.match(html, /class="appbox-app-intro appbox-app-intro--edge" id="pdfBrand"/);
  assert.match(html, /class="appbox-app-h1">PDFかんたん編集<\/h1>/);
  assert.match(html, /class="appbox-shell appbox-shell--wide pdfeditor-shell"/);
  assert.equal((html.match(/<main\b/g) || []).length, 1);
  assert.equal((html.match(/<h1\b/g) || []).length, 1);
});

test("プレビュー拡張用の折りたたみはアプリ導入部と重要注意だけを対象にする", () => {
  const html = read("index.html");
  const css = read("app.css");

  assert.match(html, /data-appbox-collapse="pdfBrand pdfNotice"/);
  assert.doesNotMatch(html, /data-appbox-collapse-flag="chrome"/);
  assert.match(html, new RegExp(`appbox-collapse\\.js\\?v=${commonAssetVersion().replaceAll(".", "\\.")}`));
  assert.match(css, /\[data-appbox-collapsed="true"\]\s*\{\s*display:\s*none;/);
  assert.doesNotMatch(css, /data-appbox-collapsed-chrome/);
});

test("PDF固有の主要な編集領域と安全上の注意を維持する", () => {
  const html = read("index.html");
  const css = read("app.css");

  for (const id of [
    "pdfInput",
    "pdfNotice",
    "emptyState",
    "editor",
    "thumbList",
    "viewerArea",
    "pdfCanvas",
    "annotationLayer",
    "saveBtn",
    "statusText",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }

  assert.match(html, /マスキング用途で使用しないでください（データは見えます）/);
  assert.doesNotMatch(html, /id="addPdfBtn"/);

  const bodyBlocks = [
    ...css.matchAll(/(?:^|\n)body\s*\{([^}]*)\}/g),
  ];
  const bodyBlock = bodyBlocks.find((match) =>
    /margin:\s*0;/.test(match[1])
  );
  assert.ok(bodyBlock);
});

test("PDF読込み後は案内類を自動で隠して編集領域を優先する", () => {
  const js = read("app.js");
  const css = read("app.css");

  assert.match(
    js,
    /document\.body\.classList\.toggle\(\s*"pdf-editor-active",\s*hasPages\s*\)/
  );
  assert.match(
    js,
    /マスキング用途で使用しないでください（データは見えます）/
  );
  assert.match(
    js,
    /function restoreIntroDisclosure\(\)[\s\S]*aria-expanded[\s\S]*\.click\(\)/
  );
  assert.match(
    js,
    /state\.tool = "select";[\s\S]*restoreIntroDisclosure\(\);/
  );

  for (const selector of [
    "body.pdf-editor-active #pdfBrand",
    "body.pdf-editor-active #pdfNotice",
    "body.pdf-editor-active .appbox-collapse-toggle",
    "body.pdf-editor-active .pdfeditor-footer",
    "body.pdf-editor-active .editor-guidance",
  ]) {
    assert.match(css, new RegExp(selector.replaceAll(".", "\\.")));
  }

  const statusRule = css.match(
    /body\.pdf-editor-active \.status-bar\s*\{([^}]*)\}/
  );
  assert.ok(statusRule);
  assert.match(statusRule[1], /position:\s*absolute;/);
  assert.doesNotMatch(statusRule[1], /display:\s*none;/);
});

test("共通外枠と重複する旧ヘッダー・ボタンCSSを持たない", () => {
  const css = read("app.css");

  for (const selector of [
    /^\.app-header\b/m,
    /^\.brand\b/m,
    /^\.title-row\b/m,
    /^\.app-icon\b/m,
    /^\.header-actions\b/m,
    /^\.back-button\b/m,
    /^\.help-button\b/m,
    /^\.btn-primary\b/m,
    /^\.btn-soft\b/m,
    /^h1\s*\{/m,
  ]) {
    assert.doesNotMatch(css, selector);
  }

  assert.match(css, /#pdfBrand\s*\{[\s\S]*margin-bottom:\s*0;[\s\S]*padding-bottom:\s*12px;/);
  assert.match(css, /\.pdfeditor-shell\s*\{/);
  assert.match(css, /\.redaction-notice\s*\{/);
  assert.match(css, /\.editor\s*\{/);
});

test("ヘルプは新標準の4区分とネスト目次を使用し重要警告を先に示す", () => {
  const help = read("help.html");

  assert.match(help, /data-appbox-theme="red"/);
  assert.match(help, /class="appbox-header"/);
  assert.match(help, /class="appbox-help-header-card"/);
  assert.match(help, /class="appbox-help-grid help-panel"/);
  assert.match(help, /href="\.\/index\.html">&lt; アプリに戻る<\/a>/);

  for (const id of ["quick-start", "advanced", "faq", "other"]) {
    assert.match(help, new RegExp(`href="#${id}"`), id);
    assert.match(help, new RegExp(`id="${id}"`), id);
  }

  for (const id of ["pages", "comments", "shapes", "save", "cautions", "privacy"]) {
    assert.match(help, new RegExp(`appbox-help-nav-link--sub" href="#${id}"`), id);
    assert.match(help, new RegExp(`class="appbox-help-subheading" id="${id}"`), id);
  }

  const warningPos = help.indexOf('class="help-callout help-callout-warning"');
  const navPos = help.indexOf('class="appbox-help-nav-card');
  assert.ok(warningPos > 0 && navPos > warningPos);
  assert.match(help, /<details class="appbox-help-faq-item">/);
  assert.match(help, /class="appbox-help-faq-answer"/);
  assert.match(help, new RegExp(`appbox-help\\.js\\?v=${commonAssetVersion().replaceAll(".", "\\.")}`));
});

test("README・本体・ヘルプを1.3.2へ更新し変更したCSSだけキャッシュ識別子を上げる", () => {
  const html = read("index.html");
  const help = read("help.html");
  const readme = read("README.txt");

  assert.match(readme, /お役立ちアプリBOX \/ PDFかんたん編集  v1\.3\.2/);
  assert.match(readme, /リリース版 v1\.3\.2/);
  assert.match(html, /PDFかんたん編集 Version 1\.3\.2/);
  assert.match(help, /Version 1\.3\.2/);
  assert.match(help, /PDFかんたん編集 Version 1\.3\.2/);
  assert.match(html, /app\.css\?v=1\.3\.2/);
  assert.match(html, /app\.js\?v=1\.3\.1/);
});

test("保存警告は丸を含め、抽出対象ページだけを判定する", () => {
  const js = read("app.js");
  const help = read("help.html");
  const readme = read("README.txt");

  assert.match(js, /function hasCoveringAnnotations\(\s*pages = state\.pages\s*\)/);
  assert.match(js, /"rect",[\s\S]*"ellipse",[\s\S]*"text"[\s\S]*\.includes\(\s*annotation\.type/);
  assert.match(js, /hasCoveringAnnotations\(\s*exportPages\s*\)/);
  assert.match(readme, /四角・丸・テキストがある場合/);
  assert.match(help, /四角・丸・テキストがある場合/);
});

test("PDF.js TextLayerの文字計測用Canvasを画面へ露出させない", () => {
  const css = read("app.css");

  const rule = css.match(/\.hiddenCanvasElement\s*\{([^}]*)\}/);
  assert.ok(rule);
  assert.match(rule[1], /position:\s*absolute;/);
  assert.match(rule[1], /width:\s*0;/);
  assert.match(rule[1], /height:\s*0;/);
  assert.match(rule[1], /display:\s*none;/);
});

test("ページ描画は白背景とサムネイル再利用で競合・全件再描画を抑制する", () => {
  const js = read("app.js");

  assert.match(js, /let currentThumbnailRenderTask = null;/);
  assert.match(js, /function thumbnailRenderKey\(pageRef\)/);
  assert.match(js, /reusable\?\.dataset[\s\S]*\.renderKey ===[\s\S]*thumbnailRenderKey/);
  assert.match(js, /await stopThumbnailRendering\(\)/);
  assert.match(js, /context\.fillStyle =\s*"#ffffff";[\s\S]*context\.fillRect\(/);
  assert.match(js, /function selectPage\(pageId, render = true\)/);
  assert.match(js, /state\.selectionAnchor=state\.currentPageId/);
});


test("PDF.js 5.3.31のJPEG2000・ICC実行資産を同一オリジンから読み込む", () => {
  const js = read("app.js");
  const vendorReadme = read("vendor/README.txt");
  const notice = read("THIRD_PARTY_LICENSES.txt");

  assert.match(js, /new URL\([\s\S]*\.\/vendor\/wasm\/[\s\S]*document\.baseURI/);
  assert.match(js, /useWasm:\s*true/);
  assert.match(js, /useWorkerFetch:\s*false/);
  assert.match(js, /BundledTextCMapReaderFactory/);

  for (const [relative, minimum] of [
    ["vendor/wasm/openjpeg.wasm", 200000],
    ["vendor/wasm/openjpeg_nowasm_fallback.js", 400000],
    ["vendor/wasm/qcms_bg.wasm", 80000],
  ]) {
    const full = path.join(appDir, relative);
    assert.ok(fs.existsSync(full), relative);
    assert.ok(fs.statSync(full).size >= minimum, relative);
  }

  assert.match(vendorReadme, /openjpeg\.wasm/);
  assert.match(vendorReadme, /qcms_bg\.wasm/);
  assert.match(notice, /PDF\.js \/ pdfjs-dist 5\.3\.31/);
  assert.match(notice, /licenses\/openjpeg_LICENSE\.txt/);
  assert.match(notice, /licenses\/pdfjs-openjpeg_LICENSE\.txt/);
  assert.match(notice, /licenses\/qcms_LICENSE\.txt/);
  assert.match(notice, /licenses\/pdfjs-qcms_LICENSE\.txt/);
});
