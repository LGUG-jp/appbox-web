const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { read } = require("../../../tests/helpers.cjs");

function guard() {
  const calls = [], events = [];
  const window = {
    location: new URL("https://appbox.example/apps/flowchart/"),
    fetch: async (input, init) => { calls.push({ input, init }); return new Response("local"); },
    open() {}, addEventListener() {}, dispatchEvent: event => events.push(event.type),
  };
  vm.runInNewContext(read("apps/flowchart/asset-path.js"), {
    window, document: { addEventListener() {} }, URL, Request,
    CustomEvent: class { constructor(type) { this.type = type; } },
  });
  return { window, calls, events };
}

test("外部画像・ライブラリ投稿・同一サイトへの書込みを送信前に拒否する", async () => {
  const { window, calls, events } = guard();
  const blocked = [
    ["https://external.example/image.png"],
    [new URL("https://external.example/image.png")],
    [new Request("https://external.example/submit", { method: "POST", body: "diagram" })],
    ["./library", { method: "POST", body: "diagram" }],
    ["//external.example/image.png"],
    ["blob:https://external.example/id"],
  ];
  for (const args of blocked) await assert.rejects(window.fetch(...args), /外部通信/);
  assert.equal(calls.length, 0);
  assert.equal(events.length, blocked.length);
});

test("同梱フォント・ローカル画像を読み込み、外部へのリダイレクトは追わない", async () => {
  const { window, calls } = guard();
  const inputs = ["./assets/fonts/local.woff2", new URL("https://appbox.example/font.woff2"),
    new Request("https://appbox.example/font.woff2"), "data:font/woff2;base64,AA==", "blob:https://appbox.example/id"];
  for (const input of inputs) assert.equal(await (await window.fetch(input)).text(), "local");
  const controller = new AbortController();
  await window.fetch("./assets/font.woff2", { method: "HEAD", signal: controller.signal, redirect: "follow", cache: "force-cache" });
  assert.equal(calls.length, inputs.length + 1);
  for (const call of calls) assert.equal(call.init.redirect, "error");
  assert.equal(calls.at(-1).init.signal, controller.signal);
  assert.equal(calls.at(-1).init.cache, "force-cache");
});

test("PagesとIISのCSPは外部接続を許可せず、画像出力用のローカルWasmを許可する", () => {
  const html = read("apps/flowchart/index.html");
  const meta = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
  const header = read("apps/flowchart/web.config").match(/value="(default-src [^"]+)"/)[1];
  const directives = value => new Map(value.split(";").map(item => item.trim().split(/\s+/)).filter(([key]) => key).map(([key, ...values]) => [key, values.join(" ")]));
  const policy = directives(meta), iis = directives(header);
  for (const [key, value] of policy) assert.equal(iis.get(key), value, key);
  assert.equal(policy.get("connect-src"), "'self' blob: data:");
  assert.equal(policy.get("script-src"), "'self' 'wasm-unsafe-eval'");
  assert.equal(policy.get("frame-src"), "'none'");
  assert.equal(policy.get("form-action"), "'none'");
  assert.ok(html.indexOf("Content-Security-Policy") < html.indexOf("<script"));
  assert.ok(html.indexOf("asset-path.js") < html.indexOf('type="module"'));
});

test("外部ライブラリ公開メニューはCSSで隠し、React管理のDOMを削除しない", () => {
  const css = read("apps/flowchart/flow-app.css");
  assert.match(css, /\.library-menu \[data-testid="lib-dropdown--remove"\]\s*\{\s*display: none !important;\s*\}/);
  assert.doesNotMatch(read("apps/flowchart/notice.js"), /lib-dropdown--remove/);
});

test("現行CSPを維持し、SVGのサブセット化失敗と容量増加を既知の制約として案内する", () => {
  const policy = read("apps/flowchart/index.html").match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
  assert.doesNotMatch(policy, /'unsafe-eval'/);
  // wasm-unsafe-evalはEmscriptenのnew Functionを許可しない。
  // SVGは元のフォントを埋め込むため、容量増加を受け入れる方針。
  const readme = read("apps/flowchart/README.txt");
  assert.match(readme, /new Function/);
  assert.match(readme, /フォールバック/);
  for (const source of [readme, read("apps/flowchart/help.html")]) {
    assert.match(source, /サブセット化/);
    assert.match(source, /数百KB〜数MB/);
    assert.match(source, /PNG/);
  }
});
