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

  const $ = id => document.getElementById(id);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const clamp = (value,min,max) => Math.min(max,Math.max(min,value));
  const isFiniteInteger = value => Number.isSafeInteger(value);

  const baseCanvas = $("baseCanvas");
  const baseContext = baseCanvas.getContext("2d");

  const layerCanvas = $("layerCanvas");
  const layerContext = layerCanvas.getContext("2d");

  const editCanvas = $("editCanvas");
  const editContext = editCanvas.getContext("2d");

  const state = {
    sourceFile:null,
    originalCanvas:null,
    layers:[],
    selectedLayerId:null,
    tool:null,
    crop:null,
    drag:null,
    undo:[],
    redo:[],
    loadVersion:0,
    baseRevision:0,
    mosaicCache:new Map(),
    renderPending:false,
    singleBusy:false
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
  let singleAspect = 1;

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
    if("createImageBitmap" in window){
      try{
        return await createImageBitmap(file,{imageOrientation:"from-image"});
      }catch(error){
        try{
          return await createImageBitmap(file);
        }catch(secondError){
          throw new Error("画像を読み込めませんでした。");
        }
      }
    }

    return await new Promise((resolve,reject) => {
      const url = URL.createObjectURL(file);
      const image = new Image();

      image.onload = () => {
        URL.revokeObjectURL(url);
        resolve(image);
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
      for(let index=0; index<list.length && excessBitmaps>0;){
        if(list[index].kind === "full"){
          list.splice(index,1);
          excessBitmaps--;
        }else{
          index++;
        }
      }
    }

    while(list.length > 40){
      list.shift();
    }
  }

  function makeLayerSnapshot(){
    return {
      kind:"layers",
      layers:cloneLayers(state.layers)
    };
  }

  function makeFullSnapshot(){
    return {
      kind:"full",
      base:cloneCanvas(baseCanvas),
      layers:cloneLayers(state.layers)
    };
  }

  function pushHistory(kind="layers"){
    state.undo.push(kind === "full" ? makeFullSnapshot() : makeLayerSnapshot());
    trimHistory(state.undo);
    state.redo = [];
    updateHistoryButtons();
  }

  function currentSnapshotForCounterpart(item){
    return item.kind === "full" ? makeFullSnapshot() : makeLayerSnapshot();
  }

  function restoreSnapshot(item){
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
    state.selectedLayerId = null;
    state.drag = null;

    singleAspect =
        baseCanvas.width/baseCanvas.height;

    setTool("select");
    syncCanvas();
  }

  function undo(){
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

  requestAnimationFrame(() => {
    const width = `${baseCanvas.clientWidth}px`;
    const height = `${baseCanvas.clientHeight}px`;

    layerCanvas.style.width = width;
    layerCanvas.style.height = height;
    editCanvas.style.width = width;
    editCanvas.style.height = height;
  });

  $("resizeW").value = baseCanvas.width || "";
  $("resizeH").value = baseCanvas.height || "";
  $("singleInfo").textContent = baseCanvas.width
    ? `${baseCanvas.width} × ${baseCanvas.height}px`
    : "-";

  singleAspect = baseCanvas.width && baseCanvas.height
    ? baseCanvas.width/baseCanvas.height
    : 1;

  syncCropInputs();
  updateCropActionBar();
  renderLayers();
  renderEditor();
  renderLayerList();
  updateSelectedControls();
  updateHistoryButtons();
}


function renderLayers(){
  layerContext.clearRect(
    0,
    0,
    layerCanvas.width,
    layerCanvas.height
  );

  state.layers.forEach(layer => {
    if(layer.visible !== false){
      drawLayer(layerContext,layer);
    }
  });
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

  function selectedLayer(){
    return state.layers.find(layer => layer.id === state.selectedLayerId) || null;
  }

  function textBounds(layer){
    editContext.save();
    editContext.font = `bold ${layer.fontSize}px sans-serif`;
    const metrics = editContext.measureText(layer.text || "");
    editContext.restore();

    const ascent = Number.isFinite(metrics.actualBoundingBoxAscent)
      ? metrics.actualBoundingBoxAscent
      : layer.fontSize;
    const descent = Number.isFinite(metrics.actualBoundingBoxDescent)
      ? metrics.actualBoundingBoxDescent
      : layer.fontSize*.25;

    return {
      x:layer.x,
      y:layer.y-ascent,
      w:Math.max(1,metrics.width),
      h:Math.max(1,ascent+descent)
    };
  }

  function layerBounds(layer){
    if(RECT_TYPES.includes(layer.type)){
      return {x:layer.x,y:layer.y,w:layer.w,h:layer.h};
    }

    if(layer.type === "text"){
      return textBounds(layer);
    }

    if(layer.type === "arrow"){
      const rectangle = normalizeRectangle(
        {x:layer.x1,y:layer.y1},
        {x:layer.x2,y:layer.y2}
      );
      const pad = Math.max(10,layer.lineWidth*2);

      return {
        x:rectangle.x-pad,
        y:rectangle.y-pad,
        w:Math.max(1,rectangle.w+pad*2),
        h:Math.max(1,rectangle.h+pad*2)
      };
    }

    if(BRUSH_TYPES.includes(layer.type)){
      if(!layer.points || !layer.points.length){
        return {x:0,y:0,w:0,h:0};
      }

      const xs = layer.points.map(point => point.x);
      const ys = layer.points.map(point => point.y);
      const pad = layer.brushSize/2;

      return {
        x:Math.min(...xs)-pad,
        y:Math.min(...ys)-pad,
        w:Math.max(1,Math.max(...xs)-Math.min(...xs)+pad*2),
        h:Math.max(1,Math.max(...ys)-Math.min(...ys)+pad*2)
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

    if(layer.type === "arrow"){
      const tolerance = Math.max(10*displayScale(),layer.lineWidth*2);
      return pointToSegmentDistance(
        point,
        {x:layer.x1,y:layer.y1},
        {x:layer.x2,y:layer.y2}
      ) <= tolerance;
    }

    if(BRUSH_TYPES.includes(layer.type)){
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

  function clampLayerTranslation(layer,dx,dy){
    const bounds = layerBounds(layer);

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
    if(RECT_TYPES.includes(layer.type) || layer.type === "text"){
      layer.x += dx;
      layer.y += dy;
    }else if(layer.type === "arrow"){
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

  function moveLayer(layer,dx,dy,constrain=true){
    const translation = constrain
      ? clampLayerTranslation(layer,dx,dy)
      : {dx,dy};

    moveLayerRaw(layer,translation.dx,translation.dy);
  }

  function scaleLayerFromBounds(layer,startLayer,startBounds,newWidth,newHeight){
    const sx = newWidth/Math.max(1,startBounds.w);
    const sy = newHeight/Math.max(1,startBounds.h);

    if(RECT_TYPES.includes(layer.type)){
      layer.x = startBounds.x;
      layer.y = startBounds.y;
      layer.w = Math.max(2,startLayer.w*sx);
      layer.h = Math.max(2,startLayer.h*sy);
    }else if(layer.type === "text"){
      layer.x = startBounds.x;
      layer.fontSize = clamp(
        startLayer.fontSize*Math.max(sx,sy),
        8,
        300
      );
      layer.y = startBounds.y+layer.fontSize;
    }else if(layer.type === "arrow"){
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
      layer.brushSize = clamp(
        startLayer.brushSize*Math.max(sx,sy),
        5,
        500
      );
      layer.maskDirty = true;
    }
  }

  function drawArrow(context,layer){
    const angle = Math.atan2(layer.y2-layer.y1,layer.x2-layer.x1);
    const head = Math.max(12,layer.lineWidth*4);

    context.beginPath();
    context.moveTo(layer.x1,layer.y1);
    context.lineTo(layer.x2,layer.y2);
    context.stroke();

    context.beginPath();
    context.moveTo(layer.x2,layer.y2);
    context.lineTo(
      layer.x2-head*Math.cos(angle-Math.PI/6),
      layer.y2-head*Math.sin(angle-Math.PI/6)
    );
    context.lineTo(
      layer.x2-head*Math.cos(angle+Math.PI/6),
      layer.y2-head*Math.sin(angle+Math.PI/6)
    );
    context.closePath();
    context.fill();
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

  function getMosaicCanvas(blockSize){
    const size = clamp(Math.round(blockSize),4,200);
    const key = `${state.baseRevision}:${size}`;

    if(!state.mosaicCache.has(key)){
      state.mosaicCache.set(key,buildMosaicCanvas(baseCanvas,size));
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


  function updateCropActionBar(){
    const bar = $("cropActionBar");
    const summary = $("cropActionSummary");
    const applyButton = $("cropBarApply");

    if(!bar || !summary || !applyButton) return;

    const active =
        state.tool === "crop" &&
        !!state.crop;

    bar.classList.toggle("hidden",!active);

    if(!active){
        summary.textContent = "範囲を指定してください";
        applyButton.disabled = true;
        return;
    }

    const width = Math.round(state.crop.w);
    const height = Math.round(state.crop.h);
    const valid = width >= 1 && height >= 1;

    summary.textContent =
        `X ${Math.round(state.crop.x)} / ` +
        `Y ${Math.round(state.crop.y)} / ` +
        `${width} × ${height} px`;

    applyButton.disabled = !valid;
  }

  function drawLayer(context,layer){
    context.save();

    if(layer.type === "blackoutRect"){
      context.fillStyle = "#000";
      context.fillRect(layer.x,layer.y,layer.w,layer.h);
    }else if(layer.type === "mosaicRect"){
      const mosaic = getMosaicCanvas(layer.mosaicSize);
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
      drawMosaicBrush(context,layer,getMosaicCanvas(layer.mosaicSize));
    }else if(layer.type === "text"){
      context.fillStyle = layer.color;
      context.font = `bold ${layer.fontSize}px sans-serif`;
      context.textBaseline = "alphabetic";
      context.fillText(layer.text,layer.x,layer.y);
    }else if(layer.type === "rect"){
      context.strokeStyle = layer.color;
      context.lineWidth = layer.lineWidth;
      context.strokeRect(layer.x,layer.y,layer.w,layer.h);
    }else if(layer.type === "ellipse"){
      context.strokeStyle = layer.color;
      context.lineWidth = layer.lineWidth;
      context.beginPath();
      context.ellipse(
        layer.x+layer.w/2,
        layer.y+layer.h/2,
        Math.abs(layer.w/2),
        Math.abs(layer.h/2),
        0,0,Math.PI*2
      );
      context.stroke();
    }else if(layer.type === "arrow"){
      context.strokeStyle = layer.color;
      context.fillStyle = layer.color;
      context.lineWidth = layer.lineWidth;
      context.lineCap = "round";
      drawArrow(context,layer);
    }

    context.restore();
  }

  function compositeCanvas(){
    const output = cloneCanvas(baseCanvas);
    const context = output.getContext("2d");

    state.layers.forEach(layer => {
      if(layer.visible !== false){
        drawLayer(context,layer);
      }
    });

    return output;
  }

  function drawCropOverlay(){
    if(!state.crop) return;

    const crop = state.crop;
    const scale = displayScale();
    const handleSize = 7*scale;

    editContext.save();
    editContext.fillStyle = "rgba(0,0,0,.48)";
    editContext.fillRect(0,0,editCanvas.width,editCanvas.height);
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
    const layer = selectedLayer();

    if(!layer || layer.visible === false){
        return;
    }

    const bounds = layerBounds(layer);
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

    editContext.strokeRect(
        bounds.x,
        bounds.y,
        bounds.w,
        bounds.h
    );

    editContext.setLineDash([]);
    editContext.fillStyle = "#fff";
    editContext.strokeStyle = "#9a721b";

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


  function drawShapePreview(drag){
    const style = currentStyle();
    const point = drag.last;
    const rectangle =
        normalizeRectangle(drag.start,point);

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
    }else if(drag.tool === "rect"){
        editContext.strokeRect(
        rectangle.x,
        rectangle.y,
        rectangle.w,
        rectangle.h
        );
    }else if(drag.tool === "ellipse"){
        editContext.beginPath();

        editContext.ellipse(
        rectangle.x+rectangle.w/2,
        rectangle.y+rectangle.h/2,
        rectangle.w/2,
        rectangle.h/2,
        0,
        0,
        Math.PI*2
        );

        editContext.stroke();
    }else if(drag.tool === "arrow"){
        drawArrow(editContext,{
        x1:drag.start.x,
        y1:drag.start.y,
        x2:point.x,
        y2:point.y,
        lineWidth:style.lineWidth
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

    if(state.tool === "crop" && state.crop){
        drawCropOverlay();
    }

    if(state.drag?.mode === "shape"){
        drawShapePreview(state.drag);
    }

    if(state.tool === "select"){
        drawSelection();
    }

    updateCropActionBar();
  }



  function typeLabel(type){
    return {
      blackoutRect:"黒塗り範囲",
      mosaicRect:"モザイク範囲",
      blackoutBrush:"黒塗りブラシ",
      mosaicBrush:"モザイクブラシ",
      text:"文字注釈",
      rect:"四角形",
      ellipse:"楕円",
      arrow:"矢印"
    }[type] || type;
  }

  function updateSelectedControls(){
    const layer = selectedLayer();
    $("deleteLayer").disabled = !layer;
    $("applyLayerStyle").disabled = !layer;

    if(!layer) return;

    if(layer.type === "text"){
      $("annotationText").value = layer.text;
      $("annotationColor").value = layer.color;
      $("fontSize").value = Math.round(layer.fontSize);
    }else if(["rect","ellipse","arrow"].includes(layer.type)){
      $("annotationColor").value = layer.color;
      $("lineWidth").value = Math.round(layer.lineWidth);
    }

    if(BRUSH_TYPES.includes(layer.type)){
      $("brushSize").value = Math.round(layer.brushSize);
    }

    if(["mosaicRect","mosaicBrush"].includes(layer.type)){
      $("mosaicSize").value = Math.round(layer.mosaicSize);
    }
  }

  function renderLayerList(){
    const list = $("layerList");
    list.innerHTML = "";

    const visibleLayers = state.layers.filter(
        layer => layer.visible !== false
    );
    const hiddenCount =
        state.layers.length-visibleLayers.length;
    const counts = {};

    state.layers.forEach(layer => {
        counts[layer.type] =
        (counts[layer.type] || 0)+1;
    });

    if(!state.layers.length){
        $("layerSummary").textContent =
        "加工箇所はありません。";
        updateSelectedControls();
        return;
    }

    const summary = Object.entries(counts)
        .map(([type,count]) =>
        `${typeLabel(type)}: ${count}件`
        )
        .join(" / ");

    $("layerSummary").textContent =
        `${summary} / 表示中: ${visibleLayers.length}件` +
        (hiddenCount
        ? ` / 非表示: ${hiddenCount}件`
        : "");

    state.layers.forEach((layer,index) => {
        const row = document.createElement("div");
        row.className =
        "layer-item" +
        (layer.id === state.selectedLayerId
            ? " selected"
            : "");

        const name = document.createElement("button");
        name.type = "button";
        name.className = "layer-name";
        name.textContent =
        `${index+1}. ${typeLabel(layer.type)}` +
        (layer.text ? `「${layer.text}」` : "") +
        (layer.visible === false
            ? "（非表示）"
            : "");

        name.addEventListener("click",() => {
        state.selectedLayerId = layer.id;
        setTool("select");
        renderLayerList();
        });

        const actions = document.createElement("div");
        actions.className = "layer-actions";

        const up = document.createElement("button");
        up.type = "button";
        up.textContent = "上へ";
        up.disabled = index === state.layers.length-1;

        up.addEventListener("click",() => {
        if(index >= state.layers.length-1) return;

        pushHistory("layers");

        [
            state.layers[index],
            state.layers[index+1]
        ] = [
            state.layers[index+1],
            state.layers[index]
        ];

        renderLayers();
        renderEditor();
        renderLayerList();
        });

        const down = document.createElement("button");
        down.type = "button";
        down.textContent = "下へ";
        down.disabled = index === 0;

        down.addEventListener("click",() => {
        if(index <= 0) return;

        pushHistory("layers");

        [
            state.layers[index],
            state.layers[index-1]
        ] = [
            state.layers[index-1],
            state.layers[index]
        ];

        renderLayers();
        renderEditor();
        renderLayerList();
        });

        const visible = document.createElement("button");
        visible.type = "button";
        visible.textContent =
        layer.visible === false
            ? "表示"
            : "非表示";

        visible.addEventListener("click",() => {
        pushHistory("layers");
        layer.visible = layer.visible === false;

        if(
            layer.visible === false &&
            state.selectedLayerId === layer.id
        ){
            state.selectedLayerId = null;
        }

        renderLayers();
        renderEditor();
        renderLayerList();
        });

        const remove = document.createElement("button");
        remove.type = "button";
        remove.textContent = "削除";

        remove.addEventListener("click",() => {
        pushHistory("layers");

        state.layers = state.layers.filter(
            item => item.id !== layer.id
        );

        if(state.selectedLayerId === layer.id){
            state.selectedLayerId = null;
        }

        renderLayers();
        renderEditor();
        renderLayerList();
        });

        actions.append(up,down,visible,remove);
        row.append(name,actions);
        list.appendChild(row);
    });

    updateSelectedControls();
  }


  function setTool(tool){
    const leavingCrop =
        state.tool === "crop" &&
        tool !== "crop";

    state.tool = tool;
    state.drag = null;

    if(leavingCrop){
        state.crop = null;
        syncCropInputs();
    }

    $$(".tool").forEach(button => {
        button.classList.toggle(
        "active",
        button.dataset.tool === tool
        );
    });

    editCanvas.classList.toggle(
        "select-mode",
        tool === "select"
    );

    if(tool === "crop" && !state.crop){
        resetCropFrame();
    }

    $("stageHelp").textContent = {
        select:
        "加工箇所をクリックして選択します。ドラッグで移動し、右下の白いハンドルでサイズを変更できます。",
        crop:
        "枠の内側をドラッグすると移動できます。四隅をドラッグするとサイズを変更できます。範囲が決まったら画像直下の「この範囲で切り抜く」を押してください。",
        blackoutRect:
        "隠したい範囲をドラッグしてください。保存前なら選択ツールで再編集できます。",
        mosaicRect:
        "モザイクにする範囲をドラッグしてください。保存前なら選択ツールで再編集できます。",
        blackoutBrush:
        "画像上を自由になぞってください。ストローク単位で移動・拡大縮小できます。",
        mosaicBrush:
        "画像上を自由になぞってください。ストローク単位で移動・拡大縮小できます。",
        text:
        "文字を配置する位置をクリックしてください。",
        rect:
        "四角形をドラッグしてください。",
        ellipse:
        "楕円をドラッグしてください。",
        arrow:
        "始点から終点へドラッグしてください。"
    }[tool] || "ツールを選択してください。";

    renderLayers();
    renderEditor();
  }


  function readNumber(id,min,max,fallback){
    const value = Number($(id).value);
    return Number.isFinite(value)
      ? clamp(value,min,max)
      : fallback;
  }

  function currentStyle(){
    return {
      color:$("annotationColor").value,
      fontSize:readNumber("fontSize",8,300,42),
      lineWidth:readNumber("lineWidth",1,100,8),
      brushSize:readNumber("brushSize",5,500,50),
      mosaicSize:readNumber("mosaicSize",4,200,18)
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

  editCanvas.addEventListener("pointerdown",event => {
    if(
        state.singleBusy ||
        !state.tool ||
        !baseCanvas.width
    ){
        return;
    }

    const point = pointFromEvent(event);
    editCanvas.setPointerCapture(event.pointerId);

    if(state.tool === "select"){
      const layer = hitLayer(point);
      state.selectedLayerId = layer?.id || null;

      if(layer){
        const bounds = layerBounds(layer);
        const handleSize = 16*displayScale();
        const isResize =
          Math.abs(point.x-(bounds.x+bounds.w)) <= handleSize &&
          Math.abs(point.y-(bounds.y+bounds.h)) <= handleSize;

        state.drag = {
          mode:isResize ? "resizeLayer" : "moveLayer",
          start:point,
          last:point,
          layer,
          startLayer:cloneLayerForGesture(layer),
          bounds:{...bounds},
          historyPushed:false,
          changed:false,
          redoBefore:state.redo.slice()
        };
      }

      renderEditor();
      renderLayerList();
      return;
    }

    if(state.tool === "text"){
      const text = $("annotationText").value || "注釈";
      const style = currentStyle();

      pushHistory("layers");
      const layer = {
        id:makeId(),
        type:"text",
        text,
        x:point.x,
        y:point.y,
        color:style.color,
        fontSize:style.fontSize,
        visible:true
      };

      state.layers.push(layer);
      state.selectedLayerId = layer.id;
      setTool("select");
      renderLayerList();
      return;
    }

    if(state.tool === "crop"){
      const hit = cropHit(point);

      state.drag = {
        mode:"crop",
        action:hit,
        start:point,
        last:point,
        base:state.crop ? {...state.crop} : null
      };

      if(hit === "new"){
        state.crop = {x:point.x,y:point.y,w:1,h:1};
      }

      renderEditor();
      return;
    }

    if(BRUSH_TYPES.includes(state.tool)){
      const style = currentStyle();

      pushHistory("layers");
      const layer = {
        id:makeId(),
        type:state.tool,
        points:[point],
        brushSize:style.brushSize,
        mosaicSize:style.mosaicSize,
        visible:true,
        maskCanvas:null,
        maskDirty:true
      };

      state.layers.push(layer);
      state.selectedLayerId = layer.id;
      state.drag = {
        mode:"brush",
        layer,
        last:point
      };

      renderLayerList();
      scheduleRender();
      return;
    }

    state.drag = {
      mode:"shape",
      start:point,
      last:point,
      tool:state.tool
    };

    renderEditor();
  });

  editCanvas.addEventListener("pointermove",event => {
    if(!state.drag) return;

    const point = pointFromEvent(event);
    const drag = state.drag;

    if(drag.mode === "moveLayer"){
      const distance = Math.hypot(
        point.x-drag.start.x,
        point.y-drag.start.y
      );

      if(distance >= 1){
        if(!drag.historyPushed){
          pushHistory("layers");
          drag.historyPushed = true;
        }

        const dx = point.x-drag.last.x;
        const dy = point.y-drag.last.y;
        moveLayer(drag.layer,dx,dy,true);
        drag.last = point;
        drag.changed = true;
      }

      scheduleRender();
      return;
    }

    if(drag.mode === "resizeLayer"){
      const distance = Math.hypot(
        point.x-drag.start.x,
        point.y-drag.start.y
      );

      if(distance >= 1){
        if(!drag.historyPushed){
          pushHistory("layers");
          drag.historyPushed = true;
        }

        const maxWidth = Math.max(2,baseCanvas.width-drag.bounds.x);
        const maxHeight = Math.max(2,baseCanvas.height-drag.bounds.y);
        const width = clamp(point.x-drag.bounds.x,2,maxWidth);
        const height = clamp(point.y-drag.bounds.y,2,maxHeight);

        scaleLayerFromBounds(
          drag.layer,
          drag.startLayer,
          drag.bounds,
          width,
          height
        );

        drag.changed = true;
      }

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
      drag.last = point;

      if(drag.action === "move" && drag.base){
        state.crop = moveCrop(drag.base,point,drag.start);
      }else if(["nw","ne","se","sw"].includes(drag.action) && drag.base){
        state.crop = resizeCropFromCorner(drag.base,drag.action,point);
      }else{
        const fitted = fitDragPointToRatio(
          drag.start,
          point,
          cropRatioValue()
        );
        state.crop = normalizeRectangle(drag.start,fitted);
      }

      syncCropInputs();
      scheduleRender();
      return;
    }

    if(drag.mode === "shape"){
      drag.last = point;
      scheduleRender();
    }
  });

    editCanvas.addEventListener("pointerup",event => {
    if(!state.drag) return;

    const point = pointFromEvent(event);
    const drag = state.drag;

    if(drag.mode === "shape"){
        drag.last = point;
        const style = currentStyle();
        const rectangle =
        normalizeRectangle(drag.start,point);

        if(drag.tool === "arrow"){
        if(
            Math.hypot(
            point.x-drag.start.x,
            point.y-drag.start.y
            ) >= 2
        ){
            pushHistory("layers");

            const layer = {
            id:makeId(),
            type:"arrow",
            x1:drag.start.x,
            y1:drag.start.y,
            x2:point.x,
            y2:point.y,
            color:style.color,
            lineWidth:style.lineWidth,
            visible:true
            };

            state.layers.push(layer);
            state.selectedLayerId = layer.id;
        }
        }else if(
        rectangle.w >= 2 &&
        rectangle.h >= 2
        ){
        pushHistory("layers");

        const layer = {
            id:makeId(),
            type:drag.tool,
            ...rectangle,
            color:style.color,
            lineWidth:style.lineWidth,
            mosaicSize:style.mosaicSize,
            visible:true
        };

        state.layers.push(layer);
        state.selectedLayerId = layer.id;
        }
    }

    state.drag = null;

    renderLayers();
    renderEditor();
    renderLayerList();
    });


  editCanvas.addEventListener("pointercancel",() => {
    const drag = state.drag;

    if(
        drag &&
        ["moveLayer","resizeLayer"].includes(drag.mode) &&
        drag.changed
    ){
        const restored = cloneLayerForGesture(
        drag.startLayer
        );

        Object.keys(drag.layer).forEach(key => {
        delete drag.layer[key];
        });

        Object.assign(drag.layer,restored);

        if(drag.historyPushed && state.undo.length){
        state.undo.pop();
        }

        state.redo = drag.redoBefore
        ? drag.redoBefore.slice()
        : [];

        updateHistoryButtons();
    }

    state.drag = null;
    renderLayers();
    renderEditor();
    renderLayerList();
  });



  function syncCropInputs(){
    if(!state.crop){
        ["cropX","cropY","cropW","cropH"].forEach(id => {
        $(id).value = "";
        });

        updateCropActionBar();
        return;
    }

    $("cropX").value = Math.round(state.crop.x);
    $("cropY").value = Math.round(state.crop.y);
    $("cropW").value = Math.round(state.crop.w);
    $("cropH").value = Math.round(state.crop.h);

    updateCropActionBar();
  }


  function updateCropFromInputs(){
    if(!baseCanvas.width) return;

    const xValue = Number($("cropX").value);
    const yValue = Number($("cropY").value);
    const wValue = Number($("cropW").value);
    const hValue = Number($("cropH").value);

    if(
      !Number.isFinite(xValue) ||
      !Number.isFinite(yValue) ||
      !Number.isFinite(wValue) ||
      !Number.isFinite(hValue)
    ){
      return;
    }

    const x = clamp(Math.round(xValue),0,baseCanvas.width-1);
    const y = clamp(Math.round(yValue),0,baseCanvas.height-1);
    let width = clamp(Math.round(wValue),1,baseCanvas.width-x);
    let height = clamp(Math.round(hValue),1,baseCanvas.height-y);
    const ratio = cropRatioValue();

    if(ratio){
      height = Math.round(width/ratio);

      if(height > baseCanvas.height-y){
        height = baseCanvas.height-y;
        width = Math.round(height*ratio);
      }
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

  ["cropX","cropY","cropW","cropH"].forEach(id => {
    $(id).addEventListener("change",updateCropFromInputs);
  });

  $("cropRatio").addEventListener("change",() => {
    if(!state.crop) return;

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

  function resetCropFrame(){
    if(!baseCanvas.width) return;

    const ratio = cropRatioValue();
    let width = baseCanvas.width*.8;
    let height = baseCanvas.height*.8;

    if(ratio){
        if(width/height > ratio){
        width = height*ratio;
        }else{
        height = width/ratio;
        }
    }

    state.crop = {
        x:(baseCanvas.width-width)/2,
        y:(baseCanvas.height-height)/2,
        w:width,
        h:height
    };

    syncCropInputs();
    renderEditor();
    updateCropActionBar();
  }


  $("resetCrop").addEventListener("click",resetCropFrame);

  $("centerCrop").addEventListener("click",() => {
    if(!state.crop) return;

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
      if(RECT_TYPES.includes(layer.type)){
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

    if(!state.layers.some(layer => layer.id === state.selectedLayerId)){
      state.selectedLayerId = null;
    }
  }

  function applyCurrentCrop(){
    if(
        !state.crop ||
        state.crop.w < 1 ||
        state.crop.h < 1
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


    $("cropBarApply").addEventListener(
    "click",
    applyCurrentCrop
    );

    $("cropBarReset").addEventListener(
    "click",
    resetCropFrame
    );

    $("cancelCrop").addEventListener("click",() => {
      setTool("select");
    });



  function transformAllLayers(scaleX,scaleY){
    const average = (Math.abs(scaleX)+Math.abs(scaleY))/2;

    state.layers.forEach(layer => {
      if(RECT_TYPES.includes(layer.type)){
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
      }else if(layer.type === "arrow"){
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
    if(!baseCanvas.width) return;

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
      if(RECT_TYPES.includes(layer.type)){
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
      }else if(layer.type === "text"){
        Object.assign(
          layer,
          rotatePoint({x:layer.x,y:layer.y},degrees,oldWidth,oldHeight)
        );
      }else if(layer.type === "arrow"){
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
    if(!baseCanvas.width) return;

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

      if(RECT_TYPES.includes(layer.type)){
        if(horizontal){
          layer.x = baseCanvas.width-layer.x-layer.w;
        }else{
          layer.y = baseCanvas.height-layer.y-layer.h;
        }
      }else if(layer.type === "text"){
        Object.assign(layer,flipPoint({x:layer.x,y:layer.y}));
      }else if(layer.type === "arrow"){
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

    $("deleteLayer").addEventListener("click",() => {
    if(!state.selectedLayerId){
        toast("加工箇所を選択してください。");
        return;
    }

    pushHistory("layers");

    state.layers = state.layers.filter(
        layer => layer.id !== state.selectedLayerId
    );
    state.selectedLayerId = null;

    renderLayers();
    renderEditor();
    renderLayerList();
    });


    $("applyLayerStyle").addEventListener("click",() => {
    const layer = selectedLayer();

    if(!layer){
        toast("加工箇所を選択してください。");
        return;
    }

    const style = currentStyle();
    pushHistory("layers");

    if(layer.type === "text"){
        layer.text =
        $("annotationText").value || "注釈";
        layer.color = style.color;
        layer.fontSize = style.fontSize;
    }else if(
        ["rect","ellipse","arrow"].includes(layer.type)
    ){
        layer.color = style.color;
        layer.lineWidth = style.lineWidth;
    }

    if(BRUSH_TYPES.includes(layer.type)){
        layer.brushSize = style.brushSize;
    }

    if(
        ["mosaicRect","mosaicBrush"].includes(layer.type)
    ){
        layer.mosaicSize = style.mosaicSize;
    }

    renderLayers();
    renderEditor();
    renderLayerList();

    toast(
        "選択中の加工へ設定を反映しました。"
    );
    });


  $("resetSingle").addEventListener("click",() => {
    if(!state.originalCanvas) return;

    pushHistory("full");

    baseCanvas.width = state.originalCanvas.width;
    baseCanvas.height = state.originalCanvas.height;
    baseContext.clearRect(0,0,baseCanvas.width,baseCanvas.height);
    baseContext.drawImage(state.originalCanvas,0,0);

    state.layers = [];
    state.crop = null;
    state.selectedLayerId = null;
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
        state.originalCanvas =
        cloneCanvas(baseCanvas);
        state.layers = [];
        state.crop = null;
        state.selectedLayerId = null;
        state.undo = [];
        state.redo = [];

        invalidateBaseCaches();

        $("singleFileName").textContent =
        file.name;
        $("singleSaveName").value =
        `${sanitizeBaseName(file.name)}-edited`;
        $("singleFormat").value =
        SUPPORTED_TYPES.includes(file.type)
            ? file.type
            : "image/jpeg";

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
        }

        if(
        image &&
        typeof image.close === "function"
        ){
        image.close();
        }
    }
  }


  const singleInput = $("singleInput");

  $("singleChoose").addEventListener("click",event => {
    event.stopPropagation();
    singleInput.value = "";
    singleInput.click();
  });

  $("changeSingle").addEventListener("click",() => {
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

  $$(".tool").forEach(button => {
    button.addEventListener("click",() => {
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
    if(!state.originalCanvas) return;

    drawPreview(state.originalCanvas,$("beforePreview"));
    drawPreview(compositeCanvas(),$("afterPreview"));

    previewReturnFocus = document.activeElement;
    $("previewDialog").classList.remove("hidden");
    document.body.classList.add("dialog-open");
    $("closePreview").focus();
  }

  function closePreview(){
    if($("previewDialog").classList.contains("hidden")) return;

    $("previewDialog").classList.add("hidden");
    document.body.classList.remove("dialog-open");

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
      toast("プリセットを選択してください。");
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

    updateSingleFormatUI();

    try{
      if(preset.longEdge){
        const ratio = Math.min(
          1,
          preset.longEdge/Math.max(baseCanvas.width,baseCanvas.height)
        );

        const width = Math.max(1,Math.round(baseCanvas.width*ratio));
        const height = Math.max(1,Math.round(baseCanvas.height*ratio));

        if(width !== baseCanvas.width || height !== baseCanvas.height){
          resizeSingle(width,height);
        }
      }else if(preset.width && preset.height){
        const ratio = Math.min(
          preset.width/baseCanvas.width,
          preset.height/baseCanvas.height,
          1
        );

        const width = Math.max(1,Math.round(baseCanvas.width*ratio));
        const height = Math.max(1,Math.round(baseCanvas.height*ratio));

        if(width !== baseCanvas.width || height !== baseCanvas.height){
          resizeSingle(width,height);
        }
      }

      toast("プリセットを適用しました。");
    }catch(error){
      toast(error.message);
    }
  }

  $("applyPreset").addEventListener("click",applySinglePreset);

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
    $("singleJpegBackgroundField").classList.toggle("hidden",!jpeg);
  }

  $("singleFormat").addEventListener("change",updateSingleFormatUI);

  $("singleTargetEnabled").addEventListener("change",() => {
    $("singleTargetKB").disabled = !$("singleTargetEnabled").checked;
  });

  $("singleSave").addEventListener("click",async () => {
    if(state.singleBusy) return;
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

        $("singleSave").disabled = true;
        setSingleStatus(
        "加工結果を書き出しています。"
        );

        const output = compositeCanvas();

        const result = await encodeToTarget(
        output,
        type,
        targetEnabled,
        targetKB,
        $("singleJpegBackground").value
        );

        const fileName =
        `${sanitizeBaseName(
            $("singleSaveName").value
        )}.${extensionForType(type)}`;

        saveBlob(result.blob,fileName);

        if(targetEnabled && !result.targetMet){
        setSingleStatus(
            `${fileName}を保存しましたが、` +
            `目標${targetKB}KB以下にはできませんでした。` +
            ` 実際の容量: ${bytes(result.blob.size)} / ` +
            `${result.width} × ${result.height}px`,
            "warn"
        );
        }else{
        setSingleStatus(
            `${fileName}を保存しました。` +
            `${result.width} × ${result.height}px、` +
            `${bytes(result.blob.size)}`,
            "ok"
        );
        }
    }catch(error){
        setSingleStatus(
        error.message || "保存に失敗しました。",
        "warn"
        );
    }finally{
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
    if(batchState.processing || batchState.adding) return;

    $$(".appbox-tab").forEach(tab => {
      const active = tab === button;
      tab.classList.toggle("is-active",active);
      tab.setAttribute("aria-selected",String(active));
      tab.tabIndex = active ? 0 : -1;

      const panel = $(tab.dataset.panel);
      panel.hidden = !active;
    });

    button.focus();
  }

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

    updateSingleFormatUI();
    updateBatchResizeUI();
    updateBatchFormatUI();

    $("singleTargetKB").disabled =
    !$("singleTargetEnabled").checked;

    $("batchTargetKB").disabled =
    !$("batchTargetEnabled").checked;

    updateHistoryButtons();
    updateCropActionBar();
    renderLayers();
    renderBatch();
})();
