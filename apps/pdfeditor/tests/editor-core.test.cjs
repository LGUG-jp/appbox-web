const test = require("node:test");
const assert = require("node:assert/strict");
const core = import("../editor-core.mjs");
const pages = "abcdef".split("").map((id) => ({ id }));
test("大小切替では大だけ解像度を上げ、小・中はサムネイル描画を再利用できる", async () => {
  const { thumbnailRasterSize } = await core;
  assert.deepEqual(thumbnailRasterSize("small"), thumbnailRasterSize("medium"));
  assert.deepEqual(thumbnailRasterSize("large"), { width: 210, height: 296 });
  assert.deepEqual(thumbnailRasterSize("unknown"), thumbnailRasterSize("medium"));
});
test("矢印キーの列数は余白を含む推定幅でなく実際の行配置に従う", async () => {
  const { thumbnailColumns } = await core;
  assert.equal(thumbnailColumns([]), 1);
  assert.equal(thumbnailColumns([{ offsetTop: 20 }]), 1);
  assert.equal(thumbnailColumns([20, 20, 20, 240, 240].map((offsetTop) => ({ offsetTop }))), 3);
  assert.equal(thumbnailColumns([20, 20, 20].map((offsetTop) => ({ offsetTop }))), 3);
  assert.equal(thumbnailColumns([20, 180, 340].map((offsetTop) => ({ offsetTop }))), 1);
});
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
test("重ね順は離れた複数選択を互いの順序を保って最前面／最背面へ移す", async () => {
  const { reorderAnnotations } = await core;
  const annotations = "abcdef".split("").map((id) => ({ id, x: 10, y: 20 }));
  const original = structuredClone(annotations);
  const front = reorderAnnotations(annotations, ["d", "b"], "front"),
    back = reorderAnnotations(annotations, ["d", "b"], "back");
  assert.equal(front.map((a) => a.id).join(""), "acefbd");
  assert.equal(back.map((a) => a.id).join(""), "bdacef");
  assert.equal(front[4], annotations[1]);
  assert.equal(back[1], annotations[3]);
  assert.deepEqual(annotations, original);
});

test("重ね順の空選択・全選択・端の選択・不正な移動は元の配列を返す", async () => {
  const { reorderAnnotations } = await core;
  const annotations = "abcd".split("").map((id) => ({ id }));
  for (const [ids, position] of [
    [[], "front"], [["missing"], "back"], [["a", "b", "c", "d"], "front"],
    [["c", "d"], "front"], [["a", "b"], "back"], [["b"], "unknown"],
  ]) assert.equal(reorderAnnotations(annotations, ids, position), annotations);
  assert.deepEqual(reorderAnnotations(annotations, ["missing", "b", "b"], "back").map((a) => a.id), ["b", "a", "c", "d"]);
  const empty = [];
  assert.equal(reorderAnnotations(empty, [], "front"), empty);
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

test("Shift・Ctrl作図用の比率固定は正方形・真円の外接矩形をページ内に収める", async () => {
  const { drawingBox } = await core;
  assert.deepEqual(
    drawingBox(
      { x: 100, y: 100 },
      { x: 180, y: 140 },
      { width: 500, height: 500 },
      false,
    ),
    { x: 100, y: 100, w: 80, h: 40 },
  );
  assert.deepEqual(
    drawingBox(
      { x: 100, y: 100 },
      { x: 180, y: 140 },
      { width: 500, height: 500 },
      true,
    ),
    { x: 100, y: 100, w: 80, h: 80 },
  );
  assert.deepEqual(
    drawingBox(
      { x: 100, y: 100 },
      { x: 20, y: 60 },
      { width: 500, height: 500 },
      true,
    ),
    { x: 20, y: 20, w: 80, h: 80 },
  );
  assert.deepEqual(
    drawingBox(
      { x: 480, y: 480 },
      { x: 500, y: 490 },
      { width: 500, height: 500 },
      true,
    ),
    { x: 480, y: 480, w: 20, h: 20 },
  );
});

test("Shift・Ctrlリサイズ用の比率固定は元の縦横比を保ちページ内へ収める", async () => {
  const { resizeBox } = await core;
  const original = { x: 100, y: 100, w: 160, h: 80 };
  assert.deepEqual(
    resizeBox(original, 40, 10, { width: 500, height: 500 }, false),
    { w: 200, h: 90 },
  );
  assert.deepEqual(
    resizeBox(original, 40, 10, { width: 500, height: 500 }, true),
    { w: 200, h: 100 },
  );
  assert.deepEqual(
    resizeBox(original, -120, -20, { width: 500, height: 500 }, true),
    { w: 40, h: 20 },
  );
  assert.deepEqual(
    resizeBox(
      { x: 450, y: 450, w: 40, h: 20 },
      100,
      100,
      { width: 500, height: 500 },
      true,
    ),
    { w: 50, h: 25 },
  );
});

test("細い図形の比率固定リサイズは最小サイズと競合してもページ外へ出ない", async () => {
  const { resizeBox } = await core;
  const size = { width: 500, height: 500 };
  for (const original of [
    { x: 400, y: 100, w: 100, h: 5 },
    { x: 100, y: 400, w: 5, h: 100 },
    { x: 495, y: 495, w: 5, h: 5 },
  ]) {
    for (const delta of [100, -100]) {
      const resized = resizeBox(original, delta, delta, size, true);
      assert.ok(original.x + resized.w <= size.width);
      assert.ok(original.y + resized.h <= size.height);
      assert.ok(Math.abs(resized.w / resized.h - original.w / original.h) < 1e-10);
    }
  }
  assert.deepEqual(resizeBox({ x: 100, y: 100, w: 100, h: 5 }, -100, -100, size, true), { w: 160, h: 8 });
  assert.deepEqual(resizeBox({ x: 495, y: 495, w: 5, h: 5 }, 100, 100, size), { w: 5, h: 5 });
});


test("Ctrlで線・矢印の端点を水平または垂直に固定する", async () => {
  const { constrainedLinePoint } = await core;
  const anchor = { x: 100, y: 100 };

  assert.deepEqual(
    constrainedLinePoint(anchor, { x: 180, y: 130 }, false),
    { x: 180, y: 130 },
  );
  assert.deepEqual(
    constrainedLinePoint(anchor, { x: 180, y: 130 }, true),
    { x: 180, y: 100 },
  );
  assert.deepEqual(
    constrainedLinePoint(anchor, { x: 130, y: 190 }, true),
    { x: 100, y: 190 },
  );
  assert.deepEqual(
    constrainedLinePoint(anchor, { x: 20, y: 60 }, true),
    { x: 20, y: 100 },
  );
  assert.deepEqual(
    constrainedLinePoint(anchor, { x: 60, y: 10 }, true),
    { x: 100, y: 10 },
  );
  assert.deepEqual(
    constrainedLinePoint(anchor, { x: 150, y: 150 }, true),
    { x: 150, y: 100 },
  );
});

test("Shiftで既存の線・矢印の角度を保ったまま端点を伸縮する", async () => {
  const { angleLockedLinePoint } = await core;
  const anchor = { x: 100, y: 100 },
    originalPoint = { x: 160, y: 130 };

  assert.deepEqual(
    angleLockedLinePoint(anchor, originalPoint, { x: 220, y: 100 }),
    { x: 196, y: 148 },
  );
  assert.deepEqual(
    angleLockedLinePoint(anchor, originalPoint, { x: 0, y: 100 }),
    anchor,
  );
  assert.deepEqual(
    angleLockedLinePoint(
      anchor,
      originalPoint,
      { x: 400, y: 250 },
      { width: 200, height: 200 },
    ),
    { x: 200, y: 150 },
  );
  assert.deepEqual(
    angleLockedLinePoint(anchor, anchor, { x: 140, y: 180 }),
    { x: 140, y: 180 },
  );
});
