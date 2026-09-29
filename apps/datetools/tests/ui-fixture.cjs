// UI状態遷移用の最小DOM。ブラウザのレイアウト・ネイティブ日付選択は検証しない。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const decode = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"');
function fixture(utilities) {
  let document;
  class Element {
    constructor(tag) { this.tagName = tag.toLowerCase(); this.attrs = {}; this.children = []; this.listeners = {}; this.dataset = {}; this.style = { setProperty() {} }; this.hidden = false; this.open = false; this.checked = false; this.defaultChecked = false; this.scrollTop = 0; this.clientWidth = 900; this.offsetWidth = 750; this._value = ''; }
    setAttribute(key, value) {
      this.attrs[key] = String(value);
      if (key === 'checked') this.checked = this.defaultChecked = true;
      if (key === 'hidden') this.hidden = true;
      if (key === 'value') this._value = String(value);
      if (key.startsWith('data-')) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value);
    }
    getAttribute(key) { return this.attrs[key] ?? null; }
    removeAttribute(key) { delete this.attrs[key]; }
    get id() { return this.attrs.id || ''; } set id(v) { this.attrs.id = v; }
    get name() { return this.attrs.name || ''; } set name(v) { this.attrs.name = v; }
    get type() { return this.attrs.type || ''; } set type(v) { this.attrs.type = v; }
    get className() { return this.attrs.class || ''; } set className(v) { this.attrs.class = v; }
    get parentElement() { return this.parentNode; }
    get classList() { return { add: c => this.classList.toggle(c, true), toggle: (c, on) => { const classes = new Set(this.className.split(/\s+/).filter(Boolean)); if (on ?? !classes.has(c)) classes.add(c); else classes.delete(c); this.className = [...classes].join(' '); } }; }
    get value() { if (this.tagName === 'select') return this._value || this.children.find(c => c.tagName === 'option')?.value || ''; return this._value; }
    set value(v) { this._value = String(v); }
    get textContent() { return this.tagName === '#text' ? this.text || '' : this.children.map(c => c.textContent).join(''); }
    set textContent(v) { this.replaceChildren(); if (v !== '') { const node = new Element('#text'); node.text = String(v); this.append(node); } }
    append(...nodes) { for (let node of nodes) { if (typeof node === 'string') { const t = new Element('#text'); t.text = node; node = t; } if (node.tagName === '#fragment') { this.append(...[...node.children]); continue; } if (node.parentNode) node.parentNode.children = node.parentNode.children.filter(c => c !== node); node.parentNode = this; this.children.push(node); } }
    replaceChildren(...nodes) { this.children.forEach(c => c.parentNode = null); this.children = []; this.append(...nodes); }
    matches(selector) {
      const ancestor = selector.lastIndexOf(' ');
      if (ancestor >= 0) { if (!this.matches(selector.slice(ancestor + 1))) return false; let p = this.parentNode; while (p) { if (p.matches(selector.slice(0, ancestor))) return true; p = p.parentNode; } return false; }
      const tag = selector.match(/^[a-z]+/i)?.[0]; if (tag && tag !== this.tagName) return false;
      const id = selector.match(/#([\w-]+)/)?.[1]; if (id && id !== this.id) return false;
      for (const m of selector.matchAll(/\.([\w-]+)/g)) if (!this.className.split(/\s+/).includes(m[1])) return false;
      for (const m of selector.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)) { if (this.getAttribute(m[1]) === null) return false; if (m[2] !== undefined && this.getAttribute(m[1]) !== m[2]) return false; }
      return true;
    }
    querySelectorAll(selector) { const out = []; const walk = node => { for (const c of node.children) { if (selector.split(',').some(s => c.matches(s.trim()))) out.push(c); walk(c); } }; walk(this); return out; }
    querySelector(s) { return this.querySelectorAll(s)[0] || null; }
    closest(s) { let node = this; while (node) { if (node.matches(s)) return node; node = node.parentNode; } return null; }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    emit(type, event = {}) { event.target ||= this; event.preventDefault ||= () => {}; for (const fn of this.listeners[type] || []) fn(event); if (['input', 'change', 'click', 'submit', 'keydown'].includes(type) && this.parentNode) this.parentNode.emit(type, event); }
    click() { if (this.type === 'radio') { for (const r of document.querySelectorAll('input')) if (r.name === this.name) r.checked = false; this.checked = true; this.emit('input'); this.emit('change'); } this.emit('click'); }
    focus() { document.activeElement = this; }
    select() { this.focus(); }
    get isConnected() { let n = this; while (n) { if (n === document) return true; n = n.parentNode; } return false; }
    showModal() { this.open = true; } close() { this.open = false; }
    reset() { for (const n of this.querySelectorAll('input, select, textarea')) { n.value = ''; n.checked = n.defaultChecked; } }
  }
  document = new Element('#document'); document.styleSheets = []; document.createElement = tag => new Element(tag); document.createDocumentFragment = () => new Element('#fragment'); document.getElementById = id => document.querySelector('#' + id);
  const stack = [document], voids = new Set(['meta', 'link', 'input', 'br', 'hr', 'img', 'path', 'rect', 'circle']);
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  for (const token of html.match(/<[^>]+>|[^<]+/g)) {
    if (/^<!/.test(token)) continue;
    if (/^<\//.test(token)) { const tag = token.match(/^<\/([^\s>]+)/)[1]; const index = stack.findLastIndex(n => n.tagName === tag); if (index > 0) stack.length = index; continue; }
    if (token.startsWith('<')) { const tag = token.match(/^<([^\s/>]+)/)[1]; const el = new Element(tag); for (const a of token.slice(tag.length + 1, -1).matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) el.setAttribute(a[1], decode(a[2] || '')); stack.at(-1).append(el); if (!voids.has(tag) && !token.endsWith('/>')) stack.push(el); }
    else stack.at(-1).append(decode(token));
  }
  document.body = document.querySelector('body');
  let now = new Date('2026-09-19T12:00:00');
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now.getTime()])); } }
  const window = new Element('#window'); window.setTimeout = () => 1; window.clearTimeout = () => {}; window.print = () => {};
  if (utilities) window.AppBox = { utilities };
  const context = vm.createContext({ window, document, Date: Clock, setTimeout: window.setTimeout, clearTimeout: window.clearTimeout, CSSRule: { PAGE_RULE: 6 } });
  vm.runInContext(fs.readFileSync(path.join(root, 'date-core.js'), 'utf8'), context);
  window.AppBoxDateTools = context.AppBoxDateTools;
  vm.runInContext(fs.readFileSync(path.join(root, 'datetools.js'), 'utf8'), context);
  const get = id => document.getElementById(id);
  const set = (id, value) => { get(id).value = value; get(id).emit('input'); get(id).emit('change'); };
  const birth = (year = '1990', month = '5', day = '15') => { set('birth-year', year); set('birth-month', month); set('birth-day', day); };
  const submit = () => get('form-age').emit('submit');
  const toggle = open => { get('reference-manual').open = open; get('reference-manual').emit('toggle'); };
  return { get, set, birth, submit, toggle, document, window, advance: day => { now = new Date(day + 'T12:00:00'); } };
}
module.exports = { fixture };
