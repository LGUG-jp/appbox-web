const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const appDir = path.resolve(__dirname, "..");

function read(name) {
  return fs.readFileSync(path.join(appDir, name), "utf8");
}

test("本体とヘルプは新標準の外枠とyellowテーマを使用する", () => {
  const html = read("index.html");
  const help = read("help.html");

  for (const page of [html, help]) {
    assert.match(page, /data-appbox-theme="yellow"/);
    assert.match(page, /class="appbox-header(?: [^"]*)?"/);
    assert.match(page, /class="appbox-header__brand"/);
    assert.match(page, /class="appbox-back-button"/);
  }

  assert.match(html, /class="appbox-app-intro appbox-app-intro--edge"/);
  assert.match(html, /class="appbox-app-h1">画像かんたん加工<\/h1>/);
  assert.match(html, /class="appbox-app-icon"/);
  assert.match(html, /&lt; ポータルに戻る/);
  assert.match(help, /&lt; アプリに戻る/);
});

test("本体は共通shellを使用し、画像編集専用にウィンドウ幅を活用する", () => {
  const html = read("index.html");
  const css = read("image.css");

  assert.match(html, /<main id="appMain" aria-label="画像かんたん加工">[\s\S]*class="appbox-app-intro appbox-app-intro--edge"[\s\S]*class="appbox-shell appbox-shell--wide imageedit-workspace-shell"/);
  assert.match(css, /\.imageedit-workspace-shell\s*\{[^}]*width:calc\(100% - 32px\);/);
  assert.match(css, /background:\s*var\(--appbox-page-bg/);
  assert.doesNotMatch(css, /\.imageedit-shell|\.app-shell/);
});

test("ツールは左サイド、設定は右サイド、表示倍率は画像下部に配置する", () => {
  const html = read("index.html");
  const css = read("image.css");
  const sidebarStart = html.indexOf('class="editor-sidebar ');
  const settingsPaneStart = html.indexOf('class="editor-settings ');
  const settingsStart = html.indexOf('id="contextPanel"');
  const stageStart = html.indexOf('class="panel stage-panel');
  const workareaStart = html.indexOf('id="canvasWorkarea"');
  const viewportStart = html.indexOf('id="canvasViewport"');
  const actionsStart = html.indexOf('id="editorActions"');
  const zoomStart = html.indexOf('id="zoomControls"');
  assert.ok(sidebarStart > 0 && stageStart > sidebarStart && workareaStart > stageStart);
  assert.ok(actionsStart > settingsStart);
  assert.ok(settingsPaneStart > zoomStart && settingsStart > settingsPaneStart);
  const settings = html.slice(settingsPaneStart,html.indexOf('id="batchPanel"'));
  for(const name of ["brush","mosaic","text","color","line","outline","fill","ink","image"]){
    assert.ok(settings.includes(`data-settings="${name}"`),name);
  }
  for(const name of ["crop","transform"]) assert.ok(settings.includes(`data-context="${name}"`),name);
  assert.ok(viewportStart > workareaStart && zoomStart > viewportStart);
  const viewport = html.slice(viewportStart,html.lastIndexOf("<div",zoomStart));
  assert.match(viewport, /id="canvasHolder"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>\s*<\/div>\s*$/);
  assert.match(css, /\.workspace\s*\{[^}]*grid-template-columns:260px minmax\(0,1fr\) 260px;[^}]*grid-template-areas:"sidebar stage settings";/);
  assert.match(css, /@media\(max-width:820px\)[\s\S]*?\.workspace\s*\{[^}]*grid-template-areas:"sidebar" "stage" "settings";/);
  assert.match(css, /\.toolbar-buttons\s*\{[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\);/);
  assert.doesNotMatch(css, /\.toolbar-group:(?:first-child|nth-child)[^{]*\.toolbar-buttons/);
  assert.match(css, /height:max\(360px,calc\(100dvh - 380px\)\);/);
  assert.doesNotMatch(css, /height:clamp\(320px,60vh,720px\)/);
});

test("左右のペインを縦にスクロールでき、未選択の設定で画像の位置を変えない",() => {
  const html=read("index.html"),css=read("image.css"),js=read("image.js");
  assert.match(css,/\.canvas-workarea\s*\{[^}]*position:relative;[^}]*isolation:isolate;/);
  assert.match(css,/\.editor-sidebar,\s*\.editor-settings\s*\{[^}]*height:var\(--image-sidebar-height,/);
  assert.match(css,/\.editor-sidebar\s*\{[^}]*display:flex;[^}]*flex-direction:column;/);
  assert.match(css,/\.editor-toolbar\s*\{[^}]*min-height:160px;[^}]*overflow-y:auto;/);
  assert.match(css,/\.editor-actions\s*\{[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\);[^}]*border-top:/);
  assert.match(css,/\.editor-settings\s*\{[^}]*grid-area:settings;[^}]*overflow-y:auto;/);
  assert.match(css,/\.editor-settings:has\(\.context-panel\.hidden\)\{visibility:hidden\}/);
  assert.match(css,/\.editor-settings\{height:auto;min-height:0;max-height:480px\}/);
  assert.match(html,/class="editor-settings right-panel panel[^>]*aria-label="ツールの設定" inert/);
  assert.match(css,/\.context-panel\s*\{[^}]*display:grid;/);
  assert.doesNotMatch(css,/\.context-panel\.hidden\s*\{|height:56px/);
  assert.match(html,/id="contextPanel"[^>]*aria-hidden="true" inert/);
  assert.doesNotMatch(css,/\.context-panel\s*\{[^}]*position:absolute/);
  assert.match(css,/\.editor-zoom-controls\s*\{[^}]*min-height:48px;/);
  assert.match(html,/id="zoomControls" class="zoom-controls editor-zoom-controls left-panel" inert/);
  assert.match(html,/id="annotationColorLabel">色<\/span>/);
  assert.match(html,/for="shapeFill"><span id="shapeFillLabel">塗り<\/span>/);
  assert.match(html,/aria-label="文字サイズ（px）"/);
  for(const id of ["decreaseFontSize","increaseFontSize"]) assert.match(html,new RegExp(`id="${id}"[^>]*aria-label="文字を(?:小さく|大きく)"`));
  assert.doesNotMatch(html,/id="textWidth"|文字枠の幅（px）/);
  assert.match(html,/for="textBgColor"><span id="textFillLabel">塗り<\/span>/);
  assert.match(html,/id="textBgTransparent"[^>]*>塗りなし/);
  assert.match(html,/for="lineWidth"><span>太さ<\/span>/);
  assert.match(html,/aria-label="保存する画像の横幅（px）"/);
  assert.doesNotMatch(html+js,/stageHelp|stage-help|contextHint|contextPanelHandle|resetContextPanel|floating-panel|floatingPanel|AppBoxImageFloatingPanel/);
});

test("スタンプ画面は見出しを残し、余白のある本文だけを画面の高さ内でスクロールする",() => {
  const html=read("index.html"),css=read("image.css");
  const stamp=html.slice(html.indexOf('id="stampDialog"'),html.indexOf('id="saveDialog"'));
  const body=stamp.slice(stamp.indexOf('class="stamp-dialog-body"'));
  assert.ok(stamp.indexOf('id="closeStamp"') < stamp.indexOf('class="stamp-dialog-body"'));
  for(const id of ["stampPreset","stampPreviewCanvas","stampApply","stampName","stampSaveTemplate","stampLoadTemplate"]){
    assert.ok(body.includes(`id="${id}"`),id);
  }
  assert.match(css,/#stampDialog\s*\{padding:16px\}/);
  assert.match(css,/\.dialog-card\.stamp-dialog-card\s*\{[^}]*display:flex;[^}]*flex-direction:column;[^}]*max-height:calc\(100dvh - 32px\);[^}]*overflow:hidden;/);
  assert.match(css,/\.stamp-dialog-card \.dialog-head\s*\{flex:0 0 auto\}/);
  assert.match(css,/\.stamp-dialog-body\s*\{[^}]*min-height:0;[^}]*padding:16px;[^}]*overflow:auto;/);
  assert.match(css,/@media\(max-width:820px\)\s*\{\s*\.stamp-layout\{grid-template-columns:1fr\}/);
  assert.match(css,/\.stamp-dialog-body :is\(input,select,textarea\)\{min-width:0;max-width:100%\}/);
});

test("画像編集の主要操作は共通ヘッダーに集約し、導入部と編集時の広い作業領域を切り替える",() => {
  const html=read("index.html"),css=read("image.css");
  const header=html.slice(html.indexOf("<header"),html.indexOf("</header>"));
  const stage=html.slice(html.indexOf('class="panel stage-panel'),html.indexOf('id="batchPanel"'));
  assert.match(header,/id="imageHeaderActions"[^>]*role="group"[^>]*hidden inert/);
  for(const id of ["changeSingle","undo","redo","resetSingle","previewButton","showSaveSettings"]){
    assert.ok(header.includes(`id="${id}"`),id);
    assert.ok(!stage.includes(`id="${id}"`),id);
  }
  for(const label of ["画像を変更","元に戻す","やり直す","すべて戻す","読込み時と現在を比較","加工した画像を保存"]){
    assert.ok(header.includes(`aria-label="${label}"`),label);
  }
  assert.match(header,/class="appbox-help-button"/);
  assert.match(header,/class="appbox-back-button"/);
  assert.match(html,/id="imageIntro" class="appbox-app-intro appbox-app-intro--edge"/);
  assert.match(html,/data-tool="select"[^>]*>[\s\S]*?<span>選択<\/span>/);
  assert.doesNotMatch(html,/選択・再編集|stage-head|file-heading/);
  assert.match(css,/\.image-header-actions\[hidden\],[\s\S]*?#imageIntro\[hidden\]\s*\{display:none\}/);
  assert.match(css,/body\.image-editor-active \.appbox-header__inner\s*\{[^}]*flex-wrap:wrap;/);
  assert.match(css,/body\.image-editor-active \.canvas-stage\s*\{[^}]*height:max\(240px,calc\(100dvh - 210px\)\);/);
  assert.doesNotMatch(css,/body\.image-editor-active\s*\{[^}]*overflow:hidden/);
});

test("加工モード切り替えは共通インデックスタブを使用する", () => {
  const html = read("index.html");
  const css = read("image.css");

  assert.match(html, /class="appbox-tabs appbox-print-hidden"/);
  assert.match(html, /id="processingModeTabs"/);
  assert.match(html, /id="changeProcessingMode"[^>]*aria-controls="processingModeTabs"/);
  assert.match(css, /#processingModeTabs\[hidden\],[\s\S]*?#changeProcessingMode\[hidden\]\{display:none\}/);
  assert.match(html, /class="appbox-tab is-active"[\s\S]*role="tab"/);
  assert.match(html, /class="appbox-tab-panel"[\s\S]*role="tabpanel"/);
  assert.doesNotMatch(css, /\.tabs\.calc-tabs|\.tab\.calc-tab|\.tab-panel/);
});

test("各パネルにテーマアクセント線が適用されている", () => {
  const html = read("index.html");
  const css = read("image.css");

  assert.match(html, /editor-sidebar panel appbox-panel appbox-panel--accent/);
  assert.match(html, /stage-panel appbox-panel appbox-panel--accent/);
  assert.match(html, /right-panel appbox-panel appbox-panel--accent/);
  assert.match(css, /\.panel\s*\{[^}]*border-top:\s*4px solid var\(--yellow-strong\)/s);
});

test("プライマリボタンは高コントラスト色を使用する", () => {
  const css = read("image.css");

  assert.match(css, /\.button\.primary\s*\{[^}]*background:\s*var\(--appbox-primary-hover,#856014\)/s);
});

test("画像未読み込み時は編集・保存領域が不活性で読込成功後に有効化される", () => {
  const html = read("index.html");
  const js = read("image.js");
  const css = read("image.css");

  assert.match(html, /class="left-panel editor-toolbar" inert/);
  assert.match(html, /id="editorActions" class="editor-actions hidden"[^>]*aria-hidden="true" inert/);
  assert.match(html, /id="saveDialog"\s+class="dialog hidden"/);
  assert.match(js, /function openSaveSettings\(\)\{\s*if\(!state\.originalCanvas \|\| state\.singleBusy \|\| state\.drag \|\| viewState\.pan\)/);
  assert.match(css, /#singleWorkspace:has\(#singleEmpty:not\(\.hidden\)\)\s*\.left-panel/);
  assert.match(css, /pointer-events:\s*none/);
  assert.match(js, /\.querySelectorAll\("\.left-panel[^"\n]*"\)\s*\.forEach\(element => \{\s*element\.inert = false;/);
});

test("旧ヘッダーやフッターの重複CSSが削除されている", () => {
  const css = read("image.css");

  assert.doesNotMatch(css, /^\.topbar\b/m);
  assert.doesNotMatch(css, /^\.brand\b/m);
  assert.doesNotMatch(css, /^\.brand-mark\b/m);
  assert.doesNotMatch(css, /^\.eyebrow\b/m);
  assert.doesNotMatch(css, /^h1\s*\{/m);
  assert.doesNotMatch(css, /^\.top-actions\b/m);
  assert.doesNotMatch(css, /^\.back-button\b/m);
  assert.doesNotMatch(css, /^footer\s*\{/m);
  assert.doesNotMatch(css, /^\.hero\b/m);
  assert.doesNotMatch(css, /^\.chips\b/m);
});

test("ヘルプは新標準の4区分とネスト目次を持ち目次前に重要警告を配置する", () => {
  const help = read("help.html");

  assert.match(help, /class="appbox-help-header-card"/);
  assert.match(help, /class="appbox-help-grid help-panel"/);
  assert.match(help, /class="appbox-help-nav-card/);
  assert.match(help, /class="[^"]*appbox-help-nav-sublist[^"]*"/);
  assert.match(help, /class="[^"]*appbox-help-nav-link--sub[^"]*"/);

  // 重要警告が目次より前にあること
  const warningPos = help.indexOf('class="help-callout help-callout-warning"');
  const navPos = help.indexOf('class="appbox-help-nav-card');
  assert.ok(warningPos > 0 && navPos > 0 && warningPos < navPos);

  // 4区分の存在確認
  for (const id of ["quick-start", "advanced", "faq", "other"]) {
    assert.match(help, new RegExp(`href="#${id}"`));
    assert.match(help, new RegExp(`id="${id}"`));
  }

  // ネスト小見出しの存在確認
  for (const id of ["mask", "layers", "trim", "size", "batch", "files", "operations", "cautions", "privacy"]) {
    assert.match(help, new RegExp(`href="#${id}"`));
    assert.match(help, new RegExp(`id="${id}"`));
  }

  // FAQ構造
  assert.match(help, /<details class="appbox-help-faq-item">/);
  assert.match(help, /<div class="appbox-help-faq-answer">/);
});

test("README・本体・ヘルプでバージョン整合性が保たれている", () => {
  const html = read("index.html");
  const help = read("help.html");
  const readme = read("README.txt");

  assert.match(readme, /共創アプリBOX \/ 画像かんたん加工  v1\.12\.3/);
  assert.match(html, /画像かんたん加工 Version 1\.12\.3/);
  assert.match(help, /Version 1\.12\.3/);
  assert.match(help, /画像かんたん加工 Version 1\.12\.3/);
  assert.match(html, /image\.css\?v=1\.12\.2/);
  assert.match(html, /image\.js\?v=1\.12\.3/);
  assert.match(html, /editor-actions\.js\?v=1\.10\.0/);
  assert.match(html, /annotation-style\.js\?v=1\.8\.0/);
  assert.doesNotMatch(html, /floating-panel\.js/);
});

test("主要ツールは四区画の見出しで常時表示され、切り抜き確定操作を保持する", () => {
  const html = read("index.html");
  const toolbar = html.slice(html.indexOf('aria-label="加工ツール"'),html.indexOf('class="panel stage-panel'));
  for(const title of ["操作","マスキング","文字・図形","回転・リサイズ"]){
    assert.ok(toolbar.includes(`<h2>${title}</h2>`));
  }
  assert.doesNotMatch(toolbar, /<details|<summary/);
  assert.doesNotMatch(toolbar, /<h2>(?:秘匿加工|注釈)<\/h2>/);
  assert.doesNotMatch(html, /範囲の確定は、画像直下に表示される/);
  assert.match(html, /id="applyCrop"[^>]*>[\s\S]*?この範囲で切り抜く/);
  assert.match(toolbar,/data-tool="crop"[^>]*>[\s\S]*?<span>トリミング<\/span>[\s\S]*?id="toggleTransform"/);
  assert.doesNotMatch(toolbar,/<h2>トリミング<\/h2>|範囲を指定/);
  assert.match(read("image.js"), /\$\$\("\.tool\[data-tool\]"\)\.forEach/);
});

test("切り抜き操作は移動できる範囲設定へ集約し、下部バーと元ファイル名を表示しない",() => {
  const html=read("index.html"),js=read("image.js"),css=read("image.css");
  const crop=html.slice(html.indexOf('data-context="crop"'),html.indexOf('data-context="transform"'));
  for(const id of ["applyCrop","cancelCrop","centerCrop","cropW","cropH","cropRatio"]){
    assert.ok(crop.includes(`id="${id}"`),id);
  }
  assert.doesNotMatch(html+js,/cropX|cropY|resetCrop/);
  assert.doesNotMatch(html+js+css,/cropActionBar|crop-action-bar|cropActionSummary|cropBarApply|cropBarReset|singleFileName/);
  assert.ok(html.includes('id="singleInfo"'));
  assert.match(html,/data-tool="ellipse"[^>]*>[\s\S]*?<span>円<\/span>/);
  assert.doesNotMatch(html,/>楕円</);
});

test("レイヤー一覧をなくし、画像上の操作と保存ダイアログを使う", () => {
  const html = read("index.html");
  const dialog = html.slice(html.indexOf('id="saveDialog"'));
  const singlePanel = html.slice(html.indexOf('id="singlePanel"'),html.indexOf('id="batchPanel"'));
  assert.doesNotMatch(singlePanel, /定型プリセット|加工箇所の確認一覧/);
  assert.doesNotMatch(html, /singleJpegBackground/);
  assert.doesNotMatch(html+read("image.js")+read("editor-actions.js"), /layersPanel|layerList|layerSummary|renderLayerList/);
  for(const id of ["frontLayer","backLayer","menuDelete","menuFront","menuBack"]){
    assert.ok(html.includes(`id="${id}"`),id);
  }
  assert.doesNotMatch(html+read("image.js"),/deleteLayer|選択削除/);
  assert.match(html, /id="showSaveSettings"/);
  assert.match(dialog, /id="singleSave"/);
  assert.match(dialog, /id="presetSelect"/);
  assert.match(dialog, /<option value="image\/png" selected>PNG<\/option>/);
});

test("三枚のCanvasは同一親の表示寸法を共有しDOMへ個別styleを設定しない", () => {
  const html = read("index.html");
  const css = read("image.css");
  const js = read("image.js");
  assert.match(html, /id="canvasHolder"[\s\S]*?id="baseCanvas"[\s\S]*?id="layerCanvas"[\s\S]*?id="editCanvas"/);
  assert.match(css, /\.canvas-holder canvas\s*\{[^}]*width:100%;[^}]*height:100%;/);
  assert.doesNotMatch(js, /(?:baseCanvas|layerCanvas|editCanvas)\.style\./);
  assert.doesNotMatch(html, /\sstyle=|\son\w+=/);
  for(const id of ["canvasViewport","zoomOut","zoomIn","zoomFit","zoomActual","zoomValue"]){
    assert.ok(html.includes(`id="${id}"`),id);
  }
});

test("画像編集コードの固定ID参照は画面内の一意な要素へ解決する", () => {
  const html = read("index.html");
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size,ids.length);
  const refs = [...(read("image.js")+read("editor-actions.js")).matchAll(/(?<!\$)\$\("([^"]+)"\)/g)].map(match => match[1]);
  for(const id of new Set(refs)) assert.ok(ids.includes(id),`未定義ID: ${id}`);
});

test("文字入力は設定欄ではなく画像上のネイティブ入力欄で行う",() => {
  const html=read("index.html"),css=read("image.css"),js=read("image.js");
  const settings=html.slice(html.indexOf('class="editor-settings '),html.indexOf('id="batchPanel"'));
  assert.doesNotMatch(settings,/<textarea|annotationText/);
  assert.match(html,/id="canvasHolder"[\s\S]*id="textEditorHost"[\s\S]*<textarea[^>]*id="textEditor"[^>]*maxlength="2000"[^>]*hidden><\/textarea>/);
  assert.doesNotMatch(js,/annotationText|\|\| "注釈"/);
  assert.match(css,/#textEditor\{[^}]*caret-color:[^;]+;/);
  assert.match(css,/#textEditor\{[^}]*white-space:break-spaces;[^}]*tab-size:8;/);
  assert.match(css,/#textEditorHost\{[^}]*overflow:hidden;/);
  assert.doesNotMatch(js,/(?:textEditor|textEditorHost)\.style\./);
});
