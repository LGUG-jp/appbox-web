const test = require("node:test");
const assert = require("node:assert/strict");
const core = import("../editor-core.mjs");
const pages = "abcdef".split("").map((id) => ({ id }));
test("離れたページを相対順序を保って前後の挿入位置へ移動する", async () => {
  const { movePages } = await core;
  assert.equal(
    movePages(pages, ["b", "d"], "f", true)
      .map((p) => p.id)
      .join(""),
    "acefbd",
  );
  assert.equal(
    movePages(pages, ["b", "d"], "a")
      .map((p) => p.id)
      .join(""),
    "bdacef",
  );
  assert.equal(movePages(pages, ["b", "d"], "d"), pages);
  assert.equal(pages.map((p) => p.id).join(""), "abcdef");
});
test("前後移動は境界を越えず離れた選択も一段ずつ移動する", async () => {
  const { stepPages } = await core;
  assert.equal(
    stepPages(pages, ["a", "c", "d"], -1)
      .map((p) => p.id)
      .join(""),
    "acdbef",
  );
  assert.equal(
    stepPages(pages, ["a", "c", "d"], 1)
      .map((p) => p.id)
      .join(""),
    "baecdf",
  );
  assert.equal(
    stepPages(
      pages,
      pages.map((p) => p.id),
      1,
    )
      .map((p) => p.id)
      .join(""),
    "abcdef",
  );
});
test("Shift選択は逆方向でもアンカーからの連続範囲を返す", async () => {
  const { rangeIds } = await core;
  assert.deepEqual(rangeIds(pages, "e", "b"), ["b", "c", "d", "e"]);
  assert.deepEqual(rangeIds(pages, "missing", "c"), ["c"]);
});
test("図形と複数行マーカーを4回回転すると元の位置へ戻る", async () => {
  const { rotateAnnotation } = await core;
  const examples = [
    { type: "rect", x: 15, y: 20, w: 30, h: 40 },
    { type: "ellipse", x: 25, y: 70, w: 80, h: 90 },
    { type: "line", x1: 10, y1: 20, x2: 40, y2: 50 },
    { type: "arrow", x1: 100, y1: 20, x2: 20, y2: 150 },
    {
      type: "highlight",
      rects: [
        { x: 12, y: 30, w: 80, h: 14 },
        { x: 12, y: 50, w: 50, h: 14 },
      ],
    },
  ];
  for (const a of examples) {
    const original = structuredClone(a);
    let size = { width: 595, height: 842 };
    for (let i = 0; i < 4; i++) {
      rotateAnnotation(a, size, 90);
      size = { width: size.height, height: size.width };
    }
    assert.deepEqual(a, original);
    rotateAnnotation(a, size, 90);
    rotateAnnotation(a, { width: 842, height: 595 }, -90);
    assert.deepEqual(a, original);
  }
});
test("複数行マーカーの移動は行間を変えず全範囲を更新する", async () => {
  const { bounds, translate } = await core;
  const a = {
    type: "highlight",
    rects: [
      { x: 10, y: 10, w: 100, h: 12 },
      { x: 10, y: 30, w: 40, h: 12 },
    ],
  };
  translate(a, 5, 7);
  assert.deepEqual(bounds(a), { x: 15, y: 17, w: 100, h: 32 });
  assert.deepEqual(a.rects[1], { x: 15, y: 37, w: 40, h: 12 });
});
test("文字選択の矩形は倍率を戻し重複・空矩形を除きページ内に収める", async () => {
  const { selectionRects } = await core;
  const r = { left: 120, top: 240, right: 220, bottom: 270 };
  assert.deepEqual(
    selectionRects(
      [r, r, { left: 150, top: 270, right: 150, bottom: 300 }],
      { left: 100, top: 200 },
      2,
      { width: 595, height: 842 },
    ),
    [{ x: 10, y: 20, w: 50, h: 15 }],
  );
  assert.deepEqual(
    selectionRects(
      [{ left: 90, top: 190, right: 1400, bottom: 2000 }],
      { left: 100, top: 200 },
      2,
      { width: 595, height: 842 },
    ),
    [{ x: 0, y: 0, w: 595, h: 842 }],
  );
});
test("同じ行の重複マーカー矩形を統合し、離れた範囲は分けて保持する", async () => {
  const { selectionRects } = await core;
  const result = selectionRects(
    [
      { left: 10, top: 10, right: 70, bottom: 24 },
      { left: 60, top: 10.4, right: 110, bottom: 24.2 },
      { left: 130, top: 10.2, right: 170, bottom: 24.1 },
    ],
    { left: 0, top: 0 },
    1,
    { width: 300, height: 300 },
  );
  assert.equal(result.length, 2);
  assert.ok(Math.abs(result[0].x - 10) < 0.001);
  assert.ok(Math.abs(result[0].w - 100) < 0.001);
  assert.ok(Math.abs(result[1].x - 130) < 0.001);
  assert.ok(Math.abs(result[1].w - 40) < 0.001);
});
test("隣接行のわずかな縦重複は境界を分け、半透明マーカーの濃い筋を作らない", async () => {
  const { selectionRects } = await core;
  const result = selectionRects(
    [
      { left: 10, top: 10, right: 100, bottom: 24 },
      { left: 10, top: 23, right: 95, bottom: 37 },
    ],
    { left: 0, top: 0 },
    1,
    { width: 300, height: 300 },
  );
  assert.equal(result.length, 2);
  assert.ok(Math.abs(result[0].y + result[0].h - result[1].y) < 0.001);
});
test("履歴復元の再描画判定は注釈差分を再ラスタライズ扱いにしない", async () => {
  const { samePageRaster, samePageLayout } = await core;
  const copy = (value) => JSON.parse(JSON.stringify(value));
  const before = {
    id: "page-1",
    sourceId: "source-1",
    sourceIndex: 0,
    baseRotation: 0,
    rotationExtra: 0,
    annotations: [],
  };
  const afterAnnotation = {
    ...copy(before),
    annotations: [{ id: "ann-1", type: "rect" }],
  };
  assert.equal(samePageRaster(before, afterAnnotation), true);
  assert.equal(samePageLayout([before], [afterAnnotation]), true);
  const afterRotation = { ...copy(before), rotationExtra: 90 };
  assert.equal(samePageRaster(before, afterRotation), false);
  assert.equal(samePageLayout([before], [afterRotation]), false);
  const page2 = { ...copy(before), id: "page-2", sourceIndex: 1 };
  assert.equal(samePageLayout([before, page2], [page2, before]), false);
});
test("詳細設定の移動先を4隅に限定する", async () => {
  const { nearestCorner } = await core;
  assert.equal(nearestCorner(10, 10, 100, 80), "top-left");
  assert.equal(nearestCorner(90, 10, 100, 80), "top-right");
  assert.equal(nearestCorner(10, 70, 100, 80), "bottom-left");
  assert.equal(nearestCorner(90, 70, 100, 80), "bottom-right");
});
