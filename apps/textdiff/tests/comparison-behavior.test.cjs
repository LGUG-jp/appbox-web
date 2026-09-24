const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const appDirectory = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(appDirectory, 'index.html'), 'utf8');
const script = fs.readFileSync(path.join(appDirectory, 'textdiff.js'), 'utf8');

// 必要なDOM操作だけを代替し、変更を加えていない本体スクリプトを実行する。
// レイアウト、ネイティブのフォーカス及びキーボード操作は実ブラウザで確認する。
function createApp() {
  let document;
  class Element {
    constructor(tag='div') {
      this.tagName=tag.toUpperCase(); this.children=[]; this.events={}; this.dataset={}; this.style={}; this.attributes={};
      this.value=''; this.checked=false; this.disabled=false; this.hidden=false; this.className=''; this.open=false; this.scrollTop=0;
      this.scrollHeight=1000; this.clientHeight=200;
      this.classList={add:(...names)=>{this.className=[...new Set([...this.className.split(/\s+/),...names])].filter(Boolean).join(' ');},remove:(...names)=>{this.className=this.className.split(/\s+/).filter(n=>!names.includes(n)).join(' ');}};
    }
    set textContent(v) { this.children=[]; this._text=String(v); }
    get textContent() { return (this._text||'')+this.children.map(c=>c.textContent).join(''); }
    appendChild(c) { if(c.tagName==='#FRAGMENT') this.children.push(...c.children); else this.children.push(c); return c; }
    replaceChildren(...children) { this._text=''; this.children=[]; children.forEach(c=>this.appendChild(c)); }
    setAttribute(k,v) { this.attributes[k]=v; }
    addEventListener(k,f) { (this.events[k] ||= []).push(f); }
    emit(k,extra={}) { for(const f of this.events[k]||[]) f({target:this,currentTarget:this,preventDefault(){},...extra}); }
    focus() { document.activeElement=this; }
    querySelectorAll(s) {
      const found=[]; const match=s.match(/^\[data-change-group="(\d+)"\]$/);
      const visit=e=>{for(const c of e.children){if((s.startsWith('.')&&c.className.split(/\s+/).includes(s.slice(1)))||(match&&c.dataset.changeGroup===match[1]))found.push(c);visit(c);}};
      visit(this); return found;
    }
    querySelector(s) { return this.querySelectorAll(s)[0]||null; }
    close() {this.open=false;this.emit('close');}
    scrollIntoView() {}
  }
  const elements={}; const body=new Element('body'); const radios=[];
  for(const m of html.matchAll(/<([\w-]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const e=new Element(m[1]);e.id=m[3];e.checked=/\bchecked\b/.test(m[2]);e.hidden=/\bhidden\b/.test(m[2]);elements[e.id]=e;body.appendChild(e);
  }
  for(const m of html.matchAll(/<input\b([^>]*\bname="diffMode"[^>]*)>/g)) {
    const e=new Element('input');e.value=m[1].match(/value="([^"]+)"/)[1];e.checked=/\bchecked\b/.test(m[1]);radios.push(e);elements.diffMode.appendChild(e);
  }
  document={body,activeElement:null,getElementById:id=>elements[id],querySelectorAll:s=>s==='input[name="diffMode"]'?radios:body.querySelectorAll(s),createElement:t=>new Element(t),createDocumentFragment:()=>new Element('#fragment'),createTextNode:v=>{const e=new Element('#text');e.textContent=v;return e;},addEventListener(){}};
  const queue=[];const errors=[];const con={error:(...args)=>errors.push(args.map(x=>x?.code||String(x)).join(' '))};
  const window={console:con,confirm:()=>true,matchMedia:()=>({matches:false})};
  vm.runInNewContext(script,{document,window,navigator:{},performance,console:con,requestAnimationFrame:f=>queue.push(f)});
  const flush=()=>{for(let n=0;queue.length&&n<100;n++)queue.shift()();assert.equal(queue.length,0);};
  const setText=(a,b)=>{elements.oldText.value=a;elements.oldText.emit('input');elements.newText.value=b;elements.newText.emit('input');};
  const setMode=v=>{radios.forEach(r=>r.checked=r.value===v);elements.diffMode.emit('change');};
  const compare=()=>{elements.compareBtn.emit('click');flush();};
  const changeRule=(id,value)=>{elements[id].checked=value;elements[id].emit('change');};
  const toggle=(id,value)=>{changeRule(id,value);flush();};
  return {elements,radios,document,errors,flush,setText,setMode,compare,toggle,changeRule};
}

for (const mode of ['line-char', 'char', 'line']) {
  test(`${mode}: 比較ルール変更で結果を更新し、原文を維持する`, () => {
    for (const [option, oldValue, newValue] of [
      ['optNormalizeSpace', 'a  b', 'a b'],
      ['optNormalizeWidth', 'Ａ１２', 'A12'],
      ['optNormalizeBlankLines', 'a\n\nb', 'a\nb']
    ]) {
      const app = createApp();
      const e = app.elements;
      app.setMode(mode);
      app.setText(oldValue, newValue);
      app.compare();
      assert.equal(e.resultsPanel.hidden, false);
      assert.notEqual(e.statChanges.textContent, '0');
      app.toggle(option, true);
      assert.equal(e.statChanges.textContent, '0');
      assert.equal(e.statSimilarity.textContent, '100%');
      assert.equal(app.document.activeElement, e[option]);
      app.toggle(option, false);
      assert.notEqual(e.statChanges.textContent, '0');
      assert.equal(e.oldText.value, oldValue);
      assert.equal(e.newText.value, newValue);
      assert.deepEqual(app.errors, []);
    }
  });
}

test('自動再比較の上限エラー後、設定を戻すと結果が復帰する', () => {
  const app = createApp();
  const e = app.elements;
  const longText = 'a' + ' '.repeat(16000) + 'b';
  app.setText(longText, longText);
  app.toggle('optNormalizeSpace', true);
  app.compare();
  assert.equal(e.resultsPanel.hidden, false);
  app.toggle('optNormalizeSpace', false);
  assert.match(e.status.textContent, /30,000/);
  assert.equal(e.resultsPanel.hidden, true);
  assert.equal(e.copyBtn.disabled, true);
  assert.equal(e.compareBtn.disabled, false);
  app.toggle('optNormalizeSpace', true);
  assert.equal(e.resultsPanel.hidden, false);
  assert.equal(e.statSimilarity.textContent, '100%');
  assert.equal(e.copyBtn.disabled, false);
  assert.equal(e.printBtn.disabled, false);
  assert.equal(app.document.activeElement, e.optNormalizeSpace);
});

test('初回比較前と、入力・比較単位・クリア変更後は自動比較しない', () => {
  for (const reset of [
    app => app.setText('another old text', 'another new text'),
    app => app.setMode('line'),
    app => app.elements.clearBtn.emit('click'),
    app => app.elements.sampleBtn.emit('click'),
    app => app.elements.swapBtn.emit('click')
  ]) {
    const app = createApp();
    const e = app.elements;
    app.setText('a  b', 'a b');
    app.toggle('optNormalizeSpace', true);
    assert.equal(e.resultsPanel.hidden, true);
    app.compare();
    assert.equal(e.resultsPanel.hidden, false);
    reset(app);
    app.toggle('optNormalizeWidth', true);
    assert.equal(e.resultsPanel.hidden, true);
    assert.equal(e.copyBtn.disabled, true);
    app.compare();
    assert.equal(e.resultsPanel.hidden, false);
    assert.deepEqual(app.errors, []);
  }
});

test('再比較待ち中の入力変更で古い結果を破棄し、自動再比較を解除する', () => {
  const app = createApp();
  const e = app.elements;
  app.setText('a  b', 'a b');
  app.compare();
  app.changeRule('optNormalizeSpace', true);
  assert.equal(e.compareBtn.disabled, true);
  app.setText('edited', 'different');
  app.flush();
  assert.equal(e.resultsPanel.hidden, true);
  assert.equal(e.compareBtn.disabled, false);
  app.toggle('optNormalizeWidth', true);
  assert.equal(e.resultsPanel.hidden, true);
  app.compare();
  assert.equal(e.resultsPanel.hidden, false);
  assert.deepEqual(app.errors, []);
});
