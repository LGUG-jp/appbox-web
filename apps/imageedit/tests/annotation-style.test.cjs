const test = require("node:test");
const assert = require("node:assert/strict");
const annotation = require("../annotation-style.js");

function context(){
  const calls = [];
  const target = {
    calls,save(){},restore(){},
    measureText(text){return {width:Array.from(text).length*10,actualBoundingBoxAscent:18,actualBoundingBoxDescent:4};}
  };
  for(const method of ["fillText","strokeText","fillRect","strokeRect","ellipse","arc","beginPath","closePath","moveTo","lineTo","fill","stroke"]){
    target[method] = (...args) => calls.push({method,args,font:target.font,strokeStyle:target.strokeStyle,fillStyle:target.fillStyle,lineWidth:target.lineWidth,lineCap:target.lineCap,lineJoin:target.lineJoin,miterLimit:target.miterLimit});
  }
  return target;
}

const text = overrides => ({type:"text",x:100,y:150,text:"あいうえお\n二行",fontSize:20,textWidth:30,color:"#123456",...overrides});

test("端末内の12フォントだけを使用し、未指定の既存文字は従来のsans-serif/太字を保つ",() => {
  assert.equal(Object.keys(annotation.FONT_STACKS).length,12);
  assert.equal(annotation.fontFor(text({fontFamily:undefined})),"700 20px sans-serif");
  assert.match(annotation.fontFor(text({fontFamily:"ms-mincho",bold:false})),/^400 20px "MS Mincho"/);
  assert.equal(annotation.safeFontFamily("unknown"),annotation.DEFAULT_FONT_FAMILY);
  assert.equal(Object.values(annotation.FONT_STACKS).some(stack => /https?:/.test(stack)),false);
});

test("明示改行・空行と指定幅の折り返しを描画と選択サイズで共用する",() => {
  const ctx = context();
  const layer = text({text:"あいうえお\n\n二行"});
  const layout = annotation.layoutText(ctx,layer);
  assert.deepEqual(layout.lines,["あいう","えお","","二行"]);
  assert.deepEqual(layout.bounds,{x:100,y:132,w:30,h:101.2});
  const drawn = annotation.drawText(ctx,layer);
  assert.deepEqual(drawn,layout);
  assert.deepEqual(ctx.calls.filter(call => call.method === "fillText").map(call => call.args[0]),layout.lines);
  assert.equal(ctx.calls.find(call => call.method === "fillText").args[2],150);
});

test("幅未指定の既存文字は強制折り返しせず、CRLFも単一改行になる",() => {
  const ctx = context();
  const layout = annotation.layoutText(ctx,text({textWidth:undefined,text:"123456789\r\n次行"}));
  assert.deepEqual(layout.lines,["123456789","次行"]);
  assert.equal(layout.bounds.w,90);
});

test("折り返しは絵文字や結合文字の一文字を途中で分割しない",() => {
  const ctx = context();
  assert.deepEqual(annotation.wrapText(ctx,"👩‍💻か\u3099A",10),["👩‍💻","か\u3099","A"]);
});

test("文字背景は枠全体を覆い、白縁は文字色より先に同じ座標で描く",() => {
  const ctx = context();
  const layer = text({bgTransparent:false,bgColor:"#ffeeee",outline:true});
  const layout = annotation.drawText(ctx,layer);
  const background = ctx.calls[0];
  assert.equal(background.method,"fillRect");
  assert.equal(background.fillStyle,"#ffeeee");
  assert.deepEqual(background.args,[layout.bounds.x,layout.bounds.y,layout.bounds.w,layout.bounds.h]);
  const strokes = ctx.calls.filter(call => call.method === "strokeText");
  const fills = ctx.calls.filter(call => call.method === "fillText");
  assert.equal(strokes.length,3);
  assert.deepEqual(strokes.map(call => call.args),fills.map(call => call.args));
  assert.equal(strokes[0].strokeStyle,"#ffffff");
  assert.ok(strokes.every(call => call.lineWidth === 6));
  assert.equal(fills[0].fillStyle,"#123456");
});

test("透明背景と白縁オフでは背景や縁を追加しない",() => {
  const ctx = context();
  annotation.drawText(ctx,text({bgTransparent:true,outline:false}));
  assert.equal(ctx.calls.some(call => ["fillRect","strokeText"].includes(call.method)),false);
});

test("矢印は線と矢尻を一体の閉じた輪郭で描き、白縁も尖りを保つ",() => {
  const ctx = context();
  annotation.drawArrow(ctx,{type:"arrow",x1:10,y1:10,x2:100,y2:50,lineWidth:8,color:"#cc0000",outline:true});
  const strokes = ctx.calls.filter(call => call.method === "stroke");
  assert.deepEqual(strokes.map(call => [call.strokeStyle,call.lineWidth,call.lineJoin,call.miterLimit]),[["#ffffff",8,"miter",4]]);
  assert.deepEqual(ctx.calls.filter(call => call.method === "fill").map(call => call.fillStyle),["#cc0000"]);
  assert.equal(ctx.calls.filter(call => call.method === "beginPath").length,1);
  const closed = ctx.calls.findIndex(call => call.method === "closePath");
  assert.ok(closed < ctx.calls.findIndex(call => call.method === "stroke"));
  assert.ok(ctx.calls.findIndex(call => call.method === "stroke") < ctx.calls.findIndex(call => call.method === "fill"));
  assert.equal(ctx.calls.filter(call => call.method === "arc").length,1,"始点の丸い端は維持する");
  assert.equal(ctx.calls.filter(call => call.method === "lineTo" && call.args[0] === 100 && call.args[1] === 50).length,1);
});

test("太い・短い・斜め・逆向き矢印でも色の輪郭は先端を越えず、長さ内の尖った矢尻になる",() => {
  for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1],[.6,.8],[-.6,-.8]]){
    for(const length of [2,10,100,1200]){
      for(const lineWidth of [1,8,100]){
        for(const outline of [false,true]){
          const ctx=context();
          const layer={type:"arrow",x1:300,y1:300,x2:300+dx*length,y2:300+dy*length,lineWidth,color:"#123456",outline};
          assert.equal(annotation.drawArrow(ctx,layer),true);
          const vertices=ctx.calls.filter(call => ["moveTo","lineTo"].includes(call.method)).map(call => call.args);
          assert.ok(vertices.every(point => point.every(Number.isFinite)));
          assert.ok(vertices.every(([x,y]) => (x-layer.x1)*dx+(y-layer.y1)*dy <= length+1e-8),`先端からのはみ出し: ${length}/${lineWidth}`);
          assert.equal(vertices.filter(([x,y]) => x === layer.x2 && y === layer.y2).length,1);
          const headLength=Math.min(length,Math.max(12,lineWidth*4)*Math.cos(Math.PI/6));
          const shoulders=vertices.filter(([x,y]) => Math.abs((x-layer.x1)*dx+(y-layer.y1)*dy-(length-headLength)) < 1e-8);
          assert.ok(shoulders.length >= 2);
          const halfWidth=headLength*Math.tan(Math.PI/6);
          assert.ok(shoulders.some(([x,y]) => Math.abs(Math.abs(-(x-layer.x1)*dy+(y-layer.y1)*dx)-halfWidth) < 1e-8));
          assert.equal(ctx.calls.filter(call => call.method === "stroke").length,outline ? 1 : 0);
          if(headLength === length){
            assert.equal(vertices.length,3,"短い矢印は三角形のみとし、太線端を重ねない");
            assert.equal(ctx.calls.some(call => call.method === "arc"),false);
          }
        }
      }
    }
  }
});

test("長さゼロ・不正な座標や線幅の矢印は描画APIへ渡さない",() => {
  for(const change of [{x2:10,y2:20},{x2:NaN},{x1:-Number.MAX_VALUE,x2:Number.MAX_VALUE},{lineWidth:0},{lineWidth:-1},{lineWidth:Infinity}]){
    const ctx=context();
    assert.equal(annotation.drawArrow(ctx,{type:"arrow",x1:10,y1:20,x2:100,y2:80,lineWidth:8,color:"#123456",outline:true,...change}),false);
    assert.deepEqual(ctx.calls,[]);
  }
});

test("太くした文字の白縁は透明時3px・背景あり4pxを選択範囲へ含める",() => {
  const ctx = context();
  const layer = text({text:"AB",outline:true});
  assert.equal(annotation.TEXT_OUTLINE_WIDTH,6);
  assert.deepEqual(annotation.layoutText(ctx,layer).bounds,{x:97,y:129,w:36,h:28});
  assert.deepEqual(annotation.layoutText(ctx,{...layer,bgTransparent:false}).bounds,{x:96,y:128,w:38,h:30});
  assert.deepEqual(annotation.layoutText(ctx,{...layer,outline:false}).bounds,{x:100,y:132,w:30,h:22});
  const box = annotation.editingTextBox(ctx,layer);
  assert.equal(box.left,100);
  assert.equal(box.width,30);
});

test("直線の白縁は同じ端点の外側へ広げ、元の線色・太さ・丸い端を保つ",() => {
  const ctx = context();
  const layer = {type:"line",x1:10,y1:20,x2:130,y2:50,color:"#124578",lineWidth:4,outline:true,fillNone:false};
  assert.equal(annotation.SHAPE_OUTLINE_EXTRA,8);
  assert.equal(annotation.drawShape(ctx,layer),true);
  assert.deepEqual(ctx.calls.filter(call => ["moveTo","lineTo"].includes(call.method)).map(call => call.args),[[10,20],[130,50]]);
  const strokes = ctx.calls.filter(call => call.method === "stroke");
  assert.deepEqual(strokes.map(call => [call.strokeStyle,call.lineWidth,call.lineCap]),[["#ffffff",12,"round"],["#124578",4,"round"]]);
  assert.equal(ctx.calls.some(call => ["fill","fillRect"].includes(call.method)),false);
});

test("四角形の塗りは一度だけ描画し、同じ寸法の白縁と色枠を順に重ねる",() => {
  const ctx = context();
  const layer = {type:"rect",x:10,y:20,w:120,h:60,color:"#124578",lineWidth:4,outline:true,fill:"#fff4cc",fillNone:false};
  annotation.drawShape(ctx,layer);
  assert.deepEqual(ctx.calls.map(call => call.method),["fillRect","strokeRect","strokeRect"]);
  assert.equal(ctx.calls[0].fillStyle,"#fff4cc");
  assert.deepEqual(ctx.calls.map(call => call.args),[[10,20,120,60],[10,20,120,60],[10,20,120,60]]);
  assert.deepEqual(ctx.calls.slice(1).map(call => [call.strokeStyle,call.lineWidth]),[["#ffffff",12],["#124578",4]]);
});

test("楕円は中心と縦横半径を共有して塗り・白縁・色枠を描き、真円以外も形を保つ",() => {
  const ctx = context();
  const layer = {type:"ellipse",x:10,y:20,w:120,h:60,color:"#124578",lineWidth:4,outline:true,fill:"#fff4cc",fillNone:false};
  annotation.drawShape(ctx,layer);
  assert.deepEqual(ctx.calls.map(call => call.method),["beginPath","ellipse","fill","stroke","stroke"]);
  assert.deepEqual(ctx.calls.find(call => call.method === "ellipse").args,[70,50,60,30,0,0,Math.PI*2]);
  assert.equal(ctx.calls.find(call => call.method === "fill").fillStyle,"#fff4cc");
  assert.deepEqual(ctx.calls.filter(call => call.method === "stroke").map(call => [call.strokeStyle,call.lineWidth]),[["#ffffff",12],["#124578",4]]);
});

test("白縁オフ・未指定の既存直線と図形は色枠だけを描き、塗りオフは透明のまま保つ",() => {
  for(const type of ["line","rect","ellipse"]){
    for(const outline of [undefined,false]){
      const ctx = context();
      annotation.drawShape(ctx,{type,x:10,y:20,w:120,h:60,x1:10,y1:20,x2:130,y2:80,color:"#124578",lineWidth:4,outline,fillNone:true});
      const strokes = ctx.calls.filter(call => ["strokeRect","stroke"].includes(call.method));
      assert.deepEqual(strokes.map(call => [call.strokeStyle,call.lineWidth]),[["#124578",4]],`${type}/${outline}`);
      assert.equal(ctx.calls.some(call => ["fill","fillRect"].includes(call.method)),false,`${type}/${outline}`);
    }
  }
  for(const outline of [undefined,false]){
    const ctx = context();
    annotation.drawArrow(ctx,{type:"arrow",x1:10,y1:20,x2:130,y2:80,color:"#124578",lineWidth:4,outline});
    assert.deepEqual(ctx.calls.filter(call => call.method === "stroke"),[]);
    assert.deepEqual(ctx.calls.filter(call => call.method === "fill").map(call => call.fillStyle),["#124578"]);
  }
});

test("線・四角形・楕円へ白縁を一括適用でき、未指定はオフ、画像・手書き・秘匿加工は対象外",() => {
  const supported = ["text","arrow","line","rect","ellipse"].map(type => ({id:type,type}));
  const excluded = ["image","ink","blackoutRect","mosaicRect","blackoutBrush","mosaicBrush"].map(type => ({id:type,type}));
  const common = annotation.commonFieldValue([...supported,...excluded],"outline");
  assert.deepEqual(common.eligible,supported);
  assert.equal(common.value,false);
  assert.equal(common.mixed,false);
  supported[2].outline=true;
  assert.equal(annotation.commonFieldValue(supported,"outline").mixed,true);
  for(const layer of excluded){
    assert.equal(annotation.eligibleForField(layer,"outline"),false,layer.type);
    const ctx = context();
    assert.equal(annotation.drawShape(ctx,layer),false,layer.type);
    assert.deepEqual(ctx.calls,[],layer.type);
  }
});

test("一括書式は対応種類だけを対象にし、画像や秘匿加工の色を変更対象にしない",() => {
  const layers = [text({id:"text",color:"#111111"}),{id:"rect",type:"rect",color:"#222222"},{id:"image",type:"image",color:"#333333"},{id:"blackout",type:"blackoutRect",color:"#444444"}];
  const colors = annotation.commonFieldValue(layers,"color");
  assert.deepEqual(colors.eligible.map(layer => layer.id),["text","rect"]);
  assert.equal(colors.mixed,true);
  assert.deepEqual(annotation.commonFieldValue(layers,"fontFamily").eligible.map(layer => layer.id),["text"]);
  assert.deepEqual(annotation.commonFieldValue(layers,"fill").eligible.map(layer => layer.id),["rect"]);
  assert.equal(annotation.eligibleForField({type:"line"},"outline"),true);
});

test("既存文字・図形の未指定設定を統一値として扱う",() => {
  const texts = [text(),text({bold:true,bgTransparent:true})];
  assert.deepEqual(annotation.commonFieldValue(texts,"bold"),{eligible:texts,mixed:false,value:true});
  assert.equal(annotation.commonFieldValue(texts,"outline").value,false);
  assert.equal(annotation.commonFieldValue([{type:"rect"},{type:"ellipse",fillNone:true}],"fillNone").mixed,false);
});

test("複数画像の不透明度は画像だけを対象とし、既定100%と混在値を認識する",() => {
  const image = {type:"image"};
  const explicit = {type:"image",opacity:100};
  const text = {type:"text",opacity:50};
  const common = annotation.commonFieldValue([image,explicit,text],"opacity");
  assert.deepEqual(common.eligible,[image,explicit]);
  assert.equal(common.value,100);
  assert.equal(common.mixed,false);
  const mixed = annotation.commonFieldValue([image,{type:"image",opacity:50},text],"opacity");
  assert.equal(mixed.mixed,true);
  assert.equal(annotation.eligibleForField({type:"rect"},"opacity"),false);
});

test("直接編集欄はフォント全体のbaselineと同じ行高・指定幅へ揃える",() => {
  const ctx = context();
  const fonts = [];
  ctx.measureText = function(value){
    fonts.push(this.font);
    return {width:Array.from(value).length*10,fontBoundingBoxAscent:19,fontBoundingBoxDescent:5};
  };
  const layer = text({fontFamily:"ms-mincho",bold:false,text:"あいうえ"});
  const box = annotation.editingTextBox(ctx,layer);
  assert.equal(box.left,100);
  assert.ok(Math.abs(box.top-129.8) < 1e-10);
  assert.equal(box.width,30);
  assert.equal(box.lineHeight,26.400000000000002);
  assert.equal(box.height,52.800000000000004);
  assert.ok(fonts.every(font => font === annotation.fontFor(layer)));
});

test("fontBoundingBox未対応でも文字内容で入力位置が揺れず、空欄は300px一行を保つ",() => {
  const ctx = context();
  ctx.measureText = value => ({width:Array.from(value).length*10,actualBoundingBoxAscent:value.includes("g") ? 8 : 20,actualBoundingBoxDescent:value.includes("g") ? 9 : 0});
  const first = annotation.editingTextBox(ctx,text({textWidth:undefined,text:"あ"}));
  const second = annotation.editingTextBox(ctx,text({textWidth:undefined,text:"g"}));
  assert.deepEqual(first,second);
  const empty = annotation.editingTextBox(ctx,text({textWidth:undefined,text:""}));
  assert.equal(empty.width,300);
  assert.equal(empty.height,empty.lineHeight);
  assert.ok(Math.abs(empty.top-130.8) < 1e-10);
  assert.equal(annotation.editingTextBox(ctx,text({textWidth:12,text:""})).width,12);
  assert.equal(annotation.editingTextBox(ctx,text({textWidth:undefined,text:"長".repeat(36)})).width,360);
});

test("直接編集のクリック位置はCanvasの折返し行・空行とUTF16文字位置を共有する",() => {
  const ctx = context();
  const layer = text({text:"abcd\n\nxy"});
  const box = annotation.editingTextBox(ctx,layer);
  const at = (x,row) => annotation.textCaretIndex(ctx,layer,{x:layer.x+x,y:box.top+(row+.5)*box.lineHeight});
  assert.deepEqual(annotation.layoutText(ctx,layer).lines,["abc","d","","xy"]);
  assert.equal(at(-20,0),0);
  assert.equal(at(5,0),0);
  assert.equal(at(6,0),1);
  assert.equal(at(26,0),3);
  assert.equal(at(0,1),3);
  assert.equal(at(30,1),4);
  assert.equal(at(20,2),5);
  assert.equal(at(10,3),7);
  assert.equal(at(200,3),8);
  assert.equal(at(-200,-10),0);
  assert.equal(at(200,10),8);
});

test("クリックcaretは絵文字・結合文字を分断せず、CRLFをtextareaと同じLF indexへ換算する",() => {
  const ctx = context();
  const layer = text({text:"👩‍💻か\u3099A",textWidth:10});
  const box = annotation.editingTextBox(ctx,layer);
  const at = (x,row) => annotation.textCaretIndex(ctx,layer,{x:layer.x+x,y:box.top+(row+.5)*box.lineHeight});
  assert.deepEqual(annotation.layoutText(ctx,layer).lines,["👩‍💻","か\u3099A"]);
  assert.equal(at(15,0),0);
  assert.equal(at(16,0),5);
  assert.equal(at(0,1),5);
  assert.equal(at(11,1),7);
  assert.equal(at(26,2),8);
  const newlines = text({text:"ab\r\nc\rd",textWidth:undefined});
  const newlineBox = annotation.editingTextBox(ctx,newlines);
  assert.equal(annotation.textCaretIndex(ctx,newlines,{x:100,y:newlineBox.top+newlineBox.lineHeight*1.5}),3);
  assert.equal(annotation.textCaretIndex(ctx,newlines,{x:110,y:newlineBox.top+newlineBox.lineHeight*2.5}),6);
  assert.equal(annotation.textCaretIndex(ctx,text({text:""}),{x:1000,y:1000}),0);
});

test("極細の指定幅でも一つのgraphemeが収まり、描画・入力欄・caretの折返しを共有する",() => {
  const ctx = context();
  const layer = text({text:"👩‍💻Aあ",textWidth:2});
  const layout = annotation.layoutText(ctx,layer);
  const box = annotation.editingTextBox(ctx,layer);
  assert.equal(layer.textWidth,2);
  assert.equal(layout.bounds.w,30);
  assert.equal(box.width,30);
  assert.deepEqual(layout.lines,["👩‍💻","Aあ"]);
  assert.equal(box.height,box.lineHeight*2);
  assert.equal(annotation.textCaretIndex(ctx,layer,{x:100+16,y:box.top+box.lineHeight*.5}),5);
  assert.equal(annotation.textCaretIndex(ctx,layer,{x:100+16,y:box.top+box.lineHeight*1.5}),7);
  const drawn = annotation.drawText(ctx,layer);
  assert.deepEqual(drawn,layout);
  assert.deepEqual(ctx.calls.filter(call => call.method === "fillText").map(call => call.args[0]),layout.lines);
});

test("Tabは行起点の半角空白8文字ごとの停止位置で測定・描画し、白縁を文字より先に描く",() => {
  const ctx = context();
  const layer = text({text:"ab\tc\tde\nx\ty",textWidth:undefined,outline:true});
  const layout = annotation.drawText(ctx,layer);
  assert.equal(layout.bounds.w,186);
  const fills = ctx.calls.filter(call => call.method === "fillText");
  const strokes = ctx.calls.filter(call => call.method === "strokeText");
  assert.deepEqual(fills.map(call => call.args),[
    ["ab",100,150],["c",180,150],["de",260,150],
    ["x",100,176.4],["y",180,176.4]
  ]);
  assert.deepEqual(strokes.map(call => call.args),fills.map(call => call.args));
  assert.deepEqual(ctx.calls.map(call => call.method),[
    "strokeText","strokeText","strokeText","fillText","fillText","fillText",
    "strokeText","strokeText","fillText","fillText"
  ]);
  assert.ok(fills.every(call => !call.args[0].includes("\t")));
});

test("Tabを含む行の折返しでは停止位置を行ごとに戻し、クリックcaretは元のTab indexを保持する",() => {
  const ctx = context();
  const layer = text({text:"ab\tcd\tZ",textWidth:100});
  assert.deepEqual(annotation.wrapText(ctx,layer.text,100),["ab\tcd","\tZ"]);
  const layout = annotation.drawText(ctx,layer);
  const box = annotation.editingTextBox(ctx,layer);
  assert.deepEqual(layout.lines,["ab\tcd","\tZ"]);
  assert.equal(box.width,100);
  assert.equal(box.height,box.lineHeight*2);
  assert.deepEqual(ctx.calls.filter(call => call.method === "fillText").map(call => call.args),[
    ["ab",100,150],["cd",180,150],["Z",180,176.4]
  ]);
  const at = (x,row) => annotation.textCaretIndex(ctx,layer,{x:100+x,y:box.top+(row+.5)*box.lineHeight});
  assert.equal(at(21,0),2);
  assert.equal(at(49,0),2);
  assert.equal(at(51,0),3);
  assert.equal(at(86,0),4);
  assert.equal(at(10,1),5);
  assert.equal(at(41,1),6);
  assert.equal(at(86,1),7);
  const tabOnly = text({text:"\tX",textWidth:2});
  assert.equal(annotation.editingTextBox(ctx,tabOnly).width,80);
  assert.deepEqual(annotation.layoutText(ctx,tabOnly).lines,["\t","X"]);
});

test("行末・連続空白を除かず文字幅どおりに折り返してcaretの位置を残す",() => {
  const ctx = context();
  const layer = text({text:"a   b\n  ",textWidth:30});
  const layout = annotation.layoutText(ctx,layer);
  const box = annotation.editingTextBox(ctx,layer);
  assert.deepEqual(layout.lines,["a  "," b","  "]);
  assert.equal(annotation.textCaretIndex(ctx,layer,{x:128,y:box.top+box.lineHeight*.5}),3);
  assert.equal(annotation.textCaretIndex(ctx,layer,{x:118,y:box.top+box.lineHeight*2.5}),8);
  assert.equal(layer.text,"a   b\n  ");
});

test("Tab停止位置まで0.5ch未満ならネイティブCSSと同じ次の停止位置へ進む",() => {
  const ctx = context();
  ctx.measureText = value => ({width:Array.from(value).reduce((sum,character) => sum+(character === "a" ? 76 : 10),0),actualBoundingBoxAscent:18,actualBoundingBoxDescent:4});
  const layer = text({text:"a\tZ",textWidth:undefined});
  const layout = annotation.drawText(ctx,layer);
  assert.equal(layout.bounds.w,170);
  assert.deepEqual(ctx.calls.filter(call => call.method === "fillText").map(call => call.args),[["a",100,150],["Z",260,150]]);
  assert.deepEqual(annotation.wrapText(ctx,layer.text,100),["a","\tZ"]);
  const box = annotation.editingTextBox(ctx,layer);
  assert.equal(annotation.textCaretIndex(ctx,layer,{x:250,y:box.top+box.lineHeight*.5}),2);
});
