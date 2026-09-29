const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const holidays = require("../holidays.js");
const core = require("../calc-core.js");

test("祝日データが正しく読み込まれ、メタデータが存在する", () => {
  assert.ok(holidays.meta);
  assert.equal(holidays.meta.updated, "2026-02-02");
  assert.ok(holidays.meta.count > 1000);
  assert.equal(holidays.isHoliday("2026-01-01"), true);
  assert.equal(holidays.getHolidayName("2026-01-01"), "元日");
  assert.equal(holidays.isHoliday("2026-01-02"), false);
});

test("開庁日・閉庁日判定が正確に動作する", () => {
  // 2026-09-15 は火曜日（開庁日）
  assert.equal(core.isOpenDay("2026-09-15"), true);
  assert.equal(core.isClosedDay("2026-09-15"), false);
  assert.equal(core.getClosedReason("2026-09-15"), null);

  // 土曜日
  assert.equal(core.isOpenDay("2026-09-19"), false);
  assert.equal(core.getClosedReason("2026-09-19"), "土曜日");

  // 日曜日
  assert.equal(core.isOpenDay("2026-09-20"), false);
  assert.equal(core.getClosedReason("2026-09-20"), "日曜日");

  // 国民の祝日（2026-09-21: 敬老の日）
  assert.equal(core.isOpenDay("2026-09-21"), false);
  assert.equal(core.getClosedReason("2026-09-21"), "敬老の日");

  // 年末年始（12月29日〜1月3日）
  assert.equal(core.isOpenDay("2026-12-28"), true); // 月曜
  assert.equal(core.isOpenDay("2026-12-29"), false);
  assert.match(core.getClosedReason("2026-12-29"), /年末年始/);
  assert.equal(core.isOpenDay("2026-12-31"), false);
  assert.equal(core.isOpenDay("2027-01-01"), false); // 元日かつ年末年始
  assert.equal(core.isOpenDay("2027-01-03"), false);
  assert.equal(core.isOpenDay("2027-01-04"), true); // 月曜・仕事始め

  // 独自閉庁日の指定
  const custom = { "2026-10-01": "創立記念日（独自閉庁日）" };
  assert.equal(core.isOpenDay("2026-10-01", custom), false);
  assert.equal(core.getClosedReason("2026-10-01", custom), "創立記念日（独自閉庁日）");
});

test("期限計算：暦日・初日不算入・閉庁日補正なし", () => {
  // 2026-09-15（火）の15日後 -> 2026-09-30（水）
  const res = core.calculateDeadline("2026-09-15", 15, {
    includeFirstDay: false,
    countMode: "calendar",
    closedAdjustment: "none"
  });
  assert.equal(res.rawTargetDate, "2026-09-30");
  assert.equal(res.finalTargetDate, "2026-09-30");
  assert.equal(res.finalTargetWeekday, "水");
  assert.equal(res.finalTargetJapanese, "令和8年9月30日");
  assert.equal(res.adjustmentApplied, "none");
  assert.equal(res.steps.length, 16); // base + 1..15
});

test("期限計算：暦日・初日算入", () => {
  // 2026-09-15（火）を1日目として15日目 -> 2026-09-29（火）
  const res = core.calculateDeadline("2026-09-15", 15, {
    includeFirstDay: true,
    countMode: "calendar",
    closedAdjustment: "none"
  });
  assert.equal(res.finalTargetDate, "2026-09-29");
  assert.equal(res.finalTargetWeekday, "火");
  assert.equal(res.steps.length, 15);
  assert.equal(res.steps[0].dayNumber, 1);
});

test("期限計算：暦日・閉庁日の翌開庁日繰越", () => {
  // 2026-09-15（火）の4日後 -> 2026-09-19（土）
  // 9/19(土), 9/20(日), 9/21(月・敬老の日), 9/22(火・国民の休日), 9/23(水・秋分の日)
  // 翌開庁日は 2026-09-24（木）
  const res = core.calculateDeadline("2026-09-15", 4, {
    includeFirstDay: false,
    countMode: "calendar",
    closedAdjustment: "next"
  });
  assert.equal(res.rawTargetDate, "2026-09-19");
  assert.equal(res.rawTargetIsClosed, true);
  assert.equal(res.finalTargetDate, "2026-09-24");
  assert.equal(res.finalTargetWeekday, "木");
  assert.equal(res.adjustmentApplied, "next");
  assert.equal(res.adjustmentShiftDays, 5);
  assert.equal(res.excludedDays.length, 5);
});

test("期限計算：暦日・閉庁日の前開庁日繰上", () => {
  // 2026-09-15（火）の4日後 -> 2026-09-19（土）
  // 前開庁日は 2026-09-18（金）
  const res = core.calculateDeadline("2026-09-15", 4, {
    includeFirstDay: false,
    countMode: "calendar",
    closedAdjustment: "prev"
  });
  assert.equal(res.rawTargetDate, "2026-09-19");
  assert.equal(res.finalTargetDate, "2026-09-18");
  assert.equal(res.finalTargetWeekday, "金");
  assert.equal(res.adjustmentApplied, "prev");
  assert.equal(res.adjustmentShiftDays, -1);
});

test("期限計算：開庁日のみで数える", () => {
  // 2026-09-18（金）から1開庁日後（初日不算入）
  // 9/19(土), 9/20(日), 9/21(祝), 9/22(休), 9/23(祝) をスキップして 9/24(木)
  const res = core.calculateDeadline("2026-09-18", 1, {
    includeFirstDay: false,
    countMode: "business"
  });
  assert.equal(res.finalTargetDate, "2026-09-24");
  assert.equal(res.finalTargetWeekday, "木");
  assert.equal(res.excludedDays.length, 5);
});

test("○日前・○日後計算", () => {
  const after = core.calculateOffset("2026-05-01", 10, "after");
  assert.equal(after.targetDate, "2026-05-11");
  assert.equal(after.targetWeekday, "月");

  const before = core.calculateOffset("2026-05-01", 10, "before");
  assert.equal(before.targetDate, "2026-04-21");
  assert.equal(before.targetWeekday, "火");
});

test("期間計算：実日数・開庁日数・年月日の目安", () => {
  // 2026-09-01 〜 2026-09-30
  const dur = core.calculateDuration("2026-09-01", "2026-09-30");
  assert.equal(dur.totalDays, 29); // 実日数 (片端)
  assert.equal(dur.inclusiveDays, 30); // 両端含む
  assert.ok(dur.businessDaysInclusive > 0);
  assert.ok(dur.businessDaysExclusive > 0);
  assert.equal(dur.approximate.years, 0);
  assert.equal(dur.approximate.months, 0);
  assert.equal(dur.approximate.days, 29);

  // 1年間の期間
  const oneYear = core.calculateDuration("2025-04-01", "2026-03-31");
  assert.equal(oneYear.totalDays, 364);
  assert.equal(oneYear.inclusiveDays, 365);
  assert.equal(oneYear.approximate.years, 0);
  assert.equal(oneYear.approximate.months, 11);
});

test("開庁日確認", () => {
  // 閉庁日（2026-09-21 敬老の日）
  const checkClosed = core.checkOpenDay("2026-09-21");
  assert.equal(checkClosed.isClosed, true);
  assert.equal(checkClosed.closedReason, "敬老の日");
  assert.equal(checkClosed.prevOpenDay.date, "2026-09-18");
  assert.equal(checkClosed.nextOpenDay.date, "2026-09-24");

  // 開庁日
  const checkOpen = core.checkOpenDay("2026-09-24");
  assert.equal(checkOpen.isClosed, false);
  assert.equal(checkOpen.prevOpenDay, null);
});

test("クイック日付：月末・年末・年度末", () => {
  const base = { year: 2026, month: 2, day: 10 };
  assert.deepEqual(core.getMonthEnd(base), { year: 2026, month: 2, day: 28 }); // 2026は平年
  assert.deepEqual(core.getYearEnd(base), { year: 2026, month: 12, day: 31 });
  assert.deepEqual(core.getFiscalYearEnd(base), { year: 2026, month: 3, day: 31 }); // 2月なので当年3月末

  const baseAutumn = { year: 2026, month: 9, day: 15 };
  assert.deepEqual(core.getMonthEnd(baseAutumn), { year: 2026, month: 9, day: 30 });
  assert.deepEqual(core.getFiscalYearEnd(baseAutumn), { year: 2027, month: 3, day: 31 }); // 9月なので翌年3月末
});

test("日数バリデーション：小数・負数・指数表記・上限超過の拒否", () => {
  assert.throws(() => core.calculateDeadline("2026-09-15", 1.5), /日数は0以上の整数を入力してください/);
  assert.throws(() => core.calculateDeadline("2026-09-15", -5), /日数は0以上の整数を入力してください/);
  assert.throws(() => core.calculateDeadline("2026-09-15", "1.5"), /日数は0以上の整数を入力してください/);
  assert.throws(() => core.calculateDeadline("2026-09-15", "-1"), /日数は0以上の整数を入力してください/);
  assert.throws(() => core.calculateDeadline("2026-09-15", "1e2"), /日数は0以上の整数を入力してください/);
  assert.throws(() => core.calculateDeadline("2026-09-15", 36526), /36,525以下の整数/);

  assert.throws(() => core.calculateOffset("2026-09-15", 1.5, "after"), /日数は0以上の整数を入力してください/);
  assert.throws(() => core.calculateOffset("2026-09-15", -1, "after"), /日数は0以上の整数を入力してください/);
  assert.throws(() => core.calculateOffset("2026-09-15", "1e2", "after"), /日数は0以上の整数を入力してください/);
  assert.throws(() => core.calculateOffset("2026-09-15", 36526, "after"), /36,525以下の整数/);

  const validRes = core.calculateOffset("2026-09-15", 36525, "after");
  assert.ok(validRes.targetDate);
});

test("西暦2099年上限ガード", () => {
  assert.throws(() => core.calculateDeadline("2099-12-30", 5, { countMode: "calendar" }), /西暦2099年/);
  assert.throws(() => core.calculateDeadline("2099-12-30", 5, { countMode: "business" }), /西暦2099年/);
});

test("祝日データ収録範囲外の日付に対する警告（warnings）", () => {
  const openDayRes = core.checkOpenDay("2028-05-05");
  assert.ok(openDayRes.warnings && openDayRes.warnings.length > 0);
  assert.match(openDayRes.warnings[0], /収録範囲外/);

  const offsetRes = core.calculateOffset("2028-05-05", 10, "after");
  assert.ok(offsetRes.warnings && offsetRes.warnings.length > 0);
  assert.match(offsetRes.warnings[0], /収録範囲外/);

  const durationRes = core.calculateDuration("2026-09-01", "2028-01-01");
  assert.ok(durationRes.warnings && durationRes.warnings.length > 0);
  assert.match(durationRes.warnings[0], /収録範囲外/);

  const deadlineRes = core.calculateDeadline("2028-01-01", 10);
  assert.ok(deadlineRes.warnings && deadlineRes.warnings.length > 0);
  assert.match(deadlineRes.warnings[0], /収録範囲外/);
});

test("祝日データ収録範囲内の日付（2027年末まで）は警告が出ない", () => {
  const openDayRes = core.checkOpenDay("2027-12-31");
  assert.deepEqual(openDayRes.warnings, []);

  const deadlineRes = core.calculateDeadline("2027-12-20", 5);
  assert.deepEqual(deadlineRes.warnings, []);
});

test("期限計算：○日前（過去への逆算）と閉庁日補正", () => {
  // 2026-09-24（木）の1開庁日前（初日不算入）
  // 9/23(祝), 9/22(休), 9/21(祝), 9/20(日), 9/19(土) をスキップして 9/18(金)
  const resB = core.calculateDeadline("2026-09-24", 1, {
    direction: "before",
    includeFirstDay: false,
    countMode: "business"
  });
  assert.equal(resB.finalTargetDate, "2026-09-18");
  assert.equal(resB.finalTargetWeekday, "金");
  assert.equal(resB.direction, "before");
  assert.equal(resB.excludedDays.length, 5);

  // 2026-09-24（木）の5暦日前 -> 2026-09-19（土）
  // 前開庁日へ繰上（prev） -> 2026-09-18（金）
  const resCal = core.calculateDeadline("2026-09-24", 5, {
    direction: "before",
    includeFirstDay: false,
    countMode: "calendar",
    closedAdjustment: "prev"
  });
  assert.equal(resCal.rawTargetDate, "2026-09-19");
  assert.equal(resCal.finalTargetDate, "2026-09-18");
  assert.equal(resCal.adjustmentApplied, "prev");
});

test("期間・残り日数計算（calculateRemainingDays）", () => {
  // 2026-09-01 〜 2026-09-30
  const rem = core.calculateRemainingDays("2026-09-01", "2026-09-30", {
    includeFirstDay: false
  });
  assert.equal(rem.totalDays, 29); // 片端
  assert.equal(rem.inclusiveDays, 30); // 両端含む
  assert.ok(rem.businessDays > 0);
  assert.equal(rem.isPast, false);
  assert.equal(rem.deadlineIsClosed, false);

  // 期限日が土曜日の場合（2026-09-19）
  const remSat = core.calculateRemainingDays("2026-09-15", "2026-09-19", {
    includeFirstDay: false
  });
  assert.equal(remSat.totalDays, 4);
  assert.equal(remSat.deadlineIsClosed, true);
  assert.equal(remSat.deadlineClosedReason, "土曜日");
  // 翌開庁日は連休明けの 2026-09-24（木）
  assert.ok(remSat.nextOpenDay);
  assert.equal(remSat.nextOpenDay.date, "2026-09-24");
});

test("月間カレンダー生成（getMonthCalendar）", () => {
  const cal = core.getMonthCalendar(2026, 9);
  assert.equal(cal.year, 2026);
  assert.equal(cal.month, 9);
  assert.equal(cal.totalDays, 30);
  assert.equal(cal.businessDays, 19); // 30日 - 土日8日 - 祝日・休日3日(9/21敬老, 9/22国民休日, 9/23秋分) = 19日
  assert.ok(cal.days.length % 7 === 0, "7の倍数のマス数（グリッド対応）");
  assert.equal(cal.days[0].dayOfWeek, 0, "日曜日始まり");

  // 祝日が含まれていること
  const hDay = cal.days.find((d) => d.date === "2026-09-21");
  assert.ok(hDay);
  assert.equal(hDay.holidayName, "敬老の日");
  assert.equal(hDay.isClosed, true);
});

test("年間閉庁日一覧（getYearClosedDays）", () => {
  const yearData = core.getYearClosedDays(2026);
  assert.equal(yearData.year, 2026);
  assert.equal(yearData.totalDays, 365);
  assert.ok(yearData.businessDays > 200);
  assert.ok(yearData.specialClosedDays.length > 15);

  // 元日が含まれる
  const ganjitsu = yearData.specialClosedDays.find((d) => d.date === "2026-01-01");
  assert.ok(ganjitsu);
  assert.match(ganjitsu.reason, /元日/);
});

test("組織独自閉庁日（custom-closed-days.js）の反映", () => {
  const custom = { "2026-10-01": "創立記念日（独自休庁）" };
  const cal = core.getMonthCalendar(2026, 10, custom);
  const oct1 = cal.days.find((d) => d.date === "2026-10-01");
  assert.ok(oct1);
  assert.equal(oct1.isClosed, true);
  assert.equal(oct1.isCustomClosed, true);
  assert.equal(oct1.closedReason, "創立記念日（独自休庁）");
});

test("基本日付：うるう年判定および2月29日前後の加算・減算", () => {
  // うるう年・平年判定
  assert.equal(core.isLeapYear(2024), true);
  assert.equal(core.isLeapYear(2025), false);
  assert.equal(core.isLeapYear(2026), false);
  assert.equal(core.isLeapYear(2000), true);
  assert.equal(core.isLeapYear(2100), false);

  // うるう年（2024年）の2月29日をまたぐ日数加算（初日不算入）
  const leapAfter = core.calculateDeadline("2024-02-28", 2, { countMode: "calendar" });
  assert.equal(leapAfter.finalTargetDate, "2024-03-01");
  const leapOne = core.calculateDeadline("2024-02-28", 1, { countMode: "calendar" });
  assert.equal(leapOne.finalTargetDate, "2024-02-29");

  // うるう年（2024年）の2月29日をまたぐ日数減算（○日前）
  const leapBefore = core.calculateDeadline("2024-03-01", 1, { direction: "before", countMode: "calendar" });
  assert.equal(leapBefore.finalTargetDate, "2024-02-29");
  const leapBeforeTwo = core.calculateDeadline("2024-03-01", 2, { direction: "before", countMode: "calendar" });
  assert.equal(leapBeforeTwo.finalTargetDate, "2024-02-28");

  // 平年（2025年）の2月28日からの加算・減算
  const normAfter = core.calculateDeadline("2025-02-28", 1, { countMode: "calendar" });
  assert.equal(normAfter.finalTargetDate, "2025-03-01");
  const normBefore = core.calculateDeadline("2025-03-01", 1, { direction: "before", countMode: "calendar" });
  assert.equal(normBefore.finalTargetDate, "2025-02-28");

  // うるう日当日（2024-02-29）を基準日とする計算
  const leapBaseEx = core.calculateDeadline("2024-02-29", 10, { includeFirstDay: false, countMode: "calendar" });
  assert.equal(leapBaseEx.finalTargetDate, "2024-03-10");
  const leapBaseIn = core.calculateDeadline("2024-02-29", 10, { includeFirstDay: true, countMode: "calendar" });
  assert.equal(leapBaseIn.finalTargetDate, "2024-03-09");
});

test("基本日付：月末・年末・年度末の境界日をまたぐ計算", () => {
  // 小の月末（4月30日）の翌日
  const aprEnd = core.calculateDeadline("2026-04-30", 1, { countMode: "calendar" });
  assert.equal(aprEnd.rawTargetDate, "2026-05-01");

  // 大の月末（5月31日）の翌日
  const mayEnd = core.calculateDeadline("2026-05-31", 1, { countMode: "calendar" });
  assert.equal(mayEnd.rawTargetDate, "2026-06-01");

  // 年末（12月31日）の翌日
  const yearEnd = core.calculateDeadline("2026-12-31", 1, { countMode: "calendar" });
  assert.equal(yearEnd.rawTargetDate, "2027-01-01");

  // 年度末（3月31日）の翌日
  const fyEnd = core.calculateDeadline("2026-03-31", 1, { countMode: "calendar" });
  assert.equal(fyEnd.rawTargetDate, "2026-04-01");
});

test("初日算入・不算入および0日指定・1日指定の挙動", () => {
  // 0日指定（初日不算入）: 基準日当日
  const zeroEx = core.calculateDeadline("2026-09-15", 0, { includeFirstDay: false, countMode: "calendar" });
  assert.equal(zeroEx.rawTargetDate, "2026-09-15");
  assert.equal(zeroEx.finalTargetDate, "2026-09-15");

  // 0日指定（初日算入）: 基準日当日
  const zeroIn = core.calculateDeadline("2026-09-15", 0, { includeFirstDay: true, countMode: "calendar" });
  assert.equal(zeroIn.rawTargetDate, "2026-09-15");
  assert.equal(zeroIn.finalTargetDate, "2026-09-15");

  // 0日指定で基準日が閉庁日かつ翌開庁日繰越の場合
  // 2026-09-19 は土曜日 -> 翌開庁日は 2026-09-24（木）
  const zeroClosedNext = core.calculateDeadline("2026-09-19", 0, {
    countMode: "calendar",
    closedAdjustment: "next"
  });
  assert.equal(zeroClosedNext.rawTargetDate, "2026-09-19");
  assert.equal(zeroClosedNext.finalTargetDate, "2026-09-24");
  assert.equal(zeroClosedNext.adjustmentApplied, "next");

  // 0日指定で基準日が閉庁日かつ前開庁日繰上の場合 -> 2026-09-18（金）
  const zeroClosedPrev = core.calculateDeadline("2026-09-19", 0, {
    countMode: "calendar",
    closedAdjustment: "prev"
  });
  assert.equal(zeroClosedPrev.finalTargetDate, "2026-09-18");
  assert.equal(zeroClosedPrev.adjustmentApplied, "prev");

  // 1日指定（初日不算入）: 翌日
  const oneEx = core.calculateDeadline("2026-09-15", 1, { includeFirstDay: false, countMode: "calendar" });
  assert.equal(oneEx.finalTargetDate, "2026-09-16");

  // 1日指定（初日算入）: 基準日当日が1日目
  const oneIn = core.calculateDeadline("2026-09-15", 1, { includeFirstDay: true, countMode: "calendar" });
  assert.equal(oneIn.finalTargetDate, "2026-09-15");
});

test("連休・振替休日・連続閉庁日のスキップと開庁日計算", () => {
  // 2026年5月のGW: 5/3(日・憲法記念日), 5/4(月・みどりの日), 5/5(火・こどもの日), 5/6(水・振替休日)
  assert.equal(core.isOpenDay("2026-05-02"), false); // 土曜
  assert.equal(core.isOpenDay("2026-05-03"), false); // 憲法記念日
  assert.equal(core.isOpenDay("2026-05-04"), false); // みどりの日
  assert.equal(core.isOpenDay("2026-05-05"), false); // こどもの日
  assert.equal(core.isOpenDay("2026-05-06"), false); // 振替休日
  assert.equal(core.isOpenDay("2026-05-07"), true);  // 木曜（開庁日）

  // 2026-05-01（金）から1開庁日後 -> 5連休（土〜水）をまたいで 5/7（木）
  const gwAfter = core.calculateDeadline("2026-05-01", 1, { countMode: "business" });
  assert.equal(gwAfter.finalTargetDate, "2026-05-07");
  assert.equal(gwAfter.excludedDays.length, 5);

  // 2026-05-07（木）から1開庁日前 -> 5連休を遡って 5/1（金）
  const gwBefore = core.calculateDeadline("2026-05-07", 1, { direction: "before", countMode: "business" });
  assert.equal(gwBefore.finalTargetDate, "2026-05-01");
  assert.equal(gwBefore.excludedDays.length, 5);

  // 年末年始の連続閉庁日（12月29日〜1月3日）をまたぐ計算
  // 2026-12-28（月）の1開庁日後 -> 2027-01-04（月）
  const nyAfter = core.calculateDeadline("2026-12-28", 1, { countMode: "business" });
  assert.equal(nyAfter.finalTargetDate, "2027-01-04");
  assert.equal(nyAfter.excludedDays.length, 6); // 12/29, 30, 31, 1/1, 1/2(土), 1/3(日)

  // 2027-01-04（月）の1開庁日前 -> 2026-12-28（月）
  const nyBefore = core.calculateDeadline("2027-01-04", 1, { direction: "before", countMode: "business" });
  assert.equal(nyBefore.finalTargetDate, "2026-12-28");

  // 組織独自の連続閉庁日を設定した場合のスキップ
  const customMulti = {
    "2026-08-13": "夏季休庁日1",
    "2026-08-14": "夏季休庁日2"
  };
  // 2026-08-12（水）から1開庁日後 -> 8/13(木・独自), 8/14(金・独自), 8/15(土), 8/16(日) をスキップして 8/17(月)
  const summerRes = core.calculateDeadline("2026-08-12", 1, {
    countMode: "business",
    customClosedDays: customMulti
  });
  assert.equal(summerRes.finalTargetDate, "2026-08-17");
  assert.equal(summerRes.excludedDays.length, 4);
});

test("期間計算：同日・うるう日またぎ・月末から月末・終了日逆転エラー", () => {
  // 同日（開始日 === 終了日）
  const sameDay = core.calculateDuration("2026-09-15", "2026-09-15");
  assert.equal(sameDay.totalDays, 0); // 実日数（片端）
  assert.equal(sameDay.inclusiveDays, 1); // 両端含む
  assert.equal(sameDay.businessDaysExclusive, 0);
  assert.equal(sameDay.businessDaysInclusive, 1); // 開庁日

  // 閉庁日の同日
  const sameDayClosed = core.calculateDuration("2026-09-20", "2026-09-20");
  assert.equal(sameDayClosed.totalDays, 0);
  assert.equal(sameDayClosed.inclusiveDays, 1);
  assert.equal(sameDayClosed.businessDaysInclusive, 0);
  assert.equal(sameDayClosed.excludedDaysCount, 1);

  // うるう日（2024-02-29）をまたぐ期間
  const leapDur = core.calculateDuration("2024-02-28", "2024-03-01");
  assert.equal(leapDur.totalDays, 2); // 28 -> 29 (1), 29 -> 1 (2)
  assert.equal(leapDur.inclusiveDays, 3); // 2/28, 2/29, 3/1

  // 月末から月末（1月31日〜2月28日: 平年28日間）
  const monthEndDur = core.calculateDuration("2026-01-31", "2026-02-28");
  assert.equal(monthEndDur.totalDays, 28);
  assert.equal(monthEndDur.inclusiveDays, 29);

  // 月末から月末（4月30日〜5月31日: 31日間）
  const aprMayDur = core.calculateDuration("2026-04-30", "2026-05-31");
  assert.equal(aprMayDur.totalDays, 31);
  assert.equal(aprMayDur.inclusiveDays, 32);

  // 終了日が開始日より前の場合は例外が送出されること
  assert.throws(() => core.calculateDuration("2026-09-15", "2026-09-14"), /終了日は開始日以降/);
  assert.throws(() => core.calculateDuration("2026-09-15", "2025-09-15"), /終了日は開始日以降/);
});

test("祝日メタ情報が完全で整合している", () => {
  assert.equal(typeof holidays.meta, "object");
  assert.match(holidays.meta.updated, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(holidays.meta.startDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(holidays.meta.endDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(holidays.meta.endDate, "2027-12-31");
  assert.ok(holidays.meta.startDate < holidays.meta.endDate);
  assert.ok(holidays.meta.count > 1000);
});



