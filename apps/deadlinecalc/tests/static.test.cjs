"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (filename) => fs.readFileSync(path.join(root, filename), "utf8");

for (const filename of ["index.html", "help.html", "maintenance.html"]) {
  test(`${filename}: 読込み先は同梱ファイルのみで、リンクと目次が存在する`, () => {
    const source = read(filename);
    const ids = Array.from(source.matchAll(/\bid="([^"]+)"/g), (m) => m[1]);
    assert.equal(new Set(ids).size, ids.length, "重複IDなし");

    for (const match of source.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
      const ref = match[1];
      assert.doesNotMatch(ref, /^(?:https?:|\/\/)/i, "外部URLを含めない");
      if (ref.startsWith("#")) {
        assert.ok(ids.includes(ref.slice(1)), `アンカー先存在: ${ref}`);
      } else {
        const filePath = path.resolve(root, ref.split("?")[0]);
        assert.ok(fs.existsSync(filePath), `参照先ファイル存在: ${ref}`);
      }
    }

    assert.match(source, /connect-src 'none'/);
    assert.match(source, /form-action 'none'/);
    assert.doesNotMatch(source, /\bon\w+\s*=/i, "インラインイベントなし");
    assert.doesNotMatch(source, /<script(?![^>]*\bsrc=)/i, "インラインスクリプトなし");
  });
}

test("未置換のプレースホルダーが一切残っていない", () => {
  for (const filename of [
    "index.html",
    "help.html",
    "maintenance.html",
    "maintenance.js",
    "app.css",
    "app.js",
    "custom-closed-days.js",
    "README.txt"
  ]) {
    const content = read(filename);
    assert.doesNotMatch(content, /\{\{[A-Z0-9_]+\}\}/, `${filename}に未置換プレースホルダーがあります`);
  }
});

test("外部通信API・永続ストレージへのアクセスがない", () => {
  const js = read("app.js") + read("calc-core.js") + read("holidays.js") + read("custom-closed-days.js") + read("maintenance.js");
  assert.doesNotMatch(
    js,
    /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|localStorage|sessionStorage|indexedDB)\b/
  );
  assert.doesNotMatch(js, /document\.cookie/);
});

test("CSSに外部依存がない", () => {
  const css = read("app.css");
  assert.doesNotMatch(css, /@import\b|url\s*\(|@font-face/i);
});

test("カレンダーおよび主要コンポーネントの構造とARIA属性が正しい", () => {
  const html = read("index.html");
  // ヘッダーが新標準テンプレート準拠であること（ヘルプとポータルに戻るのみ）
  assert.match(html, /<nav class="appbox-header__actions" aria-label="ページ操作">\s*<a class="appbox-help-button"[^>]*>[\s\S]*?<\/a>\s*<a class="appbox-back-button"[^>]*>&lt; ポータルに戻る<\/a>\s*<\/nav>/);
  assert.match(html, /<main id="main-content">[\s\S]*class="appbox-app-intro appbox-app-intro--edge(?: [^"]+)?"/);
  assert.match(html, /class="appbox-shell"/);
  assert.doesNotMatch(html, /class="(?:app-shell|calc-tabs|calc-tab|calc-tab-panel)\b/);
  // タブナビゲーション
  assert.match(html, /role="tablist"[^>]*aria-label="機能の切り替え"/);
  assert.match(html, /class="appbox-tabs appbox-print-hidden" role="tablist"/);
  assert.match(html, /class="appbox-tab is-active"[^>]*id="tab-calculator"[^>]*role="tab"[^>]*tabindex="0"/);
  assert.match(html, /class="appbox-tab" id="tab-duration"[^>]*role="tab"[^>]*aria-controls="panel-calculator"/);
  assert.match(html, /class="appbox-tab" id="tab-yearly"[^>]*role="tab"/);
  assert.match(html, /id="panel-calculator"[^>]*role="tabpanel"/);
  assert.match(html, /id="panel-yearly"[^>]*role="tabpanel"/);
  // カレンダーと主要コントロール
  assert.match(html, /id="calendar-grid"[^>]*role="grid"/);
  assert.match(html, /id="yearly-calendar-grid"/);
  assert.match(html, /role="radiogroup"[^>]*aria-label="計算モード"/);
  assert.match(html, /id="panel-deadline-ctrl"/);
  assert.match(html, /id="panel-duration-ctrl"/);
  // 祝日データメタ情報表示（収録期間・更新日）
  assert.match(html, /id="cal-holiday-meta-note"/);
  assert.match(html, /id="yearly-holiday-meta-note"/);
});

test("期限・期間の切替時に計算パネルのラベルを同期する", () => {
  assert.match(read("app.js"), /panelCalculator\.setAttribute\("aria-labelledby", isDuration \? "tab-duration" : "tab-calculator"\)/);
});

test("README.txtに必須セクションと祝日データ保守手順が記載されている", () => {
  const readme = read("README.txt");
  assert.match(readme, /■ 1\. 概要/);
  assert.match(readme, /■ 2\. 動作環境/);
  assert.match(readme, /■ 3\. 構成ファイル/);
  assert.match(readme, /■ 4\. 配置・初期設定/);
  assert.match(readme, /■ 5\. 主な機能と仕様/);
  assert.match(readme, /■ 6\. データの取扱い/);
  assert.match(readme, /■ 7\. セキュリティとプライバシー/);
  assert.match(readme, /■ 8\. アクセシビリティと操作性/);
  assert.match(readme, /■ 9\. 既知の制約/);
  assert.match(readme, /■ 10\. 運用・保守/);
  assert.match(readme, /祝日データの更新手順/);
  assert.match(readme, /■ 11\. 本番配置前の確認/);
  assert.match(readme, /■ 12\. 障害発生時の確認情報/);
  assert.match(readme, /■ 13\. ライセンス/);
  assert.match(readme, /■ 14\. 更新履歴/);
});
test("アプリ版数を画面・ヘルプ・固有資産へ揃える", () => {
  const html = read("index.html");
  const version = html.match(/app\.css\?v=([\d.]+)/)[1];
  const help = read("help.html");
  const readme = read("README.txt");
  assert.ok(html.includes(`app.js?v=${version}`));
  assert.ok(html.includes(`Version ${version}`));
  assert.ok(help.includes(`Version ${version}`));
  assert.ok(readme.includes(`v${version}`));
});
