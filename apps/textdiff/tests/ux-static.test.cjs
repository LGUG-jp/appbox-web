const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const appDirectory = path.resolve(__dirname, "..");
const read = fileName =>
  fs.readFileSync(path.join(appDirectory, fileName), "utf8");

const html = read("index.html");
const help = read("help.html");
const readme = read("README.txt");
const script = read("textdiff.js");

test("比較単位は3つのラジオボタンで表示する", () => {
  const radios = html.match(/name="diffMode"/g) || [];

  assert.equal(radios.length, 3);
  assert.doesNotMatch(html, /<select[^>]+id="diffMode"/);
  assert.match(html, /value="line-char"[\s\S]*checked/);
});

test("詳細カスタマイズは比較ボタンより後に配置する", () => {
  const compareButtonPosition = html.indexOf('id="compareBtn"');
  const customizationPosition = html.indexOf(
    "<legend>詳細カスタマイズ</legend>"
  );

  assert.ok(compareButtonPosition >= 0);
  assert.ok(customizationPosition > compareButtonPosition);
  assert.match(html, /<h3>比較ルール<\/h3>/);
  assert.match(html, /<h3>表示・操作<\/h3>/);
  assert.doesNotMatch(
    html,
    /正規化オプションを有効にした場合/
  );
});

test("README・ヘルプ・専用資源の機能版が一致する", () => {
  const version = readme.match(/^.*v(\d+\.\d+\.\d+)/)[1];
  for (const fileName of ["textdiff.css", "textdiff.js"]) {
    assert.ok(html.includes(`${fileName}?v=${version}`));
    assert.ok(readme.includes(`- ${fileName}?v=${version}`));
  }
  assert.ok(readme.includes(`本ツールはv${version}のため`));
  assert.ok(help.includes(`Version ${version}`));
});

test("ヘルプも新しい操作手順を案内する", () => {
  assert.match(help, />詳細カスタマイズ</);
  assert.match(help, /変更内容が比較結果へ自動で反映されます/);
  assert.match(help, /Version 1\.4\.0/);
});

test("JavaScriptに構文エラーがない", () => {
  assert.doesNotThrow(() => new vm.Script(script));
});
