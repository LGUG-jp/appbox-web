const test = require("node:test");
const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");
const path = require("node:path");

const modulePromise = import(pathToFileURL(path.resolve(__dirname, "../stamp.mjs")).href);
// Full-width glyphs are one em wide; ASCII digits and punctuation are narrower.
const measure = (text, size) => [...text].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 0xff ? size : size * 0.55), 0);
const base = {
  name: "テスト", shape: "rect", widthMm: 30, heightMm: 18, lines: ["受付", "{date}"],
  dateFormat: "seireki", color: "#D7261E", borderWidth: 1.5, fill: "none", justify: false, dividers: false,
};

test("既定のスタンプは庁内でよく使う7種を提供し、すべて検証を通る", async () => {
  const { STAMP_PRESETS, normalizeStampSettings } = await modulePromise;
  assert.deepEqual(STAMP_PRESETS.map(p => p.name),
    ["承認", "確認", "済", "回覧", "至急", "受付（日付）", "日付印（所属・氏名）"]);
  for (const preset of STAMP_PRESETS) assert.doesNotThrow(() => normalizeStampSettings(preset));
});

test("日付は西暦・和暦・和暦（漢字）で展開し、元年と改元日を扱う", async () => {
  const { formatStampDate, expandStampLines } = await modulePromise;
  const date = new Date(2026, 9, 6);
  assert.equal(formatStampDate(date, "seireki"), "2026.10.06");
  assert.equal(formatStampDate(date, "wareki"), "R8.10.6");
  assert.equal(formatStampDate(date, "wareki-kanji"), "令和8年10月6日");
  assert.equal(formatStampDate(new Date(2019, 4, 1), "wareki-kanji"), "令和元年5月1日");
  assert.equal(formatStampDate(new Date(2019, 3, 30), "wareki"), "H31.4.30");
  assert.deepEqual(expandStampLines(["受付", "{date}"], date, "seireki"), ["受付", "2026.10.06"]);
  assert.throws(() => formatStampDate(date, "unknown"), /書式/);
});

test("入力を正規化し、行数・文字数・サイズ・色・太さの不正を拒否する", async () => {
  const { normalizeStampSettings } = await modulePromise;
  const normalized = normalizeStampSettings({ ...base, lines: [" 受付 ", "{date}"], extra: "ignored" });
  assert.deepEqual(normalized.lines, ["受付", "{date}"]);
  assert.equal(normalized.color, "#d7261e");
  assert.equal("extra" in normalized, false);
  assert.throws(() => normalizeStampSettings({ ...base, lines: ["a", "b", "c", "d"] }), /3行以内/);
  assert.throws(() => normalizeStampSettings({ ...base, lines: ["", " "] }), /文字を入力/);
  assert.throws(() => normalizeStampSettings({ ...base, lines: ["あ".repeat(21)] }), /20文字以内/);
  assert.throws(() => normalizeStampSettings({ ...base, widthMm: 7 }), /8〜60mm/);
  assert.throws(() => normalizeStampSettings({ ...base, color: "red" }), /色/);
  assert.throws(() => normalizeStampSettings({ ...base, borderWidth: 9 }), /太さ/);
  assert.throws(() => normalizeStampSettings({ ...base, shape: "star" }), /形/);
});

test("行ごとに文字サイズを調整し、すべての文字を図形の内側へ収める", async () => {
  const { layoutStamp, MM_TO_PT } = await modulePromise;
  const settings = { ...base, lines: ["受付", "2026.10.06"] };
  const layout = layoutStamp(settings, settings.lines, measure);
  assert.ok(Math.abs(layout.width - 30 * MM_TO_PT) < 1e-9);
  assert.equal(layout.rows.length, 2);
  for (const row of layout.rows) {
    const last = row.chars.at(-1);
    const right = last.x + measure(last.ch, row.fontSize);
    assert.ok(row.chars[0].x >= layout.inset - 1e-6, "左端が枠の内側");
    assert.ok(right <= layout.width - layout.inset + 1e-6, "右端が枠の内側");
    assert.ok(Math.abs((row.chars[0].x + right) / 2 - layout.width / 2) < 1e-6, "中央揃え");
  }
  assert.notEqual(layout.rows[0].fontSize, layout.rows[1].fontSize);
});

test("丸では上下の行ほど幅が狭くなるよう縮め、区切り線を楕円の内側へ引く", async () => {
  const { layoutStamp } = await modulePromise;
  const settings = { ...base, shape: "ellipse", widthMm: 18, heightMm: 18, lines: ["総務課", "R8.10.6", "山田"], dividers: true };
  const layout = layoutStamp(settings, settings.lines, measure);
  const cx = layout.width / 2, cy = layout.height / 2, r = layout.width / 2;
  for (const row of layout.rows) {
    const last = row.chars.at(-1), right = last.x + measure(last.ch, row.fontSize);
    for (const [x, y] of [[row.chars[0].x, row.centerY - row.fontSize / 2], [right, row.centerY + row.fontSize / 2]])
      assert.ok((x - cx) ** 2 + (y - cy) ** 2 <= r * r, `${row.text} は円の内側`);
  }
  assert.equal(layout.dividers.length, 2);
  for (const line of layout.dividers)
    assert.ok((line.x1 - cx) ** 2 + (line.y - cy) ** 2 <= r * r + 1e-6);
});

test("両端揃えは文字間を広げ、収まらない文字は配置せずに案内する", async () => {
  const { layoutStamp } = await modulePromise;
  const wide = { ...base, widthMm: 40, heightMm: 12, lines: ["回覧"] };
  const plain = layoutStamp(wide, wide.lines, measure);
  const justified = layoutStamp({ ...wide, justify: true }, wide.lines, measure);
  const last = justified.rows[0].chars.at(-1);
  assert.ok(last.x + measure(last.ch, justified.rows[0].fontSize) <= justified.width - justified.inset);
  const gap = layout => layout.rows[0].chars[1].x - layout.rows[0].chars[0].x;
  assert.ok(gap(justified) > gap(plain));
  const tiny = { ...base, widthMm: 8, heightMm: 8, lines: ["あ".repeat(20)] };
  assert.throws(() => layoutStamp(tiny, tiny.lines, measure), /収まりません/);
});

test("テンプレートは名前付きでファイルへ書き出し、読み込み・同名置換・検証ができる", async () => {
  const { serializeStampTemplates, parseStampTemplates, mergeStampTemplates, STAMP_TEMPLATE_FORMAT } = await modulePromise;
  const json = serializeStampTemplates([{ ...base, name: "総務課受付" }]);
  const parsed = parseStampTemplates(`\uFEFF${json}`);
  assert.equal(parsed[0].name, "総務課受付");
  assert.equal(JSON.parse(json).format, STAMP_TEMPLATE_FORMAT);
  const merged = mergeStampTemplates([{ ...base, name: "A" }, { ...base, name: "B" }], [{ ...base, name: "A", color: "#000000" }]);
  assert.deepEqual(merged.map(t => [t.name, t.color]), [["A", "#000000"], ["B", "#D7261E"]]);
  assert.throws(() => serializeStampTemplates([{ ...base, name: "" }]), /テンプレート名/);
  assert.throws(() => parseStampTemplates("{"), /読み込めません/);
  assert.throws(() => parseStampTemplates(JSON.stringify({ format: "other", templates: [] })), /スタンプテンプレートファイル/);
  assert.throws(() => parseStampTemplates(JSON.stringify({ format: STAMP_TEMPLATE_FORMAT, version: 2, templates: [] })), /バージョン/);
  assert.throws(() => parseStampTemplates(JSON.stringify({ format: STAMP_TEMPLATE_FORMAT, version: 1,
    templates: [{ ...base, name: "ok" }, { ...base, name: "ng", widthMm: 100 }] })), /2件目/);
  assert.throws(() => mergeStampTemplates([], Array.from({ length: 51 }, (_, i) => ({ ...base, name: `t${i}` }))), /50件/);
});

test("丸で最小サイズまで縮めた行は、縮めた後の幅で収まりを判定する", async () => {
  const { layoutStamp } = await modulePromise;
  // 18mm・3行の丸で、先頭行は最小3ptまで縮めて初めて収まる（Codexレビューで再現した境界）。
  const settings = { ...base, shape: "ellipse", widthMm: 18, heightMm: 18, lines: ["あ".repeat(8), "R8.10.6", "山田"] };
  const layout = layoutStamp(settings, settings.lines, measure);
  const row = layout.rows[0], last = row.chars.at(-1);
  assert.equal(row.fontSize, 3);
  const cx = layout.width / 2, cy = layout.height / 2, r = layout.width / 2;
  for (const [x, y] of [[row.chars[0].x, row.centerY - row.fontSize / 2], [last.x + measure(last.ch, row.fontSize), row.centerY - row.fontSize / 2]])
    assert.ok((x - cx) ** 2 + (y - cy) ** 2 <= r * r);
});

test("幅・高さは画面入力と同じ0.5mm刻みだけを受け付ける", async () => {
  const { normalizeStampSettings } = await modulePromise;
  assert.doesNotThrow(() => normalizeStampSettings({ ...base, widthMm: 15.5 }));
  assert.throws(() => normalizeStampSettings({ ...base, widthMm: 15.2 }), /0\.5mm刻み/);
});
