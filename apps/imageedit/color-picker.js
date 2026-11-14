(function(root,factory){
  const api=factory();
  if(typeof module === "object" && module.exports) module.exports=api;
  else root.AppBoxImageColorPicker=api;
})(typeof globalThis !== "undefined" ? globalThis : this,function(){
  "use strict";
  const clamp=(value,min,max)=>Math.min(max,Math.max(min,value));
  function normalizeHex(value){
    const text=String(value).trim().replace(/^#/,"");
    if(/^[\da-f]{3}$/i.test(text)) return "#"+[...text.toLowerCase()].map(c=>c+c).join("");
    return /^[\da-f]{6}$/i.test(text) ? "#"+text.toLowerCase() : null;
  }
  const rgbHex=values=>"#"+values.map(value=>Math.round(clamp(value,0,255)).toString(16).padStart(2,"0")).join("");
  const hexRgb=hex=>[1,3,5].map(index=>parseInt(hex.slice(index,index+2),16));
  function hexToHsv(hex,previousHue=0){
    const [r,g,b]=hexRgb(hex).map(value=>value/255),max=Math.max(r,g,b),min=Math.min(r,g,b),delta=max-min;
    let h=previousHue;
    if(delta) h=((max === r ? (g-b)/delta : max === g ? (b-r)/delta+2 : (r-g)/delta+4)*60+360)%360;
    return {h,s:max ? delta/max : 0,v:max};
  }
  function hsvToHex({h,s,v}){
    const hue=((h%360)+360)%360/60,saturation=clamp(s,0,1),value=clamp(v,0,1);
    const c=value*saturation,x=c*(1-Math.abs(hue%2-1)),m=value-c;
    const parts=[[c,x,0],[x,c,0],[0,c,x],[0,x,c],[x,0,c],[c,0,x]][Math.floor(hue)];
    return rgbHex(parts.map(channel=>(channel+m)*255));
  }
  const BASE_COLORS=[
    ["赤","#d00000"],["朱色","#ef5b2a"],["橙","#f59e0b"],["黄","#facc15"],
    ["黄緑","#84cc16"],["緑","#16a34a"],["青緑","#0d9488"],["水色","#06b6d4"],
    ["青","#2563eb"],["藍","#4f46e5"],["紫","#9333ea"],["桃色","#db2777"]
  ];
  const PALETTE=Object.freeze([
    ...Array.from({length:12},(_,index)=>({name:index === 0 ? "黒" : index === 11 ? "白" : "グレー"+index,color:rgbHex(Array(3).fill(index*255/11))})),
    ...BASE_COLORS.map(([name,color])=>({name,color})),
    ...BASE_COLORS.map(([name,color])=>({name:"薄い"+name,color:rgbHex(hexRgb(color).map(value=>value+(255-value)*.6))})),
    ...BASE_COLORS.map(([name,color])=>({name:"濃い"+name,color:rgbHex(hexRgb(color).map(value=>value*.65))}))
  ].map(Object.freeze));
  const presetColors=new Set(PALETTE.map(item=>item.color));
  function updateRecent(recent,color){
    const normalized=normalizeHex(color);
    if(!normalized || presetColors.has(normalized)) return recent;
    return [normalized,...recent.filter(value=>value !== normalized)].slice(0,12);
  }

  function initialize({doc,win,fields,blocked,context,beforeOpen,preview,commit,cancel}){
    if(doc.getElementById("imageColorPickerPanel")) return null;
    const candidates=fields.filter(field=>field?.parentElement && /^[a-z][\w-]*$/i.test(field.id));
    if(!candidates.length) return null;
    let sheet;
    const rule=selector=>sheet.cssRules[sheet.insertRule(selector+" {}",sheet.cssRules.length)].style;
    let panelStyle,areaStyle,markerStyle,currentStyle,triggerStyles,recentStyles;
    try{
      const origin=new URL(doc.baseURI).origin;
      sheet=Array.from(doc.styleSheets).find(item=>item.href && new URL(item.href,doc.baseURI).origin === origin && new URL(item.href,doc.baseURI).pathname.endsWith("/image.css"));
      if(!sheet) return null;
      panelStyle=rule(".image-color-panel");areaStyle=rule(".image-color-area");markerStyle=rule(".image-color-marker");currentStyle=rule(".image-color-current");
      triggerStyles=candidates.map(field=>rule("#"+field.id+"Picker"));
      recentStyles=Array.from({length:12},(_,i)=>rule('.image-color-recent [data-slot="'+i+'"] .image-color-swatch-fill'));
      PALETTE.forEach((item,i)=>{rule('.image-color-presets [data-slot="'+i+'"] .image-color-swatch-fill').backgroundColor=item.color;});
    }catch(error){return null;} // Retain the native inputs if CSSOM is unavailable.
    const make=(tag,className,text)=>{
      const node=doc.createElement(tag);node.className=className||"";
      if(text !== undefined) node.textContent=text;return node;
    };
    const button=(className,text)=>{const node=make("button",className,text);node.type="button";return node;};
    const panel=make("div","image-color-panel");panel.id="imageColorPickerPanel";panel.hidden=true;
    panel.setAttribute("role","dialog");panel.setAttribute("aria-labelledby","imageColorPickerTitle");
    const heading=make("div","image-color-heading");
    const title=make("strong",null);title.id="imageColorPickerTitle";
    const mixed=make("span","image-color-mixed","複数の値");mixed.hidden=true;heading.append(title,mixed);
    const body=make("div","image-color-body");
    const area=make("div","image-color-area");
    const marker=make("span","image-color-marker");marker.setAttribute("aria-hidden","true");
    function range(name,min,max,step,className){
      const node=make("input",className);node.type="range";node.min=String(min);node.max=String(max);node.step=String(step);node.setAttribute("aria-label",name);return node;
    }
    // Native range controls expose both axes separately to keyboards and AT.
    const saturation=range("彩度（色の鮮やかさ）",0,100,.1,"image-color-axis visually-hidden");
    const brightness=range("明るさ",0,100,.1,"image-color-axis visually-hidden");
    const axisHint=make("span","image-color-axis-hint");axisHint.setAttribute("aria-hidden","true");
    function syncAxisHint(){
      const axis=doc.activeElement === saturation ? [saturation,"彩度"] : doc.activeElement === brightness ? [brightness,"明るさ"] : null;
      axisHint.textContent=axis ? axis[1]+" "+Math.round(Number(axis[0].value))+"%" : "";
    }
    for(const axis of [saturation,brightness]){axis.addEventListener("focus",syncAxisHint);axis.addEventListener("blur",syncAxisHint);}
    area.append(marker,saturation,brightness,axisHint);
    const hue=range("色相",0,359,.1,"image-color-hue");
    const canSample=()=>typeof win.EyeDropper === "function" && typeof win.AbortController === "function";
    const eyedropper=button("image-color-eyedropper");
    eyedropper.setAttribute("aria-label",canSample() ? "スポイトで画面の色を取得" : "スポイト（ブラウザーの色選択を開く）");
    eyedropper.title=eyedropper.getAttribute("aria-label");
    const icon=doc.createElementNS("http://www.w3.org/2000/svg","svg"),iconPath=doc.createElementNS("http://www.w3.org/2000/svg","path");
    icon.setAttribute("viewBox","0 0 24 24");icon.setAttribute("aria-hidden","true");icon.setAttribute("focusable","false");
    iconPath.setAttribute("d","m14 5 5 5m-7-3 5 5m-4-4-8 8-1 4 4-1 8-8m-1-5 3-3a2.12 2.12 0 0 1 3 3l-3 3");
    icon.appendChild(iconPath);eyedropper.appendChild(icon);
    const codeRow=make("div","image-color-code-row"),current=make("span","image-color-current");current.setAttribute("aria-hidden","true");
    const hex=make("input","image-color-hex");hex.type="text";hex.maxLength=7;hex.spellcheck=false;hex.setAttribute("aria-label","色コード（HEX）");hex.setAttribute("placeholder","#RRGGBB");
    codeRow.append(eyedropper,current,hex);
    const rgb=make("div","image-color-rgb");
    const channels=["R","G","B"].map(name=>{
      const label=make("label",null,name),input=make("input",null);input.type="number";input.min="0";input.max="255";input.step="1";
      input.setAttribute("aria-label",name+"（0〜255）");label.appendChild(input);rgb.appendChild(label);return input;
    });
    codeRow.appendChild(rgb);
    const palette=make("div","image-color-presets");palette.setAttribute("role","group");palette.setAttribute("aria-label","定番色48色。黒から白、代表色、薄い色、濃い色");
    function swatch(item,index){
      const node=button("image-color-swatch");node.dataset.slot=String(index);node.dataset.color=item.color;node.tabIndex=-1;
      node.setAttribute("aria-label",item.name+" "+item.color.toUpperCase());node.title=item.name+" "+item.color.toUpperCase();node.setAttribute("aria-pressed","false");
      const fill=make("span","image-color-swatch-fill");fill.setAttribute("aria-hidden","true");node.appendChild(fill);return node;
    }
    const swatches=PALETTE.map((item,i)=>{const node=swatch(item,i);palette.appendChild(node);return node;});
    const recentGroup=make("div","image-color-recent-group");recentGroup.hidden=true;
    const recentLabel=make("div","image-color-section-label","最近使った色"),recentList=make("div","image-color-recent");
    recentList.setAttribute("role","group");recentList.setAttribute("aria-label","最近使った自由色。ページを閉じるまで保持");
    recentGroup.append(recentLabel,recentList);
    const recentButtons=Array.from({length:12},(_,i)=>{const node=swatch({name:"最近使った色",color:"#000000"},i);node.hidden=true;recentList.appendChild(node);return node;});
    const status=make("div","image-color-status");status.hidden=true;status.setAttribute("role","status");
    const nativeFallback=button("image-color-fallback","ブラウザーの色選択を開く");nativeFallback.hidden=true;
    body.append(area,hue,codeRow,palette,recentGroup,status,nativeFallback);
    const footer=make("div","image-color-footer"),cancelButton=button("image-color-cancel","取消"),apply=button("image-color-apply","決定");
    footer.append(cancelButton,apply);
    panel.append(heading,body,footer);doc.body.appendChild(panel);
    const entries=candidates.map((field,index)=>{
      const trigger=button("image-color-trigger");trigger.id=field.id+"Picker";trigger.setAttribute("aria-haspopup","dialog");trigger.setAttribute("aria-expanded","false");trigger.setAttribute("aria-controls",panel.id);
      const label=doc.querySelector('label[for="'+field.id+'"]');
      if(label) label.htmlFor=trigger.id;
      field.parentElement.appendChild(trigger);
      // Keep a real layout anchor for the fallback browser picker, without a
      // second visible or keyboard-focusable control.
      field.classList.add("image-color-native-field");field.tabIndex=-1;field.setAttribute("aria-hidden","true");
      return {field,trigger,style:triggerStyles[index],label};
    });
    let session=null,gesture=null,rangeGesture=null,sampling=null,recent=[];
    const contains=target=>!!target && (panel.contains(target)||entries.some(entry=>entry.trigger.contains(target)||entry.field.parentElement.contains(target)));
    const unavailable=entry=>entry.field.disabled || blocked(entry.field) || !!entry.trigger.closest("[inert], [hidden], .hidden");
    const stale=()=>unavailable(session.entry)||context(session.entry.field) !== session.context || normalizeHex(session.entry.field.value) !== session.color;
    function reportError(message=""){
      status.textContent=message;status.hidden=!message;nativeFallback.hidden=!message;
      if(message){
        const bounds=panel.getBoundingClientRect(),overflow=bounds.bottom-(win.innerHeight-12);
        if(overflow>0)panelStyle.top=Math.max(12,bounds.top-overflow)+"px";
      }
    }
    function invalid(node,value){node.setAttribute("aria-invalid",String(value));}
    function sync(){
      if(session && stale()) close({cancel:true});
      entries.forEach(entry=>{
        const {field,trigger,style}=entry,color=normalizeHex(field.value)||"#000000",label=field.getAttribute("aria-label")||"色";
        const isMixed=field.dataset.mixed === "true";
        trigger.setAttribute("aria-label",label+"："+(isMixed ? "複数の値" : color.toUpperCase()));trigger.title=label+"："+(isMixed ? "複数の値" : color.toUpperCase());
        style.backgroundColor=color;trigger.dataset.mixed=String(isMixed);
        const disabled=unavailable(entry);if(trigger.disabled !== disabled) trigger.disabled=disabled;
      });
    }
    function render(keep=null){
      if(!session) return;
      const {color,hsv}=session;
      areaStyle.backgroundColor=hsvToHex({h:hsv.h,s:1,v:1});markerStyle.left=(hsv.s*100)+"%";markerStyle.top=((1-hsv.v)*100)+"%";currentStyle.backgroundColor=color;
      for(const [node,value] of [[saturation,hsv.s*100],[brightness,hsv.v*100],[hue,hsv.h]]){
        node.value=String(value);node.setAttribute("aria-valuetext",Math.round(value)+(node === hue ? "度" : "%"));
      }
      syncAxisHint();
      if(keep !== hex){hex.value=color.toUpperCase();invalid(hex,false);}
      hexRgb(color).forEach((value,i)=>{if(keep !== channels[i]){channels[i].value=String(value);invalid(channels[i],false);}});
      const showSelection=session.mixed !== "true" || session.touched;
      swatches.forEach(node=>node.setAttribute("aria-pressed",String(node.dataset.color === color && showSelection)));
      recentGroup.hidden=!recent.length;
      recentButtons.forEach((node,i)=>{
        node.hidden=i >= recent.length;
        if(node.hidden) return;
        node.dataset.color=recent[i];node.setAttribute("aria-label","最近使った色 "+recent[i].toUpperCase());node.title=recent[i].toUpperCase();
        recentStyles[i].backgroundColor=recent[i];node.setAttribute("aria-pressed",String(recent[i] === color && showSelection));
      });
    }
    function setColor(color,{hsv=null,keep=null}={}){
      if(!session || stale()) {if(session) close({cancel:true});return;}
      const normalized=normalizeHex(color);if(!normalized) return;
      session.color=normalized;session.hsv=hsv||hexToHsv(normalized,session.hsv.h);session.touched=true;
      reportError();
      session.entry.field.value=normalized;preview(session.entry.field,normalized);
      render(keep);sync();
    }
    function releaseGesture(){
      const activeGesture=gesture;gesture=null;rangeGesture=null;
      if(activeGesture && area.hasPointerCapture?.(activeGesture.id)) area.releasePointerCapture(activeGesture.id);
    }
    function close({cancel:revert=false,restoreFocus=panel.contains(doc.activeElement)}={}){
      if(!session) return;
      revert=revert||stale()||!session.touched;
      const currentSession=session;session=null;releaseGesture();panel.hidden=true;
      const pendingSample=sampling;sampling=null;pendingSample?.controller.abort();
      eyedropper.disabled=false;eyedropper.removeAttribute("aria-busy");
      reportError();
      currentSession.entry.trigger.setAttribute("aria-expanded","false");
      const {field}=currentSession.entry;
      if(revert){
        field.value=currentSession.original;
        if(currentSession.mixed === undefined)delete field.dataset.mixed;else field.dataset.mixed=currentSession.mixed;
        cancel(field);
      }
      else{
        commit(field,currentSession.color);
        if(currentSession.touched && (currentSession.color !== currentSession.original || currentSession.mixed === "true")) recent=updateRecent(recent,currentSession.color);
      }
      sync();if(restoreFocus && !unavailable(currentSession.entry)) currentSession.entry.trigger.focus({preventScroll:true});
    }
    function show(entry){
      if(unavailable(entry)) return;
      if(session?.entry === entry){close({restoreFocus:true});return;}
      close();beforeOpen();if(unavailable(entry)) return;
      const color=normalizeHex(entry.field.value)||"#000000";
      session={entry,context:context(entry.field),original:color,mixed:entry.field.dataset.mixed,color,hsv:hexToHsv(color),touched:false};
      reportError();
      title.textContent=entry.field.getAttribute("aria-label")||"色を選択";mixed.hidden=session.mixed !== "true";
      panel.hidden=false;entry.trigger.setAttribute("aria-expanded","true");render();
      const selected=Math.max(0,PALETTE.findIndex(item=>item.color === color));swatches.forEach((node,i)=>{node.tabIndex=i === selected ? 0 : -1;});
      const selectedRecent=Math.max(0,recent.indexOf(color));recentButtons.forEach((node,i)=>{node.tabIndex=i === selectedRecent ? 0 : -1;});
      const margin=12,gap=6;panelStyle.maxHeight=Math.max(0,win.innerHeight-margin*2)+"px";
      const anchor=entry.trigger.getBoundingClientRect(),size=panel.getBoundingClientRect(),maxX=Math.max(margin,win.innerWidth-size.width-margin),maxY=Math.max(margin,win.innerHeight-size.height-margin);
      panelStyle.left=Math.min(maxX,Math.max(margin,anchor.left))+"px";
      panelStyle.top=(anchor.bottom+gap+size.height+margin <= win.innerHeight ? anchor.bottom+gap
        : anchor.top-gap-size.height >= margin ? anchor.top-gap-size.height : maxY)+"px";
      saturation.focus({preventScroll:true});
    }
    entries.forEach(entry=>{
      entry.trigger.addEventListener("click",()=>show(entry));
      entry.trigger.addEventListener("keydown",event=>{
        event.stopPropagation();if(event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey) return;
        if(["ArrowDown","ArrowUp"].includes(event.key)){event.preventDefault();show(entry);}
      });
    });
    function changeHsv(){if(!session)return;const hsv={h:Number(hue.value),s:Number(saturation.value)/100,v:Number(brightness.value)/100};setColor(hsvToHex(hsv),{hsv});}
    function gestureSnapshot(){return {color:session.color,hsv:{...session.hsv},touched:session.touched};}
    function restoreGesture(old){
      if(!session)return;
      if(old.touched){setColor(old.color,{hsv:old.hsv});return;}
      // Before the first adjustment, a mixed selection has several originals;
      // assigning just its first color cannot restore that selection.
      session.color=old.color;session.hsv=old.hsv;session.touched=false;
      session.entry.field.value=old.color;
      if(session.mixed === undefined)delete session.entry.field.dataset.mixed;else session.entry.field.dataset.mixed=session.mixed;
      cancel(session.entry.field);render();sync();
    }
    for(const node of [saturation,brightness,hue]){
      node.addEventListener("input",changeHsv);
      node.addEventListener("pointerdown",event=>{
        if(!session || gesture || rangeGesture){event.preventDefault();return;}
        rangeGesture={node,id:event.pointerId,...gestureSnapshot()};
      });
      node.addEventListener("pointerup",event=>{if(rangeGesture?.node === node && rangeGesture.id === event.pointerId)rangeGesture=null;});
      node.addEventListener("pointercancel",event=>{if(rangeGesture?.node === node && rangeGesture.id === event.pointerId){const old=rangeGesture;rangeGesture=null;restoreGesture(old);}});
      node.addEventListener("lostpointercapture",()=>{if(rangeGesture?.node === node){const old=rangeGesture;rangeGesture=null;restoreGesture(old);}});
    }
    hex.addEventListener("input",()=>{const color=normalizeHex(hex.value);invalid(hex,!color);if(color)setColor(color,{keep:hex});});
    channels.forEach(node=>node.addEventListener("input",()=>{
      const values=channels.map(field=>field.value.trim() === "" ? NaN : Number(field.value));
      const valid=values.every(value=>Number.isInteger(value)&&value>=0&&value<=255);
      channels.forEach((field,i)=>invalid(field,!Number.isInteger(values[i])||values[i]<0||values[i]>255));
      if(valid)setColor(rgbHex(values),{keep:node});
    }));
    for(const node of [hex,...channels]) node.addEventListener("blur",()=>render());
    function point(event){
      if(!session)return;
      const rect=area.getBoundingClientRect();if(!rect.width || !rect.height)return;
      const hsv={h:session.hsv.h,s:clamp((event.clientX-rect.left)/rect.width,0,1),v:1-clamp((event.clientY-rect.top)/rect.height,0,1)};
      setColor(hsvToHex(hsv),{hsv});
    }
    area.addEventListener("pointerdown",event=>{
      if(event.target !== area && event.target !== marker || event.button !== 0 || gesture || rangeGesture || !session) return;
      event.preventDefault();gesture={id:event.pointerId,...gestureSnapshot()};
      area.setPointerCapture(event.pointerId);saturation.focus({preventScroll:true});point(event);
    });
    area.addEventListener("pointermove",event=>{if(gesture?.id === event.pointerId)point(event);});
    area.addEventListener("pointerup",event=>{if(gesture?.id === event.pointerId){point(event);releaseGesture();}});
    area.addEventListener("pointercancel",event=>{if(gesture?.id === event.pointerId){const old=gesture;releaseGesture();restoreGesture(old);}});
    area.addEventListener("lostpointercapture",()=>{if(gesture){const old=gesture;gesture=null;restoreGesture(old);}});
    function choose(node){if(!session)return;setColor(node.dataset.color);if(session)node.focus({preventScroll:true});}
    function bindSwatches(nodes,columns){
      nodes.forEach((node,i)=>{
        node.addEventListener("focus",()=>{nodes.forEach(item=>{item.tabIndex=item === node ? 0 : -1;});});
        node.addEventListener("click",()=>choose(node));
        node.addEventListener("keydown",event=>{
          if(event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey)return;
          if(!["ArrowLeft","ArrowRight","ArrowUp","ArrowDown","Home","End"].includes(event.key))return;
          event.preventDefault();const visible=nodes.filter(item=>!item.hidden),index=visible.indexOf(node),last=visible.length-1;
          const next=event.key === "Home" ? 0 : event.key === "End" ? last : clamp(index+({ArrowLeft:-1,ArrowRight:1,ArrowUp:-columns,ArrowDown:columns}[event.key]),0,last);
          visible.forEach((item,j)=>{item.tabIndex=j === next ? 0 : -1;});visible[next]?.focus({preventScroll:true});
        });
      });
    }
    bindSwatches(swatches,12);bindSwatches(recentButtons,12);
    cancelButton.addEventListener("click",()=>close({cancel:true,restoreFocus:true}));
    apply.addEventListener("click",()=>close({restoreFocus:true}));
    function openNativePicker(){
      if(!session)return;const {field,trigger,label}=session.entry;close({restoreFocus:true});
      try{if(typeof field.showPicker === "function")field.showPicker();else field.click();}
      catch(error){field.classList.remove("image-color-native-field");field.tabIndex=0;field.removeAttribute("aria-hidden");trigger.hidden=true;if(label)label.htmlFor=field.id;field.focus();field.click();}
    }
    nativeFallback.addEventListener("click",()=>{
      if(nativeFallback.hidden || !session || sampling)return;
      if(stale()){close({cancel:true});return;}
      // The browser picker needs a fresh user action, not the async error handler.
      openNativePicker();
    });
    eyedropper.addEventListener("click",async()=>{
      if(!session || sampling)return;
      if(stale()){close({cancel:true});return;}
      if(!canSample()){openNativePicker();return;}
      const operation={session,controller:new win.AbortController()};sampling=operation;
      eyedropper.disabled=true;eyedropper.setAttribute("aria-busy","true");reportError();
      try{
        // Start directly from the click: the browser requires user activation.
        const result=await new win.EyeDropper().open({signal:operation.controller.signal});
        if(sampling !== operation || session !== operation.session)return;
        const color=normalizeHex(result?.sRGBHex);
        if(!color)throw Error("Invalid sampled color");
        setColor(color);
      }catch(error){
        if(sampling === operation && session === operation.session && !stale() && error?.name !== "AbortError"){
          reportError("スポイトで色を取得できませんでした。再試行するか、ブラウザーの色選択を利用してください。");
        }
      }finally{
        if(sampling === operation){
          sampling=null;eyedropper.disabled=false;eyedropper.removeAttribute("aria-busy");
          if(session === operation.session){
            if(stale())close({cancel:true});else eyedropper.focus({preventScroll:true});
          }
        }
      }
    });
    panel.addEventListener("keydown",event=>{
      event.stopPropagation();if(event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey)return;
      if(event.key === "Escape"){event.preventDefault();close({cancel:true,restoreFocus:true});}
      else if(event.key === "Enter" && event.target.tagName !== "BUTTON"){event.preventDefault();close({restoreFocus:true});}
      else if(event.key === "Tab" && (event.shiftKey && event.target === saturation || !event.shiftKey && event.target === apply)) close({restoreFocus:true});
    });
    doc.addEventListener("pointerdown",event=>{if(session && !contains(event.target))close();},true);
    doc.addEventListener("focusin",event=>{if(session && !contains(event.target))close({restoreFocus:false});});
    win.addEventListener("blur",()=>close({cancel:true}));win.addEventListener("resize",()=>close());
    win.addEventListener("scroll",event=>{if(session && !panel.contains(event.target))close();},true);
    doc.addEventListener("visibilitychange",()=>{if(doc.hidden)close({cancel:true});});
    if(typeof win.MutationObserver === "function"){
      const observer=new win.MutationObserver(sync),observed=new Set();
      entries.forEach(entry=>{for(let node=entry.trigger;node;node=node.parentElement)if(!observed.has(node)){observer.observe(node,{attributes:true,attributeFilter:["inert","hidden","class","disabled"]});observed.add(node);}observer.observe(entry.field,{attributes:true,attributeFilter:["disabled"]});});
    }
    sync();return {sync,close,contains,get isOpen(){return !!session;}};
  }
  return {PALETTE,normalizeHex,hexToHsv,hsvToHex,updateRecent,initialize};
});
