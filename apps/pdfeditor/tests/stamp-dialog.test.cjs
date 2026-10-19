const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { pathToFileURL } = require("node:url");

const stampModule = import(pathToFileURL(path.resolve(__dirname, "../stamp.mjs")).href);
const source = fs.readFileSync(path.join(__dirname, "../app.js"), "utf8");
const section = source.slice(source.indexOf("const STAMP_PX_PER_PT"), source.indexOf("function renderFigures()"));

class Option { constructor(text, value) { this.text = text; this.value = value; } }

function element(extra = {}) {
  // Copy descriptors so getters/setters in extra stay live instead of being evaluated once.
  const base = {
    value: "", textContent: "", disabled: false, checked: false, open: true, files: null, dataset: {},
    children: [], replaceChildren(...children) { this.children = children; }, append() {},
    addEventListener() {}, setAttribute() {}, focus() {}, click() {}, remove() {},
    showModal() { this.open = true; }, close() { this.open = false; },
    get valueAsNumber() { return this.value === "" ? NaN : Number(this.value); },
  };
  return Object.defineProperties(base, Object.getOwnPropertyDescriptors(extra));
}

function select() {
  let value = "";
  return element({
    get options() { return this.children.flatMap(group => group.children || [group]); },
    get value() { return value; },
    set value(next) { value = this.options.some(option => option.value === next) ? next : ""; },
    replaceChildren(...children) { this.children = children; value = ""; },
  });
}

async function fixture({ page = { id: "p", annotations: [] }, pageSize = { width: 595, height: 842 } } = {}) {
  const mod = await stampModule;
  const ids = ["stampText", "stampName", "stampShape", "stampWidth", "stampHeight", "stampDateFormat", "stampColor",
    "stampBorder", "stampFill", "stampJustify", "stampDividers", "stampPreview", "stampStatus", "stampError",
    "stampSaveAll", "stampSaveAllNote", "stampApply", "stampSave", "stampDialog", "stampTemplateInput", "stampBtn",
    "stampSaveSection"];
  const els = Object.fromEntries(ids.map(id => [id, element()]));
  els.stampTemplate = select();
  els.stampForm = element({ reset() { for (const id of ["stampText", "stampName", "stampWidth", "stampHeight"]) els[id].value = ""; } });
  const downloads = [], placed = [], toasts = [];
  const ctx = vm.createContext({
    ...mod, Option, Blob, setTimeout,
    URL: { createObjectURL: blob => { downloads.push(blob); return "blob:test"; }, revokeObjectURL() {} },
    document: {
      body: { append() {} },
      createElement: tag => tag === "optgroup"
        ? { label: "", children: [], append(...options) { this.children.push(...options); } }
        : element(),
    },
    state: { busy: false, mode: "edit" },
    $: id => els[id],
    currentPage: () => page,
    pageDisplaySize: () => pageSize,
    finishTextEditing() {}, setBusy(on) { ctx.state.busy = on; },
    showToast: (message, error) => toasts.push({ message, error }),
    addImageAnnotation: (target, asset, box, extra) => placed.push({ target, box, extra }),
    fontStackFor: () => "sans-serif", DEFAULT_FONT_FAMILY: "yu-gothic-ui",
  });
  vm.runInContext(section, ctx);
  // Canvas drawing is covered in the browser; here only the layout size matters.
  ctx.drawStampCanvas = settings => {
    const layout = mod.layoutStamp(settings, mod.expandStampLines(settings.lines, new Date(2026, 9, 6), settings.dateFormat),
      (text, size) => [...text].length * size);
    return { layout, canvas: element({ width: 1, height: 1, toBlob: done => done(new Blob(["png"], { type: "image/png" })) }) };
  };
  vm.runInContext("stampTargetPageId = currentPage().id;", ctx);
  vm.runInContext("renderStampTemplateOptions('preset:5'); applyStampTemplate(selectedStampTemplate());", ctx);
  const names = async blob => JSON.parse(await blob.text()).templates.map(template => template.name);
  return { ctx, els, downloads, placed, toasts, names, mod };
}

test("テンプレート読込みの途中でPDFを閉じると、読込み結果で一覧や入力を復活させない", async () => {
  const { ctx, els, mod } = await fixture();
  let finish;
  const json = mod.serializeStampTemplates([{ ...mod.STAMP_PRESETS[6], name: "個人 山田", lines: ["総務課", "{date}", "山田"] }]);
  els.stampTemplateInput.files = [{ size: json.length, text: () => new Promise(resolve => { finish = resolve; }) }];
  const loading = ctx.loadStampTemplates();
  ctx.clearStampSession();
  finish(json);
  await loading;
  assert.equal(vm.runInContext("stampTemplates.length", ctx), 0);
  assert.equal(els.stampText.value, "");
  assert.equal(els.stampStatus.textContent, "");
  assert.equal(els.stampTemplate.options.length, 0);
  // 次のPDFでは保存欄を閉じた状態から始め、通常の画面高で縦スクロールなしに収める。
  assert.equal(els.stampSaveSection.open, false);
});

test("読込み中にPDFを閉じた後で読込みが失敗しても、エラー表示を復活させない", async () => {
  const { ctx, els } = await fixture();
  let fail;
  els.stampTemplateInput.files = [{ size: 10, text: () => new Promise((_, reject) => { fail = reject; }) }];
  const loading = ctx.loadStampTemplates();
  ctx.clearStampSession();
  fail(new Error("共有フォルダに接続できません"));
  await loading;
  assert.equal(els.stampError.textContent, "");
});

test("一覧が50件でも「このテンプレートを保存」は1件だけ出力し、「まとめて保存」は上限を案内する", async () => {
  const { ctx, els, downloads, names, mod } = await fixture();
  const fifty = Array.from({ length: 50 }, (_, i) => ({ ...mod.STAMP_PRESETS[3], name: `t${i}` }));
  vm.runInContext(`stampTemplates = ${JSON.stringify(fifty)};`, ctx);
  els.stampName.value = "新しい受付";
  ctx.saveStampTemplates(false);
  assert.equal(els.stampError.textContent, "");
  assert.deepEqual(await names(downloads.at(-1)), ["新しい受付"]);
  assert.match(els.stampStatus.textContent, /一覧には追加していません/);
  assert.equal(vm.runInContext("stampTemplates.length", ctx), 50);
  const count = downloads.length;
  ctx.saveStampTemplates(true);
  assert.equal(downloads.length, count);
  assert.match(els.stampError.textContent, /50件まで/);
});

test("まとめて保存は事前表示した対象と同じ内容を出力し、1件保存は表示中の1件だけを出力する", async () => {
  const { ctx, els, downloads, names } = await fixture();
  els.stampName.value = "個人 山田";
  ctx.saveStampTemplates(false);
  els.stampName.value = "共有 受付";
  ctx.syncStampSaveAll(ctx.readStampSettingsOrNull());
  assert.equal(els.stampSaveAll.disabled, false);
  assert.equal(els.stampSaveAllNote.textContent, "まとめて保存の対象：個人 山田、共有 受付");
  ctx.saveStampTemplates(false);
  assert.deepEqual(await names(downloads.at(-1)), ["共有 受付"]);
  ctx.saveStampTemplates(true);
  assert.deepEqual(await names(downloads.at(-1)), ["個人 山田", "共有 受付"]);
  // 同名で内容を変えて保存し直すと、まとめて保存にも新しい内容が入る。
  els.stampText.value = "受付済";
  els.stampColor.value = "#000000";
  ctx.saveStampTemplates(true);
  const saved = JSON.parse(await downloads.at(-1).text()).templates;
  assert.deepEqual(saved.map(template => [template.name, template.lines.join("/"), template.color]),
    [["個人 山田", "受付/{date}", "#d7261e"], ["共有 受付", "受付済", "#000000"]]);
});

test("ページより大きいスタンプは縮小せず配置を拒否し、直した後は実寸で配置する", async () => {
  const { ctx, els, placed, mod } = await fixture({ pageSize: { width: 150, height: 150 } });
  els.stampWidth.value = "60";
  await ctx.placeStamp({ preventDefault() {} });
  assert.equal(placed.length, 0);
  assert.equal(els.stampDialog.open, true);
  assert.match(els.stampError.textContent, /ページより大きい/);
  assert.equal(ctx.state.busy, false);
  els.stampWidth.value = "30";
  ctx.previewStamp();
  assert.equal(els.stampError.textContent, "");
  assert.equal(els.stampApply.disabled, false);
  await ctx.placeStamp({ preventDefault() {} });
  assert.equal(placed.length, 1);
  assert.equal(els.stampDialog.open, false);
  assert.ok(Math.abs(placed[0].box.w - 30 * mod.MM_TO_PT) < 1e-9);
  assert.ok(Math.abs(placed[0].box.h - 18 * mod.MM_TO_PT) < 1e-9);
  assert.equal(placed[0].extra.stamp, true);
});
