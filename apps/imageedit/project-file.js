// AppBox image project: bounded JSON manifest followed by PNG blobs.
// Kept app-local: this is not a ZIP reader or a general serialization format.
(function(root,factory){
  const api = factory();
  if(typeof module === "object" && module.exports) module.exports = api;
  else root.AppBoxImageProject = api;
})(typeof globalThis === "object" ? globalThis : this,function(){
  "use strict";
  const FORMAT = "appbox-imageedit-project", VERSION = 1, EXTENSION = ".abimg";
  const MAGIC = [65,66,73,77,71,13,10,26];
  const MAX_FILE_BYTES = 200*1024*1024, MAX_JSON_BYTES = 4*1024*1024;
  const MAX_ASSET_BYTES = 64*1024*1024, MAX_TOTAL_PIXELS = 72000000;
  const MAX_LAYERS = 500, MAX_POINTS = 200000, MAX_TEXT = 200000;
  const TYPES = ["image","text","rect","ellipse","line","arrow","ink","blackoutRect","mosaicRect","blackoutBrush","mosaicBrush"];
  const NUMBERS = ["x","y","w","h","x1","y1","x2","y2","fontSize","textWidth","lineWidth","brushSize","mosaicSize","opacity","rotation"];
  const BOOLEANS = ["visible","bold","bgTransparent","outline","fillNone","textFlipX"];
  const STRINGS = ["color","bgColor","fill","fontFamily","inkStabilizer","name","text"];
  const KEYS = new Set(["id","type","points","asset",...NUMBERS,...BOOLEANS,...STRINGS]);
  const invalid = () => new Error("作業ファイルの形式・編集情報が不正か、上限を超えています。");
  const integer = (n,min,max) => Number.isSafeInteger(n) && n >= min && n <= max;
  function size(width,height){
    if(!integer(width,1,8192) || !integer(height,1,8192) || width*height > 36000000) throw invalid();
  }
  function normalizeLayers(layers,assetCount){
    if(!Array.isArray(layers) || layers.length > MAX_LAYERS) throw invalid();
    let points = 0, text = 0;
    const ids = new Set();
    return layers.map(raw => {
      if(!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some(key => !KEYS.has(key))) throw invalid();
      if(typeof raw.id !== "string" || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(raw.id) || ids.has(raw.id) || !TYPES.includes(raw.type)) throw invalid();
      ids.add(raw.id);
      const layer = {id:raw.id,type:raw.type};
      for(const key of NUMBERS){
        if(raw[key] === undefined) continue;
        const value = raw[key];
        if(typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 1000000) throw invalid();
        if(["w","h","fontSize","textWidth","lineWidth","brushSize","mosaicSize"].includes(key) && value <= 0) throw invalid();
        if(key === "opacity" && (value < 0 || value > 100)) throw invalid();
        if(key === "fontSize" && (value < 8 || value > 300)) throw invalid();
        if(["lineWidth","brushSize"].includes(key) && value > 32768) throw invalid();
        if(key === "rotation" && ![0,90,180,270].includes(value)) throw invalid();
        layer[key] = value;
      }
      for(const key of BOOLEANS){
        if(raw[key] === undefined) continue;
        if(typeof raw[key] !== "boolean") throw invalid();
        layer[key] = raw[key];
      }
      for(const key of STRINGS){
        if(raw[key] === undefined) continue;
        if(typeof raw[key] !== "string" || raw[key].length > (key === "text" ? 50000 : 300)) throw invalid();
        if(["color","bgColor","fill"].includes(key) && !/^#[0-9a-f]{6}$/i.test(raw[key])) throw invalid();
        if(key === "fontFamily" && !["biz-udgothic","biz-udpgothic","yu-gothic","yu-gothic-ui","meiryo","ms-gothic","ms-pgothic","ms-mincho","ms-pmincho","segoe-ui","arial","times-new-roman"].includes(raw[key])) throw invalid();
        if(key === "inkStabilizer" && !["none","weak","medium","strong"].includes(raw[key])) throw invalid();
        layer[key] = raw[key];
      }
      text += layer.text?.length || 0;
      if(text > MAX_TEXT) throw invalid();
      const required = ["image","rect","ellipse","blackoutRect","mosaicRect"].includes(layer.type) ? ["x","y","w","h"]
        : ["line","arrow"].includes(layer.type) ? ["x1","y1","x2","y2","lineWidth"]
        : layer.type === "text" ? ["x","y","fontSize","text"] : ["brushSize","points"];
      if(layer.type === "image"){
        if(!integer(raw.asset,2,assetCount-1)) throw invalid();
        layer.asset = raw.asset;
      }else if(raw.asset !== undefined) throw invalid();
      if(["ink","blackoutBrush","mosaicBrush"].includes(layer.type)){
        if(!Array.isArray(raw.points) || !raw.points.length || raw.points.length > MAX_POINTS) throw invalid();
        points += raw.points.length;
        if(points > MAX_POINTS) throw invalid();
        layer.points = raw.points.map(point => {
          if(!point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || Math.abs(point.x)>1000000 || Math.abs(point.y)>1000000) throw invalid();
          return {x:point.x,y:point.y};
        });
      }else if(raw.points !== undefined) throw invalid();
      if(layer.type.startsWith("mosaic") && !(Number.isFinite(layer.mosaicSize) && layer.mosaicSize >= 4 && layer.mosaicSize <= 200)) throw invalid();
      if(required.some(key => layer[key] === undefined)) throw invalid();
      return layer;
    });
  }
  function normalizeManifest(raw){
    if(!raw || raw.format !== FORMAT || raw.version !== VERSION) throw new Error("この版で読める画像の作業ファイル（.abimg）を選択してください。");
    if(Object.keys(raw).some(key => !["format","version","name","sourceType","assets","layers"].includes(key))) throw invalid();
    if(typeof raw.name !== "string" || !raw.name || raw.name.length > 255 || /[\x00-\x1f\x7f]/.test(raw.name) || !["image/png","image/jpeg","image/webp"].includes(raw.sourceType)) throw invalid();
    if(!Array.isArray(raw.assets) || raw.assets.length < 2 || raw.assets.length > MAX_LAYERS+2) throw invalid();
    let pixels = 0;
    const assets = raw.assets.map(asset => {
      if(!asset || Object.keys(asset).some(key => !["width","height","bytes"].includes(key))) throw invalid();
      size(asset.width,asset.height);
      if(!integer(asset.bytes,1,MAX_ASSET_BYTES)) throw invalid();
      pixels += asset.width*asset.height;
      if(pixels > MAX_TOTAL_PIXELS) throw invalid();
      return {width:asset.width,height:asset.height,bytes:asset.bytes};
    });
    const layers = normalizeLayers(raw.layers,assets.length);
    const used = new Set([0,1,...layers.filter(layer => layer.type === "image").map(layer => layer.asset)]);
    if(used.size !== assets.length) throw invalid();
    return {format:FORMAT,version:VERSION,name:raw.name,sourceType:raw.sourceType,assets,layers};
  }
  async function encode({original,base,layers,name,sourceType},toBlob){
    if(!Array.isArray(layers) || layers.length > MAX_LAYERS) throw invalid();
    const canvases = [original,base];
    // Explicitly omit only known runtime-only caches; all other fields are validated.
    const records = layers.map(layer => {
      const record = {...layer};
      delete record.imageCanvas;delete record.maskCanvas;delete record.maskDirty;
      if(layer.type === "image"){
        let index = canvases.indexOf(layer.imageCanvas);
        if(index < 0){index=canvases.length;canvases.push(layer.imageCanvas);}
        record.asset=index;
      }
      for(const key of Object.keys(record)) if(record[key] === undefined) delete record[key];
      return record;
    });
    const raw = {format:FORMAT,version:VERSION,name,sourceType,layers:records,
      assets:canvases.map(canvas => ({width:canvas?.width,height:canvas?.height,bytes:1}))};
    normalizeManifest(raw); // Reject size/counts before PNG allocation.
    const blobs = [];
    let bytes = 12;
    for(let i=0;i<canvases.length;i++){
      const blob = await toBlob(canvases[i]);
      if(!blob || blob.type !== "image/png" || !integer(blob.size,1,MAX_ASSET_BYTES)) throw invalid();
      raw.assets[i].bytes=blob.size;blobs.push(blob);bytes+=blob.size;
      if(bytes > MAX_FILE_BYTES) throw invalid();
    }
    const manifest = normalizeManifest(raw);
    const json = new TextEncoder().encode(JSON.stringify(manifest));
    if(json.length > MAX_JSON_BYTES || bytes+json.length > MAX_FILE_BYTES) throw invalid();
    const header = new Uint8Array(12);header.set(MAGIC);
    new DataView(header.buffer).setUint32(8,json.length,true);
    return new Blob([header,json,...blobs],{type:"application/octet-stream"});
  }
  async function read(file,inspect){
    if(!file || !integer(file.size,13,MAX_FILE_BYTES)) throw invalid();
    const header = new Uint8Array(await file.slice(0,12).arrayBuffer());
    if(header.length !== 12 || !MAGIC.every((value,index) => header[index] === value)) throw invalid();
    const length = new DataView(header.buffer).getUint32(8,true);
    if(!integer(length,1,MAX_JSON_BYTES) || 12+length > file.size) throw invalid();
    let raw;
    try{raw=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(await file.slice(12,12+length).arrayBuffer()));}
    catch(error){throw invalid();}
    const manifest = normalizeManifest(raw), blobs = [];
    let offset = 12+length;
    for(const asset of manifest.assets){
      if(offset+asset.bytes > file.size) throw invalid();
      const blob=file.slice(offset,offset+asset.bytes,"image/png");offset+=asset.bytes;
      blobs.push(blob);
    }
    if(offset !== file.size) throw invalid();
    // Inspect every header and total pixels before decoding any image.
    for(let i=0;i<blobs.length;i++){
      const header = await inspect(blobs[i]);
      if(header.mime !== "image/png" || header.width !== manifest.assets[i].width || header.height !== manifest.assets[i].height) throw invalid();
    }
    return {manifest,blobs};
  }
  return Object.freeze({FORMAT,VERSION,EXTENSION,MAX_FILE_BYTES,MAX_JSON_BYTES,MAX_ASSET_BYTES,MAX_TOTAL_PIXELS,MAX_LAYERS,MAX_POINTS,MAX_TEXT,normalizeLayers,normalizeManifest,encode,read});
});
