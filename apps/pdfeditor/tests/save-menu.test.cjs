// Production save-menu handlers run against a minimal DOM; layout and real focus order are checked in a browser.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../app.js"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "../app.css"), "utf8");

function fixture() {
  const document = { activeElement: null, listeners: {},
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    emit(type, event) { for (const fn of this.listeners[type] || []) fn(event); } };
  class Element {
    constructor(id, attrs = {}) { this.id = id; this.attrs = { ...attrs }; this.children = []; this.listeners = {}; this.hidden = false; this.disabled = false; }
    setAttribute(key, value) { this.attrs[key] = String(value); }
    getAttribute(key) { return this.attrs[key] ?? null; }
    append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
    contains(element) { return element === this || this.children.some(child => child.contains(element)); }
    querySelectorAll() { return this.children.flatMap(child => [...(child.attrs.role === "menuitem" ? [child] : []), ...child.querySelectorAll()]); }
    focus() { document.activeElement = this; }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    emit(type, values = {}) {
      const event = { target: this, defaultPrevented: false, propagationStopped: false,
        preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.propagationStopped = true; }, ...values };
      for (const fn of this.listeners[type] || []) fn(event);
      return event;
    }
  }
  const elements = new Map();
  const $ = id => { if (!elements.has(id)) elements.set(id, new Element(id)); return elements.get(id); };
  const group = $("saveMenuGroup"), trigger = $("saveBtn"), menu = $("saveMenu");
  const pdf = new Element("savePdfMenuItem", { role: "menuitem" }), project = new Element("saveProjectBtn", { role: "menuitem" });
  elements.set(pdf.id, pdf); elements.set(project.id, project);
  menu.append(pdf, project); group.append(trigger, menu); menu.hidden = true;
  const calls = [], window = new Element("window");
  const state = { busy: false, pages: [{ id: "a" }] };
  const context = vm.createContext({ $, els: { save: trigger }, state, document, window,
    exportPdf: () => calls.push(["pdf", document.activeElement?.id, menu.hidden]),
    saveProjectFile: () => calls.push(["project", document.activeElement?.id, menu.hidden]) });
  vm.runInContext(source.slice(source.indexOf("function saveMenuItems("), source.indexOf("let pageNumberMeasureContext")), context);
  vm.runInContext("setupSaveMenu()", context);
  const key = (target, key, extra = {}) => target.emit("keydown", { key, ...extra });
  return { $, document, window, group, trigger, menu, pdf, project, calls, state, key, run: code => vm.runInContext(code, context) };
}

test("保存ボタンはメニューを開閉し、PDFと作業ファイルを文字の項目で選ぶ", () => {
  const f = fixture();
  assert.equal(f.menu.hidden, true);
  f.trigger.emit("click");
  assert.equal(f.menu.hidden, false);
  assert.equal(f.trigger.getAttribute("aria-expanded"), "true");
  assert.equal(f.document.activeElement, f.pdf);
  f.pdf.emit("click");
  // The menu closes and focus returns to the trigger before the save starts.
  assert.deepEqual(f.calls, [["pdf", "saveBtn", true]]);
  assert.equal(f.trigger.getAttribute("aria-expanded"), "false");
  f.trigger.emit("click"); f.project.emit("click");
  assert.deepEqual(f.calls.at(-1), ["project", "saveBtn", true]);
  f.trigger.emit("click"); f.trigger.emit("click");
  assert.equal(f.menu.hidden, true);
  assert.equal(f.document.activeElement, f.trigger);
});

test("矢印・Home・End・Escape・Tabで操作し、メニュー内のキーを文書のショートカットへ伝えない", () => {
  const f = fixture();
  const down = f.key(f.trigger, "ArrowDown");
  assert.equal(down.defaultPrevented, true);
  assert.equal(f.document.activeElement, f.pdf);
  f.run("closeSaveMenu()");
  f.key(f.trigger, "ArrowUp");
  assert.equal(f.document.activeElement, f.project);
  f.key(f.menu, "ArrowDown"); assert.equal(f.document.activeElement, f.pdf);
  f.key(f.menu, "ArrowUp"); assert.equal(f.document.activeElement, f.project);
  f.key(f.menu, "Home"); assert.equal(f.document.activeElement, f.pdf);
  f.key(f.menu, "End"); assert.equal(f.document.activeElement, f.project);
  for (const name of ["Delete", "Backspace", "a"]) assert.equal(f.key(f.menu, name).propagationStopped, true, name);
  const escape = f.key(f.menu, "Escape");
  assert.equal(escape.propagationStopped, true);
  assert.equal(f.menu.hidden, true);
  assert.equal(f.document.activeElement, f.trigger);
  // Tab leaves from the trigger so the browser moves on in the normal order; the key is not cancelled.
  f.trigger.emit("click");
  const tab = f.key(f.menu, "Tab");
  assert.equal(tab.defaultPrevented, false);
  assert.equal(f.menu.hidden, true);
  assert.equal(f.document.activeElement, f.trigger);
  f.trigger.emit("click"); f.key(f.menu, "Tab", { shiftKey: true });
  assert.equal(f.menu.hidden, true);
  // Ctrl／Command+S inside the menu still saves the PDF instead of the browser saving the page.
  for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
    f.trigger.emit("click");
    const save = f.key(f.menu, "s", modifier);
    assert.equal(save.defaultPrevented, true);
    assert.equal(f.menu.hidden, true);
    assert.deepEqual(f.calls.at(-1), ["pdf", "saveBtn", true]);
  }
  f.calls.length = 0;
  // Enter and Space reach the item as the native button click only, so nothing runs twice.
  f.trigger.emit("click");
  for (const name of ["Enter", " "]) assert.equal(f.key(f.menu, name).defaultPrevented, false, name);
  assert.equal(f.calls.length, 0);
});

test("外側の操作・画面サイズの変更・ウィンドウ切替で閉じ、無効や処理中には開かない", () => {
  const f = fixture();
  f.trigger.emit("click");
  f.document.emit("pointerdown", { target: f.pdf });
  assert.equal(f.menu.hidden, false);
  f.document.emit("pointerdown", { target: f.trigger });
  assert.equal(f.menu.hidden, false);
  const outside = { id: "elsewhere", contains: () => false };
  f.document.activeElement = outside;
  f.document.emit("pointerdown", { target: outside });
  assert.equal(f.menu.hidden, true);
  // Closing for an outside click does not take focus away from what was clicked.
  assert.equal(f.document.activeElement, outside);
  for (const type of ["resize", "blur"]) {
    f.trigger.emit("click"); f.window.emit(type);
    assert.equal(f.menu.hidden, true, type);
  }
  f.trigger.disabled = true; f.trigger.emit("click");
  assert.equal(f.menu.hidden, true);
  f.trigger.disabled = false; f.state.busy = true; f.trigger.emit("click");
  assert.equal(f.menu.hidden, true);
  f.state.busy = false; f.trigger.emit("click"); f.pdf.disabled = true;
  f.run("closeSaveMenu()"); f.key(f.trigger, "ArrowDown");
  assert.equal(f.document.activeElement, f.project, "無効な項目は飛ばす");
});

test("保存メニューのマークアップは名前・状態・項目の文字を持ち、狭い幅でも項目の文字を隠さない", () => {
  const trigger = html.match(/<button id="saveBtn"[^>]*>/)[0];
  for (const attr of ['aria-haspopup="menu"', 'aria-expanded="false"', 'aria-controls="saveMenu"', 'aria-label="保存"'])
    assert.ok(trigger.includes(attr), attr);
  assert.match(html, /<div id="saveMenu" class="save-menu-list" role="menu" aria-labelledby="saveBtn" hidden>/);
  for (const [id, label, description] of [["savePdfMenuItem", "PDFを保存（全ページ）", "savePdfDescription"],
    ["saveProjectBtn", "作業ファイル（.abpdf）を保存", "saveProjectDescription"]]) {
    const item = html.match(new RegExp(`<button id="${id}"[^>]*>([^<]*)</button>`));
    assert.ok(item, id);
    assert.equal(item[1].trim(), label);
    for (const attr of ['type="button"', 'role="menuitem"', 'tabindex="-1"', `aria-describedby="${description}"`])
      assert.ok(item[0].includes(attr), `${id} ${attr}`);
  }
  assert.doesNotMatch(css, /#saveProjectBtn\)?\s*>\s*span|:is\([^)]*#saveProjectBtn/);
  assert.match(css, /\.save-menu-list\[hidden\]\s*\{\s*display:\s*none;/);
});
