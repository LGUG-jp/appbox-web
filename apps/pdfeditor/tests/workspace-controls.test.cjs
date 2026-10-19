// Execute production handlers against a minimal DOM. This does not test browser layout/PDF rendering.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../app.js"), "utf8");

function fixture() {
  const elements = new Map();
  const document = { activeElement: null, listeners: {}, addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }, removeEventListener(type, fn) {
    this.listeners[type] = (this.listeners[type] || []).filter((listener) => listener !== fn);
  }, emit(type, event) { for (const fn of this.listeners[type] || []) fn(event); } };
  class Element {
    constructor(id = "", tag = "div") {
      this.id = id; this.tagName = tag; this.dataset = {}; this.attrs = {};
      this.children = []; this.listeners = {}; this.classes = new Set();
      this.style = {}; this.capturedPointers = new Set(); this.animations = [];
      this.scrollTop = 0; this.scrollLeft = 0; this.clientLeft = 0; this.clientTop = 0;
      this.clientWidth = 800; this.clientHeight = 600; this.scrollHeight = 600;
      this.classList = { toggle: (name, on) => on ? this.classes.add(name) : this.classes.delete(name),
        add: (...names) => names.forEach(name => this.classes.add(name)),
        remove: (...names) => names.forEach(name => this.classes.delete(name)), contains: (name) => this.classes.has(name) };
      this.rect = { left: 0, top: 0, bottom: 100, width: 100 };
    }
    set className(value) { this.classes = new Set(value.split(" ")); }
    setAttribute(key, value) { this.attrs[key] = String(value); }
    getAttribute(key) { return this.attrs[key] ?? null; }
    removeAttribute(key) { delete this.attrs[key]; }
    append(...children) { children.forEach((child) => {
      if (child.tagName === "#fragment") { this.append(...child.children); return; }
      child.parent = this; child.parentElement = this; this.children.push(child);
    }); }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); }
    contains(element) { return element === this || this.children.some((child) => child.contains(element)); }
    closest(selectors) {
      if (selectors.split(",").some((s) => this.matches(s.trim()))) return this;
      return this.parent?.closest(selectors) || null;
    }
    matches(selector) {
      if (selector.includes(",")) return selector.split(",").some((part) => this.matches(part.trim()));
      if (selector.startsWith(".")) return this.classes.has(selector.slice(1));
      if (selector.startsWith("#")) return this.id === selector.slice(1);
      if (selector === "[data-drop]") return this.dataset.drop != null;
      if (selector.startsWith("[data-page-id=")) return this.dataset.pageId === selector.match(/"(.*?)"/)[1];
      return this.tagName === selector;
    }
    querySelectorAll(selector) {
      return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((listener) => listener !== fn); }
    emit(type, values = {}) {
      const event = { target: this, preventDefault() {}, stopPropagation() {}, ...values };
      (this.listeners[type] || []).forEach((fn) => fn(event)); return event;
    }
    focus() { document.activeElement = this; document.emit("focusin", { target: this }); }
    getBoundingClientRect() { return this.rect; }
    setPointerCapture(id) { this.capturedPointers.add(id); }
    hasPointerCapture(id) { return this.capturedPointers.has(id); }
    releasePointerCapture(id) { this.capturedPointers.delete(id); }
    animate(...args) { this.animations.push(args); }
  }
  const $ = (id) => {
    if (!elements.has(id)) elements.set(id, new Element(id));
    return elements.get(id);
  };
  document.createElement = (tag) => new Element("", tag);
  document.createDocumentFragment = () => new Element("", "#fragment");
  document.querySelectorAll = () => [];
  document.body = $("body");
  const window = new Element("window");
  const state = { pages: [{ id: "a", annotations: [] }, { id: "b", annotations: [] }], mode: "overview", thumbnailSize: "medium",
    pagesPanelPreference: null, pageSelection: new Set(["a"]), currentPageId: "a", selectionAnchor: "a",
    figureSelection: new Set(), busy: false, restoringHistory: false, sources: new Map() };
  const calls = { renderPage: 0, finishText: 0, thumbnails: [], reorder: [], syncUI: 0, history: [], status: [], toast: [], read: [] };
  const frames = new Map(), timers = new Map(); let nextFrame = 0, nextTimer = 0, narrow = false;
  const els = { layer: $("annotationLayer"), editor: $("editor"), thumbs: $("thumbList"), append: $("appendPdfBtn"), zoom: $("zoomSelect"),
    rotateLeft: $("rotateLeftBtn"), rotateRight: $("rotateRightBtn"), deletePage: $("deletePageBtn"),
    movePageUp: $("movePageUpBtn"), movePageDown: $("movePageDownBtn") };
  for (const [key, id] of Object.entries({ empty: "emptyState", close: "closePdfBtn", save: "saveBtn",
    pageCount: "pageCount", pageIndicator: "pageIndicator", prev: "prevPageBtn", next: "nextPageBtn",
    zoomOut: "zoomOutBtn", zoomIn: "zoomInBtn", documentName: "documentName", undo: "undoBtn", redo: "redoBtn" }))
    els[key] = $(id);
  $("pagesPanel").append(els.thumbs);
  els.zoom.value = "fit";
  $("pdfHeaderActions").append(els.append, $("closePdfBtn"));
  $("headerInner").append($("pdfHeaderActions"));
  const toolbar = $("pageToolbar"); toolbar.className = "page-toolbar"; els.editor.append(toolbar);
  window.innerWidth = 1280;
  window.innerHeight = 800;
  const context = vm.createContext({ $, state, els, document, window, CSS: { escape: (value) => value },
    matchMedia: () => ({ matches: narrow }), resizeRenderFrame: 0,
    requestAnimationFrame: (fn) => { frames.set(++nextFrame, fn); return nextFrame; },
    cancelAnimationFrame: (id) => frames.delete(id),
    setTimeout: (fn) => { timers.set(++nextTimer, fn); return nextTimer; },
    clearTimeout: (id) => timers.delete(id),
    finishTextEditing: () => calls.finishText++, renderCurrentPage: () => calls.renderPage++,
    renderThumbnails: (anchor, focusPageId) => {
      calls.thumbnails.push(anchor);
      if (focusPageId) {
        for (const item of [...els.thumbs.children]) item.remove();
        state.pages.forEach((page, index) => els.thumbs.append(vm.runInContext(`createThumbnailItem(state.pages[${index}], ${index})`, context)));
        vm.runInContext(`restoreDeletedPageFocus("${focusPageId}")`, context);
      }
    },
    updatePageDragScroll() {}, pageScrollVelocity: 0, clearPageDrag() {},
    selectPage: (id) => { state.currentPageId = id; state.pageSelection = new Set([id]); },
    openPageEditor: (id) => { calls.opened = id; },
    syncUI: () => { calls.syncUI++; vm.runInContext("syncWorkspace()", context); },
    syncFloatingProperties() {},
    currentPageIndex: () => state.pages.findIndex((page) => page.id === state.currentPageId),
    currentPage: () => state.pages.find((page) => page.id === state.currentPageId),
    sourceFor: () => ({ name: "sample.pdf" }), syncToolButtons() {}, syncToolProperties() {},
    documentInkPointCount: () => 0, MAX_DOCUMENT_INK_POINTS: 200_000,
    pushHistory: () => calls.history.push({ pages: [...state.pages], selection: [...state.pageSelection] }),
    updateStatus: (value) => calls.status.push(value), showToast: (value) => calls.toast.push(value),
    reorderPage: (...args) => calls.reorder.push(args),
    readPdfFiles: (...args) => calls.read.push(args),
    thumbnailColumns: (items) => items.length,
    closeFontMenu: () => { calls.closeFontMenu = (calls.closeFontMenu || 0) + 1; },
    clamp: (value, min, max) => Math.max(min, Math.min(max, value)),
    nearestCorner: (x, y, width, height) => `${y < height / 2 ? "top" : "bottom"}-${x < width / 2 ? "left" : "right"}`,
  });
  vm.runInContext(source.slice(source.indexOf("function insertLoadedPages("), source.indexOf("let pageScrollFrame = 0,")), context);
  vm.runInContext(source.slice(source.indexOf("function syncWorkspaceLayout()"), source.indexOf("function syncFloatingProperties()")), context);
  vm.runInContext(source.slice(source.indexOf("function createThumbnailItem("), source.indexOf("function thumbnailRenderKey(")), context);
  vm.runInContext(source.slice(source.indexOf("function selectedPages()"), source.indexOf("async function openPageEditor(")), context);
  vm.runInContext(source.slice(source.indexOf("function syncThumbnailSelection()"), source.indexOf("function updateThumbnailAnnotationMarker(")), context);
  vm.runInContext(source.slice(source.indexOf("function deleteCurrentPage()"), source.indexOf("function setTool(")), context);
  vm.runInContext(source.slice(source.indexOf("function restoreDeletedPageFocus("), source.indexOf("async function renderThumbnails(")), context);
  vm.runInContext(source.slice(source.indexOf("let figureContextTargetId"), source.indexOf("function setupWorkspace()")), context);
  const setup = source.slice(source.indexOf("function setupWorkspace() {"), source.indexOf('  $("backToPagesBtn").addEventListener("click", showPageOverview);'));
  vm.runInContext(setup + "}\nsetupWorkspace();", context);
  const run = (code) => vm.runInContext(code, context);
  const flush = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach((fn) => fn()); };
  const flushTimers = () => { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); };
  return { $, state, els, document, window, calls, context, run, flush, flushTimers, narrow: (value) => { narrow = value; }, Element };
}

test("一覧開閉の手動設定は狭幅・広幅への変更やモード往復でも維持する", () => {
  const f = fixture(); f.state.mode = "edit";
  f.run("syncWorkspaceLayout()");
  assert.equal(f.$("togglePagesBtn").getAttribute("aria-expanded"), "true");
  f.$("togglePagesBtn").emit("click");
  assert.equal(f.els.editor.dataset.pagesExpanded, "false");
  assert.equal(f.$("togglePagesBtn").getAttribute("aria-label"), "ページ一覧を表示");
  assert.equal(f.$("togglePagesBtn").getAttribute("title"), "ページ一覧を表示");
  f.narrow(true); f.run("syncWorkspaceLayout()");
  f.narrow(false); f.state.mode = "overview"; f.run("syncWorkspaceLayout()");
  f.state.mode = "edit"; f.run("syncWorkspaceLayout()");
  assert.equal(f.$("togglePagesBtn").getAttribute("aria-expanded"), "false");
  f.$("togglePagesBtn").emit("click"); f.flush();
  assert.equal(f.els.editor.dataset.pagesExpanded, "true");
  assert.equal(f.$("togglePagesBtn").getAttribute("title"), "ページ一覧を閉じる");
  assert.equal(f.calls.renderPage, 1); // Consecutive layout changes use the latest frame.
});

function panelFixture() {
  const f = fixture(), panel = f.$("formatPanel"), handle = f.$("formatDragHandle");
  const host = new f.Element(); host.rect = { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 };
  host.append(panel); panel.parentElement = host;
  panel.rect = { left: 550, top: 12, right: 788, bottom: 192, width: 238, height: 180 };
  panel.dataset.corner = "top-right"; handle.tagName = "button";
  const title = f.$("formatTitle"), whitespace = new f.Element();
  handle.append(title);
  panel.append(handle, whitespace);
  f.$("dockPreview").hidden = true;
  f.run(source.slice(source.indexOf("function trackPointer("), source.indexOf("function resizeEndpoint(")));
  f.run(source.slice(source.indexOf('  const panel = $("formatPanel"),'), source.indexOf('  $("pdfTextLayer").addEventListener("pointerup"')));
  const down = (target = title, overrides = {}) => panel.emit("pointerdown", {
    target, button: 0, pointerId: 1, clientX: 600, clientY: 50, ...overrides,
  });
  const move = (x, y, pointerId = 1) => f.document.emit("pointermove", { pointerId, clientX: x, clientY: y });
  const end = (type = "pointerup", pointerId = 1) => f.document.emit(type, { type, pointerId });
  return { ...f, panel, handle, title, whitespace, down, move, end };
}

test("設定パネルは見出し・余白から移動し、クリックや手ぶれでは動かない", () => {
  for (const target of ["title", "whitespace", "handle", "panel"]) {
    const f = panelFixture();
    f.down(f[target]); f.move(603, 52);
    assert.equal(f.panel.classes.has("is-dragging"), false);
    assert.equal(f.$("dockPreview").hidden, true);
    f.end();
    assert.equal(f.panel.dataset.corner, "top-right");
    assert.equal(f.panel.animations.length, 0);
    assert.equal(f.panel.capturedPointers.size, 0);
    f.down(f[target]); f.move(50, 550);
    assert.equal(f.panel.classes.has("is-dragging"), true);
    assert.equal(f.$("dockPreview").dataset.corner, "bottom-left");
    f.end();
    assert.equal(f.panel.dataset.corner, "bottom-left");
    assert.equal(f.panel.style.transform, "");
    assert.equal(f.$("dockPreview").hidden, true);
    assert.equal(f.panel.capturedPointers.size, 0);
    assert.equal(f.document.listeners.pointermove.length, 0);
  }
});

test("設定欄・ラベル・ボタンの中を操作してもパネルは動かず既定操作を妨げない", () => {
  for (const tag of ["input", "select", "textarea", "label", "button", "a"]) {
    const f = panelFixture(), control = new f.Element("", tag), child = new f.Element("", "span");
    control.disabled = true; control.append(child); f.panel.append(control);
    let prevented = false;
    f.down(child, { preventDefault: () => { prevented = true; } });
    f.move(50, 550); f.end();
    assert.equal(prevented, false);
    assert.equal(f.panel.dataset.corner, "top-right");
    assert.equal(f.panel.animations.length, 0);
    assert.equal(f.panel.capturedPointers.size, 0);
  }
  const f = panelFixture(), field = new f.Element(), text = new f.Element("", "span");
  field.className = "font-picker-field"; field.append(text); f.panel.append(field);
  f.down(text); f.move(50, 550); f.end();
  assert.equal(f.panel.dataset.corner, "top-right");
});

test("別ポインターは無視し、キャンセルで元の位置へ戻して次の移動を受け付ける", () => {
  const f = panelFixture();
  f.down(); f.move(50, 550, 2);
  assert.equal(f.panel.classes.has("is-dragging"), false);
  f.down(f.whitespace, { pointerId: 2 });
  assert.equal(f.panel.capturedPointers.has(2), false);
  f.move(50, 550); f.end("pointercancel");
  assert.equal(f.panel.dataset.corner, "top-right");
  assert.equal(f.panel.classes.has("is-dragging"), false);
  assert.equal(f.$("dockPreview").hidden, true);
  assert.equal(f.panel.capturedPointers.size, 0);
  f.down(); f.move(50, 550); f.end();
  assert.equal(f.panel.dataset.corner, "bottom-left");
});

test("パネルのcapture喪失・画面離脱は一度だけ中断し、次のドラッグを受け付ける", () => {
  for (const cause of ["lostpointercapture", "blur"]) {
    const f = panelFixture(); f.down(); f.move(50, 550);
    if (cause === "blur") f.window.emit(cause, { type: cause });
    else f.document.emit(cause, { type: cause, pointerId: 1 });
    assert.equal(f.panel.dataset.corner, "top-right");
    assert.equal(f.panel.style.transform, "");
    assert.equal(f.panel.classes.has("is-dragging"), false);
    assert.equal(f.$("dockPreview").hidden, true);
    assert.equal(f.document.listeners.lostpointercapture.length, 0);
    const animations = f.panel.animations.length;
    f.end(); assert.equal(f.panel.animations.length, animations);
    f.down(); f.move(50, 550); f.end();
    assert.equal(f.panel.dataset.corner, "bottom-left");
  }
});

test("一般の図形操作はcapture喪失だけでは中断せず、設定パネルだけ明示的に中断できる", () => {
  const f = fixture();
  f.run(source.slice(source.indexOf("function trackPointer("), source.indexOf("function resizeEndpoint(")));
  f.context.trackFinishes = [];
  f.run('trackPointer({ pointerId: 7 }, () => {}, (cancel) => trackFinishes.push(cancel));');
  f.document.emit("lostpointercapture", { type: "lostpointercapture", pointerId: 7 });
  assert.deepEqual(f.context.trackFinishes, []);
  f.document.emit("pointerup", { type: "pointerup", pointerId: 7 });
  assert.deepEqual(f.context.trackFinishes, [false]);

  f.context.trackFinishes = [];
  f.run('trackPointer({ pointerId: 8 }, () => {}, (cancel) => trackFinishes.push(cancel), { cancelOnLostCapture: true });');
  f.document.emit("lostpointercapture", { type: "lostpointercapture", pointerId: 8 });
  assert.deepEqual(f.context.trackFinishes, [true]);
});


test("図形コンテキストメニューは選択を整え、画面内に収めて操作を実行する", () => {
  const f = fixture();
  f.state.mode = "edit";
  f.state.currentPageId = "a";
  f.state.pages = [{ id: "a", annotations: [{ id: "fig1", type: "rect" }] }];
  f.state.figureSelection = new Set();
  f.state.clipboard = [];
  const menu = f.$("figureContextMenu"), copy = f.$("figureContextCopyBtn"),
    paste = f.$("figureContextPasteBtn"), remove = f.$("figureContextDeleteBtn");
  for (const button of [copy, paste, remove]) button.tagName = "button";
  menu.append(copy, paste, remove);
  menu.hidden = true;
  menu.rect = { left: 0, right: 148, top: 0, bottom: 120, width: 148, height: 120 };
  f.context.renderAnnotations = () => { f.calls.renderAnnotations = (f.calls.renderAnnotations || 0) + 1; };
  f.context.selectedFigures = () => f.state.pages[0].annotations.filter((a) => f.state.figureSelection.has(a.id));
  f.context.copyFiguresFromMenu = () => { f.calls.copy = (f.calls.copy || 0) + 1; };
  f.context.pasteFigures = () => { f.calls.paste = (f.calls.paste || 0) + 1; };
  f.context.deleteSelectedAnnotation = () => { f.calls.remove = (f.calls.remove || 0) + 1; };
  f.run('openFigureContextMenu(1275, 795, "fig1");');
  assert.deepEqual([...f.state.figureSelection], ["fig1"]);
  assert.equal(menu.hidden, false);
  assert.equal(f.document.activeElement, copy);
  assert.equal(paste.disabled, true);
  assert.ok(Number.parseFloat(menu.style.left) <= 1124);
  assert.ok(Number.parseFloat(menu.style.top) <= 672);
  copy.emit("click");
  assert.equal(menu.hidden, true);
  assert.equal(f.calls.copy, 1);

  f.state.clipboard = [{ id: "clip" }];
  f.run('openFigureContextMenu(20, 20, "fig1");');
  assert.equal(paste.disabled, false);
  paste.emit("click");
  assert.equal(f.calls.paste, 1);
  f.run('openFigureContextMenu(20, 20, "fig1");');
  remove.emit("click");
  assert.equal(f.calls.remove, 1);
});

function blankPageFixture() {
  const f = fixture();
  f.state.mode = "edit";
  f.state.tool = "select";
  f.state.viewScale = 1;
  f.state.clipboard = [{ id: "copied", type: "rect", x: 10, y: 10, w: 20, h: 20 }];
  f.state.pages[0].annotations = [];
  const menu = f.$("figureContextMenu");
  for (const id of ["figureContextCopyBtn", "figureContextPasteBtn", "figureContextDeleteBtn"]) {
    const button = f.$(id); button.tagName = "button"; menu.append(button);
  }
  menu.hidden = true;
  menu.rect = { width: 148, height: 120 };
  f.context.renderAnnotations = () => { f.calls.renderAnnotations = (f.calls.renderAnnotations || 0) + 1; };
  f.context.selectedFigures = () => f.state.pages[0].annotations.filter((a) => f.state.figureSelection.has(a.id));
  f.context.pagePointFromEvent = (event) => ({ x: event.clientX, y: event.clientY });
  f.context.bounds = (annotation) => annotation;
  f.context.pasteFigures = () => { f.calls.paste = (f.calls.paste || 0) + 1; };
  f.run(source.slice(source.indexOf("function trackPointer("), source.indexOf("function copyFigures()")));
  f.run(`const FIGURE_LONG_PRESS_MS = 550, FIGURE_LONG_PRESS_MOVE_PX = 10;`);
  return f;
}

test("図形のないページの余白から貼り付けを実行でき、コピー・削除は無効", () => {
  const f = blankPageFixture();
  let prevented = false;
  f.els.layer.emit("contextmenu", { clientX: 30, clientY: 40, preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(f.$("figureContextMenu").hidden, false);
  assert.equal(f.$("figureContextCopyBtn").disabled, true);
  assert.equal(f.$("figureContextDeleteBtn").disabled, true);
  assert.equal(f.$("figureContextPasteBtn").disabled, false);
  assert.equal(f.document.activeElement, f.$("figureContextPasteBtn"));
  f.$("figureContextPasteBtn").emit("click");
  assert.equal(f.calls.paste, 1);
  assert.equal(f.$("figureContextMenu").hidden, true);
  f.state.clipboard = [];
  prevented = false;
  f.els.layer.emit("contextmenu", { clientX: 30, clientY: 40, preventDefault() { prevented = true; } });
  assert.equal(prevented, false);
  assert.equal(f.$("figureContextMenu").hidden, true);
});

test("余白の長押しは貼り付けを開き、移動・終了・中断では長押しを取り消す", () => {
  for (const pointerType of ["touch", "pen"]) {
    const f = blankPageFixture();
    f.context.event = { target: f.els.layer, pointerId: 1, pointerType, button: 0, clientX: 30, clientY: 40, preventDefault() {} };
    f.run("beginMarquee(event)");
    f.flushTimers();
    assert.equal(f.$("figureContextMenu").hidden, false);
    assert.equal(f.els.layer.children.length, 0);
    f.document.emit("pointermove", { pointerId: 1, clientX: 100, clientY: 100 });
    f.document.emit("pointerup", { type: "pointerup", pointerId: 1 });
    assert.equal(f.$("figureContextMenu").hidden, false);
    assert.equal(f.state.figureSelection.size, 0);
  }
  for (const end of ["pointermove", "pointerup", "pointercancel"]) {
    const f = blankPageFixture();
    f.state.pages[0].annotations = [{ id: "inside", x: 40, y: 50, w: 20, h: 20 }];
    f.context.event = { target: f.els.layer, pointerId: 1, pointerType: "touch", button: 0, clientX: 30, clientY: 40, preventDefault() {} };
    f.run("beginMarquee(event)");
    // A second finger must neither open nor cancel the first finger's gesture.
    f.document.emit("pointermove", { pointerId: 2, clientX: 200, clientY: 200 });
    f.document.emit(end, { type: end, pointerId: 1, clientX: 100, clientY: 100 });
    f.flushTimers();
    assert.equal(f.$("figureContextMenu").hidden, true);
    if (end === "pointermove") {
      assert.deepEqual([...f.state.figureSelection], ["inside"]);
      f.document.emit("pointerup", { type: "pointerup", pointerId: 1 });
    }
    assert.equal(f.els.layer.children.length, 0);
    assert.equal(f.document.listeners.pointermove.length, 0);
  }
});

test("空の別ページへのメニュー貼り付けはコピー元を保ち履歴と新しい選択を作る", () => {
  const f = blankPageFixture();
  const original = { id: "copied", type: "rect", x: 10, y: 10, w: 20, h: 20 };
  f.state.pages[0].annotations = [original];
  f.state.currentPageId = "b";
  f.context.clone = (value) => JSON.parse(JSON.stringify(value));
  f.context.uid = () => "pasted";
  f.context.pageDisplaySize = () => ({ width: 500, height: 500 });
  f.context.translate = (a, dx, dy) => { a.x += dx; a.y += dy; };
  f.context.updateThumbnailAnnotationMarker = (id) => { f.calls.marker = id; };
  f.context.pushHistory = () => { f.calls.history.push(JSON.parse(JSON.stringify(f.state.pages))); };
  f.run(source.slice(source.indexOf("function pasteFigures()"), source.indexOf("// PDF.js builds the transparent text layer")));
  f.els.layer.emit("contextmenu", { clientX: 30, clientY: 40 });
  f.$("figureContextPasteBtn").emit("click");
  assert.deepEqual(f.state.pages[0].annotations, [original]);
  assert.deepEqual(f.state.clipboard, [original]);
  assert.deepEqual(JSON.parse(JSON.stringify(f.state.pages[1].annotations)), [{ ...original, id: "pasted", x: 22, y: 22 }]);
  assert.equal(f.calls.history.length, 1);
  assert.deepEqual(f.calls.history[0][1].annotations, []);
  assert.deepEqual([...f.state.figureSelection], ["pasted"]);
  assert.equal(f.state.selectedAnnotationId, "pasted");
  assert.equal(f.calls.marker, "b");
});


test("処理中・右クリック・非主ポインターでは開始せず、矢印キーでパネルを動かさない", () => {
  const f = panelFixture();
  f.state.busy = true; f.down();
  f.handle.emit("keydown", { key: "ArrowLeft" });
  assert.equal(f.panel.dataset.corner, "top-right");
  f.state.busy = false;
  f.down(f.title, { button: 2 }); f.down(f.title, { isPrimary: false });
  assert.equal(f.panel.capturedPointers.size, 0);
  f.handle.emit("keydown", { key: "ArrowLeft" });
  assert.equal(f.panel.dataset.corner, "top-right");
  f.handle.emit("keydown", { key: "ArrowDown" });
  assert.equal(f.panel.dataset.corner, "top-right");
  assert.equal(f.calls.status.length, 0);
});

test("手動設定がなければ狭幅で一覧を閉じ、固定倍率の開閉では再描画しない", () => {
  const f = fixture(); f.state.mode = "edit"; f.narrow(true); f.els.zoom.value = "200";
  f.run("syncWorkspaceLayout()");
  assert.equal(f.els.editor.dataset.pagesExpanded, "false");
  f.$("togglePagesBtn").emit("click"); f.flush();
  assert.equal(f.els.editor.dataset.pagesExpanded, "true");
  assert.equal(f.calls.renderPage, 0);
  assert.equal(f.calls.finishText, 1);
});

test("サイズ切替は現在見ているページをアンカーとし、順番・選択・モードを変えない", () => {
  const f = fixture(), before = f.state.pages;
  const first = new f.Element(); first.dataset.pageId = "a"; first.rect = { top: -100, bottom: -1 };
  const visible = new f.Element(); visible.dataset.pageId = "b"; visible.rect = { top: 10, bottom: 150 };
  f.els.thumbs.append(first, visible);
  f.$("thumbnailSize").value = "large"; f.$("thumbnailSize").emit("change");
  assert.equal(f.els.editor.dataset.thumbnailSize, "large");
  assert.deepEqual(f.calls.thumbnails, ["b"]);
  assert.equal(f.state.pages, before);
  assert.deepEqual([...f.state.pageSelection], ["a"]);
  assert.equal(f.state.mode, "overview");
  f.run('setThumbnailSize("large"); setThumbnailSize("invalid")');
  assert.equal(f.calls.thumbnails.length, 1);
});

test("処理中や別モードの表示操作はPDF状態を変更しない", () => {
  const f = fixture(); f.state.busy = true;
  f.run('syncWorkspaceLayout(); togglePagesPanel(); setThumbnailSize("large")');
  assert.equal(f.$("togglePagesBtn").disabled, true);
  assert.equal(f.state.thumbnailSize, "medium");
  f.state.busy = false; f.state.mode = "edit";
  f.run('setThumbnailSize("large")');
  assert.equal(f.state.thumbnailSize, "medium");
  assert.equal(f.calls.thumbnails.length, 0);
});

test("複数選択D&Dは全対象を示し、自分自身の上には挿入先を出さない", () => {
  const f = fixture();
  f.state.pages = ["a", "b", "c"].map((id) => ({ id, annotations: [], sourceId: "s" }));
  f.state.pageSelection = new Set(["a", "b"]);
  const items = f.state.pages.map((page, index) => f.run(`createThumbnailItem(state.pages[${index}], ${index})`));
  items.forEach((item, index) => { item.rect = { left: 0, top: index * 120, bottom: index * 120 + 100, width: 100 }; });
  f.els.thumbs.append(...items);
  const transfer = { setData() {} };
  items[0].emit("dragstart", { dataTransfer: transfer });
  assert.equal(items[0].classes.has("dragging"), true);
  assert.equal(items[1].classes.has("dragging"), true);
  assert.equal(items[2].classes.has("dragging"), false);
  items[2].emit("dragover", { clientX: 20, clientY: 250, dataTransfer: transfer });
  assert.equal(items[2].dataset.drop, "before");
  assert.equal(items[2].querySelector(".thumb-drop-caption"), null);
  items[2].emit("dragover", { clientX: 80, clientY: 250, dataTransfer: transfer });
  assert.equal(items[2].dataset.drop, "after");
  items[1].emit("dragover", { clientX: 80, clientY: 130, dataTransfer: transfer });
  assert.equal(items[2].dataset.drop, undefined);
  assert.equal(items[1].dataset.drop, undefined);
  assert.equal(transfer.dropEffect, "none");
  items[2].emit("dragover", { clientX: 80, clientY: 250, dataTransfer: transfer });
  items[2].emit("drop", { clientX: 80, clientY: 250 });
  assert.deepEqual(f.calls.reorder, [["a", "c", true]]);
});

function overviewFixture() {
  const f = fixture();
  f.state.pages = ["a", "b", "c", "d"].map((id) => ({ id, annotations: [] }));
  f.els.thumbs.rect = { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 };
  f.$("pagesPanel").rect = { ...f.els.thumbs.rect };
  const items = f.state.pages.map((page, index) => {
    const item = f.run(`createThumbnailItem(state.pages[${index}], ${index})`);
    const left = 20 + (index % 2) * 200, top = 20 + Math.floor(index / 2) * 200;
    item.rect = { left, top, right: left + 160, bottom: top + 180, width: 160, height: 180 };
    f.els.thumbs.append(item);
    return item;
  });
  f.run("syncWorkspace()");
  const down = (x = 5, y = 5, options = {}) => f.els.thumbs.emit("pointerdown", {
    clientX: x, clientY: y, button: 0, pointerId: 1, ...options,
  });
  const move = (x, y, pointerId = 1) => f.document.emit("pointermove", { clientX: x, clientY: y, pointerId });
  const end = (x, y, type = "pointerup") => f.document.emit(type, { clientX: x, clientY: y, type, pointerId: 1 });
  return { ...f, items, down, move, end };
}

test("チェックボックスは最後の選択も解除でき、0件なら対象ページの操作を無効にする", () => {
  const f = overviewFixture(), check = f.items[0].querySelector(".page-check");
  assert.equal(check.checked, true);
  check.checked = false; check.emit("change");
  assert.deepEqual([...f.state.pageSelection], []);
  assert.equal(check.checked, false);
  assert.equal(f.$("selectionCount").textContent, "0ページ選択");
  for (const id of ["extractBtn", "rotateLeftBtn", "rotateRightBtn", "deletePageBtn", "movePageUpBtn", "movePageDownBtn"])
    assert.equal(f.$(id).disabled, true, id);
  check.checked = true; check.emit("change");
  assert.deepEqual([...f.state.pageSelection], ["a"]);
  assert.equal(check.checked, true);
  assert.equal(f.$("extractBtn").disabled, false);
  assert.equal(f.$("rotateLeftBtn").disabled, false);
  assert.equal(f.calls.history.length, 0);
  assert.equal(check.parent.tagName, "label");
  assert.equal(check.parent.classes.has("page-check-target"), true);
  let stopped = false; check.parent.emit("click", { stopPropagation() { stopped = true; } });
  assert.equal(stopped, true);
  f.items[0].emit("dragstart", { target: check.parent, preventDefault() { stopped = "drag"; } });
  assert.equal(stopped, "drag");
  stopped = false;
  f.items[0].emit("pointerdown", { target: check.parent });
  f.items[0].emit("dragstart", { preventDefault() { stopped = true; } });
  assert.equal(stopped, true); // Native dragstart targets the draggable card, not the label.
});

test("一覧余白のクリックは全選択を解除し、ページ上と編集モードでは解除しない", () => {
  const f = overviewFixture(); f.state.pageSelection = new Set(["a", "b"]);
  f.down(); f.end(5, 5);
  assert.deepEqual([...f.state.pageSelection], []);
  assert.equal(f.state.currentPageId, "a");
  assert.equal(f.document.activeElement, f.els.thumbs);
  assert.equal(f.$("pagesPanel").querySelector(".page-selection-marquee"), null);
  f.state.pageSelection = new Set(["a"]);
  f.down(25, 25, { target: f.items[0] }); f.end(25, 25);
  assert.deepEqual([...f.state.pageSelection], ["a"]);
  f.state.mode = "edit"; f.down(); f.end(5, 5);
  assert.deepEqual([...f.state.pageSelection], ["a"]);
  f.state.pageSelection.clear(); f.run("syncWorkspace()");
  assert.deepEqual([...f.state.pageSelection], ["a"]); // Current page remains the edit-mode target.
  assert.equal(f.calls.history.length, 0);
});

test("余白からの矩形は交差するページを選び、ページ順・現在ページ・履歴を変更しない", () => {
  const f = overviewFixture(), pages = f.state.pages;
  f.down(); f.move(385, 205);
  assert.deepEqual([...f.state.pageSelection], ["a", "b"]);
  assert.equal(f.items[0].querySelector(".page-check").checked, true);
  assert.equal(f.items[2].querySelector(".page-check").checked, false);
  assert.equal(f.$("selectionCount").textContent, "2ページ選択");
  const box = f.$("pagesPanel").querySelector(".page-selection-marquee");
  assert.equal(box.hidden, false);
  assert.equal(box.style.width, "380px");
  f.move(180, 205); // Shrinking the rectangle removes pages outside it.
  assert.deepEqual([...f.state.pageSelection], ["a"]);
  f.end(385, 405);
  assert.deepEqual([...f.state.pageSelection], ["a", "b", "c", "d"]);
  assert.equal(f.state.pages, pages);
  assert.equal(f.state.currentPageId, "a");
  assert.equal(f.calls.history.length, 0);
  assert.equal(f.els.thumbs.classes.has("is-selecting"), false);
  assert.equal(f.$("pagesPanel").querySelector(".page-selection-marquee"), null);
  assert.equal(f.els.thumbs.capturedPointers.size, 0);
});

test("矩形選択はCtrl・Shiftで追加でき、逆向きの矩形でも同じページを選べる", () => {
  for (const modifier of ["ctrlKey", "metaKey", "shiftKey"]) {
    const f = overviewFixture(); f.state.pageSelection = new Set(["d"]);
    f.state.selectionAnchor = "b";
    f.down(190, 210, { [modifier]: true }); f.move(5, 5); f.end(5, 5);
    assert.deepEqual([...f.state.pageSelection], ["d", "a"]);
  }
});

test("矩形選択はキャンセル・Esc・画面離脱・capture喪失で復元し後始末する", () => {
  for (const cancel of ["pointercancel", "escape", "blur", "lostcapture"]) {
    const f = overviewFixture(); f.state.pageSelection = new Set(["d"]);
    f.state.selectionAnchor = "b";
    f.down(); f.move(385, 205);
    assert.deepEqual([...f.state.pageSelection], ["a", "b"]);
    if (cancel === "pointercancel") f.end(385, 205, "pointercancel");
    if (cancel === "escape") f.document.emit("keydown", { key: "Escape", preventDefault() {} });
    if (cancel === "blur") f.window.emit("blur");
    if (cancel === "lostcapture") f.els.thumbs.emit("lostpointercapture", { pointerId: 1 });
    assert.deepEqual([...f.state.pageSelection], ["d"]);
    assert.equal(f.state.selectionAnchor, "b");
    assert.equal(f.$("pagesPanel").querySelector(".page-selection-marquee"), null);
    assert.equal(f.document.listeners.pointermove.length, 0);
    assert.equal(f.els.thumbs.capturedPointers.size, 0);
    f.down(); f.end(5, 5);
    assert.deepEqual([...f.state.pageSelection], []);
  }
});

test("長い一覧の矩形選択はスクロール位置を加味し、下端で自動スクロールする", () => {
  const f = overviewFixture(); f.els.thumbs.clientHeight = 220; f.els.thumbs.scrollHeight = 1000;
  f.els.thumbs.scrollTop = 200;
  f.items.forEach((item) => { item.rect.top -= 200; item.rect.bottom -= 200; });
  f.down(); f.move(385, 205);
  assert.deepEqual([...f.state.pageSelection], ["c", "d"]);
  f.flush();
  assert.equal(f.els.thumbs.scrollTop, 212);
  f.end(385, 205);
  assert.equal(f.els.thumbs.classes.has("is-selecting"), false);
});

test("手ぶれはクリック扱い、スクロールバー・処理中・右クリック・別ポインターは無視", () => {
  const f = overviewFixture();
  f.down(); f.move(7, 8); f.end(7, 8);
  assert.deepEqual([...f.state.pageSelection], []);
  f.state.pageSelection = new Set(["b"]); f.els.thumbs.clientWidth = 785;
  f.down(790, 5); f.end(790, 5);
  f.state.busy = true; f.down(); f.state.busy = false;
  f.down(5, 5, { button: 2 }); f.down(5, 5, { isPrimary: false });
  assert.deepEqual([...f.state.pageSelection], ["b"]);
  assert.equal(f.els.thumbs.capturedPointers.size, 0);
  f.down(); f.move(385, 405, 2);
  assert.deepEqual([...f.state.pageSelection], []);
  f.end(5, 5);
});

test("削除は確認なしで履歴を保存し、全ページや0件の削除は実行しない", () => {
  const f = overviewFixture();
  f.state.pageSelection = new Set(["a", "b"]);
  f.run("deleteCurrentPage()"); // No confirm() exists in this environment.
  assert.deepEqual(f.state.pages.map((page) => page.id), ["c", "d"]);
  assert.deepEqual(f.calls.history[0].pages.map((page) => page.id), ["a", "b", "c", "d"]);
  assert.deepEqual(f.calls.history[0].selection, ["a", "b"]);
  assert.match(f.calls.status[0], /元に戻す/);
  f.state.pageSelection = new Set(["c", "d"]); f.run("deleteCurrentPage()");
  assert.equal(f.state.pages.length, 2);
  assert.equal(f.calls.history.length, 1);
  assert.equal(f.calls.toast.length, 2);
  assert.match(f.calls.toast[0], /2ページを削除.*残り2ページ.*元に戻す/);
  f.state.pageSelection.clear(); f.run("deleteCurrentPage()");
  assert.equal(f.calls.history.length, 1);
});

test("矩形選択で現在ページと削除対象が違っても、先頭の削除位置から次を選ぶ", () => {
  for (const [selection, expected] of [[["d", "e"], "f"], [["c", "e"], "d"], [["f", "g"], "e"]]) {
    const f = fixture();
    f.state.pages = "abcdefg".split("").map(id => ({ id, annotations: [] }));
    f.state.currentPageId = "a"; f.state.pageSelection = new Set(selection);
    f.run("deleteCurrentPage()");
    assert.equal(f.state.currentPageId, expected);
    assert.deepEqual([...f.state.pageSelection], [expected]);
    f.run("deleteCurrentPage()");
    assert.ok(!f.state.pages.some(page => page.id === expected));
    assert.equal(f.state.pages[0].id, "a");
  }
});

test("Delete後は新しいサムネイルから矢印とEnterを続けて使い、他の操作へフォーカスを奪わない", () => {
  const f = overviewFixture(); f.items[0].focus(); f.run("deleteCurrentPage()");
  const next = f.document.activeElement;
  assert.equal(next.dataset.pageId, "b");
  next.emit("keydown", { key: "ArrowRight" });
  assert.equal(f.document.activeElement.dataset.pageId, "c");
  f.document.activeElement.emit("keydown", { key: "Enter" });
  assert.equal(f.calls.opened, "c");
  f.$("saveBtn").focus(); f.run('restoreDeletedPageFocus("c")');
  assert.equal(f.document.activeElement, f.$("saveBtn"));
  f.els.thumbs.focus(); f.state.pageSelection = new Set(["d"]);
  f.run('restoreDeletedPageFocus("c")');
  assert.equal(f.document.activeElement, f.els.thumbs); // Selection changed while rendering.
  f.$("saveBtn").focus();
  f.run("deleteCurrentPage()");
  assert.equal(f.document.activeElement, f.$("saveBtn"));
});

test("実際の非同期サムネイル再構築後にフォーカスを戻し、待機中の移動・古い描画を尊重する", async () => {
  for (const change of ["none", "focus", "token"]) {
    const f = overviewFixture(); let resume;
    f.state.thumbToken = 0; f.els.thumbs.focus();
    f.state.pageSelection = new Set(["b"]);
    Object.assign(f.context, {
      stopThumbnailRendering: () => new Promise(resolve => { resume = resolve; }),
      thumbnailRenderKey: () => "test", sourceFor: () => null, currentThumbnailRenderTask: null,
    });
    f.run(source.slice(source.indexOf("async function renderThumbnails("), source.indexOf("function syncThumbnailSelection()")));
    const pending = f.run('renderThumbnails(null, "b")');
    if (change === "focus") f.$("saveBtn").focus();
    if (change === "token") f.state.thumbToken++;
    resume(); await pending;
    if (change === "none") {
      assert.equal(f.document.activeElement.dataset.pageId, "b");
      assert.notEqual(f.document.activeElement, f.items[1]);
    } else assert.equal(f.document.activeElement, change === "focus" ? f.$("saveBtn") : f.els.thumbs);
  }
});

test("ヘッダーはPDFの有無に追従し、両モードで履歴と保存の無効状態を維持する", () => {
  const f = overviewFixture();
  f.state.history = []; f.state.future = [];
  f.run(source.slice(source.indexOf("function syncUndoRedo()"), source.indexOf("function syncToolButtons()")));
  f.run(source.slice(source.indexOf("function saveMenuItems("), source.indexOf("function setupSaveMenu(")));
  f.run(source.slice(source.indexOf("function syncUI()"), source.indexOf("async function readPdfFiles(")));
  for (const mode of ["overview", "edit"]) {
    f.state.mode = mode; f.run("syncUI()");
    assert.equal(f.$("pdfHeaderActions").hidden, false);
    assert.equal(f.document.body.classes.has("pdf-editor-active"), true);
    assert.equal(f.els.undo.disabled, true);
    assert.equal(f.els.save.disabled, false);
    f.state.history.push({}); f.state.future.push({}); f.run("syncUI()");
    assert.equal(f.els.undo.disabled, false);
    assert.equal(f.els.redo.disabled, false);
    f.$("saveMenu").hidden = false; f.els.save.setAttribute("aria-expanded", "true");
    f.state.busy = true; f.run("syncUI()");
    assert.equal(f.els.undo.disabled, true);
    assert.equal(f.els.redo.disabled, true);
    assert.equal(f.els.save.disabled, true);
    // A save menu left open closes once saving becomes unavailable.
    assert.equal(f.$("saveMenu").hidden, true);
    assert.equal(f.els.save.getAttribute("aria-expanded"), "false");
    assert.equal(f.$("savePdfMenuItem").disabled, true);
    assert.equal(f.$("saveProjectBtn").disabled, true);
    f.state.busy = false;
    f.state.history = []; f.state.future = [];
  }
  f.state.pages = []; f.state.currentPageId = null; f.run("syncUI()");
  assert.equal(f.$("pdfHeaderActions").hidden, true);
  assert.equal(f.document.body.classes.has("pdf-editor-active"), false);
  assert.equal(f.els.save.disabled, true);
});

async function inkHistoryFixture(reuseRaster = true) {
  const f = fixture(), core = await import("../editor-core.mjs"), ink = await import("../ink.mjs");
  Object.assign(f.state, { mode: "edit", tool: "select", viewScale: 1, history: [], future: [] });
  f.state.pages = [{ id: "a", annotations: [
    { id: "ink1", type: "ink", points: [{ x: 20, y: 30 }, { x: 50, y: 40 }], color: "#112233", strokeWidth: 2 },
    { id: "ink2", type: "ink", points: [{ x: 80, y: 90 }], color: "#112233", strokeWidth: 2 },
  ] }];
  f.els.loading = f.$("loadingOverlay"); f.els.drop = f.$("dropArea");
  Object.assign(f.context, { ...core, ...ink,
    clone: value => structuredClone(value), cancelInkGesture() {}, releaseUnusedSources: async () => {},
    samePageRaster: () => reuseRaster, samePageLayout: () => true,
    updateThumbnailAnnotationMarker() {},
    resolvedPageNumber: () => null,
    renderCurrentPage: async () => f.run("renderAnnotations()"),
    svgNode: (tag, attrs = {}) => {
      const el = new f.Element("", tag);
      for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
      return el;
    },
  });
  f.run(source.slice(source.indexOf("function setBusy("), source.indexOf("function currentPage()")));
  f.run(source.slice(source.indexOf("function snapshot()"), source.indexOf("function currentTotalSourceBytes()")));
  f.run(source.slice(source.indexOf("function pushHistory("), source.indexOf("function syncToolButtons()")));
  f.run(source.slice(source.indexOf("function saveMenuItems("), source.indexOf("function setupSaveMenu(")));
  f.run(source.slice(source.indexOf("function syncUI()"), source.indexOf("async function readPdfFiles(")));
  f.run(source.slice(source.indexOf("function renderAnnotations()"), source.indexOf("function beginMove(")));
  f.run(source.slice(source.indexOf("function renderFigures()"), source.indexOf("function moveInkByKey(")));
  f.run("renderAnnotations()");
  return f;
}

async function annotationOrderFixture() {
  const f = await inkHistoryFixture();
  const { imagePlacement } = await import("../image-insertion.mjs");
  const box = { x: 20, y: 30, w: 80, h: 40, color: "#112233", strokeWidth: 2 };
  f.state.pages[0].annotations = [
    { ...box, id: "rect", type: "rect", fillNone: false, fill: "#ff0000" },
    { ...box, id: "text", type: "text", text: "テスト", fontSize: 14 },
    { id: "line", type: "line", x1: 20, y1: 30, x2: 100, y2: 70, color: "#223344", strokeWidth: 2 },
    { ...box, id: "image", type: "image", imageId: "asset" },
    { id: "ink", type: "ink", points: [{ x: 20, y: 30 }, { x: 100, y: 70 }], color: "#334455", strokeWidth: 2 },
    { ...box, id: "ellipse", type: "ellipse", fillNone: false, fill: "#00ff00" },
    { id: "arrow", type: "arrow", x1: 20, y1: 30, x2: 100, y2: 70, color: "#445566", strokeWidth: 2 },
    { id: "highlight", type: "highlight", rects: [{ x: 20, y: 30, w: 80, h: 15 }], color: "#ffff00", opacity: 0.35 },
    { ...box, id: "stamp", type: "image", stamp: true, imageId: "asset" },
  ];
  f.state.pages[0].watermark = { text: "案" };
  f.state.pages[0].pageNumber = { number: 1 };
  f.state.pages.push({ id: "b", annotations: [{ ...box, id: "other", type: "rect" }] });
  f.state.images = new Map([["asset", { url: "blob:synthetic" }]]);
  Object.assign(f.context, { imagePlacement, fontStackFor: () => "Arial",
    resolvedWatermark: p => p.watermark,
    resolvedPageNumber: p => p.pageNumber,
    watermarkOverlay: () => new f.Element("watermark"),
    pageNumberOverlay: () => new f.Element("page-number"),
    syncToolProperties: () => f.run("syncFigureOrderControls()"),
  });
  f.run(source.slice(source.indexOf("function moveSelectedFigures("), source.indexOf("function deleteSelectedAnnotation(")));
  const menu = f.$("figureContextMenu");
  for (const id of ["figureContextCopyBtn", "figureContextPasteBtn", "figureContextFrontBtn", "figureContextBackBtn", "figureContextDeleteBtn"]) {
    const button = f.$(id); button.tagName = "button"; menu.append(button);
  }
  menu.hidden = true;
  f.state.clipboard = [];
  f.ids = () => f.state.pages[0].annotations.map((a) => a.id);
  f.layerIds = () => f.els.layer.children.filter(el => el.dataset.annId).map(el => el.dataset.annId);
  f.select = (...ids) => {
    f.state.figureSelection = new Set(ids);
    f.state.selectedAnnotationId = ids.at(-1) || null;
    f.run("renderAnnotations()");
  };
  f.select();
  return f;
}

test("通常ボタンの重ね順は複数選択・座標・別ページを保ち、画面・Undo／Redo・未保存へ反映する", async () => {
  const f = await annotationOrderFixture(), original = structuredClone(f.state.pages);
  f.select("stamp", "text", "rect");
  f.$("bringFiguresFrontBtn").emit("click");
  const front = ["line", "image", "ink", "ellipse", "arrow", "highlight", "rect", "text", "stamp"];
  assert.deepEqual(f.ids(), front);
  assert.deepEqual(f.layerIds(), front);
  assert.equal(f.els.layer.children[0].id, "watermark");
  assert.equal(f.els.layer.children.at(-1).id, "page-number");
  assert.deepEqual([...f.state.figureSelection], ["stamp", "text", "rect"]);
  assert.equal(f.state.selectedAnnotationId, "rect");
  assert.equal(f.state.history.length, 1);
  assert.equal(f.run("hasUnsavedChanges()"), true);
  assert.equal(f.$("bringFiguresFrontBtn").disabled, true);
  assert.equal(f.$("sendFiguresBackBtn").disabled, false);
  assert.equal(f.document.activeElement, f.$("sendFiguresBackBtn"));
  for (const a of f.state.pages[0].annotations)
    assert.deepEqual(a, original[0].annotations.find(before => before.id === a.id));
  assert.deepEqual(f.state.pages[1], original[1]);
  await f.run("undo()");
  assert.deepEqual(f.state.pages, original);
  assert.deepEqual(f.layerIds(), original[0].annotations.map(a => a.id));
  assert.equal(f.run("hasUnsavedChanges()"), false);
  await f.run("redo()");
  assert.deepEqual(f.ids(), front);
  assert.deepEqual(f.layerIds(), front);
  assert.equal(f.run("hasUnsavedChanges()"), true);
  f.run("markDocumentSaved()");
  f.select("text");
  f.$("sendFiguresBackBtn").emit("click");
  assert.equal(f.ids()[0], "text");
  assert.equal(f.run("hasUnsavedChanges()"), true);
  await f.run("undo()");
  assert.equal(f.run("hasUnsavedChanges()"), false);
});

test("右クリック／長押しメニューの重ね順は通常ボタンと共通で、無効項目をキーボード移動で飛ばす", async () => {
  const f = await annotationOrderFixture();
  f.select("image", "stamp");
  f.run('openFigureContextMenu(30, 40, "image")');
  assert.equal(f.$("figureContextFrontBtn").disabled, false);
  f.$("figureContextFrontBtn").emit("click");
  assert.deepEqual(f.ids().slice(-2), ["image", "stamp"]);
  assert.equal(f.$("figureContextMenu").hidden, true);
  assert.equal(f.document.activeElement, f.$("sendFiguresBackBtn"));
  f.run('openFigureContextMenu(30, 40, "image")');
  assert.equal(f.$("figureContextFrontBtn").disabled, true);
  assert.equal(f.$("figureContextBackBtn").disabled, false);
  f.$("figureContextCopyBtn").focus();
  f.$("figureContextMenu").emit("keydown", { key: "ArrowDown" });
  assert.equal(f.document.activeElement, f.$("figureContextBackBtn"));
  f.$("figureContextBackBtn").emit("click");
  assert.deepEqual(f.ids().slice(0, 2), ["image", "stamp"]);
  assert.equal(f.state.history.length, 2);
});

test("メニュー内のスクロール後も重ね順を操作でき、ページのスクロールでは閉じる", async () => {
  const f = await annotationOrderFixture(), menu = f.$("figureContextMenu");
  f.window.innerHeight = 120;
  menu.rect = { left: 0, top: 0, width: 148, height: 104 };
  f.select("rect");
  f.run('openFigureContextMenu(30, 40, "rect")');
  assert.equal(menu.hidden, false);
  menu.scrollTop = 40;
  f.document.emit("scroll", { target: menu });
  assert.equal(menu.hidden, false);
  f.$("figureContextFrontBtn").emit("click");
  assert.equal(f.ids().at(-1), "rect");
  assert.equal(f.state.history.length, 1);
  assert.equal(menu.hidden, true);
  f.run('openFigureContextMenu(30, 40, "rect")');
  f.document.emit("scroll", { target: f.els.layer });
  assert.equal(menu.hidden, true);
});

test("端・空選択・全選択・処理中・一覧では重ね順操作が履歴とRedoを消費しない", async () => {
  const f = await annotationOrderFixture();
  f.state.future = [{ pages: structuredClone(f.state.pages), revision: 8 }];
  const unchanged = structuredClone(f.state.pages);
  for (const [ids, position] of [[[], "front"], [["stamp"], "front"], [["rect"], "back"], [f.ids(), "front"]]) {
    f.select(...ids);
    assert.equal(f.$(position === "front" ? "bringFiguresFrontBtn" : "sendFiguresBackBtn").disabled, true);
    f.run(`moveSelectedFigures("${position}")`);
  }
  f.select("image");
  for (const mode of ["busy", "overview"]) {
    f.state.busy = mode === "busy";
    f.state.mode = mode === "overview" ? "overview" : "edit";
    f.run('syncFigureOrderControls(); moveSelectedFigures("front")');
    for (const id of ["bringFiguresFrontBtn", "sendFiguresBackBtn", "figureContextFrontBtn", "figureContextBackBtn"])
      assert.equal(f.$(id).disabled, true);
  }
  assert.deepEqual(f.state.pages, unchanged);
  assert.equal(f.state.history.length, 0);
  assert.equal(f.state.future.length, 1);
  assert.equal(f.run("hasUnsavedChanges()"), false);
});

test("変更した重ね順は四方向の回転ページでも全体保存／選択保存したPDFの描画順に一致する", async () => {
  const pdf = await import("../vendor/pdf-lib.esm.js"), f = await annotationOrderFixture();
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAQAAAABCAYAAAD5PA/NAAAAGUlEQVR4nGNgYGBg+P//fwMDA8P//wwMDgAupwW8KZ3epgAAAABJRU5ErkJggg==", "base64");
  f.state.images.set("asset", { url: "blob:synthetic", bytes: png, mime: "image/png" });
  const input = await pdf.PDFDocument.create();
  const annotations = [
    { id: "rect", type: "rect", x: 20, y: 30, w: 80, h: 40, color: "#ff0000", fill: "#ff0000", fillNone: false, strokeWidth: 2 },
    { id: "ellipse", type: "ellipse", x: 20, y: 30, w: 80, h: 40, color: "#0000ff", fill: "#0000ff", fillNone: false, strokeWidth: 2 },
    { id: "image", type: "image", imageId: "asset", x: 20, y: 30, w: 80, h: 40 },
    { id: "ink", type: "ink", points: [{ x: 20, y: 30 }, { x: 100, y: 70 }], color: "#00ff00", strokeWidth: 2 },
  ];
  f.state.pages = [0, 90, 180, 270].map((rotation, i) => {
    const original = input.addPage([595, 842]);
    original.drawRectangle({ x: 20, y: 30, width: 10, height: 10, color: pdf.rgb(0.5, 0.5, 0.5) });
    original.setRotation(pdf.degrees(rotation));
    return { id: `p${i}`, sourceId: "source", sourceIndex: i, width: 595, height: 842,
      baseRotation: rotation, rotationExtra: 0, annotations: structuredClone(annotations) };
  });
  f.state.sources = new Map([["source", { name: "synthetic.pdf", bytes: await input.save(), pdfjsDoc: { numPages: 4 } }]]);
  for (const [i, page] of f.state.pages.entries()) {
    f.state.currentPageId = page.id;
    f.select(i % 2 ? "ink" : "rect");
    f.run(`moveSelectedFigures("${i % 2 ? "back" : "front"}")`);
  }
  const bridge = { load: pdf.PDFDocument.load.bind(pdf.PDFDocument), create: async options => {
    const doc = await pdf.PDFDocument.create(options), copyPages = doc.copyPages.bind(doc), addPage = doc.addPage.bind(doc);
    doc.copyPages = (from, indices) => copyPages(from, Array.from(indices));
    doc.addPage = page => addPage(Array.isArray(page) ? Array.from(page) : page);
    return doc;
  } };
  Object.assign(f.context, { ...pdf, PDFDocument: bridge, embeddedImages: new WeakMap(), confirm: () => true,
    normRotation: n => (n % 360 + 360) % 360 });
  f.run(source.slice(source.indexOf("function hexToRgb("), source.indexOf("function wrapCanvasText(")));
  f.run(source.slice(source.indexOf("function drawEmbeddedPage("), source.indexOf("function restoreIntroDisclosure()")));
  const downloads = [];
  f.context.downloadPdfBytes = (bytes, name) => downloads.push({ bytes, name });
  const tokens = { rect: /1 0 0 rg/, ellipse: /0 0 1 rg/, image: /\/Image-[^\s]+ Do/, ink: /0 1 0 RG/ };
  for (const extract of [false, true]) {
    f.state.pageSelection = new Set(["p1", "p3"]);
    await f.run(`exportPdf(${extract})`);
    assert.equal(downloads.length, extract ? 2 : 1, f.calls.toast.join("\n"));
    const reopened = await pdf.PDFDocument.load(downloads.at(-1).bytes);
    const references = extract ? f.state.pages.filter(p => f.state.pageSelection.has(p.id)) : f.state.pages;
    assert.equal(reopened.getPageCount(), references.length);
    for (const [i, reference] of references.entries()) {
      const saved = reopened.getPage(i), content = saved.node.Contents().asArray().map(ref =>
        Buffer.from(pdf.decodePDFRawStream(reopened.context.lookup(ref)).decode()).toString()).join("\n");
      const positions = reference.annotations.map(a => content.search(tokens[a.id]));
      assert.ok(positions.every(position => position >= 0));
      assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
      assert.equal(saved.getRotation().angle, 0);
      assert.deepEqual(saved.getSize(), reference.baseRotation % 180 ? { width: 842, height: 595 } : { width: 595, height: 842 });
    }
  }
});

test("本番Undo／Redoはbusy中の手書きTab停止を解除し、終了後にTab操作を戻す", async () => {
  for (const reuseRaster of [true, false]) {
    const f = await inkHistoryFixture(reuseRaster);
    const nodes = () => f.els.layer.querySelectorAll(".ann-ink");
    f.run("pushHistory(); state.pages[0].annotations[0].points[0].x = 25");
    for (const operation of ["undo()", "redo()", "undo()", "redo()"]) {
      const pending = f.run(operation);
      assert.equal(f.state.busy, true);
      assert.ok(nodes().every(el => el.getAttribute("tabindex") === "-1"));
      await pending;
      assert.equal(f.state.busy, false);
      assert.equal(f.state.restoringHistory, false);
      assert.equal(f.calls.toast.length, 0);
      assert.equal(f.state.pages[0].annotations[0].points[0].x, operation === "undo()" ? 20 : 25);
      assert.ok(nodes().every(el => el.getAttribute("tabindex") === "0"));
      assert.equal(nodes()[0].getAttribute("aria-label"), "手書き");
      assert.equal(nodes()[1].getAttribute("aria-label"), "手書き");
    }
    f.state.tool = "ink";
    f.run("setBusy(true); setBusy(false)");
    assert.ok(nodes().every(el => el.getAttribute("tabindex") === "-1"));
    assert.equal(nodes()[0].getAttribute("aria-label"), "手書き");
  }
});

test("処理開始・終了では既存の手書きノードとフォーカスを保ってTab属性を同期する", async () => {
  const f = await inkHistoryFixture(), node = f.els.layer.querySelector(".ann-ink");
  node.focus();
  f.run("setBusy(true)");
  assert.equal(node.getAttribute("tabindex"), "-1");
  f.run("setBusy(false)");
  assert.equal(f.els.layer.querySelector(".ann-ink"), node);
  assert.equal(f.document.activeElement, node);
  assert.equal(node.getAttribute("tabindex"), "0");
  assert.equal(node.getAttribute("aria-label"), "手書き");
});

test("一覧チェック後のDeleteは次の選択ページも続けて削除でき、キーリピートと入力欄を除外", () => {
  const f = overviewFixture();
  f.run(source.slice(source.indexOf("const isTextEditingTarget = element =>"), source.indexOf("const FONT_STACKS =")));
  const start = source.indexOf('  document.addEventListener("keydown", (e) => {\n    if (state.busy || isTextEditingTarget');
  f.run(source.slice(start, source.indexOf("\n}\n\nfunction releaseUnusedImages()", start)));
  const check = f.items[0].querySelector(".page-check");
  const key = (target, repeat = false) => f.document.emit("keydown", {
    target, key: "Delete", repeat, preventDefault() {},
  });
  check.focus();
  key(check, true);
  assert.equal(f.state.pages.length, 4);
  key(check);
  assert.deepEqual(f.state.pages.map((page) => page.id), ["b", "c", "d"]);
  key(f.els.thumbs, true);
  key(new f.Element("", "input"));
  assert.equal(f.state.pages.length, 3);
  assert.equal(f.calls.history.length, 1);
  assert.equal(f.document.activeElement.dataset.pageId, "b");
  assert.deepEqual([...f.state.pageSelection], ["b"]);
  // The newly selected thumbnail receives the next distinct Delete.
  key(f.document.activeElement);
  assert.deepEqual(f.state.pages.map(page => page.id), ["c", "d"]);
  assert.deepEqual([...f.state.pageSelection], ["c"]);
  key(f.document.activeElement, true);
  assert.equal(f.calls.history.length, 2);
  key(f.document.activeElement);
  assert.deepEqual(f.state.pages.map(page => page.id), ["d"]);
  assert.equal(f.calls.history.length, 3);
  key(f.document.activeElement);
  assert.equal(f.state.pages.length, 1);
  assert.equal(f.calls.history.length, 3);
});

test("矩形選択中にPDFのページ集合が変わると古い選択を復元せず終了する", () => {
  const f = overviewFixture();
  f.down(); f.move(385, 205);
  f.state.pages = [{ id: "new", annotations: [] }];
  f.state.pageSelection = new Set(["new"]);
  f.move(390, 210);
  assert.deepEqual([...f.state.pageSelection], ["new"]);
  assert.equal(f.$("pagesPanel").querySelector(".page-selection-marquee"), null);
  assert.equal(f.els.thumbs.capturedPointers.size, 0);
  assert.equal(f.document.listeners.pointermove.length, 0);
});


test("隣接ページの前後は同じ1本の挿入バーを使い、余白もドロップ対象にする", () => {
  const f = overviewFixture();
  const transfer = { types: ["Files"], files: [{ name: "added.pdf" }] };
  f.items[0].emit("dragover", { clientX: 170, clientY: 40, dataTransfer: transfer });
  assert.equal(f.items[0].dataset.drop, undefined);
  assert.equal(f.items[1].dataset.drop, "before");
  f.items[1].emit("dragover", { clientX: 230, clientY: 40, dataTransfer: transfer });
  assert.equal(f.items[1].dataset.drop, "before");
  assert.equal(f.els.thumbs.querySelectorAll("[data-drop]").length, 1);
  f.els.thumbs.emit("drop", { clientX: 200, clientY: 40, dataTransfer: transfer });
  assert.equal(f.calls.read[0][1], 1);
  assert.equal(transfer.dropEffect, "copy");
});

test("PDFのドロップは先頭・途中・末尾へ追加し、処理中と個別編集では挿入しない", () => {
  for (const [itemIndex, x, expected] of [[0, 30, 0], [1, 370, 2], [3, 370, 4]]) {
    const f = overviewFixture();
    const files = [{ name: "one.pdf" }, { name: "two.pdf" }];
    const event = { clientX: x, clientY: itemIndex === 3 ? 240 : 40, dataTransfer: { types: ["Files"], files } };
    f.items[itemIndex].emit("drop", event);
    assert.equal(f.calls.read[0][0], files);
    assert.equal(f.calls.read[0][1], expected);
    assert.equal(f.calls.reorder.length, 0);
    f.state.busy = true; f.items[0].emit("drop", event);
    f.state.busy = false; f.state.mode = "edit"; f.items[0].emit("drop", event);
    assert.equal(f.calls.read.length, 1);
  }
});

test("自動スクロールは最新の幾何位置で挿入バーとdropを一致させ、終了時に後始末", () => {
  for (const fileDrag of [true, false]) {
    const f = overviewFixture();
    f.run(source.slice(source.indexOf("let pageScrollFrame = 0,"), source.indexOf("function syncWorkspaceLayout()")));
    f.els.thumbs.rect.bottom = 200;
    // Rectangles move with the real scroll position, even without another dragover.
    for (const item of f.items) {
      const original = { ...item.rect };
      item.getBoundingClientRect = () => ({ ...original, top: original.top - f.els.thumbs.scrollTop, bottom: original.bottom - f.els.thumbs.scrollTop });
    }
    const files = [{ name: "new.pdf" }];
    const transfer = { types: fileDrag ? ["Files"] : [], files: fileDrag ? files : [], setData() {} };
    if (!fileDrag) { f.state.pageSelection = new Set(["d"]); f.items[3].emit("dragstart", { dataTransfer: transfer }); }
    const event = { target: f.items[0], clientX: 30, clientY: 210, dataTransfer: transfer };
    f.els.thumbs.emit("dragover", event);
    assert.equal(f.items[1].dataset.drop, "before");
    f.flush();
    assert.equal(f.items[2].dataset.drop, "before");
    assert.equal(f.els.thumbs.querySelectorAll("[data-drop]").length, 1);
    f.els.thumbs.emit("drop", event); // Deliberately stale target.
    if (fileDrag) assert.equal(f.calls.read[0][1], 2);
    else assert.deepEqual(f.calls.reorder, [["d", "c", false]]);
    assert.equal(f.els.thumbs.querySelectorAll("[data-drop]").length, 0);
    const scroll = f.els.thumbs.scrollTop; f.flush();
    assert.equal(f.els.thumbs.scrollTop, scroll);
  }
});

test("読み終わった複数PDFのページ順を保って挿入し、既存ページを維持する", () => {
  for (const index of [0, 1, 2]) {
    const f = fixture();
    f.state.pages = ["a", "b", "file1-1", "file1-2", "file2-1"].map(id => ({ id }));
    f.run(`insertLoadedPages(2, ${index})`);
    const expected = ["a", "b"]; expected.splice(index, 0, "file1-1", "file1-2", "file2-1");
    assert.deepEqual(f.state.pages.map(page => page.id), expected);
  }
});


test("PDF読込み本体は途中へまとめて挿入し履歴を保存、失敗時は追加前へ戻す", async () => {
  for (const fail of [false, true]) {
    const f = fixture(); let serial = 0, fileIndex = 0, destroyed = 0;
    const history = [];
    f.state.history = history;
    f.state.future = [];
    f.els.input = { value: "file" };
    f.state.sources.set("existing", { name: "existing.pdf" });
    Object.assign(f.context, {
      MAX_SINGLE_FILE_BYTES: 100, MAX_TOTAL_FILE_BYTES: 200, MAX_TOTAL_PAGES: 100,
      currentTotalSourceBytes: () => 1,
      snapshot: () => ({ pages: structuredClone(f.state.pages), currentPageId: "a" }),
      clone: structuredClone, uid: () => `new-${++serial}`, normRotation: n => n,
      setBusy: value => { f.state.busy = value; },
      pushHistory: before => history.push(before),
      getPdfJsAuxiliaryOptions: () => ({}), PdfCMapError: class extends Error {},
      isProjectFile: file => /\.abpdf$/i.test(file.name),
      console: { error() {} },
      pdfjsLib: { getDocument: () => ({ promise: Promise.resolve({
        numPages: 2,
        getPage: async () => {
          if (fail && fileIndex === 2) throw new Error("broken page");
          return { rotate: 0, getViewport: () => ({ width: 100, height: 100 }), cleanup() {} };
        }, destroy: async () => { destroyed++; },
      }) }) },
    });
    const start = source.indexOf("async function readPdfFiles(");
    const end = source.indexOf("\n}\n", start) + 3;
    f.run(source.slice(start, end));
    const files = ["one.pdf", "two.pdf"].map(name => ({ name, type: "application/pdf", size: 1,
      arrayBuffer: async () => { fileIndex++; return new ArrayBuffer(1); } }));
    f.context.testFiles = files;
    await f.run("readPdfFiles(testFiles, 1)");
    assert.equal(f.state.busy, false);
    assert.equal(f.els.input.value, "");
    if (fail) {
      assert.deepEqual(Array.from(f.state.pages, p => p.id), ["a", "b"]);
      assert.equal(history.length, 0);
      assert.equal(f.state.sources.size, 1);
      assert.equal(destroyed, 2);
    } else {
      assert.deepEqual(Array.from(f.state.pages, p => p.id), ["a", "new-2", "new-3", "new-5", "new-6", "b"]);
      assert.equal(history.length, 1);
      assert.deepEqual(history[0].pages.map(p => p.id), ["a", "b"]);
    }
  }
});

test("作業ファイルは1件だけのときに作業ファイルの読込みへ振り分け、PDFとの混在は読み込まない", async () => {
  const f = fixture();
  const opened = [];
  f.els.input = { value: "file" };
  Object.assign(f.context, {
    isProjectFile: file => /\.abpdf$/i.test(file.name),
    openProjectFile: async file => opened.push(file.name),
  });
  const start = source.indexOf("async function readPdfFiles(");
  f.run(source.slice(start, source.indexOf("\n}\n", start) + 3));
  f.context.testFiles = [{ name: "会議資料.ABPDF", type: "", size: 1 }];
  await f.run("readPdfFiles(testFiles)");
  assert.deepEqual(opened, ["会議資料.ABPDF"]);
  f.context.testFiles = [{ name: "a.abpdf", type: "", size: 1 }, { name: "b.pdf", type: "application/pdf", size: 1 }];
  await f.run("readPdfFiles(testFiles)");
  assert.deepEqual(opened, ["会議資料.ABPDF"]);
  assert.match(f.calls.toast.at(-1), /作業ファイルは1つだけ/);
  assert.equal(f.els.input.value, "");
});


test("図形のサイズ変更ハンドルは選択ツールだけに表示する", async () => {
  const f = await inkHistoryFixture();
  for (const type of ["rect", "ellipse", "line", "arrow"]) {
    f.state.pages[0].annotations = [
      ["line", "arrow"].includes(type)
        ? { id: "shape", type, x1: 10, y1: 20, x2: 80, y2: 90, color: "#112233", strokeWidth: 2 }
        : { id: "shape", type, x: 10, y: 20, w: 70, h: 70, color: "#112233", strokeWidth: 2 },
    ];
    f.state.figureSelection = new Set(["shape"]);
    f.state.selectedAnnotationId = "shape";
    for (const tool of ["rect", "ellipse", "line", "arrow", "text", "select"]) {
      f.state.tool = tool;
      f.run("renderFigures()");
      const handles = f.els.layer.querySelectorAll(".resize-handle,.endpoint-handle");
      assert.equal(handles.length, tool === "select" ? (["line", "arrow"].includes(type) ? 2 : 1) : 0);
    }
  }
});
