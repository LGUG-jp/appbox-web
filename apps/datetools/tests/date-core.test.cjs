"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const C = require("../date-core.js");
const d = text => C.date(...text.split("-").map(Number));
const current = d("2026-09-11");

// 期待値は元号の定義表から生成せず、境界日の値を明示する。
for (const [iso, era, n, expected] of [
  ["1873-01-01", "meiji", 6, "明治6年1月1日"],
  ["1912-07-29", "meiji", 45, "明治45年7月29日"],
  ["1912-07-30", "taisho", 1, "大正元年7月30日"],
  ["1926-12-24", "taisho", 15, "大正15年12月24日"],
  ["1926-12-25", "showa", 1, "昭和元年12月25日"],
  ["1989-01-07", "showa", 64, "昭和64年1月7日"],
  ["1989-01-08", "heisei", 1, "平成元年1月8日"],
  ["2019-04-30", "heisei", 31, "平成31年4月30日"],
  ["2019-05-01", "reiwa", 1, "令和元年5月1日"],
  ["2099-12-31", "reiwa", 81, "令和81年12月31日"]
]) test(`和暦・西暦の両方向: ${iso}`, () => {
  const value = d(iso);
  assert.equal(C.japanese(value), expected);
  assert.deepEqual(C.fromParts(era, n, value.month, value.day), value);
  assert.equal(C.iso(value), iso);
});

for (const parts of [
  ["meiji", 45, 7, 30], ["taisho", 1, 7, 29],
  ["taisho", 15, 12, 25], ["showa", 1, 12, 24],
  ["showa", 64, 1, 8], ["heisei", 1, 1, 7],
  ["heisei", 31, 5, 1], ["reiwa", 1, 4, 30],
  ["reiwa", 0, 5, 1], ["meiji", 5, 12, 31],
  ["other", 1, 1, 1]
]) test(`存在しない元号の日付を拒否: ${parts.join("/")}`, () => {
  assert.throws(() => C.fromParts(...parts));
});

test("元年・全角数字・前後の空白を受け付ける", () => {
  assert.deepEqual(C.fromParts("reiwa", " 元 ", "５", "０１"), d("2019-05-01"));
  assert.deepEqual(C.fromParts("western", "２０２６", " ９ ", "１１"), current);
});
for (const input of ["", " ", "1e2", "-1", "2.5", "12x", "<1>", "10000", "元"]) {
  test(`不正な西暦の年を拒否: ${JSON.stringify(input)}`, () => assert.throws(() => C.date(input, 1, 1)));
}
for (const value of ["1872-12-31", "2100-01-01", "2025-02-29", "1900-02-29", "2026-04-31", "2026-00-01", "2026-13-01", "2026-01-00", "2026-01-32"]) {
  test(`不正日付・範囲外を拒否: ${value}`, () => assert.throws(() => d(value)));
}
test("グレゴリオ暦の世紀うるう年", () => {
  assert.equal(C.isLeap(1900), false); assert.equal(C.isLeap(2000), true); assert.equal(C.isLeap(2100), false);
  assert.equal(C.iso(d("2000-02-29")), "2000-02-29");
  assert.equal(C.compare(d("2000-03-01"), d("2000-02-28")), 2);
  assert.equal(C.compare(d("1900-03-01"), d("1900-02-28")), 1);
});
test("日付の差は夏時間を含む日でも整数", () => {
  assert.equal(C.compare(d("2026-03-09"), d("2026-03-08")), 1);
  assert.equal(C.compare(d("2026-11-02"), d("2026-11-01")), 1);
});
test("今日の取得には端末のローカル日付を使う", () => {
  assert.deepEqual(C.today(new Date(2026, 8, 11, 0, 1)), current);
});

test("年度は3月31日と4月1日で切り替わる", () => {
  assert.equal(C.fiscalYearFor(d("2026-03-31")), 2025);
  assert.equal(C.fiscalYearFor(d("2026-04-01")), 2026);
  assert.equal(C.fiscalYearFor(d("2027-01-01")), 2026);
  const info = C.fiscalInfo(2026);
  assert.equal(info.label, "令和8年度");
  assert.equal(C.iso(info.start), "2026-04-01");
  assert.equal(C.iso(info.end), "2027-03-31");
  assert.equal(info.days, 365);
});
test("改元年度と暦日の境界を区別する", () => {
  const info = C.fiscalInfo(2019);
  assert.equal(info.label, "令和元年度");
  assert.equal(C.japanese(info.start), "平成31年4月1日");
  assert.equal(C.japanese(info.end), "令和2年3月31日");
  assert.equal(info.days, 366);
});
test("存在しない年度・不正値を拒否", () => {
  assert.throws(() => C.fiscalInfo(1872)); assert.throws(() => C.fiscalInfo(2099));
  assert.equal(C.iso(C.fiscalInfo(1873).start), "1873-04-01");
  assert.equal(C.iso(C.fiscalInfo(2098).end), "2099-03-31");
});

test("誕生日の前日・当日・翌日", () => {
  const birth = d("2000-09-11");
  assert.equal(C.ageAt(birth, d("2026-09-10"), current), 25);
  assert.equal(C.ageAt(birth, current, current), 26);
  assert.equal(C.ageAt(birth, d("2026-09-12"), current), 26);
  const info = C.ageInfo(birth, current, current);
  assert.equal(info.daysUntil, 0); assert.equal(C.iso(info.next), "2026-09-11");
  assert.equal(info.fiscalAge, 26); assert.equal(C.iso(info.fiscal.end), "2027-03-31");
});
test("過去・未来の基準日と次の誕生日", () => {
  const birth = d("2000-09-11");
  const info = C.ageInfo(birth, d("2025-09-12"), current);
  assert.equal(info.age, 25); assert.equal(C.iso(info.next), "2026-09-11"); assert.equal(info.daysUntil, 364);
  assert.equal(C.ageAt(birth, d("2030-09-11"), current), 30);
});
test("4月1日生まれの年度末年齢", () => {
  const a = C.ageInfo(d("2020-04-01"), d("2026-04-01"), current);
  assert.equal(a.age, 6); assert.equal(a.fiscalAge, 6);
  const b = C.ageInfo(d("2020-03-31"), d("2026-04-01"), current);
  assert.equal(b.age, 6); assert.equal(b.fiscalAge, 7);
});
test("2月29日生まれの平年と閏年", () => {
  const birth = d("2000-02-29");
  assert.equal(C.ageAt(birth, d("2025-02-28"), current), 24);
  assert.equal(C.ageAt(birth, d("2025-03-01"), current), 25);
  assert.equal(C.ageAt(birth, d("2024-02-28"), current), 23);
  assert.equal(C.ageAt(birth, d("2024-02-29"), current), 24);
  const a = C.ageInfo(birth, d("2025-02-28"), current);
  assert.equal(C.iso(a.next), "2025-03-01"); assert.equal(a.daysUntil, 1);
  assert.equal(C.ageInfo(birth, d("2025-03-01"), current).daysUntil, 0);
});
test("生年月日が未来、基準日より後なら拒否", () => {
  assert.throws(() => C.ageAt(d("2026-09-12"), d("2030-01-01"), current), /未来/);
  assert.throws(() => C.ageAt(d("2000-01-01"), d("1999-12-31"), current), /基準日/);
  assert.equal(C.ageAt(current, current, current), 0);
});
test("範囲端でも年齢の主結果を失わない", () => {
  const a = C.ageInfo(d("2000-01-01"), d("2099-12-31"), current);
  assert.equal(a.age, 99); assert.equal(a.next, null); assert.equal(a.daysUntil, null); assert.equal(a.fiscal, null);
  const b = C.ageInfo(d("1873-01-01"), d("1873-03-31"), current);
  assert.equal(b.age, 0); assert.equal(b.fiscal, null);
});
