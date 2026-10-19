const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Run the real editor and dispatch its registered handlers without starting a
// browser. Canvas drawing is stubbed; these tests cover object state and focus.
function createEditor({loaded=true,separateEditContext=false,withActions=false}={}){
  const elements = new Map();
  const animationFrames = [];
  let document;
  let serial = 0;
  const timers = new Map();
  let timerId = 0;
  const context = new Proxy({
    calls:[],
    fillRect(...args){this.calls.push({method:"fillRect",args,fillStyle:this.fillStyle});},
    clearRect(...args){this.calls.push({method:"clearRect",args});},
    strokeRect(...args){this.calls.push({method:"strokeRect",args,strokeStyle:this.strokeStyle});},
    drawImage(...args){this.calls.push({method:"drawImage",args});},
    measureText: text => ({width:Math.max(1,text.length*18),actualBoundingBoxAscent:30,actualBoundingBoxDescent:8}),
    getImageData: () => ({data:new Uint8ClampedArray(4)}),
    createImageData: () => ({data:new Uint8ClampedArray(4)})
  },{get:(target,key) => key in target ? target[key] : () => {}});
  const overlayContext=new Proxy({...context,calls:[]},{get:(target,key) => key in target ? target[key] : () => {}});

  function element(id="",tagName="DIV"){
    const classes = new Set(["previewDialog","saveDialog","contextPanel","editorActions"].includes(id) ? ["hidden"] : []);
    const listeners = new Map();
    return {
      id,tagName,ownerDocument:document,type:"",value:"",checked:false,disabled:false,hidden:false,
      width:0,height:0,clientWidth:1000,clientHeight:700,clientLeft:0,clientTop:0,
      scrollLeft:0,scrollTop:0,dataset:{},style:{},children:[],isContentEditable:false,attributes:new Map(),
      set innerHTML(value){this.children=[];},
      captured:new Set(),
      classList:{
        add:(...names) => names.forEach(name => classes.add(name)),
        remove:(...names) => names.forEach(name => classes.delete(name)),
        contains:name => classes.has(name),
        toggle:(name,force) => {
          const show = force === undefined ? !classes.has(name) : force;
          if(show) classes.add(name); else classes.delete(name);
          return show;
        }
      },
      addEventListener(type,listener){
        if(!listeners.has(type)) listeners.set(type,[]);
        listeners.get(type).push(listener);
      },
      async dispatch(type,properties={}){
        const event = {type,target:this,key:"",button:0,pointerId:1,
          clientX:0,clientY:0,prevented:false,defaultPrevented:false,isComposing:false,
          preventDefault(){this.prevented=true;this.defaultPrevented=true;},stopPropagation(){this.stopped=true;},...properties};
        for(const listener of listeners.get(type) || []) await listener(event);
        return event;
      },
      focus(){
        const old = document.activeElement;
        if(old && old !== this) old.dispatch("blur");
        document.activeElement = this;
        if(old !== this) this.dispatch("focus");
      },
      select(){this.textSelected=true;},
      setSelectionRange(start,end){this.selectionStart=start;this.selectionEnd=end;},
      closest(selector=""){
        for(let node=this;node;node=node.parentElement){
          if(selector === ".hidden" && node.classList?.contains("hidden")) return node;
          if(selector === "button" && node.tagName === "BUTTON") return node;
          if((selector.includes("input") || selector.includes("textarea") || selector.includes("select") || selector.includes("contenteditable")) &&
            (["INPUT","TEXTAREA","SELECT"].includes(node.tagName) || node.isContentEditable)) return node;
        }
        return null;
      },
      checkValidity:() => true,
      getContext:() => separateEditContext && id === "editCanvas" ? overlayContext : context,
      getBoundingClientRect(){return {left:0,top:0,width:this.width || 1000,height:this.height || 700};},
      setPointerCapture(id){this.captured.add(id);},releasePointerCapture(id){this.captured.delete(id);},
      hasPointerCapture(id){return this.captured.has(id);},
      setAttribute(name,value){this.attributes.set(name,String(value));},getAttribute(name){return this.attributes.get(name) ?? null;},
      removeAttribute(name){this.attributes.delete(name);},append(...items){items.forEach(item => this.appendChild(item));},
      appendChild(item){item.parentElement=this;this.children.push(item);},remove(){},click(){},
      querySelector(){return this.children.find(node => !node.disabled) || null;},
      querySelectorAll(){return this.id === "objectMenu" ? this.children.filter(node => !node.disabled) : [];},
      contains(item){return item === this || this.children.some(child => child.contains?.(item));}
    };
  }

  document = element("document");
  document.body = element("body");
  document.activeElement = document.body;
  document.getElementById = id => {
    if(["textWidth","deleteLayer","layersPanel","layerList","layerSummary","cropX","cropY","resetCrop","stageHelp","contextHint","contextPanelHandle","resetContextPanel"].includes(id)) return null;
    if(!elements.has(id)){
      const tag = ["changeSingle","undo","redo","resetSingle","changeProcessingMode","previewButton","showSaveSettings","singleTab","batchTab","decreaseFontSize","increaseFontSize","frontLayer","backLayer"].includes(id) || id.startsWith("menu") ? "BUTTON" : id === "textEditor" ? "TEXTAREA" : id === "cropRatio" ? "SELECT" : /^(annotationColor|fontSize|lineWidth|brushSize|mosaicSize|imageOpacity|zoomValue|textBgColor|whiteOutline|boldText|textBgTransparent|shapeFill|shapeFillNone|fontFamily|inkStabilizer|cropW|cropH)$/.test(id) ? "INPUT" : "DIV";
      elements.set(id,element(id,tag));
      if(id === "imageHeaderActions"){elements.get(id).hidden=true;elements.get(id).inert=true;}
      if(["whiteOutline","boldText","textBgTransparent","shapeFillNone"].includes(id)) elements.get(id).type="checkbox";
      if(["annotationColor","textBgColor","shapeFill"].includes(id)) elements.get(id).type="color";
      if(id === "fontSize") elements.get(id).type="number";
    }
    return elements.get(id);
  };
  document.createElement = tag => element("",tag.toUpperCase());
  const tabs=[document.getElementById("singleTab"),document.getElementById("batchTab")];
  tabs[0].dataset.panel="singlePanel";tabs[1].dataset.panel="batchPanel";
  tabs[0].setAttribute("aria-selected","true");tabs[1].setAttribute("aria-selected","false");
  document.getElementById("processingModeTabs").append(...tabs);
  document.getElementById("batchPanel").hidden=true;
  const header=document.getElementById("appHeader"),actions=document.getElementById("imageHeaderActions");
  header.appendChild(actions);
  header.appendChild(document.getElementById("changeProcessingMode"));
  for(const id of ["changeSingle","undo","redo","resetSingle","previewButton","showSaveSettings"]) actions.appendChild(document.getElementById(id));
  const contextPanel=document.getElementById("contextPanel"),editorActions=document.getElementById("editorActions"),workarea=document.getElementById("canvasWorkarea");
  const sidebar=element("","ASIDE");
  const stage=element("","SECTION");stage.append(workarea,document.getElementById("zoomControls"));
  const settingsPanel=element("","ASIDE");settingsPanel.appendChild(contextPanel);
  document.getElementById("singleWorkspace").append(sidebar,stage,settingsPanel);
  workarea.appendChild(document.getElementById("canvasViewport"));
  document.getElementById("zoomControls").height=44;
  for(const id of ["zoomOut","zoomIn","zoomFit","zoomWidth","zoomActual","zoomValue"]) document.getElementById("zoomControls").appendChild(document.getElementById(id));
  const settings=[["text",["fontFamily","fontSize","decreaseFontSize","increaseFontSize"]],
    ["color",["annotationColor","annotationColorLabel"]],["text",["boldText"]],["line",["lineWidth"]],
    ["text",["textBgColor","textBgTransparent","textFillLabel"]],["fill",["shapeFill","shapeFillNone","shapeFillLabel"]],
    ["outline",["whiteOutline"]],["brush",["brushSize"]],["mosaic",["mosaicSize"]],
    ["ink",["inkStabilizer"]],["image",["imageOpacity"]]]
    .map(([name,ids],index) => {
      const group=element(`settings-${name}-${index}`);group.dataset.settings=name;
      ids.forEach(id => group.appendChild(document.getElementById(id)));contextPanel.appendChild(group);return group;
    });
  const contexts=["crop","transform"].map(name => {
    const group=element(`context-${name}`);group.dataset.context=name;contextPanel.appendChild(group);return group;
  });
  contextPanel.appendChild(editorActions);
  editorActions.append(document.getElementById("frontLayer"),document.getElementById("backLayer"));
  document.querySelectorAll = selector => selector === ".appbox-tab" ? tabs : selector === ".appbox-header" ? [header]
    : selector === "[data-settings]" ? settings : selector === "[data-context]" ? contexts : [];
  document.querySelector = selector => selector === ".appbox-header" ? header : null;
  document.baseURI="https://appbox.test/apps/imageedit/";
  document.styleSheets = [{
    href:"https://appbox.test/apps/imageedit/image.css?v=1.4.1",cssRules:[],
    insertRule(selector,index){
      this.cssRules.splice(index,0,{selectorText:selector.replace(/\s*\{.*$/,""),style:{setProperty(name,value){this[name]=value;}}});
      return index;
    }
  }];
  const window = element("window");
  document.defaultView=window;
  window.confirm = () => true;
  window.AppBoxImageDrawing = require("../drawing-core.js");
  window.AppBoxImageAnnotation = require("../annotation-style.js");
  // Other interaction tests exercise canvas state; the real guard has separate tests.
  window.AppBoxSafeImage = {readDimensions:async()=>({width:1,height:1}),assertDimensions(){}};
  window.crypto = {randomUUID:() => `copy-${++serial}`};
  window.getSelection = () => ({toString:() => ""});
  window.createImageBitmap = async () => ({width:240,height:120,close(){}});
  const sandbox = {document,window,AppBoxImageAnnotation:window.AppBoxImageAnnotation,
    crypto:window.crypto,requestAnimationFrame:callback => {animationFrames.push(callback);return animationFrames.length;},
    createImageBitmap:window.createImageBitmap,
    setTimeout:(callback,delay) => {const id=++timerId;timers.set(id,{callback,delay});return id;},
    clearTimeout:id => timers.delete(id),Blob,TextEncoder,URL};
  vm.createContext(sandbox);
  if(withActions){
    for(const id of ["menuCopy","menuPaste","menuDelete","menuFront","menuBack"]) document.getElementById("objectMenu").appendChild(document.getElementById(id));
    vm.runInContext(fs.readFileSync(path.join(__dirname,"..","editor-actions.js"),"utf8"),sandbox);
    window.AppBoxImageActions=sandbox.AppBoxImageActions;
  }
  const source = fs.readFileSync(path.join(__dirname,"..","image.js"),"utf8")
    .replace(/\}\)\(\);\s*$/, "globalThis.editor={state,batchState,viewState,setTool,undo,redo,pasteCopiedLayer,trimLayersAfterCrop,reorderSelectedLayers,hasUnsavedChanges,loadSingleFile,selectLayers,updateSelectedControls,updateBatchControls,renderEditor,beginTextEditing,finishTextEditing,syncTextEditor};})();");
  vm.runInContext(source,sandbox);
  const get = document.getElementById;
  get("textEditorHost").appendChild(get("textEditor"));
  for(const id of ["baseCanvas","layerCanvas","editCanvas"]){get(id).width=loaded ? 1000 : 0;get(id).height=loaded ? 700 : 0;}
  get("annotationColor").value="#ff0000";
  get("fontSize").value="42";
  get("lineWidth").value="8";
  get("brushSize").value="50";
  get("mosaicSize").value="18";
  get("fontFamily").value="yu-gothic-ui";
  get("boldText").checked=true;
  get("whiteOutline").checked=false;
  get("textBgTransparent").checked=true;
  get("shapeFillNone").checked=true;
  get("inkStabilizer").value="none";
  get("cropRatio").value="free";
  sandbox.editor.state.sourceFile = loaded ? {name:"test.png",type:"image/png"} : null;
  const originalCanvas=document.createElement("canvas");
  originalCanvas.width=1000;originalCanvas.height=700;
  sandbox.editor.state.originalCanvas = loaded ? originalCanvas : null;
  sandbox.editor.setTool(loaded ? "select" : null);
  get("editCanvas").focus();
  return {...sandbox.editor,get,document,window,
    holdTouch(){for(const [id,timer] of [...timers]) if(timer.delay === 600){timers.delete(id);timer.callback();}},
    flushAnimationFrames(){for(let count=0;animationFrames.length && count<100;count++) animationFrames.shift()();},
    setImageBitmap(decoder){sandbox.createImageBitmap=decoder;window.createImageBitmap=decoder;}};
}

function textLayer(){
  return {id:"text-1",type:"text",text:"もとの文字",x:100,y:150,fontSize:42,color:"#ff0000",visible:true};
}

test("読込み後は加工タブを隠し、加工方法を変更しても編集内容・履歴・未保存状態を保持する",async () => {
  const editor=createEditor(),tabs=editor.get("processingModeTabs"),change=editor.get("changeProcessingMode");
  editor.state.layers=[rectangleLayer()];editor.selectLayers(editor.state.layers);
  await editor.document.dispatch("keydown",{target:editor.get("editCanvas"),key:"ArrowRight"});
  const before=JSON.stringify(editor.state.layers),revision=editor.state.revision,undo=editor.state.undo.length;
  assert.equal(tabs.hidden,true);assert.equal(tabs.inert,true);assert.equal(change.hidden,false);
  await change.dispatch("click");assert.equal(tabs.hidden,false);assert.equal(tabs.inert,false);
  assert.equal(change.getAttribute("aria-expanded"),"true");assert.equal(editor.document.activeElement,editor.get("singleTab"));
  await editor.get("batchTab").dispatch("click");assert.equal(tabs.hidden,false);assert.equal(change.hidden,true);
  await editor.get("singleTab").dispatch("click");assert.equal(tabs.hidden,true);assert.equal(change.hidden,false);
  assert.equal(editor.document.activeElement,editor.get("editCanvas"));
  assert.equal(JSON.stringify(editor.state.layers),before);assert.equal(editor.state.revision,revision);
  assert.equal(editor.state.undo.length,undo);assert.equal(editor.hasUnsavedChanges(),true);
});

test("一括画像の追加後もタブを隠し、処理中は変更を止め、画像がなくなれば選択肢を戻す",async () => {
  const editor=createEditor({loaded:false}),tabs=editor.get("processingModeTabs"),change=editor.get("changeProcessingMode");
  assert.equal(tabs.hidden,false);assert.equal(change.hidden,true);
  await editor.get("batchTab").dispatch("click");
  editor.batchState.items.push({file:{name:"batch.png"}});editor.updateBatchControls();
  assert.equal(tabs.hidden,true);assert.equal(change.hidden,false);
  editor.batchState.processing=true;editor.updateBatchControls();
  assert.equal(change.disabled,true);await change.dispatch("click");assert.equal(tabs.hidden,true);
  editor.batchState.processing=false;editor.updateBatchControls();await change.dispatch("click");
  assert.equal(tabs.hidden,false);await editor.get("batchTab").dispatch("click");
  assert.equal(tabs.hidden,true);assert.equal(editor.document.activeElement,editor.get("batchAdd"));
  editor.batchState.items=[];editor.updateBatchControls();assert.equal(tabs.hidden,false);assert.equal(change.hidden,true);
});

for(const input of ["file","paste"]){
  for(const valid of [true,false]){
    test(`画像の${input === "file" ? "ファイル追加" : "貼り付け"}が${valid ? "成功" : "失敗"}した後も加工方法を変更できる`,async () => {
      const editor=createEditor(),change=editor.get("changeProcessingMode"),tabs=editor.get("processingModeTabs");
      const source=editor.state.sourceFile,original=editor.state.originalCanvas;
      const layerData=() => JSON.stringify(editor.state.layers,(key,value) => key === "imageCanvas" ? undefined : value);
      let finish;
      editor.setImageBitmap(() => new Promise(resolve => {finish=resolve;}));
      if(input === "file"){
        editor.get("imageLayerInput").files=[{name:"extra.png",type:"image/png",size:1024}];
        await editor.get("imageLayerInput").dispatch("change");
      }else{
        await editor.document.dispatch("paste",{target:editor.get("editCanvas"),clipboardData:imageClipboard()});
      }
      assert.equal(editor.state.singleBusy,true);assert.equal(change.disabled,true);
      await change.dispatch("click");assert.equal(tabs.hidden,true);
      await Promise.resolve();
      finish({width:valid ? 240 : 8193,height:120,close(){}});
      await finishImagePaste();editor.flushAnimationFrames();
      assert.equal(editor.state.singleBusy,false);assert.equal(change.disabled,false);
      assert.equal(editor.state.layers.length,valid ? 1 : 0);
      assert.equal(editor.state.undo.length,valid ? 1 : 0);
      const before=layerData(),revision=editor.state.revision,undo=editor.state.undo.length;
      const imageCanvas=editor.state.layers[0]?.imageCanvas;
      await change.dispatch("click");assert.equal(tabs.hidden,false);
      await editor.get("batchTab").dispatch("click");
      await editor.get("singleTab").dispatch("click");
      assert.equal(tabs.hidden,true);assert.equal(change.disabled,false);
      assert.equal(editor.state.sourceFile,source);assert.equal(editor.state.originalCanvas,original);
      assert.equal(layerData(),before);assert.equal(editor.state.layers[0]?.imageCanvas,imageCanvas);
      assert.equal(editor.state.revision,revision);assert.equal(editor.state.undo.length,undo);
      assert.equal(editor.hasUnsavedChanges(),valid);
    });
  }
}

test("タッチで矩形複数選択し、対象上と余白の長押しから全選択を削除してUndoで戻せる",async () => {
  for(const point of [[125,125],[700,500]]){
    const editor=createEditor({withActions:true}),canvas=editor.get("editCanvas"),viewport=editor.get("canvasViewport");
    editor.state.layers=[rectangleLayer(),rectangleLayer("rect-2",300,200)];
    const layerData=() => JSON.stringify(editor.state.layers.map(({maskCanvas,maskDirty,...layer}) => layer));
    const before=layerData();
    const touch=async (type,x,y) => {
      const event={target:canvas,pointerType:"touch",pointerId:7,clientX:x,clientY:y};
      const captured=await viewport.dispatch(type,event);
      if(!captured.stopped) await canvas.dispatch(type,event);
    };
    await touch("pointerdown",40,30);await touch("pointermove",450,350);await touch("pointerup",450,350);
    assert.deepEqual(selectedIds(editor),["rect-1","rect-2"]);
    await touch("pointerdown",...point);editor.holdTouch();
    assert.equal(editor.get("objectMenu").hidden,false);assert.equal(editor.get("menuDelete").disabled,false);
    assert.deepEqual(selectedIds(editor),["rect-1","rect-2"]);
    assert.equal(editor.state.drag,null);assert.equal(editor.state.undo.length,0);
    await touch("pointerup",...point);await editor.get("menuDelete").dispatch("click");
    assert.equal(editor.state.layers.length,0);assert.equal(editor.state.undo.length,1);assert.equal(editor.hasUnsavedChanges(),true);
    editor.undo();assert.equal(layerData(),before);assert.equal(editor.hasUnsavedChanges(),false);
  }
});

test("初回の画像読込成功までは説明を表示し、成功した単体編集だけが共通ヘッダーの操作を表示する",async () => {
  const editor=createEditor({loaded:false}),actions=editor.get("imageHeaderActions"),intro=editor.get("imageIntro");
  assert.equal(actions.hidden,true);assert.equal(actions.inert,true);assert.equal(intro.hidden,false);
  assert.equal(editor.document.body.classList.contains("image-editor-active"),false);
  let finish;
  editor.setImageBitmap(() => new Promise(resolve => {finish=resolve;}));
  const loading=editor.loadSingleFile({name:"first.png",type:"image/png",size:100});
  assert.equal(editor.state.singleBusy,true);assert.equal(actions.hidden,true);assert.equal(intro.hidden,false);
  editor.get("singleTab").focus();
  await finishImagePaste();
  finish({width:1200,height:800,close(){}});await loading;
  assert.equal(actions.hidden,false);assert.equal(actions.inert,false);assert.equal(intro.hidden,true);
  assert.equal(editor.document.body.classList.contains("image-editor-active"),true);
  assert.equal(editor.get("processingModeTabs").hidden,true);assert.equal(editor.document.activeElement,editor.get("editCanvas"));
  const file=editor.state.sourceFile;
  await editor.get("batchTab").dispatch("click");
  assert.equal(editor.get("singlePanel").hidden,true);assert.equal(intro.hidden,false);
  assert.equal(actions.hidden,true);assert.equal(actions.inert,true);assert.equal(editor.state.sourceFile,file);
  assert.equal(editor.document.body.classList.contains("image-editor-active"),false);
  await editor.get("singleTab").dispatch("click");
  assert.equal(actions.hidden,false);assert.equal(actions.inert,false);assert.equal(intro.hidden,true);
  assert.equal(editor.state.sourceFile,file);
});

test("読込失敗・未保存確認の取消・一括タブ内での読込完了でもヘッダーと説明を現在の画面に同期する",async () => {
  const fresh=createEditor({loaded:false});fresh.setImageBitmap(async () => ({width:8193,height:10,close(){}}));
  await fresh.loadSingleFile({name:"invalid.png",type:"image/png",size:100});
  assert.equal(fresh.get("imageIntro").hidden,false);assert.equal(fresh.get("imageHeaderActions").hidden,true);
  assert.equal(fresh.state.sourceFile,null);
  const editor=createEditor();editor.state.layers=[rectangleLayer()];editor.selectLayers(editor.state.layers);
  await editor.document.dispatch("keydown",{target:editor.get("editCanvas"),key:"ArrowRight"});
  const revision=editor.state.revision,version=editor.state.loadVersion,file=editor.state.sourceFile;
  editor.window.confirm=() => false;
  await editor.loadSingleFile({name:"cancelled.png",type:"image/png",size:100});
  assert.equal(editor.state.loadVersion,version);assert.equal(editor.state.revision,revision);
  assert.equal(editor.get("imageIntro").hidden,true);assert.equal(editor.get("imageHeaderActions").hidden,false);
  editor.window.confirm=() => true;editor.setImageBitmap(async () => ({width:8193,height:10,close(){}}));
  await editor.loadSingleFile({name:"invalid.png",type:"image/png",size:100});
  assert.equal(editor.state.sourceFile,file);assert.equal(editor.state.revision,revision);
  assert.equal(editor.get("imageIntro").hidden,true);assert.equal(editor.get("imageHeaderActions").inert,false);
  const deferred=createEditor({loaded:false});let finish;
  deferred.setImageBitmap(() => new Promise(resolve => {finish=resolve;}));
  const loading=deferred.loadSingleFile({name:"pending.png",type:"image/png",size:100});
  await deferred.get("batchTab").dispatch("click");await Promise.resolve();finish({width:100,height:100,close(){}});await loading;
  assert.equal(deferred.get("imageHeaderActions").hidden,true);assert.equal(deferred.get("imageIntro").hidden,false);
  await deferred.get("singleTab").dispatch("click");assert.equal(deferred.get("imageHeaderActions").hidden,false);
  assert.equal(deferred.get("imageIntro").hidden,true);
});

test("共通ヘッダーの戻す・やり直す・比較・保存を使い、処理中やドラッグ中は変更を始めない",async () => {
  const editor=createEditor(),canvas=editor.get("editCanvas");
  editor.state.layers=[rectangleLayer()];editor.selectLayers(editor.state.layers);editor.setTool("select");
  await editor.document.dispatch("keydown",{target:canvas,key:"ArrowRight"});
  await editor.get("undo").dispatch("click");assert.equal(editor.state.layers[0].x,100);
  await editor.get("redo").dispatch("click");assert.equal(editor.state.layers[0].x,101);
  await editor.get("previewButton").dispatch("click");assert.equal(editor.get("previewDialog").classList.contains("hidden"),false);
  await editor.get("closePreview").dispatch("click");
  await editor.get("showSaveSettings").dispatch("click");assert.equal(editor.get("saveDialog").classList.contains("hidden"),false);
  assert.equal(editor.get("appHeader").inert,true);
  await editor.get("closeSaveSettings").dispatch("click");assert.equal(editor.get("appHeader").inert,false);
  let chooses=0;editor.get("singleInput").click=() => {chooses++;};
  for(const mode of ["busy","drag","pan"]){
    if(mode === "busy") editor.state.singleBusy=true;
    if(mode === "drag") editor.state.drag={mode:"shape"};
    if(mode === "pan") editor.viewState.pan={id:1};
    for(const id of ["changeSingle","undo","redo","previewButton","showSaveSettings"]) await editor.get(id).dispatch("click");
    assert.equal(chooses,0);assert.equal(editor.state.layers[0].x,101);
    assert.equal(editor.get("previewDialog").classList.contains("hidden"),true);assert.equal(editor.get("saveDialog").classList.contains("hidden"),true);
    editor.state.singleBusy=false;editor.state.drag=null;editor.viewState.pan=null;
  }
  await editor.get("changeSingle").dispatch("click");assert.equal(chooses,1);
});

test("左右のペインと画像下の倍率行を揃え、画面の高さとページスクロールへ追従する",async () => {
  const editor=createEditor(),viewport=editor.get("canvasViewport");
  let documentTop=200;
  editor.window.innerHeight=1000;editor.window.scrollY=0;
  viewport.getBoundingClientRect=() => ({left:0,top:documentTop-editor.window.scrollY,width:1000,height:viewport.clientHeight});
  Object.defineProperty(viewport,"clientHeight",{get:() => parseFloat(editor.viewState.viewportRule?.style.height) || 360});
  Object.defineProperty(editor.get("canvasWorkarea"),"clientHeight",{get:() => viewport.clientHeight});
  editor.get("zoomControls").height=44;
  editor.flushAnimationFrames();assert.equal(editor.viewState.viewportRule.style.height,"740px");
  assert.equal(editor.viewState.sidebarRule.selectorText,".editor-sidebar, .editor-settings");
  assert.equal(editor.viewState.sidebarRule.style["--image-sidebar-height"],"784px");
  editor.setTool("rect");editor.flushAnimationFrames();assert.equal(editor.viewState.viewportRule.style.height,"740px");
  editor.window.scrollY=400;await editor.window.dispatch("resize");editor.flushAnimationFrames();
  assert.equal(editor.viewState.viewportRule.style.height,"740px");
  documentTop=280;await editor.window.dispatch("resize");editor.flushAnimationFrames();
  assert.equal(editor.viewState.viewportRule.style.height,"660px");
  assert.ok(Math.abs(parseFloat(editor.viewState.rule.style.width)/parseFloat(editor.viewState.rule.style.height)-1000/700) < 1e-10);
  editor.setTool("select");editor.flushAnimationFrames();assert.equal(editor.viewState.viewportRule.style.height,"660px");
  editor.window.innerHeight=400;await editor.window.dispatch("resize");editor.flushAnimationFrames();
  assert.equal(editor.viewState.viewportRule.style.height,"240px");
  await editor.get("batchTab").dispatch("click");assert.equal(editor.viewState.viewportRule.style.height,"");
  assert.equal(editor.viewState.sidebarRule.style["--image-sidebar-height"],"");
  assert.equal(editor.get("imageIntro").hidden,false);assert.equal(editor.state.undo.length,0);assert.equal(editor.hasUnsavedChanges(),false);
});

test("右側の設定は対象の項目だけを表示し、未選択でも画像下の倍率操作を残す",async () => {
  const editor=createEditor(),panel=editor.get("contextPanel"),zoom=editor.get("zoomControls");
  assert.equal(panel.parentElement,editor.get("singleWorkspace").children[2]);
  assert.equal(editor.get("editorActions").parentElement,panel);
  assert.deepEqual(editor.get("canvasWorkarea").children.map(node => node.id),["canvasViewport"]);
  assert.equal(panel.parentElement.tagName,"ASIDE");
  assert.deepEqual(zoom.parentElement.children.map(node => node.id),["canvasWorkarea","zoomControls"]);
  assert.equal(panel.classList.contains("hidden"),true);assert.equal(panel.inert,true);assert.equal(panel.getAttribute("aria-hidden"),"true");
  assert.equal(zoom.classList.contains("hidden"),false);
  for(const id of ["stageHelp","contextHint","contextPanelHandle","resetContextPanel"]) assert.equal(editor.get(id),null,id);
  const visibleSettings=() => editor.document.querySelectorAll("[data-settings]").filter(node => !node.classList.contains("hidden")).map(node => node.dataset.settings).sort();
  editor.setTool("ellipse");
  assert.equal(panel.inert,false);assert.equal(panel.getAttribute("aria-hidden"),"false");
  assert.equal(editor.get("contextTitle").textContent,"円");assert.equal(editor.get("annotationColorLabel").textContent,"枠");
  assert.deepEqual(visibleSettings(),["color","fill","line","outline"]);
  editor.setTool("ink");
  assert.equal(editor.get("contextTitle").textContent,"手書き");assert.equal(editor.get("annotationColorLabel").textContent,"色");
  assert.deepEqual(visibleSettings(),["brush","color","ink"]);
  editor.state.layers=[rectangleLayer(),{...rectangleLayer("line"),type:"line",x1:300,y1:100,x2:400,y2:200},textLayer()];
  editor.setTool("select");editor.selectLayers(editor.state.layers.slice(0,2));editor.updateSelectedControls();
  assert.equal(editor.get("contextTitle").textContent,"2個");assert.equal(editor.get("annotationColorLabel").textContent,"枠");
  editor.selectLayers(editor.state.layers);editor.updateSelectedControls();
  assert.equal(editor.get("contextTitle").textContent,"3個");assert.equal(editor.get("annotationColorLabel").textContent,"色");
  editor.selectLayers([]);editor.updateSelectedControls();assert.equal(panel.classList.contains("hidden"),true);
  assert.equal(panel.inert,true);assert.equal(panel.getAttribute("aria-hidden"),"true");
  const before=JSON.stringify(editor.state.layers),scale=editor.viewState.scale;
  await zoom.dispatch("wheel",{deltaY:-100});assert.equal(editor.viewState.scale,scale);
  await editor.get("zoomIn").dispatch("click");assert.equal(editor.viewState.scale,scale*1.25);
  assert.equal(JSON.stringify(editor.state.layers),before);assert.equal(editor.state.undo.length,0);assert.equal(editor.hasUnsavedChanges(),false);
  assert.deepEqual([editor.get("baseCanvas").width,editor.get("baseCanvas").height],[1000,700]);
});

test("上部設定の入力・IME・文字コピーを優先し、入力欄のホイールで画像を拡大しない",async () => {
  const editor=createEditor(),canvas=editor.get("editCanvas"),field=editor.get("lineWidth");
  editor.state.layers=[rectangleLayer()];editor.selectLayers(editor.state.layers);editor.updateSelectedControls();
  field.focus();const before=JSON.stringify(editor.state.layers),data=clipboard();
  for(const event of [{key:"Delete"},{key:"Backspace"},{key:"ArrowRight"},{key:"z",ctrlKey:true},{key:"c",ctrlKey:true},{key:"v",ctrlKey:true}]){
    assert.equal((await editor.document.dispatch("keydown",{target:field,...event})).prevented,false);
  }
  for(const type of ["copy","paste"]) assert.equal((await editor.document.dispatch(type,{target:field,clipboardData:data})).prevented,false);
  assert.equal((await editor.get("canvasViewport").dispatch("wheel",{target:field,deltaY:-100})).prevented,false);
  await editor.document.dispatch("compositionstart",{target:field});
  assert.equal((await editor.document.dispatch("keydown",{target:canvas,key:"Delete"})).prevented,false);
  await editor.document.dispatch("compositionend",{target:field});
  assert.equal(JSON.stringify(editor.state.layers),before);assert.equal(editor.viewState.scale,1);
  assert.equal(editor.state.undo.length,0);assert.equal(editor.hasUnsavedChanges(),false);
  canvas.focus();await editor.document.dispatch("keydown",{target:canvas,key:"ArrowRight"});
  assert.equal(editor.state.layers[0].x,101);assert.equal(editor.state.undo.length,1);
});

test("固定高の上部設定は通常幅と狭幅でもドラッグ中の座標・倍率を保ち、確定後に選択設定を反映する",async () => {
  for(const {top,width} of [{top:100,width:1000},{top:280,width:300}]){
   for(const mode of ["move","marquee","cancel"]){
    const editor=createEditor(),viewport=editor.get("canvasViewport"),canvas=editor.get("editCanvas"),panel=editor.get("contextPanel");
    editor.window.innerHeight=800;editor.window.scrollY=0;
    viewport.clientWidth=width;
    Object.defineProperty(viewport,"clientHeight",{get:() => parseFloat(editor.viewState.viewportRule?.style.height) || 640});
    viewport.getBoundingClientRect=() => ({left:0,top,width,height:viewport.clientHeight});
    const rectangle=() => ({left:0,top,width:1000*editor.viewState.scale,height:700*editor.viewState.scale});
    editor.get("canvasHolder").getBoundingClientRect=rectangle;canvas.getBoundingClientRect=rectangle;
    editor.state.layers=[rectangleLayer(),{...textLayer(),id:"text-2",x:300,y:200}];
    editor.flushAnimationFrames();const scale=editor.viewState.scale;
    const at=(x,y) => ({clientX:x*scale,clientY:top+y*scale});
    if(mode === "marquee"){
      await canvas.dispatch("pointerdown",at(50,50));
      await canvas.dispatch("pointermove",at(500,350));
      assert.deepEqual(selectedIds(editor),["rect-1","text-2"]);
    }else{
      await canvas.dispatch("pointerdown",at(130,130));
      await canvas.dispatch("pointermove",at(150,160));
    }
    // Observer/resize callbacks preserve the original coordinate frame and
    // defer selection-specific field changes until this gesture is complete.
    await editor.window.dispatch("resize");editor.flushAnimationFrames();
    assert.equal(panel.classList.contains("hidden"),true,mode);assert.equal(panel.inert,true,mode);
    assert.equal(editor.viewState.scale,scale,mode);assert.equal(viewport.clientHeight,800-top-60,mode);
    if(mode === "cancel"){
      await canvas.dispatch("pointercancel");
      assert.deepEqual([editor.state.layers[0].x,editor.state.layers[0].y],[100,100]);
      assert.equal(editor.state.undo.length,0);assert.equal(editor.hasUnsavedChanges(),false);
    }else{
      await canvas.dispatch("pointerup",mode === "marquee" ? at(550,350) : at(170,180));
      if(mode === "move"){
        assert.deepEqual([editor.state.layers[0].x,editor.state.layers[0].y],[140,150]);
        assert.equal(editor.state.undo.length,1);
      }else assert.equal(editor.state.undo.length,0);
    }
    assert.equal(editor.state.drag,null);assert.equal(panel.classList.contains("hidden"),false);
    assert.equal(panel.inert,false);assert.equal(panel.getAttribute("aria-hidden"),"false");
    editor.flushAnimationFrames();assert.equal(viewport.getBoundingClientRect().top,top);assert.equal(viewport.clientHeight,800-top-60);
    assert.equal(editor.viewState.scale,scale);
    assert.equal(editor.get("baseCanvas").width,1000);assert.equal(editor.get("baseCanvas").height,700);
   }
  }
});

test("短い直線・矢印の重なる端点ハンドルは表示倍率によらず近い端を選ぶ",async () => {
  for(const type of ["line","arrow"]){
    for(const scale of [.2,1,4]){
      for(const end of ["1","2"]){
        const editor=createEditor(),canvas=editor.get("editCanvas");
        const layer={id:"short",type,x1:100,y1:100,x2:108,y2:100,lineWidth:8,color:"#ff0000",visible:true};
        editor.state.layers=[layer];editor.selectLayers([layer]);
        canvas.getBoundingClientRect=() => ({left:0,top:0,width:1000*scale,height:700*scale});
        await canvas.dispatch("pointerdown",{clientX:layer[`x${end}`]*scale,clientY:100*scale});
        assert.equal(editor.state.drag.end,end,`${type}/${scale}/${end}`);
        await canvas.dispatch("pointerup",{clientX:150*scale,clientY:150*scale});
        const fixed=end === "1" ? "2" : "1";
        assert.equal(layer[`x${fixed}`],fixed === "1" ? 100 : 108);
        assert.equal(layer[`y${fixed}`],100);
        assert.equal(layer[`x${end}`],150);
      }
    }
  }
});

test("画像の複数選択は不透明度の混在を示し、画像だけへ一括反映して一度で戻す",async () => {
  const editor=createEditor();
  const image=(id,opacity) => ({id,type:"image",imageCanvas:editor.get("layerCanvas"),x:100,y:100,w:80,h:60,opacity,visible:true});
  editor.state.layers=[image("a",30),image("b",70),rectangleLayer()];
  editor.selectLayers(editor.state.layers);editor.setTool("select");
  const field=editor.get("imageOpacity");
  assert.equal(field.value,"");assert.equal(field.dataset.mixed,"true");
  field.focus();field.value="50";await field.dispatch("input");
  field.value="40";await field.dispatch("change");
  assert.deepEqual(editor.state.layers.map(layer => layer.opacity),[40,40,undefined]);
  assert.equal(editor.state.undo.length,1);
  editor.undo();assert.deepEqual(editor.state.layers.map(layer => layer.opacity),[30,70,undefined]);
  editor.redo();assert.deepEqual(editor.state.layers.map(layer => layer.opacity),[40,40,undefined]);
});

test("画像履歴の上限では古い画像を要する注釈履歴も除き、Undo/Redoで座標を混同しない",async () => {
  const editor=createEditor(),base=editor.get("baseCanvas");
  base.width=5000;base.height=4200;
  editor.state.layers=[rectangleLayer()];editor.selectLayers(editor.state.layers);
  await editor.document.dispatch("keydown",{target:editor.get("editCanvas"),key:"ArrowRight"});
  editor.get("resizeW").value="4900";editor.get("resizeH").value="4200";
  await editor.get("applyResize").dispatch("click");
  const afterFirstResize=editor.state.layers[0].x;
  await editor.document.dispatch("keydown",{target:editor.get("editCanvas"),key:"ArrowRight"});
  editor.get("resizeW").value="4800";
  await editor.get("applyResize").dispatch("click");
  const afterSecondResize=editor.state.layers[0].x;
  assert.equal(editor.state.undo.length,2);
  editor.undo();assert.equal(base.width,4900);assert.equal(editor.state.layers[0].x,afterFirstResize+1);
  editor.undo();assert.equal(base.width,4900);assert.equal(editor.state.layers[0].x,afterFirstResize);
  assert.equal(editor.state.undo.length,0);
  editor.redo();editor.redo();assert.equal(base.width,4800);assert.equal(editor.state.layers[0].x,afterSecondResize);
});

test("切り抜き後も矩形の枠線と楕円の形状を変えず、残る部分をCanvas境界で表示する",() => {
  const editor=createEditor();
  editor.state.layers=[{...rectangleLayer("rect",100,100),w:200,h:100},
    {...rectangleLayer("ellipse",100,100),type:"ellipse",w:200,h:100},rectangleLayer("outside",500,500)];
  editor.trimLayersAfterCrop({x:200,y:100,w:200,h:100});
  assert.deepEqual(editor.state.layers.map(layer => [layer.id,layer.x,layer.y,layer.w,layer.h]),
    [["rect",-100,0,200,100],["ellipse",-100,0,200,100]]);
});

test("文字幅入力を外しても細い文字枠を保持し、混在選択後の新規ツールへ既定値を表示する",async () => {
  const editor=createEditor();
  editor.state.layers=[{...textLayer(),textWidth:12}];
  editor.selectLayers(editor.state.layers);
  editor.setTool("select");
  assert.equal(editor.get("textWidth"),null);
  editor.get("fontSize").value="44";
  await editor.get("fontSize").dispatch("input");
  assert.equal(editor.state.layers[0].textWidth,12);
  editor.state.layers.push({...textLayer(),id:"text-2",text:"別の文字",fontSize:30,bold:false,outline:true});
  editor.selectLayers(editor.state.layers);editor.setTool("select");
  assert.equal(editor.get("fontSize").value,"");
  assert.equal(editor.get("boldText").indeterminate,true);
  editor.setTool("text");
  assert.equal(Number(editor.get("fontSize").value),42);
  assert.equal(editor.get("boldText").indeterminate,false);
  assert.equal(editor.get("boldText").checked,true);
  assert.equal(editor.get("textEditor").hidden,true);
  assert.equal(editor.get("textEditor").value,"");
  assert.equal(editor.get("fontSize").dataset.mixed,"false");
});

test("保存・比較ダイアログでもIME変換取消しのEscを優先する",async () => {
  const editor=createEditor();
  for(const [button,dialog] of [["showSaveSettings","saveDialog"],["previewButton","previewDialog"]]){
    await editor.get(button).dispatch("click");
    assert.equal(editor.get(dialog).classList.contains("hidden"),false);
    for(const composing of [{isComposing:true},{keyCode:229}]){
      await editor.get(dialog).dispatch("keydown",{key:"Escape",...composing});
      assert.equal(editor.get(dialog).classList.contains("hidden"),false);
    }
    editor.state.composing=true;
    await editor.get(dialog).dispatch("keydown",{key:"Escape"});
    assert.equal(editor.get(dialog).classList.contains("hidden"),false);
    editor.state.composing=false;
    await editor.get(dialog).dispatch("keydown",{key:"Escape"});
    assert.equal(editor.get(dialog).classList.contains("hidden"),true);
  }
});

test("最前面・最背面は複数選択の相対順と非選択の順を維持し一回で戻せる",() => {
  for(const front of [true,false]){
    const editor=createEditor();
    editor.state.layers=Array.from({length:5},(_,i) => rectangleLayer(`rect-${i}`,100+i*100,100));
    editor.selectLayers([editor.state.layers[1],editor.state.layers[3]]);
    editor.reorderSelectedLayers(front);
    assert.deepEqual(Array.from(editor.state.layers,item => item.id),front
      ? ["rect-0","rect-2","rect-4","rect-1","rect-3"]
      : ["rect-1","rect-3","rect-0","rect-2","rect-4"]);
    assert.equal(editor.state.undo.length,1);
    editor.reorderSelectedLayers(front);assert.equal(editor.state.undo.length,1);
    editor.undo();assert.deepEqual(Array.from(editor.state.layers,item => item.id),["rect-0","rect-1","rect-2","rect-3","rect-4"]);
  }
});

test("Ctrl+Aと矢印/Shift矢印で表示中のオブジェクトを一括選択・微調整しCtrl+Z/Y/ShiftZで戻す",async () => {
  const editor=createEditor();
  editor.state.layers=[rectangleLayer("a"),rectangleLayer("b",300,100),{...rectangleLayer("hidden"),visible:false}];
  const key = (key,extra={}) => editor.document.dispatch("keydown",{target:editor.get("editCanvas"),key,...extra});
  assert.equal((await key("a",{ctrlKey:true})).prevented,true);
  assert.deepEqual([...editor.state.selectedLayerIds],["a","b"]);
  await key("ArrowRight");assert.equal(editor.state.layers[0].x,101);assert.equal(editor.state.layers[1].x,301);
  await key("ArrowDown",{shiftKey:true});assert.equal(editor.state.layers[0].y,110);assert.equal(editor.state.layers[1].y,110);
  await key("z",{ctrlKey:true});assert.equal(editor.state.layers[0].y,100);
  await key("y",{ctrlKey:true});assert.equal(editor.state.layers[0].y,110);
  await key("z",{ctrlKey:true});await key("z",{ctrlKey:true,shiftKey:true});assert.equal(editor.state.layers[0].y,110);
  const event=await key("s",{ctrlKey:true});assert.equal(event.prevented,true);
  assert.equal(editor.get("saveDialog").classList.contains("hidden"),false);
});

test("追加キー操作は入力・IME変換・保存/スタンプダイアログ・一括画面では通常処理を優先する",async () => {
  for(const mode of ["input","composing","save","stamp","batch","pan"]){
    const editor=createEditor();editor.state.layers=[rectangleLayer()];editor.state.selectedLayerId="rect-1";
    let target=editor.get("editCanvas");
    if(mode === "input"){target=editor.get("textEditor");target.focus();}
    if(mode === "composing") editor.state.composing=true;
    if(mode === "save") editor.get("saveDialog").classList.remove("hidden");
    if(mode === "stamp") editor.document.querySelector=selector => selector === "#stampDialog:not(.hidden)" ? editor.get("stampDialog") : null;
    if(mode === "batch") editor.get("singlePanel").hidden=true;
    if(mode === "pan") editor.viewState.pan={id:1};
    for(const [key,ctrlKey] of [["ArrowRight",false],["a",true],["z",true],["y",true],["s",true]]){
      const event=await editor.document.dispatch("keydown",{target,key,ctrlKey});assert.equal(event.prevented,false,`${mode}/${key}`);
    }
    assert.equal(editor.state.undo.length,0);assert.equal(editor.state.layers[0].x,100);
  }
});

test("一括タブから矢印キーで単体編集へ戻っても、選択対象の座標と履歴を変更しない",async () => {
  for(const key of ["ArrowLeft","ArrowRight"]){
    const editor=createEditor(),layer=rectangleLayer();
    editor.state.layers=[layer];editor.selectLayers([layer]);
    await editor.get("batchTab").dispatch("click");
    const before=JSON.stringify(editor.state.layers);
    const event=await editor.get("batchTab").dispatch("keydown",{key});
    assert.equal(editor.get("singlePanel").hidden,false);
    assert.equal(event.defaultPrevented,true);
    // The real key event bubbles to document after the tab's own handler.
    await editor.document.dispatch("keydown",event);
    assert.equal(JSON.stringify(editor.state.layers),before,key);
    assert.equal(editor.state.undo.length,0,key);
    assert.equal(editor.hasUnsavedChanges(),false,key);
  }
});

test("未保存判定は保存した履歴位置をUndo/Redoで認識し、未確定描画と離脱を保護する",async () => {
  const editor=createEditor();editor.state.layers=[rectangleLayer()];editor.state.selectedLayerId="rect-1";
  assert.equal(editor.hasUnsavedChanges(),false);
  await editor.document.dispatch("keydown",{target:editor.get("editCanvas"),key:"ArrowRight"});
  assert.equal(editor.hasUnsavedChanges(),true);
  editor.state.savedRevision=editor.state.revision;
  assert.equal(editor.hasUnsavedChanges(),false);
  editor.undo();assert.equal(editor.hasUnsavedChanges(),true);
  editor.redo();assert.equal(editor.hasUnsavedChanges(),false);
  editor.state.drag={mode:"shape"};assert.equal(editor.hasUnsavedChanges(),true);
  const unload=await editor.window.dispatch("beforeunload");assert.equal(unload.prevented,true);assert.equal(unload.returnValue,"");
  editor.state.drag=null;
  assert.equal((await editor.window.dispatch("beforeunload")).prevented,false);
});

test("画像変更・初期化の未保存確認を取り消すと画像・履歴・読込み世代を維持する",async () => {
  const editor=createEditor();editor.state.layers=[rectangleLayer()];editor.state.selectedLayerId="rect-1";
  await editor.document.dispatch("keydown",{target:editor.get("editCanvas"),key:"ArrowRight"});
  editor.window.confirm=() => false;
  const before=JSON.stringify(editor.state.layers),revision=editor.state.revision,version=editor.state.loadVersion;
  await editor.loadSingleFile({name:"next.png",type:"image/png",size:100});
  assert.equal(editor.state.loadVersion,version);assert.equal(JSON.stringify(editor.state.layers),before);
  await editor.get("resetSingle").dispatch("click");
  assert.equal(JSON.stringify(editor.state.layers),before);assert.equal(editor.state.revision,revision);
});

test("通常・Ctrl・Metaホイールは画像領域だけを上下にズームし、画素・注釈・保存寸法・履歴を変えない",async () => {
  for(const modifier of [{},{ctrlKey:true},{metaKey:true}]){
    const editor=createEditor(),viewport=editor.get("canvasViewport"),base=editor.get("baseCanvas");
    editor.state.layers=[rectangleLayer(),textLayer()];
    const before=JSON.stringify(editor.state.layers);
    const bitmapCalls=base.getContext("2d").calls.filter(call => call.method === "drawImage").length;
    let event=await viewport.dispatch("wheel",{deltaY:-100,...modifier});
    assert.equal(event.prevented,true);assert.ok(editor.viewState.scale > 1);
    const enlarged=editor.viewState.scale;
    event=await viewport.dispatch("wheel",{deltaY:100,...modifier});
    assert.equal(event.prevented,true);assert.ok(editor.viewState.scale < enlarged);
    assert.ok(Math.abs(editor.viewState.scale-1) < 1e-12);
    assert.deepEqual([base.width,base.height],[1000,700]);
    assert.equal(base.getContext("2d").calls.filter(call => call.method === "drawImage").length,bitmapCalls);
    assert.equal(JSON.stringify(editor.state.layers),before);
    assert.equal(editor.state.undo.length,0);assert.equal(editor.state.redo.length,0);
    assert.equal(editor.state.revision,0);assert.equal(editor.hasUnsavedChanges(),false);
    await editor.get("showSaveSettings").dispatch("click");
    assert.match(editor.get("singleSaveSize").textContent,/1000 × 700px/);
  }
});

test("ホイールのpixel・line・page単位は同じ移動量へ換算され、ゼロ・横移動・非数値では変更しない",async () => {
  const zoom=async (deltaY,deltaMode) => {
    const editor=createEditor();await editor.get("canvasViewport").dispatch("wheel",{deltaY,deltaMode});return editor.viewState.scale;
  };
  assert.equal(await zoom(-16,0),await zoom(-1,1));
  assert.equal(await zoom(-70,0),await zoom(-.1,2));
  assert.equal(await zoom(300,0),await zoom(1,2));
  for(const extra of [{deltaY:0},{deltaX:100,deltaY:0},{deltaY:NaN},{deltaY:Infinity}]){
    const editor=createEditor();
    const event=await editor.get("canvasViewport").dispatch("wheel",extra);
    assert.equal(event.prevented,false);assert.equal(editor.viewState.scale,1);
    assert.equal(editor.viewState.mode,"fit");
  }
});

test("入力・IME・文字編集・描画・表示移動・処理中・画像未読込のホイールと領域外は通常処理を優先する",async () => {
  for(const mode of ["input","editable","composing","textEditing","drag","pan","busy","noImage"]){
    const editor=createEditor(),viewport=editor.get("canvasViewport");
    let target=editor.get("editCanvas");
    if(mode === "input") target=editor.get("zoomValue");
    if(mode === "editable"){target=editor.get("editable");target.isContentEditable=true;}
    if(mode === "composing") editor.state.composing=true;
    if(mode === "textEditing") editor.state.textEditing={id:"text-1"};
    if(mode === "drag") editor.state.drag={mode:"shape"};
    if(mode === "pan") editor.viewState.pan={id:1};
    if(mode === "busy") editor.state.singleBusy=true;
    if(mode === "noImage") editor.state.sourceFile=null;
    const event=await viewport.dispatch("wheel",{target,deltaY:-100});
    assert.equal(event.prevented,false,mode);assert.equal(editor.viewState.scale,1,mode);
  }
  const editor=createEditor();
  for(const target of [editor.document,editor.window,editor.get("appMain"),editor.get("fontSize")]){
    const event=await target.dispatch("wheel",{deltaY:-100,ctrlKey:true});
    assert.equal(event.prevented,false);assert.equal(editor.viewState.scale,1);
  }
});

function installViewportGeometry(editor,{width=500,height=350,scale=1,heightFromRule=false}={}){
  const viewport=editor.get("canvasViewport"),base=editor.get("baseCanvas");
  viewport.clientWidth=width;viewport.clientHeight=height;viewport.clientLeft=2;viewport.clientTop=2;
  const viewportHeight=() => heightFromRule ? parseFloat(editor.viewState.viewportRule?.style.height) || height : height;
  if(heightFromRule) Object.defineProperty(viewport,"clientHeight",{get:viewportHeight});
  editor.viewState.scale=scale;editor.viewState.mode="manual";
  const size=() => ({width:parseFloat(editor.viewState.rule?.style.width) || base.width*editor.viewState.scale,
    height:parseFloat(editor.viewState.rule?.style.height) || base.height*editor.viewState.scale});
  let scrollLeft=0,scrollTop=0;
  Object.defineProperty(viewport,"scrollLeft",{get:() => scrollLeft,set:value => {scrollLeft=Math.max(0,Math.min(value,Math.max(0,size().width-width)));}});
  Object.defineProperty(viewport,"scrollTop",{get:() => scrollTop,set:value => {scrollTop=Math.max(0,Math.min(value,Math.max(0,size().height-viewportHeight())));}});
  viewport.getBoundingClientRect=() => ({left:10,top:20,width:width+4,height:viewportHeight()+4});
  const rectangle=() => ({left:12+Math.max(0,(width-size().width)/2)-scrollLeft,
    top:22+Math.max(0,(viewportHeight()-size().height)/2)-scrollTop,...size()});
  editor.get("canvasHolder").getBoundingClientRect=rectangle;
  editor.get("editCanvas").getBoundingClientRect=rectangle;
  const imagePoint=(clientX,clientY) => {
    const rect=rectangle();return {x:(clientX-rect.left)/editor.viewState.scale,y:(clientY-rect.top)/editor.viewState.scale};
  };
  return {viewport,rectangle,imagePoint};
}

test("編集領域の高さ変更でも手動ズームの画像中心と注釈座標・保存寸法を維持する",async () => {
  const editor=createEditor(),view=installViewportGeometry(editor,{scale:2,heightFromRule:true});
  editor.window.innerHeight=700;editor.window.scrollY=0;editor.get("zoomControls").height=44;
  editor.state.layers=[rectangleLayer()];editor.selectLayers(editor.state.layers);
  editor.flushAnimationFrames();view.viewport.scrollLeft=200;view.viewport.scrollTop=300;
  const center=() => view.imagePoint(12+view.viewport.clientWidth/2,22+view.viewport.clientHeight/2);
  const before=center(),layers=JSON.stringify(editor.state.layers);
  assert.equal(view.viewport.clientHeight,620);
  editor.window.innerHeight=900;await editor.window.dispatch("resize");editor.flushAnimationFrames();
  assert.equal(view.viewport.clientHeight,820);
  assert.ok(Math.abs(center().x-before.x) < 1e-8);assert.ok(Math.abs(center().y-before.y) < 1e-8);
  assert.equal(editor.viewState.scale,2);assert.equal(JSON.stringify(editor.state.layers),layers);
  assert.deepEqual([editor.get("baseCanvas").width,editor.get("baseCanvas").height],[1000,700]);
  assert.equal(editor.state.undo.length,0);assert.equal(editor.hasUnsavedChanges(),false);
});

test("スクロールした拡大画像ではホイール位置の元画像座標を同じ画面位置に保つ",async () => {
  const editor=createEditor(),view=installViewportGeometry(editor);
  view.viewport.scrollLeft=200;view.viewport.scrollTop=150;
  const clientX=140,clientY=110,point=view.imagePoint(clientX,clientY);
  for(const deltaY of [-100,100]){
    const event=await view.viewport.dispatch("wheel",{clientX,clientY,deltaY});assert.equal(event.prevented,true);
    const after=view.imagePoint(clientX,clientY);
    assert.ok(Math.abs(after.x-point.x) < 1e-8);assert.ok(Math.abs(after.y-point.y) < 1e-8);
  }
  assert.ok(Math.abs(view.viewport.scrollLeft-200) < 1e-8);
  assert.ok(Math.abs(view.viewport.scrollTop-150) < 1e-8);
});

test("画像外の余白でホイールしたときは画像中央を基準にズームする",async () => {
  const editor=createEditor(),view=installViewportGeometry(editor,{width:1000,height:700,scale:.5});
  const center=view.imagePoint(512,372);
  assert.ok(view.rectangle().left > 30 && view.rectangle().top > 40);
  await view.viewport.dispatch("wheel",{clientX:30,clientY:40,deltaY:-100});
  const after=view.imagePoint(512,372);
  assert.ok(Math.abs(after.x-center.x) < 1e-8);assert.ok(Math.abs(after.y-center.y) < 1e-8);
  assert.equal(view.viewport.scrollLeft,0);assert.equal(view.viewport.scrollTop,0);
});

function rectangleLayer(id="rect-1",x=100,y=100){
  return {id,type:"rect",x,y,w:80,h:60,color:"#ff0000",lineWidth:8,visible:true};
}

function selectedIds(editor){
  return [...editor.state.selectedLayerIds].sort();
}

async function selectRectangle(editor,start,end,options={}){
  const canvas=editor.get("editCanvas");
  await canvas.dispatch("pointerdown",{clientX:start[0],clientY:start[1],...options});
  await canvas.dispatch("pointermove",{clientX:end[0],clientY:end[1],...options});
  await canvas.dispatch("pointerup",{clientX:end[0],clientY:end[1],...options});
}

function clipboard(){
  const values = new Map();
  return {items:[],setData:(type,value) => values.set(type,value),getData:type => values.get(type) || ""};
}

async function finishImagePaste(){
  // The native paste handler starts decoding without making event dispatch
  // asynchronous. Let its decode promise and continuation finish.
  for(let index=0;index<10;index++) await Promise.resolve();
}

function imageClipboard(data=clipboard()){
  const file={name:"clipboard.png",type:"image/png",size:1024};
  data.items=[{kind:"file",type:"image/png",getAsFile:() => file}];
  return data;
}

async function placeAnnotation(editor,type,start=[100,100],end=[180,160]){
  editor.setTool(type);
  const canvas=editor.get("editCanvas");
  await canvas.dispatch("pointerdown",{clientX:start[0],clientY:start[1]});
  await canvas.dispatch("pointermove",{clientX:end[0],clientY:end[1]});
  await canvas.dispatch("pointerup",{clientX:end[0],clientY:end[1]});
  if(type === "text") await editor.get("textEditor").dispatch("keydown",{key:"Escape"});
  return editor.state.layers.at(-1);
}

test("文字サイズボタンは新規文字の既定値を2pxずつ変え、8〜300pxの範囲を守り履歴を増やさない",async () => {
  const editor=createEditor(),size=editor.get("fontSize"),smaller=editor.get("decreaseFontSize"),larger=editor.get("increaseFontSize");
  assert.equal(smaller.disabled,true);assert.equal(larger.disabled,true);
  editor.setTool("text");
  assert.equal(editor.get("annotationColorLabel").textContent,"テキスト");
  assert.equal(editor.get("annotationColor").getAttribute("aria-label"),"テキストの色");
  assert.equal(editor.get("textFillLabel").textContent,"塗り");
  await larger.dispatch("click");assert.equal(Number(size.value),44);
  await smaller.dispatch("click");assert.equal(Number(size.value),42);
  size.value="299";await size.dispatch("input");
  await larger.dispatch("click");assert.equal(Number(size.value),300);assert.equal(larger.disabled,true);
  await larger.dispatch("click");assert.equal(Number(size.value),300);
  size.value="9";await size.dispatch("input");
  await smaller.dispatch("click");assert.equal(Number(size.value),8);assert.equal(smaller.disabled,true);
  await smaller.dispatch("click");assert.equal(Number(size.value),8);
  assert.equal(editor.state.undo.length,0);assert.equal(editor.hasUnsavedChanges(),false);
  const layer=await placeAnnotation(editor,"text");assert.equal(layer.fontSize,8);assert.equal(layer.textWidth,300);
});

test("文字サイズボタンは混在選択の各文字だけを相対変更し、クリックごとにUndoできる",async () => {
  const editor=createEditor(),larger=editor.get("increaseFontSize"),smaller=editor.get("decreaseFontSize");
  editor.state.layers=[{...textLayer(),textWidth:88},{...textLayer(),id:"text-2",fontSize:30,textWidth:120},rectangleLayer("rect-2")];
  editor.selectLayers(editor.state.layers);editor.setTool("select");
  const sizes=() => editor.state.layers.slice(0,2).map(layer => layer.fontSize);
  assert.equal(editor.get("fontSize").value,"");
  assert.equal(editor.get("textFillLabel").textContent,"文字の塗り");
  assert.equal(editor.get("shapeFillLabel").textContent,"図形の塗り");
  await larger.dispatch("click");assert.deepEqual(sizes(),[44,32]);
  await larger.dispatch("click");assert.deepEqual(sizes(),[46,34]);assert.equal(editor.state.undo.length,2);
  assert.deepEqual(editor.state.layers.slice(0,2).map(layer => layer.textWidth),[88,120]);
  assert.equal(editor.state.layers[2].fontSize,undefined);
  editor.undo();assert.deepEqual(sizes(),[44,32]);editor.undo();assert.deepEqual(sizes(),[42,30]);
  editor.redo();assert.deepEqual(sizes(),[44,32]);
  editor.selectLayers(editor.state.layers);editor.updateSelectedControls();
  editor.get("fontSize").value="60";await editor.get("fontSize").dispatch("input");
  await larger.dispatch("click");assert.deepEqual(sizes(),[62,62]);
  editor.undo();assert.deepEqual(sizes(),[60,60]);editor.undo();assert.deepEqual(sizes(),[44,32]);
  editor.selectLayers(editor.state.layers);editor.updateSelectedControls();
  for(const blocked of ["busy","drag","pan","composing"]){
    if(blocked === "busy") editor.state.singleBusy=true;
    if(blocked === "drag") editor.state.drag={mode:"shape"};
    if(blocked === "pan") editor.viewState.pan={id:1};
    if(blocked === "composing") editor.state.composing=true;
    const undoCount=editor.state.undo.length;
    await smaller.dispatch("click");await larger.dispatch("click");
    assert.deepEqual(sizes(),[44,32]);assert.equal(editor.state.undo.length,undoCount);
    editor.state.singleBusy=false;editor.state.drag=null;editor.viewState.pan=null;editor.state.composing=false;
  }
  editor.state.layers[0].fontSize=8;editor.state.layers[1].fontSize=300;editor.updateSelectedControls();
  await larger.dispatch("click");assert.deepEqual(sizes(),[10,300]);
  await smaller.dispatch("click");assert.deepEqual(sizes(),[8,298]);
});

test("四角形・円・矢印・直線は配置後に選択へ戻り、次のドラッグで移動できる。取消では描画ツールを保つ",async () => {
  for(const tool of ["rect","ellipse","arrow","line"]){
    const editor=createEditor(),canvas=editor.get("editCanvas");
    const layer=await placeAnnotation(editor,tool,[100,100],[240,220]);
    assert.equal(editor.state.tool,"select",tool);assert.deepEqual(selectedIds(editor),[layer.id]);
    assert.equal(editor.get("editorActions").classList.contains("hidden"),false);
    const firstX=layer.x ?? layer.x1;
    await canvas.dispatch("pointerdown",{clientX:170,clientY:160});
    await canvas.dispatch("pointermove",{clientX:200,clientY:180});
    await canvas.dispatch("pointerup",{clientX:200,clientY:180});
    assert.equal(editor.state.layers.length,1,tool);assert.equal(layer.x ?? layer.x1,firstX+30);
    editor.undo();editor.undo();assert.equal(editor.state.layers.length,0);
    editor.redo();editor.redo();assert.equal(editor.state.layers.length,1);assert.equal(editor.state.tool,"select");
    const cancelled=createEditor(),target=cancelled.get("editCanvas");cancelled.setTool(tool);
    await target.dispatch("pointerdown",{clientX:100,clientY:100});
    await target.dispatch("pointermove",{clientX:240,clientY:220});
    await target.dispatch("pointercancel");
    assert.equal(cancelled.state.tool,tool);assert.equal(cancelled.state.layers.length,0);assert.equal(cancelled.state.undo.length,0);
    await target.dispatch("pointerdown",{clientX:100,clientY:100});await target.dispatch("pointerup",{clientX:100.1,clientY:100.1});
    assert.equal(cancelled.state.tool,tool);assert.equal(cancelled.state.layers.length,0);
  }
  for(const tool of ["blackoutRect","mosaicRect"]){
    const editor=createEditor();await placeAnnotation(editor,tool);assert.equal(editor.state.tool,tool);
  }
});

test("右の重なり順ボタンは設定のない黒塗りにも表示され、選択対象を並べ替えてUndoできる",async () => {
  const editor=createEditor({withActions:true}),actions=editor.get("editorActions"),panel=editor.get("contextPanel");
  editor.state.layers=[{...rectangleLayer("mask"),type:"blackoutRect"},rectangleLayer("other",300,200)];
  editor.selectLayers([editor.state.layers[0]]);editor.updateSelectedControls();
  assert.equal(actions.parentElement,panel);assert.equal(actions.inert,false);assert.equal(panel.inert,false);
  await editor.get("frontLayer").dispatch("click");assert.deepEqual(Array.from(editor.state.layers,layer => layer.id),["other","mask"]);
  assert.deepEqual(selectedIds(editor),["mask"]);
  await editor.get("backLayer").dispatch("click");assert.deepEqual(Array.from(editor.state.layers,layer => layer.id),["mask","other"]);
  editor.undo();assert.deepEqual(Array.from(editor.state.layers,layer => layer.id),["other","mask"]);assert.deepEqual(selectedIds(editor),[]);
  editor.selectLayers([]);editor.updateSelectedControls();assert.equal(actions.inert,true);assert.equal(panel.inert,true);
  editor.setTool("text");assert.equal(panel.inert,false);assert.equal(actions.inert,true);
  assert.equal(editor.get("annotationColorLabel").textContent,"テキスト");
});

test("白縁の新規既定値は文字・矢印・直線でオン、四角形・楕円でオフとなりコピーとUndoでも保持する",async () => {
  for(const [type,expected] of [["text",true],["arrow",true],["line",true],["rect",false],["ellipse",false]]){
    const editor=createEditor();
    editor.setTool(type);
    assert.equal(editor.get("whiteOutline").checked,expected,type);
    const layer=await placeAnnotation(editor,type);
    assert.equal(layer.type,type);
    assert.equal(layer.outline,expected,type);
    editor.selectLayers([layer]);editor.setTool("select");
    const data=clipboard();
    await editor.document.dispatch("copy",{target:editor.get("editCanvas"),clipboardData:data});
    await editor.document.dispatch("paste",{target:editor.get("editCanvas"),clipboardData:data});
    assert.equal(editor.state.layers.length,2,type);
    assert.equal(editor.state.layers[1].outline,expected,type);
    editor.undo();assert.equal(editor.state.layers.length,1,type);
    editor.undo();assert.equal(editor.state.layers.length,0,type);
    editor.redo();assert.equal(editor.state.layers[0].outline,expected,type);
    editor.redo();assert.equal(editor.state.layers[1].outline,expected,type);
  }
});

test("描画ツールの白縁設定は種類ごとに記憶し、既存対象の書式変更や混在選択と分離する",async () => {
  const editor=createEditor(),field=editor.get("whiteOutline");
  const initial={text:true,arrow:true,line:true,rect:false,ellipse:false};
  for(const type of Object.keys(initial)){
    editor.setTool(type);
    assert.equal(field.checked,initial[type],`${type}/initial`);
    field.checked=!initial[type];await field.dispatch("change");
  }
  for(const type of Object.keys(initial)){
    editor.setTool(type);
    assert.equal(field.checked,!initial[type],`${type}/remembered`);
    const layer=await placeAnnotation(editor,type,[100+editor.state.layers.length*120,100+editor.state.layers.length*100],[180+editor.state.layers.length*120,160+editor.state.layers.length*100]);
    assert.equal(layer.outline,!initial[type],`${type}/created`);
    editor.selectLayers([layer]);editor.setTool("select");
    field.checked=initial[type];await field.dispatch("change");
    assert.equal(layer.outline,initial[type],`${type}/selected`);
    editor.setTool(type);
    assert.equal(field.checked,!initial[type],`${type}/after-selection`);
  }
  editor.selectLayers(editor.state.layers);editor.setTool("select");
  assert.equal(field.indeterminate,true);
  for(const type of Object.keys(initial)){
    editor.setTool(type);
    assert.equal(field.checked,!initial[type],`${type}/after-mixed`);
    assert.equal(field.indeterminate,false,type);
    assert.equal(field.dataset.mixed,"false",type);
  }
});

test("白縁の一括変更は文字・矢印・直線・四角形・楕円だけへ反映し、一度で元に戻せる",async () => {
  const editor=createEditor(),field=editor.get("whiteOutline");
  editor.state.layers=[
    {...textLayer(),outline:false},
    {id:"arrow",type:"arrow",x1:300,y1:100,x2:380,y2:160,color:"#000000",lineWidth:8,outline:true,visible:true},
    {id:"line",type:"line",x1:400,y1:100,x2:480,y2:160,color:"#000000",lineWidth:8,visible:true},
    {...rectangleLayer("rect",500,100),outline:false},
    {...rectangleLayer("ellipse",600,100),type:"ellipse"},
    {id:"ink",type:"ink",points:[{x:100,y:200},{x:180,y:240}],brushSize:8,color:"#000000",visible:true},
    {...rectangleLayer("blackout",300,200),type:"blackoutRect"},
    {id:"image",type:"image",x:500,y:200,w:80,h:60,imageCanvas:editor.get("layerCanvas"),visible:true}
  ];
  editor.selectLayers(editor.state.layers);editor.setTool("select");
  assert.equal(field.indeterminate,true);
  field.checked=true;await field.dispatch("change");
  assert.deepEqual(editor.state.layers.map(layer => layer.outline),[true,true,true,true,true,undefined,undefined,undefined]);
  assert.equal(editor.state.undo.length,1);
  editor.undo();
  assert.deepEqual(editor.state.layers.map(layer => layer.outline),[false,true,undefined,false,undefined,undefined,undefined,undefined]);
  editor.redo();
  assert.deepEqual(editor.state.layers.map(layer => layer.outline),[true,true,true,true,true,undefined,undefined,undefined]);
});

test("トリミング開始時は画像全体を薄く暗くし、範囲の枠・ハンドルは描かず確定と中央配置を無効にする",async () => {
  const editor=createEditor({separateEditContext:true}),ctx=editor.get("editCanvas").getContext("2d");
  ctx.calls.length=0;
  editor.setTool("crop");
  assert.equal(editor.state.crop,null);
  assert.deepEqual(["cropW","cropH"].map(id => editor.get(id).value),["",""]);
  assert.equal(editor.get("applyCrop").disabled,true);
  assert.equal(editor.get("centerCrop").disabled,true);
  assert.deepEqual(ctx.calls.filter(call => call.method === "fillRect"),[
    {method:"fillRect",args:[0,0,1000,700],fillStyle:"rgba(0,0,0,.28)"}
  ]);
  assert.equal(ctx.calls.some(call => call.method === "strokeRect"),false);
  assert.ok(ctx.calls.filter(call => call.method === "clearRect").every(call => call.args.join(",") === "0,0,1000,700"));
  await editor.get("centerCrop").dispatch("click");
  assert.equal(editor.state.crop,null);
  await editor.get("applyCrop").dispatch("click");
  assert.equal(editor.get("baseCanvas").width,1000);
  assert.equal(editor.state.undo.length,0);
  const empty=createEditor({loaded:false,separateEditContext:true});empty.setTool("crop");
  assert.equal(empty.get("editCanvas").getContext("2d").calls.some(call => call.method === "fillRect"),false);
});

test("切り抜く範囲ができたら外側を暗く保ち、範囲内を明るくして枠と四つのハンドルを描く",async () => {
  const editor=createEditor({separateEditContext:true}),ctx=editor.get("editCanvas").getContext("2d");
  editor.setTool("crop");ctx.calls.length=0;
  await selectRectangle(editor,[100,100],[350,250]);
  const index=ctx.calls.findLastIndex(call => call.method === "fillRect" && call.fillStyle === "rgba(0,0,0,.48)");
  assert.ok(index >= 0);
  const overlay=ctx.calls.slice(index);
  assert.deepEqual(overlay[0],{method:"fillRect",args:[0,0,1000,700],fillStyle:"rgba(0,0,0,.48)"});
  assert.deepEqual(overlay.find(call => call.method === "clearRect")?.args,[100,100,250,150]);
  const borders=overlay.filter(call => call.method === "strokeRect");
  assert.equal(borders.length,5);assert.deepEqual(borders[0].args,[100,100,250,150]);
  assert.equal(overlay.filter(call => call.method === "fillRect" && call.fillStyle === "#fff").length,4);
  assert.equal(editor.state.undo.length,0);assert.equal(editor.hasUnsavedChanges(),false);
});

test("トリミングの取消や他ツールへの切替は暗転を消し、元画像・注釈・保存用描画・履歴を変えない",async () => {
  for(const action of ["cancel","tool"]){
    const editor=createEditor({separateEditContext:true}),base=editor.get("baseCanvas"),canvas=editor.get("editCanvas");
    const ctx=canvas.getContext("2d"),baseContext=base.getContext("2d");
    editor.state.layers=[textLayer()];const before=JSON.stringify(editor.state.layers),revision=editor.state.revision;
    baseContext.calls.length=0;editor.setTool("crop");
    assert.ok(ctx.calls.some(call => call.method === "fillRect" && call.fillStyle === "rgba(0,0,0,.28)"));
    assert.equal(baseContext.calls.some(call => call.method === "fillRect"),false,"暗幕は編集用Canvasだけへ描く");
    ctx.calls.length=0;
    if(action === "cancel") await editor.get("cancelCrop").dispatch("click");else editor.setTool("ellipse");
    assert.ok(ctx.calls.some(call => call.method === "clearRect" && call.args.join(",") === "0,0,1000,700"));
    assert.equal(ctx.calls.some(call => call.method === "fillRect"),false);
    assert.deepEqual([base.width,base.height],[1000,700]);assert.equal(JSON.stringify(editor.state.layers),before);
    assert.equal(editor.state.undo.length,0);assert.equal(editor.state.redo.length,0);assert.equal(editor.state.revision,revision);
    assert.equal(editor.hasUnsavedChanges(),false);
    await editor.get("previewButton").dispatch("click");
    assert.equal(baseContext.calls.some(call => call.method === "drawImage" && call.args[0] === canvas),false,"保存用の合成へ暗幕Canvasを取り込まない");
    assert.equal(editor.state.undo.length,0);assert.equal(editor.state.revision,revision);
  }
});

test("トリミングは3表示pxのドラッグから範囲を作り、pointerupの最終座標を画像座標へ反映する",async () => {
  for(const scale of [.25,1,4]){
    const editor=createEditor(),canvas=editor.get("editCanvas");
    canvas.getBoundingClientRect=() => ({left:80,top:50,width:1000*scale,height:700*scale});
    const at=(x,y) => ({clientX:80+x*scale,clientY:50+y*scale});
    editor.setTool("crop");
    await canvas.dispatch("pointerdown",at(100,100));
    await canvas.dispatch("pointermove",at(100+2/scale,100));
    assert.equal(editor.state.crop,null,`${scale}/jitter`);
    await canvas.dispatch("pointerup",at(100+2/scale,100));
    assert.equal(editor.state.crop,null,`${scale}/click`);
    await canvas.dispatch("pointerdown",at(100,100));
    await canvas.dispatch("pointermove",at(100+3/scale,100+3/scale));
    assert.ok(editor.state.crop,`${scale}/threshold`);
    await canvas.dispatch("pointercancel");
    assert.equal(editor.state.crop,null,`${scale}/cancel`);
    await canvas.dispatch("pointerdown",at(100,100));
    await canvas.dispatch("pointerup",at(300,250));
    assert.deepEqual({...editor.state.crop},{x:100,y:100,w:200,h:150},`${scale}/up`);
    assert.equal(editor.get("applyCrop").disabled,false);
    assert.equal(editor.get("centerCrop").disabled,false);
    assert.equal(editor.state.undo.length,0);
    assert.equal(editor.hasUnsavedChanges(),false);
  }
});

test("トリミングの取消は選択へ戻って枠と数値を消し、確定するとUndo可能な画像を切り抜く",async () => {
  const editor=createEditor();
  editor.state.layers=[rectangleLayer()];
  editor.setTool("crop");
  await selectRectangle(editor,[50,50],[350,250]);
  await editor.get("cancelCrop").dispatch("click");
  assert.equal(editor.state.tool,"select");
  assert.equal(editor.state.crop,null);
  assert.equal(editor.get("cropW").value,"");assert.equal(editor.get("cropH").value,"");
  assert.equal(editor.state.undo.length,0);
  editor.setTool("crop");
  await selectRectangle(editor,[50,50],[350,250]);
  await editor.get("applyCrop").dispatch("click");
  assert.equal(editor.state.tool,"select");
  assert.equal(editor.state.crop,null);
  assert.deepEqual([editor.get("baseCanvas").width,editor.get("baseCanvas").height],[300,200]);
  assert.deepEqual([editor.state.layers[0].x,editor.state.layers[0].y],[50,50]);
  assert.equal(editor.state.undo.length,1);
  assert.equal(editor.hasUnsavedChanges(),true);
  editor.undo();
  assert.deepEqual([editor.get("baseCanvas").width,editor.get("baseCanvas").height],[1000,700]);
  assert.deepEqual([editor.state.layers[0].x,editor.state.layers[0].y],[100,100]);
  editor.redo();
  assert.deepEqual([editor.get("baseCanvas").width,editor.get("baseCanvas").height],[300,200]);
});

test("トリミングの幅・高さから原点で枠を作り、中央配置後も数値変更と比率を位置を保って反映する",async () => {
  const editor=createEditor();editor.setTool("crop");
  editor.get("cropW").value="200";await editor.get("cropW").dispatch("change");
  assert.equal(editor.state.crop,null);assert.equal(editor.get("cropW").value,"200");
  editor.get("cropH").value="100";await editor.get("cropH").dispatch("change");
  assert.deepEqual({...editor.state.crop},{x:0,y:0,w:200,h:100});
  await editor.get("centerCrop").dispatch("click");
  assert.deepEqual({...editor.state.crop},{x:400,y:300,w:200,h:100});
  editor.get("cropW").value="250";await editor.get("cropW").dispatch("change");
  assert.deepEqual({...editor.state.crop},{x:400,y:300,w:250,h:100});
  editor.get("cropRatio").value="1";await editor.get("cropRatio").dispatch("change");
  assert.deepEqual({...editor.state.crop},{x:400,y:300,w:250,h:250});
  editor.get("cropH").value="120";await editor.get("cropH").dispatch("change");
  assert.deepEqual({...editor.state.crop},{x:400,y:300,w:120,h:120});
  editor.get("cropW").value="1000";await editor.get("cropW").dispatch("change");
  assert.deepEqual({...editor.state.crop},{x:400,y:300,w:400,h:400});
  for(const invalid of ["","0","-1","not-a-number"]){
    editor.get("cropH").value=invalid;await editor.get("cropH").dispatch("change");
    assert.deepEqual({...editor.state.crop},{x:400,y:300,w:400,h:400},invalid);
    assert.deepEqual([editor.get("cropW").value,editor.get("cropH").value],[400,400]);
  }
  await editor.get("cancelCrop").dispatch("click");editor.setTool("crop");
  for(const invalid of ["","0","-1","not-a-number"]){
    editor.get("cropW").value="100";editor.get("cropH").value=invalid;
    await editor.get("cropH").dispatch("change");
    assert.equal(editor.state.crop,null,invalid);assert.equal(editor.get("applyCrop").disabled,true,invalid);
  }
});

test("ドラッグで作った切り抜き範囲の位置は幅・高さ変更でも保ち、画像外へ広げず確定とUndoできる",async () => {
  const editor=createEditor();editor.state.layers=[rectangleLayer("retained",300,200)];editor.setTool("crop");
  await selectRectangle(editor,[200,150],[400,250]);
  editor.get("cropW").value="900";await editor.get("cropW").dispatch("change");
  assert.deepEqual({...editor.state.crop},{x:200,y:150,w:800,h:100});
  editor.get("cropH").value="900";await editor.get("cropH").dispatch("change");
  assert.deepEqual({...editor.state.crop},{x:200,y:150,w:800,h:550});
  await editor.get("applyCrop").dispatch("click");
  assert.deepEqual([editor.get("baseCanvas").width,editor.get("baseCanvas").height],[800,550]);
  assert.deepEqual([editor.state.layers[0].x,editor.state.layers[0].y],[100,50]);
  assert.equal(editor.state.undo.length,1);editor.undo();
  assert.deepEqual([editor.get("baseCanvas").width,editor.get("baseCanvas").height],[1000,700]);
  assert.deepEqual([editor.state.layers[0].x,editor.state.layers[0].y],[300,200]);
});

test("400%表示の小さなcrop範囲も有効表示と同じ丸めで1pxとして確定できる",async () => {
  const editor=createEditor(),canvas=editor.get("editCanvas");
  canvas.getBoundingClientRect=() => ({left:0,top:0,width:4000,height:2800});
  editor.setTool("crop");
  await canvas.dispatch("pointerdown",{clientX:400,clientY:400});
  await canvas.dispatch("pointerup",{clientX:403,clientY:403});
  assert.equal(editor.get("applyCrop").disabled,false);
  assert.deepEqual([editor.get("cropW").value,editor.get("cropH").value],[1,1]);
  await editor.get("applyCrop").dispatch("click");
  assert.deepEqual([editor.get("baseCanvas").width,editor.get("baseCanvas").height],[1,1]);
  assert.equal(editor.state.undo.length,1);
});

test("既存cropの外側クリックは範囲を維持し、新規ドラッグ取消と角の最終pointerupでも整合する",async () => {
  const editor=createEditor(),canvas=editor.get("editCanvas");
  editor.setTool("crop");editor.get("cropRatio").value="16:9";
  await selectRectangle(editor,[100,100],[260,150]);
  const before={...editor.state.crop};
  await canvas.dispatch("pointerdown",{clientX:500,clientY:400});
  await canvas.dispatch("pointerup",{clientX:501,clientY:401});
  assert.deepEqual({...editor.state.crop},before);
  await canvas.dispatch("pointerdown",{clientX:500,clientY:400});
  await canvas.dispatch("pointermove",{clientX:700,clientY:500});
  assert.notDeepEqual({...editor.state.crop},before);
  await canvas.dispatch("pointercancel");
  assert.deepEqual({...editor.state.crop},before);
  await canvas.dispatch("pointerdown",{clientX:260,clientY:190});
  await canvas.dispatch("pointerup",{clientX:420,clientY:230});
  assert.deepEqual({...editor.state.crop},{x:100,y:100,w:320,h:180});
  assert.equal(editor.state.undo.length,0);
});

test("比率付きcropドラッグと取消は開始前の範囲・履歴を復元し、別ポインターで変更しない",async () => {
  const editor=createEditor(),canvas=editor.get("editCanvas");
  editor.setTool("crop");editor.get("cropRatio").value="16:9";
  await selectRectangle(editor,[100,100],[260,150]);
  assert.deepEqual({...editor.state.crop},{x:100,y:100,w:160,h:90});
  const before={...editor.state.crop};
  await canvas.dispatch("pointerdown",{clientX:180,clientY:140});
  await canvas.dispatch("pointermove",{clientX:220,clientY:170,pointerId:2});
  assert.deepEqual({...editor.state.crop},before);
  await canvas.dispatch("pointermove",{clientX:220,clientY:170});
  assert.deepEqual({...editor.state.crop},{x:140,y:130,w:160,h:90});
  await canvas.dispatch("pointercancel");
  assert.deepEqual({...editor.state.crop},before);
  assert.equal(editor.state.undo.length,0);
  assert.equal(editor.hasUnsavedChanges(),false);
  await editor.get("cancelCrop").dispatch("click");editor.setTool("crop");
  await canvas.dispatch("pointerdown",{clientX:100,clientY:100});
  await canvas.dispatch("pointermove",{clientX:260,clientY:150});
  await canvas.dispatch("lostpointercapture");
  assert.equal(editor.state.crop,null);
  assert.equal(editor.get("applyCrop").disabled,true);
  assert.equal(canvas.captured.size,0);
});

test("画像読込み後は寸法情報を表示し、cropを選んでも画像サイズを変更しない",async () => {
  const editor=createEditor();
  await editor.loadSingleFile({name:"upload-name.png",type:"image/png",size:1024});
  assert.match(editor.get("singleInfo").textContent,/240.*120/);
  editor.setTool("crop");
  assert.equal(editor.state.crop,null);
  assert.deepEqual([editor.get("baseCanvas").width,editor.get("baseCanvas").height],[240,120]);
  assert.equal(editor.state.undo.length,0);
});

test("配置済み文字は文字ツールのクリックで増えず、ダブルクリックで同じ文字を直接編集する",async () => {
  const editor = createEditor();
  editor.state.layers = [textLayer()];
  editor.setTool("text");
  await editor.get("editCanvas").dispatch("pointerdown",{clientX:120,clientY:140});
  await editor.get("editCanvas").dispatch("pointerup",{clientX:120,clientY:140});
  await editor.get("editCanvas").dispatch("dblclick",{clientX:120,clientY:140});
  assert.equal(editor.state.layers.length,1);
  assert.equal(editor.document.activeElement,editor.get("textEditor"));
  assert.equal(editor.get("textEditor").selectionStart,1);
  assert.equal(editor.get("textEditor").selectionEnd,1);
  assert.equal(editor.get("textEditor").textSelected,undefined);
  assert.equal(editor.get("textEditor").value,"もとの文字");
  editor.get("textEditor").value="書き換え";
  await editor.get("textEditor").dispatch("input");
  editor.get("textEditor").value="書き換えた文字";
  await editor.get("textEditor").dispatch("input");
  assert.equal(editor.state.layers[0].id,"text-1");
  assert.equal(editor.state.layers[0].text,"書き換えた文字");
  assert.equal(editor.state.undo.length,1);
  const event = await editor.document.dispatch("keydown",{target:editor.get("textEditor"),key:"Backspace"});
  assert.equal(event.prevented,false);
  assert.equal(editor.state.layers.length,1);
  editor.undo();
  assert.equal(editor.state.layers[0].text,"もとの文字");
  editor.redo();
  assert.equal(editor.state.layers[0].text,"書き換えた文字");
});

test("固定高の設定バーは最上部の文字のダブルクリックを通常幅と狭幅でも妨げない",async () => {
 for(const {top,width} of [{top:100,width:1000},{top:280,width:300}]){
  for(const tool of ["select","ink","blackoutBrush","mosaicBrush","rect","text"]){
    const editor=createEditor(),viewport=editor.get("canvasViewport"),canvas=editor.get("editCanvas"),panel=editor.get("contextPanel");
    editor.window.innerHeight=800;editor.window.scrollY=0;
    viewport.clientWidth=width;
    Object.defineProperty(viewport,"clientHeight",{get:() => parseFloat(editor.viewState.viewportRule?.style.height) || 640});
    viewport.getBoundingClientRect=() => ({left:0,top,width,height:viewport.clientHeight});
    const rectangle=() => ({left:0,top,width:1000*editor.viewState.scale,height:700*editor.viewState.scale});
    editor.get("canvasHolder").getBoundingClientRect=rectangle;canvas.getBoundingClientRect=rectangle;
    const text={...textLayer(),y:40};
    editor.state.layers=[rectangleLayer("other",150,310),text];editor.setTool(tool);editor.flushAnimationFrames();
    const scale=editor.viewState.scale,client={clientX:120*scale,clientY:top+30*scale};
    for(let click=1;click<=2;click++){
      await canvas.dispatch("pointerdown",{...client,detail:0});editor.flushAnimationFrames();
      assert.equal(viewport.getBoundingClientRect().top,top,tool);assert.equal(editor.viewState.scale,scale,tool);
      await canvas.dispatch("pointerup",{...client,detail:0});
      await canvas.dispatch("click",{...client,detail:click});editor.flushAnimationFrames();
      assert.equal(viewport.getBoundingClientRect().top,top,tool);assert.equal(editor.viewState.scale,scale,tool);
      assert.equal(panel.inert,false,tool);assert.deepEqual(selectedIds(editor),["text-1"],tool);
    }
    const event=await canvas.dispatch("dblclick",{...client,detail:2});
    assert.equal(event.prevented,true,tool);assert.equal(editor.state.textEditing,"text-1",tool);
    assert.deepEqual(selectedIds(editor),["text-1"],tool);assert.equal(editor.document.activeElement,editor.get("textEditor"),tool);
    assert.equal(editor.get("textEditor").selectionStart,1,tool);assert.equal(editor.state.layers.length,2,tool);
    assert.deepEqual([text.x,text.y],[100,40],tool);assert.equal(editor.state.undo.length,0,tool);assert.equal(editor.hasUnsavedChanges(),false,tool);
  }
 }
});

test("新規文字は空のまま直接編集を始め、blur後も枠を残して再編集・Undoできる",async () => {
  const editor=createEditor(),canvas=editor.get("editCanvas"),field=editor.get("textEditor");
  editor.setTool("text");
  const placement=await canvas.dispatch("pointerdown",{clientX:100,clientY:150});
  assert.equal(placement.prevented,true,"既定のポインター処理でcanvasへフォーカスを戻さない");
  await canvas.dispatch("pointerup",{clientX:100,clientY:150});
  assert.equal(editor.state.layers.length,1);
  const layer=editor.state.layers[0];
  assert.equal(layer.type,"text");
  assert.equal(layer.text,"");
  assert.equal(layer.textWidth,300);
  assert.equal(editor.state.textEditing,layer.id);
  assert.equal(editor.document.activeElement,field);
  assert.equal(field.hidden,false);
  assert.equal(field.selectionStart,0);
  assert.equal(field.selectionEnd,0);
  assert.equal(editor.state.undo.length,1);
  await field.dispatch("blur");
  assert.equal(field.hidden,true);
  assert.equal(editor.state.textEditing,null);
  assert.equal(editor.state.layers[0].text,"");
  assert.equal(editor.state.undo.length,1);
  await canvas.dispatch("dblclick",{clientX:120,clientY:140});
  assert.equal(editor.state.layers.length,1);
  assert.equal(editor.state.textEditing,layer.id);
  field.value="入力した文字";
  await field.dispatch("input");
  assert.equal(editor.state.undo.length,2);
  await field.dispatch("keydown",{key:"Escape"});
  editor.undo();
  assert.equal(editor.state.layers.length,1);
  assert.equal(editor.state.layers[0].text,"");
  editor.undo();assert.equal(editor.state.layers.length,0);
  editor.redo();assert.equal(editor.state.layers[0].text,"");
  editor.redo();assert.equal(editor.state.layers[0].text,"入力した文字");
});

test("Enterは改行を入力し、EscとCtrl/Command Enterは入力を確定して選択へ戻る",async () => {
  for(const confirm of [{key:"Escape"},{key:"Enter",ctrlKey:true},{key:"Enter",metaKey:true}]){
    const editor=createEditor(),field=editor.get("textEditor");
    editor.state.layers=[textLayer()];
    editor.beginTextEditing(editor.state.layers[0]);
    const enter=await field.dispatch("keydown",{key:"Enter"});
    assert.equal(enter.prevented,false);
    assert.equal(editor.state.textEditing,"text-1");
    field.value="一行目\n二行目";
    await field.dispatch("input");
    assert.equal(editor.state.layers[0].text,"一行目\n二行目");
    assert.equal(editor.state.undo.length,1);
    const event=await field.dispatch("keydown",confirm);
    assert.equal(event.prevented,true);
    assert.equal(field.hidden,true);
    assert.equal(editor.state.textEditing,null);
    assert.equal(editor.state.layers[0].text,"一行目\n二行目");
    assert.equal(editor.document.activeElement,editor.get("editCanvas"));
    assert.equal(editor.state.undo.length,1);
    editor.undo();assert.equal(editor.state.layers[0].text,"もとの文字");
  }
});

test("文字編集中の削除・コピー・貼付・Undoはネイティブ入力へ渡し、オブジェクトを変えない",async () => {
  const editor=createEditor(),canvas=editor.get("editCanvas"),field=editor.get("textEditor");
  editor.state.layers=[textLayer(),rectangleLayer()];editor.selectLayers([editor.state.layers[0]]);
  const data=clipboard();
  await editor.document.dispatch("copy",{target:canvas,clipboardData:data});
  editor.beginTextEditing(editor.state.layers[0]);
  field.value="編集内容";await field.dispatch("input");
  const revision=editor.state.revision;
  for(const key of ["Backspace","Delete","ArrowLeft","ArrowRight"]){
    const event=await editor.document.dispatch("keydown",{target:field,key});
    assert.equal(event.prevented,false,key);
  }
  for(const key of ["z","y","a","c","v"]){
    const event=await editor.document.dispatch("keydown",{target:field,key,ctrlKey:true});
    assert.equal(event.prevented,false,key);
  }
  for(const type of ["copy","paste"]){
    const event=await editor.document.dispatch(type,{target:field,clipboardData:data});
    assert.equal(event.prevented,false,type);
  }
  assert.equal(editor.state.layers.length,2);
  assert.equal(editor.state.layers[0].text,"編集内容");
  assert.equal(editor.state.undo.length,1);
  assert.equal(editor.state.revision,revision);
  // A native textarea undo arrives as input, rather than an object undo.
  field.value="もとの文字";await field.dispatch("input");
  assert.equal(editor.state.textEditing,"text-1");
  assert.equal(editor.state.layers.length,2);
});

test("IME変換中はEsc・確定キー・blurで文字編集を閉じず、変換終了後に確定する",async () => {
  for(const marker of [{isComposing:true},{keyCode:229},{state:true}]){
    const editor=createEditor(),field=editor.get("textEditor");
    editor.state.layers=[textLayer()];editor.beginTextEditing(editor.state.layers[0]);
    if(marker.state) await editor.document.dispatch("compositionstart",{target:field});
    for(const key of ["Escape","Enter"]){
      const event=await field.dispatch("keydown",{key,ctrlKey:key === "Enter",...marker});
      assert.equal(event.prevented,false);
      assert.equal(field.hidden,false);
      assert.equal(editor.state.textEditing,"text-1");
    }
    if(marker.state){
      field.value="変換中";await field.dispatch("input");
      await field.dispatch("blur");
      assert.equal(editor.state.textEditing,"text-1");
      field.value="変換済み";
      await field.dispatch("compositionend");
      assert.equal(field.hidden,true);
      assert.equal(editor.state.textEditing,null);
      assert.equal(editor.state.layers[0].text,"変換済み");
      assert.equal(editor.state.undo.length,1);
    }
  }
});

test("文字入力欄内のクリックは編集を維持し、保存・比較を開く前に最新の文字を確定する",async () => {
  for(const action of ["shortcut","save","preview"]){
    const editor=createEditor(),field=editor.get("textEditor");
    editor.state.layers=[textLayer()];editor.beginTextEditing(editor.state.layers[0]);
    await editor.document.dispatch("pointerdown",{target:field});
    assert.equal(editor.state.textEditing,"text-1");
    assert.equal(field.hidden,false);
    // The boundary also flushes a native value before its final input event.
    field.value="保存・比較する最新文字";
    if(action === "shortcut"){
      const event=await field.dispatch("keydown",{key:"s",ctrlKey:true});
      assert.equal(event.prevented,true);
    }else await editor.get(action === "save" ? "showSaveSettings" : "previewButton").dispatch("click");
    assert.equal(editor.state.textEditing,null,action);
    assert.equal(field.hidden,true,action);
    assert.equal(editor.state.layers[0].text,"保存・比較する最新文字",action);
    assert.equal(editor.state.undo.length,1,action);
    assert.equal(editor.get(action === "preview" ? "previewDialog" : "saveDialog").classList.contains("hidden"),false,action);
  }
});

test("文字編集は選択・ツール・画像外クリックで確定し、同じ文字へ戻した編集は履歴と未保存判定を戻す",async () => {
  for(const action of ["selection","tool","outside"]){
    const editor=createEditor(),field=editor.get("textEditor");
    editor.state.layers=[textLayer(),rectangleLayer()];editor.beginTextEditing(editor.state.layers[0]);
    field.value="確定した文字";await field.dispatch("input");
    if(action === "selection") editor.selectLayers([editor.state.layers[1]]);
    if(action === "tool") editor.setTool("rect");
    if(action === "outside") await editor.document.dispatch("pointerdown",{target:editor.document.body});
    assert.equal(editor.state.textEditing,null,action);
    assert.equal(field.hidden,true,action);
    assert.equal(editor.state.layers[0].text,"確定した文字",action);
    assert.equal(editor.state.undo.length,1,action);
  }
  const editor=createEditor(),field=editor.get("textEditor");
  editor.state.layers=[textLayer(),rectangleLayer()];editor.selectLayers([editor.state.layers[1]]);
  await editor.document.dispatch("keydown",{target:editor.get("editCanvas"),key:"ArrowRight"});
  editor.undo();
  const before={undo:editor.state.undo.slice(),redo:editor.state.redo.slice(),revision:editor.state.revision};
  assert.equal(editor.hasUnsavedChanges(),false);
  editor.beginTextEditing(editor.state.layers[0]);
  field.value="一時入力";await field.dispatch("input");
  assert.equal(editor.hasUnsavedChanges(),true);
  assert.equal(editor.state.redo.length,0);
  field.value="もとの文字";await field.dispatch("input");
  await field.dispatch("blur");
  assert.deepEqual(editor.state.undo,before.undo);
  assert.deepEqual(editor.state.redo,before.redo);
  assert.equal(editor.state.revision,before.revision);
  assert.equal(editor.hasUnsavedChanges(),false);
  editor.redo();assert.equal(editor.state.layers[1].x,101);
});

test("文字編集を確定してDeleteで選択対象を削除し、Undoで編集済み文字を復元する",async () => {
  const editor=createEditor(),field=editor.get("textEditor"),canvas=editor.get("editCanvas");
  editor.state.layers=[textLayer()];editor.beginTextEditing(editor.state.layers[0]);
  field.value="更新した文字";await field.dispatch("input");
  await editor.document.dispatch("pointerdown",{target:canvas});
  assert.equal(editor.state.textEditing,null);
  assert.equal(editor.state.layers[0].text,"更新した文字");
  canvas.focus();await editor.document.dispatch("keydown",{target:canvas,key:"Delete"});assert.equal(editor.state.layers.length,0);
  assert.deepEqual(selectedIds(editor),[]);
  editor.undo();assert.equal(editor.state.layers[0].text,"更新した文字");
});

test("直接編集のクリックcaretとCSSOM入力欄は縮小・拡大・表示位置変更でも画像座標へ対応する",async () => {
  const annotation=require("../annotation-style.js");
  for(const scale of [.25,1,4]){
    const editor=createEditor(),canvas=editor.get("editCanvas"),field=editor.get("textEditor");
    const layer={...textLayer(),fontFamily:"ms-mincho",bold:false,textWidth:120};
    editor.state.layers=[layer];
    canvas.getBoundingClientRect=() => ({left:80,top:50,width:1000*scale,height:700*scale});
    await canvas.dispatch("dblclick",{clientX:80+127*scale,clientY:50+140*scale});
    assert.equal(field.selectionStart,1,`caret/${scale}`);
    assert.equal(field.selectionEnd,1,`caret/${scale}`);
    const rules=editor.document.styleSheets[0].cssRules;
    const editorStyle=rules.find(rule => rule.selectorText === "#textEditor").style;
    const hostStyle=rules.find(rule => rule.selectorText === "#textEditorHost").style;
    const box=annotation.editingTextBox(canvas.getContext("2d"),layer);
    assert.equal(hostStyle.left,`${box.left*scale}px`);
    assert.equal(hostStyle.top,`${box.top*scale}px`);
    assert.equal(hostStyle.width,`${(box.width+2)*scale}px`);
    assert.equal(hostStyle.height,`${box.height*scale}px`);
    assert.equal(editorStyle.width,`${box.width}px`);
    assert.equal(editorStyle.height,`${box.height}px`);
    assert.equal(editorStyle.transform,`scale(${scale})`);
    assert.equal(editorStyle.font,annotation.fontFor(layer));
    assert.equal(editorStyle["--editing-text-color"],layer.color);
    assert.equal(editor.get("baseCanvas").width,1000);
    assert.equal(editor.state.layers[0].x,100);
    assert.equal(editor.state.undo.length,0);
    const nextScale=scale*1.5;
    canvas.getBoundingClientRect=() => ({left:20,top:100,width:1000*nextScale,height:700*nextScale});
    editor.syncTextEditor();
    assert.equal(hostStyle.left,`${box.left*nextScale}px`);
    assert.equal(hostStyle.top,`${box.top*nextScale}px`);
    assert.equal(hostStyle.width,`${(box.width+2)*nextScale}px`);
    assert.equal(editorStyle.transform,`scale(${nextScale})`);
    assert.equal(field.selectionStart,1);
    assert.equal(field.selectionEnd,1);
  }
});

test("選択オブジェクトのBackspace/Delete削除は一度で戻せる",async () => {
  for(const key of ["Backspace","Delete"]){
    const editor = createEditor();
    editor.state.layers = [textLayer()];
    editor.state.selectedLayerId="text-1";
    const event = await editor.document.dispatch("keydown",{target:editor.get("editCanvas"),key});
    assert.equal(event.prevented,true);
    assert.equal(editor.state.layers.length,0);
    assert.equal(editor.state.undo.length,1);
    editor.undo();
    assert.equal(editor.state.layers[0].id,"text-1");
    editor.redo();
    assert.equal(editor.state.layers.length,0);
  }
});

test("ブラシや図形ツール中も配置済み文字のダブルクリックでは加工を増やさず文字編集を始める",async () => {
  for(const tool of ["blackoutBrush","mosaicBrush","rect","ellipse","arrow","blackoutRect","mosaicRect"]){
    const editor=createEditor();
    editor.state.layers=[textLayer()];
    editor.setTool(tool);
    for(let click=0;click<2;click++){
      await editor.get("editCanvas").dispatch("pointerdown",{clientX:120,clientY:140});
      await editor.get("editCanvas").dispatch("pointerup",{clientX:120,clientY:140});
    }
    await editor.get("editCanvas").dispatch("dblclick",{clientX:120,clientY:140});
    assert.equal(editor.state.layers.length,1,tool);
    assert.equal(editor.state.undo.length,0,tool);
    assert.equal(editor.document.activeElement,editor.get("textEditor"),tool);
    editor.get("textEditor").value="修正した文字";
    await editor.get("textEditor").dispatch("input");
    assert.equal(editor.state.layers[0].id,"text-1",tool);
    assert.equal(editor.state.layers[0].text,"修正した文字",tool);
  }
});

test("コピーした文字・書式とブラシ設定を別オブジェクトとして貼り付け、点とマスクを共有しない",async () => {
  const originals = [textLayer(),{id:"brush-1",type:"mosaicBrush",points:[{x:80,y:90},{x:130,y:140}],
    brushSize:50,mosaicSize:18,visible:true,maskCanvas:{old:true},maskDirty:false}];
  for(const original of originals){
    const editor = createEditor();
    editor.state.layers=[original];
    editor.state.selectedLayerId=original.id;
    const data=clipboard();
    const copied=await editor.document.dispatch("copy",{target:editor.get("editCanvas"),clipboardData:data});
    assert.equal(copied.prevented,true);
    original.color="#0000ff";
    const pasted=await editor.document.dispatch("paste",{target:editor.get("editCanvas"),clipboardData:data});
    assert.equal(pasted.prevented,true);
    assert.equal(editor.state.layers.length,2);
    const duplicate=editor.state.layers[1];
    assert.notEqual(duplicate.id,original.id);
    assert.equal(editor.state.selectedLayerId,duplicate.id);
    assert.equal(editor.state.undo.length,1);
    if(original.type === "text"){
      assert.equal(duplicate.text,"もとの文字");
      assert.equal(duplicate.color,"#ff0000");
      assert.equal(duplicate.fontSize,42);
      assert.notEqual(duplicate.x,original.x);
    }else{
      assert.equal(duplicate.brushSize,50);
      assert.equal(duplicate.mosaicSize,18);
      assert.notEqual(duplicate.points,original.points);
      assert.notEqual(duplicate.points[0],original.points[0]);
      duplicate.points[0].x++;
      assert.equal(original.points[0].x,80);
      assert.equal(duplicate.maskDirty,true);
      assert.notEqual(duplicate.maskCanvas,original.maskCanvas);
    }
    editor.undo();
    assert.equal(editor.state.layers.length,1);
    editor.redo();
    assert.equal(editor.state.layers.length,2);
  }
});

test("入力欄・contenteditable・IME・プレビュー・一括モードでは通常の削除コピー貼付を優先する",async () => {
  const cases = ["input","textarea","select","contenteditable","ime","dialog","saveDialog","batch"];
  for(const name of cases){
    const editor=createEditor();
    editor.state.layers=[textLayer()];
    editor.state.selectedLayerId="text-1";
    const data=clipboard();
    await editor.document.dispatch("copy",{target:editor.get("editCanvas"),clipboardData:data});
    let target=editor.get("editCanvas");
    if(["input","textarea","select","contenteditable"].includes(name)){
      target=editor.document.createElement(name === "contenteditable" ? "div" : name);
      target.isContentEditable=name === "contenteditable";
      target.focus();
    }
    if(name === "dialog") editor.get("previewDialog").classList.remove("hidden");
    if(name === "saveDialog") editor.get("saveDialog").classList.remove("hidden");
    if(name === "batch") editor.get("singlePanel").hidden=true;
    const properties={target,clipboardData:data,isComposing:name === "ime"};
    for(const type of ["copy","paste","keydown"]){
      const event=await editor.document.dispatch(type,{...properties,key:"Delete"});
      assert.equal(event.prevented,false,`${name}: ${type}`);
    }
    assert.equal(editor.state.layers.length,1,name);
    assert.equal(editor.state.undo.length,0,name);
  }
});

test("専用clipboard形式が省かれても同じコピーを貼付でき、別のテキストに変わった後は古いobjectを貼付しない",async () => {
  const editor=createEditor();
  editor.state.layers=[textLayer()];
  editor.state.selectedLayerId="text-1";
  const data=clipboard();
  await editor.document.dispatch("copy",{target:editor.get("editCanvas"),clipboardData:data});
  const plainData=clipboard();
  plainData.setData("text/plain",data.getData("text/plain"));
  await editor.document.dispatch("paste",{target:editor.get("editCanvas"),clipboardData:plainData});
  assert.equal(editor.state.layers.length,2);
  plainData.setData("text/plain","別の文書からコピー");
  const event=await editor.document.dispatch("paste",{target:editor.get("editCanvas"),clipboardData:plainData});
  assert.equal(event.prevented,false);
  assert.equal(editor.state.layers.length,2);
});

test("内部オブジェクトのコピーがあっても画像clipboardの貼付を優先して一度だけ追加する",async () => {
  const editor=createEditor();
  editor.state.layers=[textLayer()];
  editor.state.selectedLayerId="text-1";
  const data=clipboard();
  await editor.document.dispatch("copy",{target:editor.get("editCanvas"),clipboardData:data});
  const event=await editor.document.dispatch("paste",{target:editor.get("editCanvas"),clipboardData:imageClipboard(data)});
  await finishImagePaste();
  assert.equal(event.prevented,true);
  assert.equal(editor.state.layers.length,2);
  assert.equal(editor.state.layers[0].type,"text");
  assert.equal(editor.state.layers[1].type,"image");
  assert.equal(editor.state.undo.length,1);
  assert.equal(editor.state.singleBusy,false);
});

test("大きな画像の貼り付けは元画像・既存注釈を動かさずキャンバスを拡張し、全体を一回でUndo／Redoできる",async () => {
  const editor=createEditor(),base=editor.get("baseCanvas"),source=editor.state.sourceFile,original=editor.state.originalCanvas;
  editor.state.layers=[rectangleLayer(),textLayer(),
    {id:"ink",type:"ink",points:[{x:50,y:60},{x:80,y:90}],brushSize:10,color:"#00f",visible:true}];
  const layersJSON=layers => JSON.stringify(layers,(key,value) => ["maskCanvas","maskDirty"].includes(key) ? undefined : value);
  const before=layersJSON(editor.state.layers);
  let closed=0;
  editor.setImageBitmap(async () => ({width:2000,height:1400,close(){closed++;}}));
  const event=await editor.document.dispatch("paste",{target:editor.get("editCanvas"),clipboardData:imageClipboard()});
  await finishImagePaste();
  assert.equal(event.prevented,true);assert.equal(closed,1);
  assert.deepEqual([base.width,base.height],[2000,1400]);
  assert.equal(layersJSON(editor.state.layers.slice(0,-1)),before);
  const pasted=editor.state.layers.at(-1);
  assert.deepEqual([pasted.type,pasted.x,pasted.y,pasted.w,pasted.h,pasted.opacity],["image",0,0,2000,1400,100]);
  assert.deepEqual([pasted.imageCanvas.width,pasted.imageCanvas.height],[2000,1400]);
  assert.equal(editor.state.sourceFile,source);assert.equal(editor.state.originalCanvas,original);
  assert.notEqual(original,base);assert.deepEqual([original.width,original.height],[1000,700]);
  const copies=base.getContext("2d").calls.filter(call => call.method === "drawImage" && call.args[0] === base);
  assert.ok(copies.length > 0);assert.ok(copies.every(call => call.args.length === 3 && call.args[1] === 0 && call.args[2] === 0));
  assert.equal(editor.state.undo.length,1);assert.equal(editor.state.undo[0].kind,"full");
  assert.equal(editor.hasUnsavedChanges(),true);assert.equal(editor.state.singleBusy,false);
  assert.match(editor.get("singleSaveSize").textContent,/2000 × 1400px/);
  editor.undo();
  assert.deepEqual([base.width,base.height],[1000,700]);assert.equal(layersJSON(editor.state.layers),before);
  editor.redo();
  assert.deepEqual([base.width,base.height],[2000,1400]);
  assert.equal(layersJSON(editor.state.layers.slice(0,-1)),before);
  assert.deepEqual([editor.state.layers.at(-1).w,editor.state.layers.at(-1).h],[2000,1400]);
  await editor.get("resetSingle").dispatch("click");
  assert.deepEqual([base.width,base.height],[1000,700]);assert.equal(editor.state.layers.length,0);
  assert.equal(editor.state.sourceFile,source);assert.equal(editor.state.originalCanvas,original);
  editor.undo();assert.deepEqual([base.width,base.height],[2000,1400]);assert.equal(editor.state.layers.length,4);
});

test("横長・縦長の貼付は必要な方向だけを右下へ拡張し、小さい画像は原寸中央に置いてキャンバスを縮めない",async () => {
  for(const [width,height,expected] of [[1600,400,[1600,700,0,150]],[800,1200,[1000,1200,100,0]],[240,120,[1000,700,380,290]]]){
    const editor=createEditor(),base=editor.get("baseCanvas"),original=editor.state.originalCanvas;
    editor.state.layers=[rectangleLayer()];
    editor.setImageBitmap(async () => ({width,height,close(){}}));
    await editor.document.dispatch("paste",{target:editor.get("editCanvas"),clipboardData:imageClipboard()});
    await finishImagePaste();
    const image=editor.state.layers.at(-1);
    assert.deepEqual([base.width,base.height,image.x,image.y],expected);
    assert.deepEqual([image.w,image.h,image.imageCanvas.width,image.imageCanvas.height],[width,height,width,height]);
    assert.deepEqual([editor.state.layers[0].x,editor.state.layers[0].y,editor.state.layers[0].w,editor.state.layers[0].h],[100,100,80,60]);
    assert.deepEqual([original.width,original.height],[1000,700]);
    assert.equal(editor.state.undo.length,1);assert.equal(editor.state.undo[0].kind,width > 1000 || height > 700 ? "full" : "layers");
  }
});

test("画像追加ファイルは従来どおり既存キャンバスに収まり、貼り付けの拡張設定を引き継がない",async () => {
  const editor=createEditor();editor.setImageBitmap(async () => ({width:2400,height:1200,close(){}}));
  editor.get("imageLayerInput").files=[{name:"file.png",type:"image/png",size:1024}];
  await editor.get("imageLayerInput").dispatch("change");await finishImagePaste();
  const image=editor.state.layers[0];
  assert.deepEqual([editor.get("baseCanvas").width,editor.get("baseCanvas").height],[1000,700]);
  assert.deepEqual([image.x,image.y,image.w,image.h],[0,100,1000,500]);
  assert.deepEqual([image.imageCanvas.width,image.imageCanvas.height],[2400,1200]);
  assert.equal(editor.state.undo.length,1);assert.equal(editor.state.undo[0].kind,"layers");
});

test("画像単独または拡張後の8192px・3600万画素制限を超える貼付は画素・注釈・履歴を変更しない",async () => {
  for(const [oldWidth,oldHeight,width,height,message] of [[7000,3000,3000,7000,/3,600万/],[1000,700,8193,100,/8192/],[1000,700,6001,6000,/3,600万/]]){
    const editor=createEditor(),base=editor.get("baseCanvas");base.width=oldWidth;base.height=oldHeight;
    editor.state.layers=[rectangleLayer()];editor.selectLayers(editor.state.layers);editor.setTool("select");
    const before=JSON.stringify(editor.state.layers),revision=editor.state.revision,source=editor.state.sourceFile,original=editor.state.originalCanvas;
    const draws=base.getContext("2d").calls.filter(call => call.method === "drawImage").length;
    let closed=0;editor.setImageBitmap(async () => ({width,height,close(){closed++;}}));
    const event=await editor.document.dispatch("paste",{target:editor.get("editCanvas"),clipboardData:imageClipboard()});
    await finishImagePaste();
    assert.equal(event.prevented,true);assert.equal(closed,1);
    assert.deepEqual([base.width,base.height],[oldWidth,oldHeight]);assert.equal(JSON.stringify(editor.state.layers),before);
    assert.equal(base.getContext("2d").calls.filter(call => call.method === "drawImage").length,draws);
    assert.equal(editor.state.undo.length,0);assert.equal(editor.state.redo.length,0);assert.equal(editor.state.revision,revision);
    assert.equal(editor.state.singleBusy,false);assert.equal(editor.state.sourceFile,source);assert.equal(editor.state.originalCanvas,original);
    assert.deepEqual(selectedIds(editor),["rect-1"]);assert.match(editor.get("singleStatus").textContent,message);
  }
});

test("最初の画像はclipboardからベースとして読み込んで編集を開始できる",async () => {
  const editor=createEditor();
  editor.state.originalCanvas=null;
  editor.state.sourceFile=null;
  editor.state.tool=null;
  for(const id of ["baseCanvas","layerCanvas","editCanvas"]){editor.get(id).width=0;editor.get(id).height=0;}
  const event=await editor.document.dispatch("paste",{target:editor.document.body,clipboardData:imageClipboard()});
  await finishImagePaste();
  assert.equal(event.prevented,true);
  assert.equal(editor.state.sourceFile.name,"clipboard.png");
  assert.equal(editor.get("baseCanvas").width,240);
  assert.equal(editor.get("baseCanvas").height,120);
  assert.equal(editor.state.tool,"select");
  assert.equal(editor.state.layers.length,0);
  assert.equal(editor.state.undo.length,0);
  assert.equal(editor.state.singleBusy,false);
});

test("文字入力にフォーカスがあると画像clipboardをeditorへ読み込まず通常貼付を優先する",async () => {
  const editor=createEditor();
  editor.state.layers=[textLayer()];
  editor.state.selectedLayerId="text-1";
  editor.get("textEditor").focus();
  const event=await editor.document.dispatch("paste",{target:editor.get("textEditor"),clipboardData:imageClipboard()});
  await finishImagePaste();
  assert.equal(event.prevented,false);
  assert.equal(editor.state.layers.length,1);
  assert.equal(editor.get("baseCanvas").width,1000);
  assert.equal(editor.state.undo.length,0);
  assert.equal(editor.state.singleBusy,false);
});

test("clipboardの専用形式の取得が例外でも標準text fallbackでオブジェクトを貼付する",async () => {
  const editor=createEditor();
  editor.state.layers=[textLayer()];
  editor.state.selectedLayerId="text-1";
  const data=clipboard();
  await editor.document.dispatch("copy",{target:editor.get("editCanvas"),clipboardData:data});
  const getData=data.getData;
  data.getData=type => {
    if(type !== "text/plain") throw new Error("unsupported clipboard type");
    return getData(type);
  };
  const event=await editor.document.dispatch("paste",{target:editor.get("editCanvas"),clipboardData:data});
  assert.equal(event.prevented,true);
  assert.equal(editor.state.layers.length,2);
});

test("空白からの矩形ドラッグは交差する表示中の文字・図形・ブラシ・画像を向きに関係なく選択する",async () => {
  for(const [start,end] of [[[40,30],[450,300]],[[450,300],[40,30]]]){
    const editor=createEditor();
    editor.state.layers=[rectangleLayer(),textLayer(),
      {id:"brush-1",type:"mosaicBrush",points:[{x:80,y:220},{x:130,y:260}],brushSize:20,mosaicSize:18,visible:true},
      {id:"arrow-1",type:"arrow",x1:300,y1:100,x2:350,y2:250,lineWidth:8,color:"#ff0000",visible:true},
      {id:"image-1",type:"image",x:380,y:150,w:100,h:100,imageCanvas:editor.get("layerCanvas"),opacity:70,visible:true},
      rectangleLayer("outside",700,500),rectangleLayer("hidden",180,100)];
    editor.state.layers.at(-1).visible=false;
    await selectRectangle(editor,start,end);
    assert.deepEqual(selectedIds(editor),["arrow-1","brush-1","image-1","rect-1","text-1"]);
    assert.equal(editor.state.undo.length,0);
    assert.equal(editor.state.selectedLayerId,null);
    assert.equal(editor.get("deleteLayer"),null);
    assert.equal(editor.get("contextPanel").classList.contains("hidden"),false);
  }
});

test("矩形の最終pointerup位置を使い、3表示px未満の揺れでは選択を作らない",async () => {
  const editor=createEditor();
  editor.state.layers=[rectangleLayer(),rectangleLayer("rect-2",300,200)];
  const canvas=editor.get("editCanvas");
  await canvas.dispatch("pointerdown",{clientX:99,clientY:99});
  await canvas.dispatch("pointerup",{clientX:101,clientY:101});
  assert.deepEqual(selectedIds(editor),[]);
  await canvas.dispatch("pointerdown",{clientX:50,clientY:50});
  await canvas.dispatch("pointerup",{clientX:450,clientY:300});
  assert.deepEqual(selectedIds(editor),["rect-1","rect-2"]);
  assert.equal(editor.state.undo.length,0);
});

test("矩形選択と複数移動は拡大・縮小とスクロール後の表示位置から画像座標へ一致する",async () => {
  for(const scale of [.5,1,4]){
    const editor=createEditor();
    const canvas=editor.get("editCanvas");
    canvas.getBoundingClientRect=() => ({left:-200,top:-120,width:1000*scale,height:700*scale});
    const point=(x,y) => ({clientX:-200+x*scale,clientY:-120+y*scale});
    editor.state.layers=[rectangleLayer(),rectangleLayer("rect-2",300,200)];
    await canvas.dispatch("pointerdown",point(99,99));
    await canvas.dispatch("pointerup",point(99+2/scale,99+1/scale));
    assert.deepEqual(selectedIds(editor),[],`jitter at ${scale}`);
    await canvas.dispatch("pointerdown",point(50,50));
    await canvas.dispatch("pointermove",point(450,300));
    await canvas.dispatch("pointerup",point(450,300));
    assert.deepEqual(selectedIds(editor),["rect-1","rect-2"],`selection at ${scale}`);
    await canvas.dispatch("pointerdown",point(130,130));
    await canvas.dispatch("pointermove",point(150,145));
    await canvas.dispatch("pointerup",point(150,145));
    assert.equal(editor.state.layers[0].x,120,`x at ${scale}`);
    assert.equal(editor.state.layers[0].y,115,`y at ${scale}`);
    assert.equal(editor.state.layers[1].x,320,`relative x at ${scale}`);
    assert.equal(editor.state.layers[1].y,215,`relative y at ${scale}`);
    assert.equal(canvas.width,1000);
    assert.equal(canvas.height,700);
    assert.equal(editor.state.undo.length,1);
  }
});

test("Shiftクリックは追加・解除、Shift矩形は追加し、未選択のオブジェクトをクリックすると一つへ戻る",async () => {
  const editor=createEditor();
  editor.state.layers=[rectangleLayer(),rectangleLayer("rect-2",300,200),rectangleLayer("rect-3",600,400)];
  const canvas=editor.get("editCanvas");
  await canvas.dispatch("pointerdown",{clientX:130,clientY:130});
  await canvas.dispatch("pointerup",{clientX:130,clientY:130});
  await selectRectangle(editor,[250,150],[450,300],{shiftKey:true});
  assert.deepEqual(selectedIds(editor),["rect-1","rect-2"]);
  await canvas.dispatch("pointerdown",{clientX:330,clientY:230,shiftKey:true});
  await canvas.dispatch("pointerup",{clientX:330,clientY:230,shiftKey:true});
  assert.deepEqual(selectedIds(editor),["rect-1"]);
  assert.equal(editor.state.selectedLayerId,"rect-1");
  await canvas.dispatch("pointerdown",{clientX:330,clientY:230,shiftKey:true});
  await canvas.dispatch("pointerup",{clientX:330,clientY:230,shiftKey:true});
  assert.deepEqual(selectedIds(editor),["rect-1","rect-2"]);
  await canvas.dispatch("pointerdown",{clientX:630,clientY:430});
  await canvas.dispatch("pointerup",{clientX:630,clientY:430});
  assert.deepEqual(selectedIds(editor),["rect-3"]);
  assert.equal(editor.state.undo.length,0);
});

test("選択群内のクリックで群を保ち、画像の端まで共通距離で移動し、Undo/Redoで一度に戻す",async () => {
  const editor=createEditor();
  editor.state.layers=[rectangleLayer(),rectangleLayer("rect-2",300,200)];
  await selectRectangle(editor,[50,50],[450,300]);
  const canvas=editor.get("editCanvas");
  await canvas.dispatch("pointerdown",{clientX:130,clientY:130});
  assert.equal(editor.state.drag.mode,"moveLayers");
  await canvas.dispatch("pointermove",{clientX:950,clientY:690});
  assert.equal(editor.state.layers[0].x,720);
  assert.equal(editor.state.layers[0].y,540);
  assert.equal(editor.state.layers[1].x,920);
  assert.equal(editor.state.layers[1].y,640);
  await canvas.dispatch("pointermove",{clientX:140,clientY:140});
  assert.equal(editor.state.layers[0].x,110);
  assert.equal(editor.state.layers[1].x,310);
  await canvas.dispatch("pointerup",{clientX:230,clientY:230});
  assert.equal(editor.state.layers[0].x,200);
  assert.equal(editor.state.layers[1].x,400);
  assert.deepEqual(selectedIds(editor),["rect-1","rect-2"]);
  assert.equal(editor.state.undo.length,1);
  editor.undo();
  assert.equal(editor.state.layers[0].x,100);
  assert.equal(editor.state.layers[1].x,300);
  assert.deepEqual(selectedIds(editor),[]);
  editor.redo();
  assert.equal(editor.state.layers[0].x,200);
  assert.equal(editor.state.layers[1].x,400);
});

test("矩形のpointercancelは元の選択を復元し、複数移動のcancelは全座標・点とUndo/Redoを復元する",async () => {
  const editor=createEditor();
  const brush={id:"brush-1",type:"blackoutBrush",points:[{x:300,y:200},{x:350,y:250}],brushSize:20,visible:true};
  editor.state.layers=[rectangleLayer(),brush];
  await selectRectangle(editor,[50,50],[450,300]);
  const canvas=editor.get("editCanvas");
  await canvas.dispatch("pointerdown",{clientX:500,clientY:400});
  await canvas.dispatch("pointermove",{clientX:900,clientY:600});
  assert.deepEqual(selectedIds(editor),[]);
  await canvas.dispatch("pointercancel");
  assert.deepEqual(selectedIds(editor),["brush-1","rect-1"]);
  editor.state.undo=Array.from({length:40},(_,index) => ({kind:"layers",layers:[],marker:index}));
  const undoBefore=editor.state.undo.slice();
  editor.state.redo=[{kind:"layers",layers:[rectangleLayer("redo")]}];
  const redoBefore=editor.state.redo.slice();
  await canvas.dispatch("pointerdown",{clientX:130,clientY:130});
  await canvas.dispatch("pointermove",{clientX:200,clientY:220});
  assert.equal(editor.state.layers[0].x,170);
  assert.equal(brush.points[0].x,370);
  await canvas.dispatch("pointercancel");
  assert.equal(editor.state.layers[0].x,100);
  assert.equal(brush.points[0].x,300);
  assert.equal(brush.points[0].y,200);
  assert.deepEqual(editor.state.undo,undoBefore);
  assert.deepEqual(editor.state.redo,redoBefore);
  assert.deepEqual(selectedIds(editor),["brush-1","rect-1"]);
});

test("Escapeは複数選択を解除し、矩形や移動の途中でも加工を残さず取り消す",async () => {
  const editor=createEditor();
  editor.state.layers=[rectangleLayer(),rectangleLayer("rect-2",300,200)];
  const canvas=editor.get("editCanvas");
  for(const mode of ["selected","marquee","move"]){
    await selectRectangle(editor,[50,50],[450,300]);
    if(mode === "marquee"){
      await canvas.dispatch("pointerdown",{clientX:500,clientY:400});
      await canvas.dispatch("pointermove",{clientX:50,clientY:50});
    }
    if(mode === "move"){
      await canvas.dispatch("pointerdown",{clientX:130,clientY:130});
      await canvas.dispatch("pointermove",{clientX:180,clientY:180});
    }
    const event=await editor.document.dispatch("keydown",{target:canvas,key:"Escape"});
    assert.equal(event.prevented,true,mode);
    assert.deepEqual(selectedIds(editor),[],mode);
    assert.equal(editor.state.drag,null,mode);
    assert.equal(editor.state.layers[0].x,100,mode);
    assert.equal(editor.state.layers[1].x,300,mode);
    assert.equal(editor.state.undo.length,0,mode);
  }
});

test("複数選択のBackspace/Deleteは全対象を一度で削除し、Undo/Redoでも一回の操作となる",async () => {
  for(const key of ["Backspace","Delete"]){
    const editor=createEditor();
    editor.state.layers=[rectangleLayer(),rectangleLayer("rect-2",300,200),rectangleLayer("outside",700,500)];
    await selectRectangle(editor,[50,50],[450,300]);
    const event=await editor.document.dispatch("keydown",{target:editor.get("editCanvas"),key});
    assert.equal(event.prevented,true);
    assert.equal(editor.state.layers.length,1);
    assert.equal(editor.state.layers[0].id,"outside");
    assert.equal(editor.state.undo.length,1);
    assert.deepEqual(selectedIds(editor),[]);
    editor.undo();
    assert.equal(editor.state.layers.length,3);
    editor.redo();
    assert.equal(editor.state.layers.length,1);
  }
});

test("複数コピーは文字書式・図形・画像・ブラシ点を保持し、端の貼付でも相対位置と重なり順を保つ",async () => {
  const editor=createEditor();
  const originalImage=editor.get("layerCanvas");
  editor.state.layers=[{...textLayer(),x:850,y:150},rectangleLayer("rect-1",880,200),
    {id:"brush-1",type:"mosaicBrush",points:[{x:910,y:300},{x:930,y:320}],brushSize:20,mosaicSize:18,visible:true},
    {id:"image-1",type:"image",x:940,y:350,w:60,h:40,imageCanvas:originalImage,opacity:35,visible:true}];
  await selectRectangle(editor,[800,50],[1000,450]);
  assert.equal(selectedIds(editor).length,4);
  const data=clipboard();
  const copied=await editor.document.dispatch("copy",{target:editor.get("editCanvas"),clipboardData:data});
  assert.equal(copied.prevented,true);
  editor.state.layers[0].text="コピー後変更";
  const pasted=await editor.document.dispatch("paste",{target:editor.get("editCanvas"),clipboardData:data});
  assert.equal(pasted.prevented,true);
  assert.equal(editor.state.layers.length,8);
  assert.equal(editor.state.undo.length,1);
  assert.equal(selectedIds(editor).length,4);
  const originals=editor.state.layers.slice(0,4);
  const copies=editor.state.layers.slice(4);
  assert.deepEqual(copies.map(layer => layer.type),originals.map(layer => layer.type));
  const dx=copies[0].x-originals[0].x;
  const dy=copies[0].y-originals[0].y;
  assert.equal(dx,-24);
  for(let index=0;index<copies.length;index++){
    assert.notEqual(copies[index].id,originals[index].id);
    assert.equal(copies[index].x ?? copies[index].points[0].x,(originals[index].x ?? originals[index].points[0].x)+dx);
    assert.equal(copies[index].y ?? copies[index].points[0].y,(originals[index].y ?? originals[index].points[0].y)+dy);
  }
  assert.equal(copies[0].text,"もとの文字");
  assert.equal(copies[0].fontSize,42);
  assert.equal(copies[0].color,"#ff0000");
  assert.equal(copies[1].lineWidth,8);
  assert.equal(copies[2].mosaicSize,18);
  assert.notEqual(copies[2].points,originals[2].points);
  assert.notEqual(copies[2].points[0],originals[2].points[0]);
  assert.equal(copies[3].imageCanvas,originalImage);
  assert.equal(copies[3].opacity,35);
  editor.undo();
  assert.equal(editor.state.layers.length,4);
  editor.redo();
  assert.equal(editor.state.layers.length,8);
});

test("複数選択でも入力欄・文字編集中・IME変換中は通常の削除・コピー・貼付を優先する",async () => {
  for(const mode of ["input","textEditing","ime"]){
    const editor=createEditor();
    editor.state.layers=[textLayer(),rectangleLayer("rect-2",300,200)];
    await selectRectangle(editor,[50,50],[450,300]);
    const data=clipboard();
    await editor.document.dispatch("copy",{target:editor.get("editCanvas"),clipboardData:data});
    let target=editor.get("editCanvas");
    if(mode === "input"){
      target=editor.get("textEditor");
      target.focus();
    }
    if(mode === "textEditing") editor.state.textEditing="text-1";
    if(mode === "ime") editor.state.composing=true;
    for(const type of ["keydown","copy","paste"]){
      const event=await editor.document.dispatch(type,{target,key:"Delete",clipboardData:data});
      assert.equal(event.prevented,false,`${mode}: ${type}`);
    }
    assert.equal(editor.state.layers.length,2,mode);
    assert.equal(editor.state.undo.length,0,mode);
  }
});

test("未選択の設定カードを隠し、複数書式変更と文字のダブルクリック単一編集を切り替える",async () => {
  const editor=createEditor();
  editor.state.layers=[textLayer(),rectangleLayer("rect-2",300,200)];
  assert.equal(editor.get("contextPanel").classList.contains("hidden"),true);
  assert.equal(editor.get("contextTitle").textContent,"");
  await selectRectangle(editor,[50,50],[450,300]);
  editor.get("annotationColor").value="#0000ff";
  await editor.get("annotationColor").dispatch("input");
  assert.equal(editor.state.layers[0].color,"#0000ff");
  assert.equal(editor.state.layers[1].color,"#0000ff");
  assert.equal(editor.state.undo.length,1);
  await editor.get("editCanvas").dispatch("dblclick",{clientX:120,clientY:140});
  assert.deepEqual(selectedIds(editor),["text-1"]);
  assert.equal(editor.get("contextPanel").classList.contains("hidden"),false);
  assert.equal(editor.document.activeElement,editor.get("textEditor"));
  assert.equal(editor.state.layers.length,2);
  editor.setTool("pan");
  assert.equal(editor.get("contextPanel").classList.contains("hidden"),true);
  editor.setTool("rect");
  assert.equal(editor.get("contextPanel").classList.contains("hidden"),false);
  editor.setTool("select");
  assert.equal(editor.get("contextPanel").classList.contains("hidden"),true);
});

test("Canvasでの一括削除・Undo・トリミング・初期化で存在しない選択IDを残さない",async () => {
  const editor=createEditor(),canvas=editor.get("editCanvas");
  editor.state.layers=[rectangleLayer(),rectangleLayer("rect-2",300,200)];
  await selectRectangle(editor,[50,50],[450,300]);
  await editor.document.dispatch("keydown",{target:canvas,key:"Delete"});
  assert.deepEqual(selectedIds(editor),[]);assert.equal(editor.state.layers.length,0);
  editor.undo();assert.equal(editor.state.layers.length,2);assert.deepEqual(selectedIds(editor),[]);
  await selectRectangle(editor,[50,50],[450,300]);
  editor.trimLayersAfterCrop({x:50,y:50,w:200,h:150});
  assert.deepEqual(selectedIds(editor),["rect-1"]);assert.equal(editor.state.selectedLayerId,"rect-1");
  await editor.get("resetSingle").dispatch("click");
  assert.deepEqual(selectedIds(editor),[]);assert.equal(editor.state.layers.length,0);
});

test("混在する複数選択への書式変更は対象種類だけに適用され、一度でUndoできる",async () => {
  const editor=createEditor();
  const first=textLayer();
  const second={...textLayer(),id:"text-2",x:300,y:150,color:"#00ff00",fontSize:30,bold:false};
  const rect=rectangleLayer("rect-2",500,200);
  const image={id:"image-2",type:"image",x:700,y:100,w:80,h:60,imageCanvas:editor.get("layerCanvas"),opacity:70,visible:true};
  editor.state.layers=[first,second,rect,image];
  await selectRectangle(editor,[50,50],[820,350]);
  assert.equal(editor.get("fontSize").value,"");
  assert.equal(editor.get("fontSize").placeholder,"複数の値");
  assert.equal(editor.get("boldText").indeterminate,true);
  assert.equal(editor.get("textEditor").hidden,true);
  editor.get("fontSize").value="64";
  await editor.get("fontSize").dispatch("input");
  assert.equal(first.fontSize,64);
  assert.equal(second.fontSize,64);
  assert.equal(rect.fontSize,undefined);
  assert.equal(image.fontSize,undefined);
  assert.equal(first.color,"#ff0000");
  assert.equal(second.color,"#00ff00");
  assert.equal(second.bold,false);
  assert.equal(editor.state.undo.length,1);
  editor.undo();
  assert.equal(editor.state.layers[0].fontSize,42);
  assert.equal(editor.state.layers[1].fontSize,30);
  assert.equal(editor.state.layers[3].opacity,70);
});

test("混在する複数選択の色・白縁・塗りは対応する種類へだけ反映される",async () => {
  const editor=createEditor();
  const first=textLayer();
  const rect=rectangleLayer("rect-2",300,200);
  const arrow={id:"arrow-2",type:"arrow",x1:500,y1:100,x2:560,y2:180,color:"#00ff00",lineWidth:8,visible:true};
  const image={id:"image-2",type:"image",x:700,y:100,w:80,h:60,imageCanvas:editor.get("layerCanvas"),opacity:70,visible:true};
  editor.state.layers=[first,rect,arrow,image];
  await selectRectangle(editor,[50,50],[820,350]);
  editor.get("annotationColor").value="#123456";
  await editor.get("annotationColor").dispatch("input");
  assert.deepEqual([first.color,rect.color,arrow.color],["#123456","#123456","#123456"]);
  assert.equal(image.color,undefined);
  editor.get("whiteOutline").checked=true;
  await editor.get("whiteOutline").dispatch("change");
  assert.equal(first.outline,true);
  assert.equal(arrow.outline,true);
  assert.equal(rect.outline,true);
  editor.get("shapeFillNone").checked=false;
  await editor.get("shapeFillNone").dispatch("change");
  assert.equal(rect.fillNone,false);
  assert.equal(first.fillNone,undefined);
  assert.equal(image.fillNone,undefined);
});

test("フォント候補のinputプレビューは未確定で履歴を増やさずEsc・blurで元に戻る",async () => {
  const editor=createEditor();
  editor.state.layers=[textLayer()];
  await editor.get("editCanvas").dispatch("pointerdown",{clientX:120,clientY:140});
  await editor.get("editCanvas").dispatch("pointerup",{clientX:120,clientY:140});
  const field=editor.get("fontFamily");
  field.focus();
  field.value="ms-mincho";
  await field.dispatch("input");
  assert.equal(editor.state.layers[0].fontFamily,undefined);
  assert.equal(editor.state.undo.length,0);
  const escape=await field.dispatch("keydown",{key:"Escape"});
  assert.equal(escape.prevented,true);
  assert.equal(field.value,"yu-gothic-ui");
  field.value="arial";
  await field.dispatch("input");
  await field.dispatch("blur");
  assert.equal(field.value,"yu-gothic-ui");
  assert.equal(editor.state.undo.length,0);
  field.focus();
  field.value="ms-mincho";
  await field.dispatch("input");
  await field.dispatch("change");
  assert.equal(editor.state.layers[0].fontFamily,"ms-mincho");
  assert.equal(editor.state.undo.length,1);
  editor.undo();
  assert.equal(editor.state.layers[0].fontFamily,undefined);
});

test("複数行・塗り・太字と文字枠の幅をコピーしても設定は独立して保持する",async () => {
  const editor=createEditor();
  editor.state.layers=[{...textLayer(),textWidth:120}];
  await editor.get("editCanvas").dispatch("dblclick",{clientX:120,clientY:140});
  editor.get("textEditor").value="一行目\n二行目";
  await editor.get("textEditor").dispatch("input");
  await editor.get("textEditor").dispatch("blur");
  editor.get("boldText").checked=false;
  await editor.get("boldText").dispatch("change");
  editor.get("textBgTransparent").checked=false;
  await editor.get("textBgTransparent").dispatch("change");
  editor.get("textBgColor").value="#ffff00";
  await editor.get("textBgColor").dispatch("change");
  editor.get("editCanvas").focus();
  const data=clipboard();
  await editor.document.dispatch("copy",{target:editor.get("editCanvas"),clipboardData:data});
  await editor.document.dispatch("paste",{target:editor.get("editCanvas"),clipboardData:data});
  assert.equal(editor.state.layers.length,2);
  const copy=editor.state.layers[1];
  assert.equal(copy.text,"一行目\n二行目");
  assert.equal(copy.textWidth,120);
  assert.equal(copy.bold,false);
  assert.equal(copy.bgTransparent,false);
  assert.equal(copy.bgColor,"#ffff00");
  copy.text="別の文字";
  assert.equal(editor.state.layers[0].text,"一行目\n二行目");
});

test("Ctrl／Shiftで真円・正方形を作り、表示倍率が変わっても元画像座標で確定する",async () => {
  for(const tool of ["rect","ellipse"]){
    for(const modifier of ["ctrlKey","shiftKey"]){
      const editor=createEditor(),canvas=editor.get("editCanvas");
      canvas.getBoundingClientRect=() => ({left:50,top:30,width:2000,height:1400});
      editor.setTool(tool);
      await canvas.dispatch("pointerdown",{clientX:250,clientY:230,[modifier]:true});
      await canvas.dispatch("pointermove",{clientX:370,clientY:270,[modifier]:true});
      await canvas.dispatch("pointerup",{clientX:450,clientY:290,[modifier]:true});
      const layer=editor.state.layers[0];
      assert.equal(layer.type,tool);
      assert.deepEqual([layer.x,layer.y,layer.w,layer.h],[100,100,100,100]);
      assert.equal(editor.state.undo.length,1);
      assert.equal(canvas.captured.size,0);
      editor.undo();
      assert.equal(editor.state.layers.length,0);
      editor.redo();
      assert.deepEqual([editor.state.layers[0].w,editor.state.layers[0].h],[100,100]);
    }
  }
});

test("追加画像は一方向のハンドル縮小でも表示倍率によらず比率を保ち、取消とUndo／Redoに対応する",async () => {
  for(const scale of [.5,2]) for(const [dx,dy] of [[-50,0],[0,-25]]){
    const editor=createEditor(),canvas=editor.get("editCanvas");
    canvas.getBoundingClientRect=() => ({left:40,top:60,width:1000*scale,height:700*scale});
    const position=(x,y) => ({clientX:40+x*scale,clientY:60+y*scale});
    const bitmap=editor.document.createElement("canvas");
    const layer={id:"image-1",type:"image",imageCanvas:bitmap,x:20,y:30,w:100,h:50,opacity:100,visible:true};
    editor.state.layers=[layer];editor.selectLayers([layer]);
    await canvas.dispatch("pointerdown",position(120,80));
    assert.equal(editor.state.drag.mode,"resizeLayer");
    await canvas.dispatch("pointermove",position(120+dx,80+dy));
    assert.deepEqual([layer.w,layer.h],[50,25]);
    await canvas.dispatch("pointercancel");
    assert.deepEqual([layer.x,layer.y,layer.w,layer.h],[20,30,100,50]);
    assert.equal(editor.state.undo.length,0);
    assert.equal(editor.hasUnsavedChanges(),false);
    await canvas.dispatch("pointerdown",position(120,80));
    await canvas.dispatch("pointerup",position(120+dx,80+dy));
    assert.deepEqual([layer.x,layer.y,layer.w,layer.h],[20,30,50,25]);
    assert.equal(editor.state.undo.length,1);
    editor.undo();
    assert.deepEqual([editor.state.layers[0].w,editor.state.layers[0].h],[100,50]);
    editor.redo();
    assert.deepEqual([editor.state.layers[0].w,editor.state.layers[0].h],[50,25]);
    assert.equal(editor.state.layers[0].imageCanvas,bitmap);
  }
});

test("Ctrl／Shiftの図形リサイズは元の比率を保ち、最後のpointerup位置を反映する",async () => {
  for(const modifier of ["ctrlKey","shiftKey"]){
    const editor=createEditor(),canvas=editor.get("editCanvas");
    editor.state.layers=[rectangleLayer()];
    editor.state.selectedLayerId="rect-1";
    await canvas.dispatch("pointerdown",{clientX:180,clientY:160,[modifier]:true});
    await canvas.dispatch("pointermove",{clientX:240,clientY:190,[modifier]:true});
    await canvas.dispatch("pointerup",{clientX:260,clientY:280,[modifier]:true});
    assert.equal(editor.state.layers[0].w/editor.state.layers[0].h,80/60);
    assert.deepEqual([editor.state.layers[0].w,editor.state.layers[0].h],[240,180]);
    assert.equal(editor.state.undo.length,1);
    editor.undo();
    assert.deepEqual([editor.state.layers[0].w,editor.state.layers[0].h],[80,60]);
  }
});

function strokeLayer(type,points=[{x:100,y:100},{x:180,y:140},{x:200,y:160}],brushSize=20){
  return {id:"stroke",type,points:points.map(point => ({...point})),brushSize,mosaicSize:18,color:"#123456",visible:true};
}

function strokeBounds(layer){
  const box=require("../drawing-core.js").inkBounds(layer.points),pad=layer.brushSize/2;
  return {x:box.x-pad,y:box.y-pad,w:box.w+pad*2,h:box.h+pad*2};
}

function strokeGeometry(layer){
  return JSON.parse(JSON.stringify({points:layer.points,brushSize:layer.brushSize,color:layer.color,mosaicSize:layer.mosaicSize}));
}

test("Ctrl／Shiftのブラシ3種類のリサイズは拡大・縮小表示でも点と太さを同じ比率で変え、一度でUndo／Redoする",async () => {
  for(const type of ["blackoutBrush","mosaicBrush","ink"]){
    for(const modifier of ["ctrlKey","shiftKey"]){
      for(const scale of [.25,1,4]){
        const editor=createEditor(),canvas=editor.get("editCanvas"),layer=strokeLayer(type),bounds=strokeBounds(layer);
        const left=scale === 4 ? -150 : 50,top=scale === 4 ? -90 : 30;
        const original=strokeGeometry(layer),eventAt=(x,y) => ({clientX:left+x*scale,clientY:top+y*scale,[modifier]:true});
        canvas.getBoundingClientRect=() => ({left,top,width:1000*scale,height:700*scale});
        editor.state.layers=[layer];editor.selectLayers([layer]);
        await canvas.dispatch("pointerdown",eventAt(bounds.x+bounds.w,bounds.y+bounds.h));
        assert.equal(editor.state.drag.mode,"resizeLayer");
        await canvas.dispatch("pointermove",eventAt(bounds.x+bounds.w+40,bounds.y+bounds.h+10));
        await canvas.dispatch("pointerup",eventAt(bounds.x+bounds.w+120,bounds.y+bounds.h+40));
        const after=strokeBounds(layer);
        assert.deepEqual(after,{x:bounds.x,y:bounds.y,w:bounds.w*2,h:bounds.h*2},`${type}/${modifier}/${scale}`);
        assert.equal(layer.brushSize,40);assert.equal(layer.color,original.color);assert.equal(layer.mosaicSize,18);
        assert.deepEqual(Array.from(layer.points,point => [point.x,point.y]),[[110,110],[270,190],[310,230]]);
        assert.equal(editor.state.undo.length,1);assert.equal(editor.hasUnsavedChanges(),true);assert.equal(canvas.captured.size,0);
        const changed=strokeGeometry(layer);editor.undo();assert.deepEqual(strokeGeometry(editor.state.layers[0]),original);
        assert.equal(editor.hasUnsavedChanges(),false);editor.redo();assert.deepEqual(strokeGeometry(editor.state.layers[0]),changed);
      }
    }
  }
});

test("修飾キーを外したブラシのリサイズは点を自由な縦横比で変更する",async () => {
  for(const type of ["blackoutBrush","mosaicBrush","ink"]){
    for(const beginLocked of [false,true]){
      const editor=createEditor(),canvas=editor.get("editCanvas"),layer=strokeLayer(type);
      editor.state.layers=[layer];editor.selectLayers([layer]);
      await canvas.dispatch("pointerdown",{clientX:210,clientY:170,ctrlKey:beginLocked});
      await canvas.dispatch("pointermove",{clientX:250,clientY:180,ctrlKey:beginLocked});
      await canvas.dispatch("pointerup",{clientX:330,clientY:210});
      assert.deepEqual(Array.from(layer.points,point => [point.x,point.y]),[[110,105],[270,165],[310,195]]);
      assert.equal(layer.brushSize,40);assert.equal(editor.state.undo.length,1);
    }
  }
});

test("比率固定ブラシは太さの上限・下限と画像端で同一倍率を守り、水平線・垂直線・1点も崩さない",async () => {
  const cases=[
    {points:[{x:100,y:100},{x:200,y:160}],brushSize:20,end:[0,0],expected:.25},
    {points:[{x:250,y:250},{x:350,y:300}],brushSize:400,end:[1000,700],expected:1.25},
    {points:[{x:800,y:500},{x:900,y:600}],brushSize:20,end:[1000,700],expected:1.75},
    {points:[{x:100,y:100},{x:200,y:100}],brushSize:20,delta:[120,10],expected:2},
    {points:[{x:100,y:100},{x:100,y:200}],brushSize:20,delta:[10,120],expected:2},
    {points:[{x:100,y:100}],brushSize:20,delta:[20,10],expected:2},
    {points:[{x:-10,y:100},{x:90,y:150}],brushSize:20,delta:[120,35],expected:2}
  ];
  for(const type of ["blackoutBrush","mosaicBrush","ink"]){
    for(const entry of cases){
      const editor=createEditor(),canvas=editor.get("editCanvas"),layer=strokeLayer(type,entry.points,entry.brushSize),bounds=strokeBounds(layer);
      const start=[bounds.x+bounds.w,bounds.y+bounds.h],end=entry.end || start.map((value,i) => value+entry.delta[i]);
      editor.state.layers=[layer];editor.selectLayers([layer]);
      await canvas.dispatch("pointerdown",{clientX:start[0],clientY:start[1],shiftKey:true});
      assert.equal(editor.state.drag.mode,"resizeLayer");
      await canvas.dispatch("pointerup",{clientX:end[0],clientY:end[1],shiftKey:true});
      const changed=strokeBounds(layer);
      for(const property of ["x","y"]) assert.ok(Math.abs(changed[property]-bounds[property]) < 1e-8);
      for(const property of ["w","h"]) assert.ok(Math.abs(changed[property]-bounds[property]*entry.expected) < 1e-8,`${type}/${JSON.stringify(entry)}/${property}`);
      assert.equal(layer.brushSize,entry.brushSize*entry.expected);
      assert.ok(layer.brushSize >= 5 && layer.brushSize <= 500);
      assert.ok(changed.x+changed.w <= 1000+1e-8 && changed.y+changed.h <= 700+1e-8);
      assert.equal(editor.state.undo.length,1);
    }
  }
});

test("比率固定ブラシのキャンセルは点・太さ・Undo／Redo・未保存判定を復元し、Escapeで選択を解除する",async () => {
  for(const type of ["blackoutBrush","mosaicBrush","ink"]){
    for(const cancel of ["pointercancel","lostpointercapture","Escape"]){
      const editor=createEditor(),canvas=editor.get("editCanvas"),layer=strokeLayer(type),before=strokeGeometry(layer);
      editor.state.layers=[layer];editor.selectLayers([layer]);
      editor.state.redo=[{kind:"layers",layers:[],selectedLayerId:null,selectedLayerIds:[]}];
      const revision=editor.state.revision;
      await canvas.dispatch("pointerdown",{clientX:210,clientY:170,ctrlKey:true});
      await canvas.dispatch("pointermove",{clientX:330,clientY:210,ctrlKey:true});
      assert.equal(editor.state.undo.length,1);assert.equal(editor.hasUnsavedChanges(),true);
      if(cancel === "Escape") await editor.document.dispatch("keydown",{target:canvas,key:"Escape"});
      else await canvas.dispatch(cancel);
      assert.deepEqual(strokeGeometry(editor.state.layers[0]),before);assert.deepEqual(selectedIds(editor),cancel === "Escape" ? [] : ["stroke"]);
      assert.equal(editor.state.undo.length,0);assert.equal(editor.state.redo.length,1);assert.equal(editor.state.revision,revision);
      assert.equal(editor.state.drag,null);assert.equal(canvas.captured.size,0);assert.equal(editor.hasUnsavedChanges(),false);
    }
  }
});

test("直線・矢印はCtrlで水平／垂直になり、先端ハンドルはShiftで元角度を保つ",async () => {
  for(const tool of ["line","arrow"]){
    const editor=createEditor(),canvas=editor.get("editCanvas");
    editor.setTool(tool);
    await canvas.dispatch("pointerdown",{clientX:100,clientY:100,ctrlKey:true});
    await canvas.dispatch("pointerup",{clientX:300,clientY:150,ctrlKey:true});
    const layer=editor.state.layers[0];
    assert.deepEqual([layer.x1,layer.y1,layer.x2,layer.y2],[100,100,300,100]);
    layer.y2=200;
    editor.setTool("select");
    await canvas.dispatch("pointerdown",{clientX:300,clientY:200,shiftKey:true});
    assert.equal(editor.state.drag.mode,"resizeEndpoint");
    await canvas.dispatch("pointermove",{clientX:360,clientY:300,shiftKey:true});
    await canvas.dispatch("pointerup",{clientX:400,clientY:350,shiftKey:true});
    assert.equal((layer.y2-layer.y1)/(layer.x2-layer.x1),.5);
    assert.deepEqual([layer.x1,layer.y1],[100,100]);
    assert.equal(layer.lineWidth,8);
    assert.equal(editor.state.undo.length,2);
    editor.undo();
    assert.deepEqual([editor.state.layers[0].x2,editor.state.layers[0].y2],[300,200]);
  }
});

test("線の始点と終点は個別に編集し、Ctrlの軸固定とpointercancelの復元が使える",async () => {
  const editor=createEditor(),canvas=editor.get("editCanvas");
  editor.state.layers=[{id:"line-1",type:"line",x1:100,y1:100,x2:300,y2:200,color:"#f00",lineWidth:8,visible:true}];
  editor.state.selectedLayerId="line-1";
  await canvas.dispatch("pointerdown",{clientX:100,clientY:100});
  await canvas.dispatch("pointerup",{clientX:150,clientY:120,ctrlKey:true});
  assert.deepEqual([editor.state.layers[0].x1,editor.state.layers[0].y1],[150,200]);
  assert.deepEqual([editor.state.layers[0].x2,editor.state.layers[0].y2],[300,200]);
  const before=JSON.stringify(editor.state.layers),revision=editor.state.revision;
  await canvas.dispatch("pointerdown",{clientX:300,clientY:200});
  await canvas.dispatch("pointermove",{clientX:500,clientY:300});
  await canvas.dispatch("pointercancel");
  assert.equal(JSON.stringify(editor.state.layers),before);
  assert.equal(editor.state.revision,revision);
  assert.equal(editor.state.undo.length,1);
});

test("カラー手書きは補正・coalesced入力・最後の点を保存し、Undo／Redoは線単位になる",async () => {
  const editor=createEditor(),canvas=editor.get("editCanvas");
  editor.get("inkStabilizer").value="strong";
  editor.get("annotationColor").value="#00ff00";
  editor.setTool("ink");
  await canvas.dispatch("pointerdown",{clientX:100,clientY:100});
  await canvas.dispatch("pointermove",{clientX:150,clientY:100,
    getCoalescedEvents:() => [{clientX:120,clientY:100},{clientX:150,clientY:100}]});
  await canvas.dispatch("pointermove",{clientX:160,clientY:100,getCoalescedEvents:() => []});
  await canvas.dispatch("pointerup",{clientX:180,clientY:120});
  const layer=editor.state.layers[0];
  assert.equal(layer.type,"ink");
  assert.equal(layer.color,"#00ff00");
  assert.equal(layer.brushSize,50);
  assert.deepEqual(Array.from(layer.points,p => [p.x,p.y]),[[100,100],[114,100],[144,100],[154,100],[180,120]]);
  assert.equal(editor.state.undo.length,1);
  editor.undo();
  assert.equal(editor.state.layers.length,0);
  editor.redo();
  assert.equal(editor.state.layers[0].points.length,5);
});

test("手書き消しゴムは通過した表示中の手書きだけを線単位で消し、一度で取り消せる",async () => {
  const editor=createEditor(),canvas=editor.get("editCanvas");
  editor.state.layers=[
    {id:"ink-1",type:"ink",points:[{x:150,y:100},{x:150,y:200}],brushSize:10,color:"#f00",visible:true},
    {id:"ink-2",type:"ink",points:[{x:250,y:100},{x:250,y:200}],brushSize:10,color:"#00f",visible:true},
    {id:"hidden",type:"ink",points:[{x:200,y:100},{x:200,y:200}],brushSize:10,color:"#0f0",visible:false},
    {id:"secret",type:"blackoutBrush",points:[{x:210,y:100},{x:210,y:200}],brushSize:50,visible:true},rectangleLayer()];
  editor.setTool("inkEraser");
  await canvas.dispatch("pointerdown",{clientX:100,clientY:150});
  await canvas.dispatch("pointerup",{clientX:300,clientY:150});
  assert.deepEqual(editor.state.layers.map(layer => layer.id),["hidden","secret","rect-1"]);
  assert.equal(editor.state.undo.length,1);
  editor.undo();
  assert.deepEqual(editor.state.layers.map(layer => layer.id),["ink-1","ink-2","hidden","secret","rect-1"]);
  editor.redo();
  assert.equal(editor.state.layers.length,3);
});

test("手書き・秘匿ブラシ・消しゴムのキャンセルは線と履歴・revisionをすべて復元する",async () => {
  for(const tool of ["ink","blackoutBrush","mosaicBrush","inkEraser"]){
    const editor=createEditor(),canvas=editor.get("editCanvas");
    editor.state.layers=[{id:"ink-1",type:"ink",points:[{x:100,y:100},{x:200,y:100}],brushSize:10,color:"#f00",visible:true}];
    const before=JSON.stringify(editor.state.layers),revision=editor.state.revision;
    editor.state.redo=[{kind:"layers",layers:[],selectedLayerId:null,selectedLayerIds:[]}];
    editor.setTool(tool);
    await canvas.dispatch("pointerdown",{clientX:120,clientY:100});
    await canvas.dispatch("pointermove",{clientX:160,clientY:120});
    await canvas.dispatch("lostpointercapture");
    assert.equal(editor.state.layers.length,1,tool);
    assert.equal(JSON.stringify(editor.state.layers),before,tool);
    assert.equal(editor.state.undo.length,0,tool);
    assert.equal(editor.state.redo.length,1,tool);
    assert.equal(editor.state.revision,revision,tool);
    assert.equal(canvas.captured.size,0,tool);
  }
});

test("別ポインターで手書きや作図を変更せず、ツール切替時の未確定線も残さない",async () => {
  const editor=createEditor(),canvas=editor.get("editCanvas");
  editor.setTool("ink");
  await canvas.dispatch("pointerdown",{clientX:100,clientY:100});
  await canvas.dispatch("pointerdown",{pointerId:2,isPrimary:false,clientX:200,clientY:200});
  await canvas.dispatch("pointermove",{pointerId:2,clientX:200,clientY:200});
  await canvas.dispatch("pointerup",{pointerId:2,clientX:200,clientY:200});
  assert.equal(editor.state.layers[0].points.length,1);
  assert.ok(editor.state.drag);
  editor.setTool("rect");
  assert.equal(editor.state.layers.length,0);
  assert.equal(editor.state.undo.length,0);
  await canvas.dispatch("pointerdown",{clientX:100,clientY:100,ctrlKey:true});
  await canvas.dispatch("pointermove",{clientX:200,clientY:150,ctrlKey:true});
  await canvas.dispatch("pointercancel");
  assert.equal(editor.state.layers.length,0);
});

test("画像の回転・反転・リサイズは直線と手書きの元画像座標・太さへ反映する",async () => {
  const editor=createEditor();
  editor.state.layers=[
    {id:"line-1",type:"line",x1:100,y1:100,x2:300,y2:200,color:"#f00",lineWidth:8,visible:true},
    {id:"ink-1",type:"ink",points:[{x:50,y:100},{x:80,y:120}],brushSize:10,color:"#00f",visible:true}];
  await editor.get("rotateRight").dispatch("click");
  assert.deepEqual([editor.state.layers[0].x1,editor.state.layers[0].y1,editor.state.layers[0].x2,editor.state.layers[0].y2],[600,100,500,300]);
  assert.deepEqual(Array.from(editor.state.layers[1].points,p => [p.x,p.y]),[[600,50],[580,80]]);
  await editor.get("flipH").dispatch("click");
  assert.deepEqual([editor.state.layers[0].x1,editor.state.layers[0].x2],[100,200]);
  editor.get("resizeW").value="350";
  editor.get("resizeH").value="500";
  await editor.get("applyResize").dispatch("click");
  assert.deepEqual([editor.state.layers[0].x1,editor.state.layers[0].y1,editor.state.layers[0].x2,editor.state.layers[0].y2],[50,50,100,150]);
  assert.equal(editor.state.layers[0].lineWidth,4);
  assert.equal(editor.state.layers[1].brushSize,5);
});

test("ズーム・スクロール後の手書きは画像座標で描画・選択・移動・コピーできる",async () => {
  const editor=createEditor(),canvas=editor.get("editCanvas");
  canvas.getBoundingClientRect=() => ({left:-100,top:-250,width:4000,height:2800});
  editor.setTool("ink");
  await canvas.dispatch("pointerdown",{clientX:300,clientY:150});
  await canvas.dispatch("pointerup",{clientX:700,clientY:150});
  assert.deepEqual(Array.from(editor.state.layers[0].points,p => [p.x,p.y]),[[100,100],[200,100]]);
  editor.setTool("select");
  await canvas.dispatch("pointerdown",{clientX:500,clientY:150});
  await canvas.dispatch("pointerup",{clientX:700,clientY:230});
  assert.deepEqual(Array.from(editor.state.layers[0].points,p => [p.x,p.y]),[[150,120],[250,120]]);
  const data=clipboard();
  await editor.document.dispatch("copy",{target:canvas,clipboardData:data});
  await editor.document.dispatch("paste",{target:canvas,clipboardData:data});
  assert.equal(editor.state.layers.length,2);
  assert.deepEqual(Array.from(editor.state.layers[1].points,p => [p.x,p.y]),[[174,144],[274,144]]);
  editor.state.layers[1].points[0].x=500;
  assert.equal(editor.state.layers[0].points[0].x,150);
});

test("手書きは一線8192点と画像全体200000点の上限を守り、確定後も編集を続けられる",async () => {
  const editor=createEditor(),canvas=editor.get("editCanvas");
  editor.setTool("ink");
  await canvas.dispatch("pointerdown",{clientX:100,clientY:100});
  const samples=Array.from({length:8300},(_,i) => ({clientX:i%2 ? 150 : 100,clientY:100}));
  await canvas.dispatch("pointermove",{clientX:150,clientY:100,getCoalescedEvents:() => samples});
  await canvas.dispatch("pointerup",{clientX:200,clientY:100});
  assert.equal(editor.state.layers[0].points.length,8192);
  assert.equal(editor.state.drag,null);
  await canvas.dispatch("pointerdown",{clientX:200,clientY:200});
  await canvas.dispatch("pointerup",{clientX:250,clientY:200});
  assert.equal(editor.state.layers.length,2);
  editor.state.layers=[{id:"full",type:"ink",points:Array.from({length:200000},() => ({x:100,y:100})),brushSize:5,color:"#f00",visible:false}];
  const revision=editor.state.revision,undoLength=editor.state.undo.length;
  await canvas.dispatch("pointerdown",{clientX:300,clientY:300});
  await canvas.dispatch("pointerup",{clientX:350,clientY:300});
  assert.equal(editor.state.layers.length,1);
  assert.equal(editor.state.drag,null);
  assert.equal(editor.state.undo.length,undoLength);
  assert.equal(editor.state.revision,revision);
  assert.equal(canvas.captured.size,0);
});
