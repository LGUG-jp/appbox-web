const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const modulePromise = import("../image-insertion.mjs");
const corePromise = import("../editor-core.mjs");
const source = fs.readFileSync(path.join(__dirname, "../app.js"), "utf8");
const section = (from, to) => source.slice(source.indexOf(from), source.indexOf(to));
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAQAAAABCAYAAAD5PA/NAAAAGUlEQVR4nGNgYGBg+P//fwMDA8P//wwMDgAupwW8KZ3epgAAAABJRU5ErkJggg==", "base64");

test("画像形式と寸法を拡張子によらず判定し、デコード前に過大画像を拒否する", async () => {
  const { imageMetadata } = await modulePromise;
  assert.deepEqual(imageMetadata(png), { mime: "image/png", width: 4, height: 1 });
  // SOI, APP segment, baseline SOF (two pixels by three pixels).
  const jpg = Buffer.from([255,216,255,224,0,4,0,0,255,192,0,11,8,0,3,0,2,1,1,17,0,255,217]);
  assert.deepEqual(imageMetadata(jpg), { mime: "image/jpeg", width: 2, height: 3 });
  for (const data of [Buffer.from("<svg></svg>"), png.subarray(0, 20), jpg.subarray(0, 14)])
    assert.throws(() => imageMetadata(data));
  for (const [w,h] of [[0,1], [8193,1], [5000,5000]]) {
    const large = Buffer.from(png); large.writeUInt32BE(w,16); large.writeUInt32BE(h,20);
    assert.throws(() => imageMetadata(large));
  }
});

test("画像は縦横比を保ってページ中央に収まり、拡大しすぎない", async () => {
  const { initialImageBox } = await modulePromise;
  for (const [w,h] of [[4000,2000],[100,5000],[4,1]]) {
    const b = initialImageBox(w,h,{width:595,height:842});
    assert.ok(Math.abs(b.w/b.h-w/h)<1e-10);
    assert.ok(b.w<=595*.6 && b.h<=842*.6 && b.w<=w);
    assert.equal(b.x+b.w/2,595/2); assert.equal(b.y+b.h/2,842/2);
  }
});

test("ページ回転は画像の向きと矩形を追随させ、4回転で元に戻る", async () => {
  const { rotateAnnotation, bounds } = await corePromise;
  const { imagePlacement } = await modulePromise;
  const a={type:"image",imageId:"asset",x:10,y:20,w:100,h:50,rotation:0};
  const original=structuredClone(a); let size={width:595,height:842};
  for(let i=1;i<=4;i++) {
    rotateAnnotation(a,size,90); size={width:size.height,height:size.width};
    const p=imagePlacement(a,size.height);
    assert.equal(p.rotation,(i*90)%360);
    assert.equal(p.width,100); assert.equal(p.height,50);
    const radians=-p.rotation*Math.PI/180;
    const corners=[[0,0],[p.width,0],[0,p.height],[p.width,p.height]].map(([x,y])=>({
      x:p.x+x*Math.cos(radians)-y*Math.sin(radians),
      y:p.y+x*Math.sin(radians)+y*Math.cos(radians),
    }));
    assert.ok(Math.abs(Math.min(...corners.map(c=>c.x))-a.x)<1e-8);
    assert.ok(Math.abs(Math.min(...corners.map(c=>c.y))-(size.height-a.y-a.h))<1e-8);
    assert.ok(bounds(a).x>=0 && bounds(a).y>=0);
  }
  assert.deepEqual(a,original);
  rotateAnnotation(a,size,-90); assert.equal(a.rotation,270);
});

test("Undo／Redoとコピーから参照される画像だけを保持する", async () => {
  const { referencedImageIds } = await modulePromise;
  const page=id=>({annotations:[{type:"image",imageId:id}]});
  assert.deepEqual([...referencedImageIds([page("now")],[{pages:[page("undo")]}],
    [{pages:[page("redo")]}],[{type:"image",imageId:"copy"}])], ["now","undo","redo","copy"]);
  const state={pages:[page("now")],history:[{pages:[page("undo")]}],future:[],clipboard:[],
    images:new Map(["now","undo","orphan"].map(id=>[id,{url:`blob:${id}`}]))};
  const revoked=[];
  const ctx=vm.createContext({state,referencedImageIds,URL:{revokeObjectURL:url=>revoked.push(url)}});
  vm.runInContext(section("function releaseUnusedImages()", "async function decodeInsertionImage("),ctx);
  vm.runInContext("releaseUnusedImages()",ctx);
  assert.deepEqual(revoked,["blob:orphan"]); assert.equal(state.images.size,2);
});

test("PDF貼り付けは初期画面のファイルだけを既存の読込み処理へ渡す", async () => {
  const { clipboardFiles }=await modulePromise;
  const pdf={name:"test.pdf",type:"application/pdf"};
  assert.deepEqual(clipboardFiles({files:[pdf],items:[{kind:"file",getAsFile:()=>pdf}]}),[pdf]);
  assert.deepEqual(clipboardFiles({files:[],items:[{kind:"string"},{kind:"file",getAsFile:()=>pdf}]}),[pdf]);
  assert.deepEqual(clipboardFiles({items:[{kind:"file",getAsFile:()=>null}]}),[]);
  const state={busy:false,pages:[]},calls=[];
  const ctx=vm.createContext({state,clipboardFiles,isTextEditingTarget:t=>t.editable,
    readPdfFiles:files=>calls.push(files)});
  vm.runInContext(section("function handleInitialPdfPaste(","let imageTargetPageId"),ctx);
  let prevented=0;
  const emit=data=>ctx.handleInitialPdfPaste({target:{},clipboardData:data,preventDefault(){prevented++;}});
  emit({files:[pdf]}); assert.equal(calls.length,1); assert.equal(prevented,1);
  state.busy=true;emit({files:[pdf]});state.busy=false;
  state.pages=[{}];emit({files:[pdf]});state.pages=[];
  emit({files:[],items:[{kind:"string"}]});
  ctx.handleInitialPdfPaste({target:{editable:true},clipboardData:{files:[pdf]}});
  assert.equal(calls.length,1); assert.equal(prevented,1);
});

test("個別編集の画像貼り付けは図形より優先し、ファイルなしでは図形を貼り付ける", async () => {
  const { clipboardFiles }=await modulePromise;
  const state={busy:false,mode:"edit",pages:[{id:"p"}],clipboard:[{type:"rect"}]};
  const calls=[],toasts=[];
  const ctx=vm.createContext({state,clipboardFiles,currentPage:()=>state.pages[0],
    isTextEditingTarget:target=>target.editable,
    insertImage:(file,id)=>calls.push({file,id}),pasteFigures:()=>calls.push("figures"),
    showToast:message=>toasts.push(message)});
  vm.runInContext(section("function handleEditorPaste(","let imageTargetPageId"),ctx);
  let prevented=0;
  const image={name:"clipboard.png",type:"image/png"};
  const emit=(files,target={})=>ctx.handleEditorPaste({target,clipboardData:{files},preventDefault(){prevented++;}});
  emit([image]);assert.equal(calls.length,1);assert.equal(calls[0].file,image);assert.equal(calls[0].id,"p");
  emit([]);assert.equal(calls[1],"figures");
  emit([image,image]);assert.equal(calls.length,2);assert.equal(toasts.length,1);
  emit([image],{editable:true});state.busy=true;emit([image]);state.busy=false;
  state.mode="overview";emit([image]);state.mode="edit";state.pages=[];emit([image]);
  assert.equal(calls.length,2);assert.equal(prevented,3);
  state.pages=[{id:"p"}];state.clipboard=[];emit([]);assert.equal(prevented,3);
});

test("Ctrl＋Vのkeydownはネイティブpasteイベントを妨げない", () => {
  const state={busy:false,mode:"edit",pages:[{id:"p"}],clipboard:[{type:"rect"}]};
  const listeners=[];
  const ctx=vm.createContext({state,isTextEditingTarget:()=>false,
    document:{addEventListener:(type,fn)=>listeners.push(fn)}});
  const start=source.indexOf('  document.addEventListener("keydown", (e) => {\n    if (state.busy || isTextEditingTarget');
  vm.runInContext(source.slice(start,source.indexOf("\n}\n\nfunction releaseUnusedImages()",start)),ctx);
  let prevented=false;
  listeners[0]({key:"v",ctrlKey:true,target:{},preventDefault(){prevented=true;}});
  assert.equal(prevented,false);
});

test("図形のCtrl＋Cは古いOS画像を案内文字列に置き換え、図形データはアプリ内だけで保持する", () => {
  const state={busy:false,mode:"edit"};let copies=0,prevented=0;const data=[];
  const ctx=vm.createContext({state,isTextEditingTarget:target=>target.editable,
    selectedFigures:()=>[{type:"rect"}],copyFigures:()=>copies++});
  vm.runInContext(section("function handleFigureCopy(","function handleEditorPaste("),ctx);
  const event={target:{},clipboardData:{setData:(...args)=>data.push(args)},preventDefault(){prevented++;}};
  ctx.handleFigureCopy(event);
  assert.equal(copies,1);assert.equal(prevented,1);assert.equal(data.length,1);
  assert.equal(data[0][0],"text/plain");assert.equal(data[0][1],"AppBox: コピーした図形（このアプリ内のみ）");
  ctx.handleFigureCopy({...event,target:{editable:true}});state.busy=true;ctx.handleFigureCopy(event);
  assert.equal(copies,1);assert.equal(prevented,1);
});

test("メニューで図形コピー→Ctrl＋Vは古いOS画像ではなく図形を貼り付ける", async () => {
  const { clipboardFiles }=await modulePromise;
  const image={name:"old.png",type:"image/png"},figure={id:"rect",type:"rect"};
  const state={busy:false,mode:"edit",clipboard:[]},calls=[];
  const clipboard={files:[image],setData(type,text){
    assert.equal(type,"text/plain");assert.equal(text,"AppBox: コピーした図形（このアプリ内のみ）");
    this.files=[];
  }};
  const ctx=vm.createContext({state,clipboardFiles,clone:v=>JSON.parse(JSON.stringify(v)),
    selectedFigures:()=>[figure],finishTextEditing(){},releaseUnusedImages(){},syncToolProperties(){},showToast(){},
    currentPage:()=>({id:"page"}),isTextEditingTarget:()=>false,
    insertImage:()=>calls.push("image"),pasteFigures:()=>calls.push("figures")});
  ctx.document={execCommand(command){
    assert.equal(command,"copy");ctx.handleFigureCopy({target:{},clipboardData:clipboard,preventDefault(){}});
    return true;
  }};
  vm.runInContext(section("function copyFigures()","function pasteFigures()"),ctx);
  vm.runInContext(section("let nativeFigureCopyHandled", "let imageTargetPageId"),ctx);
  ctx.copyFiguresFromMenu();
  assert.deepEqual(JSON.parse(JSON.stringify(state.clipboard)),[figure]);
  ctx.handleEditorPaste({target:{},clipboardData:clipboard,preventDefault(){}});
  assert.deepEqual(calls,["figures"]);
  // A subsequent screenshot must take priority, even without a window/tab switch.
  clipboard.files=[image];ctx.handleEditorPaste({target:{},clipboardData:clipboard,preventDefault(){}});
  assert.deepEqual(calls,["figures","image"]);
});

test("メニューコピーが拒否された場合は成功扱いにせずCtrl＋Cを案内する", () => {
  for(const throws of [false,true]) {
    const state={busy:false,mode:"edit",clipboard:[]},toasts=[];
    const ctx=vm.createContext({state,selectedFigures:()=>[{type:"rect"}],
      document:{execCommand(){if(throws)throw Error("blocked");return false;}},
      showToast:(message,error)=>toasts.push({message,error})});
    vm.runInContext(section("let nativeFigureCopyHandled", "function handleEditorPaste("),ctx);
    ctx.copyFiguresFromMenu();
    assert.equal(state.clipboard.length,0);assert.equal(toasts.length,1);
    assert.match(toasts[0].message,/Ctrl＋C/);assert.equal(toasts[0].error,true);
  }
});

test("画像挿入の成功は1履歴、読込み失敗は図形・履歴を変更しない", async () => {
  const mod=await modulePromise;
  for(const fail of [false,true]) {
    const page={id:"p",annotations:[]},history=[],toasts=[];
    const state={busy:false,mode:"edit",images:new Map(),pages:[page],history,future:[],clipboard:[]};
    const ctx=vm.createContext({...mod,state,Blob,URL:{createObjectURL:()=>"blob:test"},
      currentPage:()=>page,finishTextEditing(){},setBusy:on=>state.busy=on,
      decodeInsertionImage:async()=>{if(fail)throw Error("broken");return{bytes:png,mime:"image/png",width:4,height:1};},
      releaseUnusedImages(){},uid:()=>"id",pageDisplaySize:()=>({width:595,height:842}),
      snapshot:()=>structuredClone(page),pushHistory:before=>history.push(before),
      els:{layer:{classList:{remove(){}}}},syncToolButtons(){},renderAnnotations(){},
      updateThumbnailAnnotationMarker(){},showToast:(message,error)=>toasts.push({message,error}),
      $:()=>({focus(){}})});
    vm.runInContext(section("async function insertImage(","function moveImageByKey("),ctx);
    await ctx.insertImage({name:"test.png"},"p");
    assert.equal(state.busy,false); assert.equal(history.length,fail?0:1);
    assert.equal(page.annotations.length,fail?0:1); assert.equal(state.images.size,fail?0:1);
    if(!fail)assert.equal(history[0].annotations.length,0);
    else assert.equal(toasts[0].error,true);
  }
});

test("画像読込みは容量を先に検証し、デコード失敗・成功とも一時URLを解放する", async () => {
  const mod=await modulePromise;
  for(const fail of [false,true]) {
    const revoked=[],canvas={width:0,height:0,getContext:()=>({drawImage(){}}),
      toBlob:fn=>fn(new Blob([png],{type:"image/png"}))};
    class Image { naturalWidth=4; naturalHeight=1; async decode(){if(fail)throw Error("decode");} }
    const ctx=vm.createContext({...mod,Uint8Array,Blob,Image,document:{createElement:()=>canvas},
      URL:{createObjectURL:()=>"blob:temporary",revokeObjectURL:url=>revoked.push(url)}});
    vm.runInContext(section("async function decodeInsertionImage(","async function insertImage("),ctx);
    await assert.rejects(ctx.decodeInsertionImage({size:mod.MAX_IMAGE_BYTES+1}));
    assert.equal(revoked.length,0);
    const pending=ctx.decodeInsertionImage({size:png.length,arrayBuffer:async()=>png});
    if(fail)await assert.rejects(pending);else assert.equal((await pending).mime,"image/png");
    assert.deepEqual(revoked,["blob:temporary"]);assert.equal(canvas.width,0);assert.equal(canvas.height,0);
  }
});

test("画像のキーボード移動・リサイズはページ内の比率と履歴を保つ", async () => {
  const core=await corePromise,history=[];
  const a={id:"a",type:"image",x:10,y:20,w:100,h:50};
  const state={busy:false,figureSelection:new Set(),tool:"select"};
  const ctx=vm.createContext({...core,state,CSS:{escape:id=>id},
    currentPage:()=>({id:"p"}),pageDisplaySize:()=>({width:200,height:100}),
    pushHistory:()=>history.push(structuredClone(a)),renderAnnotations(){},updateThumbnailAnnotationMarker(){},
    els:{layer:{querySelector:()=>({focus(){}})}}});
  vm.runInContext(section("function moveImageByKey(","function handleInitialPdfPaste("),ctx);
  const event=key=>({key,preventDefault(){},stopPropagation(){}});
  ctx.moveImageByKey(event("ArrowRight"),a);assert.equal(a.x,11);assert.equal(history.length,1);
  ctx.resizeImageByKey(event("ArrowDown"),a);
  assert.equal(a.w/a.h,2);assert.ok(a.x+a.w<=200 && a.y+a.h<=100);
  assert.equal(history.length,2);
  state.busy=true;ctx.moveImageByKey(event("ArrowRight"),a);ctx.resizeImageByKey(event("ArrowDown"),a);
  assert.equal(history.length,2);
});

test("画像の描画は操作グループ内に名前とフォーカス可能なリサイズボタンを保持する", async () => {
  const { imagePlacement } = await modulePromise;
  const { bounds } = await corePromise;
  const node = (tag, attrs = {}) => ({
    tag, attrs, style: {}, dataset: {}, children: [], listeners: {},
    classList: { add() {} },
    append(child) { this.children.push(child); },
    replaceChildren() { this.children = []; },
    addEventListener(type, handler) { this.listeners[type] = handler; },
  });
  const image = { id: "a", type: "image", imageId: "asset", x: 10, y: 20, w: 100, h: 50 };
  const layer = node("layer"), calls = [];
  let selected = false;
  const ctx = vm.createContext({
    state: { tool: "select", viewScale: 1, images: new Map([["asset", { url: "blob:image" }]]) },
    els: { layer }, currentPage: () => ({ annotations: [image] }),
    selectedFigures: () => selected ? [image] : [], bounds, imagePlacement,
    svgNode: node, document: { createElement: node }, isLine: () => false,
    resolvedPageNumber: () => null, syncToolProperties() {},
    moveImageByKey: (event, figure) => calls.push(["move", event, figure]),
    resizeImageByKey: (event, figure) => calls.push(["resize", event, figure]),
  });
  vm.runInContext(section("function renderFigures()", "let lastFigurePress"), ctx);
  for (selected of [false, true]) {
    ctx.renderFigures();
    const group = layer.children[0];
    assert.equal(group.attrs.role, "group");
    assert.equal(group.attrs.tabindex, 0);
    assert.match(group.attrs["aria-label"], /挿入画像/);
    assert.equal(group.children[0].tag, "image");
    assert.equal(group.children[0].attrs.href, "blob:image");
    assert.equal(group.children.length, selected ? 2 : 1);
    if (selected) {
      const handle = group.children[1];
      assert.equal(handle.attrs.role, "button");
      assert.equal(handle.attrs.tabindex, 0);
      assert.match(handle.attrs["aria-label"], /画像のサイズ変更/);
      const event = { key: "ArrowRight" };
      group.listeners.keydown(event);
      handle.listeners.keydown(event);
      assert.deepEqual(calls, [["move", event, image], ["resize", event, image]]);
    }
  }
});

test("JPEGはJPEG埋め込み経路で出力し、同一画像をページ間で共用する", async () => {
  const { imagePlacement }=await modulePromise;let embedded=0;const calls=[];
  const state={images:new Map([["jpg",{bytes:Buffer.from([255,216]),mime:"image/jpeg"}]])};
  const ctx=vm.createContext({state,imagePlacement,degrees:value=>value,embeddedImages:new WeakMap(),resolvedPageNumber:()=>null});
  vm.runInContext(section("async function drawAnnotationsOnPdf(","async function exportPdf("),ctx);
  const output={embedJpg:async()=>{embedded++;return "jpg";},embedPng:async()=>{throw Error("wrong format");}};
  const a={type:"image",imageId:"jpg",x:10,y:20,w:100,h:50};
  for(let i=0;i<2;i++)await ctx.drawAnnotationsOnPdf(output,{drawImage:(...args)=>calls.push(args)},{annotations:[a]},842);
  assert.equal(embedded,1);assert.equal(calls.length,2);assert.equal(calls[0][1].y,772);
});

test("画像のPDF出力は透過を維持して埋め込みを共用し、保存後に再読込みできる", async () => {
  const { PDFDocument,PDFName,decodePDFRawStream,degrees }=await import("../vendor/pdf-lib.esm.js");
  const { imagePlacement }=await modulePromise;
  const doc=await PDFDocument.create(),state={images:new Map([["asset",{bytes:png,mime:"image/png"}]])};
  const ctx=vm.createContext({state,imagePlacement,degrees,embeddedImages:new WeakMap(),resolvedPageNumber:()=>null});
  vm.runInContext(section("async function drawAnnotationsOnPdf(", "async function exportPdf("),ctx);
  for(const rotation of [0,90,180,270]) {
    const page=doc.addPage([595,842]);
    const a={type:"image",imageId:"asset",x:10,y:20,w:rotation%180?25:100,h:rotation%180?100:25,rotation};
    await ctx.drawAnnotationsOnPdf(doc,page,{annotations:[a]},842);
  }
  const reopened=await PDFDocument.load(await doc.save()); assert.equal(reopened.getPageCount(),4);
  const refs=reopened.getPages().map(p=>p.node.Resources().lookup(PDFName.of("XObject")).values()[0]);
  assert.equal(new Set(refs.map(String)).size,1);
  const image=reopened.context.lookup(refs[0]);
  const mask=reopened.context.lookup(image.dict.get(PDFName.of("SMask")));
  assert.deepEqual([...decodePDFRawStream(mask).decode()],[0,128,255,64]);
});
