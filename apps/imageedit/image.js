(() => {
  "use strict";

  const MAX_DIMENSION = 8192;
  const MAX_PIXELS = 36000000;
  const MAX_FILE_BYTES = 25 * 1024 * 1024;
  const MAX_BATCH_FILES = 30;
  const MAX_BATCH_BYTES = 150 * 1024 * 1024;
  const SUPPORTED_TYPES = ["image/jpeg","image/png","image/webp"];
  const RECT_TYPES = ["blackoutRect","mosaicRect","rect","ellipse"];
  const BRUSH_TYPES = ["blackoutBrush","mosaicBrush"];
  const drawing = window.AppBoxImageDrawing;

  const $ = id => document.getElementById(id);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const clamp = (value,min,max) => Math.min(max,Math.max(min,value));
  const isFiniteInteger = value => Number.isSafeInteger(value);
  const annotationStyle = globalThis.AppBoxImageAnnotation;

  const baseCanvas = $("baseCanvas");
  const baseContext = baseCanvas.getContext("2d");

  const layerCanvas = $("layerCanvas");
  const layerContext = layerCanvas.getContext("2d");

  const editCanvas = $("editCanvas");
  const editContext = editCanvas.getContext("2d");
  const textEditor = $("textEditor");
  const textEditorHost = $("textEditorHost");
  textEditor.hidden = true;
  textEditorHost.hidden = true;

  // 表示倍率とスクロールは編集データ・保存用の画像座標から独立させる。
  const canvasViewport = $("canvasViewport");
  const canvasHolder = $("canvasHolder");
  const viewState = {mode:"fit",scale:1,pan:null,rule:null,pending:false};

  const state = {
    sourceFile:null,
    originalCanvas:null,
    layers:[],
    selectedLayerId:null,
    selectedLayerIds:new Set(),
    tool:null,
    crop:null,
    drag:null,
    undo:[],
    redo:[],
    loadVersion:0,
    baseRevision:0,
    revision:0,
    savedRevision:0,
    revisionCounter:0,
    mosaicCache:new Map(),
    renderPending:false,
    singleBusy:false,
    textEditing:null,
    composing:false
  };

  const batchState = {
    items:[],
    processing:false,
    adding:false,
    cancelRequested:false,
    addVersion:0,
    lastZip:null,
    lastZipName:"images-batch.zip"
  };

  const presets = {
    web:{format:"image/webp",longEdge:1600,target:true,kb:500},
    mail:{format:"image/jpeg",longEdge:1200,target:true,kb:300},
    document:{format:"image/jpeg",longEdge:1600,target:true,kb:1000},
    thumb:{format:"image/jpeg",width:400,height:300,target:true,kb:100},
    metadata:{format:"original",target:false}
  };

  let toastTimer = null;
  let previewReturnFocus = null;
  let saveReturnFocus = null;
  let singleSavePreset = null;
  let singleAspect = 1;
  let styleEditSession = null;
  let fontPreview = null;
  let textEditSession = null;
  let textEditorRule = null;
  let textEditorHostRule = null;
  let modeChoicesOpen = false;
  const toolOutlinePreferences = new Map([
    ["text",true],["arrow",true],["line",true],["rect",false],["ellipse",false]
  ]);
  let objectClipboard = null;
  let objectClipboardToken = "";
  let objectClipboardText = "";
  let objectPasteCount = 0;
  const OBJECT_CLIPBOARD_TYPE = "application/x-appbox-imageedit-object";
  function toast(message){
    const element = $("toast");
    element.textContent = message;
    element.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => element.classList.remove("show"),2200);
  }

  function setSingleStatus(message,type=""){
    const element = $("singleStatus");
    element.textContent = message;
    element.className = "status" + (type ? ` ${type}` : "");
  }

  function setBatchStatus(message,type=""){
    const element = $("batchStatus");
    element.textContent = message;
    element.className = "status" + (type ? ` ${type}` : "");
  }

  function bytes(value){
    if(!Number.isFinite(value)) return "-";
    const units = ["B","KB","MB","GB"];
    let number = value;
    let index = 0;

    while(number >= 1024 && index < units.length-1){
      number /= 1024;
      index++;
    }

    const display = index === 0
      ? Math.round(number)
      : number >= 100
        ? Math.round(number)
        : number >= 10
          ? number.toFixed(1)
          : number.toFixed(2);

    return `${display} ${units[index]}`;
  }

  function isSupportedImage(file){
    return !!file && (
      SUPPORTED_TYPES.includes(file.type) ||
      /\.(jpe?g|png|webp)$/i.test(file.name || "")
    );
  }

  function validateDimensions(width,height){
    if(!isFiniteInteger(width) || !isFiniteInteger(height) || width < 1 || height < 1){
      throw new Error("画像サイズが不正です。");
    }
    if(width > MAX_DIMENSION || height > MAX_DIMENSION){
      throw new Error(`画像の縦横は${MAX_DIMENSION}px以下にしてください。`);
    }
    if(width * height > MAX_PIXELS){
      throw new Error("画像の総画素数が3,600万画素を超えています。");
    }
  }

  function createCanvas(width,height){
    validateDimensions(width,height);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }

  function cloneCanvas(source){
    const canvas = createCanvas(source.width,source.height);
    canvas.getContext("2d").drawImage(source,0,0);
    return canvas;
  }

  function canvasToBlob(canvas,type,quality,strictType=true){
    return new Promise((resolve,reject) => {
        canvas.toBlob(blob => {
        if(!blob){
            reject(new Error("画像の生成に失敗しました。"));
            return;
        }

        if(strictType && blob.type !== type){
            reject(new Error(
            `${extensionForType(type).toUpperCase()}形式の保存に対応していないブラウザです。`
            ));
            return;
        }

        resolve(blob);
        },type,quality);
    });
  }

  async function decodeImage(file){
    // Reject invalid or huge dimensions before createImageBitmap / Image.src.
    const header = await window.AppBoxSafeImage.readDimensions(file);
    validateDimensions(header.width,header.height);
    function verify(image){
      const width = image.width || image.naturalWidth;
      const height = image.height || image.naturalHeight;
      validateDimensions(width,height);
      window.AppBoxSafeImage.assertDimensions(header,width,height);
      return image;
    }
    if("createImageBitmap" in window){
      let bitmap;
      try{
        bitmap = await createImageBitmap(file,{imageOrientation:"from-image"});
      }catch(error){
        try{
          bitmap = await createImageBitmap(file);
        }catch(secondError){
          throw new Error("画像を読み込めませんでした。");
        }
      }
      try{
        return verify(bitmap);
      }catch(error){
        if(typeof bitmap.close === "function") bitmap.close();
        throw error;
      }
    }
    return await new Promise((resolve,reject) => {
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => {
        URL.revokeObjectURL(url);
        try{resolve(verify(image));}catch(error){reject(error);}
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("画像を読み込めませんでした。"));
      };
      image.src = url;
    });
  }

  function sanitizeBaseName(value){
    let name = String(value || "image")
      .replace(/\.[^.]+$/,"")
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g,"_")
      .replace(/\.{2,}/g,"_")
      .replace(/[. ]+$/g,"")
      .trim();

    if(/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:[. ]|$)/i.test(name)){
      name = "_" + name;
    }

    return [...name].slice(0,100).join("") || "image";
  }

  function extensionForType(type){
    if(type === "image/jpeg") return "jpg";
    if(type === "image/png") return "png";
    return "webp";
  }

  function saveBlob(blob,fileName){
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url),2000);
  }

  function makeId(){
    if(window.crypto && typeof crypto.randomUUID === "function"){
      return crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

    function cloneLayers(layers){
    return layers.map(layer => ({
        ...layer,
        points:layer.points
        ? layer.points.map(point => ({
            x:point.x,
            y:point.y
            }))
        : undefined,
        maskCanvas:null,
        maskDirty:true
    }));
    }


  function invalidateBaseCaches(){
    state.baseRevision++;
    state.mosaicCache.clear();
  }

  function maxBitmapHistoryCount(){
    const pixels = Math.max(1,baseCanvas.width * baseCanvas.height);
    if(pixels > 20000000) return 1;
    if(pixels > 10000000) return 2;
    if(pixels > 5000000) return 4;
    return 8;
  }

  function trimHistory(list){
    const bitmapCount = list.reduce(
      (count,item) => count + (item.kind === "full" ? 1 : 0),
      0
    );
    const allowedBitmaps = maxBitmapHistoryCount();
    let excessBitmaps = bitmapCount - allowedBitmaps;

    if(excessBitmaps > 0){
      let cutoff = 0;
      for(let index=0; index<list.length && excessBitmaps>0; index++){
        if(list[index].kind === "full"){
          cutoff = index+1;
          excessBitmaps--;
        }
      }
      // Layer-only snapshots before this boundary still require the discarded
      // bitmap. Keep a continuous history rather than restoring mismatched data.
      list.splice(0,cutoff);
    }

    while(list.length > 40){
      list.shift();
    }
  }

  function makeLayerSnapshot(){
    return {
      kind:"layers",
      revision:state.revision,
      layers:cloneLayers(state.layers)
    };
  }

  function makeFullSnapshot(){
    return {
      kind:"full",
      revision:state.revision,
      base:cloneCanvas(baseCanvas),
      layers:cloneLayers(state.layers)
    };
  }

  function pushHistory(kind="layers"){
    state.undo.push(kind === "full" ? makeFullSnapshot() : makeLayerSnapshot());
    trimHistory(state.undo);
    state.redo = [];
    state.revision = ++state.revisionCounter;
    updateHistoryButtons();
  }

  function currentSnapshotForCounterpart(item){
    return item.kind === "full" ? makeFullSnapshot() : makeLayerSnapshot();
  }

  function restoreSnapshot(item){
    state.revision = item.revision;
    if(item.kind === "full"){
        baseCanvas.width = item.base.width;
        baseCanvas.height = item.base.height;
        baseContext.clearRect(
        0,
        0,
        baseCanvas.width,
        baseCanvas.height
        );
        baseContext.drawImage(item.base,0,0);
        invalidateBaseCaches();
    }

    state.layers = cloneLayers(item.layers);
    state.crop = null;
    selectLayers([]);
    state.drag = null;

    singleAspect =
        baseCanvas.width/baseCanvas.height;

    setTool("select");
    syncCanvas();
  }

  function undo(){
    if(state.singleBusy || state.drag || viewState.pan) return;
    finishTextEditing();
    if(!state.undo.length){
      toast("これ以上戻せません。");
      return;
    }

    const item = state.undo.pop();
    state.redo.push(currentSnapshotForCounterpart(item));
    trimHistory(state.redo);
    restoreSnapshot(item);
    updateHistoryButtons();
  }

  function redo(){
    if(state.singleBusy || state.drag || viewState.pan) return;
    finishTextEditing();
    if(!state.redo.length){
      toast("やり直せる操作がありません。");
      return;
    }

    const item = state.redo.pop();
    state.undo.push(currentSnapshotForCounterpart(item));
    trimHistory(state.undo);
    restoreSnapshot(item);
    updateHistoryButtons();
  }

  function updateHistoryButtons(){
    $("undo").disabled = !state.undo.length;
    $("redo").disabled = !state.redo.length;
  }

  function scheduleRender(){
    if(state.renderPending) return;

    state.renderPending = true;

    requestAnimationFrame(() => {
      state.renderPending = false;
     renderLayers();
      renderEditor();
    });
  }


function syncCanvas(){
  layerCanvas.width = baseCanvas.width;
  layerCanvas.height = baseCanvas.height;
  editCanvas.width = baseCanvas.width;
  editCanvas.height = baseCanvas.height;

  syncDisplaySize();

  $("resizeW").value = baseCanvas.width || "";
  $("resizeH").value = baseCanvas.height || "";
  $("singleInfo").textContent = baseCanvas.width
    ? `${baseCanvas.width} × ${baseCanvas.height}px`
    : "-";

  singleAspect = baseCanvas.width && baseCanvas.height
    ? baseCanvas.width/baseCanvas.height
    : 1;

  syncCropInputs();
  updateCropControls();
  renderLayers();
  renderEditor();
  updateSelectedControls();
  updateHistoryButtons();
  updateSingleSaveSize();
}

  function fitDisplayScale(){
    return Math.min(
      1,
      Math.max(1,canvasViewport.clientWidth)/Math.max(1,baseCanvas.width),
      Math.max(1,canvasViewport.clientHeight)/Math.max(1,baseCanvas.height)
    );
  }

  function widthDisplayScale(){
    return Math.min(4,Math.max(1,canvasViewport.clientWidth)/Math.max(1,baseCanvas.width));
  }

  function editorChromeActive(){
    return !!state.sourceFile && !!state.originalCanvas && !$("singlePanel").hidden;
  }

  function syncEditorChrome(){
    const active = editorChromeActive();
    const changed = document.body.classList.contains("image-editor-active") !== active;
    document.body.classList.toggle("image-editor-active",active);
    const intro = $("imageIntro");
    if(intro) intro.hidden = active;
    const actions = $("imageHeaderActions");
    if(actions){actions.hidden = !active;actions.inert = !active;}
    syncModeControls();
    if(changed) scheduleDisplayResize();
  }

  function syncModeControls(){
    const loaded = editorChromeActive() || (!$("batchPanel").hidden && batchState.items.length > 0);
    const tabs = $("processingModeTabs");
    const tabFocused = tabs.contains(document.activeElement);
    tabs.hidden = loaded && !modeChoicesOpen;
    tabs.inert = tabs.hidden;
    const change = $("changeProcessingMode");
    change.hidden = !loaded;
    change.disabled = state.singleBusy || batchState.processing || batchState.adding;
    change.setAttribute("aria-expanded",String(!tabs.hidden));
    if(tabs.hidden && tabFocused){
      if(!$("singlePanel").hidden) editCanvas.focus({preventScroll:true});
      else $("batchAdd").focus();
    }
  }

  function syncWorkspaceHeight(){
    if(!editorChromeActive()){
      if(viewState.sidebarRule) viewState.sidebarRule.style.setProperty("--image-sidebar-height","");
      if(!viewState.viewportRule?.style.height) return false;
      viewState.viewportRule.style.height = "";
      return true;
    }
    if(!Number.isFinite(window.innerHeight) || window.innerHeight <= 0) return false;
    const rect = canvasViewport.getBoundingClientRect();
    if(!Number.isFinite(rect.top)) return false;
    let extra = 16;
    for(const id of ["zoomControls"]){
      const element = $(id);
      if(!element || element.hidden || element.classList.contains("hidden")) continue;
      const height = element.getBoundingClientRect().height;
      if(Number.isFinite(height)) extra += Math.max(0,height);
    }
    const top = Math.max(0,rect.top+(Number.isFinite(window.scrollY) ? window.scrollY : 0));
    const height = `${Math.max(240,Math.floor(window.innerHeight-top-extra))}px`;
    if(!viewState.viewportRule){
      const origin = new URL(document.baseURI).origin;
      const sheet = [...document.styleSheets].find(item => item.href &&
        new URL(item.href,document.baseURI).origin === origin &&
        new URL(item.href,document.baseURI).pathname.endsWith("/imageedit/image.css"));
      if(!sheet) return false;
      try{
        const index = sheet.insertRule("#canvasViewport {}",sheet.cssRules.length);
        const viewportRule = sheet.cssRules[index];
        const sidebarIndex = sheet.insertRule(".editor-sidebar, .editor-settings {}",sheet.cssRules.length);
        viewState.sidebarRule = sheet.cssRules[sidebarIndex];
        viewState.viewportRule = viewportRule;
      }catch(error){return false;}
    }
    viewState.sidebarRule.style.setProperty("--image-sidebar-height",`${parseFloat(height)+extra-16}px`);
    const changed = viewState.viewportRule.style.height !== height;
    viewState.viewportRule.style.height = height;
    return changed;
  }

  function displayCenter(){
    const viewport = canvasViewport.getBoundingClientRect();
    const holder = canvasHolder.getBoundingClientRect();
    return {
      x:(viewport.left+canvasViewport.clientLeft+canvasViewport.clientWidth/2-holder.left)/viewState.scale,
      y:(viewport.top+canvasViewport.clientTop+canvasViewport.clientHeight/2-holder.top)/viewState.scale
    };
  }

  function displayAnchorAtEvent(event){
    const rectangle = editCanvas.getBoundingClientRect();
    if(!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY) ||
      event.clientX < rectangle.left || event.clientY < rectangle.top ||
      event.clientX > rectangle.left+rectangle.width || event.clientY > rectangle.top+rectangle.height) return null;
    const viewport = canvasViewport.getBoundingClientRect();
    return {
      ...pointFromEvent(event),
      viewportX:event.clientX-viewport.left-canvasViewport.clientLeft,
      viewportY:event.clientY-viewport.top-canvasViewport.clientTop
    };
  }

  function syncDisplaySize(center=null){
    const previousCenter = !center && state.sourceFile && viewState.mode !== "fit" ? displayCenter() : null;
    const heightChanged = syncWorkspaceHeight();
    if(heightChanged && previousCenter) center = previousCenter;
    if(!state.sourceFile || !canvasViewport.clientWidth || !canvasViewport.clientHeight) return;

    if(!viewState.rule){
      // 同一オリジンの外部CSSへルールを追加し、style属性は付与しない。
      const sheet = [...document.styleSheets].find(item => item.href &&
        new URL(item.href,document.baseURI).pathname.endsWith("/image.css"));
      if(!sheet) return;
      const index = sheet.insertRule("#canvasHolder {}",sheet.cssRules.length);
      viewState.rule = sheet.cssRules[index];
    }

    if(viewState.mode === "fit") viewState.scale = fitDisplayScale();
    if(viewState.mode === "width") viewState.scale = widthDisplayScale();
    const scale = viewState.scale;
    // 三枚のキャンバスを同じ親要素の寸法に追従させ、縦横の倍率を統一する。
    viewState.rule.style.width = `${baseCanvas.width*scale}px`;
    viewState.rule.style.height = `${baseCanvas.height*scale}px`;

    if(center && viewState.mode !== "fit"){
      const viewport = canvasViewport.getBoundingClientRect();
      const holder = canvasHolder.getBoundingClientRect();
      canvasViewport.scrollLeft += holder.left+center.x*scale-
        (viewport.left+canvasViewport.clientLeft+(center.viewportX ?? canvasViewport.clientWidth/2));
      canvasViewport.scrollTop += holder.top+center.y*scale-
        (viewport.top+canvasViewport.clientTop+(center.viewportY ?? canvasViewport.clientHeight/2));
    }else if(viewState.mode === "fit"){
      canvasViewport.scrollLeft = 0;
      canvasViewport.scrollTop = 0;
    }

    $("zoomValue").value = Math.round(scale*1000)/10;
    $("zoomOut").disabled = scale <= Math.min(.05,fitDisplayScale());
    $("zoomIn").disabled = scale >= 4;
    $("zoomFit").setAttribute("aria-pressed",String(viewState.mode === "fit"));
    $("zoomWidth")?.setAttribute("aria-pressed",String(viewState.mode === "width"));
    renderEditor();
  }

  function setDisplayZoom(scale,mode="manual",anchor=null){
    if(!state.sourceFile || state.singleBusy || state.drag || viewState.pan) return;
    const center = anchor || displayCenter();
    viewState.mode = mode;
    viewState.scale = clamp(scale,Math.min(.05,fitDisplayScale()),4);
    syncDisplaySize(center);
  }

  $("zoomOut").addEventListener("click",() => setDisplayZoom(viewState.scale/1.25));
  $("zoomIn").addEventListener("click",() => setDisplayZoom(viewState.scale*1.25));
  $("zoomFit").addEventListener("click",() => setDisplayZoom(1,"fit"));
  $("zoomWidth")?.addEventListener("click",() => setDisplayZoom(1,"width"));
  $("zoomActual").addEventListener("click",() => setDisplayZoom(1));
  $("zoomValue").addEventListener("change",() => {
    const value = Number($("zoomValue").value);
    if(Number.isFinite(value) && value > 0) setDisplayZoom(value/100);
    else $("zoomValue").value = Math.round(viewState.scale*1000)/10;
  });

  canvasViewport.addEventListener("wheel",event => {
    if(!state.sourceFile || state.singleBusy || state.drag || viewState.pan ||
      state.composing || state.textEditing || isEditingTarget(event.target)) return;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvasViewport.clientHeight : 1;
    const delta = event.deltaY*unit;
    if(!Number.isFinite(delta) || delta === 0) return;
    event.preventDefault();
    setDisplayZoom(viewState.scale*Math.exp(-clamp(delta,-300,300)*.003),"manual",displayAnchorAtEvent(event));
  },{passive:false});

  function scheduleDisplayResize(){
    if(viewState.pending) return;
    viewState.pending = true;
    requestAnimationFrame(() => {
      viewState.pending = false;
      syncDisplaySize();
    });
  }

  if("ResizeObserver" in window){
    const observer = new ResizeObserver(scheduleDisplayResize);
    observer.observe(canvasViewport);
    [$("editorActions"),$("imageHeaderActions"),$("zoomControls")].filter(Boolean)
      .forEach(element => observer.observe(element));
    const header = document.querySelector(".appbox-header");
    if(header) observer.observe(header);
  }
  window.addEventListener("resize",scheduleDisplayResize);

  // captureで手のひら操作を先に受け、注釈の移動・描画処理へ渡さない。
  canvasViewport.addEventListener("pointerdown",event => {
    if(state.tool !== "pan" || !state.sourceFile || state.singleBusy || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    editCanvas.focus({preventScroll:true});
    canvasViewport.setPointerCapture(event.pointerId);
    viewState.pan = {
      id:event.pointerId,x:event.clientX,y:event.clientY,
      left:canvasViewport.scrollLeft,top:canvasViewport.scrollTop
    };
    canvasViewport.classList.add("panning");
  },true);

  canvasViewport.addEventListener("pointermove",event => {
    const pan = viewState.pan;
    if(!pan || pan.id !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    canvasViewport.scrollLeft = pan.left-(event.clientX-pan.x);
    canvasViewport.scrollTop = pan.top-(event.clientY-pan.y);
  },true);

  function endViewPan(event){
    if(!viewState.pan || viewState.pan.id !== event.pointerId) return;
    event.stopPropagation();
    viewState.pan = null;
    canvasViewport.classList.remove("panning");
    if(canvasViewport.hasPointerCapture(event.pointerId)){
      canvasViewport.releasePointerCapture(event.pointerId);
    }
  }
  canvasViewport.addEventListener("pointerup",endViewPan,true);
  canvasViewport.addEventListener("pointercancel",endViewPan,true);
  canvasViewport.addEventListener("lostpointercapture",endViewPan,true);


function renderLayers(){
  layerContext.clearRect(
    0,
    0,
    layerCanvas.width,
    layerCanvas.height
  );

  let source = null;
  let sourceContext = null;
  let drawnLayers = 0;
  try{
    state.layers.forEach(layer => {
      if(layer.visible === false) return;
      const isMosaic = ["mosaicRect","mosaicBrush"].includes(layer.type);
      if(isMosaic && drawnLayers){
        if(!source){
          source = createCanvas(baseCanvas.width,baseCanvas.height);
          sourceContext = source.getContext("2d");
        }
        sourceContext.clearRect(0,0,source.width,source.height);
        sourceContext.drawImage(baseCanvas,0,0);
        sourceContext.drawImage(layerCanvas,0,0);
      }
      drawLayer(layerContext,layer,isMosaic && drawnLayers ? source : baseCanvas);
      drawnLayers++;
    });
  }finally{
    // 合成素材はフレームをまたいで保持しない。大画像のbitmapを早期解放する。
    if(source){source.width = 0;source.height = 0;}
  }
}



  function pointFromEvent(event){
    const rectangle = editCanvas.getBoundingClientRect();

    if(!rectangle.width || !rectangle.height){
      return {x:0,y:0};
    }

    return {
      x:clamp(
        (event.clientX-rectangle.left)*editCanvas.width/rectangle.width,
        0,
        editCanvas.width
      ),
      y:clamp(
        (event.clientY-rectangle.top)*editCanvas.height/rectangle.height,
        0,
        editCanvas.height
      )
    };
  }

  function displayScale(){
    const rectangle = editCanvas.getBoundingClientRect();
    return rectangle.width
      ? editCanvas.width/rectangle.width
      : 1;
  }

  function normalizeRectangle(start,end){
    return {
      x:Math.min(start.x,end.x),
      y:Math.min(start.y,end.y),
      w:Math.abs(end.x-start.x),
      h:Math.abs(end.y-start.y)
    };
  }

  function selectedLayers(){
    const ids = state.selectedLayerIds || new Set();
    return state.layers.filter(layer => ids.size
      ? ids.has(layer.id)
      : layer.id === state.selectedLayerId);
  }

  function selectLayers(layers){
    if(state.textEditing) finishTextEditing();
    state.selectedLayerIds = new Set(layers.map(layer => layer.id));
    state.selectedLayerId = layers.length === 1 ? layers[0].id : null;
    state.textEditing = null;
    styleEditSession = null;
  }

  function selectedLayer(){
    const layers = selectedLayers();
    return layers.length === 1 ? layers[0] : null;
  }

  function layersBounds(layers){
    const bounds = layers.map(layerBounds);
    const x = Math.min(...bounds.map(item => item.x));
    const y = Math.min(...bounds.map(item => item.y));
    return {
      x,y,
      w:Math.max(...bounds.map(item => item.x+item.w))-x,
      h:Math.max(...bounds.map(item => item.y+item.h))-y
    };
  }

  function textBounds(layer){
    return annotationStyle.layoutText(editContext,layerForStylePreview(layer)).bounds;
  }

  function layerBounds(layer){
    if(RECT_TYPES.includes(layer.type) || layer.type === "image"){
      return {x:layer.x,y:layer.y,w:layer.w,h:layer.h};
    }

    if(layer.type === "text"){
      return textBounds(layer);
    }

    if(drawing.isLine(layer)){
      const rectangle = normalizeRectangle(
        {x:layer.x1,y:layer.y1},
        {x:layer.x2,y:layer.y2}
      );
      const pad = layer.type === "arrow" ? Math.max(10,layer.lineWidth*2) : Math.max(1,layer.lineWidth/2);

      return {
        x:rectangle.x-pad,
        y:rectangle.y-pad,
        w:Math.max(1,rectangle.w+pad*2),
        h:Math.max(1,rectangle.h+pad*2)
      };
    }

    if(BRUSH_TYPES.includes(layer.type) || layer.type === "ink"){
      if(!layer.points || !layer.points.length){
        return {x:0,y:0,w:0,h:0};
      }

      const bounds = drawing.inkBounds(layer.points);
      const pad = layer.brushSize/2;

      return {
        x:bounds.x-pad,
        y:bounds.y-pad,
        w:Math.max(1,bounds.w+pad*2),
        h:Math.max(1,bounds.h+pad*2)
      };
    }

    return {x:0,y:0,w:0,h:0};
  }

  function pointToSegmentDistance(point,a,b){
    const dx = b.x-a.x;
    const dy = b.y-a.y;

    if(dx === 0 && dy === 0){
      return Math.hypot(point.x-a.x,point.y-a.y);
    }

    const t = clamp(
      ((point.x-a.x)*dx+(point.y-a.y)*dy)/(dx*dx+dy*dy),
      0,
      1
    );

    const x = a.x+t*dx;
    const y = a.y+t*dy;
    return Math.hypot(point.x-x,point.y-y);
  }

  function hitTestLayer(layer,point){
    if(layer.visible === false) return false;

    if(drawing.isLine(layer)){
      const tolerance = Math.max(10*displayScale(),layer.lineWidth*2);
      return pointToSegmentDistance(
        point,
        {x:layer.x1,y:layer.y1},
        {x:layer.x2,y:layer.y2}
      ) <= tolerance;
    }

    if(BRUSH_TYPES.includes(layer.type) || layer.type === "ink"){
      if(!layer.points || !layer.points.length) return false;
      const tolerance = Math.max(layer.brushSize/2,8*displayScale());

      if(layer.points.length === 1){
        return Math.hypot(
          point.x-layer.points[0].x,
          point.y-layer.points[0].y
        ) <= tolerance;
      }

      for(let index=1; index<layer.points.length; index++){
        if(pointToSegmentDistance(
          point,
          layer.points[index-1],
          layer.points[index]
        ) <= tolerance){
          return true;
        }
      }
      return false;
    }

    const bounds = layerBounds(layer);
    return point.x >= bounds.x &&
      point.x <= bounds.x+bounds.w &&
      point.y >= bounds.y &&
      point.y <= bounds.y+bounds.h;
  }

  function hitLayer(point){
    for(let index=state.layers.length-1; index>=0; index--){
      if(hitTestLayer(state.layers[index],point)){
        return state.layers[index];
      }
    }
    return null;
  }

  function clampBoundsTranslation(bounds,dx,dy){

    if(bounds.w <= baseCanvas.width){
      dx = clamp(dx,-bounds.x,baseCanvas.width-(bounds.x+bounds.w));
    }else{
      dx = clamp(dx,baseCanvas.width-(bounds.x+bounds.w),-bounds.x);
    }

    if(bounds.h <= baseCanvas.height){
      dy = clamp(dy,-bounds.y,baseCanvas.height-(bounds.y+bounds.h));
    }else{
      dy = clamp(dy,baseCanvas.height-(bounds.y+bounds.h),-bounds.y);
    }

    return {dx,dy};
  }

  function moveLayerRaw(layer,dx,dy){
    if(RECT_TYPES.includes(layer.type) || ["text","image"].includes(layer.type)){
      layer.x += dx;
      layer.y += dy;
    }else if(drawing.isLine(layer)){
      layer.x1 += dx;
      layer.y1 += dy;
      layer.x2 += dx;
      layer.y2 += dy;
    }else if(layer.points){
      layer.points.forEach(point => {
        point.x += dx;
        point.y += dy;
      });
      layer.maskDirty = true;
    }
  }

  function scaleLayerFromBounds(layer,startLayer,startBounds,newWidth,newHeight,uniformStroke=false){
    const sx = newWidth/Math.max(1,startBounds.w);
    const sy = uniformStroke ? sx : newHeight/Math.max(1,startBounds.h);

    if(layer.type === "image"){
      // Follow the axis with the larger relative change, including shrinking
      // on only one axis; the other axis follows the image's aspect ratio.
      const desired = Math.abs(sx-1) >= Math.abs(sy-1) ? sx : sy;
      const ratio = Math.min(
        desired,
        Math.max(2,baseCanvas.width-startBounds.x)/Math.max(1,startLayer.w),
        Math.max(2,baseCanvas.height-startBounds.y)/Math.max(1,startLayer.h)
      );
      layer.x = startBounds.x;
      layer.y = startBounds.y;
      layer.w = startLayer.w*ratio;
      layer.h = startLayer.h*ratio;
    }else if(RECT_TYPES.includes(layer.type)){
      layer.x = startBounds.x;
      layer.y = startBounds.y;
      layer.w = Math.max(2,startLayer.w*sx);
      layer.h = Math.max(2,startLayer.h*sy);
    }else if(layer.type === "text"){
      layer.x = startLayer.x;
      layer.y = startLayer.y;
      const pad = startLayer.bgTransparent === false ? 8
        : startLayer.outline ? annotationStyle.TEXT_OUTLINE_WIDTH : 0;
      layer.textWidth = Math.max(2,newWidth-pad);
    }else if(drawing.isLine(layer)){
      layer.x1 = startBounds.x+(startLayer.x1-startBounds.x)*sx;
      layer.y1 = startBounds.y+(startLayer.y1-startBounds.y)*sy;
      layer.x2 = startBounds.x+(startLayer.x2-startBounds.x)*sx;
      layer.y2 = startBounds.y+(startLayer.y2-startBounds.y)*sy;
      layer.lineWidth = clamp(
        startLayer.lineWidth*Math.max(sx,sy),
        1,
        100
      );
    }else if(layer.points){
      layer.points = startLayer.points.map(point => ({
        x:startBounds.x+(point.x-startBounds.x)*sx,
        y:startBounds.y+(point.y-startBounds.y)*sy
      }));
      layer.brushSize = uniformStroke ? startLayer.brushSize*sx : clamp(
        startLayer.brushSize*Math.max(sx,sy),
        5,
        500
      );
      layer.maskDirty = true;
    }
  }

  function drawArrow(context,layer){
    annotationStyle.drawArrow(context,layer);
  }

  function buildMosaicCanvas(source,blockSize){
    const safeBlock = clamp(Math.round(blockSize),4,200);
    const smallWidth = Math.max(1,Math.ceil(source.width/safeBlock));
    const smallHeight = Math.max(1,Math.ceil(source.height/safeBlock));

    const small = document.createElement("canvas");
    small.width = smallWidth;
    small.height = smallHeight;

    const smallContext = small.getContext("2d");
    smallContext.imageSmoothingEnabled = true;
    smallContext.imageSmoothingQuality = "low";
    // 半透明PNGでも元の細部がモザイク越しに透けないよう、加工素材だけ白合成する。
    smallContext.fillStyle = "#ffffff";
    smallContext.fillRect(0,0,smallWidth,smallHeight);
    smallContext.drawImage(source,0,0,smallWidth,smallHeight);

    const mosaic = createCanvas(source.width,source.height);
    const mosaicContext = mosaic.getContext("2d");
    mosaicContext.imageSmoothingEnabled = false;
    mosaicContext.drawImage(
      small,
      0,0,smallWidth,smallHeight,
      0,0,source.width,source.height
    );

    return mosaic;
  }

  function getMosaicCanvas(blockSize,source=baseCanvas){
    const size = clamp(Math.round(blockSize),4,200);
    if(source !== baseCanvas){
      // 注釈・画像の移動や書式の連続変更中も、直前までの合成内容を使う。
      state.mosaicCache.clear();
      return buildMosaicCanvas(source,size);
    }
    const key = `${state.baseRevision}:${size}`;

    if(!state.mosaicCache.has(key)){
      // スライダー操作で全寸法canvasをサイズの数だけ保持しない。
      state.mosaicCache.clear();
      state.mosaicCache.set(key,buildMosaicCanvas(source,size));
    }

    return state.mosaicCache.get(key);
  }

  function traceBrush(context,layer){
    if(!layer.points || !layer.points.length) return;

    context.beginPath();

    if(layer.points.length === 1){
      context.arc(
        layer.points[0].x,
        layer.points[0].y,
        layer.brushSize/2,
        0,
        Math.PI*2
      );
      context.fill();
      return;
    }

    context.moveTo(layer.points[0].x,layer.points[0].y);
    for(let index=1; index<layer.points.length; index++){
      context.lineTo(layer.points[index].x,layer.points[index].y);
    }

    context.lineCap = "round";
    context.lineJoin = "round";
    context.lineWidth = layer.brushSize;
    context.stroke();
  }


  function drawMosaicBrush(context,layer,mosaic){
    if(!layer.points || !layer.points.length) return;

    const bounds = layerBounds(layer);

    const left = clamp(
        Math.floor(bounds.x),
        0,
        mosaic.width
    );
    const top = clamp(
        Math.floor(bounds.y),
        0,
        mosaic.height
    );
    const right = clamp(
        Math.ceil(bounds.x+bounds.w),
        0,
        mosaic.width
    );
    const bottom = clamp(
        Math.ceil(bounds.y+bounds.h),
        0,
        mosaic.height
    );

    const width = right-left;
    const height = bottom-top;

    if(width < 1 || height < 1) return;

    const clipped = document.createElement("canvas");
    clipped.width = width;
    clipped.height = height;

    const clippedContext = clipped.getContext("2d");
    if(!clippedContext) return;

    clippedContext.drawImage(
        mosaic,
        left,
        top,
        width,
        height,
        0,
        0,
        width,
        height
    );

    clippedContext.globalCompositeOperation = "destination-in";
    clippedContext.fillStyle = "#fff";
    clippedContext.strokeStyle = "#fff";
    clippedContext.lineCap = "round";
    clippedContext.lineJoin = "round";
    clippedContext.lineWidth = layer.brushSize;

    if(layer.points.length === 1){
        clippedContext.beginPath();
        clippedContext.arc(
        layer.points[0].x-left,
        layer.points[0].y-top,
        layer.brushSize/2,
        0,
        Math.PI*2
        );
        clippedContext.fill();
    }else{
        clippedContext.beginPath();
        clippedContext.moveTo(
        layer.points[0].x-left,
        layer.points[0].y-top
        );

        for(let index=1; index<layer.points.length; index++){
        clippedContext.lineTo(
            layer.points[index].x-left,
            layer.points[index].y-top
        );
        }

        clippedContext.stroke();
    }

    clippedContext.globalCompositeOperation = "source-over";
    context.drawImage(clipped,left,top);
  }


  function updateCropControls(){
    const valid = state.tool === "crop" && !!state.crop &&
      Math.round(state.crop.w) >= 1 && Math.round(state.crop.h) >= 1;
    $("applyCrop").disabled = !valid;
    $("centerCrop").disabled = !valid;
  }

  function layerForStylePreview(layer){
    return fontPreview?.ids.has(layer.id) ? {...layer,fontFamily:fontPreview.key} : layer;
  }

  function drawLayer(context,layer,mosaicSource=baseCanvas){
    // 保存用の合成では一時フォント候補を採用しない。
    if(context === layerContext || context === editContext) layer = layerForStylePreview(layer);
    context.save();
    let temporaryMosaic = null;
    try{

    if(layer.type === "image"){
      context.globalAlpha = clamp(Number.isFinite(layer.opacity) ? layer.opacity : 100,0,100)/100;
      context.drawImage(layer.imageCanvas,layer.x,layer.y,layer.w,layer.h);
    }else if(layer.type === "blackoutRect"){
      context.fillStyle = "#000";
      context.fillRect(layer.x,layer.y,layer.w,layer.h);
    }else if(layer.type === "mosaicRect"){
      const mosaic = getMosaicCanvas(layer.mosaicSize,mosaicSource);
      if(mosaicSource !== baseCanvas) temporaryMosaic = mosaic;
      const sourceX = clamp(Math.floor(layer.x),0,baseCanvas.width);
      const sourceY = clamp(Math.floor(layer.y),0,baseCanvas.height);
      const sourceRight = clamp(Math.ceil(layer.x+layer.w),0,baseCanvas.width);
      const sourceBottom = clamp(Math.ceil(layer.y+layer.h),0,baseCanvas.height);
      const width = sourceRight-sourceX;
      const height = sourceBottom-sourceY;

      if(width > 0 && height > 0){
        context.drawImage(
          mosaic,
          sourceX,sourceY,width,height,
          sourceX,sourceY,width,height
        );
      }
    }else if(layer.type === "blackoutBrush"){
      context.fillStyle = "#000";
      context.strokeStyle = "#000";
      traceBrush(context,layer);
    }else if(layer.type === "mosaicBrush"){
      const mosaic = getMosaicCanvas(layer.mosaicSize,mosaicSource);
      if(mosaicSource !== baseCanvas) temporaryMosaic = mosaic;
      drawMosaicBrush(context,layer,mosaic);
    }else if(layer.type === "text"){
      annotationStyle.drawText(context,layer);
    }else if(["rect","ellipse","line"].includes(layer.type)){
      annotationStyle.drawShape(context,layer);
    }else if(layer.type === "arrow"){
      context.strokeStyle = layer.color;
      context.fillStyle = layer.color;
      context.lineWidth = layer.lineWidth;
      context.lineCap = "round";
      drawArrow(context,layer);
    }else if(layer.type === "ink"){
      context.fillStyle = layer.color;
      context.strokeStyle = layer.color;
      traceBrush(context,layer);
    }

    }finally{
      context.restore();
      if(temporaryMosaic){temporaryMosaic.width = 0;temporaryMosaic.height = 0;}
    }
  }

  function compositeCanvas(){
    const output = cloneCanvas(baseCanvas);
    const context = output.getContext("2d");

    state.layers.forEach(layer => {
      if(layer.visible !== false){
        drawLayer(context,layer,output);
      }
    });

    return output;
  }

  function drawCropOverlay(){
    editContext.save();
    editContext.fillStyle = state.crop ? "rgba(0,0,0,.48)" : "rgba(0,0,0,.28)";
    editContext.fillRect(0,0,editCanvas.width,editCanvas.height);
    if(!state.crop){
      editContext.restore();
      return;
    }

    const crop = state.crop;
    const scale = displayScale();
    const handleSize = 7*scale;

    editContext.clearRect(crop.x,crop.y,crop.w,crop.h);
    editContext.strokeStyle = "#fff";
    editContext.lineWidth = Math.max(1.5,2*scale);
    editContext.strokeRect(crop.x,crop.y,crop.w,crop.h);

    const handles = cropHandles(crop);
    Object.values(handles).forEach(point => {
      editContext.fillStyle = "#fff";
      editContext.strokeStyle = "#9a721b";
      editContext.lineWidth = Math.max(1,scale);
      editContext.fillRect(
        point.x-handleSize,
        point.y-handleSize,
        handleSize*2,
        handleSize*2
      );
      editContext.strokeRect(
        point.x-handleSize,
        point.y-handleSize,
        handleSize*2,
        handleSize*2
      );
    });

    editContext.restore();
  }

  function drawSelection(){
    if(state.textEditing) return;
    const selected = selectedLayers();
    const layers = selected.filter(layer => layer.visible !== false);
    if(!layers.length) return;
    const scale = displayScale();
    const handle = 7*scale;

    editContext.save();
    editContext.strokeStyle = "#9a721b";
    editContext.lineWidth =
        Math.max(1.5,2*scale);
    editContext.setLineDash([
        7*scale,
        5*scale
    ]);

    layers.forEach(layer => {
      const bounds = layerBounds(layer);
      editContext.strokeRect(bounds.x,bounds.y,bounds.w,bounds.h);
    });

    if(selected.length !== 1){
      editContext.restore();
      return;
    }
    const layer = layers[0];
    const bounds = layerBounds(layer);

    editContext.setLineDash([]);
    editContext.fillStyle = "#fff";
    editContext.strokeStyle = "#9a721b";

    if(drawing.isLine(layer)){
      [{x:layer.x1,y:layer.y1},{x:layer.x2,y:layer.y2}].forEach(point => {
        editContext.fillRect(point.x-handle,point.y-handle,handle*2,handle*2);
        editContext.strokeRect(point.x-handle,point.y-handle,handle*2,handle*2);
      });
      editContext.restore();
      return;
    }

    editContext.fillRect(
        bounds.x+bounds.w-handle,
        bounds.y+bounds.h-handle,
        handle*2,
        handle*2
    );

    editContext.strokeRect(
        bounds.x+bounds.w-handle,
        bounds.y+bounds.h-handle,
        handle*2,
        handle*2
    );

    editContext.restore();
  }

  function drawSelectionRectangle(drag){
    if(!drag.active) return;
    const rectangle = normalizeRectangle(drag.start,drag.last);
    const scale = displayScale();
    editContext.save();
    editContext.fillStyle = "rgba(154,114,27,.12)";
    editContext.strokeStyle = "#9a721b";
    editContext.lineWidth = 1.5*scale;
    editContext.setLineDash([5*scale,3*scale]);
    editContext.fillRect(rectangle.x,rectangle.y,rectangle.w,rectangle.h);
    editContext.strokeRect(rectangle.x,rectangle.y,rectangle.w,rectangle.h);
    editContext.restore();
  }


  function drawShapePreview(drag){
    const style = currentStyle();
    const point = drag.last;
    const rectangle =
        drawing.drawingBox(drag.start,point,{width:baseCanvas.width,height:baseCanvas.height},
          ["rect","ellipse"].includes(drag.tool) && drag.constrained);

    editContext.save();
    editContext.globalAlpha = .8;
    editContext.strokeStyle = style.color;
    editContext.fillStyle = style.color;
    editContext.lineWidth = style.lineWidth;
    editContext.lineCap = "round";

    if(drag.tool === "blackoutRect"){
        editContext.fillStyle =
        "rgba(0,0,0,.65)";

        editContext.fillRect(
        rectangle.x,
        rectangle.y,
        rectangle.w,
        rectangle.h
        );
    }else if(drag.tool === "mosaicRect"){
        editContext.strokeStyle = "#9a721b";
        editContext.setLineDash([8,6]);

        editContext.strokeRect(
        rectangle.x,
        rectangle.y,
        rectangle.w,
        rectangle.h
        );
    }else if(["rect","ellipse"].includes(drag.tool)){
        drawLayer(editContext,{type:drag.tool,...rectangle,...style});
    }else if(["line","arrow"].includes(drag.tool)){
        const end = drawing.constrainedLinePoint(drag.start,point,drag.axisLocked);
        drawLayer(editContext,{
        type:drag.tool,
        ...style,
        x1:drag.start.x,
        y1:drag.start.y,
        x2:end.x,
        y2:end.y
        });
    }

    editContext.restore();
  }

  function renderEditor(){
    editContext.clearRect(
        0,
        0,
        editCanvas.width,
        editCanvas.height
    );

    if(state.tool === "crop" && state.sourceFile && editCanvas.width > 0 && editCanvas.height > 0){
        drawCropOverlay();
    }

    if(state.drag?.mode === "shape"){
        drawShapePreview(state.drag);
    }

    if(state.tool === "select"){
        drawSelection();
        if(state.drag?.mode === "marquee") drawSelectionRectangle(state.drag);
    }

    updateCropControls();
    syncTextEditor();
  }



  function typeLabel(type){
    return {
      blackoutRect:"黒塗り範囲",
      mosaicRect:"モザイク範囲",
      blackoutBrush:"黒塗りブラシ",
      mosaicBrush:"モザイクブラシ",
      text:"文字",
      rect:"四角形",
      ellipse:"円",
      arrow:"矢印",
      line:"直線",
      ink:"手書き",
      inkEraser:"手書き消しゴム",
      image:"追加画像"
    }[type] || type;
  }

  function updateSelectedControls(){
    // Apply the final selection's controls after pointer-up/cancel, keeping
    // control and work-area changes out of an active gesture.
    if(state.drag) return;
    const layers = selectedLayers();
    const layer = selectedLayer();
    const actions = $("editorActions");
    actions.classList.toggle("hidden",!layers.length);
    actions.inert = !layers.length;
    actions.setAttribute("aria-hidden",String(!layers.length));
    if($("frontLayer")) $("frontLayer").disabled = !layers.length;
    if($("backLayer")) $("backLayer").disabled = !layers.length;
    const contextType = state.tool === "select" ? layer?.type : state.tool;
    const types = state.tool === "select" ? new Set(layers.map(item => item.type)) : new Set([state.tool]);
    const selectedTexts = layers.filter(item => item.type === "text");
    if(fontPreview && (state.tool !== "select" || selectedTexts.some(item => !fontPreview.ids.has(item.id)) || fontPreview.ids.size !== selectedTexts.length)) fontPreview = null;
    if(state.tool !== "select"){
      const defaults = currentStyle();
      for(const [id,property] of Object.entries(styleFieldProperties)){
        const field = $(id);
        if(!field || field.dataset.mixed !== "true") continue;
        field.dataset.mixed = "false";
        field.title = "";
        field.placeholder = "";
        if(field.type === "checkbox"){
          field.indeterminate = false;
          field.checked = property === "outline" ? toolOutlinePreferences.get(state.tool) ?? true
            : !!annotationStyle.valueForField({},property);
        }else field.value = defaults[property] ?? "";
      }
    }
    const fields = new Set();
    for(const type of types){
      if([...BRUSH_TYPES,"ink","inkEraser"].includes(type)) fields.add("brush");
      if(type === "ink") fields.add("ink");
      if(["mosaicRect","mosaicBrush"].includes(type)) fields.add("mosaic");
      if(type === "text") fields.add("text");
      if(["text","rect","ellipse","arrow","line","ink"].includes(type)) fields.add("color");
      if(["rect","ellipse","arrow","line"].includes(type)) fields.add("line");
      if(["text","arrow","line","rect","ellipse"].includes(type)) fields.add("outline");
      if(["rect","ellipse"].includes(type)) fields.add("fill");
      if(type === "image") fields.add("image");
    }

    $$("[data-settings]").forEach(element => {
      element.classList.toggle("hidden",!fields.has(element.dataset.settings));
    });
    $$("[data-context]").forEach(element => {
      element.classList.toggle("hidden",element.dataset.context !== contextType);
    });
    const title = $("contextTitle");
    const colorTypes = [...types].filter(type => ["text","ink","rect","ellipse","arrow","line"].includes(type));
    const colorLabel = colorTypes.length && colorTypes.every(type => type === "text") ? "テキスト"
      : colorTypes.length && colorTypes.every(type => ["rect","ellipse","arrow","line"].includes(type)) ? "枠" : "色";
    $("annotationColorLabel").textContent = colorLabel;
    $("annotationColor").setAttribute("aria-label",colorLabel === "色" ? "文字・図形・手書きの色" : `${colorLabel}の色`);
    const mixedFill = fields.has("text") && fields.has("fill");
    $("textFillLabel").textContent = mixedFill ? "文字の塗り" : "塗り";
    $("shapeFillLabel").textContent = mixedFill ? "図形の塗り" : "塗り";
    const showPanel = fields.size > 0 || layers.length > 0 || ["crop","transform"].includes(contextType);
    const panel = $("contextPanel");
    panel.classList.toggle("hidden",!showPanel);
    panel.inert = !showPanel;
    panel.setAttribute("aria-hidden",String(!showPanel));
    if(title){
      title.textContent = layers.length && state.tool === "select"
        ? layers.length > 1 ? `${layers.length}個` : typeLabel(layer.type)
        : contextType === "crop" ? "トリミング"
        : contextType === "transform" ? "サイズ"
        : contextType && contextType !== "select" && contextType !== "pan"
          ? typeLabel(contextType) : "";
    }
    scheduleDisplayResize();

    syncFontSizeButtons();
    if(!layers.length || state.tool !== "select") return;

    for(const [id,property] of Object.entries(styleFieldProperties)){
      const field = $(id);
      if(!field) continue;
      const common = annotationStyle.commonFieldValue(layers,property);
      if(!common.eligible.length) continue;
      const mixed = common.mixed;
      field.dataset.mixed = String(mixed);
      field.title = mixed ? "選択対象で値が異なります。変更した項目だけが反映されます。" : "";
      if(field.type === "checkbox"){
        field.indeterminate = mixed;
        field.checked = mixed ? false : !!common.value;
      }else{
        field.placeholder = mixed ? "複数の値" : "";
        // color入力には空値を指定できないため、先頭の色とmixed表示を併用する。
        const value = mixed && field.type !== "color" ? "" : common.value;
        if(field.value !== String(value ?? "")) field.value = value ?? "";
      }
    }
  }

  function setTool(tool){
    if(state.textEditing) finishTextEditing();
    if(toolOutlinePreferences.has(state.tool)){
      toolOutlinePreferences.set(state.tool,$("whiteOutline").checked);
    }
    const leavingCrop =
        state.tool === "crop" &&
        tool !== "crop";

    if(state.drag) cancelSelectionGesture();
    state.tool = tool;
    if(toolOutlinePreferences.has(tool)) $("whiteOutline").checked = toolOutlinePreferences.get(tool);
    state.drag = null;
    state.textEditing = null;
    styleEditSession = null;
    if(tool !== "select") selectLayers([]);

    if(leavingCrop){
        state.crop = null;
        syncCropInputs();
    }

    $$(".tool[data-tool]").forEach(button => {
        button.classList.toggle(
        "active",
        button.dataset.tool === tool
        );
        button.setAttribute("aria-pressed",String(button.dataset.tool === tool));
    });

    editCanvas.classList.toggle(
        "select-mode",
        tool === "select"
    );
    $("canvasViewport").classList.toggle("pan-mode",tool === "pan");

    renderLayers();
    renderEditor();
    updateSelectedControls();
    syncEditorChrome();
    scheduleDisplayResize();
  }


  function readNumber(id,min,max,fallback){
    if(!$(id) || $(id).value === "") return fallback;
    const value = Number($(id).value);
    return Number.isFinite(value)
      ? clamp(value,min,max)
      : fallback;
  }

  function currentStyle(){
    return {
      color:$("annotationColor").value,
      fontSize:readNumber("fontSize",8,300,42),
      fontFamily:annotationStyle.safeFontFamily($("fontFamily")?.value),
      bold:$("boldText")?.checked ?? true,
      textWidth:300,
      bgColor:$("textBgColor")?.value || "#ffffff",
      bgTransparent:$("textBgTransparent")?.checked ?? true,
      outline:$("whiteOutline")?.checked ?? true,
      fill:$("shapeFill")?.value || "#ffff00",
      fillNone:$("shapeFillNone")?.checked ?? true,
      lineWidth:readNumber("lineWidth",1,100,8),
      brushSize:readNumber("brushSize",5,500,50),
      mosaicSize:readNumber("mosaicSize",4,200,18),
      inkStabilizer:$("inkStabilizer")?.value || "none",
      opacity:readNumber("imageOpacity",0,100,100)
    };
  }

  function cloneLayerForGesture(layer){
    return {
      ...layer,
      points:layer.points
        ? layer.points.map(point => ({...point}))
        : undefined
    };
  }

  function isEditingTarget(target){
    return !!target && (
      target.isContentEditable ||
      !!target.closest?.("input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox']")
    );
  }

  function isObjectShortcutBlocked(event,includeDrag=true){
    return event.defaultPrevented || event.isComposing || event.keyCode === 229 || state.composing || state.singleBusy ||
      !!viewState.pan ||
      (includeDrag && !!state.drag) || !!state.textEditing || $("singlePanel").hidden ||
      !$("previewDialog").classList.contains("hidden") ||
      !$("saveDialog").classList.contains("hidden") ||
      !!document.querySelector("#stampDialog:not(.hidden)") ||
      !!document.querySelector("#objectMenu:not([hidden]):not(.hidden)") ||
      !!document.querySelector("dialog[open]") ||
      isEditingTarget(event.target) || isEditingTarget(document.activeElement);
  }

  function deleteSelectedLayer(){
    const layers = selectedLayers();
    if(!layers.length || state.singleBusy || state.drag) return false;
    const ids = new Set(layers.map(layer => layer.id));
    pushHistory("layers");
    state.layers = state.layers.filter(item => !ids.has(item.id));
    selectLayers([]);
    renderLayers();
    renderEditor();
    updateSelectedControls();
    return true;
  }

  function syncTextEditor(){
    if(!textEditSession || textEditor.hidden) return;
    const layer = state.layers.find(item => item.id === textEditSession.id);
    if(!layer) return;
    if(!textEditorRule){
      const sheet = [...document.styleSheets].find(item => item.href &&
        new URL(item.href,document.baseURI).pathname.endsWith("/image.css"));
      if(!sheet) return;
      const index = sheet.insertRule("#textEditor {}",sheet.cssRules.length);
      textEditorRule = sheet.cssRules[index];
      const hostIndex = sheet.insertRule("#textEditorHost {}",sheet.cssRules.length);
      textEditorHostRule = sheet.cssRules[hostIndex];
    }
    const box = annotationStyle.editingTextBox(editContext,layer);
    const scale = 1/displayScale();
    const style = textEditorRule.style;
    const hostStyle = textEditorHostRule.style;
    hostStyle.left = `${box.left*scale}px`;
    hostStyle.top = `${box.top*scale}px`;
    hostStyle.width = `${(box.width+2)*scale}px`;
    hostStyle.height = `${box.height*scale}px`;
    style.width = `${box.width}px`;
    style.height = `${box.height}px`;
    style.font = annotationStyle.fontFor(layer);
    style.lineHeight = String(box.lineHeight/layer.fontSize);
    style.transform = `scale(${scale})`;
    style.setProperty("--editing-text-color",layer.color || "#111111");
    // Native textarea handles IME, selection, clipboard and its own undo.
    // Canvas remains the visible text and export source; only its caret and
    // selection are drawn by the transparent textarea.
    textEditor.scrollTop = 0;
    textEditor.scrollLeft = 0;
  }

  function applyInlineTextInput(){
    if(!textEditSession) return;
    const layer = state.layers.find(item => item.id === textEditSession.id);
    if(!layer) return;
    const text = textEditor.value.replace(/\r\n?/g,"\n");
    if(text === layer.text) return;
    if(!textEditSession.historyPushed){
      textEditSession.undoBefore = state.undo.slice();
      textEditSession.redoBefore = state.redo.slice();
      textEditSession.beforeRevision = state.revision;
      pushHistory("layers");
      textEditSession.historyPushed = true;
    }
    layer.text = text;
    renderLayers();
    renderEditor();

  }

  function finishTextEditing(focusCanvas=false){
    if(!textEditSession) return;
    applyInlineTextInput();
    const session = textEditSession;
    const layer = state.layers.find(item => item.id === session.id);
    textEditSession = null;
    state.textEditing = null;
    textEditor.hidden = true;
    textEditorHost.hidden = true;
    if(session.historyPushed && layer?.text === session.originalText){
      state.undo = session.undoBefore;
      state.redo = session.redoBefore;
      state.revision = session.beforeRevision;
      updateHistoryButtons();
    }
    renderLayers();
    renderEditor();
    updateSelectedControls();
    if(focusCanvas) editCanvas.focus({preventScroll:true});
  }

  function beginTextEditing(layer,point=null){
    if(!layer || layer.type !== "text" || state.singleBusy) return;
    selectLayers([layer]);
    setTool("select");
    textEditSession = {id:layer.id,originalText:layer.text || "",historyPushed:false};
    state.textEditing = layer.id;
    textEditor.value = layer.text || "";
    textEditor.hidden = false;
    textEditorHost.hidden = false;
    renderEditor();
    updateSelectedControls();
    textEditor.focus({preventScroll:true});
    const position = point ? annotationStyle.textCaretIndex(editContext,layer,point) : textEditor.value.length;
    textEditor.setSelectionRange(position,position);
  }

  textEditor.addEventListener("input",applyInlineTextInput);
  textEditor.addEventListener("blur",() => {
    if(!textEditSession) return;
    if(state.composing){textEditSession.finishAfterComposition = true;return;}
    finishTextEditing();
  });
  textEditor.addEventListener("compositionend",() => {
    state.composing = false;
    applyInlineTextInput();
    if(textEditSession?.finishAfterComposition) finishTextEditing();
  });
  textEditor.addEventListener("keydown",event => {
    if(event.isComposing || state.composing || event.keyCode === 229) return;
    const command = event.ctrlKey || event.metaKey;
    if(event.key === "Escape" || (command && event.key === "Enter")){
      event.preventDefault();event.stopPropagation();finishTextEditing(true);
    }else if(command && event.key.toLowerCase() === "s"){
      event.preventDefault();event.stopPropagation();finishTextEditing(true);openSaveSettings();
    }
  });
  document.addEventListener("pointerdown",event => {
    if(textEditSession && !textEditorHost.contains(event.target) && !state.composing) finishTextEditing(true);
  },true);

  function pasteCopiedLayer(event){
    if(!objectClipboard || !baseCanvas.width || isObjectShortcutBlocked(event)) return false;
    const data = event.clipboardData;
    if(!data) return false;
    let token = "";
    let plainText = "";
    try{token = data.getData(OBJECT_CLIPBOARD_TYPE);}catch(error){/* Try plain text below. */}
    try{plainText = data.getData("text/plain");}catch(error){return false;}
    // Some browsers omit custom clipboard types. The plain-text fallback must
    // still match the last object copy, so unrelated text does not paste it.
    if(token ? token !== objectClipboardToken : !plainText || plainText !== objectClipboardText){
      return false;
    }
    return pasteObjectClipboard(event);
  }

  function pasteObjectClipboard(event=null){
    if(!objectClipboard || !baseCanvas.width || state.singleBusy || state.drag) return false;
    if(drawing.imageInkPointCount(state.layers)+drawing.imageInkPointCount(objectClipboard) > drawing.MAX_IMAGE_INK_POINTS){
      toast("手書きの点数が上限を超えるため貼り付けできません。不要な手書きを削除してください。");
      return false;
    }
    const layers = cloneLayers(objectClipboard);
    layers.forEach(layer => {layer.id = makeId();});
    objectPasteCount++;
    const offset = 24*objectPasteCount;
    const bounds = layersBounds(layers);
    const dx = bounds.x+bounds.w+offset <= baseCanvas.width ? offset : -offset;
    const dy = bounds.y+bounds.h+offset <= baseCanvas.height ? offset : -offset;
    const translation = clampBoundsTranslation(bounds,dx,dy);
    layers.forEach(layer => moveLayerRaw(layer,translation.dx,translation.dy));
    pushHistory("layers");
    state.layers.push(...layers);
    selectLayers(layers);
    setTool("select");
    updateSelectedControls();
    editCanvas.focus({preventScroll:true});
    event?.preventDefault();
    return true;
  }

  function copySelectedLayers(data=null){
    const layers = selectedLayers();
    if(!layers.length || state.singleBusy || state.drag) return false;
    const token = makeId();
    const layer = layers[0];
    const plainText = layers.length === 1 && layer.type === "text" && layer.text
      ? layer.text : layers.length === 1 ? `AppBox: ${typeLabel(layer.type)}`
      : `AppBox: ${layers.length}個のオブジェクト`;
    if(data){
      try{data.setData("text/plain",plainText);}catch(error){return false;}
      try{data.setData(OBJECT_CLIPBOARD_TYPE,token);}catch(error){/* Plain text fallback. */}
    }
    objectClipboard = cloneLayers(layers);
    objectClipboardToken = token;
    objectClipboardText = plainText;
    objectPasteCount = 0;
    return true;
  }

  function reorderSelectedLayers(front){
    if(state.singleBusy || state.drag) return;
    const ids = new Set(selectedLayers().map(layer => layer.id));
    if(!ids.size) return;
    const selected = state.layers.filter(layer => ids.has(layer.id));
    const others = state.layers.filter(layer => !ids.has(layer.id));
    const result = front ? [...others,...selected] : [...selected,...others];
    if(result.every((layer,index) => layer === state.layers[index])) return;
    pushHistory("layers");
    state.layers = result;
    renderLayers();
    renderEditor();
    updateSelectedControls();
  }

  function nudgeSelectedLayers(dx,dy){
    const layers = selectedLayers();
    if(!layers.length) return false;
    const translation = clampBoundsTranslation(layersBounds(layers),dx,dy);
    if(!translation.dx && !translation.dy) return true;
    pushHistory("layers");
    layers.forEach(layer => moveLayerRaw(layer,translation.dx,translation.dy));
    renderLayers();
    renderEditor();
    updateSelectedControls();
    return true;
  }

  document.addEventListener("compositionstart",() => {state.composing = true;});
  document.addEventListener("compositionend",() => {state.composing = false;});
  document.addEventListener("keydown",event => {
    if(event.key === "Escape" && !isObjectShortcutBlocked(event,false) && state.drag){
      cancelSelectionGesture();
      selectLayers([]);
      setTool("select");
      updateSelectedControls();
      event.preventDefault();
      return;
    }
    if(isObjectShortcutBlocked(event) || event.altKey) return;
    if(event.ctrlKey || event.metaKey){
      const key = event.key.toLowerCase();
      if(key === "z"){
        (event.shiftKey ? redo : undo)();
        event.preventDefault();
      }else if(key === "y"){
        redo();event.preventDefault();
      }else if(key === "s" && state.originalCanvas){
        openSaveSettings();event.preventDefault();
      }else if(key === "a" && state.originalCanvas){
        selectLayers(state.layers.filter(layer => layer.visible));
        setTool("select");updateSelectedControls();event.preventDefault();
      }
      return;
    }
    const direction = {ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[event.key];
    if(direction && nudgeSelectedLayers(direction[0]*(event.shiftKey ? 10 : 1),direction[1]*(event.shiftKey ? 10 : 1))){
      event.preventDefault();return;
    }
    if(["Backspace","Delete"].includes(event.key) && deleteSelectedLayer()){
      event.preventDefault();
    }
    if(event.key === "Escape" && selectedLayers().length){
      selectLayers([]);
      renderEditor();
      updateSelectedControls();
      event.preventDefault();
    }
  });
  document.addEventListener("copy",event => {
    if(isObjectShortcutBlocked(event)) return;
    if(!event.clipboardData) return;
    // Preserve copying ordinary selected page text as well as form text.
    if(window.getSelection?.()?.toString()) return;
    if(copySelectedLayers(event.clipboardData)) event.preventDefault();
  });

  function cropRatioValue(){
    const value = $("cropRatio").value;

    if(value === "free") return null;
    if(value === "original"){
      return state.originalCanvas
        ? state.originalCanvas.width/state.originalCanvas.height
        : baseCanvas.width/baseCanvas.height;
    }
    if(value === "1") return 1;

    const parts = value.split(":").map(Number);
    return parts[0]/parts[1];
  }

  function fitDragPointToRatio(start,point,ratio){
    if(!ratio) return point;

    const signX = point.x >= start.x ? 1 : -1;
    const signY = point.y >= start.y ? 1 : -1;
    const maxWidth = signX > 0 ? baseCanvas.width-start.x : start.x;
    const maxHeight = signY > 0 ? baseCanvas.height-start.y : start.y;

    let width = Math.abs(point.x-start.x);
    let height = Math.abs(point.y-start.y);

    if(width === 0 && height === 0) return point;

    if(height === 0 || width/Math.max(height,.0001) > ratio){
      height = width/ratio;
    }else{
      width = height*ratio;
    }

    const scale = Math.min(
      1,
      maxWidth/Math.max(width,.0001),
      maxHeight/Math.max(height,.0001)
    );

    width *= scale;
    height *= scale;

    return {
      x:start.x+signX*width,
      y:start.y+signY*height
    };
  }

  function cropHandles(rectangle){
    return {
      nw:{x:rectangle.x,y:rectangle.y},
      ne:{x:rectangle.x+rectangle.w,y:rectangle.y},
      se:{x:rectangle.x+rectangle.w,y:rectangle.y+rectangle.h},
      sw:{x:rectangle.x,y:rectangle.y+rectangle.h}
    };
  }

  function cropHit(point){
    if(!state.crop) return "new";

    const hitSize = 14*displayScale();
    const handles = cropHandles(state.crop);

    for(const [name,handle] of Object.entries(handles)){
      if(
        Math.abs(point.x-handle.x) <= hitSize &&
        Math.abs(point.y-handle.y) <= hitSize
      ){
        return name;
      }
    }

    if(
      point.x >= state.crop.x &&
      point.x <= state.crop.x+state.crop.w &&
      point.y >= state.crop.y &&
      point.y <= state.crop.y+state.crop.h
    ){
      return "move";
    }

    return "new";
  }

  function moveCrop(base,point,start){
    const dx = point.x-start.x;
    const dy = point.y-start.y;

    return {
      x:clamp(base.x+dx,0,baseCanvas.width-base.w),
      y:clamp(base.y+dy,0,baseCanvas.height-base.h),
      w:base.w,
      h:base.h
    };
  }

  function resizeCropFromCorner(base,handle,point){
    const ratio = cropRatioValue();
    let anchor;

    if(handle === "nw"){
      anchor = {x:base.x+base.w,y:base.y+base.h};
    }else if(handle === "ne"){
      anchor = {x:base.x,y:base.y+base.h};
    }else if(handle === "se"){
      anchor = {x:base.x,y:base.y};
    }else{
      anchor = {x:base.x+base.w,y:base.y};
    }

    const fitted = fitDragPointToRatio(anchor,point,ratio);
    const rectangle = normalizeRectangle(anchor,fitted);

    return {
      x:clamp(rectangle.x,0,baseCanvas.width-1),
      y:clamp(rectangle.y,0,baseCanvas.height-1),
      w:clamp(rectangle.w,1,baseCanvas.width-rectangle.x),
      h:clamp(rectangle.h,1,baseCanvas.height-rectangle.y)
    };
  }

  function updateCropGesture(drag,point){
    drag.last = point;
    if(drag.action === "move" && drag.base){
      state.crop = moveCrop(drag.base,point,drag.start);
    }else if(["nw","ne","se","sw"].includes(drag.action) && drag.base){
      state.crop = resizeCropFromCorner(drag.base,drag.action,point);
    }else{
      if(!drag.active && Math.hypot(point.x-drag.start.x,point.y-drag.start.y) < drag.threshold) return;
      drag.active = true;
      const fitted = fitDragPointToRatio(drag.start,point,cropRatioValue());
      state.crop = normalizeRectangle(drag.start,fitted);
    }
    syncCropInputs();
  }

  function updateSelectionRectangle(drag,point){
    drag.last = point;
    if(Math.hypot(point.x-drag.start.x,point.y-drag.start.y) >= drag.threshold){
      drag.active = true;
    }
    if(!drag.active) return;
    const rectangle = normalizeRectangle(drag.start,point);
    const hits = state.layers.filter(layer => {
      if(layer.visible === false) return false;
      const bounds = layerBounds(layer);
      return bounds.x < rectangle.x+rectangle.w && bounds.x+bounds.w > rectangle.x &&
        bounds.y < rectangle.y+rectangle.h && bounds.y+bounds.h > rectangle.y;
    });
    const ids = new Set([...drag.additiveIds,...hits.map(layer => layer.id)]);
    selectLayers(state.layers.filter(layer => ids.has(layer.id)));
  }

  function updateLayerMove(drag,point){
    if(Math.hypot(point.x-drag.start.x,point.y-drag.start.y) < drag.threshold && !drag.changed){
      return;
    }
    const translation = clampBoundsTranslation(drag.bounds,
      point.x-drag.start.x,point.y-drag.start.y);
    const dx = translation.dx-(drag.translation?.dx || 0);
    const dy = translation.dy-(drag.translation?.dy || 0);
    if(!dx && !dy) return;
    if(!drag.historyPushed){
      drag.undoBefore = state.undo.slice();
      pushHistory("layers");
      drag.historyPushed = true;
    }
    drag.layers.forEach(layer => moveLayerRaw(layer,dx,dy));
    drag.translation = translation;
    drag.last = point;
    drag.changed = true;
  }

  function selectedHandleAt(point){
    const layer = selectedLayer();
    if(!layer || layer.visible === false) return null;
    const reach = 12*displayScale();
    if(drawing.isLine(layer)){
      let nearest = null;
      let distance = reach;
      for(const end of ["1","2"]){
        const candidate = Math.hypot(point.x-layer[`x${end}`],point.y-layer[`y${end}`]);
        if(candidate <= reach && (!nearest || candidate < distance)){
          nearest = {layer,mode:"resizeEndpoint",end};
          distance = candidate;
        }
      }
      return nearest;
    }
    const bounds = layerBounds(layer);
    return Math.abs(point.x-(bounds.x+bounds.w)) <= reach &&
      Math.abs(point.y-(bounds.y+bounds.h)) <= reach ? {layer,mode:"resizeLayer"} : null;
  }

  function beginGestureHistory(drag){
    if(drag.historyPushed) return;
    drag.undoBefore = state.undo.slice();
    pushHistory("layers");
    drag.historyPushed = true;
  }

  function updateLayerResize(drag,point,event){
    if(Math.hypot(point.x-drag.start.x,point.y-drag.start.y) < 1 && !drag.changed) return;
    const original = drag.startLayer;
    if(drag.mode === "resizeEndpoint"){
      const fixed = drag.end === "1" ? "2" : "1";
      const anchor = {x:original[`x${fixed}`],y:original[`y${fixed}`]};
      const end = {x:original[`x${drag.end}`],y:original[`y${drag.end}`]};
      const fitted = event.shiftKey
        ? drawing.angleLockedLinePoint(anchor,end,point,{width:baseCanvas.width,height:baseCanvas.height})
        : drawing.constrainedLinePoint(anchor,point,event.ctrlKey);
      if(fitted.x === drag.layer[`x${drag.end}`] && fitted.y === drag.layer[`y${drag.end}`]) return;
      beginGestureHistory(drag);
      drag.layer[`x${drag.end}`] = fitted.x;
      drag.layer[`y${drag.end}`] = fitted.y;
    }else{
      const stroke = BRUSH_TYPES.includes(original.type) || original.type === "ink";
      const locked = !!(event.ctrlKey || event.shiftKey);
      const size = drawing.resizeBox(drag.bounds,point.x-drag.start.x,point.y-drag.start.y,
        {width:baseCanvas.width,height:baseCanvas.height},
        (["rect","ellipse"].includes(original.type) || stroke) && locked);
      if(stroke && locked){
        const minScale = Math.max(5/original.brushSize,2/drag.bounds.w,2/drag.bounds.h);
        const maxScale = Math.min(500/original.brushSize,
          (baseCanvas.width-drag.bounds.x)/drag.bounds.w,
          (baseCanvas.height-drag.bounds.y)/drag.bounds.h);
        // A stroke clipped to less than the minimum thickness cannot fit at
        // this anchor. Keep it intact until it is moved away from the edge.
        if(maxScale < minScale) return;
        const scale = clamp(size.w/drag.bounds.w,minScale,maxScale);
        if(scale === 1 && !drag.changed) return;
        size.w = drag.bounds.w*scale;
        size.h = drag.bounds.h*scale;
      }
      beginGestureHistory(drag);
      scaleLayerFromBounds(drag.layer,original,drag.bounds,size.w,size.h,stroke && locked);
    }
    drag.last = point;
    drag.changed = true;
  }

  function updateInkGesture(drag,point,final=false){
    // Coalesced samples and final pointer-up use the same original-image coordinates.
    const remaining = drawing.MAX_IMAGE_INK_POINTS-drawing.imageInkPointCount(state.layers)+drag.layer.points.length;
    const limit = Math.min(drawing.MAX_STROKE_POINTS,remaining);
    const fitted = final ? point : drawing.stabilizeInkPoint(drag.last,point,drag.stabilizer);
    if(drawing.appendInkPoint(drag.layer.points,fitted,limit)){
      drag.last = fitted;
      drag.changed = true;
    }
    if(!drag.limitReported && drag.layer.points.length >= limit){
      drag.limitReported = true;
      toast("手書きの点数上限に達しました。この線を確定して続けてください。");
    }
  }

  function updateInkEraser(drag,point){
    const erased = state.layers.filter(layer => layer.type === "ink" && layer.visible !== false &&
      drawing.inkIntersectsSegment(layer,drag.last,point,drag.radius));
    if(erased.length){
      beginGestureHistory(drag);
      const ids = new Set(erased.map(layer => layer.id));
      state.layers = state.layers.filter(layer => !ids.has(layer.id));
      selectLayers(selectedLayers());
      drag.changed = true;
      updateSelectedControls();
    }
    drag.last = point;
  }

  function releaseGestureCapture(drag){
    if(drag && editCanvas.hasPointerCapture?.(drag.pointerId)) editCanvas.releasePointerCapture(drag.pointerId);
  }

  function cancelSelectionGesture(){
    const drag = state.drag;
    if(drag?.mode === "marquee"){
      const ids = new Set(drag.selectionBefore);
      selectLayers(state.layers.filter(layer => ids.has(layer.id)));
    }else if(drag && ["moveLayer","moveLayers","resizeLayer","resizeEndpoint"].includes(drag.mode) && drag.changed){
      drag.layers.forEach((layer,index) => {
        const restored = cloneLayerForGesture(drag.startLayers[index]);
        Object.keys(layer).forEach(key => {delete layer[key];});
        Object.assign(layer,restored);
      });
    }else if(drag && ["brush","ink","inkEraser"].includes(drag.mode)){
      // New strokes and stroke erasure only add/remove layer references; keep
      // existing point arrays intact instead of duplicating every stroke again.
      state.layers = drag.layersBefore.slice();
      const ids = new Set(drag.selectionBefore);
      selectLayers(state.layers.filter(layer => ids.has(layer.id)));
    }else if(drag?.mode === "crop"){
      state.crop = drag.base ? {...drag.base} : null;
      syncCropInputs();
    }
    if(drag?.historyPushed){
      state.undo = drag.undoBefore.slice();
      state.redo = drag.redoBefore.slice();
      state.revision = drag.beforeRevision;
      updateHistoryButtons();
    }
    state.drag = null;
    releaseGestureCapture(drag);
    renderLayers();
    renderEditor();
    updateSelectedControls();
  }

  editCanvas.addEventListener("pointerdown",event => {
    if(
        state.singleBusy ||
        state.drag || event.isPrimary === false ||
        !state.tool ||
        !baseCanvas.width ||
        state.tool === "transform" || state.tool === "pan" ||
        event.button !== 0
    ){
        return;
    }

    const point = pointFromEvent(event);
    const beforeRevision = state.revision;
    editCanvas.focus({preventScroll:true});
    editCanvas.setPointerCapture(event.pointerId);

    // 配置済みの文字上では直接選択を優先し、ダブルクリックの先行クリックで
    // 新しい文字やブラシの点を作らない。
    if(!["select","crop","inkEraser"].includes(state.tool)){
      const existing = hitLayer(point);
      if(existing?.type === "text"){
        selectLayers([existing]);
        setTool("select");
        updateSelectedControls();
        releaseGestureCapture({pointerId:event.pointerId});
        return;
      }
    }

    if(state.tool === "select"){
      const selectedHandle = selectedHandleAt(point);
      const layer = selectedHandle?.layer || hitLayer(point);
      const selected = selectedLayers();
      const alreadySelected = selected.some(item => item.id === layer?.id);
      if(layer && event.shiftKey && !selectedHandle){
        selectLayers(alreadySelected
          ? selected.filter(item => item.id !== layer.id) : [...selected,layer]);
        renderEditor();
        updateSelectedControls();
        releaseGestureCapture({pointerId:event.pointerId});
        return;
      }
      if(layer){
        if(!alreadySelected) selectLayers([layer]);
        const layers = selectedLayers();
        const bounds = layersBounds(layers);
        state.drag = {
          mode:selectedHandle?.mode || (layers.length === 1 ? "moveLayer" : "moveLayers"),
          end:selectedHandle?.end,
          start:point,
          last:point,
          layer,
          layers,
          startLayer:cloneLayerForGesture(layer),
          startLayers:layers.map(cloneLayerForGesture),
          bounds:{...bounds},
          threshold:3*displayScale(),
          historyPushed:false,
          changed:false,
          beforeRevision,pointerId:event.pointerId,
          redoBefore:state.redo.slice()
        };
      }else{
        const selectionBefore = selected.map(item => item.id);
        if(!event.shiftKey) selectLayers([]);
        state.drag = {
          mode:"marquee",start:point,last:point,active:false,
          beforeRevision,pointerId:event.pointerId,
          threshold:3*displayScale(),selectionBefore,
          additiveIds:event.shiftKey ? selectionBefore : []
        };
      }

      renderEditor();
      updateSelectedControls();
      return;
    }

    if(state.tool === "text"){
      // Keep the native pointer default from moving focus back to the canvas
      // after the newly created text field receives its caret.
      event.preventDefault();
      const style = currentStyle();

      pushHistory("layers");
      const layer = {
        id:makeId(),
        type:"text",
        ...style,
        text:"",
        x:point.x,
        y:point.y,
        color:style.color,
        fontSize:style.fontSize,
        visible:true
      };

      state.layers.push(layer);
      selectLayers([layer]);
      setTool("select");
      updateSelectedControls();
      releaseGestureCapture({pointerId:event.pointerId});
      beginTextEditing(layer);
      return;
    }

    if(state.tool === "crop"){
      const hit = cropHit(point);

      state.drag = {
        mode:"crop",
        beforeRevision,pointerId:event.pointerId,
        action:hit,
        threshold:3*displayScale(),active:false,
        start:point,
        last:point,
        base:state.crop ? {...state.crop} : null
      };

      renderEditor();
      return;
    }

    if(state.tool === "inkEraser"){
      state.drag = {mode:"inkEraser",last:point,radius:currentStyle().brushSize/2,
        layersBefore:state.layers.slice(),selectionBefore:selectedLayers().map(layer => layer.id),
        beforeRevision,pointerId:event.pointerId,redoBefore:state.redo.slice(),historyPushed:false,changed:false};
      updateInkEraser(state.drag,point);
      scheduleRender();
      return;
    }

    if(BRUSH_TYPES.includes(state.tool) || state.tool === "ink"){
      const style = currentStyle();
      if(state.tool === "ink" && drawing.imageInkPointCount(state.layers) >= drawing.MAX_IMAGE_INK_POINTS){
        toast("手書きの点数上限に達しました。不要な線を削除してください。");
        releaseGestureCapture({pointerId:event.pointerId});
        return;
      }
      const layersBefore = state.layers.slice();
      const selectionBefore = selectedLayers().map(layer => layer.id);
      const undoBefore = state.undo.slice(),redoBefore = state.redo.slice();

      pushHistory("layers");
      const layer = {
        id:makeId(),
        type:state.tool,
        color:style.color,
        points:[point],
        brushSize:style.brushSize,
        mosaicSize:style.mosaicSize,
        visible:true,
        maskCanvas:null,
        maskDirty:true
      };

      state.layers.push(layer);
      selectLayers([layer]);
      state.drag = {
        mode:state.tool === "ink" ? "ink" : "brush",
        layer,
        last:point,stabilizer:style.inkStabilizer,
        beforeRevision,pointerId:event.pointerId,layersBefore,selectionBefore,undoBefore,redoBefore,
        historyPushed:true,changed:false
      };

      updateSelectedControls();
      scheduleRender();
      return;
    }

    state.drag = {
      mode:"shape",
      beforeRevision,pointerId:event.pointerId,
      start:point,
      last:point,
      tool:state.tool,
      constrained:!!(event.ctrlKey || event.shiftKey),axisLocked:!!event.ctrlKey
    };

    renderEditor();
  });

  editCanvas.addEventListener("dblclick",event => {
    if(state.singleBusy || !baseCanvas.width || state.tool === "pan") return;
    const layer = hitLayer(pointFromEvent(event));
    if(layer?.type === "text"){
      event.preventDefault();
      beginTextEditing(layer,pointFromEvent(event));
    }
  });

  editCanvas.addEventListener("pointermove",event => {
    if(!state.drag || (state.drag.pointerId !== undefined && event.pointerId !== state.drag.pointerId)) return;

    const point = pointFromEvent(event);
    const drag = state.drag;

    if(["moveLayer","moveLayers"].includes(drag.mode)){
      updateLayerMove(drag,point);
      scheduleRender();
      return;
    }

    if(drag.mode === "marquee"){
      updateSelectionRectangle(drag,point);
      updateSelectedControls();
      scheduleRender();
      return;
    }

    if(["resizeLayer","resizeEndpoint"].includes(drag.mode)){
      updateLayerResize(drag,point,event);
      scheduleRender();
      return;
    }

    if(drag.mode === "ink"){
      const samples = event.getCoalescedEvents?.() || [];
      for(const sample of samples.length ? samples : [event]){
        updateInkGesture(drag,pointFromEvent(sample));
      }
      scheduleRender();
      return;
    }

    if(drag.mode === "inkEraser"){
      updateInkEraser(drag,point);
      scheduleRender();
      return;
    }

    if(drag.mode === "brush"){
      const distance = Math.hypot(
        point.x-drag.last.x,
        point.y-drag.last.y
      );

      if(distance >= Math.max(2,drag.layer.brushSize/8)){
        drag.layer.points.push(point);
        drag.layer.maskDirty = true;
        drag.last = point;
      }

      scheduleRender();
      return;
    }

    if(drag.mode === "crop"){
      updateCropGesture(drag,point);
      scheduleRender();
      return;
    }

    if(drag.mode === "shape"){
      drag.last = point;
      drag.constrained = !!(event.ctrlKey || event.shiftKey);
      drag.axisLocked = !!event.ctrlKey;
      scheduleRender();
    }
  });

    editCanvas.addEventListener("pointerup",event => {
    if(!state.drag || (state.drag.pointerId !== undefined && event.pointerId !== state.drag.pointerId)) return;

    const point = pointFromEvent(event);
    const drag = state.drag;

    if(drag.mode === "marquee"){
      updateSelectionRectangle(drag,point);
    }else if(["moveLayer","moveLayers"].includes(drag.mode)){
      updateLayerMove(drag,point);
    }else if(["resizeLayer","resizeEndpoint"].includes(drag.mode)){
      updateLayerResize(drag,point,event);
    }else if(drag.mode === "ink"){
      updateInkGesture(drag,point,true);
    }else if(drag.mode === "inkEraser"){
      updateInkEraser(drag,point);
    }else if(drag.mode === "crop"){
      updateCropGesture(drag,point);
    }else if(drag.mode === "brush"){
      if(Math.hypot(point.x-drag.last.x,point.y-drag.last.y) >= .25){
        drag.layer.points.push(point);
        drag.layer.maskDirty = true;
      }
    }

    let placedShape = false;
    if(drag.mode === "shape"){
        drag.last = point;
        const style = currentStyle();
        const rectangle =
        drawing.drawingBox(drag.start,point,{width:baseCanvas.width,height:baseCanvas.height},
          ["rect","ellipse"].includes(drag.tool) && (event.ctrlKey || event.shiftKey));

        if(["arrow","line"].includes(drag.tool)){
        const end = drawing.constrainedLinePoint(drag.start,point,event.ctrlKey);
        if(
            Math.hypot(
            end.x-drag.start.x,
            end.y-drag.start.y
            ) >= 2
        ){
            pushHistory("layers");

            const layer = {
            id:makeId(),
            type:drag.tool,
            ...style,
            x1:drag.start.x,
            y1:drag.start.y,
            x2:end.x,
            y2:end.y,
            color:style.color,
            lineWidth:style.lineWidth,
            visible:true
            };

            state.layers.push(layer);
            selectLayers([layer]);
            placedShape = true;
        }
        }else if(
        rectangle.w >= 2 &&
        rectangle.h >= 2
        ){
        pushHistory("layers");

        const layer = {
            id:makeId(),
            type:drag.tool,
            ...style,
            ...rectangle,
            color:style.color,
            lineWidth:style.lineWidth,
            mosaicSize:style.mosaicSize,
            visible:true
        };

        state.layers.push(layer);
        selectLayers([layer]);
        placedShape = ["rect","ellipse"].includes(drag.tool);
        }
    }

    state.drag = null;
    releaseGestureCapture(drag);

    if(placedShape){
      setTool("select");
      return;
    }

    renderLayers();
    renderEditor();
    updateSelectedControls();
    });


  editCanvas.addEventListener("pointercancel",event => {
    if(state.drag?.pointerId === event.pointerId) cancelSelectionGesture();
  });
  editCanvas.addEventListener("lostpointercapture",event => {
    if(state.drag?.pointerId === event.pointerId) cancelSelectionGesture();
  });



  function syncCropInputs(){
    if(!state.crop){
        ["cropW","cropH"].forEach(id => {
        $(id).value = "";
        });

        updateCropControls();
        return;
    }

    $("cropW").value = Math.round(state.crop.w);
    $("cropH").value = Math.round(state.crop.h);

    updateCropControls();
  }


  function updateCropFromInputs(event){
    if(!state.sourceFile || state.tool !== "crop" || state.singleBusy || state.drag) return;
    if($("cropW").value === "" || $("cropH").value === ""){
      if(state.crop) syncCropInputs();
      renderEditor();
      return;
    }

    const wValue = Number($("cropW").value);
    const hValue = Number($("cropH").value);

    if(
      !Number.isFinite(wValue) ||
      !Number.isFinite(hValue) || wValue <= 0 || hValue <= 0
    ){
      if(state.crop) syncCropInputs();
      renderEditor();
      return;
    }

    // X/Y remain image coordinates controlled by dragging and centering.
    // Invalid dimensions must not discard that position during a numeric edit.
    const x = clamp(state.crop?.x ?? 0,0,baseCanvas.width-1);
    const y = clamp(state.crop?.y ?? 0,0,baseCanvas.height-1);
    const maxWidth = baseCanvas.width-x,maxHeight = baseCanvas.height-y;
    let width = clamp(Math.round(wValue),1,maxWidth);
    let height = clamp(Math.round(hValue),1,maxHeight);
    const ratio = cropRatioValue();

    if(ratio){
      if(event?.target?.id === "cropH") width = Math.max(1,Math.round(height*ratio));
      else height = Math.max(1,Math.round(width/ratio));
      const scale = Math.min(1,maxWidth/width,maxHeight/height);
      width = Math.min(maxWidth,Math.max(1,Math.round(width*scale)));
      height = Math.min(maxHeight,Math.max(1,Math.round(height*scale)));
    }

    state.crop = {
      x,
      y,
      w:Math.max(1,width),
      h:Math.max(1,height)
    };

    syncCropInputs();
    renderEditor();
  }

  ["cropW","cropH"].forEach(id => {
    $(id).addEventListener("change",updateCropFromInputs);
  });

  $("cropRatio").addEventListener("change",() => {
    if(!state.crop || state.singleBusy || state.drag || state.tool !== "crop") return;

    const ratio = cropRatioValue();
    if(!ratio) return;

    let width = state.crop.w;
    let height = width/ratio;

    if(height > baseCanvas.height-state.crop.y){
      height = baseCanvas.height-state.crop.y;
      width = height*ratio;
    }

    state.crop.w = Math.max(1,width);
    state.crop.h = Math.max(1,height);
    syncCropInputs();
    renderEditor();
  });

  $("centerCrop").addEventListener("click",() => {
    if(!state.crop || state.singleBusy || state.drag || state.tool !== "crop") return;

    state.crop.x = (baseCanvas.width-state.crop.w)/2;
    state.crop.y = (baseCanvas.height-state.crop.h)/2;
    syncCropInputs();
    renderEditor();
  });

  function clipRectLayerToCanvas(layer,width,height){
    const left = clamp(layer.x,0,width);
    const top = clamp(layer.y,0,height);
    const right = clamp(layer.x+layer.w,0,width);
    const bottom = clamp(layer.y+layer.h,0,height);

    if(right <= left || bottom <= top) return false;

    layer.x = left;
    layer.y = top;
    layer.w = right-left;
    layer.h = bottom-top;
    return true;
  }

  function trimLayersAfterCrop(crop){
    state.layers.forEach(layer => {
      moveLayerRaw(layer,-crop.x,-crop.y);
    });

    state.layers = state.layers.filter(layer => {
      if(["blackoutRect","mosaicRect"].includes(layer.type)){
        return clipRectLayerToCanvas(layer,crop.w,crop.h);
      }

      const bounds = layerBounds(layer);
      const intersects = bounds.x+bounds.w > 0 &&
        bounds.y+bounds.h > 0 &&
        bounds.x < crop.w &&
        bounds.y < crop.h;

      if(layer.points){
        layer.maskDirty = true;
      }

      return intersects;
    });

    selectLayers(selectedLayers());
  }

  function applyCurrentCrop(){
    if(state.singleBusy || state.drag || state.tool !== "crop") return;
    finishTextEditing();
    if(
        !state.crop ||
        Math.round(state.crop.w) < 1 ||
        Math.round(state.crop.h) < 1
    ){
        toast(
        "有効なトリミング範囲を指定してください。"
        );
        return;
    }

    const crop = {
        x:Math.round(state.crop.x),
        y:Math.round(state.crop.y),
        w:Math.round(state.crop.w),
        h:Math.round(state.crop.h)
    };

    crop.x = clamp(
        crop.x,
        0,
        baseCanvas.width-1
    );
    crop.y = clamp(
        crop.y,
        0,
        baseCanvas.height-1
    );
    crop.w = clamp(
        crop.w,
        1,
        baseCanvas.width-crop.x
    );
    crop.h = clamp(
        crop.h,
        1,
        baseCanvas.height-crop.y
    );

    pushHistory("full");

    const output = createCanvas(
        crop.w,
        crop.h
    );

    output.getContext("2d").drawImage(
        baseCanvas,
        crop.x,
        crop.y,
        crop.w,
        crop.h,
        0,
        0,
        crop.w,
        crop.h
    );

    baseCanvas.width = crop.w;
    baseCanvas.height = crop.h;
    baseContext.clearRect(
        0,
        0,
        crop.w,
        crop.h
    );
    baseContext.drawImage(output,0,0);

    trimLayersAfterCrop(crop);

    state.crop = null;
    invalidateBaseCaches();
    setTool("select");
    syncCanvas();

    toast("トリミングしました。");
  }


    $("applyCrop").addEventListener(
    "click",
    applyCurrentCrop
    );

    $("cancelCrop").addEventListener("click",() => {
      if(state.singleBusy) return;
      setTool("select");
    });



  function transformAllLayers(scaleX,scaleY){
    const average = (Math.abs(scaleX)+Math.abs(scaleY))/2;

    state.layers.forEach(layer => {
      if(RECT_TYPES.includes(layer.type) || layer.type === "image"){
        layer.x *= scaleX;
        layer.y *= scaleY;
        layer.w *= scaleX;
        layer.h *= scaleY;

        if(layer.lineWidth){
          layer.lineWidth = clamp(layer.lineWidth*average,1,100);
        }
      }else if(layer.type === "text"){
        layer.x *= scaleX;
        layer.y *= scaleY;
        layer.fontSize = clamp(layer.fontSize*average,8,300);
        if(layer.textWidth > 0) layer.textWidth *= Math.abs(scaleX);
      }else if(drawing.isLine(layer)){
        layer.x1 *= scaleX;
        layer.y1 *= scaleY;
        layer.x2 *= scaleX;
        layer.y2 *= scaleY;
        layer.lineWidth = clamp(layer.lineWidth*average,1,100);
      }else if(layer.points){
        layer.points.forEach(point => {
          point.x *= scaleX;
          point.y *= scaleY;
        });
        layer.brushSize = clamp(layer.brushSize*average,5,500);
        layer.maskDirty = true;
      }
    });
  }

  function resizeSingle(width,height){
    if(state.singleBusy || state.drag || !state.originalCanvas) return false;
    finishTextEditing();
    validateDimensions(width,height);

    if(width === baseCanvas.width && height === baseCanvas.height){
      toast("画像サイズは変更されていません。");
      return false;
    }

    pushHistory("full");

    const oldWidth = baseCanvas.width;
    const oldHeight = baseCanvas.height;
    const output = createCanvas(width,height);
    const context = output.getContext("2d");

    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(baseCanvas,0,0,width,height);

    baseCanvas.width = width;
    baseCanvas.height = height;
    baseContext.clearRect(0,0,width,height);
    baseContext.drawImage(output,0,0);

    transformAllLayers(width/oldWidth,height/oldHeight);
    state.crop = null;
    invalidateBaseCaches();
    syncCanvas();
    return true;
  }

  $("applyResize").addEventListener("click",() => {
    try{
      const width = Number($("resizeW").value);
      const height = Number($("resizeH").value);
      validateDimensions(width,height);

      if(resizeSingle(width,height)){
        toast("リサイズしました。");
      }
    }catch(error){
      toast(error.message);
    }
  });

  $("resizeW").addEventListener("input",() => {
    if(!$("lockAspect").checked) return;

    const width = Number($("resizeW").value);
    if(Number.isFinite(width) && width > 0){
      $("resizeH").value = clamp(
        Math.max(1,Math.round(width/singleAspect)),
        1,
        MAX_DIMENSION
      );
    }
  });

  $("resizeH").addEventListener("input",() => {
    if(!$("lockAspect").checked) return;

    const height = Number($("resizeH").value);
    if(Number.isFinite(height) && height > 0){
      $("resizeW").value = clamp(
        Math.max(1,Math.round(height*singleAspect)),
        1,
        MAX_DIMENSION
      );
    }
  });

  function rotatePoint(point,degrees,oldWidth,oldHeight){
    if(degrees === 90){
      return {x:oldHeight-point.y,y:point.x};
    }
    if(degrees === -90){
      return {x:point.y,y:oldWidth-point.x};
    }
    return {x:oldWidth-point.x,y:oldHeight-point.y};
  }

  function rotateSingle(degrees){
    if(state.singleBusy || state.drag || !state.originalCanvas) return;
    finishTextEditing();

    pushHistory("full");

    const oldWidth = baseCanvas.width;
    const oldHeight = baseCanvas.height;
    const swap = Math.abs(degrees) === 90;
    const output = createCanvas(
      swap ? oldHeight : oldWidth,
      swap ? oldWidth : oldHeight
    );
    const context = output.getContext("2d");

    context.translate(output.width/2,output.height/2);
    context.rotate(degrees*Math.PI/180);
    context.drawImage(baseCanvas,-oldWidth/2,-oldHeight/2);

    baseCanvas.width = output.width;
    baseCanvas.height = output.height;
    baseContext.clearRect(0,0,output.width,output.height);
    baseContext.drawImage(output,0,0);

    state.layers.forEach(layer => {
      if(RECT_TYPES.includes(layer.type) || layer.type === "image"){
        const corners = [
          rotatePoint({x:layer.x,y:layer.y},degrees,oldWidth,oldHeight),
          rotatePoint({x:layer.x+layer.w,y:layer.y},degrees,oldWidth,oldHeight),
          rotatePoint({x:layer.x,y:layer.y+layer.h},degrees,oldWidth,oldHeight),
          rotatePoint({x:layer.x+layer.w,y:layer.y+layer.h},degrees,oldWidth,oldHeight)
        ];

        const xs = corners.map(point => point.x);
        const ys = corners.map(point => point.y);
        layer.x = Math.min(...xs);
        layer.y = Math.min(...ys);
        layer.w = Math.max(...xs)-layer.x;
        layer.h = Math.max(...ys)-layer.y;
        if(layer.type === "image"){
          // History and copied objects share immutable bitmap references.
          layer.imageCanvas = rotateCanvas(layer.imageCanvas,degrees);
        }
      }else if(layer.type === "text"){
        Object.assign(
          layer,
          rotatePoint({x:layer.x,y:layer.y},degrees,oldWidth,oldHeight)
        );
      }else if(drawing.isLine(layer)){
        const first = rotatePoint(
          {x:layer.x1,y:layer.y1},
          degrees,
          oldWidth,
          oldHeight
        );
        const second = rotatePoint(
          {x:layer.x2,y:layer.y2},
          degrees,
          oldWidth,
          oldHeight
        );

        layer.x1 = first.x;
        layer.y1 = first.y;
        layer.x2 = second.x;
        layer.y2 = second.y;
      }else if(layer.points){
        layer.points = layer.points.map(point =>
          rotatePoint(point,degrees,oldWidth,oldHeight)
        );
        layer.maskDirty = true;
      }
    });

    state.crop = null;
    invalidateBaseCaches();
    syncCanvas();
  }

  function flipSingle(horizontal){
    if(state.singleBusy || state.drag || !state.originalCanvas) return;
    finishTextEditing();

    pushHistory("full");
    const output = cloneCanvas(baseCanvas);

    baseContext.clearRect(0,0,baseCanvas.width,baseCanvas.height);
    baseContext.save();

    if(horizontal){
      baseContext.translate(baseCanvas.width,0);
      baseContext.scale(-1,1);
    }else{
      baseContext.translate(0,baseCanvas.height);
      baseContext.scale(1,-1);
    }

    baseContext.drawImage(output,0,0);
    baseContext.restore();

    state.layers.forEach(layer => {
      const flipPoint = point => ({
        x:horizontal ? baseCanvas.width-point.x : point.x,
        y:horizontal ? point.y : baseCanvas.height-point.y
      });

      if(RECT_TYPES.includes(layer.type) || layer.type === "image"){
        if(horizontal){
          layer.x = baseCanvas.width-layer.x-layer.w;
        }else{
          layer.y = baseCanvas.height-layer.y-layer.h;
        }
        if(layer.type === "image"){
          layer.imageCanvas = flipCanvas(layer.imageCanvas,horizontal);
        }
      }else if(layer.type === "text"){
        Object.assign(layer,flipPoint({x:layer.x,y:layer.y}));
      }else if(drawing.isLine(layer)){
        const first = flipPoint({x:layer.x1,y:layer.y1});
        const second = flipPoint({x:layer.x2,y:layer.y2});
        layer.x1 = first.x;
        layer.y1 = first.y;
        layer.x2 = second.x;
        layer.y2 = second.y;
      }else if(layer.points){
        layer.points = layer.points.map(flipPoint);
        layer.maskDirty = true;
      }
    });

    state.crop = null;
    invalidateBaseCaches();
    syncCanvas();
  }

  $("rotateLeft").addEventListener("click",() => rotateSingle(-90));
  $("rotateRight").addEventListener("click",() => rotateSingle(90));
  $("flipH").addEventListener("click",() => flipSingle(true));
  $("flipV").addEventListener("click",() => flipSingle(false));
  $("undo").addEventListener("click",undo);
  $("redo").addEventListener("click",redo);

  const styleFieldProperties = {
    annotationColor:"color",fontSize:"fontSize",
    lineWidth:"lineWidth",brushSize:"brushSize",mosaicSize:"mosaicSize",
    fontFamily:"fontFamily",boldText:"bold",
    textBgColor:"bgColor",textBgTransparent:"bgTransparent",whiteOutline:"outline",
    shapeFill:"fill",shapeFillNone:"fillNone",imageOpacity:"opacity"
  };

  function applySelectedField(event){
    const field = event.target;
    const property = styleFieldProperties[field.id];
    const layers = selectedLayers().filter(layer => annotationStyle.eligibleForField(layer,property));
    if(!layers.length || state.tool !== "select" || state.singleBusy || state.drag || (property === "text" && layers.length > 1)) return;
    if(field.type === "number" && (field.value === "" || !Number.isFinite(Number(field.value)))) return;
    if(event.type === "input" && field.checkValidity && !field.checkValidity()) return;
    if(property === "fontFamily"){
      if(!field.value) return;
      if(event.type === "input"){
        fontPreview = {ids:new Set(layers.map(layer => layer.id)),key:annotationStyle.safeFontFamily(field.value)};
        renderLayers();
        renderEditor();
        return;
      }
      fontPreview = null;
    }
    const value = property === "text" ? field.value
      : currentStyle()[property];
    const changed = layers.filter(layer => annotationStyle.valueForField(layer,property) !== value);
    if(!changed.length) return;
    const selectionKey = layers.map(layer => layer.id).sort().join("\n");
    if(!styleEditSession || styleEditSession.selectionKey !== selectionKey || styleEditSession.field !== field.id){
      styleEditSession = {selectionKey,field:field.id,historyPushed:false};
    }
    if(!styleEditSession.historyPushed){
      pushHistory("layers");
      styleEditSession.historyPushed = true;
    }
    for(const layer of changed){
      layer[property] = value;
      if(property === "brushSize") layer.maskDirty = true;
    }
    renderLayers();
    renderEditor();
    updateSelectedControls();
  }

  Object.keys(styleFieldProperties).forEach(id => {
    const field = $(id);
    if(!field) return;
    field.addEventListener("focus",() => {
      styleEditSession = null;
    });
    field.addEventListener("blur",() => {
      styleEditSession = null;
      if(id === "fontFamily" && fontPreview){
        fontPreview = null;
        renderLayers();
        renderEditor();
        updateSelectedControls();
      }
    });
    if(id === "fontFamily") field.addEventListener("keydown",event => {
      if(event.key !== "Escape" || !fontPreview) return;
      event.preventDefault();
      fontPreview = null;
      renderLayers();
      renderEditor();
      updateSelectedControls();
    });
    field.addEventListener("input",applySelectedField);
    field.addEventListener("change",applySelectedField);
  });

  function syncFontSizeButtons(){
    const sizes = state.tool === "text" ? [currentStyle().fontSize]
      : state.tool === "select" ? selectedLayers().filter(layer => layer.type === "text").map(layer => layer.fontSize) : [];
    const blocked = !state.sourceFile || state.singleBusy;
    $("decreaseFontSize").disabled = blocked || !sizes.some(size => size > 8);
    $("increaseFontSize").disabled = blocked || !sizes.some(size => size < 300);
  }

  function adjustFontSize(delta){
    if(!state.sourceFile || state.singleBusy || state.drag || viewState.pan || state.composing) return;
    finishTextEditing();
    styleEditSession = null;
    fontPreview = null;
    if(state.tool === "text"){
      $("fontSize").value = clamp(currentStyle().fontSize+delta,8,300);
      syncFontSizeButtons();
      return;
    }
    if(state.tool !== "select") return;
    const changes = selectedLayers().filter(layer => layer.type === "text")
      .map(layer => ({layer,size:clamp(layer.fontSize+delta,8,300)}))
      .filter(({layer,size}) => size !== layer.fontSize);
    if(!changes.length) return;
    pushHistory("layers");
    changes.forEach(({layer,size}) => {layer.fontSize = size;});
    renderLayers();
    renderEditor();
    updateSelectedControls();
  }

  $("decreaseFontSize").addEventListener("click",() => adjustFontSize(-2));
  $("increaseFontSize").addEventListener("click",() => adjustFontSize(2));
  $("fontSize").addEventListener("input",syncFontSizeButtons);
  $("fontSize").addEventListener("change",syncFontSizeButtons);

  $("toggleTransform").addEventListener("click",() => setTool("transform"));

  function hasUnsavedChanges(){
    if(!state.sourceFile) return false;
    const pending = state.drag && !["marquee","moveLayer","moveLayers","resizeLayer"].includes(state.drag.mode);
    return state.revision !== state.savedRevision || !!pending;
  }

  function confirmDiscardChanges(action){
    return !hasUnsavedChanges() || window.confirm(`保存していない変更があります。${action}\n保存する場合は「キャンセル」を選択してください。`);
  }

  window.addEventListener("beforeunload",event => {
    if(!hasUnsavedChanges()) return;
    event.preventDefault();
    event.returnValue = "";
  });

  $("resetSingle").addEventListener("click",() => {
    if(state.singleBusy || state.drag || viewState.pan || state.composing || !state.originalCanvas) return;
    finishTextEditing();
    if(!confirmDiscardChanges("読込み時の状態へ戻しますか？")) return;

    pushHistory("full");

    baseCanvas.width = state.originalCanvas.width;
    baseCanvas.height = state.originalCanvas.height;
    baseContext.clearRect(0,0,baseCanvas.width,baseCanvas.height);
    baseContext.drawImage(state.originalCanvas,0,0);

    state.layers = [];
    state.crop = null;
    selectLayers([]);
    invalidateBaseCaches();
    syncCanvas();
    toast("読込み時の状態へ戻しました。");
  });

  async function loadSingleFile(file){
    if(!file) return;

    if(!isSupportedImage(file)){
        toast(
        "JPEG・PNG・WebP画像を選択してください。"
        );
        return;
    }

    if(file.size > MAX_FILE_BYTES){
        toast(
        "25MBを超える画像は読み込めません。"
        );
        return;
    }

    finishTextEditing();
    if(state.sourceFile && !confirmDiscardChanges("別の画像を読み込みますか？")) return;
    if(state.drag) cancelSelectionGesture();

    const version = ++state.loadVersion;
    state.singleBusy = true;
    setSingleStatus(
        "画像を読み込んでいます。"
    );

    let image = null;

    try{
        image = await decodeImage(file);

        if(version !== state.loadVersion){
        return;
        }

        const width =
        image.width || image.naturalWidth;
        const height =
        image.height || image.naturalHeight;

        validateDimensions(width,height);

        baseCanvas.width = width;
        baseCanvas.height = height;
        baseContext.clearRect(
        0,
        0,
        width,
        height
        );
        baseContext.drawImage(
        image,
        0,
        0,
        width,
        height
        );

        state.sourceFile = file;
        modeChoicesOpen = false;
        state.originalCanvas =
        cloneCanvas(baseCanvas);
        state.layers = [];
        state.crop = null;
        selectLayers([]);
        state.undo = [];
        state.redo = [];
        state.revision = ++state.revisionCounter;
        state.savedRevision = state.revision;
        viewState.mode = "fit";
        viewState.pan = null;
        canvasViewport.classList.remove("panning");

        invalidateBaseCaches();

        $("singleSaveName").value =
        `${sanitizeBaseName(file.name)}-edited`;
        $("singleFormat").value = "image/png";
        $("presetSelect").value = "";
        singleSavePreset = null;
        $("singleTargetEnabled").checked = false;
        $("singleTargetKB").disabled = true;

        $("singleEmpty").classList.add(
        "hidden"
        );
        $("singleWorkspace").classList.remove(
        "hidden"
        );
        $("singleWorkspace")
          .querySelectorAll(".left-panel, .stage-head, .right-panel")
          .forEach(element => {
            element.inert = false;
          });

        syncEditorChrome();
        updateSingleFormatUI();
        syncCanvas();
        setTool("select");

        setSingleStatus(
        "加工できます。保存時に表示中のレイヤーを画像へ焼き込みます。",
        "ok"
        );
    }catch(error){
        if(version !== state.loadVersion){
        return;
        }

        setSingleStatus(
        error.message ||
            "画像の読込みに失敗しました。",
        "warn"
        );

        toast(
        error.message ||
            "画像の読込みに失敗しました。"
        );
    }finally{
        if(
        version === state.loadVersion
        ){
        state.singleBusy = false;
        syncEditorChrome();
        }

        if(
        image &&
        typeof image.close === "function"
        ){
        image.close();
        }
    }
  }


  async function addImageLayer(file,{expandCanvas=false}={}){
    if(!file) return;
    if(!state.originalCanvas){
      await loadSingleFile(file);
      return;
    }
    if(state.singleBusy || state.drag) return;
    if(!isSupportedImage(file)){
      toast("JPEG・PNG・WebP画像を選択してください。");
      return;
    }
    if(file.size > MAX_FILE_BYTES){
      toast("25MBを超える画像は読み込めません。");
      return;
    }

    const version = state.loadVersion;
    const revision = state.baseRevision;
    state.singleBusy = true;
    syncModeControls();
    setSingleStatus("追加する画像を読み込んでいます。");
    let image = null;
    let imageCanvas = null;
    let expandedBase = null;
    let added = false;

    try{
      image = await decodeImage(file);
      if(version !== state.loadVersion || revision !== state.baseRevision) return;
      const width = image.width || image.naturalWidth;
      const height = image.height || image.naturalHeight;
      validateDimensions(width,height);
      const canvasWidth = expandCanvas ? Math.max(baseCanvas.width,width) : baseCanvas.width;
      const canvasHeight = expandCanvas ? Math.max(baseCanvas.height,height) : baseCanvas.height;
      validateDimensions(canvasWidth,canvasHeight);
      const grows = canvasWidth !== baseCanvas.width || canvasHeight !== baseCanvas.height;
      // Prepare every bitmap before changing the base or creating history.
      // The existing image stays at its original pixel origin on transparent
      // padding; existing annotations therefore need no coordinate conversion.
      imageCanvas = createCanvas(width,height);
      imageCanvas.getContext("2d").drawImage(image,0,0,width,height);
      if(grows){
        expandedBase = createCanvas(canvasWidth,canvasHeight);
        expandedBase.getContext("2d").drawImage(baseCanvas,0,0);
      }
      const ratio = expandCanvas ? 1 : Math.min(1,baseCanvas.width/width,baseCanvas.height/height);
      const layer = {
        id:makeId(),
        type:"image",
        imageCanvas,
        x:(canvasWidth-width*ratio)/2,
        y:(canvasHeight-height*ratio)/2,
        w:width*ratio,
        h:height*ratio,
        opacity:100,
        visible:true
      };
      pushHistory(grows ? "full" : "layers");
      if(grows){
        baseCanvas.width = canvasWidth;
        baseCanvas.height = canvasHeight;
        baseContext.clearRect(0,0,canvasWidth,canvasHeight);
        baseContext.drawImage(expandedBase,0,0);
        state.crop = null;
        invalidateBaseCaches();
      }
      state.layers.push(layer);
      added = true;
      selectLayers([layer]);
      setTool("select");
      if(grows) syncCanvas();
      else updateSelectedControls();
      editCanvas.focus();
      setSingleStatus("画像を追加しました。選択して移動・サイズ変更・透明度の調整ができます。","ok");
    }catch(error){
      if(version !== state.loadVersion || revision !== state.baseRevision) return;
      setSingleStatus(error.message || "追加画像の読込みに失敗しました。","warn");
      toast(error.message || "追加画像の読込みに失敗しました。");
    }finally{
      if(version === state.loadVersion){
        state.singleBusy = false;
        syncModeControls();
      }
      if(image && typeof image.close === "function") image.close();
      if(expandedBase){expandedBase.width = 0;expandedBase.height = 0;}
      if(imageCanvas && !added){imageCanvas.width = 0;imageCanvas.height = 0;}
    }
  }

  $("addImageLayer").addEventListener("click",() => {
    if(state.singleBusy) return;
    $("imageLayerInput").value = "";
    $("imageLayerInput").click();
  });

  $("imageLayerInput").addEventListener("change",() => {
    addImageLayer($("imageLayerInput").files?.[0]);
  });

  document.addEventListener("paste",event => {
    if(isObjectShortcutBlocked(event)) return;
    const imageItem = [...(event.clipboardData?.items || [])]
      .find(item => item.kind === "file" && item.type.startsWith("image/"));
    if(imageItem){
      const file = imageItem.getAsFile();
      if(!file) return;
      event.preventDefault();
      if(state.originalCanvas){
        addImageLayer(file,{expandCanvas:true});
      }else{
        loadSingleFile(file);
      }
      return;
    }
    pasteCopiedLayer(event);
  });


  const singleInput = $("singleInput");

  $("singleChoose").addEventListener("click",event => {
    event.stopPropagation();
    singleInput.value = "";
    singleInput.click();
  });

  $("changeSingle").addEventListener("click",() => {
    if(state.singleBusy || state.drag || viewState.pan) return;
    singleInput.value = "";
    singleInput.click();
  });

  singleInput.addEventListener("change",() => {
    loadSingleFile(singleInput.files?.[0]);
  });

  function bindDropZone(zone,input,handler){
    zone.addEventListener("click",event => {
      if(event.target.closest("button")) return;
      input.value = "";
      input.click();
    });

    zone.addEventListener("keydown",event => {
      if(event.key === "Enter" || event.key === " "){
        event.preventDefault();
        input.value = "";
        input.click();
      }
    });

    ["dragenter","dragover"].forEach(type => {
      zone.addEventListener(type,event => {
        event.preventDefault();
        zone.classList.add("drag");
      });
    });

    ["dragleave","drop"].forEach(type => {
      zone.addEventListener(type,event => {
        event.preventDefault();
        zone.classList.remove("drag");
      });
    });

    zone.addEventListener("drop",event => {
      handler(event.dataTransfer.files);
    });
  }

  bindDropZone(
    $("singleEmpty"),
    singleInput,
    files => loadSingleFile(files?.[0])
  );

  $$(".tool[data-tool]").forEach(button => {
    button.addEventListener("click",() => {
      if(state.singleBusy || state.drag || viewState.pan) return;
      setTool(button.dataset.tool);
    });
  });

  function drawPreview(source,target){
    const maxWidth = 900;
    const maxHeight = 700;
    const ratio = Math.min(
      1,
      maxWidth/source.width,
      maxHeight/source.height
    );

    target.width = Math.max(1,Math.round(source.width*ratio));
    target.height = Math.max(1,Math.round(source.height*ratio));

    const context = target.getContext("2d");
    context.clearRect(0,0,target.width,target.height);
    context.drawImage(source,0,0,target.width,target.height);
  }

  function openPreview(){
    if(state.singleBusy || state.drag || viewState.pan || !state.originalCanvas) return;
    finishTextEditing();

    drawPreview(state.originalCanvas,$("beforePreview"));
    drawPreview(compositeCanvas(),$("afterPreview"));

    previewReturnFocus = document.activeElement;
    $("previewDialog").classList.remove("hidden");
    document.body.classList.add("dialog-open");
    $("appMain").inert = true;
    document.querySelectorAll(".appbox-header").forEach(element => {element.inert = true;});
    $("closePreview").focus();
  }

  function closePreview(){
    if($("previewDialog").classList.contains("hidden")) return;

    $("previewDialog").classList.add("hidden");
    if($("saveDialog").classList.contains("hidden")){
      document.body.classList.remove("dialog-open");
      $("appMain").inert = false;
      document.querySelectorAll(".appbox-header").forEach(element => {element.inert = false;});
    }

    if(previewReturnFocus && typeof previewReturnFocus.focus === "function"){
      previewReturnFocus.focus();
    }
  }

  $("previewButton").addEventListener("click",openPreview);
  $("closePreview").addEventListener("click",closePreview);

  $("previewDialog").addEventListener("click",event => {
    if(event.target === $("previewDialog")){
      closePreview();
    }
  });

  $("previewDialog").addEventListener("keydown",event => {
    if(event.isComposing || state.composing || event.keyCode === 229) return;
    if(event.key === "Escape"){
      event.preventDefault();
      closePreview();
      return;
    }

    if(event.key === "Tab"){
      const focusable = $$(
        "#previewDialog button:not(:disabled),#previewDialog [tabindex]:not([tabindex='-1'])"
      );

      if(!focusable.length) return;

      const first = focusable[0];
      const last = focusable[focusable.length-1];

      if(event.shiftKey && document.activeElement === first){
        event.preventDefault();
        last.focus();
      }else if(!event.shiftKey && document.activeElement === last){
        event.preventDefault();
        first.focus();
      }
    }
  });

  function resizeCanvasExact(source,width,height){
    validateDimensions(width,height);

    const output = createCanvas(width,height);
    const context = output.getContext("2d");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(source,0,0,width,height);
    return output;
  }

  function resizeToLongEdge(source,longEdge,allowUpscale=false){
    let ratio = longEdge/Math.max(source.width,source.height);

    if(!allowUpscale){
      ratio = Math.min(1,ratio);
    }

    const width = Math.max(1,Math.round(source.width*ratio));
    const height = Math.max(1,Math.round(source.height*ratio));
    return resizeCanvasExact(source,width,height);
  }

  function applySinglePreset(){
    const preset = presets[$("presetSelect").value];

    if(!preset){
      singleSavePreset = null;
      $("singleTargetEnabled").checked = false;
      $("singleTargetKB").disabled = true;
      updateSingleFormatUI();
      return;
    }

    $("singleTargetEnabled").checked = preset.target;
    $("singleTargetKB").disabled = !preset.target;

    if(preset.kb){
      $("singleTargetKB").value = preset.kb;
    }

    $("singleFormat").value = preset.format === "original"
      ? (SUPPORTED_TYPES.includes(state.sourceFile?.type)
        ? state.sourceFile.type
        : "image/jpeg")
      : preset.format;

    singleSavePreset = preset;
    updateSingleFormatUI();
    toast("保存する画像の設定を適用しました。");
  }

  $("presetSelect").addEventListener("change",applySinglePreset);

  function singleSaveDimensions(width,height,preset=singleSavePreset){
    let ratio = 1;
    if(preset?.longEdge){
      ratio = Math.min(1,preset.longEdge/Math.max(width,height));
    }else if(preset?.width && preset?.height){
      ratio = Math.min(1,preset.width/width,preset.height/height);
    }
    return {
      width:Math.max(1,Math.round(width*ratio)),
      height:Math.max(1,Math.round(height*ratio))
    };
  }

  function updateSingleSaveSize(){
    const summary = $("singleSaveSize");
    if(!summary || !baseCanvas.width) return;
    const dimensions = singleSaveDimensions(baseCanvas.width,baseCanvas.height);
    summary.textContent = `編集中: ${baseCanvas.width} × ${baseCanvas.height}px / 保存: ${dimensions.width} × ${dimensions.height}px`;
  }

  function openSaveSettings(){
    if(!state.originalCanvas || state.singleBusy || state.drag || viewState.pan) return;
    finishTextEditing();
    saveReturnFocus = document.activeElement;
    updateSingleSaveSize();
    $("saveDialog").classList.remove("hidden");
    $("appMain").inert = true;
    document.querySelectorAll(".appbox-header").forEach(element => {element.inert = true;});
    document.body.classList.add("dialog-open");
    $("closeSaveSettings").focus();
  }

  function closeSaveSettings(){
    if($("saveDialog").classList.contains("hidden")) return;
    $("saveDialog").classList.add("hidden");
    if($("previewDialog").classList.contains("hidden")){
      document.body.classList.remove("dialog-open");
      $("appMain").inert = false;
      document.querySelectorAll(".appbox-header").forEach(element => {element.inert = false;});
    }
    if(saveReturnFocus && typeof saveReturnFocus.focus === "function"){
      saveReturnFocus.focus();
    }
  }

  $("showSaveSettings").addEventListener("click",openSaveSettings);
  $("closeSaveSettings").addEventListener("click",closeSaveSettings);
  $("saveDialog").addEventListener("click",event => {
    if(event.target === $("saveDialog")) closeSaveSettings();
  });
  $("saveDialog").addEventListener("keydown",event => {
    if(event.isComposing || state.composing || event.keyCode === 229) return;
    if(event.key === "Escape"){
      event.preventDefault();
      closeSaveSettings();
      return;
    }
    if(event.key !== "Tab") return;
    const focusable = $$(
      "#saveDialog button:not(:disabled),#saveDialog input:not(:disabled),#saveDialog select:not(:disabled),#saveDialog textarea:not(:disabled),#saveDialog [tabindex]:not([tabindex='-1'])"
    ).filter(element => !element.closest(".hidden") && element.type !== "hidden");
    if(!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length-1];
    if(!focusable.includes(document.activeElement)){
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }else if(event.shiftKey && document.activeElement === first){
      event.preventDefault();
      last.focus();
    }else if(!event.shiftKey && document.activeElement === last){
      event.preventDefault();
      first.focus();
    }
  });

  function flattenForJpeg(source,background){
    const output = createCanvas(source.width,source.height);
    const context = output.getContext("2d");
    context.fillStyle = background === "black" ? "#000" : "#fff";
    context.fillRect(0,0,output.width,output.height);
    context.drawImage(source,0,0);
    return output;
  }

  async function encodeToTarget(
    source,
    type,
    targetEnabled,
    targetKB,
    jpegBackground="white"
  ){
    let work = type === "image/jpeg"
        ? flattenForJpeg(source,jpegBackground)
        : cloneCanvas(source);

    if(!targetEnabled){
        const blob = await canvasToBlob(
        work,
        type,
        type === "image/png" ? undefined : .92
        );

        return {
        blob,
        width:work.width,
        height:work.height,
        targetMet:true
        };
    }

    const target = targetKB*1024;

    if(type === "image/png"){
        for(let index=0; index<10; index++){
        const blob = await canvasToBlob(work,type);

        if(
            blob.size <= target ||
            Math.max(work.width,work.height) <= 64
        ){
            return {
            blob,
            width:work.width,
            height:work.height,
            targetMet:blob.size <= target
            };
        }

        const factor = clamp(
            Math.sqrt(target/blob.size)*.95,
            .5,
            .9
        );

        work = resizeToLongEdge(
            work,
            Math.max(
            64,
            Math.round(
                Math.max(work.width,work.height)*factor
            )
            ),
            false
        );
        }

        const blob = await canvasToBlob(work,type);

        return {
        blob,
        width:work.width,
        height:work.height,
        targetMet:blob.size <= target
        };
    }

    for(let outer=0; outer<8; outer++){
        let low = .12;
        let high = .95;
        let best = null;

        for(let index=0; index<8; index++){
        const quality = (low+high)/2;
        const blob = await canvasToBlob(
            work,
            type,
            quality
        );

        if(blob.size <= target){
            best = blob;
            low = quality;
        }else{
            high = quality;
        }
        }

        if(best){
        return {
            blob:best,
            width:work.width,
            height:work.height,
            targetMet:true
        };
        }

        const minimum = await canvasToBlob(
        work,
        type,
        .12
        );

        if(Math.max(work.width,work.height) <= 64){
        return {
            blob:minimum,
            width:work.width,
            height:work.height,
            targetMet:minimum.size <= target
        };
        }

        const factor = clamp(
        Math.sqrt(target/minimum.size)*.95,
        .55,
        .9
        );

        work = resizeToLongEdge(
        work,
        Math.max(
            64,
            Math.round(
            Math.max(work.width,work.height)*factor
            )
        ),
        false
        );
    }

    const blob = await canvasToBlob(work,type,.12);

    return {
        blob,
        width:work.width,
        height:work.height,
        targetMet:blob.size <= target
    };
  }


  function updateSingleFormatUI(){
    const jpeg = $("singleFormat").value === "image/jpeg";
    $("singleJpegNote")?.classList.toggle("hidden",!jpeg);
    updateSingleSaveSize();
  }

  $("singleFormat").addEventListener("change",updateSingleFormatUI);

  $("singleTargetEnabled").addEventListener("change",() => {
    $("singleTargetKB").disabled = !$("singleTargetEnabled").checked;
  });

  $("singleSave").addEventListener("click",async () => {
    if(state.singleBusy || state.drag || !state.originalCanvas) return;
    const version = state.loadVersion;
    const savedRevision = state.revision;
    try{
        const type = $("singleFormat").value;
        const targetEnabled =
        $("singleTargetEnabled").checked;
        const targetKB =
        Number($("singleTargetKB").value);

        if(
        targetEnabled &&
        (!Number.isFinite(targetKB) || targetKB < 10)
        ){
        throw new Error(
            "目標容量は10KB以上で指定してください。"
        );
        }

        state.singleBusy = true;
        $("singleSave").disabled = true;
        $("closeSaveSettings").focus();
        setSingleStatus(
        "加工結果を書き出しています。"
        );

        const composite = compositeCanvas();
        const dimensions = singleSaveDimensions(composite.width,composite.height);
        const output = dimensions.width === composite.width && dimensions.height === composite.height
          ? composite
          : resizeCanvasExact(composite,dimensions.width,dimensions.height);
        const fileName =
        `${sanitizeBaseName(
            $("singleSaveName").value
        )}.${extensionForType(type)}`;

        const result = await encodeToTarget(
        output,
        type,
        targetEnabled,
        targetKB,
        "white"
        );

        if(version !== state.loadVersion) return;
        saveBlob(result.blob,fileName);
        state.savedRevision = savedRevision;
        closeSaveSettings();

        if(targetEnabled && !result.targetMet){
        toast(`${fileName}を保存しました。目標容量には届きませんでした。`);
        setSingleStatus(
            `${fileName}を保存しましたが、` +
            `目標${targetKB}KB以下にはできませんでした。` +
            ` 実際の容量: ${bytes(result.blob.size)} / ` +
            `${result.width} × ${result.height}px`,
            "warn"
        );
        }else{
        toast(`${fileName}を保存しました。`);
        setSingleStatus(
            `${fileName}を保存しました。` +
            `${result.width} × ${result.height}px、` +
            `${bytes(result.blob.size)}`,
            "ok"
        );
        }
    }catch(error){
        if(version !== state.loadVersion) return;
        setSingleStatus(
        error.message || "保存に失敗しました。",
        "warn"
        );
    }finally{
        if(version === state.loadVersion) state.singleBusy = false;
        $("singleSave").disabled = false;
    }
  });


  function updateBatchControls(){
    const busy =
        batchState.processing ||
        batchState.adding;

    $("batchProcess").disabled =
        busy || !batchState.items.length;

    $("batchCancel").classList.toggle(
        "hidden",
        !batchState.processing
    );

    $("batchCancel").disabled =
        !batchState.processing ||
        batchState.cancelRequested;

    $("batchAdd").disabled = busy;
    $("batchClear").disabled = busy;
    $("batchChoose").disabled = busy;
    $("singleTab").disabled = busy;
    $("batchTab").disabled = busy;
    $("zipName").disabled = busy;

    $("batchRedownload").disabled =
        busy || !batchState.lastZip;
    syncModeControls();

    $$("#batchSettingsPanel input," +
        "#batchSettingsPanel select," +
        "#batchSettingsPanel button"
    ).forEach(control => {
        control.disabled = busy;
    });

    if(!busy){
        updateBatchResizeUI();
        updateBatchFormatUI();

        $("batchTargetKB").disabled =
        !$("batchTargetEnabled").checked;
    }
  }


  function renderBatch(){
    const list = $("batchList");
    list.innerHTML = "";
    $("batchCount").textContent = `${batchState.items.length}枚`;

    if(!batchState.items.length){
      const empty = document.createElement("div");
      empty.className = "empty-message";
      empty.textContent = "画像が追加されていません。";
      list.appendChild(empty);
      updateBatchControls();
      return;
    }

    batchState.items.forEach((item,index) => {
      const row = document.createElement("div");
      row.className = "batch-item";

      const image = document.createElement("img");
      image.className = "batch-thumb";
      image.src = item.thumbnail;
      image.alt = "";

      const meta = document.createElement("div");
      meta.className = "batch-meta";

      const name = document.createElement("strong");
      name.textContent = item.file.name;

      const detail = document.createElement("span");
      detail.textContent =
        `${item.width} × ${item.height}px / ${bytes(item.file.size)}`;

      const output = document.createElement("span");
      output.textContent = item.outputName
        ? `→ ${item.outputName} / ${bytes(item.outputSize)}`
        : "";

      meta.append(name,detail,output);

      if(item.error){
        const error = document.createElement("span");
        error.className = "batch-error";
        error.textContent = item.error;
        meta.appendChild(error);
      }

      const actions = document.createElement("div");
      actions.className = "batch-item-actions";

      const tag = document.createElement("span");
      tag.className = "tag" +
        (item.statusClass ? ` ${item.statusClass}` : "");
      tag.textContent = item.status || "待機中";

      const remove = document.createElement("button");
      remove.className = "button plain";
      remove.type = "button";
      remove.textContent = "削除";
      remove.disabled = batchState.processing || batchState.adding;

      remove.addEventListener("click",() => {
        URL.revokeObjectURL(item.thumbnail);
        batchState.items.splice(index,1);

        if(!batchState.items.length){
          batchState.lastZip = null;
          $("batchRedownload").disabled = true;
        }

        renderBatch();
      });

      actions.append(tag,remove);
      row.append(image,meta,actions);
      list.appendChild(row);
    });

    updateBatchControls();
  }

  async function createThumbnail(image){
    const width = image.width || image.naturalWidth;
    const height = image.height || image.naturalHeight;
    const ratio = Math.min(1,160/Math.max(width,height));

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1,Math.round(width*ratio));
    canvas.height = Math.max(1,Math.round(height*ratio));

    const context = canvas.getContext("2d",{alpha:false});
    context.fillStyle = "#fff";
    context.fillRect(0,0,canvas.width,canvas.height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(image,0,0,canvas.width,canvas.height);

    const blob = await canvasToBlob(
        canvas,
        "image/jpeg",
        .78,
        false
    );

    return URL.createObjectURL(blob);
  }


  async function addBatchFiles(files){
    if(batchState.processing || batchState.adding) return;

    const candidates = [...(files || [])].filter(isSupportedImage);

    if(!candidates.length){
      toast("JPEG・PNG・WebP画像を選択してください。");
      return;
    }

    batchState.adding = true;
    const version = ++batchState.addVersion;
    updateBatchControls();

    let total = batchState.items.reduce(
      (sum,item) => sum+item.file.size,
      0
    );

    let added = 0;
    let skippedCapacity = 0;
    let skippedSize = 0;
    let skippedInvalid = 0;

    setBatchStatus("画像を追加しています。");

    try{
      for(const file of candidates){
        if(version !== batchState.addVersion) break;

        if(batchState.items.length >= MAX_BATCH_FILES){
          skippedCapacity++;
          continue;
        }

        if(
          file.size > MAX_FILE_BYTES ||
          total+file.size > MAX_BATCH_BYTES
        ){
          skippedSize++;
          continue;
        }

        let image = null;

        try{
          image = await decodeImage(file);

          if(version !== batchState.addVersion) break;

          const width = image.width || image.naturalWidth;
          const height = image.height || image.naturalHeight;
          validateDimensions(width,height);

          const thumbnail = await createThumbnail(image);

          if(version !== batchState.addVersion){
            URL.revokeObjectURL(thumbnail);
            break;
          }

          batchState.items.push({
            file,
            width,
            height,
            thumbnail,
            status:"待機中",
            statusClass:"",
            outputName:null,
            outputSize:null,
            error:null
          });

          total += file.size;
          added++;
        }catch(error){
          skippedInvalid++;
        }finally{
          if(image && typeof image.close === "function"){
            image.close();
          }
        }
      }
    }finally{
      if(version === batchState.addVersion){
        batchState.adding = false;
        if(added) modeChoicesOpen = false;
        renderBatch();

        const skipped = skippedCapacity+skippedSize+skippedInvalid;
        const message =
          `${added}枚を追加しました。` +
          (skipped
            ? ` スキップ: 枚数上限${skippedCapacity}件、容量超過${skippedSize}件、読込み失敗${skippedInvalid}件。`
            : "");

        setBatchStatus(message,skipped ? "warn" : "ok");
      }
    }
  }

  const batchInput = $("batchInput");

  $("batchChoose").addEventListener("click",event => {
    event.stopPropagation();
    batchInput.value = "";
    batchInput.click();
  });

  $("batchAdd").addEventListener("click",() => {
    batchInput.value = "";
    batchInput.click();
  });

  batchInput.addEventListener("change",() => {
    addBatchFiles(batchInput.files);
  });

  bindDropZone(
    $("batchDrop"),
    batchInput,
    files => addBatchFiles(files)
  );

  $("batchClear").addEventListener("click",() => {
    if(batchState.processing || batchState.adding) return;

    batchState.addVersion++;
    batchState.items.forEach(item => {
      URL.revokeObjectURL(item.thumbnail);
    });

    batchState.items = [];
    batchState.lastZip = null;
    $("batchRedownload").disabled = true;
    $("batchResult").textContent = "未処理";
    renderBatch();
    setBatchStatus("一覧を消去しました。");
  });

  $("batchCancel").addEventListener("click",() => {
    if(!batchState.processing) return;

    batchState.cancelRequested = true;
    $("batchCancel").disabled = true;
    setBatchStatus(
      "中止を受け付けました。現在の画像処理が完了した後に停止します。",
      "warn"
    );
  });

  function applyBatchPreset(){
    const preset = presets[$("batchPreset").value];

    if(!preset){
        toast("プリセットを選択してください。");
        return;
    }

    if(preset.longEdge){
        $("batchResizeMode").value = "longEdge";
        $("batchW").value = preset.longEdge;
    }else if(preset.width && preset.height){
        $("batchResizeMode").value = "fit";
        $("batchW").value = preset.width;
        $("batchH").value = preset.height;
    }else{
        $("batchResizeMode").value = "none";
    }

    $("batchFormat").value = preset.format === "original"
        ? "original"
        : preset.format;

    $("batchTargetEnabled").checked = preset.target;

    if(preset.kb){
        $("batchTargetKB").value = preset.kb;
    }

    updateBatchResizeUI();
    updateBatchFormatUI();
    $("batchTargetKB").disabled = !preset.target;

    const formatLabel = {
        original:"元画像と同じ形式",
        "image/jpeg":"JPEG",
        "image/png":"PNG",
        "image/webp":"WebP"
    }[$("batchFormat").value];

    toast(
        `プリセットを適用しました。出力形式は${formatLabel}です。`
    );
  }

  $("applyBatchPreset").addEventListener("click",applyBatchPreset);

  function updateBatchResizeUI(){
    const mode = $("batchResizeMode").value;
    const busy = batchState.processing || batchState.adding;

    $("batchSizeFields").classList.toggle("hidden",mode === "none");
    $("batchHField").classList.toggle("hidden",mode !== "fit");

    $("batchWLabel").textContent = {
      longEdge:"長辺",
      fit:"最大横幅",
      width:"横幅",
      height:"高さ"
    }[mode] || "値";

    $("batchNoUpscale").disabled = busy || mode === "none";
  }

  $("batchResizeMode").addEventListener("change",updateBatchResizeUI);

  function updateBatchFormatUI(){
    const format = $("batchFormat").value;
    const mayUseJpeg = format === "image/jpeg" || format === "original";
    $("batchJpegBackgroundField").classList.toggle(
      "hidden",
      !mayUseJpeg
    );
  }

  $("batchFormat").addEventListener("change",updateBatchFormatUI);

  $("batchTargetEnabled").addEventListener("change",() => {
    $("batchTargetKB").disabled = !$("batchTargetEnabled").checked;
  });

  function readRequiredInteger(id,label,min,max){
    const text = $(id).value.trim();
    const value = Number(text);

    if(
      !text ||
      !Number.isSafeInteger(value) ||
      value < min ||
      value > max
    ){
      throw new Error(`${label}は${min}～${max}の整数で指定してください。`);
    }

    return value;
  }

  function readRequiredNumber(id,label,min,max){
    const text = $(id).value.trim();
    const value = Number(text);

    if(
      !text ||
      !Number.isFinite(value) ||
      value < min ||
      value > max
    ){
      throw new Error(`${label}は${min}～${max}の範囲で指定してください。`);
    }

    return value;
  }

  function collectBatchSettings(){
    const mode = $("batchResizeMode").value;
    const watermarkEnabled =
        $("watermarkEnabled").checked;

    const watermark = {
        enabled:watermarkEnabled,
        text:$("watermarkText").value.trim(),
        position:$("watermarkPosition").value,
        opacity:35,
        size:5,
        color:$("watermarkColor").value
    };

    if(watermarkEnabled){
        watermark.opacity = readRequiredNumber(
        "watermarkOpacity",
        "透かしの透明度",
        5,
        100
        );

        watermark.size = readRequiredNumber(
        "watermarkSize",
        "透かしの文字サイズ",
        1,
        30
        );

        if(!watermark.text){
        throw new Error(
            "透かし文字を入力してください。"
        );
        }
    }

    const settings = {
        mode,
        noUpscale:$("batchNoUpscale").checked,
        rotation:Number($("batchRotation").value),
        format:$("batchFormat").value,
        jpegBackground:
        $("batchJpegBackground").value,
        targetEnabled:
        $("batchTargetEnabled").checked,
        watermark,
        replaceFrom:$("replaceFrom").value,
        replaceTo:$("replaceTo").value,
        prefix:$("batchPrefix").value,
        suffix:$("batchSuffix").value,
        sequenceEnabled:
        $("sequenceEnabled").checked,
        zipName:
        `${sanitizeBaseName(
            $("zipName").value || "images-batch"
        )}.zip`
    };

    if(mode === "longEdge"){
        settings.width = readRequiredInteger(
        "batchW",
        "長辺",
        1,
        MAX_DIMENSION
        );
    }else if(mode === "fit"){
        settings.width = readRequiredInteger(
        "batchW",
        "最大横幅",
        1,
        MAX_DIMENSION
        );

        settings.height = readRequiredInteger(
        "batchH",
        "最大高さ",
        1,
        MAX_DIMENSION
        );
    }else if(mode === "width"){
        settings.width = readRequiredInteger(
        "batchW",
        "横幅",
        1,
        MAX_DIMENSION
        );
    }else if(mode === "height"){
        settings.height = readRequiredInteger(
        "batchW",
        "高さ",
        1,
        MAX_DIMENSION
        );
    }

    if(settings.targetEnabled){
        settings.targetKB = readRequiredNumber(
        "batchTargetKB",
        "目標容量",
        10,
        1048576
        );
    }else{
        settings.targetKB = 0;
    }

    if(settings.sequenceEnabled){
        settings.sequenceBase = sanitizeBaseName(
        $("sequenceBase").value || "image"
        );

        settings.sequenceStart = readRequiredInteger(
        "sequenceStart",
        "連番の開始番号",
        0,
        99999999
        );

        settings.sequenceDigits = readRequiredInteger(
        "sequenceDigits",
        "連番の桁数",
        1,
        8
        );
    }

    return settings;
  }


  function batchDimensions(width,height,settings){
    let ratio = 1;

    if(settings.mode === "longEdge"){
      ratio = settings.width/Math.max(width,height);
    }else if(settings.mode === "fit"){
      ratio = Math.min(
        settings.width/width,
        settings.height/height
      );
    }else if(settings.mode === "width"){
      ratio = settings.width/width;
    }else if(settings.mode === "height"){
      ratio = settings.height/height;
    }else if(settings.mode === "none"){
      ratio = 1;
    }

    if(settings.noUpscale){
      ratio = Math.min(1,ratio);
    }

    const outputWidth = Math.max(1,Math.round(width*ratio));
    const outputHeight = Math.max(1,Math.round(height*ratio));
    validateDimensions(outputWidth,outputHeight);

    return {
      width:outputWidth,
      height:outputHeight
    };
  }

  function rotateCanvas(source,degrees){
    if(!degrees) return cloneCanvas(source);

    const swap = Math.abs(degrees) === 90;
    const output = createCanvas(
      swap ? source.height : source.width,
      swap ? source.width : source.height
    );
    const context = output.getContext("2d");

    context.translate(output.width/2,output.height/2);
    context.rotate(degrees*Math.PI/180);
    context.drawImage(source,-source.width/2,-source.height/2);
    return output;
  }

  function flipCanvas(source,horizontal){
    const output = createCanvas(source.width,source.height);
    const context = output.getContext("2d");
    if(horizontal){
      context.translate(output.width,0);
      context.scale(-1,1);
    }else{
      context.translate(0,output.height);
      context.scale(1,-1);
    }
    context.drawImage(source,0,0);
    return output;
  }

  function addWatermark(canvas,settings){
    if(!settings.enabled || !settings.text) return;

    const context = canvas.getContext("2d");
    const size = Math.max(
      12,
      Math.round(
        Math.min(canvas.width,canvas.height)*settings.size/100
      )
    );
    const margin = Math.max(10,size*.6);

    context.save();
    context.globalAlpha = settings.opacity/100;
    context.fillStyle = settings.color;
    context.strokeStyle = settings.color.toLowerCase() === "#ffffff"
      ? "#000"
      : "#fff";
    context.lineWidth = Math.max(1,size/18);
    context.font = `bold ${size}px sans-serif`;
    context.textBaseline = "middle";

    const textWidth = context.measureText(settings.text).width;
    let x = margin;
    let y = margin+size/2;

    if(settings.position === "topRight" || settings.position === "bottomRight"){
      x = canvas.width-margin-textWidth;
    }

    if(settings.position === "bottomLeft" || settings.position === "bottomRight"){
      y = canvas.height-margin-size/2;
    }

    if(settings.position === "center" || settings.position === "diagonal"){
      x = canvas.width/2-textWidth/2;
      y = canvas.height/2;
    }

    if(settings.position === "diagonal"){
      context.translate(canvas.width/2,canvas.height/2);
      context.rotate(-Math.PI/4);
      context.strokeText(settings.text,-textWidth/2,0);
      context.fillText(settings.text,-textWidth/2,0);
    }else{
      context.strokeText(settings.text,x,y);
      context.fillText(settings.text,x,y);
    }

    context.restore();
  }

  function outputTypeFor(file,preferred){
    return preferred === "original"
      ? (SUPPORTED_TYPES.includes(file.type) ? file.type : "image/jpeg")
      : preferred;
  }

  function outputNameFor(item,index,settings,type,usedNames){
    let base;

    if(settings.sequenceEnabled){
      const number = String(settings.sequenceStart+index)
        .padStart(settings.sequenceDigits,"0");
      base = `${settings.sequenceBase}_${number}`;
    }else{
      base = sanitizeBaseName(item.file.name);

      if(settings.replaceFrom){
        base = base.split(settings.replaceFrom).join(settings.replaceTo);
      }
    }

    base = sanitizeBaseName(
      `${settings.prefix}${base}${settings.suffix}`
    );

    const extension = extensionForType(type);
    let name = `${base}.${extension}`;
    let duplicate = 2;

    while(usedNames.has(name.toLocaleLowerCase("ja"))){
      name = `${base}-${duplicate}.${extension}`;
      duplicate++;
    }

    usedNames.add(name.toLocaleLowerCase("ja"));
    return name;
  }

  async function fileToCanvas(file){
    let image = null;

    try{
      image = await decodeImage(file);

      const width = image.width || image.naturalWidth;
      const height = image.height || image.naturalHeight;
      validateDimensions(width,height);

      const canvas = createCanvas(width,height);
      canvas.getContext("2d").drawImage(image,0,0,width,height);
      return canvas;
    }finally{
      if(image && typeof image.close === "function"){
        image.close();
      }
    }
  }

  function csvCell(value){
    let text = String(value ?? "");

    if(/^[\s\u0000-\u001f]*[=+\-@]/.test(text)){
      text = "'" + text;
    }

    return /[",\r\n]/.test(text)
      ? `"${text.replace(/"/g,'""')}"`
      : text;
  }

  function buildResultCsv(results){
    const lines = [[
        "元ファイル名",
        "結果",
        "出力ファイル名",
        "出力幅",
        "出力高さ",
        "出力容量（byte）",
        "目標容量達成",
        "エラー"
    ].map(csvCell).join(",")];

    results.forEach(result => {
        lines.push([
        result.original,
        result.status,
        result.output || "",
        result.width || "",
        result.height || "",
        result.size || "",
        result.targetMet === true
            ? "達成"
            : result.targetMet === false
            ? "未達"
            : "",
        result.error || ""
        ].map(csvCell).join(","));
    });

    return new Blob(
        ["\uFEFF"+lines.join("\r\n")],
        {type:"text/csv;charset=utf-8"}
    );
  }

  const CRC_TABLE = new Uint32Array(256);

  for(let n=0; n<256; n++){
    let value = n;

    for(let k=0; k<8; k++){
      value = (value&1)
        ? (0xEDB88320^(value>>>1))
        : (value>>>1);
    }

    CRC_TABLE[n] = value>>>0;
  }

  function crc32(data){
    let crc = 0xFFFFFFFF;

    for(const byte of data){
      crc = CRC_TABLE[(crc^byte)&0xFF]^(crc>>>8);
    }

    return (crc^0xFFFFFFFF)>>>0;
  }

  function u16(value){
    const array = new Uint8Array(2);
    new DataView(array.buffer).setUint16(0,value,true);
    return array;
  }

  function u32(value){
    const array = new Uint8Array(4);
    new DataView(array.buffer).setUint32(0,value>>>0,true);
    return array;
  }

  function concatArrays(parts){
    const length = parts.reduce(
      (total,part) => total+part.length,
      0
    );
    const output = new Uint8Array(length);
    let offset = 0;

    parts.forEach(part => {
      output.set(part,offset);
      offset += part.length;
    });

    return output;
  }

  function dosDateTime(date=new Date()){
    const year = Math.max(1980,date.getFullYear());

    return {
      time:
        ((date.getHours()&31)<<11) |
        ((date.getMinutes()&63)<<5) |
        (Math.floor(date.getSeconds()/2)&31),
      date:
        (((year-1980)&127)<<9) |
        (((date.getMonth()+1)&15)<<5) |
        (date.getDate()&31)
    };
  }

  async function buildZip(files,onProgress=null){
    const encoder = new TextEncoder();
    const localParts = [];
    const centralParts = [];
    let offset = 0;
    const stamp = dosDateTime();

    for(let index=0; index<files.length; index++){
        const file = files[index];

        if(onProgress){
        onProgress(index+1,files.length,file.name);
        }

        await new Promise(resolve => {
        setTimeout(resolve,0);
        });

        const name = encoder.encode(file.name);
        const data = new Uint8Array(
        await file.blob.arrayBuffer()
        );
        const checksum = crc32(data);

        const local = concatArrays([
        u32(0x04034b50),
        u16(20),
        u16(0x0800),
        u16(0),
        u16(stamp.time),
        u16(stamp.date),
        u32(checksum),
        u32(data.length),
        u32(data.length),
        u16(name.length),
        u16(0),
        name,
        data
        ]);

        localParts.push(local);

        centralParts.push(concatArrays([
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(0x0800),
        u16(0),
        u16(stamp.time),
        u16(stamp.date),
        u32(checksum),
        u32(data.length),
        u32(data.length),
        u16(name.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        name
        ]));

        offset += local.length;
    }

    const central = concatArrays(
        centralParts
    );

    const end = concatArrays([
        u32(0x06054b50),
        u16(0),
        u16(0),
        u16(files.length),
        u16(files.length),
        u32(central.length),
        u32(offset),
        u16(0)
    ]);

    return new Blob(
        [...localParts,central,end],
        {type:"application/zip"}
    );
  }


  $("batchProcess").addEventListener("click",async () => {
    if(
      batchState.processing ||
      batchState.adding ||
      !batchState.items.length
    ){
      return;
    }

    let settings;

    try{
      settings = collectBatchSettings();
    }catch(error){
      setBatchStatus(error.message,"warn");
      return;
    }

    batchState.processing = true;
    batchState.cancelRequested = false;
    batchState.lastZip = null;
    $("batchRedownload").disabled = true;
    updateBatchControls();

    const outputs = [];
    const results = [];
    const processedItems = new Set();
    const usedNames = new Set();
    let success = 0;
    let failed = 0;
    let targetMissed = 0;

    batchState.items.forEach(item => {
      item.status = "待機中";
      item.statusClass = "";
      item.outputName = null;
      item.outputSize = null;
      item.error = null;
    });

    renderBatch();

    try{
      for(let index=0; index<batchState.items.length; index++){
        if(batchState.cancelRequested) break;

        const item = batchState.items[index];
        item.status = "処理中";
        item.statusClass = "proc";
        renderBatch();

        setBatchStatus(
          `${index+1}/${batchState.items.length}枚目を処理しています。`
        );

        try{
          let work = await fileToCanvas(item.file);

          if(batchState.cancelRequested){
            item.status = "未処理";
            item.statusClass = "";
            renderBatch();
            break;
          }

          const dimensions = batchDimensions(
            work.width,
            work.height,
            settings
          );

          if(
            dimensions.width !== work.width ||
            dimensions.height !== work.height
          ){
            work = resizeCanvasExact(
              work,
              dimensions.width,
              dimensions.height
            );
          }

          if(batchState.cancelRequested){
            item.status = "未処理";
            item.statusClass = "";
            renderBatch();
            break;
          }

          work = rotateCanvas(work,settings.rotation);
          addWatermark(work,settings.watermark);

          const type = outputTypeFor(item.file,settings.format);
          const encoded = await encodeToTarget(
            work,
            type,
            settings.targetEnabled,
            settings.targetKB,
            settings.jpegBackground
          );

          const outputName = outputNameFor(
            item,
            index,
            settings,
            type,
            usedNames
          );

          outputs.push({
            name:outputName,
            blob:encoded.blob
          });

          if(
            settings.targetEnabled &&
            !encoded.targetMet
          ){
            item.status = "成功・容量未達";
            item.statusClass = "warn";
            item.error =
                `目標${settings.targetKB}KB以下にはできませんでした。`;
            targetMissed++;
          }else{
            item.status = "成功";
            item.statusClass = "ok";
            item.error = null;
          }
          item.outputName = outputName;
          item.outputSize = encoded.blob.size;
          processedItems.add(item);
          success++;

          results.push({
            original:item.file.name,
            status:
                settings.targetEnabled && !encoded.targetMet
                ? "成功（目標容量未達）"
                : "成功",
            output:outputName,
            width:encoded.width,
            height:encoded.height,
            size:encoded.blob.size,
            targetMet:
                settings.targetEnabled
                ? encoded.targetMet
                : null,
          error:
                settings.targetEnabled && !encoded.targetMet
                ? `目標${settings.targetKB}KB以下にはできませんでした。`
                : ""
          });

        }catch(error){
          item.status = "失敗";
          item.statusClass = "warn";
          item.error = error.message || "処理エラー";
          processedItems.add(item);
          failed++;

          results.push({
            original:item.file.name,
            status:"失敗",
            output:"",
            width:"",
            height:"",
            size:"",
            targetMet:null,
            error:item.error
          });

        }

        renderBatch();
      }

      const cancelled = batchState.cancelRequested;

      batchState.items.forEach(item => {
        if(item.status === "処理中"){
          item.status = "未処理";
          item.statusClass = "";
        }

        if(!processedItems.has(item)){
          item.status = "未処理";
          item.statusClass = "";

          results.push({
            original:item.file.name,
            status:"未処理",
            output:"",
            width:"",
            height:"",
            size:"",
            targetMet:null,
            error:
                cancelled
                ? "利用者により処理中止"
                : "未処理"
          });
        }
      });

      renderBatch();

      outputs.push({
        name:"処理結果.csv",
        blob:buildResultCsv(results)
      });

      setBatchStatus("ZIPファイルを作成しています。");

      const zip = await buildZip(
        outputs,
        (current,total,fileName) => {
            setBatchStatus(
            `ZIPを作成しています。` +
            `${current}/${total}: ${fileName}`
            );
        }
      );

      batchState.lastZip = zip;
      batchState.lastZipName = settings.zipName;
      saveBlob(zip,settings.zipName);
      $("batchRedownload").disabled = false;

      const unprocessed = batchState.items.length-success-failed;
          $("batchResult").textContent =
            `成功: ${success}件 / ` +
            `容量未達: ${targetMissed}件 / ` +
            `失敗: ${failed}件 / ` +
            `未処理: ${unprocessed}件`;

      if(cancelled){
          setBatchStatus(
            `処理を中止しました。` +
            `成功${success}件` +
            (targetMissed
                ? `（うち容量未達${targetMissed}件）`
                : "") +
            `、失敗${failed}件、未処理${unprocessed}件です。` +
            "中止前までの成功画像と全件の処理結果CSVをZIPへ保存しました。",
            "warn"
          );
      }else{
          setBatchStatus(
            `一括処理が完了しました。` +
            `成功${success}件` +
            (targetMissed
                ? `（うち容量未達${targetMissed}件）`
                : "") +
            `、失敗${failed}件です。`,
            failed || targetMissed ? "warn" : "ok"
          );

      }
    }catch(error){
      batchState.items.forEach(item => {
        if(item.status === "処理中"){
          item.status = "未処理";
          item.statusClass = "";
        }
      });

      renderBatch();
      setBatchStatus(
        error.message || "一括処理に失敗しました。",
        "warn"
      );
    }finally{
      batchState.processing = false;
      batchState.cancelRequested = false;
      updateBatchControls();
    }
  });

  $("batchRedownload").addEventListener("click",() => {
    if(batchState.lastZip){
      saveBlob(
        batchState.lastZip,
        batchState.lastZipName
      );
    }
  });

  function activateTab(button){
    if(batchState.processing || batchState.adding || state.drag || viewState.pan || state.composing) return;
    finishTextEditing();
    modeChoicesOpen = false;

    $$(".appbox-tab").forEach(tab => {
      const active = tab === button;
      tab.classList.toggle("is-active",active);
      tab.setAttribute("aria-selected",String(active));
      tab.tabIndex = active ? 0 : -1;

      const panel = $(tab.dataset.panel);
      panel.hidden = !active;
    });

    syncEditorChrome();
    syncDisplaySize();
    if($("processingModeTabs").hidden){
      if(!$("singlePanel").hidden) editCanvas.focus({preventScroll:true});
      else $("batchAdd").focus();
    }else button.focus();
  }

  $("changeProcessingMode").addEventListener("click",() => {
    if(state.singleBusy || batchState.processing || batchState.adding || state.drag || viewState.pan || state.composing) return;
    finishTextEditing();
    modeChoicesOpen = true;
    syncModeControls();
    const active = $$(".appbox-tab").find(tab => tab.getAttribute("aria-selected") === "true");
    (active || $("singleTab")).focus();
    scheduleDisplayResize();
  });

  $$(".appbox-tab").forEach((button,index,tabs) => {
    button.addEventListener("click",() => activateTab(button));

    button.addEventListener("keydown",event => {
      if(!["ArrowLeft","ArrowRight","Home","End"].includes(event.key)){
        return;
      }

      event.preventDefault();
      let nextIndex = index;

      if(event.key === "ArrowRight"){
        nextIndex = (index+1)%tabs.length;
      }else if(event.key === "ArrowLeft"){
        nextIndex = (index-1+tabs.length)%tabs.length;
      }else if(event.key === "Home"){
        nextIndex = 0;
      }else if(event.key === "End"){
        nextIndex = tabs.length-1;
      }

      if(!tabs[nextIndex].disabled){
        activateTab(tabs[nextIndex]);
      }
    });
  });

    window.AppBoxImageActions?.initialize({
      $,state,editCanvas,canvasViewport,baseCanvas,toast,selectedLayers,selectLayers,
      hitLayer,pointFromEvent,cancelSelectionGesture,setTool,renderLayers,renderEditor,
      updateSelectedControls,pushHistory,makeId,createCanvas,saveBlob,
      copySelectedLayers,pasteObjectClipboard,deleteSelectedLayer,reorderSelectedLayers,
      canPaste:() => !!objectClipboard,clipboardText:() => objectClipboardText
    });

    updateSingleFormatUI();
    updateBatchResizeUI();
    updateBatchFormatUI();

    $("singleTargetKB").disabled =
    !$("singleTargetEnabled").checked;

    $("batchTargetKB").disabled =
    !$("batchTargetEnabled").checked;

    updateHistoryButtons();
    updateCropControls();
    syncEditorChrome();
    renderLayers();
    renderBatch();
})();
