(function(root,factory){
  const api = factory();
  if(typeof module === "object" && module.exports) module.exports = api;
  else root.AppBoxImageAnnotation = api;
})(typeof globalThis === "object" ? globalThis : this,function(){
  "use strict";

  const TEXT_OUTLINE_WIDTH = 6;
  const SHAPE_OUTLINE_EXTRA = 8;

  // PDFかんたん編集と同じ端末内フォントを使用する。Webフォント通信は行わない。
  const FONT_STACKS = Object.freeze({
    "biz-udgothic":'"BIZ UDGothic","BIZ UDゴシック","Yu Gothic UI","Meiryo",sans-serif',
    "biz-udpgothic":'"BIZ UDPGothic","BIZ UDPゴシック","Yu Gothic UI","Meiryo",sans-serif',
    "yu-gothic":'"Yu Gothic","游ゴシック","Yu Gothic UI","Meiryo",sans-serif',
    "yu-gothic-ui":'"Yu Gothic UI","游ゴシック UI","Yu Gothic","Meiryo",sans-serif',
    meiryo:'"Meiryo","メイリオ","Yu Gothic UI",sans-serif',
    "ms-gothic":'"MS Gothic","ＭＳ ゴシック","Meiryo",monospace',
    "ms-pgothic":'"MS PGothic","ＭＳ Ｐゴシック","Meiryo",sans-serif',
    "ms-mincho":'"MS Mincho","ＭＳ 明朝","Yu Mincho",serif',
    "ms-pmincho":'"MS PMincho","ＭＳ Ｐ明朝","Yu Mincho",serif',
    "segoe-ui":'"Segoe UI","Yu Gothic UI","Meiryo",sans-serif',
    arial:'"Arial","Yu Gothic UI","Meiryo",sans-serif',
    "times-new-roman":'"Times New Roman","Yu Mincho","MS PMincho",serif'
  });
  const DEFAULT_FONT_FAMILY = "yu-gothic-ui";
  const safeFontFamily = key => Object.hasOwn(FONT_STACKS,key) ? key : DEFAULT_FONT_FAMILY;
  const fontStackFor = key => FONT_STACKS[safeFontFamily(key)];
  const fontFor = layer => `${layer.bold === false ? "400" : "700"} ${layer.fontSize}px ${layer.fontFamily ? fontStackFor(layer.fontFamily) : "sans-serif"}`;

  function textSegments(text){
    if(typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"){
      return [...new Intl.Segmenter("ja",{granularity:"grapheme"}).segment(text)].map(part => part.segment);
    }
    return Array.from(text);
  }

  function tabbedTextRuns(context,text){
    const parts = text.split("\t");
    const tabWidth = Math.max(1,context.measureText(" ").width)*8;
    const minimumAdvance = Math.max(0,context.measureText("0").width)/2;
    const runs = [];
    let width = 0;
    parts.forEach((part,index) => {
      if(part){
        runs.push({text:part,x:width});
        width += context.measureText(part).width;
      }
      if(index < parts.length-1){
        let stop = (Math.floor(width/tabWidth)+1)*tabWidth;
        // CSS preserved tabs advance at least 0.5ch to the next tab stop.
        if(stop-width < minimumAdvance) stop += tabWidth;
        width = stop;
      }
    });
    return {runs,width};
  }

  function textAdvance(context,text){
    return text.includes("\t") ? tabbedTextRuns(context,text).width : context.measureText(text).width;
  }

  function effectiveWrapWidth(context,layer){
    if(!Number.isFinite(layer.textWidth) || layer.textWidth <= 0) return undefined;
    let width = layer.textWidth;
    for(const paragraph of String(layer.text ?? "").replace(/\r\n?/g,"\n").split("\n")){
      for(const character of textSegments(paragraph)) width = Math.max(width,textAdvance(context,character));
    }
    return width;
  }

  function wrappedTextRanges(context,text,width){
    const lines = [];
    let paragraphStart = 0;
    for(const paragraph of String(text ?? "").replace(/\r\n?/g,"\n").split("\n")){
      if(!Number.isFinite(width) || width <= 0){
        lines.push({text:paragraph,start:paragraphStart,end:paragraphStart+paragraph.length});
        paragraphStart += paragraph.length+1;
        continue;
      }
      let line = "";
      let lineStart = paragraphStart;
      let index = paragraphStart;
      for(const character of textSegments(paragraph)){
        const next = line+character;
        if(line && textAdvance(context,next) > width){
          lines.push({text:line,start:lineStart,end:index});
          line = character;
          lineStart = index;
        }else line = next;
        index += character.length;
      }
      lines.push({text:line,start:lineStart,end:index});
      paragraphStart += paragraph.length+1;
    }
    return lines;
  }

  function wrapText(context,text,width){
    return wrappedTextRanges(context,text,width).map(line => line.text);
  }

  // Quarter-turn orientation stays separate from editable text layout and wrapping.
  function textTransform(layer){
    const angle = ((Number(layer.rotation) || 0)%360+360)%360;
    const index = Math.round(angle/90)%4;
    const cos = [1,0,-1,0][index],sin = [0,1,0,-1][index];
    const flip = layer.textFlipX ? -1 : 1;
    return {a:cos*flip || 0,b:sin*flip || 0,c:-sin || 0,d:cos || 0};
  }

  function transformTextPoint(layer,point,inverse=false){
    const {a,b,c,d} = textTransform(layer);
    const x = point.x-layer.x,y = point.y-layer.y;
    return inverse ? {x:layer.x+a*x+b*y,y:layer.y+c*x+d*y}
      : {x:layer.x+a*x+c*y,y:layer.y+b*x+d*y};
  }

  function transformedTextBounds(layer,box){
    const {a,b,c,d} = textTransform(layer);
    if(a === 1 && !b && !c && d === 1) return box;
    const corners = [
      {x:box.x,y:box.y},{x:box.x+box.w,y:box.y},
      {x:box.x,y:box.y+box.h},{x:box.x+box.w,y:box.y+box.h}
    ].map(point => transformTextPoint(layer,point));
    const x = Math.min(...corners.map(point => point.x)),y = Math.min(...corners.map(point => point.y));
    return {x,y,w:Math.max(...corners.map(point => point.x))-x,h:Math.max(...corners.map(point => point.y))-y};
  }

  function layoutText(context,layer){
    context.save();
    context.font = fontFor(layer);
    // A whole grapheme must fit both Canvas and the native caret, even when a
    // numeric width is smaller than the glyph. Preserve that requested value.
    const wrapWidth = effectiveWrapWidth(context,layer);
    const lines = wrapText(context,layer.text,wrapWidth);
    const metrics = lines.map(line => context.measureText(line || "Ｍ"));
    const ascent = Math.max(1,...metrics.map(item => Number.isFinite(item.actualBoundingBoxAscent) && item.actualBoundingBoxAscent > 0 ? item.actualBoundingBoxAscent : layer.fontSize));
    const descent = Math.max(0,...metrics.map(item => Number.isFinite(item.actualBoundingBoxDescent) ? item.actualBoundingBoxDescent : layer.fontSize*.25));
    const lineHeight = layer.fontSize*1.32;
    const width = wrapWidth ?? Math.max(1,...lines.map(line => textAdvance(context,line)));
    const pad = Math.max(layer.bgTransparent === false ? 4 : 0,layer.outline ? TEXT_OUTLINE_WIDTH/2 : 0);
    const bounds = {
      x:layer.x-pad,y:layer.y-ascent-pad,
      w:Math.max(1,width+pad*2),h:Math.max(1,(lines.length-1)*lineHeight+ascent+descent+pad*2)
    };
    context.restore();
    return {lines,lineHeight,ascent,descent,localBounds:bounds,bounds:transformedTextBounds(layer,bounds)};
  }

  function editingTextBox(context,layer){
    const fontSize = Number.isFinite(layer.fontSize) && layer.fontSize > 0 ? layer.fontSize : 42;
    const lineHeight = fontSize*1.32;
    context.save();
    context.font = fontFor({...layer,fontSize});
    // Font-wide metrics keep the input baseline still while its glyphs change.
    // Older Canvas implementations use a fixed font-size ratio instead.
    const metrics = context.measureText("Ｍgj");
    const ascent = Number.isFinite(metrics.fontBoundingBoxAscent) && metrics.fontBoundingBoxAscent > 0
      ? metrics.fontBoundingBoxAscent : fontSize*.8;
    const descent = Number.isFinite(metrics.fontBoundingBoxDescent) && metrics.fontBoundingBoxDescent >= 0
      ? metrics.fontBoundingBoxDescent : fontSize*.2;
    const wrapWidth = effectiveWrapWidth(context,layer);
    const lines = wrapText(context,layer.text,wrapWidth);
    const width = wrapWidth ?? Math.max(300,...lines.map(line => textAdvance(context,line)));
    context.restore();
    const origin = transformTextPoint(layer,{x:layer.x,y:layer.y-((lineHeight-ascent-descent)/2+ascent)});
    return {
      left:origin.x,
      top:origin.y,
      width,
      height:Math.max(1,lines.length)*lineHeight,
      lineHeight
    };
  }

  function textCaretIndex(context,layer,point){
    point = transformTextPoint(layer,point,true);
    const box = editingTextBox(context,{...layer,rotation:0,textFlipX:false});
    context.save();
    context.font = fontFor(layer);
    const width = effectiveWrapWidth(context,layer);
    const lines = wrappedTextRanges(context,layer.text,width);
    const row = Math.max(0,Math.min(lines.length-1,Math.floor((point.y-box.top)/box.lineHeight)));
    const line = lines[row];
    const x = point.x-layer.x;
    let index = line.start;
    let prefix = "";
    let previousWidth = 0;
    for(const character of textSegments(line.text)){
      const next = prefix+character;
      const nextWidth = textAdvance(context,next);
      if(x <= (previousWidth+nextWidth)/2){
        context.restore();
        return index;
      }
      index += character.length;
      prefix = next;
      previousWidth = nextWidth;
    }
    context.restore();
    return line.end;
  }

  function drawText(context,layer){
    const layout = layoutText(context,layer);
    context.save();
    const {a,b,c,d} = textTransform(layer);
    if(a !== 1 || b || c || d !== 1){
      context.transform(a,b,c,d,layer.x-a*layer.x-c*layer.y,layer.y-b*layer.x-d*layer.y);
    }
    context.font = fontFor(layer);
    context.textAlign = "left";
    context.textBaseline = "alphabetic";
    if(layer.bgTransparent === false){
      context.fillStyle = layer.bgColor || "#ffffff";
      const box = layout.localBounds;
      context.fillRect(box.x,box.y,box.w,box.h);
    }
    context.fillStyle = layer.color;
    context.strokeStyle = "#ffffff";
    context.lineWidth = TEXT_OUTLINE_WIDTH;
    context.lineJoin = "round";
    layout.lines.forEach((line,index) => {
      const y = layer.y+index*layout.lineHeight;
      if(!line.includes("\t")){
        if(layer.outline) context.strokeText(line,layer.x,y);
        context.fillText(line,layer.x,y);
        return;
      }
      const {runs} = tabbedTextRuns(context,line);
      if(layer.outline) runs.forEach(run => context.strokeText(run.text,layer.x+run.x,y));
      runs.forEach(run => context.fillText(run.text,layer.x+run.x,y));
    });
    context.restore();
    return layout;
  }

  function drawArrow(context,layer){
    if(![layer.x1,layer.y1,layer.x2,layer.y2,layer.lineWidth].every(Number.isFinite) || layer.lineWidth <= 0) return false;
    const dx = layer.x2-layer.x1,dy = layer.y2-layer.y1;
    const length = Math.hypot(dx,dy);
    if(!Number.isFinite(length) || !length) return false;
    const ux = dx/length,uy = dy/length,nx = -uy,ny = ux;
    const angle = Math.atan2(dy,dx);
    // One filled silhouette prevents a round shaft cap from protruding beyond
    // the tip. Short arrows use a head that fits between their two endpoints.
    const headLength = Math.min(length,Math.max(12,layer.lineWidth*4)*Math.cos(Math.PI/6));
    const headHalfWidth = headLength*Math.tan(Math.PI/6);
    const neckX = layer.x2-ux*headLength,neckY = layer.y2-uy*headLength;
    const hasShaft = length > headLength;
    const shaftHalfWidth = layer.lineWidth/2;
    context.save();
    context.beginPath();
    if(hasShaft) context.moveTo(neckX+nx*shaftHalfWidth,neckY+ny*shaftHalfWidth);
    else context.moveTo(neckX+nx*headHalfWidth,neckY+ny*headHalfWidth);
    if(hasShaft) context.lineTo(neckX+nx*headHalfWidth,neckY+ny*headHalfWidth);
    context.lineTo(layer.x2,layer.y2);
    context.lineTo(neckX-nx*headHalfWidth,neckY-ny*headHalfWidth);
    if(hasShaft){
      context.lineTo(neckX-nx*shaftHalfWidth,neckY-ny*shaftHalfWidth);
      context.lineTo(layer.x1-nx*shaftHalfWidth,layer.y1-ny*shaftHalfWidth);
      context.arc(layer.x1,layer.y1,shaftHalfWidth,angle-Math.PI/2,angle+Math.PI/2,true);
    }
    context.closePath();
    if(layer.outline){
      context.strokeStyle = "#ffffff";
      context.lineWidth = SHAPE_OUTLINE_EXTRA;
      context.lineJoin = "miter";
      context.miterLimit = 4;
      context.stroke();
    }
    context.fillStyle = layer.color;
    context.fill();
    context.restore();
    return true;
  }

  function drawShape(context,layer){
    if(!["line","rect","ellipse"].includes(layer.type)) return false;
    context.save();
    if(layer.type === "line"){
      context.lineCap = "round";
      context.beginPath();
      context.moveTo(layer.x1,layer.y1);
      context.lineTo(layer.x2,layer.y2);
    }else if(layer.type === "ellipse"){
      context.beginPath();
      context.ellipse(layer.x+layer.w/2,layer.y+layer.h/2,Math.abs(layer.w/2),Math.abs(layer.h/2),0,0,Math.PI*2);
    }
    if(layer.type !== "line" && layer.fillNone === false){
      context.fillStyle = layer.fill || "#ffff00";
      if(layer.type === "rect") context.fillRect(layer.x,layer.y,layer.w,layer.h);
      else context.fill();
    }
    for(const outline of layer.outline ? [true,false] : [false]){
      context.strokeStyle = outline ? "#ffffff" : layer.color;
      context.lineWidth = layer.lineWidth+(outline ? SHAPE_OUTLINE_EXTRA : 0);
      if(layer.type === "rect") context.strokeRect(layer.x,layer.y,layer.w,layer.h);
      else context.stroke();
    }
    context.restore();
    return true;
  }

  function eligibleForField(layer,property){
    if(property === "opacity") return layer.type === "image";
    if(["text","fontSize","fontFamily","bold","textWidth","bgColor","bgTransparent"].includes(property)) return layer.type === "text";
    if(property === "outline") return ["text","arrow","line","rect","ellipse"].includes(layer.type);
    if(["fill","fillNone"].includes(property)) return ["rect","ellipse"].includes(layer.type);
    if(property === "color") return ["text","rect","ellipse","arrow","line","ink"].includes(layer.type);
    if(property === "lineWidth") return ["rect","ellipse","arrow","line"].includes(layer.type);
    if(property === "brushSize") return ["ink","blackoutBrush","mosaicBrush"].includes(layer.type);
    if(property === "mosaicSize") return ["mosaicRect","mosaicBrush"].includes(layer.type);
    return false;
  }

  const STYLE_DEFAULTS = Object.freeze({
    opacity:100,
    fontFamily:DEFAULT_FONT_FAMILY,bold:true,textWidth:300,bgColor:"#ffffff",bgTransparent:true,
    outline:false,fill:"#ffff00",fillNone:true
  });
  function valueForField(layer,property){
    return layer[property] ?? STYLE_DEFAULTS[property];
  }
  function commonFieldValue(layers,property){
    const eligible = layers.filter(layer => eligibleForField(layer,property));
    if(!eligible.length) return {eligible:[],mixed:false,value:undefined};
    const value = valueForField(eligible[0],property);
    return {eligible,mixed:eligible.some(layer => valueForField(layer,property) !== value),value};
  }

  return Object.freeze({TEXT_OUTLINE_WIDTH,SHAPE_OUTLINE_EXTRA,FONT_STACKS,DEFAULT_FONT_FAMILY,textTransform,transformTextPoint,safeFontFamily,fontStackFor,fontFor,wrapText,layoutText,editingTextBox,textCaretIndex,drawText,drawArrow,drawShape,eligibleForField,valueForField,commonFieldValue});
});
