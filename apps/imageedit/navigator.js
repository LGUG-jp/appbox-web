(function(root,factory){
  const api=factory();
  if(typeof module === "object" && module.exports) module.exports=api;
  else root.AppBoxImageNavigator=api;
})(typeof globalThis !== "undefined" ? globalThis : this,function(){
  "use strict";
  const clamp=(value,min,max)=>Math.min(max,Math.max(min,value));
  function geometry(state,width=320,height=200){
    if(![state.width,state.height,width,height].every(value=>Number.isFinite(value)&&value>0)||
      ![state.x,state.y,state.viewWidth,state.viewHeight].every(Number.isFinite)) return null;
    const scale=Math.min(width/state.width,height/state.height);
    const image={x:(width-state.width*scale)/2,y:(height-state.height*scale)/2,width:state.width*scale,height:state.height*scale,scale};
    const x=clamp(state.x,0,state.width),y=clamp(state.y,0,state.height);
    return {image,frame:{x:image.x+x*scale,y:image.y+y*scale,
      width:Math.max(0,Math.min(state.viewWidth,state.width-x))*scale,
      height:Math.max(0,Math.min(state.viewHeight,state.height-y))*scale}};
  }
  function pointAt(image,x,y,allowOutside=false){
    if(!Number.isFinite(x)||!Number.isFinite(y)||!image) return null;
    if(!allowOutside&&(x<image.x||y<image.y||x>image.x+image.width||y>image.y+image.height))return null;
    return {x:clamp(x-image.x,0,image.width)/image.scale,y:clamp(y-image.y,0,image.height)/image.scale};
  }
  const zoomAt=(position,min)=>min*Math.pow(4/min,clamp(position,0,1000)/1000);
  const zoomPosition=(zoom,min)=>clamp(Math.log(zoom/min)/Math.log(4/min)*1000,0,1000);

  function initialize({doc,win,getState,onPan,onZoom}){
    const $=id=>doc.getElementById(id),panel=$("imageNavigator"),surface=$("navigatorViewport"),canvas=$("navigatorPreview"),frame=$("navigatorFrame");
    if(!panel||!surface||!canvas||!frame) return null;
    let frameStyle;
    try{
      const origin=new URL(doc.baseURI).origin;
      const sheet=Array.from(doc.styleSheets).find(item=>item.href&&new URL(item.href,doc.baseURI).origin===origin&&new URL(item.href,doc.baseURI).pathname.endsWith("/image.css"));
      if(!sheet)return null;
      frameStyle=sheet.cssRules[sheet.insertRule("#navigatorFrame {}",sheet.cssRules.length)].style;
    }catch(error){return null;}
    const ctx=canvas.getContext("2d"),range=$("navigatorZoomRange"),value=$("navigatorZoomValue"),out=$("navigatorZoomOut"),inside=$("navigatorZoomIn");
    const contains=target=>!!target&&panel.contains(target);
    let dirty=true,pending=false,drag=null,deferredRestore=null;
    const hidden=()=>panel.hidden||!panel.open||!!panel.closest("[inert], [hidden], .hidden");
    function end(cancel=false){
      const previous=drag;drag=null;
      if(previous&&surface.hasPointerCapture?.(previous.id))surface.releasePointerCapture(previous.id);
      const state=getState();
      if(cancel&&previous&&state.loaded&&state.context===previous.context){
        // 非表示中は移動を実行せず、開始位置を保持して復帰通知で一度だけ戻す。
        if(doc.hidden)deferredRestore=previous;
        else if(!state.blocked)onPan(previous.center.x,previous.center.y);
      }
      surface.classList.remove("is-panning");
    }
    function sync(){
      if(pending)return;
      pending=true;
      win.requestAnimationFrame(()=>{pending=false;render();});
    }
    function render(){
      const state=getState();
      panel.hidden=!state.loaded;
      const unavailable=!state.loaded||!!state.blocked;
      if(drag&&(unavailable||hidden()||drag.context!==state.context))end(true);
      const controlsBlocked=unavailable||!!drag;
      for(const control of [range,value,out,inside])control.disabled=controlsBlocked;
      surface.setAttribute("aria-disabled",String(unavailable));surface.tabIndex=unavailable?-1:0;
      if(hidden())return;
      const layout=geometry(state,canvas.width,canvas.height);if(!layout)return;
      if(dirty){
        ctx.clearRect(0,0,canvas.width,canvas.height);
        const image=layout.image;
        ctx.fillStyle="#fff";ctx.fillRect(image.x,image.y,image.width,image.height);
        for(const source of state.sources)ctx.drawImage(source,0,0,state.width,state.height,image.x,image.y,image.width,image.height);
        dirty=false;
      }
      const f=layout.frame;
      frameStyle.left=f.x/canvas.width*100+"%";frameStyle.top=f.y/canvas.height*100+"%";
      frameStyle.width=f.width/canvas.width*100+"%";frameStyle.height=f.height/canvas.height*100+"%";
      range.value=String(zoomPosition(state.zoom,state.minZoom));range.setAttribute("aria-valuetext",Math.round(state.zoom*1000)/10+"%");
      if(doc.activeElement!==value)value.value=String(Math.round(state.zoom*1000)/10);
      out.disabled=controlsBlocked||state.zoom<=state.minZoom;inside.disabled=controlsBlocked||state.zoom>=4;
    }
    function imagePoint(event,allowOutside){
      const rect=surface.getBoundingClientRect();
      if(!rect.width||!rect.height)return null;
      const state=getState(),layout=geometry(state,canvas.width,canvas.height);
      return pointAt(layout?.image,(event.clientX-rect.left-surface.clientLeft)*canvas.width/surface.clientWidth,
        (event.clientY-rect.top-surface.clientTop)*canvas.height/surface.clientHeight,allowOutside);
    }
    surface.addEventListener("pointerdown",event=>{
      const state=getState();
      if(state.blocked||!state.loaded||hidden()||drag||event.button!==0||event.isPrimary===false)return;
      const point=imagePoint(event,false);if(!point)return;
      event.preventDefault();event.stopPropagation();surface.focus({preventScroll:true});
      const center={x:state.x+state.viewWidth/2,y:state.y+state.viewHeight/2};
      const within=point.x>=state.x&&point.y>=state.y&&point.x<=state.x+state.viewWidth&&point.y<=state.y+state.viewHeight;
      drag={id:event.pointerId,context:state.context,center,offset:within?{x:point.x-center.x,y:point.y-center.y}:{x:0,y:0}};
      surface.setPointerCapture(event.pointerId);surface.classList.add("is-panning");
      onPan(point.x-drag.offset.x,point.y-drag.offset.y);sync();
    });
    surface.addEventListener("pointermove",event=>{
      if(!drag||event.pointerId!==drag.id)return;
      const state=getState();
      if(state.blocked||hidden()||state.context!==drag.context){end(true);sync();return;}
      const point=imagePoint(event,true);if(!point)return;
      event.preventDefault();onPan(point.x-drag.offset.x,point.y-drag.offset.y);sync();
    });
    surface.addEventListener("pointerup",event=>{if(drag&&event.pointerId===drag.id){end(doc.hidden);sync();}});
    for(const type of ["pointercancel","lostpointercapture"])surface.addEventListener(type,event=>{if(drag&&event.pointerId===drag.id){end(true);sync();}});
    surface.addEventListener("keydown",event=>{
      if(event.target!==surface||event.isComposing||event.keyCode===229)return;
      if(event.key==="Escape"&&drag){event.preventDefault();event.stopPropagation();end(true);sync();return;}
      const direction={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[event.key];
      const state=getState();
      if(!direction||drag||event.altKey||event.ctrlKey||event.metaKey||state.blocked||!state.loaded||hidden())return;
      event.preventDefault();event.stopPropagation();
      const amount=event.shiftKey ? .5 : .1;
      onPan(state.x+state.viewWidth/2+direction[0]*state.viewWidth*amount,state.y+state.viewHeight/2+direction[1]*state.viewHeight*amount);sync();
    });
    range.addEventListener("input",()=>{const state=getState();if(!drag&&!state.blocked&&state.loaded){onZoom(zoomAt(Number(range.value),state.minZoom));sync();}});
    value.addEventListener("change",()=>{
      const state=getState(),number=Number(value.value);
      if(!drag&&!state.blocked&&state.loaded&&Number.isFinite(number)&&number>0)onZoom(number/100);
      value.value=String(Math.round(getState().zoom*1000)/10);sync();
    });
    for(const [button,factor] of [[out,1/1.25],[inside,1.25]])button.addEventListener("click",()=>{
      const state=getState();if(!drag&&!state.blocked&&state.loaded){onZoom(state.zoom*factor);sync();}
    });
    panel.addEventListener("toggle",()=>{
      if(!panel.open){end(true);if($("navigatorBody").contains(doc.activeElement))$("navigatorSummary").focus({preventScroll:true});}
      sync();
    });
    win.addEventListener("blur",()=>{end(true);sync();});
    doc.addEventListener("visibilitychange",()=>{
      if(doc.hidden)end(true);
      else if(deferredRestore){
        const previous=deferredRestore;deferredRestore=null;
        const state=getState();
        if(state.loaded&&state.context===previous.context&&!state.blocked)onPan(previous.center.x,previous.center.y);
      }
      sync();
    });
    sync();
    return {sync,invalidateImage(){dirty=true;sync();},contains,cancel(){end(true);sync();}};
  }
  return Object.freeze({geometry,pointAt,zoomAt,zoomPosition,initialize});
});
