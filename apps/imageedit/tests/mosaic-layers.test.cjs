const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname,"..","image.js"),"utf8");
function extractFunction(name){
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0,`${name} exists`);
  const opening = source.indexOf("{",start);
  let depth = 0;
  for(let index=opening;index<source.length;index++){
    if(source[index] === "{") depth++;
    if(source[index] === "}" && --depth === 0) return source.slice(start,index+1);
  }
  throw new Error(`Missing end of ${name}`);
}

// Canvas calls retain a snapshot of the composited source, so resetting a
// temporary canvas cannot conceal which layers a mosaic actually consumed.
function harness(){
  const canvases = [];
  const samples = [];
  function canvas(width=600,height=400,paint=[]){
    let w=width,h=height;
    const result = {paint:paint.slice()};
    const stack = [];
    const context = {
      fillStyle:"",globalAlpha:1,
      save(){stack.push({fillStyle:this.fillStyle,globalAlpha:this.globalAlpha});},
      restore(){Object.assign(this,stack.pop());},
      clearRect(){result.paint=[];},
      drawImage(image){result.paint.push(...image.paint);},
      fillRect(){result.paint.push(`fill:${this.fillStyle}`);},
      strokeRect(){result.paint.push(`stroke:${this.strokeStyle}`);}
    };
    Object.defineProperties(result,{
      width:{get:() => w,set:value => {w=value;result.paint=[];}},
      height:{get:() => h,set:value => {h=value;result.paint=[];}}
    });
    result.getContext=() => context;
    canvases.push(result);
    return result;
  }
  const baseCanvas=canvas(600,400,["base"]),layerCanvas=canvas();
  const sandbox = {
    annotationStyle:require("../annotation-style.js"),
    baseCanvas,layerCanvas,layerContext:layerCanvas.getContext("2d"),editContext:null,
    state:{layers:[],baseRevision:1,mosaicCache:new Map()},
    clamp:(value,min,max) => Math.min(max,Math.max(min,value)),
    createCanvas:canvas,
    cloneCanvas(original){return canvas(original.width,original.height,original.paint);},
    layerForStylePreview:layer => layer,
    buildMosaicCanvas(image,size){
      samples.push({size,paint:image.paint.slice()});
      return canvas(image.width,image.height,[`mosaic:${size}(${image.paint.join("+")})`]);
    },
    drawMosaicBrush(context,layer,mosaic){context.drawImage(mosaic,0,0);}
  };
  vm.createContext(sandbox);
  vm.runInContext(["renderLayers","getMosaicCanvas","drawLayer","compositeCanvas"].map(extractFunction).join("\n"),sandbox);
  const image = (id="photo") => ({id,type:"image",imageCanvas:canvas(100,100,[id]),x:20,y:30,w:100,h:100,opacity:100,visible:true});
  const mosaic = (type="mosaicRect",mosaicSize=18) => ({type,x:20,y:30,w:100,h:100,mosaicSize,points:[{x:30,y:40}],brushSize:20,visible:true});
  return {sandbox,baseCanvas,layerCanvas,samples,canvases,image,mosaic};
}

test("追加画像へのモザイクは直前までの合成を使い、表示と保存が一致する",() => {
  const h=harness();
  h.sandbox.state.layers=[h.image(),h.mosaic()];
  h.sandbox.renderLayers();
  assert.deepEqual(h.samples[0].paint,["base","photo"]);
  const displayed=[...h.baseCanvas.paint,...h.layerCanvas.paint];
  const output=h.sandbox.compositeCanvas();
  assert.deepEqual(h.samples[1].paint,["base","photo"]);
  assert.deepEqual(output.paint,displayed);
});

test("モザイクブラシと範囲は順序を反映し、後ろの画像や非表示レイヤーを素材に混ぜない",() => {
  const h=harness();
  const hidden=h.image("hidden");hidden.visible=false;
  h.sandbox.state.layers=[h.image("first"),hidden,h.mosaic(),h.image("second"),h.mosaic("mosaicBrush",24),h.image("later")];
  h.sandbox.renderLayers();
  const shown=h.samples.map(sample => ({size:sample.size,paint:sample.paint.slice()}));
  assert.deepEqual(shown,[
    {size:18,paint:["base","first"]},
    {size:24,paint:["base","first","mosaic:18(base+first)","second"]}
  ]);
  h.sandbox.compositeCanvas();
  assert.deepEqual(h.samples.slice(2),shown);
});

test("同じ履歴revision内の連続編集でも、画像・図形と重なり順の変更後に素材を更新する",() => {
  const h=harness();
  const photo=h.image();
  const rect={id:"rect",type:"rect",x:20,y:30,w:100,h:100,color:"#123456",lineWidth:8,fill:"#ff0000",fillNone:false,visible:true};
  h.sandbox.state.layers=[photo,rect,h.mosaic()];
  h.sandbox.renderLayers();
  assert.deepEqual(h.samples.at(-1).paint,["base","photo","fill:#ff0000","stroke:#123456"]);
  photo.imageCanvas.paint=["edited-photo"];rect.fill="#0000ff";
  h.sandbox.state.layers=[rect,photo,h.sandbox.state.layers[2]];
  h.sandbox.renderLayers();
  assert.deepEqual(h.samples.at(-1).paint,["base","fill:#0000ff","stroke:#123456","edited-photo"]);
  assert.equal(h.sandbox.state.baseRevision,1);
});

test("サイズ変更時のモザイクキャッシュは一件までで、同じサイズだけを再利用する",() => {
  const h=harness();
  for(const size of [4,8,12,16,4]){
    const first=h.sandbox.getMosaicCanvas(size);
    assert.equal(h.sandbox.state.mosaicCache.size,1);
    assert.equal(h.sandbox.getMosaicCanvas(size),first);
  }
  assert.equal(h.samples.length,5);
});

test("合成素材と一時モザイクは描画後に解放し、保存出力と画像bitmapは保持する",() => {
  const h=harness();
  const photo=h.image();
  h.sandbox.state.layers=[photo,h.mosaic(),h.mosaic("mosaicBrush",24)];
  const before=h.canvases.length;
  h.sandbox.renderLayers();
  assert.ok(h.canvases.slice(before).every(canvas => canvas.width === 0 && canvas.height === 0));
  assert.equal(h.sandbox.state.mosaicCache.size,0);
  const output=h.sandbox.compositeCanvas();
  assert.equal(output.width,600);assert.equal(output.height,400);
  assert.equal(photo.imageCanvas.width,100);assert.equal(photo.imageCanvas.height,100);
  assert.equal(h.baseCanvas.width,600);assert.equal(h.layerCanvas.width,600);
});

function alphaHarness(){
  const canvases=[];
  function canvas(width=0,height=0){
    let w=width,h=height;
    const result={alpha:new Float64Array(w*h),calls:[]};
    const stack=[];
    const paint=(x,y,sourceAlpha) => {
      if(x<0 || y<0 || x>=w || y>=h) return;
      const index=y*w+x;
      result.alpha[index]=sourceAlpha+result.alpha[index]*(1-sourceAlpha);
    };
    const context={
      globalAlpha:1,fillStyle:"",
      save(){stack.push({globalAlpha:this.globalAlpha,fillStyle:this.fillStyle});},
      restore(){Object.assign(this,stack.pop());},
      fillRect(x,y,width,height){
        result.calls.push({method:"fillRect",fill:this.fillStyle,args:[x,y,width,height]});
        assert.ok(["#fff","#ffffff"].includes(this.fillStyle));
        for(let row=y;row<y+height;row++) for(let col=x;col<x+width;col++) paint(col,row,this.globalAlpha);
      },
      drawImage(image,...args){
        result.calls.push({method:"drawImage",image,sourceAlpha:Array.from(image.alpha)});
        const [sx,sy,sw,sh,dx,dy,dw,dh]=args.length === 8 ? args
          : [0,0,image.width,image.height,args[0],args[1],args[2] ?? image.width,args[3] ?? image.height];
        for(let row=0;row<dh;row++) for(let col=0;col<dw;col++){
          const sourceX=Math.min(image.width-1,Math.floor(sx+col*sw/dw));
          const sourceY=Math.min(image.height-1,Math.floor(sy+row*sh/dh));
          paint(dx+col,dy+row,image.alpha[sourceY*image.width+sourceX]*this.globalAlpha);
        }
      }
    };
    const reset=() => {result.alpha=new Float64Array(w*h);};
    Object.defineProperties(result,{
      width:{get:() => w,set:value => {w=value;reset();}},
      height:{get:() => h,set:value => {h=value;reset();}}
    });
    result.getContext=() => context;canvases.push(result);return result;
  }
  const baseCanvas=canvas(8,4);baseCanvas.alpha.fill(.5);
  const brushes=[];
  const sandbox={
    baseCanvas,state:{baseRevision:1,mosaicCache:new Map()},layerContext:null,editContext:null,
    document:{createElement:() => canvas()},createCanvas:canvas,
    clamp:(value,min,max) => Math.min(max,Math.max(min,value)),
    layerForStylePreview:layer => layer,
    drawMosaicBrush(context,layer,mosaic){brushes.push(Array.from(mosaic.alpha));}
  };
  vm.createContext(sandbox);
  vm.runInContext(["buildMosaicCanvas","getMosaicCanvas","drawLayer"].map(extractFunction).join("\n"),sandbox);
  return {sandbox,baseCanvas,canvas,canvases,brushes};
}

test("半透明のモザイク素材は縮小前に白で合成し、不透明にして元画像を変更しない",() => {
  const h=alphaHarness(),original=Array.from(h.baseCanvas.alpha);
  const mosaic=h.sandbox.buildMosaicCanvas(h.baseCanvas,4);
  const small=h.canvases[1];
  assert.deepEqual(small.calls.map(call => call.method),["fillRect","drawImage"]);
  assert.equal(small.calls[0].fill,"#ffffff");
  assert.deepEqual(small.calls[0].args,[0,0,2,1]);
  assert.ok(Array.from(mosaic.alpha).every(alpha => alpha === 1));
  assert.deepEqual(Array.from(h.baseCanvas.alpha),original);
});

test("矩形のモザイク領域だけを不透明にし、領域外のPNG透明度を維持する",() => {
  const h=alphaHarness(),output=h.canvas(8,4);
  output.alpha.set(h.baseCanvas.alpha);
  h.sandbox.drawLayer(output.getContext("2d"),{type:"mosaicRect",x:0,y:0,w:4,h:4,mosaicSize:4});
  for(let y=0;y<4;y++) for(let x=0;x<8;x++){
    assert.equal(output.alpha[y*8+x],x<4 ? 1 : .5);
  }
  assert.ok(Array.from(h.baseCanvas.alpha).every(alpha => alpha === .5));
});

test("モザイクブラシも同じ不透明素材を使い、追加画像の不透明度変更は素材へ反映する",() => {
  const h=alphaHarness(),photo=h.canvas(8,4),output=h.canvas(8,4);
  photo.alpha.fill(1);
  const ctx=output.getContext("2d");
  h.sandbox.drawLayer(ctx,{type:"image",imageCanvas:photo,x:0,y:0,w:8,h:4,opacity:50});
  assert.ok(Array.from(output.alpha).every(alpha => alpha === .5));
  h.sandbox.drawLayer(ctx,{type:"mosaicBrush",mosaicSize:4,points:[{x:2,y:2}],brushSize:2},output);
  assert.ok(h.brushes[0].every(alpha => alpha === 1));
  const second=h.canvas(8,4);
  h.sandbox.drawLayer(second.getContext("2d"),{type:"image",imageCanvas:photo,x:0,y:0,w:8,h:4,opacity:20});
  assert.ok(Array.from(second.alpha).every(alpha => alpha === .2));
  h.sandbox.drawLayer(second.getContext("2d"),{type:"mosaicBrush",mosaicSize:4,points:[{x:2,y:2}],brushSize:2},second);
  assert.ok(h.brushes[1].every(alpha => alpha === 1));
  assert.ok(Array.from(photo.alpha).every(alpha => alpha === 1));
});
