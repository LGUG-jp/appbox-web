const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "image.js"), "utf8");

function createView(width=4000,height=3000) {
  const elements = new Map();
  const rule = {style:{}};
  const viewport = {
    clientWidth:1000,clientHeight:600,clientLeft:0,clientTop:0,
    scrollLeft:0,scrollTop:0,
    getBoundingClientRect:() => ({left:10,top:20}),
  };
  const holder = {getBoundingClientRect:() => ({
    left:10+Math.max(0,(viewport.clientWidth-parseFloat(rule.style.width))/2)-viewport.scrollLeft,
    top:20-viewport.scrollTop,
  })};
  const canvas = {width,height};
  const state = {
    sourceFile:{name:"sample.png"},singleBusy:false,drag:null,
    layers:[{type:"rect",x:1000,y:500,w:800,h:400}],undo:[],redo:[],
  };
  const viewState = {mode:"fit",scale:1,pan:null,rule:null,pending:false};
  const context = vm.createContext({
    baseCanvas:canvas,editCanvas:{...canvas,getBoundingClientRect:() => ({
      ...holder.getBoundingClientRect(),
      width:parseFloat(rule.style.width),height:parseFloat(rule.style.height),
    })},
    canvasViewport:viewport,canvasHolder:holder,state,viewState,URL,
    document:{baseURI:"https://example.test/apps/imageedit/",styleSheets:[{
      href:"https://example.test/apps/imageedit/image.css?v=1.3.0",cssRules:[],
      insertRule(){this.cssRules.push(rule);return 0;},
    }]},
    $:id => {
      if(!elements.has(id)) elements.set(id,{value:"",setAttribute(){}});
      return elements.get(id);
    },
    clamp:(value,min,max) => Math.min(max,Math.max(min,value)),
    renderEditor(){},requestAnimationFrame:callback => callback(),
  });
  const zoomStart = source.indexOf("  function fitDisplayScale(){");
  const zoomEnd = source.indexOf('  $("zoomOut").addEventListener',zoomStart);
  const pointStart = source.indexOf("  function pointFromEvent(event){");
  const pointEnd = source.indexOf("  function normalizeRectangle",pointStart);
  assert.ok(zoomStart >= 0 && zoomEnd > zoomStart && pointStart >= 0 && pointEnd > pointStart);
  vm.runInContext(source.slice(zoomStart,zoomEnd)+source.slice(pointStart,pointEnd),context);
  return {context,state,viewState,viewport,rule,canvas,elements};
}

test("全体表示・100%・400%でも画像座標と保存寸法・履歴を変更しない", () => {
  const view = createView();
  const before = JSON.stringify(view.state);
  vm.runInContext("syncDisplaySize()",view.context);
  assert.equal(view.viewState.scale,.2);
  assert.equal(view.rule.style.width,"800px");
  assert.equal(view.rule.style.height,"600px");
  for(const zoom of [1,4,.1]) {
    vm.runInContext(`setDisplayZoom(${zoom})`,view.context);
    assert.equal(parseFloat(view.rule.style.width)/parseFloat(view.rule.style.height),4/3);
    assert.equal(view.elements.get("zoomValue").value,zoom*100);
  }
  assert.deepEqual(view.canvas,{width:4000,height:3000});
  assert.equal(JSON.stringify(view.state),before);
});

test("ウィンドウやページ倍率で表示領域が変わっても三層の画像座標が一致する", () => {
  const view = createView();
  for(const size of [[1000,600],[320,420],[640,300],[1800,1000],[1920,980],[2560,1780]]) {
    [view.viewport.clientWidth,view.viewport.clientHeight] = size;
    vm.runInContext("syncDisplaySize()",view.context);
    const rect = view.context.editCanvas.getBoundingClientRect();
    const point = view.context.pointFromEvent({
      clientX:rect.left+1000*view.viewState.scale,
      clientY:rect.top+500*view.viewState.scale,
    });
    assert.ok(Math.abs(point.x-1000)<1e-8);
    assert.ok(Math.abs(point.y-500)<1e-8);
    assert.ok(Math.abs(parseFloat(view.rule.style.width)/parseFloat(view.rule.style.height)-4/3)<1e-10);
    assert.ok(Math.abs(view.context.displayScale()-1/view.viewState.scale)<1e-10);
  }
});

test("拡大の中心を保ち、スクロール後も編集対象の座標へ変換できる", () => {
  const view = createView();
  vm.runInContext("syncDisplaySize(); setDisplayZoom(1)",view.context);
  assert.equal(view.viewport.scrollLeft,1500);
  assert.equal(view.viewport.scrollTop,1200);
  const rect = view.context.editCanvas.getBoundingClientRect();
  const point = view.context.pointFromEvent({clientX:510,clientY:320});
  assert.equal(point.x,2000);
  assert.equal(point.y,1500);
  view.viewport.scrollLeft = 700;
  view.viewport.scrollTop = 300;
  const panRect = view.context.editCanvas.getBoundingClientRect();
  const after = view.context.pointFromEvent({clientX:panRect.left+1000,clientY:panRect.top+500});
  assert.equal(after.x,1000);
  assert.equal(after.y,500);
  assert.ok(rect.left < 0);
  vm.runInContext('setDisplayZoom(1,"fit")',view.context);
  assert.equal(view.viewport.scrollLeft,0);
  assert.equal(view.viewport.scrollTop,0);
});

test("表示倍率の上限と編集中・読込み中の倍率変更を制御する", () => {
  const view = createView();
  vm.runInContext("syncDisplaySize(); setDisplayZoom(100)",view.context);
  assert.equal(view.viewState.scale,4);
  view.state.drag = {mode:"shape"};
  vm.runInContext("setDisplayZoom(.5)",view.context);
  assert.equal(view.viewState.scale,4);
  view.state.drag = null;
  view.state.singleBusy = true;
  vm.runInContext("setDisplayZoom(.5)",view.context);
  assert.equal(view.viewState.scale,4);
  view.state.singleBusy = false;
  vm.runInContext("setDisplayZoom(.001)",view.context);
  assert.equal(view.viewState.scale,.05);
});

test("幅に合わせる表示は縦長画像でも横幅を使い、画像寸法と注釈座標を変更しない",() => {
  const view=createView(1000,2000);
  const before=JSON.stringify(view.state);
  vm.runInContext('syncDisplaySize();setDisplayZoom(1,"width")',view.context);
  assert.equal(view.viewState.scale,1);assert.equal(view.rule.style.width,"1000px");assert.equal(view.rule.style.height,"2000px");
  view.viewport.clientWidth=500;vm.runInContext("syncDisplaySize()",view.context);
  assert.equal(view.viewState.scale,.5);assert.equal(view.rule.style.width,"500px");assert.equal(view.rule.style.height,"1000px");
  assert.equal(JSON.stringify(view.state),before);assert.deepEqual(view.canvas,{width:1000,height:2000});
  const small=createView(100,100);vm.runInContext('setDisplayZoom(1,"width")',small.context);
  assert.equal(small.viewState.scale,4,"表示倍率の上限400%を維持する");
});

test("画像上のホイール位置を基準に拡大縮小し、スクロール後も同じ画像座標を保つ",() => {
  const view=createView();
  vm.runInContext("syncDisplaySize();setDisplayZoom(1)",view.context);
  const event={clientX:310,clientY:220};
  view.context.wheelEvent=event;
  const before=view.context.pointFromEvent(event),snapshot=JSON.stringify(view.state);
  for(const scale of [1.5,.75,2]){
    view.context.requestedScale=scale;
    vm.runInContext('setDisplayZoom(requestedScale,"manual",displayAnchorAtEvent(wheelEvent))',view.context);
    const after=view.context.pointFromEvent(event);
    assert.ok(Math.abs(after.x-before.x)<1e-8);
    assert.ok(Math.abs(after.y-before.y)<1e-8);
    assert.equal(view.viewport.scrollLeft,before.x*scale-300);
    assert.equal(view.viewport.scrollTop,before.y*scale-200);
    assert.equal(JSON.stringify(view.state),snapshot);
  }
  assert.deepEqual(view.canvas,{width:4000,height:3000});
});

test("画像の外の作業領域は中心を基準にし、入力位置を画像の端へ飛ばさない",() => {
  const view=createView();
  vm.runInContext("syncDisplaySize()",view.context);
  assert.equal(view.context.displayAnchorAtEvent({clientX:40,clientY:100}),null);
  assert.equal(view.context.displayAnchorAtEvent({clientX:NaN,clientY:100}),null);
});
