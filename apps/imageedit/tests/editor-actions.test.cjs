const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const stamp = require("../stamp.js");

function actionsHarness(){
  const nodes=new Map(),timers=new Map(),calls=[];let nextTimer=0,nextLayer=0;
  let document;
  function node(id=""){
    const classes=new Set(["objectMenu","stampDialog","saveDialog","previewDialog"].includes(id) ? ["hidden"] : []);
    const handlers=new Map();
    const canvasContext=new Proxy({measureText:text => ({width:[...text].length*8})},
      {get:(object,key) => key in object ? object[key] : () => {}});
    return {id,value:"",disabled:false,hidden:false,children:[],files:[],type:"",tagName:"BUTTON",
      width:320,height:240,inert:false,
      classList:{add:name => classes.add(name),remove:name => classes.delete(name),contains:name => classes.has(name)},
      addEventListener(type,handler){if(!handlers.has(type)) handlers.set(type,[]);handlers.get(type).push(handler);},
      async dispatch(type,extra={}){
        const event={target:this,pointerId:1,pointerType:"mouse",clientX:120,clientY:140,key:"",prevented:false,
          preventDefault(){this.prevented=true;},stopPropagation(){this.stopped=true;},...extra};
        for(const callback of handlers.get(type) || []) await callback(event);return event;
      },
      focus(){document.activeElement=this;},appendChild(item){this.children.push(item);},replaceChildren(){this.children=[];},
      click(){return this.dispatch("click");},contains(item){return item === this || this.children.includes(item);},
      closest(){return null;},getContext:() => canvasContext,
      querySelector(){return this.children.find(item => !item.disabled) || null;},
      querySelectorAll(){return this.children.filter(item => !item.disabled);},
      getBoundingClientRect:() => ({width:180,height:240}),
      hasPointerCapture:() => false,releasePointerCapture(){calls.push("release");}
    };
  }
  const $=id => {if(!nodes.has(id)) nodes.set(id,node(id));return nodes.get(id);};
  document=node("document");document.body=node("body");document.activeElement=$ ("editCanvas");
  document.styleSheets=[];document.baseURI="https://example.test/apps/imageedit/";
  document.createElement=tag => ({...node(),tagName:tag.toUpperCase()});
  document.querySelectorAll=() => [];
  const window=node("window");window.innerWidth=1200;window.innerHeight=900;
  const state={sourceFile:{name:"example.png"},tool:"select",layers:[],revision:0,drag:null};
  let selection=[],clipboard=false;
  for(const id of ["menuCopy","menuPaste","menuDelete","menuFront","menuBack"]) $("objectMenu").appendChild($(id));
  for(const id of ["closeStamp","stampText","stampApply"]) $("stampDialog").appendChild($(id));
  const api={$ ,state,editCanvas:$("editCanvas"),canvasViewport:$("canvasViewport"),baseCanvas:{width:1000,height:700},
    toast:message => calls.push(message),selectedLayers:() => selection,
    selectLayers:layers => {selection=layers;},hitLayer:() => state.layers[0],pointFromEvent:event => ({x:event.clientX,y:event.clientY}),
    setTool:tool => {state.tool=tool;},updateSelectedControls(){},renderLayers(){},renderEditor(){},
    cancelSelectionGesture(){calls.push("cancel");state.drag=null;},
    canPaste:() => clipboard,clipboardText:() => "AppBox: image",copySelectedLayers:() => {clipboard=true;calls.push("copy");return true;},
    pasteObjectClipboard:() => calls.push("paste"),deleteSelectedLayer:() => calls.push("delete"),
    reorderSelectedLayers:front => calls.push(front ? "front" : "back"),
    createCanvas:(width,height) => ({...node(),width,height}),makeId:() => `stamp-${++nextLayer}`,
    pushHistory(){state.revision++;calls.push("history");},saveBlob:(blob,name) => calls.push({blob,name})};
  const sandbox={document,window,AppBoxImageStamp:stamp,Blob,URL,
    setTimeout:callback => {const id=++nextTimer;timers.set(id,callback);return id;},
    clearTimeout:id => timers.delete(id)};
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.resolve(__dirname,"../editor-actions.js"),"utf8"),sandbox);
  sandbox.AppBoxImageActions.initialize(api);
  return {$,state,api,calls,timers,document,setSelection:value => {selection=value;}};
}

test("右クリックメニューは対象を選択し、複数選択を保ってアプリ内コピー貼付を提供する",async () => {
  const h=actionsHarness();h.state.layers=[{id:"a"},{id:"b"}];h.setSelection(h.state.layers);
  const event=await h.$("editCanvas").dispatch("contextmenu");
  assert.equal(event.prevented,true);assert.equal(h.$("objectMenu").hidden,false);
  assert.equal(h.api.selectedLayers().length,2);assert.equal(h.$("menuPaste").disabled,true);
  await h.$("menuCopy").click();assert.equal(h.$("objectMenu").hidden,true);assert.ok(h.calls.includes("copy"));
  await h.$("editCanvas").dispatch("contextmenu");assert.equal(h.$("menuPaste").disabled,false);
  await h.$("menuPaste").click();assert.ok(h.calls.includes("paste"));
  await h.$("frontLayer").click();await h.$("backLayer").click();assert.ok(h.calls.includes("front"));assert.ok(h.calls.includes("back"));
  await h.$("editCanvas").dispatch("contextmenu");await h.$("objectMenu").dispatch("keydown",{key:"Escape"});
  assert.equal(h.$("objectMenu").hidden,true);
});

test("長押しは選択ジェスチャーを取り消してメニューを開き、移動・複数指・離指は中止する",async () => {
  const h=actionsHarness();h.state.layers=[{id:"a"}];
  await h.$("canvasViewport").dispatch("pointerdown",{target:h.$("editCanvas"),pointerType:"touch"});
  h.state.drag={mode:"moveLayer"};const callback=[...h.timers.values()][0];callback();
  assert.equal(h.$("objectMenu").hidden,false);assert.equal(h.state.drag,null);assert.ok(h.calls.includes("cancel"));
  const up=await h.$("canvasViewport").dispatch("pointerup",{target:h.$("editCanvas"),pointerType:"touch"});assert.equal(up.stopped,true);
  const moving=actionsHarness();
  await moving.$("canvasViewport").dispatch("pointerdown",{target:moving.$("editCanvas"),pointerType:"touch"});
  await moving.$("canvasViewport").dispatch("pointermove",{clientX:130,clientY:140,pointerType:"touch"});assert.equal(moving.timers.size,0);
  await moving.$("canvasViewport").dispatch("pointerup");
  await moving.$("canvasViewport").dispatch("pointerdown",{target:moving.$("editCanvas"),pointerType:"touch"});
  await moving.$("canvasViewport").dispatch("pointerdown",{target:moving.$("editCanvas"),pointerType:"touch",pointerId:2});assert.equal(moving.timers.size,0);
});

test("スタンプはダイアログでプレビューし独立した画像レイヤーを追加して一度の履歴にする",async () => {
  const h=actionsHarness();await h.$("openStamp").click();
  assert.equal(h.$("stampDialog").classList.contains("hidden"),false);assert.equal(h.$("appMain").inert,true);
  await h.$("stampDialog").dispatch("keydown",{key:"Escape",isComposing:true});
  assert.equal(h.$("stampDialog").classList.contains("hidden"),false,"IME取消ではダイアログを閉じない");
  h.state.composing=true;await h.$("stampDialog").dispatch("keydown",{key:"Escape"});
  assert.equal(h.$("stampDialog").classList.contains("hidden"),false);h.state.composing=false;
  assert.equal(h.$("stampPreset").children.length,stamp.PRESETS.length+1);
  h.$("stampText").value="受付\n{date}\n担当";
  await h.$("stampText").dispatch("input");assert.equal(h.$("stampApply").disabled,false);
  await h.$("stampApply").click();
  assert.equal(h.state.layers.length,1);const layer=h.state.layers[0];
  assert.equal(layer.type,"image");assert.equal(layer.opacity,100);assert.equal(layer.visible,true);
  assert.equal(layer.x,(1000-layer.w)/2);assert.equal(layer.y,(700-layer.h)/2);
  assert.equal(h.state.revision,1);assert.equal(h.$("stampDialog").classList.contains("hidden"),true);
  assert.equal(h.$("appMain").inert,false);assert.equal(h.api.selectedLayers()[0],layer);
  assert.notEqual(layer.imageCanvas,h.$("stampPreviewCanvas"));
  const alpha=[];
  const context={globalAlpha:1,save(){},restore(){},drawImage(){alpha.push(this.globalAlpha);}};
  const imageSource=fs.readFileSync(path.resolve(__dirname,"../image.js"),"utf8");
  const drawing=imageSource.slice(imageSource.indexOf("  function drawLayer("),imageSource.indexOf("  function compositeCanvas(){"));
  const scope={context,layer,baseCanvas:{},layerContext:null,editContext:null,clamp:(value,min,max) => Math.min(max,Math.max(min,value))};
  vm.createContext(scope);vm.runInContext(`${drawing}\ndrawLayer(context,layer);`,scope);
  assert.deepEqual(alpha,[1],"配置したスタンプは画像保存時に100%の不透明度で描画される");
});

test("スタンプの無効入力は配置を止め、テンプレートの保存読込はファイルだけを使う",async () => {
  const h=actionsHarness();h.$("stampText").value="あ".repeat(21);
  await h.$("stampText").dispatch("input");assert.equal(h.$("stampApply").disabled,true);
  await h.$("stampApply").click();assert.equal(h.state.layers.length,0);
  h.$("stampText").value="確認";h.$("stampName").value="確認済";
  await h.$("stampSaveTemplate").click();
  const saved=h.calls.find(item => typeof item === "object" && item.name);
  assert.equal(saved.name,"imageedit-stamp-templates.json");const source=await saved.blob.text();
  h.$("stampTemplateInput").files=[{size:source.length,text:async () => source}];
  await h.$("stampTemplateInput").dispatch("change");assert.equal(h.$("stampText").value,"確認");
  assert.equal(h.$("stampName").value,"確認済");
  h.$("stampTemplateInput").files=[{size:stamp.MAX_FILE_BYTES+1,text:async () => {throw new Error("must not read");}}];
  await h.$("stampTemplateInput").dispatch("change");assert.ok(h.calls.some(item => typeof item === "string" && item.includes("200KB")));
});
