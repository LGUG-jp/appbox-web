const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.resolve(__dirname,"../image.js"),"utf8");

function extractFunction(name){
  const match = new RegExp(`(?:async )?function ${name}\\(`).exec(source);
  assert.ok(match,`${name} exists`);
  let parameterEnd = source.indexOf("(",match.index);
  let parameterDepth = 0;
  for(;parameterEnd<source.length;parameterEnd++){
    if(source[parameterEnd] === "(") parameterDepth++;
    if(source[parameterEnd] === ")" && --parameterDepth === 0) break;
  }
  const opening = source.indexOf("{",parameterEnd);
  let depth = 0;
  for(let index=opening;index<source.length;index++){
    if(source[index] === "{") depth++;
    if(source[index] === "}" && --depth === 0){
      return source.slice(match.index,index+1);
    }
  }
  throw new Error(`Missing end of ${name}`);
}

function mockCanvas(width=0,height=0){
  const calls = [];
  const stack = [];
  const context = {globalAlpha:1,fillStyle:""};
  for(const name of ["drawImage","clearRect","fillRect","translate","scale","rotate"]){
    context[name] = (...args) => calls.push({name,args,alpha:context.globalAlpha,fill:context.fillStyle});
  }
  context.save = () => stack.push({globalAlpha:context.globalAlpha,fillStyle:context.fillStyle});
  context.restore = () => Object.assign(context,stack.pop());
  return {width,height,calls,getContext:() => context,focus:() => {}};
}

function harness(names){
  const elements = new Map();
  const baseCanvas = mockCanvas(600,400);
  const histories = [];
  const statuses = [];
  const messages = [];
  const createdCanvases = [];
  const syncs = [];
  let nextId = 1;
  const $ = id => {
    if(!elements.has(id)){
      elements.set(id,{
        value:"",checked:false,disabled:false,textContent:"",
        classList:{add(){},remove(){},toggle(){}},querySelectorAll:() => []
      });
    }
    return elements.get(id);
  };
  const sandbox = {
    drawing:require("../drawing-core.js"),annotationStyle:require("../annotation-style.js"),
    MAX_DIMENSION:8192,MAX_PIXELS:36000000,MAX_FILE_BYTES:25*1024*1024,
    RECT_TYPES:["blackoutRect","mosaicRect","rect","ellipse"],
    BRUSH_TYPES:["blackoutBrush","mosaicBrush"],
    SUPPORTED_TYPES:["image/jpeg","image/png","image/webp"],
    isFiniteInteger:Number.isSafeInteger,
    clamp:(value,min,max) => Math.min(max,Math.max(min,value)),
    baseCanvas,baseContext:baseCanvas.getContext("2d"),editCanvas:mockCanvas(),layerContext:null,editContext:null,
    state:{originalCanvas:mockCanvas(600,400),layers:[],loadVersion:1,baseRevision:1,singleBusy:false,drag:null,crop:null},
    viewState:{mode:"fit",pan:null},canvasViewport:$("canvasViewport"),
    document:{createElement:() => {const canvas=mockCanvas();createdCanvases.push(canvas);return canvas;}},
    $,presets:{web:{format:"image/webp",longEdge:1600,target:true,kb:500}},
    singleSavePreset:null,
    makeId:() => `image-${nextId++}`,
    pushHistory:kind => histories.push({kind,width:baseCanvas.width,height:baseCanvas.height,layers:sandbox.cloneLayers(sandbox.state.layers)}),
    invalidateBaseCaches:() => sandbox.state.baseRevision++,
    syncCanvas(){syncs.push({width:baseCanvas.width,height:baseCanvas.height,mode:sandbox.viewState.mode});},updateSelectedControls(){},updateSingleFormatUI(){},finishTextEditing(){},syncEditorChrome(){},syncModeControls(){},
    setTool:tool => {sandbox.state.tool = tool;},
    setSingleStatus:(message,type) => statuses.push({message,type}),
    toast:message => messages.push(message),
    decodeImage:async () => ({width:1200,height:600,close(){}})
  };
  const definitions = [...new Set([
    "validateDimensions","createCanvas","cloneCanvas","cloneLayers","isSupportedImage",
    "selectedLayers","selectLayers",...names
  ])].map(extractFunction).join("\n");
  vm.createContext(sandbox);
  vm.runInContext(definitions,sandbox);
  return {sandbox,elements,baseCanvas,histories,statuses,messages,createdCanvases,syncs,$};
}

function imageLayer(overrides={}){
  return {id:"image-original",type:"image",imageCanvas:mockCanvas(100,50),
    x:20,y:30,w:100,h:50,opacity:100,visible:true,...overrides};
}

test("画像の複製は変更しないbitmapを共有し、座標とブラシ点は独立する",() => {
  const {sandbox} = harness([]);
  const image = imageLayer();
  const brush = {type:"blackoutBrush",points:[{x:3,y:4}]};
  const cloned = sandbox.cloneLayers([image,brush]);
  assert.equal(cloned[0].imageCanvas,image.imageCanvas);
  assert.notEqual(cloned[0],image);
  cloned[0].x += 20;
  cloned[1].points[0].x += 20;
  assert.equal(image.x,20);
  assert.equal(brush.points[0].x,3);
});

test("画像追加は縦横比と透過bitmapを保ち、canvasに収めて独立layerを作る",async () => {
  const {sandbox,histories} = harness(["addImageLayer"]);
  await sandbox.addImageLayer({name:"stamp.png",type:"image/png",size:100});
  const layer = sandbox.state.layers[0];
  assert.equal(layer.type,"image");
  assert.equal(layer.opacity,100);
  assert.equal(layer.w,600);
  assert.equal(layer.h,300);
  assert.equal(layer.x,0);
  assert.equal(layer.y,50);
  assert.equal(layer.imageCanvas.width,1200);
  assert.equal(layer.imageCanvas.calls.some(call => call.name === "fillRect"),false);
  assert.equal(sandbox.state.selectedLayerId,layer.id);
  assert.equal(histories.length,1);
  assert.equal(sandbox.state.singleBusy,false);
});

test("clipboard画像は原寸で追加し、必要な軸だけcanvasを広げて既存座標と元画像を保つ",async () => {
  for(const [width,height,expectedW,expectedH,x,y] of [
    [1200,200,1200,400,0,100],
    [300,900,600,900,150,0],
    [900,700,900,700,0,0],
    [8192,100,8192,400,0,150]
  ]){
    const {sandbox,baseCanvas,histories,createdCanvases,syncs}=harness(["addImageLayer"]);
    let closed=0;
    const bitmap={width,height,close(){closed++;}};
    sandbox.decodeImage=async () => bitmap;
    const original=sandbox.state.originalCanvas;
    const oldImage=imageLayer();
    const oldText={id:"text",type:"text",text:"注記",x:100,y:200,fontSize:30,textWidth:300,color:"#000000"};
    sandbox.state.layers=[oldImage,oldText];
    sandbox.state.crop={x:10,y:10,w:100,h:100};
    const before=JSON.stringify(sandbox.state.layers);
    await sandbox.addImageLayer({name:"paste.png",type:"image/png",size:100},{expandCanvas:true});
    assert.deepEqual([baseCanvas.width,baseCanvas.height],[expectedW,expectedH],`${width}/${height}`);
    assert.equal(sandbox.state.layers.length,3);
    assert.equal(JSON.stringify(sandbox.state.layers.slice(0,2)),before);
    assert.equal(sandbox.state.layers[0],oldImage);
    assert.equal(sandbox.state.layers[1],oldText);
    const added=sandbox.state.layers[2];
    assert.deepEqual([added.x,added.y,added.w,added.h],[x,y,width,height]);
    assert.deepEqual([added.imageCanvas.width,added.imageCanvas.height],[width,height]);
    assert.equal(added.imageCanvas.calls[0].args[0],bitmap);
    assert.deepEqual(added.imageCanvas.calls[0].args.slice(1),[0,0,width,height]);
    assert.equal(sandbox.state.originalCanvas,original);
    assert.deepEqual([original.width,original.height],[600,400]);
    assert.equal(histories.length,1);
    assert.deepEqual([histories[0].kind,histories[0].width,histories[0].height],["full",600,400]);
    assert.equal(histories[0].layers.length,2);
    assert.equal(sandbox.state.crop,null);
    assert.equal(sandbox.state.baseRevision,2);
    assert.equal(sandbox.state.selectedLayerId,added.id);
    assert.equal(syncs.length,1);
    assert.equal(closed,1);
    const paddedBase=createdCanvases[1];
    assert.equal(paddedBase.calls[0].args[0],baseCanvas);
    assert.deepEqual(paddedBase.calls[0].args.slice(1),[0,0]);
    assert.equal(paddedBase.calls.some(call => call.name === "fillRect"),false);
    assert.equal(baseCanvas.calls.at(-1).args[0],paddedBase);
    assert.deepEqual(baseCanvas.calls.at(-1).args.slice(1),[0,0]);
    assert.deepEqual([paddedBase.width,paddedBase.height],[0,0]);
  }
});

test("小さいclipboard画像は原寸・中央に配置しcanvasを縮めず、通常ファイル追加は従来のfitを保つ",async () => {
  for(const [width,height] of [[100,50],[600,400]]){
    const {sandbox,baseCanvas,histories,createdCanvases,syncs}=harness(["addImageLayer"]);
    let closed=0;
    sandbox.decodeImage=async () => ({width,height,close(){closed++;}});
    await sandbox.addImageLayer({name:"paste.png",type:"image/png",size:100},{expandCanvas:true});
    const layer=sandbox.state.layers[0];
    assert.deepEqual([baseCanvas.width,baseCanvas.height],[600,400]);
    assert.deepEqual([layer.x,layer.y,layer.w,layer.h],[(600-width)/2,(400-height)/2,width,height]);
    assert.equal(histories[0].kind,"layers");
    assert.equal(sandbox.state.baseRevision,1);
    assert.equal(syncs.length,0);
    assert.equal(createdCanvases.length,1);
    assert.equal(closed,1);
  }
  const {sandbox,baseCanvas,histories,syncs}=harness(["addImageLayer"]);
  await sandbox.addImageLayer({name:"file.png",type:"image/png",size:100},{expandCanvas:false});
  const layer=sandbox.state.layers[0];
  assert.deepEqual([baseCanvas.width,baseCanvas.height],[600,400]);
  assert.deepEqual([layer.x,layer.y,layer.w,layer.h],[0,50,600,300]);
  assert.equal(histories[0].kind,"layers");
  assert.equal(syncs.length,0);
});

test("元画像とclipboard画像が単独で上限内でも合成寸法が3600万画素を超えると全体を変更しない",async () => {
  const {sandbox,baseCanvas,histories,createdCanvases,syncs,messages}=harness(["addImageLayer"]);
  baseCanvas.width=8000;baseCanvas.height=4000;
  const layer=imageLayer();sandbox.state.layers=[layer];sandbox.selectLayers([layer]);
  const crop={x:10,y:10,w:100,h:100};sandbox.state.crop=crop;
  let closed=0;
  sandbox.decodeImage=async () => ({width:4000,height:8000,close(){closed++;}});
  await sandbox.addImageLayer({name:"paste.png",type:"image/png",size:100},{expandCanvas:true});
  assert.deepEqual([baseCanvas.width,baseCanvas.height],[8000,4000]);
  assert.deepEqual(sandbox.state.layers,[layer]);
  assert.equal(sandbox.state.selectedLayerId,layer.id);
  assert.equal(sandbox.state.crop,crop);
  assert.equal(sandbox.state.baseRevision,1);
  assert.equal(histories.length,0);
  assert.equal(createdCanvases.length,0);
  assert.equal(syncs.length,0);
  assert.equal(closed,1);
  assert.ok(messages.some(message => message.includes("3,600万")));
});

test("拡張bitmapの準備が失敗してもbase・既存レイヤー・履歴を変更せず一時bitmapを解放する",async () => {
  const {sandbox,baseCanvas,histories,createdCanvases,messages}=harness(["addImageLayer"]);
  const layer=imageLayer();sandbox.state.layers=[layer];
  let closed=0;
  sandbox.decodeImage=async () => ({width:1200,height:900,close(){closed++;}});
  sandbox.document.createElement=() => {
    const canvas=mockCanvas();createdCanvases.push(canvas);
    if(createdCanvases.length === 2) canvas.getContext("2d").drawImage=() => {throw new Error("bitmap preparation failed");};
    return canvas;
  };
  await sandbox.addImageLayer({name:"paste.png",type:"image/png",size:100},{expandCanvas:true});
  assert.deepEqual([baseCanvas.width,baseCanvas.height],[600,400]);
  assert.deepEqual(sandbox.state.layers,[layer]);
  assert.equal(histories.length,0);
  assert.equal(sandbox.state.baseRevision,1);
  assert.equal(closed,1);
  assert.ok(createdCanvases.every(canvas => canvas.width === 0 && canvas.height === 0));
  assert.ok(messages.includes("bitmap preparation failed"));
});

test("clipboardのdecode中に画像世代・base版が変われば拡張も追加もせずbitmapを閉じる",async () => {
  for(const key of ["loadVersion","baseRevision"]){
    const {sandbox,baseCanvas,histories,createdCanvases,syncs}=harness(["addImageLayer"]);
    let finish,closed=0;
    sandbox.decodeImage=() => new Promise(resolve => {finish=resolve;});
    const pending=sandbox.addImageLayer({name:"paste.png",type:"image/png",size:100},{expandCanvas:true});
    sandbox.state[key]++;
    finish({width:1200,height:900,close(){closed++;}});
    await pending;
    assert.deepEqual([baseCanvas.width,baseCanvas.height],[600,400],key);
    assert.equal(sandbox.state.layers.length,0,key);
    assert.equal(histories.length,0,key);
    assert.equal(createdCanvases.length,0,key);
    assert.equal(syncs.length,0,key);
    assert.equal(closed,1,key);
    assert.equal(sandbox.state.singleBusy,key === "loadVersion",key);
  }
});

test("canvas拡張は表示モードを保持して同期し、保存・寸法入力・アスペクトを更新する",async () => {
  for(const mode of ["fit","width","manual"]){
    const {sandbox,baseCanvas,$}=harness(["addImageLayer","syncCanvas"]);
    sandbox.layerCanvas=mockCanvas(600,400);
    sandbox.singleAspect=1.5;
    sandbox.viewState={mode,scale:.5};
    let displaySyncs=0,saveUpdates=0;
    sandbox.syncDisplaySize=() => {displaySyncs++;};
    sandbox.updateSingleSaveSize=() => {saveUpdates++;};
    for(const name of ["syncCropInputs","updateCropControls","renderLayers","renderEditor","updateSelectedControls","updateHistoryButtons"]){
      sandbox[name]=() => {};
    }
    await sandbox.addImageLayer({name:"paste.png",type:"image/png",size:100},{expandCanvas:true});
    assert.deepEqual([baseCanvas.width,baseCanvas.height],[1200,600]);
    assert.deepEqual([sandbox.layerCanvas.width,sandbox.layerCanvas.height],[1200,600]);
    assert.deepEqual([sandbox.editCanvas.width,sandbox.editCanvas.height],[1200,600]);
    assert.equal($("resizeW").value,1200);
    assert.equal($("resizeH").value,600);
    assert.equal($("singleInfo").textContent,"1200 × 600px");
    assert.equal(sandbox.singleAspect,2);
    assert.equal(sandbox.viewState.mode,mode);
    assert.equal(sandbox.viewState.scale,.5);
    assert.equal(displaySyncs,1);
    assert.equal(saveUpdates,1);
  }
});

test("画像追加はファイル容量・寸法・総画素数の上限を守る",async () => {
  const {sandbox,histories,messages} = harness(["addImageLayer"]);
  let decodes = 0;
  sandbox.decodeImage = async () => {decodes++;return {width:8193,height:1};};
  await sandbox.addImageLayer({name:"large.png",type:"image/png",size:26*1024*1024});
  assert.equal(decodes,0);
  await sandbox.addImageLayer({name:"wide.png",type:"image/png",size:100});
  assert.equal(sandbox.state.layers.length,0);
  assert.equal(histories.length,0);
  assert.ok(messages.some(message => message.includes("8192")));
  assert.throws(() => sandbox.validateDimensions(7000,7000),/3,600万/);
  assert.throws(() => sandbox.validateDimensions(0,100),/不正/);
});

test("追加画像のdecode中に元画像が変わると古い画像は追加されない",async () => {
  const {sandbox,histories} = harness(["addImageLayer"]);
  let finish;
  let closed = false;
  sandbox.decodeImage = () => new Promise(resolve => {finish = resolve;});
  const pending = sandbox.addImageLayer({name:"stamp.png",type:"image/png",size:100});
  sandbox.state.baseRevision++;
  finish({width:100,height:50,close(){closed = true;}});
  await pending;
  assert.equal(sandbox.state.layers.length,0);
  assert.equal(histories.length,0);
  assert.equal(sandbox.state.singleBusy,false);
  assert.equal(closed,true);
});

test("初回画像読込は標準PNGにして保存用の寸法設定を解除する",async () => {
  const {sandbox,$} = harness(["loadSingleFile","sanitizeBaseName"]);
  sandbox.singleSavePreset = {longEdge:1600};
  $("singleFormat").value = "image/jpeg";
  await sandbox.loadSingleFile({name:"photo.jpg",type:"image/jpeg",size:100});
  assert.equal($("singleFormat").value,"image/png");
  assert.equal(sandbox.singleSavePreset,null);
  assert.equal(sandbox.state.singleBusy,false);
  assert.equal(sandbox.state.sourceFile.name,"photo.jpg");
  assert.equal($("singleTargetEnabled").checked,false);
  assert.equal($("singleTargetKB").disabled,true);
});

test("画像layerの描画と保存合成は不透明度と元bitmapを使用する",() => {
  const {sandbox,baseCanvas} = harness(["drawLayer","compositeCanvas"]);
  const layer = imageLayer({opacity:35});
  sandbox.state.layers = [layer,imageLayer({visible:false})];
  const output = sandbox.compositeCanvas();
  const draws = output.calls.filter(call => call.name === "drawImage");
  assert.equal(draws.length,2);
  assert.equal(draws[0].args[0],baseCanvas);
  assert.equal(draws[1].args[0],layer.imageCanvas);
  assert.equal(draws[1].alpha,.35);
  assert.deepEqual(draws[1].args.slice(1),[20,30,100,50]);
  assert.equal(output.getContext("2d").globalAlpha,1);
});

test("画像layerの移動・resizeは座標に追従し、ハンドルresizeは縦横比を維持する",() => {
  const {sandbox} = harness(["layerBounds","moveLayerRaw","scaleLayerFromBounds","transformAllLayers"]);
  const layer = imageLayer();
  sandbox.moveLayerRaw(layer,10,20);
  assert.equal(layer.x,30);
  assert.equal(layer.y,50);
  const start = {...layer};
  sandbox.scaleLayerFromBounds(layer,start,sandbox.layerBounds(start),150,60);
  assert.equal(layer.w,150);
  assert.equal(layer.h,75);
  sandbox.state.layers = [layer];
  sandbox.transformAllLayers(.5,.5);
  assert.equal(layer.x,15);
  assert.equal(layer.y,25);
  assert.equal(layer.w,75);
  assert.equal(layer.h,37.5);
  assert.equal(layer.imageCanvas,start.imageCanvas);
  const thin = imageLayer({x:0,y:0,w:100,h:.1});
  sandbox.scaleLayerFromBounds(thin,{...thin},sandbox.layerBounds(thin),2,2);
  assert.equal(thin.w/thin.h,1000);
});

test("追加画像のハンドルは横または縦だけのドラッグでも縦横比を保って縮小する",() => {
  for(const [width,height] of [[50,50],[100,25],[50,25]]){
    const {sandbox} = harness(["layerBounds","scaleLayerFromBounds"]);
    const layer=imageLayer(),bitmap=layer.imageCanvas;
    sandbox.scaleLayerFromBounds(layer,{...layer},sandbox.layerBounds(layer),width,height);
    assert.deepEqual([layer.x,layer.y,layer.w,layer.h],[20,30,50,25]);
    assert.equal(layer.imageCanvas,bitmap);
  }
});

test("cropで部分的に残った追加画像のbitmapは引き伸ばされない",() => {
  const {sandbox} = harness(["layerBounds","moveLayerRaw","clipRectLayerToCanvas","trimLayersAfterCrop"]);
  const layer = imageLayer();
  const outside = imageLayer({id:"outside",x:300,y:300});
  sandbox.state.layers = [layer,outside];
  sandbox.trimLayersAfterCrop({x:40,y:40,w:50,h:40});
  assert.equal(sandbox.state.layers.length,1);
  assert.equal(layer.x,-20);
  assert.equal(layer.y,-10);
  assert.equal(layer.w,100);
  assert.equal(layer.h,50);
  assert.equal(layer.imageCanvas.width,100);
});

test("画像layerの回転・反転は新bitmapに置き換え、履歴のbitmapを変更しない",() => {
  const {sandbox,histories} = harness(["rotatePoint","rotateCanvas","rotateSingle","flipCanvas","flipSingle"]);
  const layer = imageLayer();
  const bitmap = layer.imageCanvas;
  sandbox.state.layers = [layer];
  sandbox.rotateSingle(90);
  assert.equal(layer.x,320);
  assert.equal(layer.y,20);
  assert.equal(layer.w,50);
  assert.equal(layer.h,100);
  assert.equal(layer.imageCanvas.width,50);
  assert.equal(layer.imageCanvas.height,100);
  assert.notEqual(layer.imageCanvas,bitmap);
  assert.equal(histories[0].layers[0].imageCanvas,bitmap);
  const rotated = layer.imageCanvas;
  sandbox.flipSingle(true);
  assert.equal(layer.x,30);
  assert.notEqual(layer.imageCanvas,rotated);
  assert.equal(histories[1].layers[0].imageCanvas,rotated);
  assert.equal(bitmap.width,100);
  assert.equal(bitmap.height,50);
});

test("保存用途は出力サイズだけを設定し、編集中画像や履歴を変更しない",() => {
  const {sandbox,baseCanvas,histories,$} = harness(["applySinglePreset","singleSaveDimensions"]);
  baseCanvas.width = 3200;
  baseCanvas.height = 2000;
  $("presetSelect").value = "web";
  sandbox.applySinglePreset();
  assert.equal(baseCanvas.width,3200);
  assert.equal(baseCanvas.height,2000);
  assert.equal(histories.length,0);
  const size = sandbox.singleSaveDimensions(baseCanvas.width,baseCanvas.height);
  assert.equal(size.width,1600);
  assert.equal(size.height,1000);
  const small = sandbox.singleSaveDimensions(400,250);
  assert.equal(small.width,400);
  assert.equal(small.height,250);
  assert.equal($("singleFormat").value,"image/webp");
  $("presetSelect").value = "";
  sandbox.applySinglePreset();
  const restored = sandbox.singleSaveDimensions(baseCanvas.width,baseCanvas.height);
  assert.equal(restored.width,3200);
  assert.equal(restored.height,2000);
  assert.equal($("singleTargetEnabled").checked,false);
});

test("JPEG透明部分の白背景合成はPNG用の元canvasを変更しない",() => {
  const {sandbox} = harness(["flattenForJpeg"]);
  const original = mockCanvas(100,50);
  const flattened = sandbox.flattenForJpeg(original,"white");
  const fill = flattened.calls.find(call => call.name === "fillRect");
  assert.equal(fill.fill,"#fff");
  assert.equal(flattened.calls.at(-1).args[0],original);
  assert.equal(original.calls.length,0);
});
