(function(root,factory){
  const api=factory();
  if(typeof module === "object" && module.exports) module.exports=api;
  else root.AppBoxImageDrop=api;
})(typeof globalThis !== "undefined" ? globalThis : this,function(){
  "use strict";
  function hasFiles(transfer){
    return !!transfer && (Array.from(transfer.types||[]).includes("Files") ||
      Array.from(transfer.items||[]).some(item=>item.kind==="file") || !!transfer.files?.length);
  }
  function initialize({doc,win,area,getState,checkFile,prepare,onAdd,onOpen,notify,onOpenDialog,onClose}){
    const $=id=>doc.getElementById(id),dialog=$("imageDropDialog"),name=$("imageDropName");
    const add=$("imageDropAdd"),open=$("imageDropOpen"),cancel=$("imageDropCancel");
    if(!area||!dialog||!name||!add||!open||!cancel)return null;
    let pending=null,depth=0;
    function clearDrag(){depth=0;area.classList.remove("has-file-drag");}
    function available(){const state=getState();return state.loaded&&!state.blocked&&!pending;}
    function focusable(element){
      return element?.focus && element.isConnected!==false && !["BODY","HTML"].includes(element.tagName) &&
        !element.closest?.("[inert], [hidden], .hidden");
    }
    function close(restoreFocus=true){
      if(!pending)return;
      const previous=pending;pending=null;dialog.classList.add("hidden");
      if(!getState().modalOpen){
        for(const [element,inert] of previous.inert)element.inert=inert;
        doc.body.classList.remove("dialog-open");
        const target=focusable(previous.focus)?previous.focus:$("editCanvas");
        if(restoreFocus&&focusable(target))target.focus({preventScroll:true});
      }
      onClose?.();
    }
    function sync(){
      const state=getState();
      if(!available())clearDrag();
      if(pending&&(!state.loaded||state.context!==pending.context||state.modalOpen))close();
      add.disabled=open.disabled=!!state.blocked;
    }
    async function run(action,file){
      try{await action(file);}catch(error){notify(error?.message||"画像を読み込めませんでした。");}
    }
    async function choose(action){
      if(!pending)return;
      const state=getState();
      if(state.blocked||!state.loaded||state.context!==pending.context){sync();return;}
      const file=pending.file;
      close();
      await run(action,file);
    }
    // Filesだけを判定する。テキストやレイヤー一覧の内部ドラッグは妨げない。
    for(const type of ["dragover","drop"])doc.addEventListener(type,event=>{
      if(!hasFiles(event.dataTransfer))return;
      event.preventDefault();
      if(type==="drop")clearDrag();
    },true);
    area.addEventListener("dragenter",event=>{
      if(!hasFiles(event.dataTransfer))return;
      if(!getState().loaded)return;
      event.preventDefault();
      if(available()){depth++;area.classList.add("has-file-drag");}
    });
    area.addEventListener("dragover",event=>{
      if(!hasFiles(event.dataTransfer))return;
      if(!getState().loaded)return;
      event.preventDefault();
      const allowed=available();
      event.dataTransfer.dropEffect=allowed?"copy":"none";
      if(allowed)area.classList.add("has-file-drag");else clearDrag();
    });
    area.addEventListener("dragleave",()=>{if(--depth<=0)clearDrag();});
    area.addEventListener("drop",async event=>{
      if(!hasFiles(event.dataTransfer))return;
      event.preventDefault();clearDrag();
      // 読込み前は既存の開始画面、一括処理は既存のドロップ先へ渡す。
      const state=getState();if(!state.loaded)return;
      event.stopPropagation();
      if(pending)return;
      if(state.blocked){notify("操作が終わってから画像をドロップしてください。");return;}
      const files=Array.from(event.dataTransfer.files||[]);
      if(files.length!==1){notify("ファイルは1枚ずつドロップしてください。");return;}
      const file=files[0],kind=checkFile(file);if(!kind)return;
      if(kind==="project"){await run(onOpen,file);return;}
      prepare();
      const ready=getState();if(!ready.loaded||ready.blocked)return;
      const inert=[$("appMain"),...doc.querySelectorAll(".appbox-header")].map(element=>[element,!!element.inert]);
      pending={file,context:ready.context,focus:doc.activeElement,inert};
      name.textContent=file.name;
      dialog.classList.remove("hidden");doc.body.classList.add("dialog-open");
      for(const [element] of inert)element.inert=true;
      add.disabled=open.disabled=false;add.focus({preventScroll:true});
      onOpenDialog?.();
    });
    add.addEventListener("click",()=>choose(onAdd));
    open.addEventListener("click",()=>choose(onOpen));
    cancel.addEventListener("click",()=>close());
    dialog.addEventListener("click",event=>{if(event.target===dialog)close();});
    dialog.addEventListener("keydown",event=>{
      if(!pending||event.isComposing||event.keyCode===229)return;
      if(event.key==="Escape"){event.preventDefault();event.stopPropagation();close();return;}
      if(event.key!=="Tab")return;
      const buttons=[add,open,cancel].filter(button=>!button.disabled),first=buttons[0],last=buttons[buttons.length-1];
      if(!buttons.includes(doc.activeElement)){
        event.preventDefault();(event.shiftKey?last:first).focus({preventScroll:true});
      }else if(event.shiftKey&&doc.activeElement===first){event.preventDefault();last.focus({preventScroll:true});}
      else if(!event.shiftKey&&doc.activeElement===last){event.preventDefault();first.focus({preventScroll:true});}
    });
    doc.addEventListener("dragend",clearDrag);
    doc.addEventListener("visibilitychange",()=>{clearDrag();sync();});
    win.addEventListener("blur",clearDrag);
    sync();
    return {sync,cancel(){clearDrag();close();}};
  }
  return Object.freeze({initialize});
});
