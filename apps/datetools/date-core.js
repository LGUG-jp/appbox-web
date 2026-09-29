/* 日付の計算本体。通信・保存・DOM操作を行わない。 */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AppBoxDateTools = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const MIN_YEAR = 1873;
  const MAX_YEAR = 2099;
  const DAY_MS = 86400000;
  const REFERENCE_MAX_AGE = 100;
  const REFERENCE_GROUPS = Object.freeze([[0, 34], [35, 69], [70, 100]].map(group => Object.freeze(group)));
  const ERAS = Object.freeze([
    { id: "meiji", name: "明治", base: 1867, start: [1873, 1, 1], end: [1912, 7, 29] },
    { id: "taisho", name: "大正", base: 1911, start: [1912, 7, 30], end: [1926, 12, 24] },
    { id: "showa", name: "昭和", base: 1925, start: [1926, 12, 25], end: [1989, 1, 7] },
    { id: "heisei", name: "平成", base: 1988, start: [1989, 1, 8], end: [2019, 4, 30] },
    { id: "reiwa", name: "令和", base: 2018, start: [2019, 5, 1], end: [2099, 12, 31] }
  ].map(era => Object.freeze({ ...era, start: Object.freeze(era.start), end: Object.freeze(era.end) })));

  function integer(value, label, firstYear) {
    const text = String(value ?? "").normalize("NFKC").trim();
    if (firstYear && text === "元") return 1;
    if (!/^\d{1,4}$/.test(text)) throw new Error(label + "を整数で入力してください。");
    return Number(text);
  }
  function isLeap(year) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  }
  function daysInMonth(year, month) {
    return [31, isLeap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  }
  function date(year, month, day) {
    year = integer(year, "年"); month = integer(month, "月"); day = integer(day, "日");
    if (year < MIN_YEAR || year > MAX_YEAR) throw new Error("日付は1873年1月1日〜2099年12月31日で入力してください。");
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
      throw new Error("存在しない日付です。月・日とうるう年を確認してください。");
    }
    return { year, month, day };
  }
  function checked(value) {
    if (!value || typeof value !== "object") throw new Error("日付を入力してください。");
    return date(value.year, value.month, value.day);
  }
  // 年月日だけをUTCの日番号にする。端末の時差や夏時間を日数に混ぜない。
  function dayNumber(value) {
    const d = checked(value);
    return Date.UTC(d.year, d.month - 1, d.day) / DAY_MS;
  }
  function compare(a, b) { return dayNumber(a) - dayNumber(b); }
  function fromParts(calendar, year, month, day) {
    if (calendar === "western") return date(year, month, day);
    const era = ERAS.find(item => item.id === calendar);
    if (!era) throw new Error("暦を選択してください。");
    const eraYear = integer(year, "和暦の年", true);
    if (eraYear < 1) throw new Error("和暦の年は1以上、または「元」で入力してください。");
    const d = date(era.base + eraYear, month, day);
    if (compare(d, date(...era.start)) < 0 || compare(d, date(...era.end)) > 0) {
      throw new Error(era.name + "の期間外です。元号・年・月・日を確認してください。");
    }
    return d;
  }
  function eraFor(value) {
    const d = checked(value);
    return ERAS.find(era => compare(d, date(...era.start)) >= 0 && compare(d, date(...era.end)) <= 0);
  }
  function western(value) {
    const d = checked(value);
    return `${d.year}年${d.month}月${d.day}日`;
  }
  function japanese(value) {
    const d = checked(value), era = eraFor(d), year = d.year - era.base;
    return `${era.name}${year === 1 ? "元" : year}年${d.month}月${d.day}日`;
  }
  function iso(value) {
    const d = checked(value);
    return `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
  }
  function today(now = new Date()) {
    return date(now.getFullYear(), now.getMonth() + 1, now.getDate());
  }
  // 生年だけの一覧では満年齢を断定せず、その年に迎える年齢を返す。
  function referenceRows(reference = today()) {
    const current = checked(reference), rows = [];
    const first = Math.max(MIN_YEAR, current.year - REFERENCE_MAX_AGE);
    for (let year = current.year; year >= first; year--) {
      const eras = ERAS.filter(era => year >= era.start[0] && year <= era.end[0]).map(era => {
        const n = year - era.base;
        return { id: era.id, name: era.name, year: n, label: `${era.name}${n === 1 ? "元" : n}年` };
      });
      rows.push({ year, eras, age: current.year - year });
    }
    return rows;
  }
  // 一覧表示は改元年の新元号（配列末尾）を基本とし、オプションで旧元号も併記する。検索用にはrow.erasへ旧元号も保持する。
  function referenceEra(row, includePrevious = false) {
    if (!row || !Array.isArray(row.eras) || !row.eras.length) return null;
    if (!includePrevious || row.eras.length === 1) return row.eras.at(-1);
    const label = row.eras.map(era => era.label).join(" ／ ");
    return { ...row.eras.at(-1), label, isCombined: true, eras: row.eras };
  }
  function filterReferenceRows(rows, input) {
    const query = String(input ?? "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();
    if (!query) return rows;
    const westernYear = query.match(/^(?:西暦)?(\d{4})年?$/);
    if (westernYear) return rows.filter(row => row.year === Number(westernYear[1]));
    const age = query.match(/^(\d{1,3})(?:歳|才)?$/);
    if (age) return rows.filter(row => row.age === Number(age[1]));
    const eraQuery = query.match(/^(明治|大正|昭和|平成|令和|m|t|s|h|r)(?:(\d{1,3}|元)年?)?$/);
    if (!eraQuery) return [];
    const aliases = { m: "meiji", t: "taisho", s: "showa", h: "heisei", r: "reiwa" };
    const n = eraQuery[2] === undefined ? null : eraQuery[2] === "元" ? 1 : Number(eraQuery[2]);
    return rows.filter(row => row.eras.some(era =>
      (era.name === eraQuery[1] || era.id === aliases[eraQuery[1]]) && (n === null || era.year === n)));
  }
  function fiscalYearFor(value) {
    const d = checked(value);
    return d.month < 4 ? d.year - 1 : d.year;
  }
  function fiscalInfo(input) {
    const year = integer(input, "年度");
    if (year < MIN_YEAR || year >= MAX_YEAR) {
      throw new Error("年度は1873〜2098年度（日付指定は1873年4月1日〜2099年3月31日）に対応しています。");
    }
    const start = date(year, 4, 1), end = date(year + 1, 3, 31);
    // 改元年は新元号の年度名を表示。旧元号の最終年も入力として受け付ける。
    const era = eraFor(date(year, 12, 31)), n = year - era.base;
    return { year, label: `${era.name}${n === 1 ? "元" : n}年度`, start, end, days: compare(end, start) + 1 };
  }
  function anniversary(birth, year) {
    return birth.month === 2 && birth.day === 29 && !isLeap(year)
      ? date(year, 3, 1) : date(year, birth.month, birth.day);
  }
  function ageAt(birth, reference, current = today()) {
    birth = checked(birth); reference = checked(reference); current = checked(current);
    if (compare(birth, current) > 0) throw new Error("生年月日に今日より未来の日付は指定できません。");
    if (compare(birth, reference) > 0) throw new Error("基準日は生年月日以降を指定してください。");
    return reference.year - birth.year - (compare(reference, anniversary(birth, reference.year)) < 0 ? 1 : 0);
  }
  function ageInfo(birth, reference, current = today()) {
    birth = checked(birth); reference = checked(reference);
    const age = ageAt(birth, reference, current);
    let next = anniversary(birth, reference.year);
    if (compare(next, reference) < 0) next = reference.year < MAX_YEAR ? anniversary(birth, reference.year + 1) : null;
    const year = fiscalYearFor(reference);
    const fiscal = year >= MIN_YEAR && year < MAX_YEAR ? fiscalInfo(year) : null;
    return { age, next, daysUntil: next ? compare(next, reference) : null,
      fiscal, fiscalAge: fiscal ? ageAt(birth, fiscal.end, current) : null };
  }
  return Object.freeze({ MIN_YEAR, MAX_YEAR, REFERENCE_MAX_AGE, REFERENCE_GROUPS, ERAS, date, fromParts, western, japanese, iso, today,
    compare, fiscalYearFor, fiscalInfo, ageAt, ageInfo, isLeap,
    referenceRows, referenceEra, filterReferenceRows });
});
