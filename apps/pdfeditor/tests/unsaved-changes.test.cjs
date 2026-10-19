const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../app.js"), "utf8");

function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.notEqual(from, -1, `missing section start: ${start}`);
  assert.notEqual(to, -1, `missing section end: ${end}`);
  return source.slice(from, to);
}

function fixture() {
  const state = {
    pages: [{ id: "p1", annotations: [] }],
    currentPageId: "p1",
    pageSelection: new Set(["p1"]),
    history: [],
    future: [],
    revision: 0,
    savedRevision: 0,
    nextRevision: 1,
  };
  const context = vm.createContext({
    state,
    clone: value => structuredClone(value),
    finishTextEditing() {},
    syncUndoRedo() {},
    releaseUnusedSources: async () => {},
  });
  vm.runInContext(
    section("function snapshot()", "function currentTotalSourceBytes()"),
    context,
  );
  vm.runInContext(
    section("function pushHistory(", "async function restoreSnapshot("),
    context,
  );
  return { state, context, run: code => vm.runInContext(code, context) };
}

test("編集リビジョンは全体保存時点との一致で未保存を判定する", () => {
  const f = fixture();
  assert.equal(f.run("hasUnsavedChanges()"), false);

  f.run("pushHistory()");
  assert.equal(f.state.revision, 1);
  assert.equal(f.run("hasUnsavedChanges()"), true);

  f.run("markDocumentSaved()");
  const savedRevision = f.state.revision;
  assert.equal(f.run("hasUnsavedChanges()"), false);

  f.run("pushHistory()");
  assert.equal(f.run("hasUnsavedChanges()"), true);

  f.state.revision = savedRevision;
  assert.equal(f.run("hasUnsavedChanges()"), false);

  f.state.revision = 0;
  assert.equal(f.run("hasUnsavedChanges()"), true);
});

test("beforeunloadは未保存時だけブラウザ標準確認を要求し、入力中テキストを先に確定する", () => {
  const f = fixture();
  let finishes = 0;
  f.context.finishTextEditing = () => { finishes++; };

  const clean = { prevented: false, returnValue: undefined, preventDefault() { this.prevented = true; } };
  f.context.cleanEvent = clean;
  f.run("handleBeforeUnload(cleanEvent)");
  assert.equal(finishes, 1);
  assert.equal(clean.prevented, false);

  f.run("pushHistory()");
  const dirty = { prevented: false, returnValue: undefined, preventDefault() { this.prevented = true; } };
  f.context.dirtyEvent = dirty;
  f.run("handleBeforeUnload(dirtyEvent)");
  assert.equal(finishes, 2);
  assert.equal(dirty.prevented, true);
  assert.equal(dirty.returnValue, "");
});

test("本番Undo／Redoで保存時点を判定し、Undo後の分岐編集に同じリビジョンを再利用しない", async () => {
  const f = fixture();
  Object.assign(f.state, { figureSelection: new Set(), mode: "overview", busy: false });
  Object.assign(f.context, {
    currentPage: () => f.state.pages[0], samePageRaster: () => true, samePageLayout: () => true,
    syncUI() {}, syncThumbnailSelection() {}, updateThumbnailAnnotationMarker() {},
    setBusy: value => { f.state.busy = value; }, showToast() {}, console,
  });
  vm.runInContext(section("function pushHistory(", "function syncUndoRedo()"), f.context);
  f.run("pushHistory(); state.pages[0].rotationExtra = 90; markDocumentSaved()");
  const savedRevision = f.state.savedRevision;
  f.run("pushHistory(); state.pages[0].rotationExtra = 180");
  await f.run("undo()");
  assert.equal(f.run("hasUnsavedChanges()"), false);
  assert.equal(f.state.pages[0].rotationExtra, 90);
  await f.run("undo()");
  assert.equal(f.run("hasUnsavedChanges()"), true);
  await f.run("redo()");
  assert.equal(f.run("hasUnsavedChanges()"), false);
  await f.run("redo()");
  assert.equal(f.run("hasUnsavedChanges()"), true);
  await f.run("undo(); undo()");
  f.run("pushHistory(); state.pages[0].rotationExtra = 270");
  assert.notEqual(f.state.revision, savedRevision);
  assert.equal(f.run("hasUnsavedChanges()"), true);
  assert.equal(f.state.future.length, 0);
});


// Issue #175: Undo／Redoの描画失敗をエラー注入で回帰確認する。
function historyRenderFailureFixture(mode = "edit") {
  const f = fixture();
  const calls = {
    toasts: [],
    statuses: [],
    releases: 0,
    busy: [],
  };

  Object.assign(f.state, {
    figureSelection: new Set(),
    mode,
    busy: false,
    restoringHistory: false,
    historyRecoveryFailed: false,
    selectedAnnotationId: null,
  });

  Object.assign(f.context, {
    currentPage: () => f.state.pages.find(page => page.id === f.state.currentPageId) || null,
    samePageRaster: () => true,
    samePageLayout: () => true,
    syncUI() {},
    syncThumbnailSelection() {},
    updateThumbnailAnnotationMarker() {},
    renderAnnotations() {},
    renderThumbnails: async () => {},
    renderCurrentPage: async () => {},
    setBusy: value => {
      f.state.busy = Boolean(value);
      calls.busy.push(Boolean(value));
    },
    showToast: (message, error) => calls.toasts.push({ message, error }),
    updateStatus: message => calls.statuses.push(message),
    releaseUnusedSources: async () => { calls.releases++; },
    console,
  });

  vm.runInContext(section("function pushHistory(", "function syncUndoRedo()"), f.context);

  const operationState = () => structuredClone({
    pages: f.state.pages,
    history: f.state.history,
    future: f.state.future,
    revision: f.state.revision,
    savedRevision: f.state.savedRevision,
    nextRevision: f.state.nextRevision,
  });

  return { ...f, calls, operationState };
}

test("Undoの注釈描画失敗は操作前へ戻し、履歴・保存判定を動かさない", async () => {
  const f = historyRenderFailureFixture();
  f.run("pushHistory(); state.pages[0].rotationExtra = 90; markDocumentSaved()");
  f.run("pushHistory(); state.pages[0].rotationExtra = 180");
  f.calls.releases = 0;
  const before = f.operationState();
  let renders = 0;

  f.context.renderAnnotations = () => {
    if (++renders === 1) throw new Error("annotation render failed");
  };

  await f.run("undo()");

  assert.deepEqual(f.operationState(), before);
  assert.equal(f.state.pages[0].rotationExtra, 180);
  assert.equal(f.run("hasUnsavedChanges()"), true);
  assert.equal(f.state.historyRecoveryFailed, false);
  assert.equal(f.state.busy, false);
  assert.equal(f.calls.releases, 0);
  assert.match(f.calls.toasts.at(-1).message, /操作前の状態に戻しました/);
});

test("Redoのサムネイル描画失敗は操作前へ戻し、Redo履歴を消費しない", async () => {
  const f = historyRenderFailureFixture();
  f.run("pushHistory(); state.pages[0].rotationExtra = 90; markDocumentSaved()");
  f.run("pushHistory(); state.pages[0].rotationExtra = 180");
  await f.run("undo()");
  f.calls.releases = 0;
  f.state.mode = "overview";
  f.context.samePageLayout = () => false;
  let renders = 0;
  f.context.renderThumbnails = async () => {
    if (++renders === 1) throw new Error("thumbnail render failed");
  };
  const before = f.operationState();

  await f.run("redo()");

  assert.deepEqual(f.operationState(), before);
  assert.equal(f.state.pages[0].rotationExtra, 90);
  assert.equal(f.run("hasUnsavedChanges()"), false);
  assert.equal(f.state.future.length, 1);
  assert.equal(f.state.historyRecoveryFailed, false);
  assert.equal(f.state.busy, false);
  assert.equal(f.calls.releases, 0);
});

test("現在ページ描画の失敗時は並列描画の完了を待ってからロールバックする", async () => {
  const f = historyRenderFailureFixture();
  f.run("pushHistory(); state.pages[0].rotationExtra = 90; markDocumentSaved()");
  f.run("pushHistory(); state.pages[0].rotationExtra = 180");
  f.context.samePageRaster = () => false;
  f.context.samePageLayout = () => false;
  const events = [];
  let pageRenders = 0;
  let thumbRenders = 0;

  f.context.renderCurrentPage = async () => {
    pageRenders++;
    events.push(`page-${pageRenders}-start`);
    if (pageRenders === 1) {
      throw new Error("current page render failed");
    }
    events.push(`page-${pageRenders}-done`);
  };
  f.context.renderThumbnails = async () => {
    thumbRenders++;
    const current = thumbRenders;
    events.push(`thumb-${current}-start`);
    await new Promise(resolve => setTimeout(resolve, 0));
    events.push(`thumb-${current}-done`);
  };
  const before = f.operationState();

  await f.run("undo()");

  assert.deepEqual(f.operationState(), before);
  assert.ok(
    events.indexOf("thumb-1-done") < events.indexOf("page-2-start"),
    `rollback started before pending thumbnail settled: ${events.join(", ")}`,
  );
  assert.equal(f.state.historyRecoveryFailed, false);
  assert.equal(f.state.busy, false);
});

test("ロールバック描画も失敗した場合は内部状態を戻して編集をロックする", async () => {
  const f = historyRenderFailureFixture();
  f.run("pushHistory(); state.pages[0].rotationExtra = 90; markDocumentSaved()");
  f.run("pushHistory(); state.pages[0].rotationExtra = 180");
  const before = f.operationState();

  f.context.renderAnnotations = () => {
    throw new Error("render always fails");
  };

  await f.run("undo()");

  assert.deepEqual(f.operationState(), before);
  assert.equal(f.state.pages[0].rotationExtra, 180);
  assert.equal(f.run("hasUnsavedChanges()"), true);
  assert.equal(f.state.historyRecoveryFailed, true);
  assert.equal(f.state.busy, true);
  assert.match(f.calls.statuses.at(-1), /PDFを閉じて読み込み直してください/);
  assert.match(f.calls.toasts.at(-1).message, /PDFを閉じて読み込み直してください/);

  assert.match(
    source,
    /els\.close\.disabled\s*=\s*\(\s*state\.busy\s*&&\s*!state\.historyRecoveryFailed\s*\)\s*\|\|\s*!hasPages/,
  );
  assert.match(
    source,
    /async function clearDocument\(\)[\s\S]*!state\.pages\.length\s*\|\|\s*\(\s*state\.busy\s*&&\s*!state\.historyRecoveryFailed\s*\)/,
  );
});

async function productionHistoryRenderFixture(mode, failureStage, alwaysFail = false) {
  const f = historyRenderFailureFixture(mode);
  const core = await import("../editor-core.mjs");
  const rendered = [];
  let attempts = 0;
  const failure = new Error(`injected ${failureStage} failure`);
  if (failureStage === "cancel") failure.name = "RenderingCancelledException";
  const shouldFail = () => alwaysFail || attempts === 1;
  const canvas = () => ({ dataset: {}, style: {}, getContext: () => ({ fillRect() {} }) });
  const viewerCanvas = canvas();
  const thumbs = {
    children: [],
    replaceChildren() { this.children = []; },
    append(fragment) { this.children.push(...fragment.children); },
    querySelector() { return this.children[0] || null; },
  };
  Object.assign(f.state, { renderToken: 0, thumbToken: 0, thumbnailSize: "medium" });
  Object.assign(f.context, {
    samePageRaster: core.samePageRaster,
    // 編集モードでは現在ページ、一覧モードではサムネイルの本番描画を検証する。
    samePageLayout: mode === "edit" ? () => true : core.samePageLayout,
    thumbnailRasterSize: core.thumbnailRasterSize,
    thumbnailRenderKey: page => String(page.rotationExtra),
    createThumbnailItem: page => {
      const preview = canvas();
      return { dataset: { pageId: page.id }, querySelector: () => preview };
    },
    document: { activeElement: null, createDocumentFragment: () => ({
      children: [], append(item) { this.children.push(item); },
    }) },
    CSS: { escape: value => value },
    els: { canvas: viewerCanvas, thumbs, pageHost: { style: {} },
      layer: { style: {}, replaceChildren() {} },
      viewerArea: { clientWidth: 600, clientHeight: 800 }, zoom: { value: "100" } },
    $: () => ({ replaceChildren() {} }),
    currentRenderTask: null,
    currentThumbnailRenderTask: null,
    cancelPdfRenderTask: async () => {},
    stopThumbnailRendering: async () => {},
    clamp: (value, min, max) => Math.max(min, Math.min(value, max)),
    normRotation: value => value,
    previewRenderQuality: () => 1,
    PREVIEW_MAX_EDGE: 1000, PREVIEW_MAX_PIXELS: 1000000,
    renderPdfTextLayer: async () => {},
    console: { error() {}, warn() {} },
    sourceFor: () => ({ pdfjsDoc: { getPage: async () => {
      attempts++;
      const rotation = f.state.pages[0].rotationExtra;
      if (failureStage === "getPage" && shouldFail()) throw failure;
      return {
        getViewport: () => ({ width: 100, height: 100 }),
        render: () => ({ promise: Promise.resolve().then(() => {
          if (["render", "cancel"].includes(failureStage) && shouldFail()) throw failure;
          rendered.push(rotation);
        }) }),
        cleanup() {},
      };
    } } }),
  });
  Object.assign(f.state.pages[0], { sourceId: "s1", sourceIndex: 0, baseRotation: 0, rotationExtra: 0 });
  vm.runInContext(section("async function renderCurrentPage(", "function pageDisplaySize("), f.context);
  vm.runInContext(section("async function renderThumbnails(", "function syncThumbnailSelection()"), f.context);
  f.run("pushHistory(); state.pages[0].rotationExtra = 90; markDocumentSaved()");
  if (mode === "overview") {
    // Set up a Redo without invoking the renderers being tested.
    f.run("state.future.push(snapshot()); state.pages[0].rotationExtra = 0; state.revision = 0; state.history = []");
  }
  return { ...f, rendered, attempts: () => attempts };
}

test("本番PDF描画内部の失敗をUndo／Redoへ伝え、履歴・保存判定・表示を復旧する", async () => {
  for (const mode of ["edit", "overview"]) {
    for (const stage of ["getPage", "render", "cancel"]) {
      const f = await productionHistoryRenderFixture(mode, stage);
      const before = f.operationState();
      await f.run(mode === "edit" ? "undo()" : "redo()");
      assert.deepEqual(f.operationState(), before, `${mode}/${stage}`);
      assert.equal(f.run("hasUnsavedChanges()"), mode === "overview");
      assert.equal(f.state.historyRecoveryFailed, false);
      assert.equal(f.state.busy, false);
      assert.deepEqual(f.rendered, [before.pages[0].rotationExtra]);
      assert.equal(f.attempts(), 2);
      assert.match(f.calls.toasts.at(-1).message, /操作前の状態に戻しました/);
    }
  }
});

test("本番PDF描画内部の復旧失敗も検出してUndo／Redo後の編集をロックする", async () => {
  for (const mode of ["edit", "overview"]) {
    const f = await productionHistoryRenderFixture(mode, "render", true);
    const before = f.operationState();
    await f.run(mode === "edit" ? "undo()" : "redo()");
    assert.deepEqual(f.operationState(), before);
    assert.equal(f.state.historyRecoveryFailed, true);
    assert.equal(f.state.busy, true);
    assert.equal(f.attempts(), 2);
    assert.deepEqual(f.rendered, []);
    assert.match(f.calls.toasts.at(-1).message, /PDFを閉じて読み込み直してください/);
  }
});

test("通常のPDF表示は内部の描画失敗を通知し、呼び出し元へrejectしない", async () => {
  for (const mode of ["edit", "overview"]) {
    const f = await productionHistoryRenderFixture(mode, "render", true);
    await f.run(mode === "edit" ? "renderCurrentPage()" : "renderThumbnails()");
    assert.equal(f.attempts(), 1);
    assert.deepEqual(f.rendered, []);
  }
});

test("終了・保存経路は未保存状態を正しく扱う", () => {
  assert.match(source, /if \(hasUnsavedChanges\(\)\) \{[\s\S]*未保存の編集内容があります。[\s\S]*このまま閉じますか？/);
  assert.match(source, /window\.addEventListener\("beforeunload", handleBeforeUnload\)/);
  assert.match(source, /downloadPdfBytes\([\s\S]*unchangedSource\.name[\s\S]*\);\s*markDocumentSaved\(\);/);
  assert.match(source, /downloadPdfBytes\([\s\S]*extract \? `抽出_[\s\S]*if \(!extract\) \{\s*markDocumentSaved\(\);\s*\}/);
  assert.match(source, /state\.history\.splice\([\s\S]*creationHistoryEntry\.revision[\s\S]*state\.revision\s*=\s*creationHistoryEntry\.revision/);
});

test("PDF追加後の描画失敗は保存判定・Undo／Redo履歴も追加前へ戻す", async () => {
  for (const dirty of [false, true]) {
    const f = fixture();
    f.run("pushHistory(); markDocumentSaved()");
    if (dirty) f.run("pushHistory()");
    f.state.future.push({ revision: 99, pages: [] });
    const before = structuredClone({ pages: f.state.pages, history: f.state.history,
      future: f.state.future, revision: f.state.revision, savedRevision: f.state.savedRevision });
    f.state.sources = new Map();
    let nextId = 0, renders = 0, destroyed = 0, releases = 0;
    Object.assign(f.context, {
      MAX_SINGLE_FILE_BYTES: 100, MAX_TOTAL_FILE_BYTES: 200, MAX_TOTAL_PAGES: 300,
      currentTotalSourceBytes: () => 0,
      clamp: (value, min, max) => Math.max(min, Math.min(value, max)),
      uid: () => `new-${++nextId}`, normRotation: value => value,
      getPdfJsAuxiliaryOptions: () => ({}),
      isProjectFile: () => false,
      els: { input: { value: "" } },
      setBusy: value => { f.state.busy = value; },
      updateStatus() {}, showToast() {}, syncUI() {}, insertLoadedPages() {}, clearViewer() {},
      renderThumbnails: async () => { if (++renders === 1) throw new Error("render failed"); },
      renderCurrentPage: async () => {},
      releaseUnusedSources: async () => { releases++; },
      pdfjsLib: { getDocument: () => ({ promise: Promise.resolve({ numPages: 1,
        getPage: async () => ({ rotate: 0, getViewport: () => ({ width: 100, height: 100 }), cleanup() {} }),
        destroy: async () => { destroyed++; },
      }) }) },
      files: [{ name: "added.pdf", type: "application/pdf", size: 1, arrayBuffer: async () => new ArrayBuffer(1) }],
    });
    vm.runInContext(section("async function readPdfFiles(", "/*\n * プレビュー"), f.context);
    await f.run("readPdfFiles(files)");
    assert.equal(f.run("hasUnsavedChanges()"), dirty);
    assert.equal(f.state.revision, before.revision);
    assert.equal(f.state.savedRevision, before.savedRevision);
    assert.deepEqual(structuredClone(f.state.pages), before.pages);
    assert.deepEqual(structuredClone(f.state.history), before.history);
    assert.deepEqual(structuredClone(f.state.future), before.future);
    assert.equal(f.state.sources.size, 0);
    assert.equal(destroyed, 1);
    assert.equal(releases, 0); // 失敗した追加でRedoが参照するsourceを解放しない。
    assert.equal(f.state.busy, false);
  }
});

async function gestureFixture() {
  const f = fixture(), core = await import("../editor-core.mjs");
  const target = () => ({ listeners: new Map(),
    addEventListener(type, fn) { const list = this.listeners.get(type) || []; list.push(fn); this.listeners.set(type, list); },
    removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item !== fn)); },
    emit(type, values = {}) { for (const fn of [...(this.listeners.get(type) || [])]) fn({ type, ...values }); },
  });
  const layer = { ...target(), classList: { add() {}, remove() {} }, setPointerCapture() {}, releasePointerCapture() {} };
  const document = target(), window = target();
  Object.assign(f.state, { busy: false, mode: "edit", tool: "select", viewScale: 1, figureSelection: new Set(), defaults: {} });
  Object.assign(f.context, core, { document, window, els: { layer },
    currentPage: () => f.state.pages[0], currentAnnotation: () => f.state.pages[0].annotations[0],
    selectedFigures: () => f.state.pages[0].annotations.filter(a => f.state.figureSelection.has(a.id)),
    pageDisplaySize: () => ({ width: 600, height: 800 }),
    pagePointFromEvent: event => ({ x: event.clientX, y: event.clientY }),
    uid: () => "new", clamp: (value, min, max) => Math.max(min, Math.min(value, max)),
    renderAnnotations() {}, syncToolButtons() {}, updateThumbnailAnnotationMarker() {}, closeFigureContextMenu() {},
    setTimeout, clearTimeout,
  });
  vm.runInContext(section("function beginDrawing(", "function startTextEditing("), f.context);
  vm.runInContext(section("let lastFigurePress", "function beginMarquee("), f.context);
  const event = (x, y) => ({ pointerId: 1, pointerType: "mouse", button: 0, timeStamp: 100,
    clientX: x, clientY: y, target: { closest: () => null }, preventDefault() {}, stopPropagation() {} });
  const warns = () => {
    const e = { prevented: false, preventDefault() { this.prevented = true; } };
    f.context.unloadEvent = e; f.run("handleBeforeUnload(unloadEvent)"); return e.prevented;
  };
  return { ...f, layer, document, window, event, warns };
}

test("図形描画中の再読込みは履歴確定前でも警告し、取消・小さすぎる図形では解除", async () => {
  for (const type of ["rect", "ellipse", "line", "arrow"]) {
    const f = await gestureFixture();
    f.context.drawEvent = f.event(10, 20); f.context.drawType = type;
    f.run("beginDrawing(drawEvent, drawType)");
    assert.equal(f.warns(), false);
    f.layer.emit("pointermove", f.event(12, 22));
    assert.equal(f.warns(), false);
    f.layer.emit("pointermove", f.event(80, 90));
    assert.equal(f.state.history.length, 0);
    assert.equal(f.warns(), true);
    f.layer.emit("pointercancel", f.event(80, 90));
    assert.equal(f.warns(), false);
    assert.equal(f.state.pendingEdits.size, 0);
    assert.equal(f.state.pages[0].annotations.length, 0);
    f.run("beginDrawing(drawEvent, drawType)");
    f.layer.emit("pointermove", f.event(80, 90));
    f.layer.emit("pointerup", f.event(80, 90));
    assert.equal(f.state.pendingEdits.size, 0);
    assert.equal(f.state.history.length, 1);
    assert.equal(f.warns(), true);
  }
});

test("四角・丸・線・矢印は配置後もツールとカーソルを維持し、続けて配置できる", async () => {
  for (const type of ["rect", "ellipse", "line", "arrow"]) {
    const f = await gestureFixture();
    let nextId = 0;
    f.context.uid = () => `shape-${++nextId}`;
    f.state.tool = type;
    f.layer.className = `annotation-layer tool-${type}`;
    f.context.drawType = type;
    for (const [x, y] of [[10, 20], [120, 140]]) {
      f.context.drawEvent = f.event(x, y);
      f.run("beginDrawing(drawEvent, drawType)");
      f.layer.emit("pointermove", f.event(x + 60, y + 70));
      f.layer.emit("pointerup", f.event(x + 60, y + 70));
      assert.equal(f.state.tool, type);
      assert.equal(f.layer.className, `annotation-layer tool-${type}`);
      assert.equal(f.state.history.length, nextId);
      assert.equal(f.state.pages[0].annotations.length, nextId);
      assert.equal(f.state.selectedAnnotationId, `shape-${nextId}`);
      assert.equal(f.state.pendingEdits.size, 0);
    }
    const before = structuredClone(f.state.pages[0].annotations);
    for (const cancel of [false, true]) {
      f.context.drawEvent = f.event(220, 240);
      f.run("beginDrawing(drawEvent, drawType)");
      if (cancel) f.layer.emit("pointermove", f.event(280, 310));
      f.layer.emit(cancel ? "pointercancel" : "pointerup", f.event(220, 240));
      assert.deepEqual(structuredClone(f.state.pages[0].annotations), before);
      assert.equal(f.state.history.length, 2);
      assert.equal(f.state.tool, type);
      assert.equal(f.layer.className, `annotation-layer tool-${type}`);
      assert.equal(f.state.pendingEdits.size, 0);
    }
  }
});

test("既存図形上のpointerdownからも作図を開始でき、選択時は既存図形を維持する", async () => {
  for (const type of ["rect", "ellipse", "line", "arrow"]) {
    const f = await gestureFixture();
    const existing = { id: "existing", type: "rect", x: 10, y: 20, w: 100, h: 100 };
    f.state.pages[0].annotations.push(existing);
    f.state.figureSelection.add(existing.id);
    f.state.selectedAnnotationId = existing.id;
    vm.runInContext(section('els.layer.addEventListener(\n  "pointerdown",', '$("inkTouchInput").addEventListener('), f.context);
    const target = { closest: selector => selector === ".ann" ? existing : null };
    // Select leaves the event to the existing annotation's own handlers.
    f.layer.emit("pointerdown", { ...f.event(30, 40), target });
    assert.equal(f.state.pages[0].annotations.length, 1);
    assert.equal(f.state.selectedAnnotationId, existing.id);
    f.state.tool = type;
    f.layer.emit("pointerdown", { ...f.event(30, 40), target });
    f.layer.emit("pointermove", f.event(80, 90));
    f.layer.emit("pointerup", f.event(80, 90));
    assert.equal(f.state.pages[0].annotations.length, 2);
    assert.equal(f.state.pages[0].annotations[1].type, type);
    assert.deepEqual(existing, { id: "existing", type: "rect", x: 10, y: 20, w: 100, h: 100 });
    assert.equal(f.state.history.length, 1);
    assert.equal(f.state.tool, type);
  }
});

test("図形移動・矩形／画像リサイズ・線端点のドラッグ中も警告し、取消は履歴を増やさない", async () => {
  for (const kind of ["move", "resize", "image-resize", "endpoint"]) {
    const f = await gestureFixture();
    const a = kind === "endpoint" ? { id: "a", type: "line", x1: 10, y1: 20, x2: 80, y2: 90 }
      : { id: "a", type: kind === "image-resize" ? "image" : "rect", x: 10, y: 20, w: 80, h: 90 };
    const original = structuredClone(a); f.state.pages[0].annotations.push(a);
    f.state.figureSelection.add("a");
    f.context.a = a; f.context.dragEvent = f.event(80, 90);
    f.run(kind === "move" ? "beginFigureMove(dragEvent, 'a')"
      : kind === "endpoint" ? "resizeEndpoint(dragEvent, a, 2)" : "beginResize(dragEvent, 'a')");
    assert.equal(f.warns(), false);
    f.document.emit("pointermove", f.event(130, 140));
    assert.equal(f.state.history.length, 0);
    assert.equal(f.warns(), true);
    f.document.emit("pointercancel", f.event(130, 140));
    assert.equal(f.warns(), false);
    assert.deepEqual(a, original);
    assert.equal(f.state.pendingEdits.size, 0);
    assert.equal(f.state.history.length, 0);
    f.run("markDocumentSaved()");
    f.context.dragEvent.timeStamp += 500;
    f.run(kind === "move" ? "beginFigureMove(dragEvent, 'a')"
      : kind === "endpoint" ? "resizeEndpoint(dragEvent, a, 2)" : "beginResize(dragEvent, 'a')");
    f.document.emit("pointermove", f.event(130, 140));
    f.document.emit("pointerup", f.event(130, 140));
    assert.equal(f.state.pendingEdits.size, 0);
    assert.equal(f.state.history.length, 1);
    assert.equal(f.warns(), true);
  }
});

test("履歴40件で新規テキストを取消しても最古のUndo履歴を保持し、確定時だけ40件へ切り詰める", () => {
  for (const text of ["", "new text"]) {
    const f = fixture();
    for (let i = 0; i < 40; i++) f.run("pushHistory()");
    f.run("markDocumentSaved()");
    const oldest = f.state.history[0], before = [...f.state.history];
    const handlers = new Map(), element = { textContent: "", classList: { add() {}, remove() {} }, focus() {},
      addEventListener: (type, fn) => handlers.set(type, fn), removeEventListener: type => handlers.delete(type),
      blur: () => handlers.get("blur")?.(),
    };
    Object.assign(f.context, { currentPage: () => f.state.pages[0],
      pageDisplaySize: () => ({ width: 600, height: 800 }),
      clamp: (value, min, max) => Math.max(min, Math.min(value, max)), uid: () => "text",
      els: { layer: { querySelector: () => element } }, CSS: { escape: id => id },
      document: { createRange: () => ({ selectNodeContents() {} }) }, getSelection: () => null,
      requestAnimationFrame: fn => fn(), syncToolButtons() {}, renderAnnotations() {}, updateThumbnailAnnotationMarker() {},
    });
    Object.assign(f.state, { defaults: {}, figureSelection: new Set() });
    vm.runInContext(section("function addTextAt(", "let activeInkGesture"), f.context);
    vm.runInContext(section("function startTextEditing(", "function deleteSelectedAnnotation()"), f.context);
    f.run("addTextAt({ x: 10, y: 20 })");
    assert.equal(f.state.history.length, 41);
    element.textContent = text; f.run("finishTextEditing()");
    assert.equal(f.state.history.length, 40);
    assert.equal(f.run("hasUnsavedChanges()"), !!text);
    if (!text) {
      assert.equal(f.state.history[0], oldest);
      assert.deepEqual(f.state.history, before);
      assert.equal(f.state.pages[0].annotations.length, 0);
    } else {
      assert.notEqual(f.state.history[0], oldest);
      assert.equal(f.state.pages[0].annotations[0].text, text);
    }
  }
});

test("移動・リサイズを元に戻せば保存済みのまま、微小変更でも確定後は未保存になる", async () => {
  for (const kind of ["move", "resize"]) {
    const f = await gestureFixture();
    const a = { id: "a", type: "rect", x: 10, y: 20, w: 80, h: 90 };
    f.state.pages[0].annotations.push(a); f.state.figureSelection.add("a");
    f.context.dragEvent = f.event(80, 90);
    const begin = kind === "move" ? "beginFigureMove(dragEvent, 'a')" : "beginResize(dragEvent, 'a')";
    f.run(begin);
    f.document.emit("pointermove", f.event(100, 110));
    assert.equal(f.warns(), true);
    f.document.emit("pointermove", f.event(80, 90));
    assert.equal(f.warns(), false);
    f.document.emit("pointerup", f.event(80, 90));
    assert.equal(f.state.history.length, 0);
    f.context.dragEvent.timeStamp += 500; f.run(begin);
    f.document.emit("pointermove", f.event(80.25, 90.25));
    assert.equal(f.warns(), true);
    f.document.emit("pointerup", f.event(80.25, 90.25));
    assert.equal(f.warns(), true);
    assert.equal(f.state.history.length, 1);
    assert.equal(f.state.pendingEdits.size, 0);
  }
});
