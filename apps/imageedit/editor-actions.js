(function(root){
  "use strict";
  function initialize(api){
    const {$,state,editCanvas,canvasViewport,baseCanvas,toast} = api;
    const menu = $("objectMenu");
    if(menu) menu.hidden=true;
    let menuReturnFocus = null;
    let longPress = null;
    let suppressTouchEnd = null;
    let menuRule = null;
    const touchPointers = new Set();
    function closeMenu(restoreFocus=true){
      if(!menu || menu.hidden) return;
      menu.hidden=true;menu.classList.add("hidden");
      if(restoreFocus) (menuReturnFocus || editCanvas).focus({preventScroll:true});
    }
    function openMenu(event){
      if(!menu || state.singleBusy || state.composing || state.textEditing || !state.sourceFile) return;
      const layer = api.hitLayer(api.pointFromEvent(event));
      if(layer && !api.selectedLayers().some(item => item.id === layer.id)) api.selectLayers([layer]);
      api.setTool("select");
      api.updateSelectedControls();
      const selected = api.selectedLayers().length > 0;
      for(const id of ["menuCopy","menuDelete","menuFront","menuBack"]) $(id).disabled=!selected;
      $("menuPaste").disabled=!api.canPaste();
      menuReturnFocus=document.activeElement;
      menu.hidden=false;menu.classList.remove("hidden");
      if(!menuRule){
        const sheet=[...document.styleSheets].find(item => item.href &&
          new URL(item.href,document.baseURI).pathname.endsWith("/image.css"));
        if(sheet){const index=sheet.insertRule("#objectMenu {}",sheet.cssRules.length);menuRule=sheet.cssRules[index];}
      }
      if(menuRule){
        const bounds=menu.getBoundingClientRect();
        menuRule.style.left=`${Math.max(8,Math.min(event.clientX,window.innerWidth-bounds.width-8))}px`;
        menuRule.style.top=`${Math.max(8,Math.min(event.clientY,window.innerHeight-bounds.height-8))}px`;
        menuRule.style.right="auto";
      }
      const first = menu.querySelector("button:not(:disabled)");
      (first || menu).focus({preventScroll:true});
    }
    $("frontLayer")?.addEventListener("click",() => api.reorderSelectedLayers(true));
    $("backLayer")?.addEventListener("click",() => api.reorderSelectedLayers(false));
    if(menu){
      editCanvas.addEventListener("contextmenu",event => {
        if(state.singleBusy || !state.sourceFile || state.composing || state.textEditing) return;
        event.preventDefault();
        if(state.drag) api.cancelSelectionGesture();
        openMenu(event);
      });
      const bind = (id,callback) => $(id)?.addEventListener("click",() => {
        closeMenu();callback();
      });
      bind("menuCopy",() => {
        if(!api.copySelectedLayers()) return;
        // The menu has its own internal clipboard; where available, also make
        // a subsequent native Ctrl+V recognize this same object copy.
        const text = api.clipboardText();
        if(root.navigator?.clipboard?.writeText){
          root.navigator.clipboard.writeText(text).catch(() => {});
        }
        toast("オブジェクトをコピーしました。");
      });
      bind("menuPaste",() => api.pasteObjectClipboard());
      bind("menuDelete",() => api.deleteSelectedLayer());
      bind("menuFront",() => api.reorderSelectedLayers(true));
      bind("menuBack",() => api.reorderSelectedLayers(false));
      document.addEventListener("pointerdown",event => {
        if(!menu.hidden && !menu.contains(event.target)) closeMenu(false);
      },true);
      menu.addEventListener("keydown",event => {
        if(event.isComposing || state.composing || event.keyCode === 229) return;
        if(event.key === "Escape"){event.preventDefault();event.stopPropagation();closeMenu();return;}
        if(!["ArrowDown","ArrowUp","Home","End","Tab"].includes(event.key)) return;
        const buttons=[...menu.querySelectorAll("button:not(:disabled)")];
        if(!buttons.length) return;
        const current=buttons.indexOf(document.activeElement);
        let next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length-1
          : (current+(event.key === "ArrowUp" || (event.key === "Tab" && event.shiftKey) ? -1 : 1)+buttons.length)%buttons.length;
        event.preventDefault();event.stopPropagation();buttons[next].focus();
      });
      function cancelLongPress(){
        if(longPress) clearTimeout(longPress.timer);
        longPress=null;
      }
      canvasViewport.addEventListener("pointerdown",event => {
        cancelLongPress();
        if(event.pointerType === "touch") touchPointers.add(event.pointerId);
        if(event.pointerType !== "touch" || state.tool !== "select" || state.singleBusy ||
          state.composing || state.textEditing || !state.sourceFile || event.target !== editCanvas || touchPointers.size > 1) return;
        const start = {id:event.pointerId,x:event.clientX,y:event.clientY,event};
        start.timer=setTimeout(() => {
          if(longPress !== start) return;
          api.cancelSelectionGesture();
          suppressTouchEnd=start.id;
          openMenu(start.event);
          longPress=null;
        },600);
        longPress=start;
      },true);
      canvasViewport.addEventListener("pointermove",event => {
        if(longPress && (event.pointerId !== longPress.id ||
          Math.hypot(event.clientX-longPress.x,event.clientY-longPress.y)>6)) cancelLongPress();
        if(suppressTouchEnd === event.pointerId){event.preventDefault();event.stopPropagation();}
      },true);
      for(const type of ["pointerup","pointercancel","lostpointercapture"]){
        canvasViewport.addEventListener(type,event => {
          cancelLongPress();
          touchPointers.delete(event.pointerId);
          if(suppressTouchEnd !== event.pointerId) return;
          suppressTouchEnd=null;event.preventDefault();event.stopPropagation();
          if(editCanvas.hasPointerCapture(event.pointerId)) editCanvas.releasePointerCapture(event.pointerId);
        },true);
      }
      window.addEventListener("blur",() => {touchPointers.clear();cancelLongPress();closeMenu(false);});
    }

    const stamp = root.AppBoxImageStamp;
    const dialog = $("stampDialog");
    if(!stamp || !dialog) return;
    let returnFocus = null;
    let templates = [];
    let extra = {justify:true,dividers:false};
    function populatePresets(selected="custom"){
      const select = $("stampPreset");
      select.replaceChildren();
      function option(value,label){
        const item=document.createElement("option");item.value=value;item.textContent=label;select.appendChild(item);
      }
      stamp.PRESETS.forEach((item,index) => option(`preset:${index}`,item.name));
      templates.forEach((item,index) => option(`template:${index}`,`保存した設定：${item.name}`));
      option("custom","自由に作成");select.value=selected;
    }
    function readSettings(){
      return stamp.normalize({name:$("stampName").value,shape:$("stampShape").value,
        width:Number($("stampWidth").value),height:Number($("stampHeight").value),
        lines:$("stampText").value.replace(/\r\n/g,"\n").split("\n"),dateFormat:$("stampDateFormat").value,
        color:$("stampColor").value,borderWidth:Number($("stampBorder").value),fill:$("stampFill").value,...extra});
    }
    function updatePreview(){
      try{
        const settings=readSettings();
        const canvas=$("stampPreviewCanvas");
        if(canvas) stamp.render(canvas,settings);
        $("stampApply").disabled=false;
        if($("stampStatus")) $("stampStatus").textContent="";
      }catch(error){
        $("stampApply").disabled=true;
        const canvas=$("stampPreviewCanvas");
        if(canvas) canvas.getContext("2d").clearRect(0,0,canvas.width,canvas.height);
        if($("stampStatus")) $("stampStatus").textContent=error.message;
      }
    }
    function applySettings(raw){
      const settings=stamp.normalize(raw);
      $("stampName").value=settings.name;$("stampShape").value=settings.shape;
      $("stampWidth").value=settings.width;$("stampHeight").value=settings.height;
      $("stampText").value=settings.lines.join("\n");$("stampDateFormat").value=settings.dateFormat;
      $("stampColor").value=settings.color;$("stampBorder").value=settings.borderWidth;
      $("stampFill").value=settings.fill;
      extra={justify:settings.justify,dividers:settings.dividers};updatePreview();
    }
    function openStamp(){
      if(!state.sourceFile || state.singleBusy || state.drag || state.composing) return;
      closeMenu(false);returnFocus=document.activeElement;
      dialog.classList.remove("hidden");$("appMain").inert=true;
      document.querySelectorAll(".appbox-header").forEach(element => {element.inert=true;});
      document.body.classList.add("dialog-open");updatePreview();$("closeStamp").focus();
    }
    function closeStamp(){
      if(dialog.classList.contains("hidden")) return;
      dialog.classList.add("hidden");
      if($("saveDialog").classList.contains("hidden") && $("previewDialog").classList.contains("hidden")){
        $("appMain").inert=false;document.body.classList.remove("dialog-open");
        document.querySelectorAll(".appbox-header").forEach(element => {element.inert=false;});
      }
      (returnFocus || editCanvas).focus({preventScroll:true});
    }
    $("openStamp")?.addEventListener("click",openStamp);
    $("closeStamp").addEventListener("click",closeStamp);
    dialog.addEventListener("click",event => {if(event.target === dialog) closeStamp();});
    dialog.addEventListener("keydown",event => {
      if(event.isComposing || state.composing || event.keyCode === 229) return;
      if(event.key === "Escape"){event.preventDefault();closeStamp();return;}
      if(event.key !== "Tab") return;
      const focusable=[...dialog.querySelectorAll("button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[tabindex]:not([tabindex='-1'])")]
        .filter(element => element.type !== "hidden" && !element.hidden && !element.closest(".hidden") &&
          (!element.closest("details:not([open])") || element.tagName === "SUMMARY"));
      if(!focusable.length) return;
      const current=focusable.indexOf(document.activeElement);
      if(current < 0 || (event.shiftKey && current === 0) || (!event.shiftKey && current === focusable.length-1)){
        event.preventDefault();focusable[event.shiftKey ? focusable.length-1 : 0].focus();
      }
    });
    $("stampPreset").addEventListener("change",() => {
      const [kind,index]=$("stampPreset").value.split(":");
      const settings=kind === "preset" ? stamp.PRESETS[Number(index)] : kind === "template" ? templates[Number(index)] : null;
      if(settings) applySettings(settings);
    });
    for(const id of ["stampShape","stampWidth","stampHeight","stampText","stampDateFormat","stampColor","stampBorder","stampFill","stampName"]){
      $(id).addEventListener("input",updatePreview);$(id).addEventListener("change",updatePreview);
    }
    $("stampApply").addEventListener("click",() => {
      if(state.singleBusy || state.drag || !state.sourceFile) return;
      try{
        const settings=readSettings();
        const imageCanvas=api.createCanvas(settings.width,settings.height);stamp.render(imageCanvas,settings);
        const ratio=Math.min(1,baseCanvas.width/settings.width,baseCanvas.height/settings.height);
        const w=Math.max(1,settings.width*ratio),h=Math.max(1,settings.height*ratio);
        const layer={id:api.makeId(),type:"image",imageCanvas,x:(baseCanvas.width-w)/2,y:(baseCanvas.height-h)/2,
          w,h,opacity:100,visible:true,name:`スタンプ：${settings.name || settings.lines[0]}`};
        closeStamp();api.pushHistory("layers");state.layers.push(layer);api.selectLayers([layer]);
        api.setTool("select");api.updateSelectedControls();editCanvas.focus({preventScroll:true});
      }catch(error){toast(error.message);}
    });
    $("stampSaveTemplate").addEventListener("click",() => {
      try{
        const settings=readSettings();
        if(!settings.name) throw new Error("テンプレート名を入力してください。");
        const merged=stamp.merge(templates,[settings]);
        const source=stamp.serialize(merged);
        api.saveBlob(new Blob([source],{type:"application/json"}),"imageedit-stamp-templates.json");
        templates=merged;populatePresets(`template:${templates.findIndex(item => item.name === settings.name)}`);
        toast("スタンプ設定をテンプレートファイルへ保存しました。");
      }catch(error){toast(error.message);}
    });
    $("stampLoadTemplate").addEventListener("click",() => {$("stampTemplateInput").value="";$("stampTemplateInput").click();});
    $("stampTemplateInput").addEventListener("change",async () => {
      const file=$("stampTemplateInput").files?.[0];if(!file) return;
      try{
        if(file.size > stamp.MAX_FILE_BYTES) throw new Error("テンプレートファイルは200KB以下にしてください。");
        const loaded=stamp.parse(await file.text());templates=stamp.merge(templates,loaded);
        const index=loaded.length ? templates.findIndex(item => item.name === loaded[0].name) : -1;
        populatePresets(index >= 0 ? `template:${index}` : "custom");
        if(index >= 0) applySettings(templates[index]);
        toast(`${loaded.length}件のスタンプ設定を読み込みました。`);
      }catch(error){toast(error.message);}
    });
    populatePresets("preset:0");applySettings(stamp.PRESETS[0]);
  }
  root.AppBoxImageActions = {initialize};
})(typeof globalThis === "object" ? globalThis : this);
