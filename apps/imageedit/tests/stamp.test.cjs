const test = require("node:test");
const assert = require("node:assert/strict");
const stamp = require("../stamp.js");
const settings = extra => ({...stamp.PRESETS[0],lines:["確認"],...extra});

test("全定型スタンプは画像pxで描画でき、丸・四角と三行日付を枠内へ配置する",() => {
  for(const raw of stamp.PRESETS){
    const item=stamp.normalize(raw);
    const lines=stamp.expandLines(item.lines,new Date(2026,9,15),item.dateFormat);
    const layout=stamp.layout(item,lines,(text,size) => [...text].length*size*.6);
    assert.equal(layout.width,item.width);assert.equal(layout.height,item.height);
    for(const row of layout.rows){
      assert.ok(row.centerY > 0 && row.centerY < item.height);
      for(const character of row.chars) assert.ok(character.x >= 0 && character.x < item.width);
    }
  }
});

test("スタンプ日付は元年・平成令和境界・西暦を展開する",() => {
  assert.equal(stamp.formatDate(new Date(2026,9,15),"seireki"),"2026.10.15");
  assert.equal(stamp.formatDate(new Date(2026,9,15),"wareki"),"R8.10.15");
  assert.equal(stamp.formatDate(new Date(2019,4,1),"wareki-kanji"),"令和元年5月1日");
  assert.equal(stamp.formatDate(new Date(2019,3,30),"wareki"),"H31.4.30");
  assert.deepEqual(stamp.expandLines(["受付 {date}"],new Date(2026,9,15),"wareki"),["受付 R8.10.15"]);
  assert.throws(() => stamp.formatDate(new Date(NaN),"seireki"));
  assert.throws(() => stamp.formatDate(new Date(1900,0,1),"unknown"));
});

test("スタンプ設定は文字数・3行・px寸法・色・枠・日付を厳格に検証する",() => {
  for(const invalid of [
    {width:39},{height:1201},{width:40.5},{lines:[]},{lines:[" "]},
    {lines:["1","2","3","4"]},{lines:["あ".repeat(21)]},{lines:["改\n行"]},
    {color:"red"},{color:"#fff"},{borderWidth:2},{fill:"blue"},{shape:"circle"},{dateFormat:"unknown"}
  ]) assert.throws(() => stamp.normalize(settings(invalid)),JSON.stringify(invalid));
  const input=settings({width:40,height:1200,lines:["あ".repeat(20)],name:"__proto__",color:"#ABCDEF"});
  const item=stamp.normalize(input);assert.equal(item.color,"#abcdef");assert.notEqual(item.lines,input.lines);
});

test("テンプレートはファイルへ保存復元し、名前で更新して上限・誤形式・過大入力を拒否する",() => {
  const initial=[settings({name:"業務印",width:200})];
  const source=stamp.serialize(initial);
  assert.deepEqual(stamp.parse(`\uFEFF${source}`),[stamp.normalize(initial[0])]);
  const merged=stamp.merge(initial,[settings({name:"業務印",width:300}),settings({name:"__proto__"})]);
  assert.equal(merged.length,2);assert.equal(merged[0].width,300);assert.equal(merged[1].name,"__proto__");
  assert.throws(() => stamp.parse("{"));
  assert.throws(() => stamp.parse(JSON.stringify({format:"appbox-pdfeditor-stamp-templates",version:1,templates:initial})));
  assert.throws(() => stamp.parse("あ".repeat(100000)));
  assert.throws(() => stamp.parse(JSON.stringify({format:stamp.FORMAT,version:1,templates:[settings({lines:["x".repeat(21)]})]})));
  assert.throws(() => stamp.serialize([settings({name:""})]));
  const many=Array.from({length:50},(_,i) => settings({name:`スタンプ${i}`}));
  assert.equal(stamp.merge([],many).length,50);
  assert.throws(() => stamp.merge(many,[settings({name:"51件目"})]));
  assert.throws(() => stamp.serialize([...many,settings({name:"51件目"})]));
});

test("スタンプ描画は背景透過/白を反映して文字・枠線・区切り線をCanvasへ保存する",() => {
  for(const fill of ["none","white"]){
    const calls=[];
    const context=new Proxy({measureText:(text) => ({width:[...text].length*8})},
      {get:(obj,key) => key in obj ? obj[key] : (...args) => calls.push({key,args})});
    const canvas={getContext:() => context};
    stamp.render(canvas,settings({width:180,height:180,lines:["受付","{date}","担当"],fill,dividers:true}));
    assert.equal(canvas.width,180);assert.equal(canvas.height,180);
    assert.equal(calls.some(call => call.key === "fill"),fill === "white");
    assert.ok(calls.some(call => call.key === "fillText"));
    assert.equal(calls.filter(call => call.key === "lineTo").length,2);
    assert.equal(context.strokeStyle,"#d7261e");
  }
});
