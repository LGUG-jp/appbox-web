(function(root,factory){
  const api=factory();
  if(typeof module === "object" && module.exports) module.exports=api;
  else root.AppBoxImageFontPicker=api;
})(typeof globalThis !== "undefined" ? globalThis : this,function(){
  "use strict";

  function initialize({doc,win,field,keys,blocked,context,beforeOpen,preview,commit,cancel}){
    if(!field?.parentElement || doc.getElementById("fontFamilyPicker")) return null;
    const allowed=new Set(keys);
    const fonts=Array.from(field.options).filter(option=>!option.disabled && allowed.has(option.value));
    if(!fonts.length) return null;
    // Geometry belongs to the existing same-origin stylesheet, not style attributes.
    let rule;
    try{
      const origin=new URL(doc.baseURI).origin;
      const sheet=Array.from(doc.styleSheets).find(item=>item.href &&
        new URL(item.href,doc.baseURI).origin === origin && new URL(item.href,doc.baseURI).pathname.endsWith("/image.css"));
      if(!sheet) return null;
      rule=sheet.cssRules[sheet.insertRule(".image-font-picker-panel {}",sheet.cssRules.length)];
    }catch(error){return null;} // Keep the native select if enhancement cannot start.

    const container=field.parentElement;
    const trigger=doc.createElement("button");
    trigger.id="fontFamilyPicker";trigger.type="button";trigger.className="image-font-trigger";
    trigger.setAttribute("aria-haspopup","dialog");trigger.setAttribute("aria-expanded","false");
    trigger.setAttribute("aria-controls","imageFontPickerPanel");
    const triggerName=doc.createElement("span");triggerName.className="image-font-trigger-name";trigger.appendChild(triggerName);
    const panel=doc.createElement("div");
    panel.id="imageFontPickerPanel";panel.className="image-font-picker-panel";panel.hidden=true;
    panel.setAttribute("role","dialog");panel.setAttribute("aria-labelledby","imageFontPickerTitle");
    panel.setAttribute("aria-describedby","imageFontPickerNote");
    const heading=doc.createElement("div");heading.className="image-font-picker-heading";
    const title=doc.createElement("strong");title.id="imageFontPickerTitle";title.textContent="フォントを選択";
    const dismiss=doc.createElement("button");dismiss.type="button";dismiss.className="image-font-dismiss";
    dismiss.textContent="×";dismiss.setAttribute("aria-label","フォント一覧を閉じる");
    heading.append(title,dismiss);
    const list=doc.createElement("div");list.className="image-font-options";
    list.setAttribute("role","group");list.setAttribute("aria-label","書体の見本");
    const rows=fonts.map(font=>{
      const row=doc.createElement("button");row.type="button";row.className="image-font-option";row.tabIndex=-1;
      row.setAttribute("aria-label",font.textContent);row.setAttribute("aria-pressed","false");
      const name=doc.createElement("span");name.className="image-font-name";name.textContent=font.textContent;name.dataset.font=font.value;
      const check=doc.createElement("span");check.className="image-font-check";check.textContent="✓";check.setAttribute("aria-hidden","true");
      row.append(name,check);list.appendChild(row);return row;
    });
    const note=doc.createElement("p");note.id="imageFontPickerNote";note.className="image-font-picker-note";
    note.textContent="PCにない書体は代替フォントで表示されます。";
    panel.append(heading,list,note);doc.body.appendChild(panel);container.appendChild(trigger);
    field.hidden=true;
    const label=doc.getElementById("fontFamilyLabel");if(label) label.htmlFor=trigger.id;
    let open=false,active=-1,snapshot=null,search="",searchAt=0;
    const contains=target=>!!target && (container.contains(target)||panel.contains(target));
    const unavailable=()=>field.disabled || blocked() || !!trigger.closest("[inert], [hidden], .hidden");
    const stale=()=>unavailable() || context() !== snapshot.context || field.value !== snapshot.value || field.dataset.mixed !== snapshot.mixed;
    function sync(){
      if(open && stale()) close();
      const font=fonts.find(option=>option.value === field.value);
      const label=font?.textContent || "複数の値";
      triggerName.textContent=label;trigger.setAttribute("aria-label","フォント："+label);
      const disabled=unavailable();if(trigger.disabled !== disabled) trigger.disabled=disabled;
      rows.forEach((row,index)=>{
        const selected=fonts[index].value === field.value;
        row.classList.toggle("is-selected",selected);row.setAttribute("aria-pressed",String(selected));
      });
    }
    function close({restoreFocus=panel.contains(doc.activeElement),chosen=null}={}){
      if(!open) return;
      open=false;active=-1;snapshot=null;search="";
      panel.hidden=true;trigger.setAttribute("aria-expanded","false");
      rows.forEach(row=>{row.classList.remove("is-active");row.tabIndex=-1;});
      if(chosen !== null) commit(chosen);else cancel();
      sync();
      if(restoreFocus && !unavailable()) trigger.focus({preventScroll:true});
    }
    function activate(index,focus=true){
      if(!open) return;
      if(stale()){close();return;}
      const changed=active !== index;active=index;
      rows.forEach((row,i)=>{row.classList.toggle("is-active",i === index);row.tabIndex=i === index ? 0 : -1;});
      if(changed) preview(fonts[index].value);
      if(focus && doc.activeElement !== rows[index]) rows[index].focus({preventScroll:true});
      const item=rows[index].getBoundingClientRect(),box=list.getBoundingClientRect();
      if(item.top < box.top) list.scrollTop-=box.top-item.top;
      else if(item.bottom > box.bottom) list.scrollTop+=item.bottom-box.bottom;
    }
    function show(){
      if(unavailable()) return;
      beforeOpen();
      if(unavailable()) return;
      snapshot={context:context(),value:field.value,mixed:field.dataset.mixed};
      open=true;panel.hidden=false;trigger.setAttribute("aria-expanded","true");
      const margin=12,gap=6;
      rule.style.maxHeight=Math.max(0,Math.min(420,win.innerHeight-margin*2))+"px";
      const anchor=trigger.getBoundingClientRect(),size=panel.getBoundingClientRect();
      const maxX=Math.max(margin,win.innerWidth-size.width-margin);
      const maxY=Math.max(margin,win.innerHeight-size.height-margin);
      const above=anchor.top-gap-size.height;
      const y=anchor.bottom+gap+size.height+margin <= win.innerHeight ? anchor.bottom+gap
        : above >= margin ? above : Math.min(maxY,Math.max(margin,anchor.bottom+gap));
      rule.style.left=Math.min(maxX,Math.max(margin,anchor.left))+"px";
      rule.style.top=y+"px";
      activate(Math.max(0,fonts.findIndex(font=>font.value === field.value)));
    }
    function choose(index){
      if(open && !stale() && fonts[index]) close({chosen:fonts[index].value,restoreFocus:true});
      else close();
    }
    trigger.addEventListener("click",()=>{if(open) close({restoreFocus:true});else show();});
    trigger.addEventListener("keydown",event=>{
      event.stopPropagation();
      if(event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey) return;
      if(["ArrowDown","ArrowUp","Enter"," "].includes(event.key)){event.preventDefault();if(!open) show();}
    });
    rows.forEach((row,index)=>{
      row.addEventListener("focus",()=>{if(open && active !== index) activate(index,false);});
      row.addEventListener("pointerenter",event=>{if(event.pointerType !== "touch") activate(index);});
      row.addEventListener("click",()=>choose(index));
    });
    dismiss.addEventListener("click",()=>close({restoreFocus:true}));
    panel.addEventListener("keydown",event=>{
      event.stopPropagation();
      if(event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey) return;
      if(event.key === "Escape"){event.preventDefault();close({restoreFocus:true});return;}
      if(event.key === "Tab"){close({restoreFocus:true});return;}
      // Leave native Enter/Space activation on the close button intact.
      if(event.target === dismiss) return;
      if(["ArrowDown","ArrowUp","Home","End"].includes(event.key)){
        event.preventDefault();search="";
        const index=event.key === "Home" ? 0 : event.key === "End" ? fonts.length-1
          : Math.max(0,Math.min(fonts.length-1,active+(event.key === "ArrowDown" ? 1 : -1)));
        activate(index);
      }else if(event.key === "Enter" || event.key === " "){
        event.preventDefault();choose(active);
      }else if(event.key.length === 1){
        event.preventDefault();const now=Date.now(),key=event.key.toLocaleLowerCase();
        search=now-searchAt > 700 || search === key ? key : search+key;searchAt=now;
        const index=fonts.findIndex((font,i)=>i > active && font.textContent.toLocaleLowerCase().startsWith(search));
        const fallback=fonts.findIndex(font=>font.textContent.toLocaleLowerCase().startsWith(search));
        if(index >= 0 || fallback >= 0) activate(index >= 0 ? index : fallback);
      }
    });
    doc.addEventListener("pointerdown",event=>{if(open && !contains(event.target)) close();},true);
    doc.addEventListener("focusin",event=>{if(open && !contains(event.target)) close();});
    win.addEventListener("blur",()=>close());
    win.addEventListener("resize",()=>close({restoreFocus:panel.contains(doc.activeElement)}));
    win.addEventListener("scroll",event=>{if(open && !panel.contains(event.target)) close({restoreFocus:panel.contains(doc.activeElement)});},true);
    doc.addEventListener("visibilitychange",()=>{if(doc.hidden) close();});
    if(typeof win.MutationObserver === "function"){
      const observer=new win.MutationObserver(sync);
      for(let node=trigger;node;node=node.parentElement) observer.observe(node,{attributes:true,attributeFilter:["inert","hidden","class","disabled"]});
      observer.observe(field,{attributes:true,attributeFilter:["disabled"]});
    }
    sync();
    return {sync,close,contains,get isOpen(){return open;}};
  }
  return {initialize};
});
