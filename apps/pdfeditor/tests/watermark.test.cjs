const test = require("node:test");
const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");
const path = require("node:path");

const modulePromise = import(pathToFileURL(path.resolve(__dirname, "../watermark.mjs")).href);
const measure = (text, size) => text.length * size * 0.7;
const page = (extra = {}) => ({
  id: "p1", width: 595, height: 842, baseRotation: 0, rotationExtra: 0, annotations: [], ...extra,
});

test("プリセットは庁内向け7種を提供する", async () => {
  const { WATERMARK_PRESETS } = await modulePromise;
  assert.deepEqual(WATERMARK_PRESETS, ["取扱注意", "部外秘", "庁内限り", "案", "参考", "見本", "DRAFT"]);
});

test("透かしは表示ページ中央に配置し、回転ページにも追随する", async () => {
  const { watermarkAnnotation } = await modulePromise;
  const watermark = { text: "庁内限り", color: "#6b7280", opacity: 0.2, fontSize: 72, angle: -45 };
  const normal = watermarkAnnotation(page({ watermark }), measure);
  const rotated = watermarkAnnotation(page({ watermark, rotationExtra: 90 }), measure);
  assert.equal(normal.watermark, true);
  assert.equal(normal.rotation, -45);
  assert.equal(normal.opacity, 0.2);
  assert.ok(Math.abs((normal.x + normal.w / 2) - 595 / 2) < 0.001);
  assert.ok(Math.abs((normal.y + normal.h / 2) - 842 / 2) < 0.001);
  assert.ok(Math.abs((rotated.x + rotated.w / 2) - 842 / 2) < 0.001);
  assert.ok(Math.abs((rotated.y + rotated.h / 2) - 595 / 2) < 0.001);
});

test("全ページと選択ページを分けて一括適用できる", async () => {
  const { createWatermarkPlan, replaceWatermarks } = await modulePromise;
  const pages = [page({ id: "p1" }), page({ id: "p2" }), page({ id: "p3" })];
  const settings = { text: "DRAFT", color: "#6b7280", opacity: 0.2, fontSize: 72, angle: -45, scope: "selected" };
  const plan = createWatermarkPlan(pages, new Set(["p1", "p3"]), settings, measure);
  assert.equal(plan.count, 2);
  const applied = replaceWatermarks(pages, plan);
  assert.equal(applied[0].watermark.text, "DRAFT");
  assert.equal(applied[1].watermark, undefined);
  assert.equal(applied[2].watermark.text, "DRAFT");
});

test("対象ページだけ透かしを削除する", async () => {
  const { removeWatermarks } = await modulePromise;
  const wm = { text: "案", color: "#6b7280", opacity: 0.2, fontSize: 72, angle: -45 };
  const pages = [page({ id: "p1", watermark: wm }), page({ id: "p2", watermark: wm })];
  const removed = removeWatermarks(pages, ["p2"]);
  assert.equal(removed[0].watermark.text, "案");
  assert.equal(removed[1].watermark, undefined);
});

test("不正な値と用紙外へのはみ出しを拒否する", async () => {
  const { createWatermarkPlan } = await modulePromise;
  const base = { text: "案", color: "#6b7280", opacity: 0.2, fontSize: 72, angle: -45, scope: "all" };
  assert.throws(() => createWatermarkPlan([page()], [], { ...base, opacity: 0.05 }, measure), /10〜80%/);
  assert.throws(() => createWatermarkPlan([page()], [], { ...base, angle: 30 }, measure), /角度/);
  assert.throws(() => createWatermarkPlan([page()], [], { ...base, text: "X".repeat(40), fontSize: 120 }, measure), /収まりません/);
});


test("角度selectのvalueを数値化してreadWatermarkPlanへ渡す", async () => {
  const fs = require("node:fs");
  const vm = require("node:vm");
  const { createWatermarkPlan } = await modulePromise;
  const app = fs.readFileSync(path.resolve(__dirname, "../app.js"), "utf8");
  const start = app.indexOf("function readWatermarkPlan()");
  const end = app.indexOf("let watermarkPreviewToken", start);
  assert.ok(start >= 0 && end > start);
  const elements = {
    watermarkText: { value: "庁内限り" },
    watermarkColor: { value: "#6b7280" },
    watermarkOpacity: { valueAsNumber: 20 },
    watermarkFontSize: { valueAsNumber: 72 },
    // HTMLSelectElementにはvalueAsNumberがない。
    watermarkAngle: { value: "-45" },
  };
  const context = vm.createContext({
    state: { pages: [page()], pageSelection: new Set(["p1"]) },
    $: id => elements[id],
    createWatermarkPlan,
    measureWatermarkText: measure,
    selectedWatermarkScope: () => "all",
  });
  vm.runInContext(app.slice(start, end), context);
  const plan = vm.runInContext("readWatermarkPlan()", context);
  assert.equal(plan.entries[0].watermark.angle, -45);
});
