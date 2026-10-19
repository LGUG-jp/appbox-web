/* Geometry adapted from AppBox PDF editor editor-core.mjs and ink.mjs (MIT).
 * Image annotations always use original image pixels, independent of view zoom. */
(function(root,factory){
  const api = factory();
  if(typeof module === "object" && module.exports) module.exports = api;
  else root.AppBoxImageDrawing = api;
})(typeof globalThis !== "undefined" ? globalThis : this,function(){
  "use strict";

  const MAX_STROKE_POINTS = 8192;
  const MAX_IMAGE_INK_POINTS = 200000;
  const isLine = layer => layer.type === "line" || layer.type === "arrow";
  const clamp = (n,min,max) => Math.min(max,Math.max(min,n));

  function drawingBox(start,point,size,constrained=false){
    if(!constrained) return {x:Math.min(start.x,point.x),y:Math.min(start.y,point.y),
      w:Math.abs(point.x-start.x),h:Math.abs(point.y-start.y)};
    const dx = point.x-start.x,dy = point.y-start.y;
    const signX = dx < 0 ? -1 : 1,signY = dy < 0 ? -1 : 1;
    const side = Math.max(0,Math.min(Math.max(Math.abs(dx),Math.abs(dy)),
      signX < 0 ? start.x : size.width-start.x,
      signY < 0 ? start.y : size.height-start.y));
    return {x:Math.min(start.x,start.x+signX*side),y:Math.min(start.y,start.y+signY*side),w:side,h:side};
  }

  function constrainedLinePoint(anchor,point,constrained=false){
    if(!constrained) return {x:point.x,y:point.y};
    return Math.abs(point.x-anchor.x) >= Math.abs(point.y-anchor.y)
      ? {x:point.x,y:anchor.y} : {x:anchor.x,y:point.y};
  }

  function angleLockedLinePoint(anchor,originalPoint,point,size){
    const dx = originalPoint.x-anchor.x,dy = originalPoint.y-anchor.y;
    const squared = dx*dx+dy*dy;
    if(!squared) return {x:point.x,y:point.y};
    let min = 0,max = Infinity;
    if(size){
      for(const [origin,delta,limit] of [[anchor.x,dx,size.width],[anchor.y,dy,size.height]]){
        if(!delta){
          if(origin < 0 || origin > limit) return {x:originalPoint.x,y:originalPoint.y};
          continue;
        }
        const first=-origin/delta,second=(limit-origin)/delta;
        min=Math.max(min,Math.min(first,second));
        max=Math.min(max,Math.max(first,second));
      }
      // Cropping can leave the fixed endpoint outside the image. Constrain the
      // editable endpoint to the visible part of the same ray in that case.
      if(max < min) return {x:originalPoint.x,y:originalPoint.y};
    }
    const scale = clamp(((point.x-anchor.x)*dx+(point.y-anchor.y)*dy)/squared,min,max);
    return {x:anchor.x+dx*scale,y:anchor.y+dy*scale};
  }

  function resizeBox(original,dx,dy,size,constrained=false,min=2){
    const maxW = Math.max(0,size.width-original.x),maxH = Math.max(0,size.height-original.y);
    if(!constrained || original.w <= 0 || original.h <= 0){
      return {w:Math.min(maxW,Math.max(min,original.w+dx)),h:Math.min(maxH,Math.max(min,original.h+dy))};
    }
    const sx = (original.w+dx)/original.w,sy = (original.h+dy)/original.h;
    const desired = Math.abs(sx-1) >= Math.abs(sy-1) ? sx : sy;
    const scale = Math.min(maxW/original.w,maxH/original.h,Math.max(min/original.w,min/original.h,desired));
    return {w:original.w*scale,h:original.h*scale};
  }

  function inkBounds(points){
    if(!points?.length) return {x:0,y:0,w:0,h:0};
    let x=Infinity,y=Infinity,right=-Infinity,bottom=-Infinity;
    for(const p of points){x=Math.min(x,p.x);y=Math.min(y,p.y);right=Math.max(right,p.x);bottom=Math.max(bottom,p.y);}
    return {x,y,w:right-x,h:bottom-y};
  }

  function appendInkPoint(points,point,limit=MAX_STROKE_POINTS){
    if(!Number.isFinite(point.x) || !Number.isFinite(point.y) || points.length >= limit) return false;
    const last = points[points.length-1];
    if(last && Math.hypot(last.x-point.x,last.y-point.y) < .25) return false;
    points.push({x:point.x,y:point.y});
    return true;
  }

  function stabilizeInkPoint(previous,point,level="none"){
    const radius = {weak:1.5,medium:3,strong:6}[level] || 0;
    if(!previous || !radius) return {x:point.x,y:point.y};
    const dx=point.x-previous.x,dy=point.y-previous.y,distance=Math.hypot(dx,dy);
    if(distance <= radius) return {x:previous.x,y:previous.y};
    const follow = (distance-radius)/distance;
    return {x:previous.x+dx*follow,y:previous.y+dy*follow};
  }

  function pointSegmentDistance(point,a,b){
    const dx=b.x-a.x,dy=b.y-a.y,squared=dx*dx+dy*dy;
    const t = squared ? clamp(((point.x-a.x)*dx+(point.y-a.y)*dy)/squared,0,1) : 0;
    return Math.hypot(point.x-a.x-t*dx,point.y-a.y-t*dy);
  }

  function segmentsDistance(a,b,c,d){
    const cross = (p,q,r) => (q.x-p.x)*(r.y-p.y)-(q.y-p.y)*(r.x-p.x);
    const abC=cross(a,b,c),abD=cross(a,b,d),cdA=cross(c,d,a),cdB=cross(c,d,b);
    if(((abC<0 && abD>0)||(abC>0 && abD<0)) && ((cdA<0 && cdB>0)||(cdA>0 && cdB<0))) return 0;
    return Math.min(pointSegmentDistance(a,c,d),pointSegmentDistance(b,c,d),pointSegmentDistance(c,a,b),pointSegmentDistance(d,a,b));
  }

  function inkIntersectsSegment(stroke,from,to,radius){
    if(!stroke.points?.length) return false;
    const box=inkBounds(stroke.points),reach=radius+stroke.brushSize/2;
    if(Math.max(from.x,to.x)+reach < box.x || Math.min(from.x,to.x)-reach > box.x+box.w ||
      Math.max(from.y,to.y)+reach < box.y || Math.min(from.y,to.y)-reach > box.y+box.h) return false;
    if(stroke.points.length === 1) return pointSegmentDistance(stroke.points[0],from,to) <= reach;
    for(let i=1;i<stroke.points.length;i++){
      if(segmentsDistance(from,to,stroke.points[i-1],stroke.points[i]) <= reach) return true;
    }
    return false;
  }

  function imageInkPointCount(layers){
    return layers.reduce((count,layer) => count+(layer.type === "ink" ? layer.points.length : 0),0);
  }

  return {MAX_STROKE_POINTS,MAX_IMAGE_INK_POINTS,isLine,drawingBox,constrainedLinePoint,angleLockedLinePoint,
    resizeBox,inkBounds,appendInkPoint,stabilizeInkPoint,pointSegmentDistance,inkIntersectsSegment,imageInkPointCount};
});
