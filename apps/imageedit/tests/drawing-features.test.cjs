const test = require("node:test");
const assert = require("node:assert/strict");
const drawing = require("../drawing-core.js");

test("真円・正方形は四方向で画像の端に収まり、解除すると自由な縦横比に戻る",() => {
  const size={width:500,height:300};
  for(const point of [{x:450,y:280},{x:5,y:5},{x:450,y:5},{x:5,y:280}]){
    const box=drawing.drawingBox({x:100,y:100},point,size,true);
    assert.equal(box.w,box.h);
    assert.ok(box.x >= 0 && box.y >= 0 && box.x+box.w <= size.width && box.y+box.h <= size.height);
  }
  assert.deepEqual(drawing.drawingBox({x:100,y:100},{x:140,y:160},size),{x:100,y:100,w:40,h:60});
  assert.deepEqual(drawing.drawingBox({x:499,y:299},{x:500,y:300},size,true),{x:499,y:299,w:1,h:1});
});

test("Ctrlの水平・垂直固定は近い軸を選び、解除時は指示点をそのまま使う",() => {
  const anchor={x:100,y:80};
  assert.deepEqual(drawing.constrainedLinePoint(anchor,{x:200,y:90},true),{x:200,y:80});
  assert.deepEqual(drawing.constrainedLinePoint(anchor,{x:90,y:200},true),{x:100,y:200});
  assert.deepEqual(drawing.constrainedLinePoint(anchor,{x:200,y:90}),{x:200,y:90});
});

test("Shiftの端点伸縮は元角度を維持し、画像端までで止まり反転しない",() => {
  const anchor={x:100,y:100},original={x:200,y:150},size={width:500,height:300};
  assert.deepEqual(drawing.angleLockedLinePoint(anchor,original,{x:900,y:500},size),{x:500,y:300});
  const result=drawing.angleLockedLinePoint(anchor,original,{x:220,y:210},size);
  assert.equal((result.y-anchor.y)/(result.x-anchor.x),.5);
  assert.deepEqual(drawing.angleLockedLinePoint(anchor,original,{x:50,y:50},size),anchor);
  assert.deepEqual(drawing.angleLockedLinePoint(anchor,anchor,{x:50,y:50},size),{x:50,y:50});
  const cropped=drawing.angleLockedLinePoint({x:-100,y:100},{x:100,y:200},{x:0,y:0},size);
  assert.deepEqual(cropped,{x:0,y:150});
});

test("比率固定リサイズは縦横比を保ち、細い図形でも画像境界を優先する",() => {
  const result=drawing.resizeBox({x:10,y:10,w:80,h:40},100,80,{width:150,height:90},true);
  assert.equal(result.w/result.h,2);
  assert.ok(result.w <= 140 && result.h <= 80);
  const thin=drawing.resizeBox({x:0,y:0,w:100,h:1},-98,0,{width:80,height:1},true);
  assert.equal(thin.w/thin.h,100);
  assert.ok(thin.w <= 80 && thin.h <= 1);
  assert.deepEqual(drawing.resizeBox({x:10,y:20,w:30,h:40},10,20,{width:500,height:300}),{w:40,h:60});
});

test("手ぶれ補正は画像座標で一定の距離を保ち、無効時は原点をそのまま使う",() => {
  const previous={x:10,y:10},point={x:30,y:10};
  assert.deepEqual(drawing.stabilizeInkPoint(previous,point,"none"),point);
  for(const [level,radius] of [["weak",1.5],["medium",3],["strong",6]]){
    const next=drawing.stabilizeInkPoint(previous,point,level);
    assert.equal(point.x-next.x,radius);
    assert.deepEqual(drawing.stabilizeInkPoint(previous,{x:11,y:10},level),previous);
  }
});

test("手書き点は独立して記録され、不正値・重複・点数上限を抑止する",() => {
  const points=[],point={x:3,y:4};
  assert.equal(drawing.appendInkPoint(points,point,2),true);
  point.x=100;
  assert.equal(points[0].x,3);
  assert.equal(drawing.appendInkPoint(points,{x:3.1,y:4},2),false);
  assert.equal(drawing.appendInkPoint(points,{x:NaN,y:4},2),false);
  assert.equal(drawing.appendInkPoint(points,{x:4,y:5},2),true);
  assert.equal(drawing.appendInkPoint(points,{x:5,y:6},2),false);
  assert.equal(drawing.imageInkPointCount([{type:"ink",points},{type:"blackoutBrush",points}]),2);
});

test("消しゴムは疎な入力でも通過した線全体に交差し、遠い線は消さない",() => {
  const stroke={type:"ink",brushSize:6,points:[{x:50,y:20},{x:50,y:100}]};
  assert.equal(drawing.inkIntersectsSegment(stroke,{x:0,y:60},{x:100,y:60},2),true);
  assert.equal(drawing.inkIntersectsSegment(stroke,{x:0,y:110},{x:100,y:110},2),false);
  assert.equal(drawing.inkIntersectsSegment(stroke,{x:54,y:60},{x:54,y:60},2),true);
  assert.equal(drawing.inkIntersectsSegment({brushSize:6,points:[{x:50,y:50}]},{x:40,y:50},{x:60,y:50},0),true);
  assert.equal(drawing.inkIntersectsSegment({brushSize:6,points:[]},{x:0,y:0},{x:100,y:100},2),false);
});

test("手書き外接矩形は大量点でも配列展開を使わず算出できる",() => {
  const points=Array.from({length:drawing.MAX_IMAGE_INK_POINTS},(_,i) => ({x:i%100,y:Math.floor(i/100)}));
  assert.deepEqual(drawing.inkBounds(points),{x:0,y:0,w:99,h:1999});
  assert.deepEqual(drawing.inkBounds([]),{x:0,y:0,w:0,h:0});
});
