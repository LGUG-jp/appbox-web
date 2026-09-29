const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { commonAssetVersion } = require("../../../tests/helpers.cjs");

const appDir = path.resolve(__dirname, "..");

function read(name) {
  return fs.readFileSync(path.join(appDir, name), "utf8");
}

test("固有CSSは共通ボタン外観を重複定義せずExcalidraw固有調整だけを持つ", () => {
  const css = read("flow-app.css");

  assert.match(css, /\.flow-app\s*\{[^}]*background:\s*var\(--appbox-page-bg\)/s);
  assert.match(css, /\.flow-header\s*\{[^}]*background:\s*var\(--appbox-surface\)/s);
  assert.match(css, /\.canvas-shell\s*\{[^}]*background:\s*var\(--appbox-surface-soft\)/s);
  assert.match(css, /\.flow-header \.back-link\s*\{\s*display: none !important;/);
  assert.match(css, /\.excalidraw \.help-icon\s*\{\s*display: none !important;/);
  assert.match(css, /\.excalidraw \.HelpDialog__btn\s*\{\s*display: none !important;/);

  assert.doesNotMatch(css, /^\.appbox-back-button\s*\{/m);
  assert.doesNotMatch(css, /^\.appbox-help-button\s*\{/m);
  assert.doesNotMatch(css, /\.appbox-back-button:focus-visible/);
  assert.doesNotMatch(css, /\.appbox-help-button:hover/);
});

test("ヘルプは新標準の4区分とネスト目次を使う", () => {
  const help = read("help.html");

  assert.match(help, /data-appbox-theme="purple"/);
  assert.match(help, /class="appbox-header"/);
  assert.match(help, /class="appbox-header__brand"/);
  assert.match(help, /class="appbox-help-header-card"/);
  assert.match(help, /class="appbox-help-grid help-panel"/);
  assert.match(help, /class="appbox-help-nav-card appbox-no-print"/);
  assert.match(help, /class="appbox-help-nav-sublist"/);
  assert.match(help, /class="appbox-help-nav-link appbox-help-nav-link--sub"/);
  assert.match(help, /href="\.\/index\.html">&lt; アプリに戻る<\/a>/);

  for (const id of ["quick-start", "advanced", "faq", "other"]) {
    assert.match(help, new RegExp(`href="#${id}"`));
    assert.match(help, new RegExp(`id="${id}"`));
  }

  for (const id of ["samples", "mermaid", "style", "save", "cautions", "privacy"]) {
    assert.match(help, new RegExp(`href="#${id}"`));
    assert.match(help, new RegExp(`id="${id}"`));
  }

  assert.equal((help.match(/<details class="appbox-help-faq-item">/g) || []).length, 6);
  assert.equal((help.match(/<div class="appbox-help-faq-answer">/g) || []).length, 6);
  assert.ok(help.includes(`appbox-help.js?v=${commonAssetVersion()}`));
});

test("ヘルプは重要警告を目次より前へ置く", () => {
  const help = read("help.html");

  const warning = help.indexOf('class="help-callout help-callout-warning"');
  const navigation = help.indexOf('class="appbox-help-nav-card');
  assert.ok(warning > 0 && navigation > warning);
});

test("ヘルプの目次リンクは同一ページの見出しIDへ解決できる", () => {
  const help = read("help.html");
  const ids = new Set([...help.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
  const links = [...help.matchAll(/class="appbox-help-nav-link[^"]*" href="#([^"]+)"/g)]
    .map(match => match[1]);

  assert.ok(links.length >= 10);
  for (const id of links) assert.ok(ids.has(id), id);
});
