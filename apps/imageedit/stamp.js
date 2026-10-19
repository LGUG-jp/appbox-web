// Adapted from AppBox PDF editor's stamp layouts for image-pixel dimensions.
(function(root,factory){
  const api = factory();
  if(typeof module === "object" && module.exports) module.exports = api;
  else root.AppBoxImageStamp = api;
})(typeof globalThis === "object" ? globalThis : this,function(){
  "use strict";
  const FORMAT = "appbox-imageedit-stamp-templates";
  const VERSION = 1;
  const MAX_TEMPLATES = 50;
  const MAX_FILE_BYTES = 200*1024;
  const DATE_FORMATS = ["seireki","wareki","wareki-kanji"];
  const preset = (name,shape,width,height,lines,extra={}) => ({
    name,shape,width,height,lines,dateFormat:"seireki",color:"#d7261e",borderWidth:3,
    fill:"none",justify:true,dividers:false,...extra
  });
  const PRESETS = [
    preset("済","ellipse",120,120,["済"]),
    preset("確認","ellipse",150,150,["確認"]),
    preset("回覧","rect",240,120,["回覧"]),
    preset("至急","rect",240,120,["至急"]),
    preset("承認","ellipse",150,150,["承認"]),
    preset("受付（日付）","rect",300,180,["受付","{date}"],{justify:false}),
    preset("日付印","ellipse",200,200,["所属名","{date}","氏名"],{dateFormat:"wareki",justify:false,dividers:true})
  ];
  function text(value,max,label){
    if(typeof value !== "string" || /[\r\n\t\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value) || [...value].length > max)
      throw new Error(`${label}は${max}文字以内の1行で入力してください。`);
    return value.trim();
  }
  function normalize(settings){
    if(!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error("スタンプの設定を読み込めませんでした。");
    const name = text(settings.name || "",40,"テンプレート名");
    if(!["rect","ellipse"].includes(settings.shape)) throw new Error("スタンプの形を選択してください。");
    const width = Number(settings.width),height = Number(settings.height);
    if(![width,height].every(value => Number.isSafeInteger(value) && value >= 40 && value <= 1200))
      throw new Error("スタンプの幅と高さは40〜1200pxの整数で指定してください。");
    if(!Array.isArray(settings.lines) || settings.lines.length < 1 || settings.lines.length > 3)
      throw new Error("スタンプの文字は3行以内にしてください。");
    const lines = settings.lines.map(line => text(line,20,"スタンプの各行"));
    if(lines.every(line => !line)) throw new Error("スタンプの文字を入力してください。");
    if(!DATE_FORMATS.includes(settings.dateFormat)) throw new Error("日付の書式を選択してください。");
    if(typeof settings.color !== "string" || !/^#[0-9a-f]{6}$/i.test(settings.color)) throw new Error("スタンプの色を選択してください。");
    const borderWidth = Number(settings.borderWidth);
    if(![1,3,6].includes(borderWidth)) throw new Error("枠線の太さを選択してください。");
    if(!["none","white"].includes(settings.fill)) throw new Error("背景を選択してください。");
    return {name,shape:settings.shape,width,height,lines,dateFormat:settings.dateFormat,
      color:settings.color.toLowerCase(),borderWidth,fill:settings.fill,
      justify:settings.justify === true,dividers:settings.dividers === true};
  }
  function formatDate(date,format){
    if(!(date instanceof Date) || Number.isNaN(date.getTime())) throw new Error("日付を取得できませんでした。");
    if(!DATE_FORMATS.includes(format)) throw new Error("日付の書式を選択してください。");
    const y = date.getFullYear(),m = date.getMonth()+1,d = date.getDate();
    const key = y*10000+m*100+d;
    const era = key >= 20190501 ? {name:"令和",initial:"R",year:y-2018}
      : key >= 19890108 ? {name:"平成",initial:"H",year:y-1988} : null;
    if(format === "seireki" || !era) return `${y}.${String(m).padStart(2,"0")}.${String(d).padStart(2,"0")}`;
    if(format === "wareki") return `${era.initial}${era.year}.${m}.${d}`;
    return `${era.name}${era.year === 1 ? "元" : era.year}年${m}月${d}日`;
  }
  function expandLines(lines,date,format){
    const formatted = formatDate(date,format);
    return lines.map(line => line.replaceAll("{date}",formatted));
  }
  function chord(settings,inset,dy){
    const halfWidth = settings.width/2-inset;
    if(settings.shape === "rect") return halfWidth*2;
    const halfHeight = Math.max(1,settings.height/2-inset);
    return halfWidth*2*Math.sqrt(1-Math.min(1,Math.abs(dy)/halfHeight)**2);
  }
  function layout(settings,lines,measure){
    const inset = settings.borderWidth+Math.min(settings.width,settings.height)*.07;
    const rowHeight = (settings.height-inset*2)/lines.length;
    const rows = lines.map((line,index) => {
      const centerY = inset+rowHeight*(index+.5);
      if(!line) return {centerY,fontSize:0,chars:[]};
      let fontSize = rowHeight*.76,available = 0;
      for(let attempt=0;attempt<30;attempt++){
        available = chord(settings,inset,Math.abs(centerY-settings.height/2)+fontSize/2)*.92;
        const naturalWidth = Number(measure(line,fontSize));
        if(!Number.isFinite(naturalWidth) || naturalWidth < 0) throw new Error("スタンプの文字を配置できませんでした。");
        if(naturalWidth <= available+.01 || fontSize <= 2) break;
        fontSize = Math.max(2,fontSize*Math.max(.5,available/Math.max(1,naturalWidth))*.995);
      }
      const chars = [...line],widths = chars.map(ch => Number(measure(ch,fontSize)));
      const natural = widths.reduce((sum,value) => sum+value,0);
      if(widths.some(value => !Number.isFinite(value) || value < 0) || natural > available+.5)
        throw new Error(`${index+1}行目の文字がスタンプに収まりません。文字を短くするかサイズを大きくしてください。`);
      const gap = settings.justify && chars.length > 1
        ? Math.max(0,Math.min((available*.86-natural)/(chars.length-1),fontSize*.9)) : 0;
      let x = (settings.width-natural-gap*(chars.length-1))/2;
      return {centerY,fontSize,chars:chars.map((ch,i) => {const item={ch,x};x += widths[i]+gap;return item;})};
    });
    const dividers = settings.dividers ? Array.from({length:lines.length-1},(_,i) => {
      const y = inset+rowHeight*(i+1),width = chord(settings,settings.borderWidth/2,y-settings.height/2);
      return {y,x1:(settings.width-width)/2,x2:(settings.width+width)/2};
    }) : [];
    return {width:settings.width,height:settings.height,rows,dividers};
  }
  function render(canvas,raw,date=new Date()){
    const settings = normalize(raw);
    canvas.width = settings.width;canvas.height = settings.height;
    const context = canvas.getContext("2d");
    context.clearRect(0,0,canvas.width,canvas.height);
    const inset = settings.borderWidth/2;
    context.beginPath();
    if(settings.shape === "ellipse") context.ellipse(settings.width/2,settings.height/2,
      settings.width/2-inset,settings.height/2-inset,0,0,Math.PI*2);
    else context.rect(inset,inset,settings.width-settings.borderWidth,settings.height-settings.borderWidth);
    if(settings.fill === "white"){context.fillStyle="#fff";context.fill();}
    context.strokeStyle=settings.color;context.lineWidth=settings.borderWidth;context.stroke();
    const font = size => `bold ${size}px "BIZ UDPGothic", "Yu Gothic", Meiryo, sans-serif`;
    const lines = expandLines(settings.lines,date,settings.dateFormat);
    const positions = layout(settings,lines,(line,size) => {context.font=font(size);return context.measureText(line).width;});
    context.fillStyle=settings.color;context.textAlign="left";context.textBaseline="middle";
    for(const row of positions.rows){
      context.font=font(row.fontSize);
      for(const item of row.chars) context.fillText(item.ch,item.x,row.centerY);
    }
    for(const divider of positions.dividers){
      context.beginPath();context.moveTo(divider.x1,divider.y);context.lineTo(divider.x2,divider.y);context.stroke();
    }
    return settings;
  }
  function serialize(templates){
    if(!Array.isArray(templates) || templates.length > MAX_TEMPLATES) throw new Error("テンプレートは50件までです。");
    const list = templates.map(raw => {const item=normalize(raw);if(!item.name) throw new Error("テンプレート名を入力してください。");return item;});
    return `${JSON.stringify({format:FORMAT,version:VERSION,templates:list},null,2)}\n`;
  }
  function parse(source){
    if(typeof source !== "string" || new TextEncoder().encode(source).length > MAX_FILE_BYTES)
      throw new Error("テンプレートファイルは200KB以下にしてください。");
    let data;
    try{data=JSON.parse(source.replace(/^\uFEFF/,""));}catch(error){throw new Error("テンプレートファイルを読み込めませんでした。");}
    if(data?.format !== FORMAT || data.version !== VERSION || !Array.isArray(data.templates))
      throw new Error("画像かんたん編集のスタンプテンプレートファイルを選択してください。");
    if(data.templates.length > MAX_TEMPLATES) throw new Error("テンプレートは50件までです。");
    return data.templates.map((raw,index) => {
      try{const item=normalize(raw);if(!item.name) throw new Error("テンプレート名がありません。");return item;}
      catch(error){throw new Error(`${index+1}件目のテンプレート：${error.message}`);}
    });
  }
  function merge(current,loaded){
    const map = new Map(current.map(item => [item.name,normalize(item)]));
    for(const raw of loaded){const item=normalize(raw);map.set(item.name,item);}
    if(map.size > MAX_TEMPLATES) throw new Error("テンプレートは50件までです。");
    return [...map.values()];
  }
  return {FORMAT,VERSION,MAX_TEMPLATES,MAX_FILE_BYTES,DATE_FORMATS,PRESETS,
    normalize,formatDate,expandLines,layout,render,serialize,parse,merge};
});
