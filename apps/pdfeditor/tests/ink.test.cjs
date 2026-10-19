const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const inkModule = import("../ink.mjs");
const coreModule = import("../editor-core.mjs");
const source = fs.readFileSync(path.join(__dirname, "../app.js"), "utf8");
const section = (from, to) => {
  assert.ok(source.includes(from) && source.includes(to));
  return source.slice(source.indexOf(from), source.indexOf(to));
};
const plain = value => JSON.parse(JSON.stringify(value));
const stroke = (id = "ink") => ({ id, type: "ink", color: "#d63a4a", strokeWidth: 2,
  points: [{ x: 20, y: 30 }, { x: 50, y: 80 }, { x: 130, y: 40 }] });

test("手書きは倍率／DPIに依存しない境界・移動・四方向回転を保持する", async () => {
  const { bounds, translate, rotateAnnotation } = await coreModule;
  const a = stroke(), original = structuredClone(a);
  assert.deepEqual(bounds(a), { x: 20, y: 30, w: 110, h: 50 });
  translate(a, 10, 15); assert.deepEqual(a.points[0], { x: 30, y: 45 });
  translate(a, -10, -15); assert.deepEqual(a, original);
  let size = { width: 595, height: 842 };
  for (let i = 0; i < 4; i++) {
    rotateAnnotation(a, size, 90); size = { width: size.height, height: size.width };
    const b = bounds(a); assert.ok(b.x >= 0 && b.y >= 0 && b.x + b.w <= size.width && b.y + b.h <= size.height);
  }
  assert.deepEqual(a, original);
  rotateAnnotation(a, size, -90); rotateAnnotation(a, { width: 842, height: 595 }, 90);
  assert.deepEqual(a, original);
});

test("ポイント列は微小移動・非有限座標・上限を除き、点とパスを生成する", async () => {
  const { appendInkPoint, inkPath, inkBounds, MAX_STROKE_POINTS, documentInkPointCount } = await inkModule;
  const points = [];
  assert.equal(appendInkPoint(points, { x: NaN, y: 0 }), false);
  assert.equal(appendInkPoint(points, { x: 0, y: Infinity }), false);
  assert.equal(appendInkPoint(points, { x: 10, y: 20 }), true);
  assert.equal(appendInkPoint(points, { x: 10.1, y: 20.1 }), false);
  assert.equal(appendInkPoint(points, { x: 40.12345, y: 60 }), true);
  assert.equal(inkPath(points), "M 10 20 L 40.123 60");
  assert.equal(appendInkPoint(points, { x: 80, y: 90 }, 2), false);
  assert.deepEqual(inkBounds([]), { x: 0, y: 0, w: 0, h: 0 });
  assert.deepEqual(inkBounds([points[0]]), { x: 10, y: 20, w: 0, h: 0 });
  assert.equal(MAX_STROKE_POINTS, 8192);
  assert.equal(documentInkPointCount([{ annotations: [stroke(), { type: "rect" }] }]), 3);
});

test("消しゴムは速い横断・線の太さ・点を判定し、離れたストロークには当たらない", async () => {
  const { inkIntersectsSegment } = await inkModule;
  const a = { ...stroke(), points: [{ x: 50, y: 20 }, { x: 50, y: 80 }] };
  assert.equal(inkIntersectsSegment(a, { x: 0, y: 40 }, { x: 100, y: 40 }, 2), true);
  assert.equal(inkIntersectsSegment(a, { x: 0, y: 90 }, { x: 100, y: 90 }, 2), false);
  assert.equal(inkIntersectsSegment(a, { x: 52, y: 40 }, { x: 52, y: 60 }, 2), true);
  assert.equal(inkIntersectsSegment(a, { x: 10, y: 20 }, { x: 40, y: 20 }, 2), false);
  a.points = [{ x: 50, y: 50 }];
  assert.equal(inkIntersectsSegment(a, { x: 0, y: 50 }, { x: 100, y: 50 }, 2), true);
  assert.equal(inkIntersectsSegment(a, { x: 0, y: 55 }, { x: 100, y: 55 }, 2), false);
});

test("手ぶれ補正は3段階で揺れを抑え、追従距離を制限して入力座標を変更しない", async () => {
  const { stabilizeInkPoint } = await inkModule;
  const origin = { x: 0, y: 0 }, point = { x: 10, y: 0 };
  assert.deepEqual(stabilizeInkPoint(null, point, "strong"), point);
  for (const level of ["none", "unknown", "__proto__"])
    assert.deepEqual(stabilizeInkPoint(origin, point, level), point);
  const variation = [];
  for (const [level, radius] of [["weak", 1.5], ["medium", 3], ["strong", 6]]) {
    assert.deepEqual(stabilizeInkPoint(origin, { x: 0.3, y: 0.4 }, level), origin);
    assert.deepEqual(stabilizeInkPoint(origin, point, level), { x: 10 - radius, y: 0 });
    let previous = origin, wobble = 0;
    for (let x = 1; x <= 100; x++) {
      const input = { x, y: x % 2 ? 1 : -1 }, corrected = stabilizeInkPoint(previous, input, level);
      assert.ok(Math.hypot(input.x - corrected.x, input.y - corrected.y) <= radius + 1e-9);
      assert.ok(corrected.x >= previous.x && corrected.x <= input.x);
      wobble += Math.abs(corrected.y - previous.y); previous = corrected;
    }
    variation.push(wobble);
  }
  assert.ok(variation[0] < 200 && variation[0] > variation[1] && variation[1] > variation[2]);
  assert.deepEqual(origin, { x: 0, y: 0 }); assert.deepEqual(point, { x: 10, y: 0 });
});

async function fixture(scale = 1) {
  const mod = await inkModule, core = await coreModule, history = [], toasts = [], frames = new Map();
  let frameId = 0, annotationId = 0;
  const target = () => ({ listeners: new Map(),
    addEventListener(type, fn) { const list = this.listeners.get(type) || []; list.push(fn); this.listeners.set(type, list); },
    removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter(f => f !== fn)); },
    emit(type, event) { for (const fn of [...(this.listeners.get(type) || [])]) fn({ type, ...event }); } });
  const document = target(), window = target();
  const node = (tag, attrs = {}) => ({ tag, attrs, children: [], classes: new Set(),
    classList: { add() {} },
    setAttribute(key, value) { this.attrs[key] = String(value); },
    append(...children) { for (const child of children) { this.children.push(child); child.parent = this; } },
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(n => n !== this); },
  });
  const layer = { ...node("layer"), ...target(), dataset: {}, captured: new Set(),
    rect: { left: 10, top: 20, width: 595 * scale, height: 842 * scale },
    getBoundingClientRect() { return { ...this.rect }; },
    setPointerCapture(id) { this.captured.add(id); },
    hasPointerCapture(id) { return this.captured.has(id); },
    releasePointerCapture(id) { this.captured.delete(id); },
    querySelector() { return { classList: { add() {} }, focus() {} }; },
  };
  const state = { mode: "edit", tool: "ink", busy: false, inkTouch: false, inkStabilization: "none", viewScale: scale,
    defaults: { color: "#112233", stroke: 4 }, figureSelection: new Set(), selectedAnnotationId: null,
    pages: [{ id: "p1", annotations: [] }, { id: "p2", annotations: [] }], currentPageId: "p1" };
  const ctx = vm.createContext({ ...mod, ...core, state, document, window, CSS: { escape: id => id },
    els: { layer }, svgNode: node, currentPage: () => state.pages.find(p => p.id === state.currentPageId),
    pageDisplaySize: () => ({ width: 595, height: 842 }),
    clamp: (value, min, max) => Math.max(min, Math.min(max, value)), uid: () => `a${++annotationId}`,
    snapshot: () => structuredClone(state.pages), pushHistory: before => history.push(before || structuredClone(state.pages)),
    finishTextEditing() {}, closeFigureContextMenu() {}, renderAnnotations() {}, updateThumbnailAnnotationMarker() {},
    showToast: (message, error) => toasts.push({ message, error }),
    requestAnimationFrame: fn => { frames.set(++frameId, fn); return frameId; }, cancelAnimationFrame: id => frames.delete(id),
  });
  vm.runInContext(section("let activeInkGesture", "function beginDrawing("), ctx);
  const event = (x, y, overrides = {}) => ({ pointerId: 1, pointerType: "pen", isPrimary: true, button: 0,
    clientX: 10 + x * scale, clientY: 20 + y * scale, target: { closest: () => layer },
    preventDefault() {}, ...overrides });
  return { ctx, state, layer, document, window, event, history, toasts, frames,
    flush() { for (const [id, fn] of frames) { frames.delete(id); fn(); } } };
}

test("ペン／マウスは連続描画し、coalescedとpointerupの最終座標を1履歴へ確定する", async () => {
  for (const [scale, pointerType] of [[0.5, "mouse"], [2, "pen"]]) {
    const f = await fixture(scale);
    f.ctx.beginInkGesture(f.event(10, 20, { pointerType }));
    f.document.emit("pointermove", f.event(80, 90, { pointerType,
      getCoalescedEvents: () => [f.event(30, 40), f.event(50, 60)] }));
    assert.equal(f.state.pages[0].annotations.length, 0); assert.equal(f.frames.size, 1);
    f.flush();
    assert.equal(f.layer.children[0].children[0].attrs.d, "M 10 20 L 30 40 L 50 60 L 80 90");
    f.document.emit("pointerup", f.event(100, 110, { pointerType }));
    const a = f.state.pages[0].annotations[0];
    assert.deepEqual(plain(a.points), [{ x: 10, y: 20 }, { x: 30, y: 40 }, { x: 50, y: 60 }, { x: 80, y: 90 }, { x: 100, y: 110 }]);
    assert.equal(a.color, "#112233"); assert.equal(a.strokeWidth, 4);
    assert.equal(f.history.length, 1); assert.equal(f.history[0][0].annotations.length, 0);
    assert.equal(f.state.tool, "ink"); assert.equal(f.layer.captured.size, 0); assert.equal(f.layer.children.length, 0);
    f.ctx.beginInkGesture(f.event(15, 25)); f.document.emit("pointerup", f.event(15, 25));
    assert.equal(f.history.length, 2); assert.equal(f.state.pages[0].annotations[1].points.length, 1);
  }
});

test("補正済みの点列をプレビューと履歴で共用し、倍率によらず始点・終点・短い線・点を保つ", async () => {
  const { inkPath } = await inkModule;
  for (const level of ["weak", "medium", "strong"]) {
    const results = [];
    for (const scale of [0.5, 2]) {
      const f = await fixture(scale); f.state.inkStabilization = level;
      f.ctx.beginInkGesture(f.event(20, 30));
      f.document.emit("pointermove", f.event(80, 30, {
        getCoalescedEvents: () => [f.event(40, 31), f.event(60, 29)] })); f.flush();
      const preview = f.layer.children[0].children[0].attrs.d;
      f.document.emit("pointerup", f.event(80, 30));
      const a = f.state.pages[0].annotations[0];
      assert.deepEqual(plain(a.points[0]), { x: 20, y: 30 });
      assert.deepEqual(plain(a.points.at(-1)), { x: 80, y: 30 });
      assert.equal(inkPath(a.points.slice(0, -1)), preview);
      assert.ok(a.points[1].x < 40); assert.equal(f.history.length, 1);
      results.push(plain(a.points));
      f.ctx.beginInkGesture(f.event(10, 10)); f.document.emit("pointerup", f.event(12, 11));
      assert.deepEqual(plain(f.state.pages[0].annotations[1].points), [{ x: 10, y: 10 }, { x: 12, y: 11 }]);
      f.ctx.beginInkGesture(f.event(15, 25)); f.document.emit("pointerup", f.event(15, 25));
      assert.equal(f.state.pages[0].annotations[2].points.length, 1);
    }
    assert.deepEqual(results[0], results[1]);
  }
});

test("補正設定の切替は未確定の線を破棄し、既存の線を変えず、処理中は変更しない", async () => {
  const f = await fixture(), a = stroke(), original = structuredClone(a);
  f.state.pages[0].annotations.push(a);
  const control = { value: "strong", addEventListener(type, fn) { this.change = fn; } };
  Object.assign(f.ctx, { $: () => control, syncToolProperties() {} });
  vm.runInContext(section('$("inkStabilizationInput").addEventListener', 'els.color?.addEventListener('), f.ctx);
  f.ctx.beginInkGesture(f.event(10, 20)); f.document.emit("pointermove", f.event(30, 40));
  control.change({ target: control });
  assert.equal(f.state.inkStabilization, "strong"); assert.equal(f.history.length, 0);
  assert.equal(f.layer.children.length, 0); assert.deepEqual(a, original);
  f.document.emit("pointerup", f.event(30, 40)); assert.equal(f.state.pages[0].annotations.length, 1);
  f.state.busy = true; control.value = "weak"; control.change({ target: control });
  assert.equal(f.state.inkStabilization, "strong");
  f.state.busy = false; control.value = "invalid"; control.change({ target: control });
  assert.equal(f.state.inkStabilization, "none");
});

test("消しゴムは強い補正設定でも短い移動の実座標で消し、他の図形を保つ", async () => {
  const f = await fixture(4); f.state.tool = "ink-eraser"; f.state.inkStabilization = "strong";
  const a = { ...stroke(), points: [{ x: 24, y: 30 }] }, rect = { id: "rect", type: "rect" };
  f.state.pages[0].annotations.push(a, rect);
  f.ctx.beginInkGesture(f.event(30, 30)); f.document.emit("pointermove", f.event(24, 30));
  f.document.emit("pointerup", f.event(30, 30));
  assert.deepEqual(plain(f.state.pages[0].annotations), [rect]); assert.equal(f.history.length, 1);
});

test("別ポインター／手のひらは進行中の線を追加・終了せず、指描画は明示的に有効化する", async () => {
  const f = await fixture();
  f.ctx.beginInkGesture(f.event(0, 0, { pointerType: "touch" })); assert.equal(f.layer.children.length, 0);
  f.ctx.beginInkGesture(f.event(10, 20));
  f.ctx.beginInkGesture(f.event(10, 30, { pointerId: 2 }));
  f.document.emit("pointermove", f.event(300, 400, { pointerId: 2, pointerType: "touch" }));
  f.document.emit("pointercancel", f.event(300, 400, { pointerId: 2 }));
  f.document.emit("pointerup", f.event(40, 50));
  assert.equal(f.state.pages[0].annotations.length, 1); assert.equal(f.state.pages[0].annotations[0].points.length, 2);
  f.state.inkTouch = true;
  f.ctx.beginInkGesture(f.event(70, 80, { pointerType: "touch" }));
  f.document.emit("pointerup", f.event(90, 100, { pointerType: "touch" }));
  assert.equal(f.history.length, 2);
});

test("入力キャンセル・キャプチャ喪失・blur・操作切替・倍率／レイアウト変更は履歴を残さない", async () => {
  const cases = [f => f.document.emit("pointercancel", f.event(60, 70)),
    f => f.document.emit("lostpointercapture", f.event(60, 70)),
    f => f.window.emit("blur", {}), f => f.window.emit("resize", {}),
    f => f.document.emit("keydown", { key: "Escape" }), f => f.document.emit("wheel", {}),
    f => f.ctx.cancelInkGesture(),
    f => { f.state.tool = "select"; f.document.emit("pointerup", f.event(60, 70)); },
    f => { f.state.currentPageId = "p2"; f.document.emit("pointerup", f.event(60, 70)); },
    f => { f.state.viewScale = 2; f.document.emit("pointermove", f.event(60, 70)); },
    f => { f.layer.rect.left += 10; f.document.emit("pointerup", f.event(60, 70)); },
    f => { f.state.busy = true; f.document.emit("pointerup", f.event(60, 70)); }];
  for (const cancel of cases) {
    const f = await fixture(); f.ctx.beginInkGesture(f.event(10, 20));
    f.document.emit("pointermove", f.event(60, 70)); cancel(f);
    assert.equal(f.history.length, 0); assert.equal(f.state.pages[0].annotations.length, 0);
    assert.equal(f.layer.captured.size, 0); assert.equal(f.frames.size, 0);
    assert.equal(f.document.listeners.get("pointermove").length, 0);
    f.document.emit("pointerup", f.event(60, 70)); assert.equal(f.history.length, 0);
  }
});

test("Shift・Tab等では描画／消去を継続し、Escapeだけがキー入力でキャンセルする", async () => {
  for (const tool of ["ink", "ink-eraser"]) {
    const f = await fixture(); f.state.tool = tool;
    if (tool === "ink-eraser") f.state.pages[0].annotations.push(stroke());
    f.ctx.beginInkGesture(f.event(20, 30));
    for (const key of ["Shift", "Tab", "ArrowLeft", "a"]) f.document.emit("keydown", { key });
    assert.equal(f.layer.captured.size, 1);
    assert.equal(f.history.length, 0);
    f.document.emit("pointerup", f.event(50, 80));
    assert.equal(f.history.length, 1);
    assert.equal(f.state.pages[0].annotations.length, tool === "ink" ? 1 : 0);
    assert.equal(f.document.listeners.get("keydown").length, 0);
    if (tool === "ink-eraser") f.state.pages[0].annotations.push(stroke());
    f.ctx.beginInkGesture(f.event(20, 30));
    f.document.emit("pointermove", f.event(50, 80));
    f.document.emit("keydown", { key: "Escape" });
    f.document.emit("pointerup", f.event(50, 80));
    assert.equal(f.state.pages[0].annotations.length, 1);
    assert.equal(f.history.length, 1);
    assert.equal(f.document.listeners.get("keydown").length, 0);
  }
});

test("指入力OFFの案内は主ポインターの初回だけで、履歴を作らずON後は描画できる", async () => {
  for (const tool of ["ink", "ink-eraser"]) {
    const f = await fixture(); f.state.tool = tool;
    f.ctx.beginInkGesture(f.event(10, 20, { pointerType: "touch", isPrimary: false }));
    assert.equal(f.toasts.length, 0);
    for (let i = 0; i < 3; i++) f.ctx.beginInkGesture(f.event(10, 20, { pointerType: "touch" }));
    assert.equal(f.toasts.length, 1);
    assert.match(f.toasts[0].message, /指でも描く・消す.*オン.*Esc/);
    assert.equal(f.history.length, 0); assert.equal(f.layer.captured.size, 0);
    assert.equal(f.state.pages[0].annotations.length, 0);
    f.state.inkTouch = true; f.state.tool = "ink";
    f.ctx.beginInkGesture(f.event(10, 20, { pointerType: "touch" }));
    f.document.emit("pointerup", f.event(30, 40, { pointerType: "touch" }));
    assert.equal(f.history.length, 1);
    assert.equal(f.state.pages[0].annotations.length, 1);
  }
});

test("ストローク消去は他の注釈を保ち、1ドラッグで1履歴・キャンセル／空振りは無変更", async () => {
  for (const cancel of [false, true]) {
    const f = await fixture(); f.state.tool = "ink-eraser";
    const rect = { id: "rect", type: "rect", x: 0, y: 0, w: 100, h: 100 };
    f.state.pages[0].annotations = [stroke(), rect];
    f.state.figureSelection = new Set(["ink"]); f.state.selectedAnnotationId = "ink";
    f.ctx.beginInkGesture(f.event(0, 45)); f.document.emit("pointermove", f.event(150, 45));
    assert.equal(f.state.pages[0].annotations.length, 2);
    f.document.emit(cancel ? "pointercancel" : "pointerup", f.event(150, 45));
    assert.equal(f.history.length, cancel ? 0 : 1);
    assert.equal(f.state.pages[0].annotations.length, cancel ? 2 : 1);
    assert.ok(f.state.pages[0].annotations.includes(rect));
    if (!cancel) { assert.equal(f.state.selectedAnnotationId, null); assert.equal(f.state.figureSelection.size, 0); }
    const count = f.history.length;
    f.ctx.beginInkGesture(f.event(500, 500)); f.document.emit("pointerup", f.event(500, 500));
    assert.equal(f.history.length, count);
  }
});

test("線のポイント数上限では途中確定し、合計上限では新規描画を拒否する", async () => {
  const f = await fixture(); f.ctx.MAX_STROKE_POINTS = 3;
  f.ctx.beginInkGesture(f.event(10, 20));
  f.document.emit("pointermove", f.event(40, 50, { getCoalescedEvents: () => [f.event(20, 30)] }));
  assert.equal(f.state.pages[0].annotations[0].points.length, 3);
  assert.equal(f.history.length, 1); assert.equal(f.toasts.length, 1);
  f.document.emit("pointerup", f.event(60, 70)); assert.equal(f.history.length, 1);
  f.ctx.MAX_DOCUMENT_INK_POINTS = 3;
  f.ctx.beginInkGesture(f.event(80, 90)); assert.equal(f.layer.children.length, 0); assert.equal(f.toasts.length, 2);
  f.state.tool = "ink-eraser";
  f.ctx.beginInkGesture(f.event(10, 20)); f.document.emit("pointerup", f.event(10, 20));
  assert.equal(f.state.pages[0].annotations.length, 0);
});

test("手書きのキー移動は選択・履歴・ページ境界を保ち、コピーは点列を独立させる", async () => {
  const f = await fixture(); f.state.tool = "select"; const a = stroke(); f.state.pages[0].annotations.push(a);
  vm.runInContext(section("function moveInkByKey(", "let lastFigurePress"), f.ctx);
  const event = key => ({ key, preventDefault() {}, stopPropagation() {} });
  f.ctx.moveInkByKey(event("Enter"), a); assert.equal(f.history.length, 0);
  f.ctx.moveInkByKey(event("ArrowRight"), a); assert.equal(a.points[0].x, 21); assert.equal(f.history.length, 1);
  const copy = structuredClone(a); (await coreModule).translate(copy, 12, 12);
  assert.equal(a.points[0].x, 21); assert.equal(copy.points[0].x, 33);
});

test("手書きのページ間コピーは点列を共有せず、合計上限では貼り付けを拒否する", async () => {
  const f = await fixture(), a = stroke();
  f.state.tool = "select"; f.state.pages[0].annotations.push(a); f.state.figureSelection.add(a.id);
  Object.assign(f.ctx, { clone: plain, selectedFigures: () => f.state.pages.find(p => p.id === f.state.currentPageId)
    .annotations.filter(a => f.state.figureSelection.has(a.id)), releaseUnusedImages() {},
    syncToolProperties() {}, syncToolButtons() {} });
  vm.runInContext(section("function copyFigures()", "function addTextHighlight()"), f.ctx);
  f.ctx.copyFigures();
  f.state.currentPageId = "p2"; f.ctx.pasteFigures();
  const pasted = f.state.pages[1].annotations[0];
  assert.notEqual(pasted.id, a.id); assert.equal(pasted.points[0].x, 32);
  pasted.points[0].x += 1; assert.equal(a.points[0].x, 20); assert.equal(f.state.clipboard[0].points[0].x, 20);
  assert.equal(f.history.length, 1);
  f.ctx.MAX_DOCUMENT_INK_POINTS = 6; f.ctx.pasteFigures();
  assert.equal(f.state.pages[1].annotations.length, 1); assert.equal(f.history.length, 1);
  assert.match(f.toasts.at(-1).message, /上限/);
});

test("手書きの線／点はPDF座標と表示倍率からSVGへ描画し、リサイズハンドルを付けない", async () => {
  const { bounds, isLine } = await coreModule, { inkPath } = await inkModule;
  const svgNode = (tag, attrs = {}) => ({ tag, attrs, style: {}, dataset: {}, children: [],
    classList: { add() {} }, addEventListener() {}, append(child) { this.children.push(child); } });
  const layer = { children: [], replaceChildren() { this.children = []; }, append(child) { this.children.push(child); } };
  const a = stroke(), dot = { ...stroke("dot"), points: [{ x: 60, y: 70 }] };
  const ctx = vm.createContext({ state: { viewScale: 2, tool: "select", mode: "edit", busy: false }, els: { layer }, svgNode, bounds, isLine, inkPath,
    currentPage: () => ({ annotations: [a, dot] }), selectedFigures: () => [a],
    resolvedPageNumber: () => null, syncToolProperties() {} });
  vm.runInContext(section("function renderFigures()", "function moveInkByKey("), ctx); ctx.renderFigures();
  const line = layer.children[0], circle = layer.children[1];
  assert.equal(line.attrs.role, "group"); assert.equal(line.attrs.tabindex, 0);
  assert.equal(line.attrs["aria-label"], "手書き");
  assert.equal(circle.attrs["aria-label"], "手書き");
  assert.equal(line.attrs.viewBox, "18 28 114 54");
  assert.equal(line.style.left, "36px"); assert.equal(line.style.width, "228px");
  assert.equal(line.children.length, 1); assert.equal(line.children[0].attrs.d, "M 20 30 L 50 80 L 130 40");
  assert.equal(circle.children[0].tag, "circle"); assert.equal(circle.children[0].attrs.r, 1);
  assert.ok(parseFloat(circle.style.width) > 0); assert.ok(parseFloat(circle.style.height) > 0);
  for (const tool of ["ink", "ink-eraser", "rect", "highlight"]) {
    ctx.state.tool = tool; ctx.renderFigures();
    assert.ok(layer.children.every(node => node.attrs.tabindex === -1));
    assert.equal(layer.children[0].attrs["aria-label"], "手書き");
  }
  ctx.state.tool = "select"; ctx.renderFigures();
  assert.ok(layer.children.every(node => node.attrs.tabindex === 0));
  ctx.state.busy = true; ctx.renderFigures();
  assert.ok(layer.children.every(node => node.attrs.tabindex === -1));
});

test("PDF保存・再読込みで手書きがベクトル線／点としてページ内の同じ座標に出力される", async () => {
  const { PDFDocument, rgb, pushGraphicsState, popGraphicsState, setLineJoin, decodePDFRawStream } =
    await import("../vendor/pdf-lib.esm.js");
  const { inkPath } = await inkModule, { rotateAnnotation } = await coreModule;
  const ctx = vm.createContext({ rgb, inkPath, pushGraphicsState, popGraphicsState, setLineJoin,
    state: {}, resolvedPageNumber: () => null, isLine: () => false,
    hexToRgb: () => [0.1, 0.2, 0.3] });
  vm.runInContext(section("async function drawAnnotationsOnPdf(", "async function exportPdf("), ctx);
  const doc = await PDFDocument.create(), a = stroke();
  let size = { width: 595, height: 842 };
  for (let i = 0; i < 4; i++) {
    const page = doc.addPage([size.width, size.height]);
    await ctx.drawAnnotationsOnPdf(doc, page, { annotations: [a, { ...a, points: [{ x: 15, y: 25 }] }] }, size.height);
    rotateAnnotation(a, size, 90); size = { width: size.height, height: size.width };
  }
  const reopened = await PDFDocument.load(await doc.save()); assert.equal(reopened.getPageCount(), 4);
  const pages = reopened.getPages();
  const content = p => p.node.Contents().asArray().map(ref =>
    Buffer.from(decodePDFRawStream(reopened.context.lookup(ref)).decode()).toString()).join("\n");
  const first = content(pages[0]);
  assert.match(first, /1 j/); assert.match(first, /1 J/); assert.match(first, /1 0 0 -1 0 0 cm/);
  assert.match(first, /1 0 0 1 0 842 cm/); assert.match(first, /20 30 m\n50 80 l\n130 40 l/);
  assert.match(first, /14 817 m/); // Radius 1 circle starts left of (15, pageHeight - 25).
  assert.match(content(pages[1]), /812 20 m\n762 50 l\n802 130 l/);
  assert.match(content(pages[2]), /575 812 m\n545 762 l\n465 802 l/);
});

test("描画で確定した補正済みの線をPDF保存・再読込みでも同じ座標で出力する", async () => {
  const { PDFDocument, rgb, pushGraphicsState, popGraphicsState, setLineJoin, decodePDFRawStream } =
    await import("../vendor/pdf-lib.esm.js");
  const f = await fixture(); f.state.inkStabilization = "strong";
  f.ctx.beginInkGesture(f.event(20, 30));
  f.document.emit("pointermove", f.event(40, 33)); f.document.emit("pointermove", f.event(60, 29));
  f.document.emit("pointerup", f.event(80, 30));
  const a = f.state.pages[0].annotations[0], original = plain(a);
  const ctx = vm.createContext({ rgb, inkPath: (await inkModule).inkPath, pushGraphicsState, popGraphicsState, setLineJoin,
    state: {}, resolvedPageNumber: () => null, isLine: () => false, hexToRgb: () => [0.1, 0.2, 0.3] });
  vm.runInContext(section("async function drawAnnotationsOnPdf(", "async function exportPdf("), ctx);
  const doc = await PDFDocument.create(), page = doc.addPage([595, 842]);
  await ctx.drawAnnotationsOnPdf(doc, page, f.state.pages[0], 842);
  const reopened = await PDFDocument.load(await doc.save()), savedPage = reopened.getPage(0);
  const content = savedPage.node.Contents().asArray().map(ref =>
    Buffer.from(decodePDFRawStream(reopened.context.lookup(ref)).decode()).toString()).join("\n");
  const commands = a.points.map((p, i) => `${Number(p.x.toFixed(3))} ${Number(p.y.toFixed(3))} ${i ? "l" : "m"}`).join("\n");
  assert.ok(content.includes(commands)); assert.deepEqual(plain(a), original);
});

test("手書きツールの状態・指入力切替・通常スクロール・文書案内を備える", () => {
  const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8"),
    css = fs.readFileSync(path.join(__dirname, "../app.css"), "utf8"),
    help = fs.readFileSync(path.join(__dirname, "../help.html"), "utf8");
  for (const [tool, label] of [["ink", "手書き"], ["ink-eraser", "手書き消しゴム"]])
    assert.match(html, new RegExp(`data-tool="${tool}"[^>]*aria-label="${label}"[^>]*aria-pressed="false"`));
  assert.match(html, /id="inkTouchInput" type="checkbox"/);
  assert.match(css, /data-tool="select"\][^{]*\{\s*touch-action: pan-x pan-y pinch-zoom/);
  assert.match(css, /data-tool="ink-eraser"\][^{]*\{[^}]*touch-action: none/);
  assert.match(help, /id="handwriting"/); assert.match(help, /部分消去・ストロークのサイズ変更は対応していません/);
});
