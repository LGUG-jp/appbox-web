/* 左ツール欄専用：初回待機と連続表示を分離する。編集データは操作しない。 */
(function(root){
  "use strict";
  function createTooltipState({show,hide,setTimeout,clearTimeout},initialDelay=600,nextDelay=80){
    let current=null,timer=null,warmed=false;
    const cancel=()=>{if(timer!==null)clearTimeout(timer);timer=null;};
    function enter(button){
      cancel();hide();current=button;
      timer=setTimeout(()=>{
        timer=null;
        if(current!==button)return;
        warmed=true;
        show(button);
      },warmed?nextDelay:initialDelay);
    }
    function dismiss(){
      cancel();current=null;hide();
    }
    function leave(button){
      if(current===button)dismiss();
    }
    function focus(button){
      cancel();current=button;show(button);
    }
    function reset(){
      dismiss();warmed=false;
    }
    return {enter,leave,focus,dismiss,reset};
  }
  function initTooltips(win,doc){
    const sidebar=doc.querySelector("#singleWorkspace .editor-sidebar");
    const toolbar=sidebar?.querySelector(".editor-toolbar");
    if(!sidebar||!toolbar)return null;
    const unavailable=()=>doc.hidden||!!toolbar.closest("[inert], [hidden], .hidden");
    const buttons=Array.from(toolbar.querySelectorAll(".toolbar-buttons .tool"));
    const toggle=doc.getElementById("toggleToolSidebar");
    const tip=doc.createElement("div");
    tip.id="imageToolTooltip";
    tip.className="image-tool-tooltip";
    tip.setAttribute("role","tooltip");
    tip.hidden=true;
    doc.body.appendChild(tip);
    // 元のtitleがあるツールは補足文を優先し、ブラウザ標準の二重表示を防ぐ。
    for(const button of buttons){
      const label=button.querySelector("span")?.textContent.trim()||button.getAttribute("aria-label")||"";
      button.dataset.toolTooltip=button.getAttribute("title")||label;
      button.removeAttribute("title");
    }
    let focusButton=null,pointerPressed=false;
    function hide(){
      if(focusButton)focusButton.removeAttribute("aria-describedby");
      tip.hidden=true;
    }
    function show(button){
      if(unavailable()||button.disabled||!button.dataset.toolTooltip)return;
      tip.textContent=button.dataset.toolTooltip;
      tip.hidden=false;
      if(focusButton===button)button.setAttribute("aria-describedby",tip.id);
      // スクロールするツール欄の外へ固定表示するため、位置座標だけ動的に指定。
      const anchor=button.getBoundingClientRect();
      const panel=sidebar.getBoundingClientRect();
      const bounds=tip.getBoundingClientRect();
      const gap=8,margin=12,rx=panel.right+gap;
      const rightFits=rx+bounds.width+margin<=win.innerWidth;
      const maxX=Math.max(margin,win.innerWidth-bounds.width-margin);
      const x=rightFits?rx:Math.min(maxX,Math.max(margin,anchor.left));
      let y=rightFits?anchor.top:anchor.bottom+gap;
      if(!rightFits&&y+bounds.height+margin>win.innerHeight)y=anchor.top-bounds.height-gap;
      y=Math.min(Math.max(margin,y),Math.max(margin,win.innerHeight-bounds.height-margin));
      tip.style.left=Math.round(x)+"px";
      tip.style.top=Math.round(y)+"px";
    }
    const state=createTooltipState({
      show,hide,
      setTimeout:win.setTimeout.bind(win),
      clearTimeout:win.clearTimeout.bind(win)
    });
    function reset(){
      state.reset();
      if(focusButton)focusButton.removeAttribute("aria-describedby");
      focusButton=null;
    }
    for(const button of buttons){
      button.addEventListener("pointerenter",event=>{
        if(event.pointerType==="touch"||event.buttons||unavailable()||button.disabled)return;
        if(focusButton)focusButton.removeAttribute("aria-describedby");
        focusButton=null;
        state.enter(button);
      });
      button.addEventListener("pointerleave",event=>{
        if(event.pointerType!=="touch"&&focusButton!==button)state.leave(button);
      });
      button.addEventListener("focus",()=>{
        if(pointerPressed||unavailable()||button.disabled)return;
        if(focusButton&&focusButton!==button)focusButton.removeAttribute("aria-describedby");
        focusButton=button;
        state.focus(button);
      });
      button.addEventListener("blur",()=>{
        if(focusButton===button)reset();
      });
    }
    sidebar.addEventListener("pointerleave",event=>{
      if(event.pointerType!=="touch")reset();
    });
    toolbar.addEventListener("pointerdown",()=>{
      pointerPressed=true;
      // ツールのクリックでは説明だけを閉じ、欄内の連続切替は維持する。
      state.dismiss();
      focusButton=null;
    });
    doc.addEventListener("pointerup",()=>{pointerPressed=false;});
    doc.addEventListener("pointercancel",()=>{pointerPressed=false;reset();});
    doc.addEventListener("keydown",event=>{if(event.key==="Escape")reset();});
    doc.addEventListener("visibilitychange",()=>{if(doc.hidden)reset();});
    win.addEventListener("blur",()=>{pointerPressed=false;reset();});
    win.addEventListener("resize",reset);
    win.addEventListener("scroll",reset,true);
    toggle?.addEventListener("click",reset);
    if(typeof win.MutationObserver==="function"){
      // 保存画面はappMainをinertにし、加工モード切替は親パネルをhiddenにする。
      // ツール欄自体が変わらない場合も、body直下の説明と保留タイマーを片付ける。
      const observer=new win.MutationObserver(()=>{if(unavailable())reset();});
      for(let ancestor=toolbar;ancestor;ancestor=ancestor.parentElement){
        observer.observe(ancestor,{attributes:true,attributeFilter:["inert","hidden","class"]});
      }
    }
    return {reset};
  }
  if(typeof module==="object"&&module.exports)module.exports={createTooltipState,initTooltips};
  else if(root?.document)initTooltips(root,root.document);
})(typeof window!=="undefined"?window:globalThis);
