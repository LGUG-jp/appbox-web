const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { commonAssetVersion } = require("../../../tests/helpers.cjs");

const appDir = path.resolve(__dirname, "..");

function read(name) {
  return fs.readFileSync(path.join(appDir, name), "utf8");
}

test("本体はredテーマと新標準の共通外枠を使用する", () => {
  const html = read("index.html");

  assert.match(html, /data-appbox-theme="red"/);
  assert.match(html, /<header class="appbox-header(?: [^"]*)?">/);
  assert.match(html, /class="appbox-header__brand"/);
  assert.match(html, /class="appbox-help-button"/);
  assert.match(html, /class="appbox-back-button" href="\.\.\/\.\.\/">&lt; ポータルに戻る<\/a>/);
  assert.match(html, /<main id="main-content" class="pdf-app-main">/);
  assert.match(html, /class="appbox-app-intro appbox-app-intro--edge" id="pdfBrand"/);
  assert.match(html, /class="appbox-app-h1">PDFかんたん編集<\/h1>/);
  assert.match(html, /class="appbox-shell appbox-shell--wide pdfeditor-shell"/);
  assert.equal((html.match(/<main\b/g) || []).length, 1);
  assert.equal((html.match(/<h1\b/g) || []).length, 1);
});

test("共通ヘッダー左側のPDF操作・履歴・全体保存は読込み後だけ表示し、同じボタンを両モードで使う", () => {
  const html = read("index.html"), css = read("app.css"), js = read("app.js");
  const header = html.match(/<header class="appbox-header(?: [^"]*)?">([\s\S]*?)<\/header>/)?.[1] || "";
  assert.match(header, /id="pdfHeaderActions"[^>]*hidden/);
  for (const id of ["appendPdfBtn", "closePdfBtn", "undoBtn", "redoBtn", "saveBtn"]) {
    assert.match(header, new RegExp(`id="${id}"`));
    assert.equal((html.match(new RegExp(`id="${id}"`, "g")) || []).length, 1);
  }
  const order = ['class="appbox-header__brand"', 'id="appendPdfBtn"', 'id="closePdfBtn"', 'id="undoBtn"', 'id="redoBtn"', 'id="saveBtn"', 'class="appbox-header__actions"'];
  for (let i = 1; i < order.length; i++) assert.ok(header.indexOf(order[i - 1]) < header.indexOf(order[i]));
  assert.match(header, /<span>開く<\/span>/);
  assert.match(header, /<span>閉じる<\/span>/);
  assert.doesNotMatch(html + js + css, /pdfMenuBtn|pdfActions|setPdfMenuOpen/);
  assert.match(css, /body\.pdf-editor-active \.appbox-header__inner\s*\{[^}]*justify-content:\s*flex-start;/);
  assert.match(js, /\$\("pdfHeaderActions"\)\.hidden = !hasPages;/);
  assert.match(css, /body\.pdf-editor-active \.appbox-header__subtitle\s*\{\s*display:\s*none;/);
  assert.match(css, /\.pdf-header-actions\[hidden\]\s*\{\s*display:\s*none;/);
  assert.match(css, /body\.pdf-editor-active \.appbox-header__inner\s*\{[^}]*flex-wrap:\s*nowrap;/);
  assert.match(css, /\.page-check-target\s*\{[^}]*width:\s*40px;[^}]*height:\s*40px;/);
});

test("プレビュー拡張用の折りたたみはアプリ導入部と重要注意だけを対象にする", () => {
  const html = read("index.html");
  const css = read("app.css");

  assert.match(html, /data-appbox-collapse="pdfBrand pdfNotice"/);
  assert.doesNotMatch(html, /data-appbox-collapse-flag="chrome"/);
  assert.match(html, new RegExp(`appbox-collapse\\.js\\?v=${commonAssetVersion().replaceAll(".", "\\.")}`));
  assert.match(css, /\[data-appbox-collapsed="true"\]\s*\{\s*display:\s*none;/);
  assert.doesNotMatch(css, /data-appbox-collapsed-chrome/);
});

test("文字付き操作の読み上げ名は可視ラベルを含み、動作説明を分ける", () => {
  const html = read("index.html");
  for (const [id, label] of [["appendPdfBtn", "開く"], ["closePdfBtn", "閉じる"], ["saveBtn", "保存"], ["extractBtn", "選択を保存"], ["thumbnailSize", "一覧の大きさ"]]) {
    const tag = html.match(new RegExp(`<[^>]*id="${id}"[^>]*>`))[0];
    assert.ok(tag.match(/aria-label="([^"]+)"/)[1].includes(label), id);
  }
  for (const id of ["appendPdfDescription", "savePdfDescription", "extractPdfDescription", "pageSelectionDescription"]) {
    assert.match(html, new RegExp(`aria-describedby="${id}"`));
    assert.match(html, new RegExp(`id="${id}"`));
  }
});

test("アイコンの説明はブラウザ標準に揃え、選択枠と挿入バーは不透明の専用色", () => {
  const html = read("index.html"), css = read("app.css"), js = read("app.js");
  assert.doesNotMatch(html + css + js, /toolbarTooltip|toolbar-tooltip|setupToolbarTooltips/);
  const icons = [...html.matchAll(/<button\b[^>]*class="[^"]*\bicon-button\b[^"]*"[^>]*>/g)];
  assert.ok(icons.length > 0);
  for (const [tag] of icons) {
    const label = tag.match(/aria-label="([^"]+)"/)[1];
    assert.equal(tag.match(/title="([^"]+)"/)[1], label);
  }
  assert.doesNotMatch(css, /\.icon-button::after/);
  assert.match(css, /--page-interaction:\s*#[\da-f]{6};/);
  assert.match(css, /\.page-selection-marquee\s*\{[^}]*border:\s*2px solid var\(--page-interaction\)/);
  assert.match(css, /\.thumb-item\[data-drop\]::after\s*\{[^}]*background:\s*var\(--page-interaction\)/);
  assert.match(js, /if \(focusPageId\) restoreDeletedPageFocus\(focusPageId\)/);
  assert.match(css, /@media \(max-height: 500px\)[\s\S]*body\.pdf-editor-active\s*\{[^}]*overflow:\s*auto;/);
});

test("PDF固有の主要な編集領域と安全上の注意を維持する", () => {
  const html = read("index.html");
  const css = read("app.css");

  for (const id of [
    "pdfInput",
    "pdfNotice",
    "emptyState",
    "editor",
    "thumbList",
    "viewerArea",
    "pdfCanvas",
    "annotationLayer",
    "saveBtn",
    "statusText",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }

  assert.match(html, /マスキング用途で使用しないでください（データは見えます）/);
  assert.doesNotMatch(html, /id="addPdfBtn"/);

  const bodyBlocks = [
    ...css.matchAll(/(?:^|\n)body\s*\{([^}]*)\}/g),
  ];
  const bodyBlock = bodyBlocks.find((match) =>
    /margin:\s*0;/.test(match[1])
  );
  assert.ok(bodyBlock);
});

test("PDF読込み後は案内類を自動で隠して編集領域を優先する", () => {
  const js = read("app.js");
  const css = read("app.css");

  assert.match(
    js,
    /document\.body\.classList\.toggle\(\s*"pdf-editor-active",\s*hasPages\s*\)/
  );
  assert.match(
    js,
    /マスキング用途で使用しないでください（データは見えます）/
  );
  assert.match(
    js,
    /function restoreIntroDisclosure\(\)[\s\S]*aria-expanded[\s\S]*\.click\(\)/
  );
  assert.match(
    js,
    /state\.tool = "select";[\s\S]*restoreIntroDisclosure\(\);/
  );

  for (const selector of [
    "body.pdf-editor-active #pdfBrand",
    "body.pdf-editor-active #pdfNotice",
    "body.pdf-editor-active .appbox-collapse-toggle",
    "body.pdf-editor-active .pdfeditor-footer",
    "body.pdf-editor-active .editor-guidance",
  ]) {
    assert.match(css, new RegExp(selector.replaceAll(".", "\\.")));
  }

  const statusRule = css.match(
    /body\.pdf-editor-active \.status-bar\s*\{([^}]*)\}/
  );
  assert.ok(statusRule);
  assert.match(statusRule[1], /position:\s*absolute;/);
  assert.doesNotMatch(statusRule[1], /display:\s*none;/);
});

test("共通外枠と重複する旧ヘッダー・ボタンCSSを持たない", () => {
  const css = read("app.css");

  for (const selector of [
    /^\.app-header\b/m,
    /^\.brand\b/m,
    /^\.title-row\b/m,
    /^\.app-icon\b/m,
    /^\.header-actions\b/m,
    /^\.back-button\b/m,
    /^\.help-button\b/m,
    /^\.btn-primary\b/m,
    /^\.btn-soft\b/m,
    /^h1\s*\{/m,
  ]) {
    assert.doesNotMatch(css, selector);
  }

  assert.match(css, /#pdfBrand\s*\{[\s\S]*margin-bottom:\s*0;[\s\S]*padding-bottom:\s*12px;/);
  assert.match(css, /\.pdfeditor-shell\s*\{/);
  assert.match(css, /\.redaction-notice\s*\{/);
  assert.match(css, /\.editor\s*\{/);
});

test("アイコン付きの操作ボタンは共通アイコンだけを使い、旧アイコンのクラスを残さない", () => {
  const html = read("index.html");
  const classes = tag => (tag.match(/\sclass\s*=\s*(["'])([\s\S]*?)\1/)?.[2] ?? "").split(/\s+/).filter(Boolean);
  // 旧クラスの寸法指定はapp.cssから削除済みのため、残ると0×0で消える。
  for (const [tag] of html.matchAll(/<[a-z][^>]*>/gi)) {
    for (const legacy of ["tool-icon", "action-icon"]) assert.ok(!classes(tag).includes(legacy), tag);
  }
  // 共通外枠の折りたたみボタンは共通chromeが図柄を持つため対象外。
  const buttons = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)]
    .map(([button]) => button)
    .filter(button => button.includes("<svg") && !classes(button.match(/<button\b[^>]*>/)[0]).includes("appbox-collapse-toggle"));
  assert.ok(buttons.length > 0);
  for (const button of buttons) {
    const id = button.match(/\sid\s*=\s*(["'])([^"']+)\1/)?.[2] ?? button.slice(0, 80);
    for (const [svg] of button.matchAll(/<svg\b[^>]*>/g)) assert.ok(classes(svg).includes("appbox-icon"), id);
  }
});

test("ヘルプは新標準の4区分とネスト目次を使用し重要警告を先に示す", () => {
  const help = read("help.html");

  assert.match(help, /data-appbox-theme="red"/);
  assert.match(help, /class="appbox-header"/);
  assert.match(help, /class="appbox-help-header-card"/);
  assert.match(help, /class="appbox-help-grid help-panel"/);
  assert.match(help, /href="\.\/index\.html">&lt; アプリに戻る<\/a>/);

  for (const id of ["quick-start", "advanced", "faq", "other"]) {
    assert.match(help, new RegExp(`href="#${id}"`), id);
    assert.match(help, new RegExp(`id="${id}"`), id);
  }

  for (const id of ["pages", "comments", "shapes", "save", "cautions", "privacy"]) {
    assert.match(help, new RegExp(`appbox-help-nav-link--sub" href="#${id}"`), id);
    assert.match(help, new RegExp(`class="appbox-help-subheading" id="${id}"`), id);
  }

  const warningPos = help.indexOf('class="help-callout help-callout-warning"');
  const navPos = help.indexOf('class="appbox-help-nav-card');
  assert.ok(warningPos > 0 && navPos > warningPos);
  assert.match(help, /<details class="appbox-help-faq-item">/);
  assert.match(help, /class="appbox-help-faq-answer"/);
  assert.match(help, new RegExp(`appbox-help\\.js\\?v=${commonAssetVersion().replaceAll(".", "\\.")}`));
});

test("README・本体・ヘルプの版と変更した固有資産のキャッシュ識別子を揃える", () => {
  const html = read("index.html");
  const help = read("help.html");
  const readme = read("README.txt");

  const version = readme.match(/^共創アプリBOX \/ PDFかんたん編集  v([\d.]+)/)[1];
  const escaped = version.replaceAll(".", "\\.");
  assert.match(readme, new RegExp(`(?:開発版|リリース版) v${escaped}`));
  assert.match(html, new RegExp(`PDFかんたん編集 Version ${escaped}`));
  assert.match(help, new RegExp(`Version ${escaped}`));
  assert.match(help, new RegExp(`PDFかんたん編集 Version ${escaped}`));
  assert.match(html, new RegExp(`app\\.js\\?v=${escaped}`));
  assert.match(html, new RegExp(`app\\.css\\?v=${escaped}`));
  // 作業ファイルを追加したproject-fileのキャッシュ識別子も今回の版へ更新する。
  assert.match(read("app.js"), new RegExp(`project-file\\.mjs\\?v=${escaped}`));
  // Unchanged modules retain their own cache key (CONTRIBUTING.md).
  for (const module of ["editor-core", "page-numbering", "text-image"])
    assert.match(read("app.js"), new RegExp(`${module}\\.mjs\\?v=\\d+\\.\\d+\\.\\d+`));
});

test("手書きモジュールは本体とeditor-coreで同じversion queryを使う", () => {
  const versions = ["app.js", "editor-core.mjs"].map(file => {
    const matches = [...read(file).matchAll(/from\s+["']\.\/ink\.mjs\?v=(\d+\.\d+\.\d+)["']/g)];
    assert.equal(matches.length, 1, `${file} must import ink exactly once`);
    return matches[0][1];
  });
  assert.equal(versions[0], versions[1]);
});

test("手書きと設定見出しの装飾を省き、狭幅とタッチ操作を保つ", () => {
  const html = read("index.html"), css = read("app.css");
  assert.match(css, /\.format-heading:focus-visible,\s*\.ann-ink:focus-visible\s*\{\s*outline: none;/);
  assert.doesNotMatch(html, /formatMoveDescription|aria-keyshortcuts/);
  assert.doesNotMatch(html, /inkTouchHint/);
  assert.doesNotMatch(css, /ink-touch-hint/);
  assert.doesNotMatch(read("app.js"), /\$\("inkTouchHint"\)/);
  assert.match(css, /@media \(pointer: coarse\)\s*\{\s*\.format-heading\s*\{\s*min-height: 44px;/);
  assert.match(css, /data-tool="ink-eraser"\]\s*\{\s*cursor: url\("\.\/eraser-cursor\.svg\?v=[\d.]+"\) 12 12, cell;/);
  assert.match(read("eraser-cursor.svg"), /cx="12" cy="12" r="8"/);
  assert.match(css, /@media \(max-width: 560px\)\s*\{[^}]*data-figure-type="ink-eraser"[^}]*max-width: min\(240px, calc\(100% - 24px\)\)/);
});

test("ページ番号の設定は一覧から開くモーダルで、ラベル・エラー・プレビュー・キャンセルを備える", () => {
  const html = read("index.html"), css = read("app.css"), js = read("app.js");
  assert.match(html, /id="pageNumberBtn"[^>]*aria-haspopup="dialog"[^>]*aria-controls="pageNumberDialog"[^>]*disabled/);
  assert.match(html, /<dialog id="pageNumberDialog"[^>]*aria-labelledby="pageNumberTitle"[^>]*aria-describedby="pageNumberDescription"/);
  for (const id of ["pageNumberStartPage", "pageNumberStartNumber", "pageNumberPosition", "pageNumberFontSize"])
    assert.match(html, new RegExp(`<label for="${id}"`));
  assert.match(html, /id="pageNumberError"[^>]*role="alert"/);
  assert.match(html, /id="pageNumberSummary"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /id="pageNumberCancel"[^>]*type="button"/);
  assert.match(html, /id="pageNumberApply"[^>]*type="submit"[^>]*disabled/);
  assert.match(css, /\.page-number-dialog\s*\{[^}]*max-height:[^;]+;[^}]*overflow:\s*auto/);
  assert.match(css, /\.page-number-overlay\s*\{[^}]*pointer-events:\s*none/);
  assert.match(js, /input,select,textarea,dialog/);
});

test("保存警告は丸を含め、抽出対象ページだけを判定する", () => {
  const js = read("app.js");
  const help = read("help.html");
  const readme = read("README.txt");

  assert.match(js, /function hasCoveringAnnotations\(\s*pages = state\.pages\s*\)/);
  assert.match(js, /"rect",[\s\S]*"ellipse",[\s\S]*"text"[\s\S]*\.includes\(\s*annotation\.type/);
  assert.match(js, /hasCoveringAnnotations\(\s*exportPages\s*\)/);
  assert.match(readme, /四角・丸・テキスト・画像・手書きがある場合/);
  assert.match(help, /四角・丸・テキスト・画像・手書きがある場合/);
});

test("PDF.js TextLayerの文字計測用Canvasを画面へ露出させない", () => {
  const css = read("app.css");

  const rule = css.match(/\.hiddenCanvasElement\s*\{([^}]*)\}/);
  assert.ok(rule);
  assert.match(rule[1], /position:\s*absolute;/);
  assert.match(rule[1], /width:\s*0;/);
  assert.match(rule[1], /height:\s*0;/);
  assert.match(rule[1], /display:\s*none;/);
});

test("ページ描画は白背景とサムネイル再利用で競合・全件再描画を抑制する", () => {
  const js = read("app.js");

  assert.match(js, /let currentThumbnailRenderTask = null;/);
  assert.match(js, /function thumbnailRenderKey\(pageRef\)/);
  assert.match(js, /reusable\?\.dataset[\s\S]*\.renderKey ===[\s\S]*thumbnailRenderKey/);
  assert.match(js, /await stopThumbnailRendering\(\)/);
  assert.match(js, /context\.fillStyle =\s*"#ffffff";[\s\S]*context\.fillRect\(/);
  assert.match(js, /function selectPage\(pageId, render = true\)/);
  assert.match(js, /state\.selectionAnchor=state\.currentPageId/);
});


test("PDF.js 5.3.31のJPEG2000・ICC実行資産を同一オリジンから読み込む", () => {
  const js = read("app.js");
  const vendorReadme = read("vendor/README.txt");
  const notice = read("THIRD_PARTY_LICENSES.txt");

  assert.match(js, /new URL\([\s\S]*\.\/vendor\/wasm\/[\s\S]*document\.baseURI/);
  assert.match(js, /useWasm:\s*true/);
  assert.match(js, /useWorkerFetch:\s*false/);
  assert.match(js, /BundledTextCMapReaderFactory/);

  for (const [relative, minimum] of [
    ["vendor/wasm/openjpeg.wasm", 200000],
    ["vendor/wasm/openjpeg_nowasm_fallback.js", 400000],
    ["vendor/wasm/qcms_bg.wasm", 80000],
  ]) {
    const full = path.join(appDir, relative);
    assert.ok(fs.existsSync(full), relative);
    assert.ok(fs.statSync(full).size >= minimum, relative);
  }

  assert.match(vendorReadme, /openjpeg\.wasm/);
  assert.match(vendorReadme, /qcms_bg\.wasm/);
  assert.match(notice, /PDF\.js \/ pdfjs-dist 5\.3\.31/);
  assert.match(notice, /licenses\/openjpeg_LICENSE\.txt/);
  assert.match(notice, /licenses\/pdfjs-openjpeg_LICENSE\.txt/);
  assert.match(notice, /licenses\/qcms_LICENSE\.txt/);
  assert.match(notice, /licenses\/pdfjs-qcms_LICENSE\.txt/);
});


test("図形操作は設定パネルから外し、右クリック・長押しメニューへ分離する", () => {
  const html = read("index.html"), css = read("app.css"), js = read("app.js");
  for (const id of ["editTextBtn", "copyFiguresBtn", "pasteFiguresBtn", "deleteAnnotationBtn"])
    assert.doesNotMatch(html, new RegExp(`id=["']${id}["']`));
  assert.match(html, /id="figureContextMenu"[^>]*role="menu"/);
  assert.match(html, /id="figureContextCopyBtn"[^>]*>コピー<\/button>/);
  assert.match(html, /id="figureContextPasteBtn"[^>]*>貼り付け<\/button>/);
  assert.match(html, /id="figureContextDeleteBtn"[^>]*>削除<\/button>/);
  assert.doesNotMatch(css, /\.figure-actions/);
  assert.match(css, /\.figure-context-menu\s*\{[^}]*position:\s*fixed;/);
  assert.match(js, /el\.addEventListener\("contextmenu"/);
  assert.match(js, /FIGURE_LONG_PRESS_MS\s*=\s*550/);
  assert.match(js, /FIGURE_LONG_PRESS_MOVE_PX\s*=\s*10/);
  assert.match(js, /event\.pointerType\s*===\s*"touch"\s*\|\|\s*event\.pointerType\s*===\s*"pen"/);
  assert.match(js, /distance <= FIGURE_LONG_PRESS_MOVE_PX/);
  assert.match(js, /setupFigureContextMenu\(\)/);
  assert.match(js, /cancelOnLostCapture\s*=\s*false/);
  assert.match(js, /\{ cancelOnLostCapture: true \}/);
});


test("テキスト設定は広幅で白縁取りまで1段に保ち、狭幅では折り返し可能にする", () => {
  const css = read("app.css"), js = read("app.js");
  assert.match(js, /panel\.dataset\.figureType = selected\.length > 1 \? "mixed" : type/);
  assert.match(css, /@media \(min-width: 560px\)[\s\S]*\.floating-properties\[data-figure-type="text"\] \.property-controls\s*\{[^}]*flex-wrap:\s*nowrap;/);
  assert.match(css, /data-figure-type="text"[\s\S]*#outlineField/);
});


test("色設定の名称はテキストで文字、四角と丸で枠に切り替える", () => {
  const html = read("index.html"), js = read("app.js");
  assert.match(html, /id="colorFieldLabel">色<\/span>/);
  assert.match(js, /type === "text" \? "文字" : \["rect", "ellipse"\]\.includes\(type\) \? "枠" : "色"/);
  assert.match(js, /type === "text" \? "文字の色" : \["rect", "ellipse"\]\.includes\(type\) \? "枠の色" : "図形の色"/);
  assert.match(js, /\$\("colorFieldLabel"\)\.textContent = colorLabel/);
  assert.match(js, /\$\("colorInput"\)\.setAttribute\("aria-label", colorAriaLabel\)/);
});


test("重ね順の通常ボタンとメニューは同じ名前を持ち、編集画面だけに通常ボタンを置く", () => {
  const html = read("index.html");
  assert.match(read("app.css"), /\.figure-context-menu\s*\{[^}]*max-height:\s*calc\(100dvh - 16px\);[^}]*overflow-y:\s*auto;/);
  const tools = html.match(/<div id="annotationToolsMenu"[^>]*class="toolbar-group tools edit-only"[^>]*>([\s\S]*?)<\/div>/)[1];
  assert.match(tools, /id="figureOrderControls"[^>]*role="group"[^>]*aria-label="図形の重ね順"/);
  for (const [button, item, label] of [
    ["bringFiguresFrontBtn", "figureContextFrontBtn", "最前面に移動"],
    ["sendFiguresBackBtn", "figureContextBackBtn", "最背面に移動"],
  ]) {
    assert.match(tools, new RegExp(`id="${button}"[^>]*class="tool-action icon-button"[^>]*type="button"[^>]*aria-label="${label}"[^>]*title="${label}"[^>]*disabled`));
    assert.match(html, new RegExp(`id="${item}"[^>]*role="menuitem"[^>]*disabled>${label}</button>`));
  }
});

test("短い画面では補助要素を省略し、狭幅ではPDFヘッダーの操作を折り返して保護する", () => {
  const css = read("app.css");
  assert.match(css, /body\.pdf-editor-active \.appbox-header__inner\s*\{[^}]*flex-wrap:\s*nowrap;/);
  assert.match(css, /@media \(max-width: 760px\), \(max-height: 500px\)[\s\S]*body\.pdf-editor-active \.appbox-header__title,[\s\S]*body\.pdf-editor-active \.appbox-help-button\s*\{\s*display:\s*none;/);
  assert.match(css, /body\.pdf-editor-active \.pdf-header-actions,[\s\S]*body\.pdf-editor-active \.appbox-header__actions\s*\{[^}]*flex-wrap:\s*nowrap;/);
  assert.match(css, /body\.pdf-editor-active \.appbox-collapse-toggle span\s*\{\s*display:\s*none;/);
  assert.match(css, /@media \(max-width: 560px\)[\s\S]*#appendPdfBtn[\s\S]*#closePdfBtn[\s\S]*#saveBtn[\s\S]*> span\s*\{\s*display:\s*none;/);
  assert.match(css, /@media \(max-width: 560px\)\s*\{\s*body\.pdf-editor-active \.appbox-header__inner\s*\{\s*flex-wrap:\s*wrap;/);
  assert.match(css, /body\.pdf-editor-active \.appbox-header__actions\s*\{[^}]*flex:\s*none;/);
});


test("四角と丸の選択後リサイズはShift・Ctrlで元の縦横比を維持する", () => {
  const js = read("app.js");
  assert.match(js, /preserveAspect\s*=\s*annotation\.type === "image" \|\|\s*\(\["rect", "ellipse"\]\.includes\(annotation\.type\)/);
  assert.match(js, /moveEvent\.shiftKey \|\| moveEvent\.ctrlKey/);
  assert.match(js, /resizeBox\(\s*original,[\s\S]*preserveAspect/);
});


test("線と矢印はCtrlで軸固定し、既存端点はShiftで元の角度を保つ", () => {
  const js = read("app.js");
  assert.match(
    js,
    /constrainedLinePoint\(\s*start,\s*point,\s*moveEvent\.ctrlKey/,
  );
  assert.doesNotMatch(
    js,
    /constrainedLinePoint\(\s*start,\s*point,\s*moveEvent\.shiftKey/,
  );
  assert.match(
    js,
    /p = e\.shiftKey\s*\? angleLockedLinePoint\(anchor, originalPoint, point, size\)\s*:\s*constrainedLinePoint\(anchor, point, e\.ctrlKey\)/,
  );
});


test("作図中は既存図形と子要素がポインター操作を遮らない", () => {
  const css = read("app.css");
  const rule = css.match(/\.annotation-layer:is\(([^)]+)\)\s*:is\(\.ann, \.ann \*\)\s*\{([^}]+)\}/);
  assert.ok(rule);
  for (const tool of ["text", "rect", "ellipse", "arrow", "line"])
    assert.ok(rule[1].includes(`[data-tool="${tool}"]`));
  assert.ok(!rule[1].includes('[data-tool="select"]'));
  assert.match(rule[2], /pointer-events:\s*none;/);
});


test("透かしは一覧から開く簡潔なモーダルで、全ページ／選択ページ・プレビュー・削除を備える", () => {
  const html = read("index.html"), css = read("app.css"), js = read("app.js");
  assert.match(html, /id="watermarkBtn"[^>]*aria-haspopup="dialog"[^>]*aria-controls="watermarkDialog"[^>]*disabled/);
  assert.match(html, /<dialog id="watermarkDialog"[^>]*aria-labelledby="watermarkTitle"/);
  for (const value of ["取扱注意", "部外秘", "庁内限り", "案", "参考", "見本", "DRAFT"])
    assert.match(html, new RegExp(`<option value="${value}"`));
  for (const id of ["watermarkText", "watermarkColor", "watermarkOpacity", "watermarkFontSize", "watermarkAngle"])
    assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /name="watermarkTarget" value="all" checked/);
  assert.match(html, /name="watermarkTarget" value="selected"/);
  assert.match(html, /id="watermarkDelete"[^>]*>透かしを削除</);
  assert.match(html, /id="watermarkPreview"/);
  assert.match(js, /function setupWatermarking\(\)/);
  assert.match(js, /function previewWatermarks\(\)/);
  assert.match(js, /replaceWatermarks\(state\.pages, plan\)/);
  assert.match(js, /removeWatermarks\(state\.pages,/);
  assert.match(css, /\.watermark-overlay\s*\{/);
});

test("透かしはプレビューと保存画像で同じ基準線・空白の扱いで中央へ描く", () => {
  const css = read("app.css"), js = read("app.js");
  const overlay = js.match(/function watermarkOverlay\([\s\S]*?\n\}/)?.[0] || "";
  assert.match(overlay, /y: height \/ 2 \+ watermarkBaselineOffset\(annotation\)/);
  assert.match(overlay, /"text-anchor": "middle"/);
  assert.doesNotMatch(overlay, /dominant-baseline/);
  const render = js.match(/async function renderTextAnnotationPng\([\s\S]*?\n\}/)?.[0] || "";
  assert.match(render, /if \(annotation\.watermark\) \{[\s\S]*?textAlign = "center"[\s\S]*?textBaseline = "alphabetic"[\s\S]*?fillText\(annotation\.text, width \/ 2, height \/ 2 \+ watermarkBaselineOffset\(annotation\)\)/);
  assert.match(render, /const lines = annotation\.watermark \? \[\] :/);
  assert.match(css, /\.watermark-overlay text \{[^}]*white-space:\s*pre;/);
});

test("スタンプは個別編集から開くモーダルで、テンプレートをファイルで保存・読込みし画像注釈として配置する", () => {
  const html = read("index.html"), css = read("app.css"), js = read("app.js");
  assert.match(html, /id="stampBtn"[^>]*aria-label="スタンプ"[^>]*aria-haspopup="dialog"[^>]*aria-controls="stampDialog"[^>]*disabled/);
  assert.match(html, /<dialog id="stampDialog"[^>]*aria-labelledby="stampTitle"/);
  for (const id of ["stampTemplate", "stampText", "stampShape", "stampDateFormat", "stampWidth", "stampHeight",
    "stampColor", "stampBorder", "stampFill", "stampJustify", "stampDividers", "stampName", "stampPreview"])
    assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(html, /<label for="stampText"[^>]*>[^<]*<textarea id="stampText"/);
  assert.match(html, /id="stampTemplateInput" type="file" accept="\.json,application\/json" hidden/);
  // 設定の右にプレビュー・注意書き・状態・配置ボタンを置き、テンプレートの保存・共有だけを折り畳む。
  const dialog = html.slice(html.indexOf('<dialog id="stampDialog"'), html.indexOf("</dialog>", html.indexOf('<dialog id="stampDialog"')));
  const side = dialog.slice(dialog.indexOf('<div class="stamp-side">'), dialog.indexOf('<details id="stampSaveSection" class="stamp-save">'));
  const save = dialog.slice(dialog.indexOf('<details id="stampSaveSection" class="stamp-save">'));
  for (const pattern of [/id="stampPreview"/, /公印・電子印鑑の代わりにはなりません/, /PDFを閉じると、テンプレート一覧と入力内容は消えます/,
    /id="stampStatus"/, /id="stampError"/, /id="stampCancel"/, /id="stampApply"[^>]*type="submit"/])
    assert.match(side, pattern);
  // テンプレート選択も左の設定側に置き、右のプレビューを見出しの直下から使う。
  const settingsStart = dialog.indexOf('<div class="stamp-settings">');
  assert.ok(settingsStart < dialog.indexOf('id="stampTemplate"') && dialog.indexOf('id="stampTemplate"') < dialog.indexOf('id="stampText"'));
  assert.ok(dialog.indexOf('id="stampDividers"') < dialog.indexOf('id="stampShape"'), "文字の配置設定は文字欄の直下");
  assert.ok(dialog.indexOf('id="stampFill"') < dialog.indexOf('<div class="stamp-side">'), "設定→プレビュー・配置の順");
  // メッセージは配置ボタンの下に出し、エラー時にボタンの位置を動かさない。
  assert.ok(side.indexOf('id="stampApply"') < side.indexOf('id="stampStatus"'));
  assert.match(save, /<summary>テンプレートをファイルに保存・共有<\/summary>/);
  for (const pattern of [/id="stampName"/, /id="stampSave"/, /id="stampSaveAll"/, /id="stampSaveAllNote"/, /氏名入りのテンプレートが含まれていないか確認/])
    assert.match(save, pattern);
  assert.match(save, /<\/form>/, "保存欄も同じフォーム内に置く");
  assert.match(js, /\$\("stampName"\)\.addEventListener\("keydown", event => \{[^}]*?event\.key === "Enter" && !event\.isComposing\) event\.preventDefault\(\)/);
  // 狭幅で1列に戻すとき、2列分・2段分の指定も解除して暗黙の列を作らない。
  const narrow = css.slice(css.indexOf("@media (max-width: 480px) {", css.indexOf(".stamp-layout")));
  assert.match(narrow, /^@media \(max-width: 480px\) \{[^@]*\.stamp-fields \.stamp-wide-field, \.stamp-text-group \{ grid-column: auto; grid-row: auto; \}/);
  assert.match(js, /\$\("stampBtn"\)\.disabled = state\.busy \|\| !hasPages \|\| state\.mode !== "edit";/);
  assert.match(js, /addImageAnnotation\(page, asset, \{[^}]*\}, \{ stamp: true \}\)/);
  assert.match(js, /a\.stamp \? "スタンプ" : "挿入画像"/);
  const stamping = js.slice(js.indexOf("const STAMP_PX_PER_PT"), js.indexOf("function renderFigures()"));
  assert.doesNotMatch(stamping, /localStorage|sessionStorage|document\.cookie/);
  // 広い画面では設定欄を3列にし、文字欄は2列分・2段分に抑える。900px以下は1カラムに戻す。
  assert.match(css, /\.stamp-dialog \.stamp-fields \{ grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/);
  assert.match(css, /\.stamp-text-group \{ grid-column: 1 \/ span 2; grid-row: 1 \/ span 2;/);
  assert.match(css, /@media \(max-width: 900px\) \{\s+\.stamp-layout \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  assert.match(js, /\$\("stampSaveSection"\)\.open = false;/);
  // 実寸で配置し、ページより大きい場合は縮小せずに案内する。
  assert.doesNotMatch(stamping, /size\.width \* 0\.9/);
  assert.match(stamping, /スタンプがページより大きいため配置できません/);
  // 1件保存とまとめて保存を分け、まとめて保存の対象を事前に表示する。
  assert.match(html, /id="stampSave"[^>]*>このテンプレートを保存</);
  assert.match(html, /id="stampSaveAll"[^>]*>まとめて保存/);
  assert.match(html, /id="stampSaveAllNote"/);
  assert.match(stamping, /serializeStampTemplates\(all \? templates : \[settings\]\)/);
  // PDFを閉じたら読み込んだテンプレートと入力内容を消す。
  assert.match(js, /state\.clipboard = \[\];\s+clearStampSession\(\);/);
});
