const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const numberingModule = import("../page-numbering.mjs");
const coreModule = import("../editor-core.mjs");
const source = fs.readFileSync(path.join(__dirname, "../app.js"), "utf8");
const measure = (text, size) => text.length * size * .6;
const settings = { startPage: 2, startNumber: 1, fontSize: 12, position: "bottom-center" };
const pages = () => Array.from({ length: 3 }, (_, index) => ({
  id: `p${index}`, sourceId: "source", sourceIndex: index,
  width: 595, height: 842, baseRotation: 0, rotationExtra: 0, annotations: [],
}));
const plain = value => JSON.parse(JSON.stringify(value));
const section = (from, to) => source.slice(source.indexOf(from), source.indexOf(to));

test("表紙を除いて採番し、再設定は番号のみを置き換える", async () => {
  const { createPageNumberPlan, replacePageNumbers } = await numberingModule;
  const original = pages(); original[1].annotations.push({ id: "figure", type: "rect" });
  const before = structuredClone(original);
  const first = replacePageNumbers(original, createPageNumberPlan(original, settings, measure));
  assert.deepEqual(first.map(p => p.pageNumber?.number), [undefined, 1, 2]);
  const second = replacePageNumbers(first, createPageNumberPlan(first, { ...settings, startPage: 3, startNumber: 20 }, measure));
  assert.deepEqual(second.map(p => p.pageNumber?.number), [undefined, undefined, 20]);
  assert.deepEqual(second[1].annotations, before[1].annotations);
  assert.deepEqual(original, before);
  first[1].pageNumber.number = 99;
  assert.equal(second[2].pageNumber.number, 20);
});

test("全6位置と0／90／180／270度の回転で番号を表示ページ内に配置する", async () => {
  const { PAGE_NUMBER_POSITIONS, createPageNumberPlan, pageNumberAnnotation } = await numberingModule;
  for (const position of PAGE_NUMBER_POSITIONS) for (const baseRotation of [0, 90, 180, 270]) {
    const page = { ...pages()[0], baseRotation };
    const plan = createPageNumberPlan([page], { ...settings, startPage: 1, position, startNumber: 999999 }, measure);
    const a = plan.entries[0].annotation;
    const [w, h] = baseRotation % 180 ? [842, 595] : [595, 842];
    assert.ok(a.x >= 0 && a.y >= 0 && a.x + a.w <= w && a.y + a.h <= h);
    if (position.endsWith("center")) assert.equal(a.x + a.w / 2, w / 2);
    if (position.endsWith("left")) assert.ok(a.x < w / 2);
    if (position.endsWith("right")) assert.ok(a.x > w / 2);
    assert.equal(position.startsWith("top"), a.y < h / 2);
    assert.deepEqual(pageNumberAnnotation({ ...page, pageNumber: plan.entries[0].pageNumber }, measure), a);
    const rotated = pageNumberAnnotation({ ...page, rotationExtra: 90, pageNumber: plan.entries[0].pageNumber }, measure);
    const nextHeight = baseRotation % 180 ? 842 : 595;
    assert.equal(position.startsWith("top"), rotated.y < nextHeight / 2);
  }
});

test("開始番号0・最終999999・300ページに対応し、範囲外と後続ページの収まりを検証する", async () => {
  const { createPageNumberPlan } = await numberingModule;
  const all = Array.from({ length: 300 }, (_, i) => ({ ...pages()[0], id: `p${i}` }));
  assert.equal(createPageNumberPlan(all, { ...settings, startPage: 1, startNumber: 0 }, measure).lastNumber, 299);
  assert.equal(createPageNumberPlan(pages(), { ...settings, startNumber: 999998 }, measure).lastNumber, 999999);
  for (const values of [
    { startPage: 0 }, { startPage: 4 }, { startPage: 1.5 }, { startPage: NaN },
    { startNumber: -1 }, { startNumber: 1.5 }, { startNumber: 999999 },
    { fontSize: 5 }, { fontSize: 73 }, { fontSize: 6.1 }, { fontSize: NaN }, { position: "middle" },
  ]) assert.throws(() => createPageNumberPlan(pages(), { ...settings, ...values }, measure));
  const small = pages(); small[2].width = 10;
  assert.throws(() => createPageNumberPlan(small, settings, measure), /3ページ目/);
  assert.ok(small.every(p => !p.pageNumber));
  assert.throws(() => createPageNumberPlan(pages(), settings, () => NaN), /収まりません/);
});

test("見開き配置は番号の奇数・偶数で、左右または上下を軸ごとに入れ替える", async () => {
  const { PAGE_NUMBER_POSITIONS, resolvePageNumberPosition } = await numberingModule;
  const flip = (position, axis) => {
    const [v, h] = position.split("-");
    if (axis === "x") return `${v}-${{ left: "right", right: "left" }[h] ?? h}`;
    return `${{ top: "bottom", bottom: "top" }[v]}-${h}`;
  };
  for (const position of PAGE_NUMBER_POSITIONS) {
    for (const number of [0, 1, 2, 7, 10]) {
      assert.equal(resolvePageNumberPosition(position, "same", number), position);
      assert.equal(resolvePageNumberPosition(position, "mirror-x", number), number % 2 ? position : flip(position, "x"));
      assert.equal(resolvePageNumberPosition(position, "mirror-y", number), number % 2 ? position : flip(position, "y"));
    }
  }
  assert.equal(resolvePageNumberPosition("top-center", "mirror-x", 2), "top-center");
  assert.equal(resolvePageNumberPosition("top-center", "mirror-y", 2), "bottom-center");
});

test("書式は番号のみ・番号／最終番号・ハイフン囲みを作り、最終番号は再設定の対象範囲から決める", async () => {
  const { pageNumberText, createPageNumberPlan } = await numberingModule;
  assert.equal(pageNumberText({ number: 3 }), "3");
  assert.equal(pageNumberText({ number: 3, format: "number" }), "3");
  assert.equal(pageNumberText({ number: 3, format: "number-last", lastNumber: 10 }), "3 / 10");
  assert.equal(pageNumberText({ number: 3, format: "dash" }), "- 3 -");
  const plan = createPageNumberPlan(pages(), { ...settings, startNumber: 20, format: "number-last" }, measure);
  assert.deepEqual(plan.entries.map(e => e.annotation.text), ["20 / 21", "21 / 21"]);
  assert.ok(plan.entries.every(e => e.pageNumber.lastNumber === 21));
  const zero = createPageNumberPlan(pages(), { ...settings, startPage: 3, startNumber: 0, format: "number-last" }, measure);
  assert.equal(zero.entries[0].annotation.text, "0 / 0");
  const plain = createPageNumberPlan(pages(), settings, measure);
  assert.ok(plain.entries.every(e => !("lastNumber" in e.pageNumber)));
  assert.throws(() => createPageNumberPlan(pages(), { ...settings, format: "roman" }, measure), /書式/);
  // Every target is measured with its decorated text, so a long "999998 / 999999" must still fit.
  const narrow = pages().map(p => ({ ...p, width: 70 }));
  assert.doesNotThrow(() => createPageNumberPlan(narrow, { ...settings, startNumber: 999998, fontSize: 6 }, measure));
  assert.throws(() => createPageNumberPlan(narrow, { ...settings, startNumber: 999998, fontSize: 6, format: "number-last" }, measure), /2ページ目/);
});

test("余白の自動は従来の位置を保ち、指定時は文字枠の端までをmmで上下・左右に適用する", async () => {
  const { createPageNumberPlan, pageNumberAnnotation } = await numberingModule;
  const page = pages()[0], padding = 4;
  const auto = createPageNumberPlan([page], { ...settings, startPage: 1, position: "bottom-left" }, measure).entries[0];
  assert.ok(!("marginX" in auto.pageNumber) && !("marginY" in auto.pageNumber));
  assert.equal(auto.annotation.x, 72 / 2.54);
  assert.equal(auto.annotation.y + auto.annotation.h, 842 - 72 / 2.54);
  const mm = v => v * 72 / 25.4;
  const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≒ ${expected}`);
  for (const [position, check] of [
    ["top-left", a => { near(a.x + padding, mm(15)); near(a.y + padding, mm(5)); }],
    ["bottom-right", a => { near(595 - (a.x + a.w - padding), mm(15)); near(842 - (a.y + a.h - padding), mm(5)); }],
    ["top-center", a => { near(a.x + a.w / 2, 595 / 2); near(a.y + padding, mm(5)); }],
  ]) {
    const entry = createPageNumberPlan([page], { ...settings, startPage: 1, position, marginX: 15, marginY: 5 }, measure).entries[0];
    assert.equal(entry.pageNumber.marginX, 15); assert.equal(entry.pageNumber.marginY, 5);
    check(entry.annotation);
    assert.deepEqual(pageNumberAnnotation({ ...page, pageNumber: entry.pageNumber }, measure), entry.annotation);
  }
  for (const values of [
    { marginX: 2.5, marginY: 10 }, { marginX: 10, marginY: 50.5 }, { marginX: 10.2, marginY: 10 },
    { marginX: NaN, marginY: 10 }, { marginX: 10 }, { marginY: 10 },
  ]) assert.throws(() => createPageNumberPlan(pages(), { ...settings, ...values }, measure), /余白/);
  // An explicit margin is never shrunk silently: a page it does not fit on stops the whole plan.
  const small = pages(); small[2].height = 100;
  assert.throws(() => createPageNumberPlan(small, { ...settings, marginX: 10, marginY: 50 }, measure), /3ページ目/);
});

test("見開き配置は回転後の表示ページ上で反転し、適用した各ページの設定を保持する", async () => {
  const { createPageNumberPlan, pageNumberAnnotation } = await numberingModule;
  const four = Array.from({ length: 4 }, (_, i) => ({ ...pages()[0], id: `p${i}`, baseRotation: i === 3 ? 90 : 0 }));
  const plan = createPageNumberPlan(four, { ...settings, startPage: 1, startNumber: 1, position: "bottom-right", layout: "mirror-x" }, measure);
  const [w0] = [595];
  assert.ok(plan.entries[0].annotation.x > w0 / 2);
  assert.ok(plan.entries[1].annotation.x < w0 / 2);
  assert.ok(plan.entries[2].annotation.x > w0 / 2);
  assert.ok(plan.entries[3].annotation.x < 842 / 2 && plan.entries[3].annotation.y > 595 / 2);
  assert.ok(plan.entries.every(e => e.pageNumber.position === "bottom-right" && e.pageNumber.layout === "mirror-x"));
  const vertical = createPageNumberPlan(four, { ...settings, startPage: 1, startNumber: 2, position: "bottom-center", layout: "mirror-y" }, measure);
  assert.deepEqual(vertical.entries.map(e => e.annotation.y < 300), [true, false, true, false]);
  assert.equal(pageNumberAnnotation({ ...four[1], pageNumber: vertical.entries[1].pageNumber }, measure).y, vertical.entries[1].annotation.y);
  assert.throws(() => createPageNumberPlan(four, { ...settings, layout: "booklet" }, measure), /配置/);
  // Older page numbers without layout or format keep their current placement and text.
  const legacy = pageNumberAnnotation({ ...four[0], pageNumber: { number: 2, fontSize: 12, position: "bottom-right" } }, measure);
  assert.equal(legacy.text, "2"); assert.ok(legacy.x > w0 / 2);
});

test("番号だけを全ページから外し、図形・透かし・元の配列は変えない", async () => {
  const { createPageNumberPlan, replacePageNumbers, removePageNumbers } = await numberingModule;
  const original = pages(); original[0].annotations.push({ id: "figure", type: "rect" }); original[1].watermark = { text: "案" };
  const numbered = replacePageNumbers(original, createPageNumberPlan(original, { ...settings, startPage: 1 }, measure));
  const before = structuredClone(numbered);
  const removed = removePageNumbers(numbered);
  assert.ok(removed.every(p => !("pageNumber" in p)));
  assert.deepEqual(removed[0].annotations, before[0].annotations);
  assert.deepEqual(removed[1].watermark, before[1].watermark);
  assert.deepEqual(numbered, before);
  assert.equal(removePageNumbers(original).length, 3);
});

// Production handlers run against a minimal DOM; this does not verify browser layout or PDF.js rendering.
async function fixture() {
  const numbering = await numberingModule, core = await coreModule;
  const elements = new Map(), renderTasks = [], markers = [], messages = [];
  class Element {
    constructor(tag = "div") { this.tag = tag; this.children = []; this.attrs = {}; this.listeners = {}; this.disabled = false; }
    set value(v) { this.rawValue = String(v); }
    get value() { return this.rawValue; }
    get valueAsNumber() { return this.rawValue === "" ? NaN : Number(this.rawValue); }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    classList = { add() {} };
    append(...children) { this.children.push(...children); }
    replaceChildren() { this.children = []; }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    showModal() { this.open = true; }
    close() { this.open = false; this.listeners.close?.(); }
    getContext() {
      if (!this.context) this.context = { font: "400 12px Arial", measureText(text) {
        return { width: measure(text, Number(this.font.match(/([\d.]+)px/)[1])) };
      } };
      return this.context;
    }
  }
  const $ = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const state = { pages: pages(), currentPageId: "p1", pageSelection: new Set(["p0"]), figureSelection: new Set(),
    history: [], future: [], mode: "overview", busy: false, sources: new Map() };
  state.sources.set("source", { id: "source", name: "synthetic.pdf", pdfjsDoc: {
    numPages: 3, getPage: async () => ({ getViewport: ({ scale, rotation }) => {
      const [w, h] = rotation % 180 ? [842, 595] : [595, 842]; return { width: w * scale, height: h * scale };
    }, render: () => {
      let resolve; const task = { promise: new Promise(r => { resolve = r; }), resolve: () => resolve(), cancel() { this.canceled = true; resolve(); } };
      renderTasks.push(task); return task;
    } }),
  } });
  const context = vm.createContext({ embeddedImages: new WeakMap(), ...numbering, ...core, $, state, console,
    clone: structuredClone, normRotation: n => (n % 360 + 360) % 360,
    fontStackFor: () => "Arial", document: { createElement: tag => new Element(tag), createElementNS: (_, tag) => new Element(tag) },
    pageDisplaySize: p => (p.baseRotation + p.rotationExtra) % 180 ? { width: p.height, height: p.width } : { width: p.width, height: p.height },
    currentPage: () => state.pages.find(p => p.id === state.currentPageId),
    finishTextEditing() {}, syncUI() {}, syncUndoRedo() {}, syncThumbnailSelection() {}, renderAnnotations() {},
    renderThumbnails() {}, renderCurrentPage() {}, releaseUnusedSources: async () => {},
    updateThumbnailAnnotationMarker: id => markers.push(id), updateStatus: s => messages.push(s), showToast: s => messages.push(s),
    setBusy: v => { state.busy = v; },
  });
  vm.runInContext(section("function snapshot()", "function currentTotalSourceBytes()"), context);
  vm.runInContext(section("function pushHistory(", "function syncUndoRedo()"), context);
  vm.runInContext(section("function svgNode(", "function renderFigures()"), context);
  vm.runInContext(section("function effectivePageRotation(", "async function drawAnnotationsOnPdf("), context);
  vm.runInContext("setupPageNumbering()", context);
  const run = code => vm.runInContext(code, context);
  const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
  return { $, state, context, run, flush, renderTasks, markers, messages };
}

test("適用前は無変更、適用・再設定はそれぞれ1回のUndo／Redoで復元できる", async () => {
  const f = await fixture(); const original = plain(f.state.pages);
  f.run("openPageNumberDialog()"); await f.flush();
  assert.deepEqual(plain(f.state.pages), original); assert.equal(f.state.history.length, 0);
  assert.equal(f.$("pageNumberApply").disabled, true);
  f.renderTasks.at(-1).resolve(); await f.flush();
  assert.equal(f.$("pageNumberApply").disabled, false);
  f.$("pageNumberForm").listeners.submit({ preventDefault() {} });
  assert.deepEqual(f.markers, ["p0", "p1", "p2"]);
  assert.deepEqual(f.state.pages.map(p => p.pageNumber?.number), [1, 2, 3]);
  assert.equal(f.state.history.length, 1);
  await f.run("undo()"); assert.deepEqual(plain(f.state.pages), original);
  await f.run("redo()"); assert.deepEqual(f.state.pages.map(p => p.pageNumber?.number), [1, 2, 3]);
  f.run("openPageNumberDialog()"); f.$("pageNumberStartPage").value = 2;
  f.$("pageNumberStartNumber").value = 10; f.run("previewPageNumbers()"); await f.flush();
  f.renderTasks.at(-1).resolve(); await f.flush();
  f.$("pageNumberForm").listeners.submit({ preventDefault() {} });
  assert.deepEqual(f.state.pages.map(p => p.pageNumber?.number), [undefined, 10, 11]);
  assert.equal(f.state.history.length, 2);
  await f.run("undo()"); assert.deepEqual(f.state.pages.map(p => p.pageNumber?.number), [1, 2, 3]);
  await f.run("redo()"); assert.deepEqual(f.state.pages.map(p => p.pageNumber?.number), [undefined, 10, 11]);
});

test("古いプレビュー・キャンセル・入力エラー・描画失敗では番号や履歴を変更しない", async () => {
  const f = await fixture(); const original = plain(f.state.pages);
  f.run("openPageNumberDialog()"); await f.flush(); const old = f.renderTasks.at(-1);
  f.$("pageNumberStartPage").value = 2; f.run("previewPageNumbers()"); await f.flush();
  assert.equal(old.canceled, true); assert.equal(f.$("pageNumberApply").disabled, true);
  const latest = f.renderTasks.at(-1); latest.resolve(); await f.flush();
  assert.equal(f.$("pageNumberPreview").children.length, 2);
  let prevented = 0, stopped = 0;
  f.$("pageNumberDialog").listeners.drop({ preventDefault() { prevented++; }, stopPropagation() { stopped++; } });
  assert.equal(prevented, 1); assert.equal(stopped, 1);
  f.$("pageNumberCancel").listeners.click();
  assert.deepEqual(plain(f.state.pages), original); assert.equal(f.state.history.length, 0);
  f.run("openPageNumberDialog()"); await f.flush();
  const canceledByEscape = f.renderTasks.at(-1);
  f.$("pageNumberDialog").listeners.cancel(); f.$("pageNumberDialog").close();
  assert.equal(canceledByEscape.canceled, true);
  assert.deepEqual(plain(f.state.pages), original);
  f.run("openPageNumberDialog()"); f.$("pageNumberStartNumber").value = "";
  await f.run("previewPageNumbers()");
  assert.equal(f.$("pageNumberApply").disabled, true); assert.match(f.$("pageNumberError").textContent, /整数/);
  f.$("pageNumberForm").listeners.submit({ preventDefault() {} });
  assert.deepEqual(plain(f.state.pages), original);
  f.$("pageNumberDialog").close(); f.state.sources.get("source").pdfjsDoc.getPage = async () => { throw new Error("描画失敗"); };
  f.run("openPageNumberDialog()"); await f.flush();
  assert.equal(f.$("pageNumberApply").disabled, true); assert.match(f.$("pageNumberError").textContent, /描画失敗/);
  assert.equal(f.state.history.length, 0);
});

test("配置・書式・余白をダイアログから適用し、開き直すと最初の番号の設定を復元する", async () => {
  const f = await fixture();
  f.run("openPageNumberDialog()"); await f.flush();
  assert.equal(f.$("pageNumberLayout").value, "same");
  assert.equal(f.$("pageNumberFormat").value, "number");
  assert.equal(f.$("pageNumberMarginMode").value, "auto");
  assert.equal(f.$("pageNumberMarginFields").hidden, true);
  // Hidden margin inputs are disabled so the browser does not validate them while the margin is automatic.
  assert.equal(f.$("pageNumberMarginX").disabled, true); assert.equal(f.$("pageNumberMarginY").disabled, true);
  f.$("pageNumberStartPage").value = 1; f.$("pageNumberPosition").value = "bottom-right";
  f.$("pageNumberLayout").value = "mirror-x"; f.$("pageNumberFormat").value = "number-last";
  f.$("pageNumberMarginMode").value = "custom"; f.$("pageNumberMarginY").value = 7.5; f.$("pageNumberMarginX").value = 15;
  f.run("previewPageNumbers()"); await f.flush();
  assert.equal(f.$("pageNumberMarginFields").hidden, false);
  assert.equal(f.$("pageNumberMarginX").disabled, false); assert.equal(f.$("pageNumberMarginY").disabled, false);
  assert.match(f.$("pageNumberSummary").textContent, /「1 \/ 3」〜「3 \/ 3」/);
  assert.match(f.$("pageNumberSummary").textContent, /奇数の番号は下・右、偶数の番号は下・左/);
  f.renderTasks.at(-1).resolve(); await f.flush();
  f.$("pageNumberForm").listeners.submit({ preventDefault() {} });
  assert.deepEqual(plain(f.state.pages.map(p => p.pageNumber)), [1, 2, 3].map(number => ({
    number, fontSize: 12, position: "bottom-right", layout: "mirror-x", format: "number-last", lastNumber: 3, marginX: 15, marginY: 7.5,
  })));
  f.$("pageNumberLayout").value = "same"; f.$("pageNumberFormat").value = "dash"; f.$("pageNumberMarginMode").value = "auto";
  f.run("openPageNumberDialog()"); await f.flush();
  assert.equal(f.$("pageNumberLayout").value, "mirror-x");
  assert.equal(f.$("pageNumberFormat").value, "number-last");
  assert.equal(f.$("pageNumberMarginMode").value, "custom");
  assert.equal(String(f.$("pageNumberMarginX").value), "15"); assert.equal(String(f.$("pageNumberMarginY").value), "7.5");
  // Old page numbers without these settings reopen as the automatic margin and the original layout.
  f.$("pageNumberDialog").close();
  f.state.pages = pages().map((p, i) => ({ ...p, pageNumber: { number: i + 1, fontSize: 12, position: "top-left" } }));
  f.run("openPageNumberDialog()"); await f.flush();
  assert.equal(f.$("pageNumberLayout").value, "same"); assert.equal(f.$("pageNumberFormat").value, "number");
  assert.equal(f.$("pageNumberMarginMode").value, "auto"); assert.equal(f.$("pageNumberMarginFields").hidden, true);
});

test("ページ番号の削除は入力エラー中でも全ページの番号だけを1回の履歴で外し、番号がなければ押せない", async () => {
  const f = await fixture();
  f.run("openPageNumberDialog()"); await f.flush();
  assert.equal(f.$("pageNumberDelete").disabled, true);
  f.renderTasks.at(-1).resolve(); await f.flush();
  f.$("pageNumberForm").listeners.submit({ preventDefault() {} });
  f.state.pages[0].annotations.push({ id: "keep", type: "rect" });
  const numbered = plain(f.state.pages);
  f.run("openPageNumberDialog()"); await f.flush();
  assert.equal(f.$("pageNumberDelete").disabled, false);
  f.$("pageNumberStartNumber").value = ""; await f.run("previewPageNumbers()");
  assert.equal(f.$("pageNumberApply").disabled, true);
  assert.equal(f.$("pageNumberDelete").disabled, false);
  f.markers.length = 0;
  f.$("pageNumberDelete").listeners.click();
  assert.ok(f.state.pages.every(p => !p.pageNumber));
  assert.deepEqual(f.state.pages[0].annotations, numbered[0].annotations);
  assert.equal(f.$("pageNumberDialog").open, false);
  assert.deepEqual(f.markers, ["p0", "p1", "p2"]);
  assert.match(f.messages.at(-1), /3ページのページ番号を削除しました/);
  assert.equal(f.state.history.length, 2);
  await f.run("undo()"); assert.deepEqual(plain(f.state.pages), numbered);
  await f.run("redo()"); assert.ok(f.state.pages.every(p => !p.pageNumber));
  const historyLength = f.state.history.length;
  f.run("deletePageNumbers()");
  assert.equal(f.state.history.length, historyLength);
});

test("番号が収まらなくなる回転はページ・図形・履歴を変えず中止する", async () => {
  const f = await fixture(); f.state.pages = [{ ...pages()[0], width: 80, pageNumber: { number: 1, fontSize: 72, position: "bottom-center" } }];
  f.state.pageSelection = new Set(["p0"]);
  f.context.selectedPages = () => f.state.pages;
  vm.runInContext(section("function transformAnnotationsForRotation(", "function deleteCurrentPage()"), f.context);
  const before = plain(f.state.pages); f.run("rotateCurrent(90)");
  assert.deepEqual(plain(f.state.pages), before); assert.equal(f.state.history.length, 0);
  assert.match(f.messages.at(-1), /回転できません/);
});

for (const blank of [false, true]) {
test(`実pdf-libで${blank ? "空白" : "描画済み"}ページの番号付き全体保存・選択保存を再読込みし、回転と番号画像を保持する`, async () => {
  const { PDFDocument, PDFName, rgb, degrees } = await import("../vendor/pdf-lib.esm.js");
  const { embedTextPng } = await import("../text-image.mjs");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAQAAAABCAYAAAD5PA/NAAAAGUlEQVR4nGNgYGBg+P//fwMDA8P//wwMDgAupwW8KZ3epgAAAABJRU5ErkJggg==", "base64");
  const f = await fixture(); const input = await PDFDocument.create();
  f.state.pages = Array.from({ length: 4 }, (_, i) => ({ ...pages()[0], id: `p${i}`, sourceIndex: i,
    baseRotation: blank && i === 1 ? 0 : i * 90, rotationExtra: blank && i === 1 ? 90 : 0,
    pageNumber: { number: i + 1, fontSize: 12, position: "bottom-right" } }));
  for (const p of f.state.pages) {
    const page = input.addPage([595, 842]); page.setRotation(degrees(p.baseRotation));
    if (!blank) page.drawRectangle({ x: 50, y: 50, width: 10, height: 10, color: rgb(1, 0, 0) });
  }
  f.state.sources.get("source").bytes = await input.save(); f.state.sources.get("source").pdfjsDoc.numPages = 4;
  if (blank) {
    const original = await PDFDocument.load(f.state.sources.get("source").bytes);
    assert.ok(original.getPages().every(page => !page.node.Contents()));
  }
  const numberedTexts = [], downloads = [];
  // pdf-lib checks Array with instanceof; bridge arrays across the VM realm only.
  const pdfBridge = { load: PDFDocument.load.bind(PDFDocument), create: async options => {
    const doc = await PDFDocument.create(options);
    const copyPages = doc.copyPages.bind(doc), addPage = doc.addPage.bind(doc);
    doc.copyPages = (from, indices) => copyPages(from, Array.from(indices));
    doc.addPage = page => addPage(Array.isArray(page) ? Array.from(page) : page);
    return doc;
  } };
  Object.assign(f.context, { PDFDocument: pdfBridge, rgb, degrees, embedTextPng,
    hexToRgb: () => [0, 0, 0], isLine: () => false,
    renderTextAnnotationPng: async a => { numberedTexts.push(plain(a)); return png; },
    confirm: () => true, selectedPages: () => f.state.pages.filter(p => f.state.pageSelection.has(p.id)),
  });
  vm.runInContext(section("function drawEmbeddedPage(", "function restoreIntroDisclosure()"), f.context);
  f.context.downloadPdfBytes = (bytes, name) => downloads.push({ bytes, name });
  assert.equal(f.run("originalSourceIfUnchanged()"), null);
  await f.run("exportPdf()"); assert.equal(downloads.length, 1);
  const reopened = await PDFDocument.load(downloads[0].bytes);
  assert.equal(reopened.getPageCount(), 4);
  for (let i = 0; i < 4; i++) {
    const p = reopened.getPage(i);
    assert.equal(p.getRotation().angle, 0);
    assert.deepEqual(p.getSize(), i % 2 ? { width: 842, height: 595 } : { width: 595, height: 842 });
    assert.equal(p.node.Resources().lookup(PDFName.of("XObject")).keys().length, blank || i === 0 ? 1 : 2);
  }
  assert.deepEqual(numberedTexts.map(a => a.text), ["1", "2", "3", "4"]);
  assert.ok(numberedTexts.every(a => a.bgTransparent && a.fontFamily === "arial"));
  numberedTexts.length = 0; f.state.pageSelection = new Set(["p1", "p3"]);
  await f.run("exportPdf(true)"); assert.equal(downloads.length, 2);
  const selected = await PDFDocument.load(downloads[1].bytes);
  assert.equal(selected.getPageCount(), 2);
  for (const page of selected.getPages()) {
    assert.equal(page.getRotation().angle, 0);
    assert.deepEqual(page.getSize(), { width: 842, height: 595 });
    assert.equal(page.node.Resources().lookup(PDFName.of("XObject")).keys().length, blank ? 1 : 2);
  }
  assert.deepEqual(numberedTexts.map(a => a.text), ["2", "4"]);
  assert.match(downloads[1].name, /^抽出_/);
});
}
