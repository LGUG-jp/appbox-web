"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const C = require("../date-core.js");
const rows = C.referenceRows(C.date(2026, 9, 11));
const years = query => C.filterReferenceRows(rows, query).map(row => row.year);

test("早見表は今年から0〜100歳まで。未来の生年・重複・欠落がない", () => {
  assert.equal(C.REFERENCE_MAX_AGE, 100);
  assert.deepEqual(C.REFERENCE_GROUPS.map(group => [...group]), [[0, 34], [35, 69], [70, 100]]);
  assert.equal(rows.length, 101);
  assert.equal(new Set(rows.map(row => row.year)).size, 101);
  assert.equal(rows[0].year, 2026); assert.equal(rows[0].age, 0);
  assert.equal(rows.at(-1).year, 1926); assert.equal(rows.at(-1).age, 100);
  for (let i = 0; i < rows.length; i++) {
    assert.equal(rows[i].year, 2026 - i); assert.equal(rows[i].age, i);
    assert.ok(rows[i].eras.length > 0);
  }
});

test("年齢は今年迎える年齢。同じ年の月日では変わらず、年越しで更新", () => {
  const age1990 = date => C.referenceRows(date).find(row => row.year === 1990).age;
  assert.equal(age1990(C.date(2026, 1, 1)), 36);
  assert.equal(age1990(C.date(2026, 12, 31)), 36);
  assert.equal(age1990(C.date(2027, 1, 1)), 37);
});

test("改元年は検索用に両元号を保持し、一覧表示はデフォルトで新元号の元年、オプションで旧元号も併記する", () => {
  for (const [year, labels, displayed, both] of [
    [1926, ["大正15年", "昭和元年"], "昭和元年", "大正15年 ／ 昭和元年"],
    [1989, ["昭和64年", "平成元年"], "平成元年", "昭和64年 ／ 平成元年"],
    [2019, ["平成31年", "令和元年"], "令和元年", "平成31年 ／ 令和元年"]
  ]) {
    const row = rows.find(item => item.year === year);
    assert.deepEqual(row.eras.map(era => era.label), labels);
    assert.equal(C.referenceEra(row).label, displayed);
    assert.equal(C.referenceEra(row, false).label, displayed);
    assert.equal(C.referenceEra(row, true).label, both);
    assert.equal(C.referenceEra(row, true).isCombined, true);
    assert.equal(C.referenceEra(row, true).eras.length, 2);
  }
  assert.equal(C.referenceEra(rows[0]).label, "令和8年");
  assert.equal(C.referenceEra(rows[0], true).label, "令和8年");
  assert.equal(C.referenceEra(rows[0], true).isCombined, undefined);
});

test("西暦と年齢の数値は区別し、部分一致で別の年を混ぜない", () => {
  for (const query of ["1990", "1990年", "西暦1990年", "１９９０", "36", "36歳", "３６才"]) {
    assert.deepEqual(years(query), [1990]);
  }
  assert.deepEqual(years("0歳"), [2026]);
  assert.deepEqual(years("100"), [1926]);
  assert.deepEqual(years("101歳"), []);
});

test("元年・1年・英字略称・全角・空白入りの和暦を検索できる", () => {
  for (const query of ["平成元年", "平成1年", "H1", "ｈ１", " 平成 元 年 ", "昭和64", "S64"]) {
    assert.deepEqual(years(query), [1989]);
  }
  for (const query of ["令和元年", "R1", "平成31年", "H31"]) assert.deepEqual(years(query), [2019]);
  assert.deepEqual(years("平成2"), [1990]);
  assert.deepEqual(years("令和0"), []);
  assert.deepEqual(years("昭和65"), []);
});

test("元号だけの絞り込みと解除。該当なしやHTML文字列も安全に空結果", () => {
  assert.deepEqual(years("平成"), Array.from({ length: 31 }, (_, i) => 2019 - i));
  assert.deepEqual(years("h"), years("平成"));
  assert.equal(years("").length, 101);
  assert.equal(years("　 ").length, 101);
  for (const query of ["3000", "明治元年", "不明", "<img src=x>", "-1", "1.5", "1e2"]) {
    assert.deepEqual(years(query), []);
  }
});

test("対応下限より古い年を作らず、範囲外の日付は拒否する", () => {
  const earliest = C.referenceRows(C.date(1873, 1, 1));
  assert.equal(earliest.length, 1);
  assert.deepEqual(earliest[0].eras.map(era => era.label), ["明治6年"]);
  assert.equal(C.referenceRows(C.date(2099, 12, 31)).at(-1).year, 1999);
  for (const year of [1872, 2100]) assert.throws(() => C.referenceRows({ year, month: 1, day: 1 }));
});
