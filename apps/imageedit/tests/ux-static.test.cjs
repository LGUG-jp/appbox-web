const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const appDir = path.resolve(__dirname, "..");

function read(name) {
  return fs.readFileSync(path.join(appDir, name), "utf8");
}

test("本体とヘルプは新標準の外枠とyellowテーマを使用する", () => {
  const html = read("index.html");
  const help = read("help.html");

  for (const page of [html, help]) {
    assert.match(page, /data-appbox-theme="yellow"/);
    assert.match(page, /class="appbox-header"/);
    assert.match(page, /class="appbox-header__brand"/);
    assert.match(page, /class="appbox-back-button"/);
  }

  assert.match(html, /class="appbox-app-intro appbox-app-intro--edge"/);
  assert.match(html, /class="appbox-app-h1">画像かんたん加工<\/h1>/);
  assert.match(html, /class="appbox-app-icon"/);
  assert.match(html, /&lt; ポータルに戻る/);
  assert.match(help, /&lt; アプリに戻る/);
});

test("本体の作業領域幅は共通広幅shellに準拠し背景は単色である", () => {
  const html = read("index.html");
  const css = read("image.css");

  assert.match(html, /<main id="appMain">[\s\S]*class="appbox-app-intro appbox-app-intro--edge"[\s\S]*class="appbox-shell appbox-shell--wide"/);
  assert.match(css, /background:\s*var\(--appbox-page-bg/);
  assert.doesNotMatch(css, /\.imageedit-shell|\.app-shell/);
});

test("加工モード切り替えは共通インデックスタブを使用する", () => {
  const html = read("index.html");
  const css = read("image.css");

  assert.match(html, /class="appbox-tabs appbox-print-hidden"/);
  assert.match(html, /class="appbox-tab is-active"[\s\S]*role="tab"/);
  assert.match(html, /class="appbox-tab-panel"[\s\S]*role="tabpanel"/);
  assert.doesNotMatch(css, /\.tabs\.calc-tabs|\.tab\.calc-tab|\.tab-panel/);
});

test("各パネルにテーマアクセント線が適用されている", () => {
  const html = read("index.html");
  const css = read("image.css");

  assert.match(html, /left-panel appbox-panel appbox-panel--accent/);
  assert.match(html, /stage-panel appbox-panel appbox-panel--accent/);
  assert.match(html, /right-panel appbox-panel appbox-panel--accent/);
  assert.match(css, /\.panel\s*\{[^}]*border-top:\s*4px solid var\(--yellow-strong\)/s);
});

test("プライマリボタンは高コントラスト色を使用する", () => {
  const css = read("image.css");

  assert.match(css, /\.button\.primary\s*\{[^}]*background:\s*var\(--appbox-primary-hover,#856014\)/s);
});

test("画像未読み込み時は編集・保存領域が不活性で読込成功後に有効化される", () => {
  const html = read("index.html");
  const js = read("image.js");
  const css = read("image.css");

  assert.match(html, /class="panel left-panel[^"]*" inert/);
  assert.match(html, /class="stage-head" inert/);
  assert.match(html, /class="panel right-panel[^"]*" inert/);
  assert.match(css, /#singleWorkspace:has\(#singleEmpty:not\(\.hidden\)\)\s*\.left-panel/);
  assert.match(css, /pointer-events:\s*none/);
  assert.match(js, /\.querySelectorAll\("\.left-panel, \.stage-head, \.right-panel"\)\s*\.forEach\(element => \{\s*element\.inert = false;/);
});

test("旧ヘッダーやフッターの重複CSSが削除されている", () => {
  const css = read("image.css");

  assert.doesNotMatch(css, /^\.topbar\b/m);
  assert.doesNotMatch(css, /^\.brand\b/m);
  assert.doesNotMatch(css, /^\.brand-mark\b/m);
  assert.doesNotMatch(css, /^\.eyebrow\b/m);
  assert.doesNotMatch(css, /^h1\s*\{/m);
  assert.doesNotMatch(css, /^\.top-actions\b/m);
  assert.doesNotMatch(css, /^\.back-button\b/m);
  assert.doesNotMatch(css, /^footer\s*\{/m);
  assert.doesNotMatch(css, /^\.hero\b/m);
  assert.doesNotMatch(css, /^\.chips\b/m);
});

test("ヘルプは新標準の4区分とネスト目次を持ち目次前に重要警告を配置する", () => {
  const help = read("help.html");

  assert.match(help, /class="appbox-help-header-card"/);
  assert.match(help, /class="appbox-help-grid help-panel"/);
  assert.match(help, /class="appbox-help-nav-card/);
  assert.match(help, /class="[^"]*appbox-help-nav-sublist[^"]*"/);
  assert.match(help, /class="[^"]*appbox-help-nav-link--sub[^"]*"/);

  // 重要警告が目次より前にあること
  const warningPos = help.indexOf('class="help-callout help-callout-warning"');
  const navPos = help.indexOf('class="appbox-help-nav-card');
  assert.ok(warningPos > 0 && navPos > 0 && warningPos < navPos);

  // 4区分の存在確認
  for (const id of ["quick-start", "advanced", "faq", "other"]) {
    assert.match(help, new RegExp(`href="#${id}"`));
    assert.match(help, new RegExp(`id="${id}"`));
  }

  // ネスト小見出しの存在確認
  for (const id of ["mask", "layers", "trim", "size", "batch", "files", "operations", "cautions", "privacy"]) {
    assert.match(help, new RegExp(`href="#${id}"`));
    assert.match(help, new RegExp(`id="${id}"`));
  }

  // FAQ構造
  assert.match(help, /<details class="appbox-help-faq-item">/);
  assert.match(help, /<div class="appbox-help-faq-answer">/);
});

test("README・本体・ヘルプでバージョン整合性が保たれている", () => {
  const html = read("index.html");
  const help = read("help.html");
  const readme = read("README.txt");

  assert.match(readme, /お役立ちアプリBOX \/ 画像かんたん加工  v1\.2\.2/);
  assert.match(html, /画像かんたん加工 Version 1\.2\.2/);
  assert.match(help, /Version 1\.2\.2/);
  assert.match(help, /画像かんたん加工 Version 1\.2\.2/);
  assert.match(html, /image\.css\?v=1\.2\.2/);
  assert.match(html, /image\.js\?v=1\.2\.2/);
});
