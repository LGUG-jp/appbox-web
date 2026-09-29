"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { commonAssetVersion } = require("../../../tests/helpers.cjs");
const root = path.resolve(__dirname, "..");
const read = filename => fs.readFileSync(path.join(root, filename), "utf8");

for (const filename of ["index.html", "help.html"]) {
  test(`${filename}: 読込み先は同梱ファイルのみで、リンクと目次が存在する`, () => {
    const source = read(filename);
    const ids = Array.from(source.matchAll(/\bid="([^"]+)"/g), m => m[1]);
    assert.equal(new Set(ids).size, ids.length, "重複IDなし");
    for (const match of source.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
      const ref = match[1];
      assert.doesNotMatch(ref, /^(?:[a-z]+:|\/\/)/i, "外部・インラインURLを含めない");
      if (ref.startsWith("#")) assert.ok(ids.includes(ref.slice(1)), ref);
      else assert.ok(fs.existsSync(path.resolve(root, ref.split("?")[0])), ref);
    }
    assert.match(source, /connect-src 'none'/);
    assert.match(source, /form-action 'none'/);
    assert.doesNotMatch(source, /\bon\w+\s*=/i, "インラインイベントなし");
    assert.doesNotMatch(source, /<script(?![^>]*\bsrc=)/i, "インラインスクリプトなし");
  });
}
test("初期状態で個人情報なし・送信フォームなし", () => {
  const html = read("index.html");
  for (const form of html.matchAll(/<form\b[^>]*>/g)) {
    assert.match(form[0], /autocomplete="off"/);
    assert.doesNotMatch(form[0], /\b(?:action|method)=/);
  }
  for (const match of html.matchAll(/<input[^>]*\bname="([^"]+)"[^>]*>/g)) {
    assert.equal(match[1], "birth-format", "nameは生年月日の西暦／和暦ラジオのグループ化だけに使用");
    assert.match(match[0], /type="radio"/);
  }
  assert.doesNotMatch(html, /type="search"|id="reference-query"/);
  assert.match(html, /data-date-field="birth"/);
});
test("共通ヘッダーで本体・ヘルプから戻る先を区別する", () => {
  for (const filename of ["index.html", "help.html"]) {
    const html = read(filename);
    assert.match(html, /data-appbox-theme="blue"/);
    const header = html.indexOf('<header class="appbox-header">');
    assert.ok(header >= 0 && header < html.indexOf('<main '));
    assert.match(html, /class="appbox-header__brand" href="\.\.\/\.\.\/"/);
  }
  assert.match(read("index.html"), /class="appbox-back-button" href="\.\.\/\.\.\/">&lt; ポータルに戻る/);
  assert.match(read("help.html"), /class="appbox-back-button" href="\.\/index.html">&lt; アプリに戻る/);
});
test("ヘルプの目次と本文が対応し、共通スクリプトをCSP内で読み込む", () => {
  const html = read("help.html");
  const links = Array.from(html.matchAll(/class="appbox-help-nav-link" href="#([^"]+)"/g), m => m[1]);
  const sections = Array.from(html.matchAll(/<section class="help-section" id="([^"]+)"/g), m => m[1]);
  assert.ok(links.length > 0);
  assert.deepEqual(links, sections, "目次と本文を同じ順序で維持する");
  assert.match(html, /script-src 'self'/);
  assert.doesNotMatch(html, /'unsafe-inline'|'unsafe-eval'/);
  assert.match(html, /src="\.\.\/\.\.\/assets\/appbox-help\.js\?v=/);
  assert.doesNotMatch(html, /(?:href|src)="\.\/datetools/);
});
test("アプリに通信API・永続ストレージ・HTMLへの入力挿入を追加しない", () => {
  const js = read("datetools.js") + read("date-core.js");
  assert.doesNotMatch(js, /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|localStorage|sessionStorage|indexedDB)\b/);
  assert.doesNotMatch(js, /document\.cookie|\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML|console\.(?:log|info|debug)/);
  assert.match(js, /event\.preventDefault\(\)/);
  assert.match(js, /pagehide/);
  assert.match(js, /form-.*\.reset\(\)/);
});
test("CSSに外部依存がない", () => {
  for (const filename of ["datetools.css", "datetools-print.css", "../../assets/appbox-tokens.css", "../../assets/appbox-themes.css", "../../assets/appbox-base.css", "../../assets/appbox-chrome.css", "../../assets/appbox-help.css"]) {
    assert.doesNotMatch(read(filename), /@import\b|url\s*\(|@font-face/i);
  }
});
test("タブ・パネルの関連と狭い画面向けのレイアウト", () => {
  const html = read("index.html");
  assert.match(html, /class="appbox-app-intro appbox-app-intro--edge"/);
  assert.match(html, /class="appbox-shell"/);
  assert.match(html, /class="appbox-tabs appbox-print-hidden"/);
  assert.match(html, /class="appbox-tab is-active"[^>]*aria-selected="true"[^>]*tabindex="0"/);
  assert.match(html, /class="appbox-tab-panel tool-panel"/);
  assert.doesNotMatch(html, /\b(?:date-shell|view-tabs|view-tab)\b/);
  for (const mode of ["reference", "age"]) {
    assert.match(html, new RegExp(`aria-controls="panel-${mode}"`));
    assert.match(html, new RegExp(`aria-labelledby="view-${mode}"`));
  }
  assert.match(html, /id="error-age" role="alert"/);
  const css = read("datetools.css");
  assert.match(css, /grid-template-columns: repeat\(3, minmax\(0, 14\.5rem\)\)/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*grid-template-columns: repeat\(2, minmax\(0, 14\.5rem\)\)/);
  assert.match(css, /@media \(max-width: 540px\)[\s\S]*grid-template-columns: minmax\(0, 14\.5rem\)/);
  assert.match(css, /\.reference-scroll \{[^}]*overflow: visible/);
  assert.match(css, /\.tool-panel \{[^}]*overflow: visible/, "ページスクロール時のsticky見出しを阻害しない");
  assert.match(css, /@media \(max-width: 400px\)/);
  assert.match(read("../../assets/appbox-base.css"), /:focus-visible/);
});
test("印刷はA4縦横・3区分でレイアウトを切り替えられ、CSPに適合する", () => {
  const html = read("index.html"), css = read("datetools-print.css"), js = read("datetools.js");
  assert.match(html, /0〜34歳・35〜69歳・70〜100歳/);
  assert.match(html, /data-print-orientation="portrait"/);
  assert.match(html, /data-print-orientation="landscape"/);
  assert.match(css, /@page \{ size: A4 portrait;/);
  assert.match(css, /@page print-landscape \{ size: A4 landscape;/);
  assert.match(css, /page: print-landscape;/);
  assert.match(css, /data-print-orientation="landscape"/);
  assert.match(css, /\.print-table \.print-age \{ color: var\(--appbox-print-age\)/);
  assert.match(css, /\.era-combined/);
  assert.match(read("datetools.css"), /\.era-combined/);
  assert.match(js, /applyPrintOrientation/);
  assert.doesNotMatch(js, /made\(["']style["']\)|createElement\(["']style["']\)/, "動的styleタグ生成によるCSP違反を防止");
});
test("共通資産とアプリ資産のキャッシュ識別子を分離", () => {
  const commonVersion = commonAssetVersion();
  const indexHtml = read("index.html");
  assert.match(indexHtml, /datetools\.css\?v=1\.2\.5/);
  assert.match(indexHtml, /datetools-print\.css\?v=1\.2\.5/);
  assert.match(indexHtml, /date-core\.js\?v=1\.2\.3/);
  assert.match(indexHtml, /datetools\.js\?v=1\.2\.3/);

  for (const filename of ["index.html", "help.html"]) {
    const html = read(filename);
    for (const match of html.matchAll(/(?:href|src)="(\.\.\/\.\.\/assets\/[^"?]+)\?v=([^"]+)"/g)) {
      assert.equal(match[2], commonVersion, `${filename}: ${match[1]}`);
    }
  }
});
test("IISでも通信先とフォーム送信を制限する", () => {
  const config = read("web.config");
  assert.match(config, /connect-src 'none'/); assert.match(config, /form-action 'none'/);
  assert.match(config, /X-Content-Type-Options/); assert.match(config, /frame-ancestors 'self'/);
});
