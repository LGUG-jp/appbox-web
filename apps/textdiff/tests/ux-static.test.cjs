const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { commonAssetVersion } = require("../../../tests/helpers.cjs");

const appDirectory = path.resolve(__dirname, "..");
const read = fileName =>
  fs.readFileSync(path.join(appDirectory, fileName), "utf8");

const html = read("index.html");
const help = read("help.html");
const readme = read("README.txt");
const style = read("textdiff.css");
const script = read("textdiff.js");

test("比較単位は3つのラジオボタンで表示する", () => {
  const radios = html.match(/name="diffMode"/g) || [];

  assert.equal(radios.length, 3);
  assert.doesNotMatch(html, /<select[^>]+id="diffMode"/);
  assert.match(html, /value="line-char"[\s\S]*checked/);
});

test("比較条件は比較ボタンより後の折りたたみに1ブロックで配置する", () => {
  const compareButtonPosition = html.indexOf('id="compareBtn"');
  const customizationPosition = html.indexOf("比較条件");

  assert.ok(compareButtonPosition >= 0);
  assert.ok(customizationPosition > compareButtonPosition);
  assert.match(html, /<details class="option-disclosure">/);
  assert.doesNotMatch(html, /<details class="option-disclosure" open>/);
  assert.match(html, /class="option-grid"/);
  assert.doesNotMatch(html, /<h3>比較ルール<\/h3>/);
  assert.doesNotMatch(html, /<h3>表示・操作<\/h3>/);
  assert.match(html, /連続するスペース・タブを1つとして扱う/);
  assert.match(html, /全角・半角の英数字を同じ文字として扱う/);
  assert.match(html, /空行の有無を無視する/);
  assert.doesNotMatch(
    html,
    /正規化オプションを有効にした場合/
  );
});

test("比較単位の説明は必要なときだけ開く", () => {
  assert.match(html, /<details class="mode-help">/);
  assert.match(html, /id="modeHelpSummary">行内文字単位とは？/);
  assert.match(html, /id="modeNote"/);
  assert.doesNotMatch(html, /class="option-note mode-note"/);
});

test("スクロール連動は次の差分の右にトグルで配置する", () => {
  const nextPosition = html.indexOf('id="nextDiffBtn"');
  const syncPosition = html.indexOf('id="optSyncScroll"');

  assert.ok(nextPosition >= 0);
  assert.ok(syncPosition > nextPosition);
  assert.match(html, /id="optSyncScroll"[\s\S]*role="switch"/);
  assert.match(html, /id="optSyncScroll"[\s\S]*checked/);
  assert.match(html, /class="sync-toggle__track"/);
  assert.match(html, /id="syncScrollState">ON/);
  assert.match(
    style,
    /\.sync-toggle input:checked \+ \.sync-toggle__track/
  );
});

test("README・ヘルプ・専用資源の機能版が一致する", () => {
  const version = readme.match(/^.*v(\d+\.\d+\.\d+)/)[1];
  assert.equal(version, "1.4.2");
  assert.ok(html.includes("textdiff.css?v=1.4.2"));
  assert.ok(html.includes("textdiff.js?v=1.4.1"));
  assert.ok(readme.includes("- textdiff.css?v=1.4.2"));
  assert.ok(readme.includes("- textdiff.js?v=1.4.1"));
  assert.ok(readme.includes(`本ツールはv${version}です`));
  assert.ok(help.includes(`Version ${version}`));
});

test("ヘルプも新しい操作手順を案内する", () => {
  const version = readme.match(/^.*v(\d+\.\d+\.\d+)/)[1];

  assert.match(help, />比較条件</);
  assert.match(help, /初期状態では閉じています/);
  assert.match(help, /「次の差分」ボタンの右にある「スクロール連動」/);
  assert.match(help, /変更内容が比較結果へ自動で反映されます/);
  assert.ok(help.includes(`Version ${version}`));
});

test("本体とヘルプは新標準の外枠とblueテーマを使用する", () => {
  for (const page of [html, help]) {
    assert.match(page, /data-appbox-theme="blue"/);
    assert.match(page, /class="appbox-header"/);
    assert.match(page, /class="appbox-header__brand"/);
    assert.match(page, /class="appbox-back-button"/);
  }

  assert.match(html, /class="appbox-app-intro appbox-app-intro--edge"/);
  assert.match(help, /&lt; アプリに戻る/);
  assert.match(help, /class="appbox-help-grid help-panel"/);
  assert.match(help, /href="#quick-start"/);
  assert.match(help, /href="#advanced"/);
  assert.match(help, /href="#faq"/);
  assert.match(help, /href="#other"/);
  assert.ok(help.includes(`appbox-help.js?v=${commonAssetVersion()}`));
});

test("固有CSSは共通外枠・ボタン・ヘルプを重複定義しない", () => {
  assert.doesNotMatch(style, /\.(?:topbar|brand-mark|back-button|help-button)\s*\{/);
  assert.doesNotMatch(style, /\.btn(?:-primary|-secondary|-danger)?\s*\{/);
  assert.doesNotMatch(style, /\.help-section\s*\{/);
  assert.doesNotMatch(style, /\.help-nav\s*\{/);
});

test("画面確認後のUI調整を維持する", () => {
  const sectionSteps = html.match(/class="section-step"/g) || [];

  assert.equal(sectionSteps.length, 2);
  assert.match(html, /class="diff-card diff-card-old"/);
  assert.match(html, /class="diff-card diff-card-new"/);
  assert.match(html, /class="unified-title"/);
  assert.match(style, /textarea\s*\{[^}]*min-height:\s*200px/);
  assert.match(style, /\.unified-card \.diff-output\s*\{[^}]*min-height:\s*120px/);
  assert.match(style, /#clearBtn\s*\{[^}]*background:\s*#fff7f8/);
});

test("人間レビュー後の比較画面改善を維持する", () => {
  assert.doesNotMatch(
    html,
    /追加・削除された箇所をブラウザ内で比較します/
  );

  assert.match(
    html,
    /id="compareBtn"[\s\S]*<circle cx="11" cy="11" r="6"/
  );
  assert.match(
    html,
    /id="clearBtn"[\s\S]*<path d="M3 6h18"/
  );

  assert.equal((html.match(/class="stat-value"/g) || []).length, 3);
  assert.equal((html.match(/class="stat-unit"/g) || []).length, 3);
  assert.equal((html.match(/class="stat-icon"/g) || []).length, 3);
  assert.match(
    html,
    /id="statAdded">0<\/strong>[\s\S]*id="unitAdded">文字/
  );
  assert.match(
    html,
    /id="statChanges">0<\/strong>[\s\S]*class="stat-unit">か所/
  );
  assert.match(
    style,
    /\.stat-icon\s*\{[^}]*width:\s*34px[^}]*height:\s*34px/
  );
  assert.match(
    style,
    /\.stat-content\s*\{[^}]*display:\s*flex[^}]*align-items:\s*baseline/
  );

  assert.match(
    style,
    /\.diff-output \.current-diff\s*\{[^}]*background-image:[^}]*linear-gradient/
  );
  assert.match(
    style,
    /--diff-add:\s*#287a45/
  );
  assert.match(
    style,
    /--diff-remove:\s*#ad3240/
  );
  assert.match(
    style,
    /--diff-modified:\s*#876000/
  );
  assert.match(
    style,
    /--diff-current:\s*#c45d00/
  );
  assert.match(
    style,
    /\.diff-output \.inserted\s*\{[^}]*color:\s*var\(--diff-add\)/
  );
  assert.match(
    style,
    /\.diff-position--modified\s*\{[^}]*background:\s*var\(--diff-modified-soft\)/
  );
  assert.match(
    style,
    /\.diff-output \.current-diff\s*\{[^}]*outline:\s*none/
  );
  assert.doesNotMatch(
    style,
    /\.diff-output \.current-diff\s*\{[^}]*outline:\s*3px/
  );
});

test("一致件数と一致率は画面・処理・ヘルプから削除する", () => {
  for (const id of ["statEqual", "unitEqual", "statSimilarity"]) {
    assert.doesNotMatch(html, new RegExp(`id="${id}"`));
    assert.doesNotMatch(script, new RegExp(id));
  }

  assert.doesNotMatch(html, /一致率/);
  assert.doesNotMatch(help, /一致率/);
  assert.doesNotMatch(readme, /一致率/);
  assert.doesNotMatch(script, /equalCount/);
  assert.equal((html.match(/class="stat-value"/g) || []).length, 3);
  assert.match(style, /\.stats\s*\{[^}]*repeat\(3,/);
});

test("比較単位の補足と入力カードの間隔を維持する", () => {
  assert.match(
    style,
    /\.mode-help\s*\{[^}]*margin:\s*-6px 0 16px/
  );
  assert.match(
    style,
    /\.editors\s*\{[^}]*margin-top:\s*6px/
  );
  assert.match(
    style,
    /\.editors\s*\{[^}]*align-items:\s*start/
  );
});

test("新しい文章カードは追加差分と同系色で表示する", () => {
  assert.match(
    style,
    /\.card-heading--new\s*\{[^}]*color:\s*var\(--diff-add\)/
  );
  assert.match(
    style,
    /\.editor-card-new\s*\{[^}]*border-top:\s*3px solid var\(--diff-add-border\)/
  );
  assert.match(
    style,
    /\.editor-card-new \.editor-head\s*\{[^}]*var\(--diff-add-soft\)/
  );
  assert.match(
    style,
    /\.diff-card-new \.diff-card-head\s*\{[^}]*color:\s*var\(--diff-add\)/
  );
});

test("追加差分は画面・印刷・Word向けコピーと説明で緑に揃える", () => {
  const printStyle = style.slice(style.indexOf("@media print"));
  assert.match(
    printStyle,
    /\.diff-output \.inserted\s*\{[^}]*color:\s*var\(--diff-add\)[^}]*background:\s*var\(--diff-add-soft\) !important/
  );
  assert.match(script, /segment\.type === "insert" \? "#287a45"/);
  assert.match(html, /追加は緑、削除は赤＋取り消し線/);
  assert.match(help, /追加は緑文字、削除は赤文字と取り消し線/);
  assert.match(readme, /- 追加: 緑文字/);
});

test("現在差分のアンダーラインは目立つ暖色にする", () => {
  assert.match(
    style,
    /--diff-current-underline:\s*#f0a500/
  );
  assert.match(
    style,
    /\.diff-output \.current-diff\s*\{[^}]*inset 0 -3px 0 var\(--diff-current-underline\)/
  );
});

test("現在差分の強調は追加差分と区別できるオレンジにする", () => {
  assert.match(
    style,
    /--diff-current:\s*#c45d00/
  );
  assert.match(
    style,
    /--diff-current-soft:\s*#fff1df/
  );
  assert.match(
    style,
    /--diff-current-border:\s*#efb36a/
  );
  assert.match(
    style,
    /\.diff-output \.current-diff\s*\{[^}]*rgba\(240, 165, 0/
  );
  assert.match(
    style,
    /\.legend-swatch\.current\s*\{[^}]*border:\s*1px solid var\(--diff-current-border\)/
  );
});

test("差分色の凡例に現在位置を表示する", () => {
  const navigationPosition = html.indexOf('id="diffNavigation"');
  const legendPosition = html.indexOf('class="legend"');
  const oldCardPosition = html.indexOf('class="diff-card diff-card-old"');

  assert.match(html, /現在の差分/);
  assert.match(html, /class="legend-swatch current"/);
  assert.ok(legendPosition > navigationPosition);
  assert.ok(legendPosition < oldCardPosition);
});

test("JavaScriptに構文エラーがない", () => {
  assert.doesNotThrow(() => new vm.Script(script));
});
