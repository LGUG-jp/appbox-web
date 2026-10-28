(function (global) {
'use strict';

/* =========================================================================
 * ガントチャート作成アプリ（開発名 NovaChart）v1.7.1
 * （v1.3 で保存形式を .json に切替。v1.4 でシンプル表示・2段書き・期間とマスの単位・テンプレートを追加。
 * v1.5 で一覧最下段の「＋ 作業を追加」、ガント上のドラッグでの作成、「日程は目安」を追加。
 * v1.6.0 で AppBox の標準構成（index.html・help.html・app.css・app.js）へ移し、共通ヘッダー・共通部品を使用）
 * 外部依存ゼロ・外部通信ゼロ（CSPでも遮断）。
 * 計算の仕様は「3. 計算エンジン」の各関数の説明と tests/calc.test.cjs・tests/v12.test.cjs、
 * 保存ファイルの安全要件は「5. 保存ファイル（.json）の検証パイプライン」と tests/validation.test.cjs を参照。
 * ========================================================================= */

/* =========================================================================
 * 0. 定数
 * ========================================================================= */
var APP_VERSION = '1.7.1';
/* 保存データの目印。.json は汎用の拡張子なので、別アプリのJSONと区別するために先頭へ入れる */
var FILE_FORMAT = 'novachart-wbs';
var APP_DISPLAY_NAME = 'ガントチャート作成アプリ';
// 保存ファイル名・印刷時の文書名の既定（プロジェクト名が空のとき）
var DEFAULT_FILE_BASENAME = 'ガントチャート';
var NOT_WBS_MESSAGE = 'このファイルは' + APP_DISPLAY_NAME + 'の工程データではありません。このアプリ（旧名 NovaChart）で保存した .json ファイルを選んでください。';
// 自動保存の領域は v1.2（novachart:）と分ける。同時に開いたとき互いの控えを古い内容で上書きしないため。
// v1.2 の「ローカルデータ消去」は接頭辞 novachart: で消すので、この領域を巻き込まない
var STORAGE_PREFIX = 'novachart-json:';
var LEGACY_STORAGE_KEY_PROJECT = 'novachart:project';  // 初回だけ引き継ぐ v1.2 の控え（読むだけで書き換えない）
var LEGACY_STORAGE_KEY_META = 'novachart:meta';
var STORAGE_KEY_LEGACY_IMPORTED = STORAGE_PREFIX + 'legacyImported'; // 引き継ぎ済みの印（ローカルデータ消去でも残す）
var STORAGE_KEY_PROJECT = STORAGE_PREFIX + 'project';
var STORAGE_KEY_META = STORAGE_PREFIX + 'meta';
var STORAGE_KEY_RECOVERY = STORAGE_PREFIX + 'recovery';
var STORAGE_KEY_TABLE_W = STORAGE_PREFIX + 'ui:tableWidth';
// 読込み・保存の上限（UTF-8バイト数）。2026-10-08 に 5MB から 100MB へ引き上げ（画像等を持たず実データは数百KB程度のため。
// 極端に大きいファイルを読み込む前に止める安全装置として上限自体は残す。100MB 以下での動作速度は未確認）。5MB に戻すときは 5 * 1024 * 1024 と '5MB' にする
var MAX_FILE_SIZE = 100 * 1024 * 1024;
var MAX_FILE_SIZE_LABEL = '100MB';
var MAX_TASKS = 5000;
var MAX_NAME_LEN = 200;
var MAX_PROJECT_NAME_LEN = 200;
// ダイアログの操作ボタンは AppBox 共通ボタンを使う（一覧・メニュー内の小さな操作ボタンはアプリ固有の見た目のまま）
var BTN_PRIMARY = 'appbox-button appbox-button--primary';
var BTN_SECONDARY = 'appbox-button appbox-button--secondary';
var BTN_DANGER = 'appbox-button appbox-button--danger';
var MAX_OWNER_LEN = 100;
var MAX_MEMO_LEN = 5000;
var MAX_PREDECESSORS = 50;
var MAX_ID_LEN = 100;
var VALID_PROGRESS = [0, 20, 40, 60, 80, 100];
/* v1.5 で 2 に更新（タスクに tentative を追加）。旧版で開くと「新しい版で作成」の警告が出て、目安が落ちることを知らせる */
var SCHEMA_VERSION = 2;
/* 日付の許容範囲（v1.2 で決定）。内部の日付文字列が常に4桁年になることを保証し、
   極端な期間による描画DoS（R03-01）と、年の1桁タイプミスでのクラッシュ（R03-02）を防ぐ。 */
var DATE_MIN = '2000-01-01';
var DATE_MAX = '2099-12-31';

var ROW_H = 30;
var HEAD_H = 30;           // 表のヘッダ(--head-h)と必ず同じ値にする（行ずれ防止）
var MAJOR_BAR_H = 16;
var MINOR_BAR_H = 11;
var GANTT_LABEL_PAD = 200;   // ガントの右端に確保するラベル用の余白（px）
/* マスの単位（細かい順）。v1.4 で「旬（月を3分割）」「半月（月を2分割）」「年度（4月始まり）」を追加 */
var SCALE_ORDER = ['day', 'week', 'third', 'half', 'month', 'year'];
var BUCKET_SCALES = ['third', 'half', 'month', 'year']; // 画面のヘッダ・罫線をマス単位で描く単位
var PX_PER_DAY = { day: 32, week: 14, third: 7, half: 5, month: 4, year: 0.5 };
/* 画面描画の上限（日数）。これを超える期間は粗い粒度に自動で切り替える（描画ノード数に上限をかける）。 */
var MAX_RENDER_DAYS = { day: 2200, week: 7500, third: 20000, half: 30000, month: 40000, year: 40000 };
var SCALE_LABELS = { day: '日', week: '週', third: '旬（月を3分割）', half: '半月（月を2分割）', month: '月', year: '年度' };
var HISTORY_LIMIT = 80;
var HISTORY_MAX_BYTES = 40 * 1024 * 1024;
var EXCEL_MAX_COLS = 16384;

var DELAY_LABELS = { onTrack: '順調', atRisk: '要注意', delayed: '遅延', unknown: '—' };
var TENTATIVE_PREFIX = '［目安］';  // v1.5: 日程が目安のタスクの名前の先頭に付ける（ガントのラベル・Excelの事業名。長い名前でも切れないよう先頭）

/* =========================================================================
 * 1. 日付ユーティリティ（Date.UTC系のみを使用。ローカルタイムゾーン解釈を避ける）
 * ========================================================================= */
function pad2(n) { return n < 10 ? '0' + n : String(n); }
function pad4(n) { var s = String(n); while (s.length < 4) s = '0' + s; return s; }

function parseISO(s) {
  if (typeof s !== 'string') return null;
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  return { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) };
}

/* 形式（YYYY-MM-DD）と実在性のみを判定する。アプリで扱える範囲かどうかは isAppDate で判定する。 */
function isValidDateString(s) {
  var p = parseISO(s);
  if (!p) return false;
  var dt = new Date(Date.UTC(p.y, p.mo - 1, p.d));
  return dt.getUTCFullYear() === p.y && dt.getUTCMonth() === p.mo - 1 && dt.getUTCDate() === p.d;
}

/* アプリが扱える日付か（形式・実在・2000-01-01〜2099-12-31） */
function isAppDate(s) {
  return isValidDateString(s) && s >= DATE_MIN && s <= DATE_MAX;
}

function toEpochDay(s) {
  var p = parseISO(s);
  return Math.floor(Date.UTC(p.y, p.mo - 1, p.d) / 86400000);
}

/* 年は必ず4桁にゼロ詰めする（R03-02: 西暦1000年未満で3桁になり内部の日付契約を破っていた） */
function fromEpochDay(n) {
  var dt = new Date(n * 86400000);
  return pad4(dt.getUTCFullYear()) + '-' + pad2(dt.getUTCMonth() + 1) + '-' + pad2(dt.getUTCDate());
}

function dayDiff(a, b) { return toEpochDay(a) - toEpochDay(b); }
function inclusiveDays(start, end) { return dayDiff(end, start) + 1; }
function dayAdd(s, n) { return fromEpochDay(toEpochDay(s) + n); }
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function roundHalfUp(x) { return Math.floor(x + 0.5); }
function clampDate(s) { return s < DATE_MIN ? DATE_MIN : (s > DATE_MAX ? DATE_MAX : s); }

function todayStr() {
  var dt = new Date();
  return dt.getFullYear() + '-' + pad2(dt.getMonth() + 1) + '-' + pad2(dt.getDate());
}

function dowOfStr(s) {
  var p = parseISO(s);
  return new Date(Date.UTC(p.y, p.mo - 1, p.d)).getUTCDay();
}

var DOW_NAMES = ['日', '月', '火', '水', '木', '金', '土'];

function isWeekend(dateStr) {
  var d = dowOfStr(dateStr);
  return d === 0 || d === 6;
}

function minDateStr(arr) { return arr.reduce(function (a, b) { return b < a ? b : a; }); }
function maxDateStr(arr) { return arr.reduce(function (a, b) { return b > a ? b : a; }); }

/* ISO日時（UTC）を利用者のローカル時刻 "YYYY/MM/DD HH:MM" に整形する（C11） */
function formatLocalDateTime(iso) {
  if (typeof iso !== 'string') return '';
  var t = Date.parse(iso);
  if (isNaN(t)) return '';
  var d = new Date(t);
  return d.getFullYear() + '/' + pad2(d.getMonth() + 1) + '/' + pad2(d.getDate()) + ' ' +
    pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

/* =========================================================================
 * 1.1 日本の祝日（祝日法の規則から計算。2000〜2099年）— E8
 * 固定日＋ハッピーマンデー＋春分・秋分（国立天文台の近似式、1980〜2099年で有効）＋振替休日＋国民の休日。
 * 改元・特別措置法による一時的な変更（2019・2020・2021年）は例外として個別に補正する。
 * 将来の法改正は反映されない（画面・ヘルプに注記）。
 * ========================================================================= */
var HOLIDAY_YEAR_MIN = 2000, HOLIDAY_YEAR_MAX = 2099;
var holidayCache = new Map();

function ymd(y, m, d) { return pad4(y) + '-' + pad2(m) + '-' + pad2(d); }

/* y年m月（1-12）の第n weekday（0=日〜6=土） */
function nthWeekdayOfMonth(y, m, weekday, n) {
  var first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  return ymd(y, m, 1 + ((weekday - first + 7) % 7) + (n - 1) * 7);
}
function vernalEquinoxDay(y) { return Math.floor(20.8431 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4)); }
function autumnalEquinoxDay(y) { return Math.floor(23.2488 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4)); }

function computeHolidaysOfYear(y) {
  var shukujitsu = new Map(); // 国民の祝日
  function add(ds, name) { shukujitsu.set(ds, name); }
  var MON = 1;

  add(ymd(y, 1, 1), '元日');
  add(nthWeekdayOfMonth(y, 1, MON, 2), '成人の日');
  add(ymd(y, 2, 11), '建国記念の日');
  if (y >= 2020) add(ymd(y, 2, 23), '天皇誕生日');
  add(ymd(y, 3, vernalEquinoxDay(y)), '春分の日');
  add(ymd(y, 4, 29), y >= 2007 ? '昭和の日' : 'みどりの日');
  add(ymd(y, 5, 3), '憲法記念日');
  if (y >= 2007) add(ymd(y, 5, 4), 'みどりの日');
  add(ymd(y, 5, 5), 'こどもの日');
  // 海の日（2003年からハッピーマンデー。2020・2021年は東京五輪特措法で移動）
  if (y === 2020) add('2020-07-23', '海の日');
  else if (y === 2021) add('2021-07-22', '海の日');
  else add(y >= 2003 ? nthWeekdayOfMonth(y, 7, MON, 3) : ymd(y, 7, 20), '海の日');
  // 山の日（2016年から。2020・2021年は移動）
  if (y === 2020) add('2020-08-10', '山の日');
  else if (y === 2021) add('2021-08-08', '山の日');
  else if (y >= 2016) add(ymd(y, 8, 11), '山の日');
  // 敬老の日（2003年からハッピーマンデー）
  add(y >= 2003 ? nthWeekdayOfMonth(y, 9, MON, 3) : ymd(y, 9, 15), '敬老の日');
  add(ymd(y, 9, autumnalEquinoxDay(y)), '秋分の日');
  // 体育の日／スポーツの日（2000年からハッピーマンデー、2020年に改称。2020・2021年は移動）
  if (y === 2020) add('2020-07-24', 'スポーツの日');
  else if (y === 2021) add('2021-07-23', 'スポーツの日');
  else add(nthWeekdayOfMonth(y, 10, MON, 2), y >= 2020 ? 'スポーツの日' : '体育の日');
  add(ymd(y, 11, 3), '文化の日');
  add(ymd(y, 11, 23), '勤労感謝の日');
  if (y <= 2018) add(ymd(y, 12, 23), '天皇誕生日');
  if (y === 2019) { add('2019-05-01', '即位の日'); add('2019-10-22', '即位礼正殿の儀'); }

  var result = new Map(shukujitsu);
  // 国民の休日: 前日と翌日がともに「国民の祝日」で、自身は祝日でも日曜でもない日
  shukujitsu.forEach(function (name, ds) {
    var mid = dayAdd(ds, 1), next = dayAdd(ds, 2);
    if (shukujitsu.has(next) && !shukujitsu.has(mid) && dowOfStr(mid) !== 0) result.set(mid, '国民の休日');
  });
  // 振替休日: 国民の祝日が日曜なら、その後で最も近い「国民の祝日でない日」（2007年から）。
  // 2006年以前は翌日（月曜）のみ。
  shukujitsu.forEach(function (name, ds) {
    if (dowOfStr(ds) !== 0) return;
    var d = dayAdd(ds, 1);
    if (y >= 2007) { while (shukujitsu.has(d)) d = dayAdd(d, 1); }
    else if (shukujitsu.has(d)) return;
    if (!result.has(d)) result.set(d, '振替休日');
  });
  return result;
}

function holidaysOfYear(y) {
  if (y < HOLIDAY_YEAR_MIN || y > HOLIDAY_YEAR_MAX) return null;
  if (!holidayCache.has(y)) holidayCache.set(y, computeHolidaysOfYear(y));
  return holidayCache.get(y);
}

/* 祝日名。祝日でなければ null。範囲外の年は「祝日情報なし」として null。 */
function holidayNameOf(dateStr) {
  var table = holidaysOfYear(Number(dateStr.slice(0, 4)));
  if (!table) return null;
  return table.get(dateStr) || null;
}

/* =========================================================================
 * 2. その他ユーティリティ
 * ========================================================================= */
function generateId() {
  return 't_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
}

function escapeXml(value) {
  return String(value)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '') // XML1.0で不正な制御文字を除去（Tab/LF/CRは対象外）
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/* 表示用に文字列を短くする（エラーメッセージ等でタスク名を示すとき用。表示は必ず textContent 経由） */
function truncateText(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function utf8ByteLength(s) { return new TextEncoder().encode(s).length; }

/* 保存前の容量検査。読込み上限（MAX_FILE_SIZE）を超えるデータは、保存しても開けないため書き出さない */
function checkWbsprojSaveSize(text, maxBytes) {
  var limit = maxBytes == null ? MAX_FILE_SIZE : maxBytes;
  var bytes = utf8ByteLength(text);
  if (bytes <= limit) return { ok: true, bytes: bytes };
  return {
    ok: false, bytes: bytes,
    message: 'データ量が約' + (Math.ceil(bytes / 1024 / 1024 * 10) / 10) + 'MBあり、開ける上限（' + MAX_FILE_SIZE_LABEL + '）を超えるため保存できません。' +
      'メモを短くする、不要なタスクを削除する等で減らしてから保存してください。'
  };
}

/* 「大事業は実効期間、小事業は計画期間」を返す共通関数（R02-13: 8箇所に散っていた分岐を集約） */
function rangeOf(task, d) {
  if (task.level === 'major') return { start: d ? d.effectiveStart : null, end: d ? d.effectiveEnd : null };
  return { start: task.plannedStart, end: task.plannedEnd };
}

/* DOM生成ヘルパー。innerHTML/insertAdjacentHTML/document.writeは本アプリ内で一切使用しない。
   ユーザー由来の値は必ずtextContent（createTextNode）またはDOMプロパティ経由でのみDOMに反映する。 */
function el(tag, props, children) {
  var e = document.createElement(tag);
  if (props) {
    for (var k in props) {
      if (!Object.prototype.hasOwnProperty.call(props, k)) continue;
      var v = props[k];
      if (v == null || v === false) continue;
      if (k === 'className') e.className = v;
      else if (k === 'style' && typeof v === 'object') { for (var sk in v) e.style[sk] = v[sk]; }
      else if (k.indexOf('on') === 0 && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'text') e.appendChild(document.createTextNode(v));
      else if (k === 'value') e.value = v;
      else if (v === true) e.setAttribute(k, '');
      else e.setAttribute(k, v);
    }
  }
  if (children) {
    var arr = Array.isArray(children) ? children : [children];
    for (var i = 0; i < arr.length; i++) {
      var c = arr[i];
      if (c == null || c === false) continue;
      e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
  }
  return e;
}

function svgEl(tag, attrs) {
  var e = document.createElementNS('http://www.w3.org/2000/svg', tag);
  if (attrs) {
    for (var k in attrs) {
      if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
      if (attrs[k] == null) continue;
      e.setAttribute(k, attrs[k]);
    }
  }
  return e;
}

function svgTitle(text) { var t = svgEl('title'); t.textContent = text; return t; }

function clearChildren(node) { while (node.firstChild) node.removeChild(node.firstChild); }

/* =========================================================================
 * 3. 計算エンジン
 * 仕様は各関数の説明と tests/calc.test.cjs・tests/v12.test.cjs を参照。
 * 計算の仕様そのものではない追加の防御処理（null安全等）は "拡張:" コメントで示す。
 * ========================================================================= */

/* parentId → 小事業の配列（配列順を保つ）。大事業ごとに全タスクを走査しないための索引 */
function buildChildrenIndex(tasks) {
  var idx = new Map();
  for (var i = 0; i < tasks.length; i++) {
    var t = tasks[i];
    if (t.level !== 'minor') continue;
    if (!idx.has(t.parentId)) idx.set(t.parentId, []);
    idx.get(t.parentId).push(t);
  }
  return idx;
}

/* ---- v1.2 5節: 大事業の期間ロールアップ（手入力の開始・終了を子の日付と同じく独立に候補へ入れる） ---- */
function computeEffectivePeriod(major, childMinors) {
  var starts = [], ends = [], i;
  for (i = 0; i < childMinors.length; i++) {
    if (childMinors[i].plannedStart != null) starts.push(childMinors[i].plannedStart);
    if (childMinors[i].plannedEnd != null) ends.push(childMinors[i].plannedEnd);
  }
  if (major.plannedStart != null) starts.push(major.plannedStart);
  if (major.plannedEnd != null) ends.push(major.plannedEnd);
  var s = starts.length > 0 ? minDateStr(starts) : null;
  var e = ends.length > 0 ? maxDateStr(ends) : null;
  // 拡張: 片方だけの日付を持つ子が混在する不整合データで s>e になり得るため、両端を包む向きに正す
  if (s != null && e != null && s > e) { var tmp = s; s = e; e = tmp; }
  return [s, e];
}

/* ---- v1.2 4節: 進捗ロールアップ（小事業を持たない大事業は自身の progress を使う） ---- */
function computeMajorRawProgress(major, childMinors) {
  if (childMinors.length === 0) {
    return (major && typeof major.progress === 'number') ? major.progress : null;
  }
  var totalWeight = 0, weightedSum = 0;
  for (var i = 0; i < childMinors.length; i++) {
    var m = childMinors[i];
    if (m.plannedStart == null || m.plannedEnd == null) continue;
    var weight = inclusiveDays(m.plannedStart, m.plannedEnd); // マイルストーンは常に1
    weightedSum += m.progress * weight;
    totalWeight += weight;
  }
  if (totalWeight === 0) return null;
  return weightedSum / totalWeight;
}

/* ---- 3章: 遅延判定（v1.2 2.2節: progress が null/NaN なら unknown） ---- */
function computeDelayStatus(effectiveStart, effectiveEnd, progressPercent, referenceDate) {
  if (effectiveStart == null || effectiveEnd == null) return 'unknown';
  if (effectiveStart > effectiveEnd) return 'unknown'; // 拡張: 不整合データの防御
  if (progressPercent == null || (typeof progressPercent === 'number' && isNaN(progressPercent))) return 'unknown';
  if (progressPercent >= 100) return 'onTrack';

  var totalDays = inclusiveDays(effectiveStart, effectiveEnd);
  var elapsedDays = clamp(dayDiff(referenceDate, effectiveStart) + 1, 0, totalDays);
  var gap = progressPercent - (elapsedDays / totalDays) * 100;

  var classification;
  if (gap >= -20) classification = 'onTrack';
  else if (gap >= -40) classification = 'atRisk';
  else classification = 'delayed';

  if (referenceDate > effectiveEnd && progressPercent < 100 && classification === 'onTrack') {
    classification = 'atRisk';
  }
  return classification;
}

/* ---- 4章: ベースライン差分（v1.2 3節: 値は保存時に固定、差分は表示・出力のたびに計算） ---- */
function computeBaselineDiff(effectiveStart, effectiveEnd, baselineStart, baselineEnd) {
  if (baselineStart == null || baselineEnd == null) {
    return { startDeltaDays: null, endDeltaDays: null, durationDeltaDays: null, classification: 'ベースライン未設定' };
  }
  if (effectiveStart == null || effectiveEnd == null) {
    return { startDeltaDays: null, endDeltaDays: null, durationDeltaDays: null, classification: '算出不可' };
  }
  var startDeltaDays = dayDiff(effectiveStart, baselineStart);
  var endDeltaDays = dayDiff(effectiveEnd, baselineEnd);
  var durationDeltaDays = inclusiveDays(effectiveStart, effectiveEnd) - inclusiveDays(baselineStart, baselineEnd);
  var classification = endDeltaDays > 0 ? '遅延' : (endDeltaDays < 0 ? '前倒し' : '変更なし');
  return { startDeltaDays: startDeltaDays, endDeltaDays: endDeltaDays, durationDeltaDays: durationDeltaDays, classification: classification };
}

/* 当初比（v1.4）: 修正後の終了日−当初の終了日（マイルストーンは日付）。当初計画が無ければ null */
function planDeltaOf(task, d) {
  if (!task.baselineStart || !task.baselineEnd) return null;
  var r = rangeOf(task, d || {});
  var cur = task.isMilestone ? r.start : r.end, base = task.isMilestone ? task.baselineStart : task.baselineEnd;
  if (!cur) return null;
  var days = dayDiff(cur, base);
  return { days: days, text: days > 0 ? '+' + days + '日' : (days < 0 ? '−' + (-days) + '日' : '±0') };
}

/* ---- 5章: FS依存関係の自動スライド ---- */
function requiredMinStart(task, idMap) {
  if (task.predecessors.length === 0) return null;
  var maxDate = null;
  for (var i = 0; i < task.predecessors.length; i++) {
    var pred = idMap.get(task.predecessors[i]);
    if (!pred) continue;                    // ダングリング参照は無視
    if (pred.plannedEnd == null) continue;  // 拡張: 先行の終了日が未確定なら制約対象外
    var candidate = dayAdd(pred.plannedEnd, 1);
    if (maxDate == null || candidate > maxDate) maxDate = candidate;
  }
  return maxDate;
}

function applyFsConstraint(task, idMap) {
  var minStart = requiredMinStart(task, idMap);
  if (minStart == null) return false;
  if (task.plannedStart == null) return false; // 拡張: 自タスクの開始日が未入力ならスライド対象外
  if (task.plannedStart >= minStart) return false;
  var shiftDays = dayDiff(minStart, task.plannedStart);
  // 拡張: 許容範囲の上限（2099-12-31）を越えて押し出さない（UIで作ったデータを読込検証が拒否する経路を作らない）
  if (task.plannedEnd != null) shiftDays = Math.min(shiftDays, dayDiff(DATE_MAX, task.plannedEnd));
  else shiftDays = Math.min(shiftDays, dayDiff(DATE_MAX, task.plannedStart));
  if (shiftDays <= 0) return false;
  task.plannedStart = dayAdd(task.plannedStart, shiftDays);
  if (task.plannedEnd != null) task.plannedEnd = dayAdd(task.plannedEnd, shiftDays);
  return true;
}

function applyAutoSlideAll(minorTasks, sortedIds) {
  var idMap = new Map();
  for (var i = 0; i < minorTasks.length; i++) idMap.set(minorTasks[i].id, minorTasks[i]);
  var changedIds = [];
  for (var j = 0; j < sortedIds.length; j++) {
    var task = idMap.get(sortedIds[j]);
    if (task && applyFsConstraint(task, idMap)) changedIds.push(sortedIds[j]);
  }
  return changedIds;
}

/* ---- 5.5章: 循環依存の検出（DFS、白/灰/黒。スタックオーバーフロー回避のため反復実装） ---- */
function detectCycle(minorTasks) {
  var WHITE = 0, GRAY = 1, BLACK = 2;
  var idMap = new Map(), color = new Map(), i;
  for (i = 0; i < minorTasks.length; i++) { idMap.set(minorTasks[i].id, minorTasks[i]); color.set(minorTasks[i].id, WHITE); }

  for (i = 0; i < minorTasks.length; i++) {
    var startId = minorTasks[i].id;
    if (color.get(startId) !== WHITE) continue;
    var stack = [{ id: startId, idx: 0 }];
    color.set(startId, GRAY);
    while (stack.length > 0) {
      var top = stack[stack.length - 1];
      var preds = idMap.get(top.id).predecessors;
      if (top.idx < preds.length) {
        var predId = preds[top.idx];
        top.idx++;
        if (!idMap.has(predId)) continue;
        var c = color.get(predId);
        if (c === GRAY) {
          var path = [];
          for (var s = 0; s < stack.length; s++) path.push(stack[s].id);
          return { hasCycle: true, cyclePath: path.slice(path.indexOf(predId)).concat([predId]) };
        } else if (c === WHITE) {
          color.set(predId, GRAY);
          stack.push({ id: predId, idx: 0 });
        }
      } else {
        color.set(top.id, BLACK);
        stack.pop();
      }
    }
  }
  return { hasCycle: false };
}

/* taskId が（直接・間接に）先行となっている小事業の集合＝taskId の後続すべて。
   これらを taskId の先行に指定すると循環になる（フォームで選択不可にする: A1/C7）。 */
function transitiveSuccessorsOf(minorTasks, taskId) {
  var succMap = new Map(), i, j;
  for (i = 0; i < minorTasks.length; i++) {
    var t = minorTasks[i];
    for (j = 0; j < t.predecessors.length; j++) {
      var p = t.predecessors[j];
      if (!succMap.has(p)) succMap.set(p, []);
      succMap.get(p).push(t.id);
    }
  }
  var seen = new Set(), queue = [taskId], qi = 0;
  while (qi < queue.length) {
    var succs = succMap.get(queue[qi++]) || [];
    for (j = 0; j < succs.length; j++) {
      if (!seen.has(succs[j]) && succs[j] !== taskId) { seen.add(succs[j]); queue.push(succs[j]); }
    }
  }
  return seen;
}

/* taskId の先行を newPreds にした場合に循環が生じるなら、その経路（id配列: taskId → … → taskId）を返す。生じなければ null。 */
function findCycleIfPredecessorsSet(minorTasks, taskId, newPreds) {
  var predMap = new Map(), i;
  for (i = 0; i < minorTasks.length; i++) predMap.set(minorTasks[i].id, minorTasks[i].predecessors);
  predMap.set(taskId, newPreds);
  // newPreds の各要素から「先行」をたどり taskId に到達すれば循環（taskId → … → p → taskId）
  for (i = 0; i < newPreds.length; i++) {
    if (newPreds[i] === taskId) return [taskId, taskId];
    var parent = new Map(), queue = [newPreds[i]], qi = 0, found = false;
    parent.set(newPreds[i], null);
    while (qi < queue.length && !found) {
      var cur = queue[qi++];
      var preds = predMap.get(cur) || [];
      for (var k = 0; k < preds.length; k++) {
        var nx = preds[k];
        if (parent.has(nx)) continue;
        parent.set(nx, cur);
        if (nx === taskId) { found = true; break; }
        queue.push(nx);
      }
    }
    if (found) {
      // taskId から newPreds[i] まで「後続方向」に並べ直す
      var chain = [], node = taskId;
      while (node != null) { chain.push(node); node = parent.get(node); }
      return chain.concat([taskId]);
    }
  }
  return null;
}

/* ---- 6.1章: トポロジカルソート（Kahn法）。循環がない前提。 ---- */
function topologicalSortSafe(minorTasks) {
  var inDegree = new Map(), successorsOf = new Map(), i;
  for (i = 0; i < minorTasks.length; i++) {
    inDegree.set(minorTasks[i].id, 0);
    successorsOf.set(minorTasks[i].id, []);
  }
  for (i = 0; i < minorTasks.length; i++) {
    var t = minorTasks[i];
    for (var j = 0; j < t.predecessors.length; j++) {
      var predId = t.predecessors[j];
      if (!inDegree.has(predId)) continue;
      successorsOf.get(predId).push(t.id);
      inDegree.set(t.id, inDegree.get(t.id) + 1);
    }
  }
  var queue = [];
  for (i = 0; i < minorTasks.length; i++) if (inDegree.get(minorTasks[i].id) === 0) queue.push(minorTasks[i].id);
  var sorted = [], qi = 0;
  while (qi < queue.length) {
    var id = queue[qi++];
    sorted.push(id);
    var succs = successorsOf.get(id);
    for (var k = 0; k < succs.length; k++) {
      inDegree.set(succs[k], inDegree.get(succs[k]) - 1);
      if (inDegree.get(succs[k]) === 0) queue.push(succs[k]);
    }
  }
  if (sorted.length !== minorTasks.length) {
    console.warn('[NovaChart] topologicalSortSafe: unexpected residual (cycle not pre-filtered)');
    var doneSet = new Set(sorted);
    for (i = 0; i < minorTasks.length; i++) if (!doneSet.has(minorTasks[i].id)) sorted.push(minorTasks[i].id);
  }
  return sorted;
}

/* ---- v1.2 1章: クリティカルパス（計画日付ベース）。日付は変更しない読み取り専用の分析。 ----
   ES=epoch(開始)、EF=epoch(終了)+1（排他的終端）。projectEnd=日付を持つ全小事業のEFの最大値。
   後退パスは日付を持つタスクだけを先行・後続として数える。totalFloat=LS−ES、isCritical=(totalFloat<=0)。
   日付が欠けた小事業は除外（全値null・isCritical=false）。日付を持つ小事業が0件なら全体をスキップ。
   戻り値: Map(id → {duration,ES,EF,LS,LF,totalFloat,isCritical}) ※第2引数は互換のため受け取るが使わない */
function computeCriticalPath(minorTasks) {
  var result = new Map(), dated = [], i, t;
  for (i = 0; i < minorTasks.length; i++) {
    t = minorTasks[i];
    result.set(t.id, { duration: null, ES: null, EF: null, LS: null, LF: null, totalFloat: null, isCritical: false });
    if (t.plannedStart != null && t.plannedEnd != null) dated.push(t);
  }
  if (dated.length === 0) return result;

  var info = new Map(), projectEnd = -Infinity;
  for (i = 0; i < dated.length; i++) {
    t = dated[i];
    var es = toEpochDay(t.plannedStart), ef = toEpochDay(t.plannedEnd) + 1;
    info.set(t.id, { duration: ef - es, ES: es, EF: ef, LS: null, LF: null, totalFloat: null, isCritical: false });
    if (ef > projectEnd) projectEnd = ef;
  }

  var successorsOf = new Map();
  for (i = 0; i < dated.length; i++) successorsOf.set(dated[i].id, []);
  for (i = 0; i < dated.length; i++) {
    t = dated[i];
    for (var j = 0; j < t.predecessors.length; j++) {
      if (info.has(t.predecessors[j])) successorsOf.get(t.predecessors[j]).push(t.id);
    }
  }

  var sorted = topologicalSortSafe(dated);
  for (i = sorted.length - 1; i >= 0; i--) {
    var d = info.get(sorted[i]);
    var succs = successorsOf.get(sorted[i]);
    if (succs.length === 0) {
      d.LF = projectEnd;
    } else {
      var minLS = Infinity;
      for (var s = 0; s < succs.length; s++) { var ls = info.get(succs[s]).LS; if (ls < minLS) minLS = ls; }
      d.LF = minLS;
    }
    d.LS = d.LF - d.duration;
  }
  info.forEach(function (d, id) {
    d.totalFloat = d.LS - d.ES;
    d.isCritical = d.totalFloat <= 0; // v1.2 1.7節: 理論上は0以上。<= は安全弁
    result.set(id, d);
  });
  return result;
}

/* v1.2 1.9節: 依存矢印（先行→後続の1本）がクリティカルか。エッジ単位で判定する。 */
function isCriticalEdge(predId, succId, derivedMap) {
  var p = derivedMap.get(predId), s = derivedMap.get(succId);
  if (!p || !s || p.ES == null || s.ES == null) return false;
  return p.isCritical === true && s.isCritical === true && s.ES === p.EF;
}

/* ---- 8章: 計算パイプライン全体
   1) 正規化（小事業のマイルストーンは終了日=開始日、大事業は isMilestone=false）→ 2) 循環検出 →
   3) [循環なしのみ] FS自動スライド → 4) 大事業ロールアップ → 5) 遅延判定 → 6) [循環なしのみ] クリティカルパス
   v1.2 2.1節: 循環時に止めるのは自動スライドとクリティカルパスのみ（ロールアップ・遅延判定は続ける）。 */
function recomputeAll(project, referenceDate) {
  var majors = [], minors = [], i, t;
  for (i = 0; i < project.tasks.length; i++) {
    t = project.tasks[i];
    if (t.level === 'major') majors.push(t); else minors.push(t);
  }

  for (i = 0; i < minors.length; i++) {
    var mt = minors[i];
    if (mt.isMilestone && mt.plannedStart != null) mt.plannedEnd = mt.plannedStart;
  }
  for (i = 0; i < majors.length; i++) majors[i].isMilestone = false;

  var cycleResult = detectCycle(minors);
  var slideChangedIds = [];
  if (!cycleResult.hasCycle) {
    slideChangedIds = applyAutoSlideAll(minors, topologicalSortSafe(minors));
  }

  var derived = new Map();
  for (i = 0; i < project.tasks.length; i++) derived.set(project.tasks[i].id, {});
  var childrenIdx = buildChildrenIndex(project.tasks);

  for (i = 0; i < majors.length; i++) {
    var major = majors[i];
    var children = childrenIdx.get(major.id) || [];
    var period = computeEffectivePeriod(major, children);
    var rawProgress = computeMajorRawProgress(major, children);
    var dm = derived.get(major.id);
    dm.effectiveStart = period[0];
    dm.effectiveEnd = period[1];
    dm.rawProgress = rawProgress;
    dm.displayProgress = (rawProgress == null) ? null : roundHalfUp(rawProgress);
    dm.hasChildren = children.length > 0;
    // v1.2 4.2節: 子を持つ大事業の progress は派生値で上書き。子0件の大事業は手入力値をそのまま保つ
    if (children.length > 0) major.progress = dm.displayProgress == null ? 0 : dm.displayProgress;
  }
  for (i = 0; i < minors.length; i++) {
    var dmi = derived.get(minors[i].id);
    dmi.effectiveStart = minors[i].plannedStart;
    dmi.effectiveEnd = minors[i].plannedEnd;
  }

  for (i = 0; i < project.tasks.length; i++) {
    t = project.tasks[i];
    var dt = derived.get(t.id);
    dt.delayStatus = computeDelayStatus(dt.effectiveStart, dt.effectiveEnd,
      t.level === 'major' ? dt.rawProgress : t.progress, referenceDate);
  }

  if (!cycleResult.hasCycle) {
    var cp = computeCriticalPath(minors);
    for (i = 0; i < minors.length; i++) {
      var c = cp.get(minors[i].id), dd = derived.get(minors[i].id);
      dd.ES = c.ES; dd.EF = c.EF; dd.LS = c.LS; dd.LF = c.LF;
      dd.totalFloat = c.totalFloat; dd.isCritical = c.isCritical;
    }
  } else {
    for (i = 0; i < minors.length; i++) {
      var d2 = derived.get(minors[i].id);
      d2.ES = d2.EF = d2.LS = d2.LF = d2.totalFloat = null;
      d2.isCritical = false;
    }
  }

  var cycleInfo = null;
  if (cycleResult.hasCycle) {
    var nameById = new Map();
    for (i = 0; i < project.tasks.length; i++) nameById.set(project.tasks[i].id, project.tasks[i].name);
    cycleInfo = {
      path: cycleResult.cyclePath,
      message: cycleResult.cyclePath.map(function (id) { return nameById.get(id) || id; }).join(' → ')
    };
  }
  return { derived: derived, cycleInfo: cycleInfo, slideChangedIds: slideChangedIds };
}

/* ---- 7.2章: WBS番号（大事業=表示順1始まり連番／小事業="親番号.子連番"） ---- */
function computeWbsNumbers(project) {
  var map = new Map(), childrenIdx = buildChildrenIndex(project.tasks), majorNo = 0;
  for (var i = 0; i < project.tasks.length; i++) {
    var t = project.tasks[i];
    if (t.level !== 'major') continue;
    majorNo++;
    map.set(t.id, String(majorNo));
    var children = childrenIdx.get(t.id) || [];
    for (var j = 0; j < children.length; j++) map.set(children[j].id, majorNo + '.' + (j + 1));
  }
  return map;
}

/* =========================================================================
 * 4. データモデル（正本フィールドのみ。派生値は含まない）
 * ========================================================================= */
function createTask(level, parentId) {
  return {
    id: generateId(),
    level: level,                 // "major" | "minor"
    parentId: parentId || null,
    name: '',
    owner: '',
    plannedStart: null,
    plannedEnd: null,
    progress: 0,
    isMilestone: false,
    predecessors: [],
    baselineStart: null,
    baselineEnd: null,
    memo: '',
    tentative: false              // v1.5: 日程が目安（はっきり決まっていない）
  };
}

function createEmptyProject() {
  return { name: '', tasks: [], baselineSavedAt: null, period: null, schemaVersion: SCHEMA_VERSION };
}

/* プロジェクトの期間（v1.4、任意）。正しければ {start,end}、無ければ null、不正なら undefined */
function parsePeriod(raw) {
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw) || hasDangerousKey(raw)) return undefined;
  if (!isAppDate(raw.start) || !isAppDate(raw.end) || raw.start > raw.end) return undefined;
  return { start: raw.start, end: raw.end };
}

/* =========================================================================
 * 5. 保存ファイル（.json）の検証パイプライン（v1.2、v1.3で目印 format を追加）
 * 参照: tests/validation.test.cjs（安全要件の回帰テスト）
 * 方針（v1.2 で決定）:
 *  - 構造の破損・不正な値（形式・範囲・長さ・型）→ 拒否。全項目を通過するまで画面は書き換えない（all-or-nothing）
 *  - 実行時に安全に扱える意味上の問題（循環・存在しない先行・自己参照・大事業を先行に指定・日付の欠け）
 *    → 拒否せず正規化し warnings で知らせる。拒否すると「自分で保存したファイルが開けない」事故になる（R01-01）
 *  - id参照は素の{}ではなくMap。コピーはホワイトリスト（プロトタイプ汚染対策）
 *  - エラーには「◯件目のタスク」を付ける。値そのものは出さない（名前は短縮し、表示は必ず textContent 経由）
 * ========================================================================= */
var DANGEROUS_KEYS = ['__proto__', 'constructor', 'prototype'];
var ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?$/;

function hasDangerousKey(obj) {
  return Object.keys(obj).some(function (k) { return DANGEROUS_KEYS.indexOf(k) !== -1; });
}

function vfail(message) { return { ok: false, message: message }; }

function taskLabel(i, t) {
  var name = (t && typeof t.name === 'string' && t.name.trim()) ? '「' + truncateText(t.name.trim(), 20) + '」' : '';
  return (i + 1) + '件目のタスク' + name;
}

/* 日付フィールドの検証。null は可。不正なら理由の文字列、正常なら null を返す */
function checkDateField(v, label) {
  if (v === null) return null;
  if (!isValidDateString(v)) return label + 'の形式が不正です（YYYY-MM-DD の実在する日付である必要があります）。';
  if (v < DATE_MIN || v > DATE_MAX) return label + 'が扱える範囲（' + DATE_MIN + '〜' + DATE_MAX + '）の外です。';
  return null;
}

/* 自動保存や保存ファイルに付随する表示設定（任意）。不正なら黙って無視する（本体データではないため） */
function sanitizeUiSettings(rawUi, validIds) {
  if (rawUi == null || typeof rawUi !== 'object' || Array.isArray(rawUi) || hasDangerousKey(rawUi)) return null;
  var out = {};
  if (SCALE_ORDER.indexOf(rawUi.scale) !== -1) out.scale = rawUi.scale;
  if (typeof rawUi.detailMode === 'boolean') out.detailMode = rawUi.detailMode;
  if (Array.isArray(rawUi.expanded) && rawUi.expanded.length <= MAX_TASKS) {
    out.expanded = rawUi.expanded.filter(function (x) { return typeof x === 'string' && validIds.has(x); });
  }
  return out;
}

/* text: ファイル内容の文字列 / byteSize: UTF-8のバイト数
   戻り値: { ok:true, project, ui, warnings[] } または { ok:false, message } */
function validateWbsprojText(text, byteSize) {
  if (byteSize > MAX_FILE_SIZE) return vfail('ファイルサイズが上限（' + MAX_FILE_SIZE_LABEL + '）を超えています。');

  var raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    console.error('[wbsproj parse error]', e);
    return vfail('ファイルの形式を読み取れませんでした。' + APP_DISPLAY_NAME + '（旧名 NovaChart）で保存した .json ファイルかご確認ください。');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return vfail('ファイルの内容が想定と異なります。');
  if (hasDangerousKey(raw)) return vfail('ファイルの内容が想定と異なります。');
  // 目印があれば一致を確認する。目印のないデータ（旧 .wbsproj の中身・自動保存）は内容の検査で判断する
  if (raw.format !== undefined && raw.format !== FILE_FORMAT) return vfail(NOT_WBS_MESSAGE);
  if (!Array.isArray(raw.tasks)) return vfail(raw.format === FILE_FORMAT ? 'タスク一覧が見つかりません。' : NOT_WBS_MESSAGE);
  if (raw.tasks.length > MAX_TASKS) return vfail('タスク数が上限（' + MAX_TASKS + '件）を超えています。');

  var i, t, msg;
  for (i = 0; i < raw.tasks.length; i++) {
    t = raw.tasks[i];
    if (t == null || typeof t !== 'object' || Array.isArray(t)) return vfail((i + 1) + '件目のタスクのデータ形式が不正です。');
    if (hasDangerousKey(t)) return vfail('ファイルの内容が想定と異なります。');
  }

  if (raw.name !== undefined && typeof raw.name !== 'string') return vfail('プロジェクト名の形式が不正です。');
  if (typeof raw.name === 'string' && raw.name.length > MAX_PROJECT_NAME_LEN) {
    return vfail('プロジェクト名が文字数上限（' + MAX_PROJECT_NAME_LEN + '字）を超えています。');
  }
  if (raw.baselineSavedAt != null &&
      (typeof raw.baselineSavedAt !== 'string' || raw.baselineSavedAt.length > 40 || !ISO_DATETIME_RE.test(raw.baselineSavedAt))) {
    return vfail('ベースライン保存日時の形式が不正です。');
  }

  // 第1パス: フィールド単位
  var ids = new Set(), majorIds = new Set();
  for (i = 0; i < raw.tasks.length; i++) {
    t = raw.tasks[i];
    var L = taskLabel(i, t);
    if (typeof t.id !== 'string' || t.id.length === 0 || t.id.length > MAX_ID_LEN) return vfail(L + 'のIDが不正です。');
    if (ids.has(t.id)) return vfail(L + 'のIDが他のタスクと重複しています。');
    ids.add(t.id);
    if (t.level !== 'major' && t.level !== 'minor') return vfail(L + 'の階層区分が不正です。');
    if (t.level === 'major') {
      majorIds.add(t.id);
      if (t.parentId !== null) return vfail(L + '（大事業）に親が指定されています。');
    } else if (typeof t.parentId !== 'string' || t.parentId.length === 0 || t.parentId.length > MAX_ID_LEN) {
      return vfail(L + '（小事業）に親の大事業が指定されていません。');
    }
    if (typeof t.name !== 'string' || t.name.trim().length === 0 || t.name.length > MAX_NAME_LEN) {
      return vfail(L + 'の事業名が空か、文字数上限（' + MAX_NAME_LEN + '字）を超えています。');
    }
    if (typeof t.owner !== 'string' || t.owner.length > MAX_OWNER_LEN) {
      return vfail(L + 'の担当者名が文字数上限（' + MAX_OWNER_LEN + '字）を超えています。');
    }
    if ((msg = checkDateField(t.plannedStart, '開始日'))) return vfail(L + 'の' + msg);
    if ((msg = checkDateField(t.plannedEnd, '終了日'))) return vfail(L + 'の' + msg);
    if (t.plannedStart != null && t.plannedEnd != null && t.plannedStart > t.plannedEnd) {
      return vfail(L + 'の開始日が終了日より後になっています。');
    }
    // 大事業の progress は小事業の加重平均（整数）が保存されるため 0〜100 の整数を許す（子を持つ大事業は読込み後の再計算で上書きされる）
    if (t.level === 'major') {
      if (typeof t.progress !== 'number' || !Number.isInteger(t.progress) || t.progress < 0 || t.progress > 100) {
        return vfail(L + 'の進捗率が不正です（0〜100の整数である必要があります）。');
      }
    } else if (typeof t.progress !== 'number' || VALID_PROGRESS.indexOf(t.progress) === -1) {
      return vfail(L + 'の進捗率が不正です（0/20/40/60/80/100のいずれかである必要があります）。');
    }
    if (typeof t.isMilestone !== 'boolean') return vfail(L + 'のマイルストーン区分が不正です。');
    if (!Array.isArray(t.predecessors)) return vfail(L + 'の先行タスクの形式が不正です。');
    if (t.predecessors.length > MAX_PREDECESSORS) return vfail(L + 'の先行タスクが上限（' + MAX_PREDECESSORS + '件）を超えています。');
    for (var pi = 0; pi < t.predecessors.length; pi++) {
      var p = t.predecessors[pi];
      if (typeof p !== 'string' || p.length === 0 || p.length > MAX_ID_LEN) return vfail(L + 'の先行タスクの指定が不正です。');
    }
    if ((msg = checkDateField(t.baselineStart, 'ベースライン開始日'))) return vfail(L + 'の' + msg);
    if ((msg = checkDateField(t.baselineEnd, 'ベースライン終了日'))) return vfail(L + 'の' + msg);
    if (t.baselineStart != null && t.baselineEnd != null && t.baselineStart > t.baselineEnd) {
      return vfail(L + 'のベースラインの開始日が終了日より後になっています。');
    }
    if (typeof t.memo !== 'string' || t.memo.length > MAX_MEMO_LEN) {
      return vfail(L + 'のメモが文字数上限（' + MAX_MEMO_LEN + '字）を超えています。');
    }
    // v1.5 で追加した任意の項目。無ければ false（v1.4 以前のファイル）
    if (t.tentative !== undefined && typeof t.tentative !== 'boolean') return vfail(L + 'の「日程は目安」の区分が不正です。');
  }

  // 第2パス: 参照整合性（構造の破損は拒否）
  for (i = 0; i < raw.tasks.length; i++) {
    t = raw.tasks[i];
    if (t.level === 'minor' && !majorIds.has(t.parentId)) return vfail(taskLabel(i, t) + 'の親の大事業が見つかりません。');
  }

  // ホワイトリストコピー＋意味上の問題の正規化（拒否しない）
  var warnings = [];
  var dropped = { self: 0, ghost: 0, major: 0, majorPreds: 0 }, missingDates = 0;
  var cleanTasks = [];
  for (i = 0; i < raw.tasks.length; i++) {
    t = raw.tasks[i];
    var preds = [];
    if (t.level === 'major') {
      if (t.predecessors.length > 0) dropped.majorPreds++;
    } else {
      var seen = new Set();
      for (var pj = 0; pj < t.predecessors.length; pj++) {
        var pid = t.predecessors[pj];
        if (seen.has(pid)) continue;          // 重複は黙って除く
        seen.add(pid);
        if (pid === t.id) { dropped.self++; continue; }
        if (!ids.has(pid)) { dropped.ghost++; continue; }
        if (majorIds.has(pid)) { dropped.major++; continue; }
        preds.push(pid);
      }
      if (t.plannedStart == null || t.plannedEnd == null) missingDates++;
    }
    cleanTasks.push({
      id: t.id,
      level: t.level,
      parentId: t.level === 'major' ? null : t.parentId,
      name: t.name,
      owner: t.owner,
      plannedStart: t.plannedStart,
      plannedEnd: t.plannedEnd,
      progress: t.progress,
      isMilestone: t.level === 'major' ? false : t.isMilestone,
      predecessors: preds,
      baselineStart: t.baselineStart,
      baselineEnd: t.baselineEnd,
      memo: t.memo,
      tentative: t.tentative === true
    });
  }
  if (dropped.self > 0) warnings.push('自分自身を先行タスクに指定していた指定を ' + dropped.self + ' 件取り除きました。');
  if (dropped.ghost > 0) warnings.push('存在しないタスクを先行タスクに指定していた指定を ' + dropped.ghost + ' 件取り除きました。');
  if (dropped.major > 0) warnings.push('大事業を先行タスクに指定していた指定を ' + dropped.major + ' 件取り除きました（先行タスクに指定できるのは小事業だけです）。');
  if (dropped.majorPreds > 0) warnings.push('大事業に付いていた先行タスクの指定を ' + dropped.majorPreds + ' 件分取り除きました。');
  if (missingDates > 0) warnings.push('開始日または終了日が未入力の小事業が ' + missingDates + ' 件あります（ガントに表示されません）。');

  var cleanMinors = cleanTasks.filter(function (x) { return x.level === 'minor'; });
  var cyc = detectCycle(cleanMinors);
  if (cyc.hasCycle) {
    var nameById = new Map(cleanTasks.map(function (x) { return [x.id, x.name]; }));
    warnings.push('先行タスクの指定が循環しています（' +
      cyc.cyclePath.map(function (id) { return truncateText(nameById.get(id), 20); }).join(' → ') +
      '）。循環を解消するまで、日程の自動調整とクリティカルパスの計算を止めています。');
  }
  var period = parsePeriod(raw.period);
  if (period === undefined) { period = null; warnings.push('期間の設定が正しくないため、期間の指定を外して開きました（タスクの日程はそのままです）。'); }
  if (typeof raw.schemaVersion === 'number' && raw.schemaVersion > SCHEMA_VERSION) {
    warnings.push('このファイルは新しい版の' + APP_DISPLAY_NAME + 'で作成されています。この版で扱えない情報は読み込まれていない可能性があります。');
  }

  return {
    ok: true,
    project: {
      name: typeof raw.name === 'string' ? raw.name : '',
      tasks: cleanTasks,
      baselineSavedAt: raw.baselineSavedAt == null ? null : raw.baselineSavedAt,
      period: period,
      schemaVersion: SCHEMA_VERSION
    },
    ui: sanitizeUiSettings(raw.ui, ids),
    warnings: warnings
  };
}

/* =========================================================================
 * 6. Excel(.xlsx) 自前生成（外部ライブラリ不使用）
 *
 * ★数式インジェクション対策（v1.0から維持）: xlsx経路では先頭 ' を前置しない。構造的保証で担保する:
 *   ①文字列セルは必ず t="inlineStr" ②<f>（数式）要素を出力するコードパスを一切作らない ③XMLエスケープを必ず通す
 *
 * v1.2 の変更:
 *   - ガントの背景（土日・祝日・基準日）は「列スタイル」で表し、セルはバーの部分だけを書く（A5: セル数を1〜2桁削減）
 *   - ZIPを CompressionStream('deflate-raw') で圧縮（非対応環境は無圧縮にフォールバック）
 *   - Excelの列数上限（16,384列）とバーのセル数上限を出力前に検査（A5）
 *   - ウィンドウ枠固定はA〜D列、詳細列J〜Pは列グループで折りたたみ、印刷設定（A3横・横1ページ・見出し行の繰り返し）、
 *     1行目に基準日・出力日、凡例シートを追加（B9）
 *   - スキーマ必須属性 sheetFormatPr@defaultRowHeight を出力（v1.1は欠落していた）、折りたたんだグループに collapsed を付与
 * 「修復しました」対策の不変条件は tests/xlsx.test.cjs を参照。
 * ========================================================================= */

var CRC_TABLE = (function () {
  var table = new Uint32Array(256);
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  var crc = 0xFFFFFFFF;
  for (var i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function ByteWriter() { this.chunks = []; this.length = 0; }
ByteWriter.prototype.writeBytes = function (arr) { this.chunks.push(arr); this.length += arr.length; };
ByteWriter.prototype.writeUint16 = function (v) { this.writeBytes(new Uint8Array([v & 0xFF, (v >>> 8) & 0xFF])); };
ByteWriter.prototype.writeUint32 = function (v) {
  this.writeBytes(new Uint8Array([v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF]));
};
ByteWriter.prototype.toUint8Array = function () {
  var out = new Uint8Array(this.length), offset = 0;
  for (var i = 0; i < this.chunks.length; i++) { out.set(this.chunks[i], offset); offset += this.chunks[i].length; }
  return out;
};

function dosDateTime(date) {
  var y = date.getFullYear();
  var dosTime = ((date.getHours() & 0x1F) << 11) | ((date.getMinutes() & 0x3F) << 5) | ((date.getSeconds() >> 1) & 0x1F);
  var dosDate = (((y - 1980) & 0x7F) << 9) | (((date.getMonth() + 1) & 0xF) << 5) | (date.getDate() & 0x1F);
  return { dosTime: dosTime, dosDate: dosDate };
}

/* entries: [{ name, crc, usize, method(0|8), payload: Uint8Array }] → ZIP全体 */
function assembleZip(entries) {
  var encoder = new TextEncoder();
  var dt = dosDateTime(new Date());
  var local = new ByteWriter(), central = new ByteWriter();
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    var nameBytes = encoder.encode(e.name);
    var offset = local.length;
    local.writeUint32(0x04034b50);
    local.writeUint16(20);
    local.writeUint16(0);
    local.writeUint16(e.method);
    local.writeUint16(dt.dosTime);
    local.writeUint16(dt.dosDate);
    local.writeUint32(e.crc);
    local.writeUint32(e.payload.length); // 圧縮後サイズ（バイト）
    local.writeUint32(e.usize);          // 元のサイズ（UTF-8バイト長）
    local.writeUint16(nameBytes.length);
    local.writeUint16(0);
    local.writeBytes(nameBytes);
    local.writeBytes(e.payload);

    central.writeUint32(0x02014b50);
    central.writeUint16(20);
    central.writeUint16(20);
    central.writeUint16(0);
    central.writeUint16(e.method);
    central.writeUint16(dt.dosTime);
    central.writeUint16(dt.dosDate);
    central.writeUint32(e.crc);
    central.writeUint32(e.payload.length);
    central.writeUint32(e.usize);
    central.writeUint16(nameBytes.length);
    central.writeUint16(0);
    central.writeUint16(0);
    central.writeUint16(0);
    central.writeUint16(0);
    central.writeUint32(0);
    central.writeUint32(offset);
    central.writeBytes(nameBytes);
  }
  var eocd = new ByteWriter();
  eocd.writeUint32(0x06054b50);
  eocd.writeUint16(0);
  eocd.writeUint16(0);
  eocd.writeUint16(entries.length);
  eocd.writeUint16(entries.length);
  eocd.writeUint32(central.length);
  eocd.writeUint32(local.length);
  eocd.writeUint16(0);
  var out = new ByteWriter();
  out.writeBytes(local.toUint8Array());
  out.writeBytes(central.toUint8Array());
  out.writeBytes(eocd.toUint8Array());
  return out.toUint8Array();
}

/* files: [{name, data: Uint8Array}] → 無圧縮ZIP（同期。テスト・フォールバック用） */
function buildZip(files) {
  return assembleZip(files.map(function (f) {
    return { name: f.name, crc: crc32(f.data), usize: f.data.length, method: 0, payload: f.data };
  }));
}

function deflateRawAsync(bytes) {
  var stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Response(stream).arrayBuffer().then(function (ab) { return new Uint8Array(ab); });
}

/* 圧縮ZIP（非同期）。CompressionStream が使えない・失敗した場合は無圧縮で返す。 */
function buildZipAsync(files) {
  if (typeof CompressionStream === 'undefined' || typeof Response === 'undefined' || typeof Blob === 'undefined') {
    return Promise.resolve(buildZip(files));
  }
  return Promise.all(files.map(function (f) {
    return deflateRawAsync(f.data).then(function (comp) {
      var smaller = comp.length < f.data.length;
      return { name: f.name, crc: crc32(f.data), usize: f.data.length, method: smaller ? 8 : 0, payload: smaller ? comp : f.data };
    });
  })).then(assembleZip, function (err) {
    console.warn('[NovaChart] 圧縮に失敗したため無圧縮で出力します', err);
    return buildZip(files);
  });
}

function xmlFile(name, xmlString) {
  return { name: name, data: new TextEncoder().encode(xmlString) };
}

function colLetter(n) {
  var s = '';
  while (n > 0) {
    var rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/* styleIdx を渡すと値が空でも <c r s/> を出す（罫線・背景を見せるため）。0/未指定で値が空ならセル自体を省略。 */
function xCellStr(ref, value, styleIdx) {
  var sAttr = styleIdx ? ' s="' + styleIdx + '"' : '';
  if (value === null || value === undefined || value === '') {
    return styleIdx ? ('<c r="' + ref + '"' + sAttr + '/>') : '';
  }
  return '<c r="' + ref + '"' + sAttr + ' t="inlineStr"><is><t xml:space="preserve">' + escapeXml(value) + '</t></is></c>';
}
function xCellNum(ref, value, styleIdx) {
  var sAttr = styleIdx ? ' s="' + styleIdx + '"' : '';
  if (value === null || value === undefined || (typeof value === 'number' && !isFinite(value))) {
    return styleIdx ? ('<c r="' + ref + '"' + sAttr + '/>') : '';
  }
  return '<c r="' + ref + '"' + sAttr + '><v>' + Number(value) + '</v></c>';
}

var EXCEL_COLUMNS = ['階層', 'WBS番号', '事業名', '担当者', '開始日', '終了日', '日数', '進捗率(%)',
  '状態(遅延判定)', '当初計画 開始', '当初計画 終了', '差分日数(開始日)', '差分日数(終了日)',
  '差分日数(期間長)', '先行タスク', '備考'];
var EXCEL_DATA_COL_W = [8, 9, 34, 12, 11.5, 11.5, 6.5, 9, 13, 14, 14, 12, 12, 12, 14, 30];
var EXCEL_FREEZE_COLS = 4;          // A〜D（階層・WBS番号・事業名・担当者）
var EXCEL_DETAIL_FROM = 10, EXCEL_DETAIL_TO = 16;   // J〜P を列グループで折りたたむ
var EXCEL_MAX_BAR_CELLS = 3000000;  // バーのセル数の上限（ブラウザのメモリを守る）
var EXCEL_BASELINE_ROWS = true;     // v1.4: 当初計画のあるタスクの上に「当初計画」の行を入れる（2段書き）

/* 備考: 利用者のメモ＋システムの自動注記（R03-07: 自動注記には［自動］を付けて利用者のメモと区別する） */
function buildRemarksFor(task, isMajor, d) {
  var parts = [];
  if (task.tentative) parts.push('［目安］日程は確定していません');
  if (task.memo) parts.push(task.memo);
  if (isMajor && (task.plannedStart != null || task.plannedEnd != null)) {
    if (d.effectiveStart !== task.plannedStart || d.effectiveEnd !== task.plannedEnd) {
      parts.push('［自動］実効期間を拡張（小事業の日程に合わせて自動拡張）');
    }
  }
  return parts.join('｜');
}

/* 16列ぶんの行データ（7.1節） */
function buildExcelRowForTask(task, isMajor, project, derived, wbsNumbers, minorIds) {
  var d = derived.get(task.id) || {};
  var r = rangeOf(task, d);
  var displayProgress = isMajor ? d.displayProgress : task.progress;
  var bdiff = computeBaselineDiff(r.start, r.end, task.baselineStart, task.baselineEnd);
  // R04-01: 「先行タスク」列は小事業のidだけを番号に変換する
  var predText = isMajor ? '' : (task.predecessors || []).filter(function (pid) { return !minorIds || minorIds.has(pid); })
    .map(function (pid) { return wbsNumbers.get(pid); }).filter(function (x) { return !!x; }).join(', ');
  return {
    level: isMajor ? '大事業' : '小事業',
    wbsNo: wbsNumbers.get(task.id) || '',
    name: (isMajor ? '' : '  ') + (task.tentative ? TENTATIVE_PREFIX : '') + task.name,
    owner: task.owner || '',
    startStr: r.start || '',
    endStr: r.end || '',
    days: (r.start && r.end) ? inclusiveDays(r.start, r.end) : null,
    progress: (displayProgress == null) ? null : displayProgress,
    status: DELAY_LABELS[d.delayStatus] || '—',
    baselineStart: task.baselineStart || '',
    baselineEnd: task.baselineEnd || '',
    diffStart: bdiff.startDeltaDays,
    diffEnd: bdiff.endDeltaDays,
    diffDuration: bdiff.durationDeltaDays,
    predText: predText,
    remarks: buildRemarksFor(task, isMajor, d)
  };
}

function minorIdSet(project) {
  var s = new Set();
  for (var i = 0; i < project.tasks.length; i++) if (project.tasks[i].level === 'minor') s.add(project.tasks[i].id);
  return s;
}

/* 表示順（大事業→その小事業）の行モデル。opts.baselineRows のとき、当初計画のあるタスクの上に当初計画の行を入れる */
function buildRowModels(project, derived, wbsNumbers, opts) {
  var models = [], childrenIdx = buildChildrenIndex(project.tasks), minorIds = minorIdSet(project);
  var withBase = !!(opts && opts.baselineRows);
  function pushBase(t, isMajor) {
    if (!withBase || !t.baselineStart || !t.baselineEnd) return;
    models.push({ task: t, isMajor: isMajor, isBaseline: true, d: derived.get(t.id) || {},
      row: buildBaselineRowFor(t, isMajor, wbsNumbers) });
  }
  for (var i = 0; i < project.tasks.length; i++) {
    var major = project.tasks[i];
    if (major.level !== 'major') continue;
    var children = childrenIdx.get(major.id) || [];
    pushBase(major, true);
    models.push({ task: major, isMajor: true, hasChildren: children.length > 0, d: derived.get(major.id) || {},
      row: buildExcelRowForTask(major, true, project, derived, wbsNumbers, minorIds) });
    for (var j = 0; j < children.length; j++) {
      var c = children[j];
      pushBase(c, false);
      models.push({ task: c, isMajor: false, d: derived.get(c.id) || {},
        row: buildExcelRowForTask(c, false, project, derived, wbsNumbers, minorIds) });
    }
  }
  return models;
}

/* 当初計画の行（2段書きの上段）。日付と日数だけを持ち、他の列は空 */
function buildBaselineRowFor(task, isMajor, wbsNumbers) {
  return {
    level: '当初計画', wbsNo: wbsNumbers.get(task.id) || '', name: (isMajor ? '' : '  ') + '（当初）' + task.name, owner: '',
    startStr: task.baselineStart, endStr: task.baselineEnd, days: inclusiveDays(task.baselineStart, task.baselineEnd),
    progress: null, status: '', baselineStart: '', baselineEnd: '', diffStart: null, diffEnd: null, diffDuration: null,
    predText: '', remarks: ''
  };
}

/* 当初計画の行のバー（灰色。マイルストーンは淡い紫の1マス） */
function buildBaselineCellsForRow(task, buckets) {
  var cells = [];
  if (task.isMilestone) {
    var mi = findBucketIndexContaining(buckets, task.baselineStart);
    if (mi >= 0) cells.push({ idx: mi, key: 'baselineMilestone' });
    return cells;
  }
  for (var i = firstBucketOverlapping(buckets, task.baselineStart); i < buckets.length && buckets[i].start <= task.baselineEnd; i++) {
    cells.push({ idx: i, key: 'baselineBar' });
  }
  return cells;
}

function buildExcelRows(project, derived, wbsNumbers) {
  return buildRowModels(project, derived, wbsNumbers).map(function (m) { return m.row; });
}

/* ---- ガント列（日付バケット） ----
   描画対象期間は「全タスクの実効期間の最小〜最大（マイルストーン含む）」。 */
function computeGanttDateRange(project, derived) {
  var starts = [], ends = [];
  for (var i = 0; i < project.tasks.length; i++) {
    var t = project.tasks[i];
    var r = rangeOf(t, derived.get(t.id) || {});
    if (r.start != null) starts.push(r.start);
    if (r.end != null) ends.push(r.end);
    if (t.baselineStart && t.baselineEnd) { starts.push(t.baselineStart); ends.push(t.baselineEnd); } // 当初計画の行のバーを欠かさない
  }
  if (starts.length === 0 || ends.length === 0) return project.period ? { start: project.period.start, end: project.period.end } : null;
  var s = minDateStr(starts), e = maxDateStr(ends);
  return unionPeriod(s <= e ? { start: s, end: e } : { start: e, end: s }, project.period || null);
}

/* 日/週/旬/半月/月/年度のバケット。週は月曜始まり、旬は1〜10・11〜20・21〜末日、半月は1〜15・16〜末日、
   月は暦月、年度は4月1日〜翌3月31日。日付の許容範囲（2000〜2099年）により件数には上限がある。 */
function lastDayOfMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
function fiscalYearOf(dateStr) { var p = parseISO(dateStr); return p.mo >= 4 ? p.y : p.y - 1; }
function buildDateBuckets(rangeStart, rangeEnd, scale) {
  var buckets = [];
  if (scale === 'third' || scale === 'half') {
    var cuts = scale === 'third' ? [[1, 10, '上'], [11, 20, '中'], [21, 0, '下']] : [[1, 15, '前'], [16, 0, '後']];
    var ps = parseISO(rangeStart), cy = ps.y, cm = ps.mo;
    for (;;) {
      var last = lastDayOfMonth(cy, cm);
      for (var ci = 0; ci < cuts.length; ci++) {
        var bs = ymd(cy, cm, cuts[ci][0]), be = ymd(cy, cm, cuts[ci][1] || last);
        if (be < rangeStart) continue;
        buckets.push({ start: bs, end: be, label: cuts[ci][2] });
        if (be >= rangeEnd) return buckets;
      }
      cm += 1; if (cm > 12) { cm = 1; cy += 1; }
    }
  }
  if (scale === 'year') {
    for (var fy = fiscalYearOf(rangeStart); ; fy++) {
      var fe = ymd(fy + 1, 3, 31);
      buckets.push({ start: ymd(fy, 4, 1), end: fe, label: fy + '年度' });
      if (fe >= rangeEnd) return buckets;
    }
  }
  if (scale === 'day') {
    var totalDays = dayDiff(rangeEnd, rangeStart) + 1;
    for (var i = 0; i < totalDays; i++) {
      var ds = dayAdd(rangeStart, i);
      buckets.push({ start: ds, end: ds, label: String(Number(ds.slice(8, 10))) });
    }
  } else if (scale === 'week') {
    var cursor = dayAdd(rangeStart, -((dowOfStr(rangeStart) + 6) % 7));
    while (cursor <= rangeEnd) {
      buckets.push({ start: cursor, end: dayAdd(cursor, 6), label: Number(cursor.slice(5, 7)) + '/' + Number(cursor.slice(8, 10)) });
      cursor = dayAdd(cursor, 7);
    }
  } else {
    var p = parseISO(rangeStart), y = p.y, m = p.mo;
    for (;;) {
      var monthEnd = ymd(y, m, new Date(Date.UTC(y, m, 0)).getUTCDate());
      buckets.push({ start: ymd(y, m, 1), end: monthEnd, label: m + '月' });
      if (monthEnd >= rangeEnd) break;
      m += 1; if (m > 12) { m = 1; y += 1; }
    }
  }
  return buckets;
}

function computeGanttColumns(project, derived, scale) {
  var range = computeGanttDateRange(project, derived);
  if (!range) return [];
  return buildDateBuckets(range.start, range.end, scale || 'week');
}

/* 上段のまとめ（Excel 1行目の結合・画面ヘッダの上段）。旬・半月・週・日は月ごと、月は年度ごと、年度はまとめない */
function groupBucketsForScale(buckets, scale) {
  if (scale === 'year') return [];
  if (scale !== 'month') return groupBucketsByMonth(buckets);
  var groups = [];
  for (var i = 0; i < buckets.length; i++) {
    var fy = fiscalYearOf(buckets[i].start);
    if (groups.length > 0 && groups[groups.length - 1].key === fy) groups[groups.length - 1].endIdx = i;
    else groups.push({ key: fy, startIdx: i, endIdx: i, label: fy + '年度' });
  }
  return groups;
}

/* 範囲をマスの境目に合わせる（旬・半月・月・年度は端のマスを丸ごと含める。日・週はそのまま） */
function snapRangeToBuckets(range, scale) {
  if (BUCKET_SCALES.indexOf(scale) === -1) return { start: range.start, end: range.end };
  var b = buildDateBuckets(range.start, range.end, scale);
  return { start: clampDate(b[0].start), end: clampDate(b[b.length - 1].end) };
}

/* プロジェクトの期間とタスクの日付範囲を合わせる（期間外のタスクも隠さない） */
function unionPeriod(range, period) {
  if (!period) return { start: range.start, end: range.end };
  return { start: range.start < period.start ? range.start : period.start, end: range.end > period.end ? range.end : period.end };
}

/* 連続するバケットを開始日の月でまとめる（1行目の月ラベル結合用） */
function groupBucketsByMonth(buckets) {
  var groups = [];
  for (var i = 0; i < buckets.length; i++) {
    var key = buckets[i].start.slice(0, 7);
    if (groups.length > 0 && groups[groups.length - 1].key === key) {
      groups[groups.length - 1].endIdx = i;
    } else {
      groups.push({ key: key, startIdx: i, endIdx: i,
        label: buckets[i].start.slice(0, 4) + '年' + Number(buckets[i].start.slice(5, 7)) + '月' });
    }
  }
  return groups;
}

function mergeRefsForGroups(groups, colOffset) {
  var refs = [];
  for (var i = 0; i < groups.length; i++) {
    var g = groups[i];
    if (g.endIdx > g.startIdx) refs.push(colLetter(colOffset + g.startIdx + 1) + '1:' + colLetter(colOffset + g.endIdx + 1) + '1');
  }
  return refs;
}

/* 期間・進捗から「濃色（進捗済み）」の境界epoch日（未満が濃色） */
function computeCutoffEpoch(startStr, endStr, progressPercent) {
  if (progressPercent == null || (typeof progressPercent === 'number' && isNaN(progressPercent))) return null;
  var totalDays = inclusiveDays(startStr, endStr);
  return toEpochDay(startStr) + clamp(roundHalfUp(totalDays * (progressPercent / 100)), 0, totalDays);
}

/* 複数日にまたがるバケットは中央日で濃淡を決める */
function isBucketDark(bucket, cutoffEpoch) {
  if (cutoffEpoch == null) return false;
  return Math.floor((toEpochDay(bucket.start) + toEpochDay(bucket.end)) / 2) < cutoffEpoch;
}

/* dateStr を含むバケットの添字（二分探索。無ければ -1） */
function findBucketIndexContaining(buckets, dateStr) {
  var lo = 0, hi = buckets.length - 1;
  while (lo <= hi) {
    var mid = (lo + hi) >> 1;
    if (buckets[mid].end < dateStr) lo = mid + 1;
    else if (buckets[mid].start > dateStr) hi = mid - 1;
    else return mid;
  }
  return -1;
}

/* 期間 [s,e] に重なる最初のバケットの添字（無ければ buckets.length） */
function firstBucketOverlapping(buckets, s) {
  var lo = 0, hi = buckets.length;
  while (lo < hi) { var mid = (lo + hi) >> 1; if (buckets[mid].end < s) lo = mid + 1; else hi = mid; }
  return lo;
}

/* 列（バケット）の背景スタイルキー: 基準日＞祝日＞土日（日粒度のみ）。週/月粒度は基準日を含む列だけ色を付ける。 */
function baseStyleKeyForBucket(bucket, scale, referenceDate) {
  if (bucket.start <= referenceDate && referenceDate <= bucket.end) return 'colToday';
  if (scale === 'day') {
    if (holidayNameOf(bucket.start)) return 'colHoliday';
    if (isWeekend(bucket.start)) return 'colWeekend';
  }
  return null;
}

var STATUS_KEY_MAP = {
  onTrack: { minor: 'statusOnTrack', major: 'majorStatusOnTrack' },
  atRisk: { minor: 'statusAtRisk', major: 'majorStatusAtRisk' },
  delayed: { minor: 'statusDelayed', major: 'majorStatusDelayed' },
  unknown: { minor: 'statusUnknown', major: 'majorStatusUnknown' }
};
function statusStyleKeyFor(delayStatus, isMajor) {
  var entry = STATUS_KEY_MAP[delayStatus] || STATUS_KEY_MAP.unknown;
  return isMajor ? entry.major : entry.minor;
}

/* 1行ぶんのバーのセル: [{ idx: バケット添字, key: スタイルキー }]（バーのある列だけ。昇順） */
function buildGanttCellsForRow(task, isMajor, d, buckets, opts) {
  var cells = [], detail = !(opts && opts.detail === false);
  if (task.isMilestone && !isMajor) {
    if (!task.plannedStart) return cells;
    var mi = findBucketIndexContaining(buckets, task.plannedStart);
    if (mi >= 0) cells.push({ idx: mi, key: task.tentative ? 'milestoneTentative' : ((detail && d.isCritical) ? 'milestoneCritical' : 'milestoneNormal') });
    return cells;
  }
  var r = rangeOf(task, d);
  if (!r.start || !r.end) return cells;
  var progress = isMajor ? d.displayProgress : task.progress;
  var cutoff = computeCutoffEpoch(r.start, r.end, progress);
  var hasManual = isMajor && task.plannedStart != null && task.plannedEnd != null;
  var first = firstBucketOverlapping(buckets, r.start), last = first;
  while (last < buckets.length && buckets[last].start <= r.end) last++;
  last--; // 最後に重なるバケット
  var delayFrom = (task.baselineStart && task.baselineEnd) ? task.baselineEnd : null; // 当初の終了日より後ろ＝延びた部分
  for (var i = first; i <= last; i++) {
    var b = buckets[i], dark = isBucketDark(b, cutoff), key;
    if (delayFrom && b.start > delayFrom) { cells.push({ idx: i, key: 'delayBar' }); continue; }
    // v1.5: 日程が目安のバーは網掛け（白黒印刷でも塗りつぶしと区別できる）。進捗の濃淡・クリティカルパスの枠より優先する
    if (task.tentative) {
      var tkey = isMajor ? 'majorTentative' : 'minorTentative';
      if (!isMajor && detail && d.isCritical) tkey += 'Crit' + ((first === last) ? 'Single' : (i === first ? 'Start' : (i === last ? 'End' : 'Mid')));
      cells.push({ idx: i, key: tkey });
      continue;
    }
    if (!detail) { cells.push({ idx: i, key: isMajor ? 'majorManualDark' : 'minorLight' }); continue; } // シンプル表示: 画面と同じ単色
    if (isMajor) {
      var inManual = hasManual && !(b.end < task.plannedStart || b.start > task.plannedEnd);
      key = inManual ? (dark ? 'majorManualDark' : 'majorManualLight') : (dark ? 'majorExtDark' : 'majorExtLight');
    } else {
      key = dark ? 'minorDark' : 'minorLight';
      if (d.isCritical) {
        var pos = (first === last) ? 'Single' : (i === first ? 'Start' : (i === last ? 'End' : 'Mid'));
        key += 'Crit' + pos;
      }
    }
    cells.push({ idx: i, key: key });
  }
  return cells;
}

/* ---- styles.xml ---- */
function createStyleRegistry() {
  var fonts = [], fills = [], borders = [], cellXfs = [];
  var fontCache = new Map(), fillCache = new Map(), borderCache = new Map();

  function addFont(spec) {
    var key = JSON.stringify(spec);
    if (fontCache.has(key)) return fontCache.get(key);
    var xml = '<font>' + (spec.bold ? '<b/>' : '') + '<sz val="' + (spec.sz || 11) + '"/>' +
      '<color rgb="' + spec.color + '"/><name val="游ゴシック"/></font>';
    fonts.push(xml);
    fontCache.set(key, fonts.length - 1);
    return fonts.length - 1;
  }
  function addFill(spec) {
    var key = JSON.stringify(spec);
    if (fillCache.has(key)) return fillCache.get(key);
    var xml;
    if (spec.type === 'none') xml = '<fill><patternFill patternType="none"/></fill>';
    else if (spec.type === 'gray125') xml = '<fill><patternFill patternType="gray125"/></fill>';
    else if (spec.type === 'solid') xml = '<fill><patternFill patternType="solid"><fgColor rgb="' + spec.fg + '"/><bgColor indexed="64"/></patternFill></fill>';
    else if (spec.type === 'lightUp' || spec.type === 'mediumGray') xml = '<fill><patternFill patternType="' + spec.type + '"><fgColor rgb="' + spec.fg + '"/><bgColor rgb="' + spec.bg + '"/></patternFill></fill>';
    else throw new Error('unknown fill type: ' + spec.type);
    fills.push(xml);
    fillCache.set(key, fills.length - 1);
    return fills.length - 1;
  }
  /* spec: { color, sides: 'lrtb' の部分文字列 }（type:'none' で罫線なし） */
  function addBorder(spec) {
    var key = JSON.stringify(spec);
    if (borderCache.has(key)) return borderCache.get(key);
    var xml;
    if (spec.type === 'none') {
      xml = '<border><left/><right/><top/><bottom/><diagonal/></border>';
    } else {
      var side = function (tag, ch) {
        return spec.sides.indexOf(ch) !== -1 ? '<' + tag + ' style="thin"><color rgb="' + spec.color + '"/></' + tag + '>' : '<' + tag + '/>';
      };
      xml = '<border>' + side('left', 'l') + side('right', 'r') + side('top', 't') + side('bottom', 'b') + '<diagonal/></border>';
    }
    borders.push(xml);
    borderCache.set(key, borders.length - 1);
    return borders.length - 1;
  }
  function addCellXf(fontId, fillId, borderId, align) {
    var attrs = 'numFmtId="0" fontId="' + fontId + '" fillId="' + fillId + '" borderId="' + borderId + '" xfId="0"';
    if (fontId !== 0) attrs += ' applyFont="1"';
    if (fillId !== 0) attrs += ' applyFill="1"';
    if (borderId !== 0) attrs += ' applyBorder="1"';
    var xf;
    if (align) {
      attrs += ' applyAlignment="1"';
      xf = '<xf ' + attrs + '><alignment horizontal="' + align + '" vertical="center"/></xf>';
    } else {
      xf = '<xf ' + attrs + '/>';
    }
    cellXfs.push(xf);
    return cellXfs.length - 1;
  }
  return { addFont: addFont, addFill: addFill, addBorder: addBorder, addCellXf: addCellXf, fonts: fonts, fills: fills, borders: borders, cellXfs: cellXfs };
}

/* 使う全スタイルを一括登録し、キー → cellXfs添字 の idx を返す（決め打ちの数値を書かない＝範囲外参照の余地を作らない） */
function buildStyleRegistry() {
  var reg = createStyleRegistry(), idx = {};
  var C = { text: 'FF1F2937', green: 'FF15803D', orange: 'FFB45309', red: 'FFDC2626', gray: 'FF6B7280', holiday: 'FFB91C1C' };

  var fDefault = reg.addFont({ color: C.text });
  var fBold = reg.addFont({ color: C.text, bold: true });
  var fTitle = reg.addFont({ color: C.text, bold: true, sz: 14 });
  var fMeta = reg.addFont({ color: C.gray, sz: 10 });
  var fGreen = reg.addFont({ color: C.green }), fOrange = reg.addFont({ color: C.orange });
  var fRed = reg.addFont({ color: C.red }), fGray = reg.addFont({ color: C.gray });
  var fGreenB = reg.addFont({ color: C.green, bold: true }), fOrangeB = reg.addFont({ color: C.orange, bold: true });
  var fRedB = reg.addFont({ color: C.red, bold: true }), fGrayB = reg.addFont({ color: C.gray, bold: true });
  var fHeadSmall = reg.addFont({ color: C.gray, sz: 9 });
  var fHeadWeekend = reg.addFont({ color: C.orange, sz: 9 });
  var fHeadHoliday = reg.addFont({ color: C.holiday, sz: 9, bold: true });
  var fHeadToday = reg.addFont({ color: C.text, sz: 9, bold: true });

  var xNone = reg.addFill({ type: 'none' });   // fills[0] 予約
  reg.addFill({ type: 'gray125' });             // fills[1] 予約
  var xBlue = reg.addFill({ type: 'solid', fg: 'FFDBEAFE' });
  var xGreenBg = reg.addFill({ type: 'solid', fg: 'FFDCFCE7' });
  var xOrangeBg = reg.addFill({ type: 'solid', fg: 'FFFEF3C7' });
  var xRedBg = reg.addFill({ type: 'solid', fg: 'FFFEE2E2' });
  var xGrayBg = reg.addFill({ type: 'solid', fg: 'FFF3F4F6' });
  var xHeaderBg = reg.addFill({ type: 'solid', fg: 'FFE5E7EB' });
  var xMonthBg = reg.addFill({ type: 'solid', fg: 'FFEFF6FF' });
  var xWeekendBg = reg.addFill({ type: 'solid', fg: 'FFF1F5F9' });
  var xHolidayBg = reg.addFill({ type: 'solid', fg: 'FFFEF2F2' });
  var xTodayBg = reg.addFill({ type: 'solid', fg: 'FFFEF9C3' });
  var xMajorManualDark = reg.addFill({ type: 'solid', fg: 'FF1E40AF' });
  var xMajorManualLight = reg.addFill({ type: 'solid', fg: 'FF93C5FD' });
  var xMajorExtDark = reg.addFill({ type: 'lightUp', fg: 'FF1E3A8A', bg: 'FF93C5FD' });
  var xMajorExtLight = reg.addFill({ type: 'lightUp', fg: 'FF60A5FA', bg: 'FFDBEAFE' });
  var xMinorDark = reg.addFill({ type: 'solid', fg: 'FF1D4ED8' });
  var xMinorLight = reg.addFill({ type: 'solid', fg: 'FF3B82F6' });
  var xMilestone = reg.addFill({ type: 'solid', fg: 'FF7C3AED' });
  var xBaseline = reg.addFill({ type: 'solid', fg: 'FFCBD5E1' });       // 当初計画（2段書きの上段）
  var xBaselineMs = reg.addFill({ type: 'solid', fg: 'FFDDD6FE' });
  var xBaselineRowBg = reg.addFill({ type: 'solid', fg: 'FFF8FAFC' });
  var xDelay = reg.addFill({ type: 'solid', fg: 'FFEA580C' });           // 当初より延びた部分
  var xMajorTentative = reg.addFill({ type: 'mediumGray', fg: 'FF1E40AF', bg: 'FFDBEAFE' }); // v1.5: 日程が目安（網掛け）
  var xMinorTentative = reg.addFill({ type: 'mediumGray', fg: 'FF3B82F6', bg: 'FFFFFFFF' });
  var xMilestoneTentative = reg.addFill({ type: 'mediumGray', fg: 'FF7C3AED', bg: 'FFFFFFFF' });

  var bNone = reg.addBorder({ type: 'none' });
  var bData = reg.addBorder({ type: 'line', color: 'FFD1D5DB', sides: 'lrtb' });
  var CRIT = 'FFDC2626';
  var bCrit = {
    Single: reg.addBorder({ type: 'line', color: CRIT, sides: 'lrtb' }),
    Start: reg.addBorder({ type: 'line', color: CRIT, sides: 'ltb' }),
    Mid: reg.addBorder({ type: 'line', color: CRIT, sides: 'tb' }),
    End: reg.addBorder({ type: 'line', color: CRIT, sides: 'rtb' })
  };

  idx.default = reg.addCellXf(fDefault, xNone, bNone, null);
  idx.dataCell = reg.addCellXf(fDefault, xNone, bData, null);
  idx.majorRow = reg.addCellXf(fBold, xBlue, bData, null);
  idx.statusOnTrack = reg.addCellXf(fGreen, xGreenBg, bData, null);
  idx.statusAtRisk = reg.addCellXf(fOrange, xOrangeBg, bData, null);
  idx.statusDelayed = reg.addCellXf(fRed, xRedBg, bData, null);
  idx.statusUnknown = reg.addCellXf(fGray, xGrayBg, bData, null);
  idx.majorStatusOnTrack = reg.addCellXf(fGreenB, xBlue, bData, null);
  idx.majorStatusAtRisk = reg.addCellXf(fOrangeB, xBlue, bData, null);
  idx.majorStatusDelayed = reg.addCellXf(fRedB, xBlue, bData, null);
  idx.majorStatusUnknown = reg.addCellXf(fGrayB, xBlue, bData, null);
  idx.headerCell = reg.addCellXf(fBold, xHeaderBg, bData, null);
  idx.title = reg.addCellXf(fTitle, xNone, bNone, null);
  idx.meta = reg.addCellXf(fMeta, xNone, bNone, null);
  idx.monthLabel = reg.addCellXf(fBold, xMonthBg, bData, 'center');
  idx.ganttHead = reg.addCellXf(fHeadSmall, xHeaderBg, bData, 'center');
  idx.ganttHeadWeekend = reg.addCellXf(fHeadWeekend, xWeekendBg, bData, 'center');
  idx.ganttHeadHoliday = reg.addCellXf(fHeadHoliday, xHolidayBg, bData, 'center');
  idx.ganttHeadToday = reg.addCellXf(fHeadToday, xTodayBg, bData, 'center');
  idx.colWeekend = reg.addCellXf(fDefault, xWeekendBg, bNone, null);
  idx.colHoliday = reg.addCellXf(fDefault, xHolidayBg, bNone, null);
  idx.colToday = reg.addCellXf(fDefault, xTodayBg, bNone, null);
  idx.majorManualDark = reg.addCellXf(fDefault, xMajorManualDark, bNone, null);
  idx.majorManualLight = reg.addCellXf(fDefault, xMajorManualLight, bNone, null);
  idx.majorExtDark = reg.addCellXf(fDefault, xMajorExtDark, bNone, null);
  idx.majorExtLight = reg.addCellXf(fDefault, xMajorExtLight, bNone, null);
  idx.minorDark = reg.addCellXf(fDefault, xMinorDark, bNone, null);
  idx.minorLight = reg.addCellXf(fDefault, xMinorLight, bNone, null);
  ['Single', 'Start', 'Mid', 'End'].forEach(function (pos) {
    idx['minorDarkCrit' + pos] = reg.addCellXf(fDefault, xMinorDark, bCrit[pos], null);
    idx['minorLightCrit' + pos] = reg.addCellXf(fDefault, xMinorLight, bCrit[pos], null);
  });
  idx.milestoneNormal = reg.addCellXf(fDefault, xMilestone, bNone, null);
  idx.milestoneCritical = reg.addCellXf(fDefault, xMilestone, bCrit.Single, null);
  idx.legendText = reg.addCellXf(fDefault, xNone, bNone, null);
  idx.baselineBar = reg.addCellXf(fDefault, xBaseline, bNone, null);
  idx.baselineMilestone = reg.addCellXf(fDefault, xBaselineMs, bNone, null);
  idx.baselineRow = reg.addCellXf(fGray, xBaselineRowBg, bData, null);
  idx.delayBar = reg.addCellXf(fDefault, xDelay, bNone, null);
  idx.majorTentative = reg.addCellXf(fDefault, xMajorTentative, bNone, null);
  idx.minorTentative = reg.addCellXf(fDefault, xMinorTentative, bNone, null);
  ['Single', 'Start', 'Mid', 'End'].forEach(function (pos) {
    idx['minorTentativeCrit' + pos] = reg.addCellXf(fDefault, xMinorTentative, bCrit[pos], null);
  });
  idx.milestoneTentative = reg.addCellXf(fDefault, xMilestoneTentative, bNone, null);

  return { fonts: reg.fonts, fills: reg.fills, borders: reg.borders, cellXfs: reg.cellXfs, idx: idx };
}

function buildStylesXml(reg) {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="' + reg.fonts.length + '">' + reg.fonts.join('') + '</fonts>' +
    '<fills count="' + reg.fills.length + '">' + reg.fills.join('') + '</fills>' +
    '<borders count="' + reg.borders.length + '">' + reg.borders.join('') + '</borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="' + reg.cellXfs.length + '">' + reg.cellXfs.join('') + '</cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>';
}

/* ---- 出力前の検査（A5）: 列数上限とバーのセル数上限 ---- */
function excelPreflight(project, derived, scale) {
  var buckets = computeGanttColumns(project, derived, scale);
  var totalCols = EXCEL_COLUMNS.length + buckets.length;
  if (totalCols > EXCEL_MAX_COLS) {
    return { ok: false, buckets: buckets, message: '期間が長いため、表示「' + SCALE_LABELS[scale] + '」ではExcelの列数上限（16,384列）を超えます（必要: ' +
      totalCols.toLocaleString('ja-JP') + '列）。表示を「月」または「年度」に切り替えてから出力してください。' };
  }
  var models = buildRowModels(project, derived, computeWbsNumbers(project), { baselineRows: EXCEL_BASELINE_ROWS }), cells = 0;
  for (var i = 0; i < models.length; i++) {
    var r = models[i].isBaseline ? { start: models[i].task.baselineStart, end: models[i].task.baselineEnd } : rangeOf(models[i].task, models[i].d);
    if (!r.start || !r.end) continue;
    var a = firstBucketOverlapping(buckets, r.start), b = a;
    while (b < buckets.length && buckets[b].start <= r.end) b++;
    cells += (b - a);
    if (cells > EXCEL_MAX_BAR_CELLS) {
      return { ok: false, buckets: buckets, message: 'データ量が多いため、表示「' + SCALE_LABELS[scale] + '」ではExcelファイルが大きくなりすぎます。表示を「月」または「年度」に切り替えてから出力してください。' };
    }
  }
  return { ok: true, buckets: buckets, barCells: cells };
}

/* ---- シートXML本体（1行目=タイトル・基準日/出力日・月ラベル／2行目=見出し・日付ラベル／3行目〜=データ） ---- */
function buildSheetXml(project, derived, wbsNumbers, referenceDate, scale, reg, buckets, opts) {
  var detail = !(opts && opts.detail === false);
  var models = buildRowModels(project, derived, wbsNumbers, { baselineRows: EXCEL_BASELINE_ROWS });
  buckets = buckets || computeGanttColumns(project, derived, scale);
  var colOffset = EXCEL_COLUMNS.length; // 16
  var totalCols = colOffset + buckets.length;
  var lastRow = Math.max(2, 2 + models.length);
  var groups = buckets.length > 0 ? groupBucketsForScale(buckets, scale) : [];
  var I = reg.idx;

  var buf = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'];
  // スキーマ順: sheetPr → dimension → sheetViews → sheetFormatPr → cols → sheetData → autoFilter → mergeCells
  //            → pageMargins → pageSetup → headerFooter
  buf.push('<sheetPr><outlinePr summaryBelow="0" summaryRight="0"/><pageSetUpPr fitToPage="1"/></sheetPr>');
  buf.push('<dimension ref="A1:' + colLetter(totalCols) + lastRow + '"/>');
  var topLeft = colLetter(EXCEL_FREEZE_COLS + 1) + '3';
  buf.push('<sheetViews><sheetView workbookViewId="0"><pane xSplit="' + EXCEL_FREEZE_COLS + '" ySplit="2" topLeftCell="' + topLeft +
    '" activePane="bottomRight" state="frozen"/><selection pane="bottomRight" activeCell="' + topLeft + '" sqref="' + topLeft + '"/></sheetView></sheetViews>');
  buf.push('<sheetFormatPr defaultRowHeight="18" outlineLevelRow="1" outlineLevelCol="1"/>');

  // 列定義: データ16列（J〜P は折りたたみ。I 列が集計列なので collapsed を付ける）＋ガント列（背景を列スタイルで）
  buf.push('<cols>');
  for (var c = 1; c <= colOffset; c++) {
    var attrs = 'min="' + c + '" max="' + c + '" width="' + EXCEL_DATA_COL_W[c - 1] + '" customWidth="1"';
    if (c >= EXCEL_DETAIL_FROM && c <= EXCEL_DETAIL_TO) attrs += ' hidden="1" outlineLevel="1"';
    else if (!detail && (c === 8 || c === 9)) attrs += ' hidden="1"'; // シンプル表示: 進捗率・状態の列を隠す
    if (c === EXCEL_DETAIL_FROM - 1) attrs += ' collapsed="1"';
    buf.push('<col ' + attrs + '/>');
  }
  var ganttW = { day: 2.8, week: 5, third: 3.6, half: 4.5, month: 8, year: 10 }[scale] || 8;
  var runStart = 0;
  for (var k = 1; k <= buckets.length; k++) {
    var prevKey = baseStyleKeyForBucket(buckets[k - 1], scale, referenceDate);
    var curKey = k < buckets.length ? baseStyleKeyForBucket(buckets[k], scale, referenceDate) : '__end__';
    if (curKey !== prevKey) {
      buf.push('<col min="' + (colOffset + runStart + 1) + '" max="' + (colOffset + k) + '" width="' + ganttW + '" customWidth="1"' +
        (prevKey ? ' style="' + I[prevKey] + '"' : '') + '/>');
      runStart = k;
    }
  }
  buf.push('</cols>');

  buf.push('<sheetData>');
  // 1行目
  buf.push('<row r="1" ht="22" customHeight="1">');
  buf.push(xCellStr('A1', project.name || '（無題プロジェクト）', I.title));
  buf.push(xCellStr(colLetter(EXCEL_FREEZE_COLS + 1) + '1', '基準日: ' + referenceDate + ' ／ 出力日: ' + todayStr(), I.meta));
  for (var gi = 0; gi < groups.length; gi++) {
    buf.push(xCellStr(colLetter(colOffset + groups[gi].startIdx + 1) + '1', groups[gi].label, I.monthLabel));
  }
  buf.push('</row>');
  // 2行目
  buf.push('<row r="2">');
  for (c = 0; c < colOffset; c++) buf.push(xCellStr(colLetter(c + 1) + '2', EXCEL_COLUMNS[c], I.headerCell));
  for (var bi = 0; bi < buckets.length; bi++) {
    var bk = baseStyleKeyForBucket(buckets[bi], scale, referenceDate);
    var headKey = bk === 'colToday' ? 'ganttHeadToday' : (bk === 'colHoliday' ? 'ganttHeadHoliday' : (bk === 'colWeekend' ? 'ganttHeadWeekend' : 'ganttHead'));
    buf.push(xCellStr(colLetter(colOffset + bi + 1) + '2', buckets[bi].label, I[headKey]));
  }
  buf.push('</row>');
  // 3行目〜
  for (var r = 0; r < models.length; r++) {
    var m = models[r], rn = r + 3, row = m.row;
    var rowAttrs = 'r="' + rn + '"';
    if (!m.isMajor) rowAttrs += ' outlineLevel="1" hidden="1"';
    else if (m.hasChildren && !m.isBaseline) rowAttrs += ' collapsed="1"';
    buf.push('<row ' + rowAttrs + '>');
    var st = m.isBaseline ? I.baselineRow : (m.isMajor ? I.majorRow : I.dataCell);
    var statusSt = detail ? I[statusStyleKeyFor(m.d.delayStatus, m.isMajor)] : st;
    buf.push(xCellStr('A' + rn, row.level, st));
    buf.push(xCellStr('B' + rn, row.wbsNo, st));
    buf.push(xCellStr('C' + rn, row.name, st));
    buf.push(xCellStr('D' + rn, row.owner, st));
    buf.push(xCellStr('E' + rn, row.startStr, st));
    buf.push(xCellStr('F' + rn, row.endStr, st));
    buf.push(xCellNum('G' + rn, row.days, st));
    buf.push(xCellNum('H' + rn, detail ? row.progress : null, st));
    buf.push(xCellStr('I' + rn, detail ? row.status : '', m.isBaseline ? st : statusSt));
    buf.push(xCellStr('J' + rn, row.baselineStart, st));
    buf.push(xCellStr('K' + rn, row.baselineEnd, st));
    buf.push(xCellNum('L' + rn, row.diffStart, st));
    buf.push(xCellNum('M' + rn, row.diffEnd, st));
    buf.push(xCellNum('N' + rn, row.diffDuration, st));
    buf.push(xCellStr('O' + rn, row.predText, st));
    buf.push(xCellStr('P' + rn, row.remarks, st));
    if (buckets.length > 0) {
      var bars = m.isBaseline ? buildBaselineCellsForRow(m.task, buckets) : buildGanttCellsForRow(m.task, m.isMajor, m.d, buckets, { detail: detail });
      for (var bj = 0; bj < bars.length; bj++) {
        buf.push('<c r="' + colLetter(colOffset + bars[bj].idx + 1) + rn + '" s="' + I[bars[bj].key] + '"/>');
      }
    }
    buf.push('</row>');
  }
  buf.push('</sheetData>');

  buf.push('<autoFilter ref="A2:' + colLetter(colOffset) + lastRow + '"/>');
  var mergeRefs = mergeRefsForGroups(groups, colOffset);
  if (mergeRefs.length > 0) {
    buf.push('<mergeCells count="' + mergeRefs.length + '">');
    for (var mi = 0; mi < mergeRefs.length; mi++) buf.push('<mergeCell ref="' + mergeRefs[mi] + '"/>');
    buf.push('</mergeCells>');
  }
  buf.push('<pageMargins left="0.3" right="0.3" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>');
  buf.push('<pageSetup paperSize="8" orientation="landscape" fitToWidth="1" fitToHeight="0"/>');
  buf.push('<headerFooter><oddFooter>&amp;C&amp;P / &amp;N</oddFooter></headerFooter>');
  buf.push('</worksheet>');
  return buf.join('');
}

/* 凡例シート（受け取った人がアプリを持っていなくても色の意味が分かるように） */
function buildLegendSheetXml(project, referenceDate, reg, opts) {
  var I = reg.idx, detail = !(opts && opts.detail === false);
  var items = !detail ? [
    ['majorManualDark', '大事業'],
    ['minorLight', '小事業'],
    ['milestoneNormal', 'マイルストーン（節目の1日）'],
    ['baselineBar', '当初計画（「当初計画」の行。その下の行が修正後の予定）'],
    ['delayBar', '当初より延びた部分（当初計画の終了日より後ろ）'],
    ['minorTentative', '日程が目安の作業（点の網掛け。事業名の先頭に「［目安］」）'],
    ['colToday', '基準日（今日）を含む列']
  ] : [
    ['minorDark', '小事業：進捗済みの部分'],
    ['minorLight', '小事業：未完了の部分'],
    ['minorDarkCritSingle', 'クリティカルパス上の小事業（赤枠）＝遅れると全体の完了が遅れる'],
    ['majorManualDark', '大事業：進捗済みの部分（手入力した期間）'],
    ['majorManualLight', '大事業：未完了の部分（手入力した期間）'],
    ['majorExtDark', '大事業：小事業に合わせて自動で広がった期間（斜線）'],
    ['milestoneNormal', 'マイルストーン（節目の1日）'],
    ['baselineBar', '当初計画（「当初計画」の行。その下の行が修正後の予定）'],
    ['delayBar', '当初より延びた部分（当初計画の終了日より後ろ）'],
    ['minorTentative', '日程が目安の作業（点の網掛け。事業名の先頭に「［目安］」）'],
    ['colWeekend', '土日（表示「日」のとき）'],
    ['colHoliday', '祝日（表示「日」のとき）'],
    ['colToday', '基準日（今日）を含む列']
  ];
  var notes = [
    '・小事業は大事業の行にまとめて折りたたまれています。行番号の左の［＋］で表示できます。',
    '・当初計画を確定したタスクは、上の行が当初計画、下の行が修正後の予定です（2段書き）。',
    '・詳細列（当初計画の日付・差分日数・先行タスク・備考）は列見出しの上の［＋］で表示できます。',
    detail ? '・「状態」は基準日時点の遅延判定です（順調／要注意／遅延）。' : '・シンプル表示で出力しました（進捗率・状態の列は隠しています）。',
    '・基準日: ' + referenceDate + ' ／ 出力日: ' + todayStr() + ' ／ ' + APP_DISPLAY_NAME + ' v' + APP_VERSION
  ];
  var lastRow = 2 + items.length + 1 + notes.length;
  var buf = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'];
  buf.push('<dimension ref="A1:B' + lastRow + '"/>');
  buf.push('<sheetViews><sheetView workbookViewId="0"/></sheetViews>');
  buf.push('<sheetFormatPr defaultRowHeight="18"/>');
  buf.push('<cols><col min="1" max="1" width="6" customWidth="1"/><col min="2" max="2" width="70" customWidth="1"/></cols>');
  buf.push('<sheetData>');
  buf.push('<row r="1">' + xCellStr('A1', '凡例（' + (project.name || '無題プロジェクト') + '）', I.title) + '</row>');
  for (var i = 0; i < items.length; i++) {
    var rn = i + 3;
    buf.push('<row r="' + rn + '"><c r="A' + rn + '" s="' + I[items[i][0]] + '"/>' + xCellStr('B' + rn, items[i][1], I.legendText) + '</row>');
  }
  for (var j = 0; j < notes.length; j++) {
    var rn2 = 3 + items.length + 1 + j;
    buf.push('<row r="' + rn2 + '">' + xCellStr('A' + rn2, notes[j], I.legendText) + '</row>');
  }
  buf.push('</sheetData>');
  buf.push('<pageMargins left="0.5" right="0.5" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>');
  buf.push('</worksheet>');
  return buf.join('');
}

/* xlsx を構成するパート一覧（圧縮前） */
/* opts.detail: false ならシンプル表示に合わせて出力する（進捗の濃淡・状態・クリティカルパス・自動拡張の斜線を出さない）。既定は詳細 */
function buildXlsxFiles(project, derived, wbsNumbers, referenceDate, scale, buckets, opts) {
  scale = scale || 'week';
  var reg = buildStyleRegistry();
  var models = buildRowModels(project, derived, wbsNumbers, { baselineRows: EXCEL_BASELINE_ROWS }); // 当初計画の行も数える（絞り込み範囲の定義と表を一致させる）
  var lastRow = Math.max(2, 2 + models.length);
  var sheetXml = buildSheetXml(project, derived, wbsNumbers, referenceDate, scale, reg, buckets, opts);
  var legendXml = buildLegendSheetXml(project, referenceDate, reg, opts);
  var stylesXml = buildStylesXml(reg);

  var contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '</Types>';
  var rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>';
  var workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<bookViews><workbookView activeTab="0"/></bookViews>' +
    '<sheets><sheet name="WBS" sheetId="1" r:id="rId1"/><sheet name="凡例" sheetId="2" r:id="rId3"/></sheets>' +
    '<definedNames>' +
    '<definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">WBS!$A$2:$P$' + lastRow + '</definedName>' +
    '<definedName name="_xlnm.Print_Titles" localSheetId="0">WBS!$1:$2</definedName>' +
    '</definedNames></workbook>';
  var workbookRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>' +
    '</Relationships>';
  return [
    xmlFile('[Content_Types].xml', contentTypes),
    xmlFile('_rels/.rels', rootRels),
    xmlFile('xl/workbook.xml', workbook),
    xmlFile('xl/_rels/workbook.xml.rels', workbookRels),
    xmlFile('xl/styles.xml', stylesXml),
    xmlFile('xl/worksheets/sheet1.xml', sheetXml),
    xmlFile('xl/worksheets/sheet2.xml', legendXml)
  ];
}

/* 同期・無圧縮（テストと互換用）。scale 省略時は 'week'。 */
function buildXlsxBytes(project, derived, wbsNumbers, referenceDate, scale, opts) {
  return buildZip(buildXlsxFiles(project, derived, wbsNumbers, referenceDate, scale, null, opts));
}

/* 非同期・圧縮（アプリの出力で使う） */
function buildXlsxBytesAsync(project, derived, wbsNumbers, referenceDate, scale, buckets, opts) {
  return buildZipAsync(buildXlsxFiles(project, derived, wbsNumbers, referenceDate, scale, buckets, opts));
}

/* =========================================================================
 * 7. アプリケーション状態・変更の入口（Undo/Redo・未保存管理・自動保存）
 * すべてのデータ変更は applyMutation / replaceProject を通す（A7/A8: 履歴・未保存表示・自動保存を1か所で扱う）。
 * 表示だけの状態（展開・表示スケール・基準日・絞り込み）は履歴に積まない。
 * ========================================================================= */
var state = {
  project: createEmptyProject(),
  ui: {
    scale: 'week',
    detailMode: false,          // v1.4: 既定はシンプル表示（進捗・状態・クリティカルパスは詳細表示で）
    referenceDate: todayStr(),
    expandedMajors: new Set(),   // M2: 初期状態は非表示（空Set=全て折りたたみ）
    recentlySlidIds: new Set(),
    filterOwner: '',
    filterStatus: '',
    focusTaskId: null,
    autoScaleNotice: null
  }
};
var derived = new Map();
var wbsNumbers = new Map();
var lastCycleInfo = null;
var lastCycleKey = null;
var localSaveTimer = null;
var slideHighlightTimer = null;
var undoHistory = { past: [], future: [], bytes: 0 };
var saveInfo = { dirty: false, savedAt: null };
var startupWarnings = [];
var recoveryInfo = null;
/* 自動保存の失敗状態（null | 'storage'＝容量制限・利用制限 | 'size'＝データが上限超過）。
   失敗中はツールバーに常時表示し、成功したら解除する（次の失敗は再び通知する） */
var autosaveFailReason = null;
/* 複数タブの自動保存の競合（v1.6.0）。
   autosaveBase: このタブが最後に読んだ・書いた控えの文字列（null はキーが無い状態）。保存の直前にこれと現在値を比べる。
   autosaveConflict: null | 'changed'（別のタブが控えを更新）| 'cleared'（別のタブが控えを消去）。
     検知したら自動保存を止め、「最新の控えを読み込む」が成功したときだけ解除する（値が一致し直しても解除しない）。
   autosaveGeneration: 最新の控えの読込み・消去で増やし、それより前に始まったファイル読込みの結果を捨てる */
var autosaveBase = { project: null, meta: null };
var autosaveConflict = null;
var autosaveGeneration = 0;
/* ファイル読込みの要求の連番。後から選んだファイルを優先し、先に選んだ分の完了は捨てる */
var fileOpenSeq = 0;

function snapshotProject() { return JSON.stringify(state.project); }

/* 履歴の操作（DOMに触れない部分）。h は { past, future, bytes }。json は工程表の文字列 */
function historyPush(h, label, json) {
  h.past.push({ label: label, json: json });
  h.bytes += json.length;
  h.future = [];
  while (h.past.length > HISTORY_LIMIT || (h.bytes > HISTORY_MAX_BYTES && h.past.length > 1)) {
    h.bytes -= h.past.shift().json.length;
  }
}
/* 戻り先の項目を返す（無ければ null）。currentJson は「やり直す」で戻る先として積む */
function historyUndo(h, currentJson) {
  if (h.past.length === 0) return null;
  var entry = h.past.pop();
  h.bytes -= entry.json.length;
  h.future.push({ label: entry.label, json: currentJson });
  return entry;
}
function historyRedo(h, currentJson) {
  if (h.future.length === 0) return null;
  var entry = h.future.pop();
  h.past.push({ label: entry.label, json: currentJson });
  h.bytes += currentJson.length;
  return entry;
}
function pushHistory(label, json) { historyPush(undoHistory, label, json); }

/* 変更の入口。fn(project) で state.project を書き換える。実際に変化があった場合だけ履歴に積む。
   opts.silent: トーストを出さない / opts.expand: 描画前に展開する大事業id */
function applyMutation(label, fn, opts) {
  opts = opts || {};
  var before = snapshotProject();
  var ret = fn(state.project);
  if (ret === false) return false;
  var result = recompute({ silent: opts.silent });
  if (snapshotProject() === before) { renderAll(); return false; }
  pushHistory(label, before);
  if (opts.expand) opts.expand.forEach(function (id) { state.ui.expandedMajors.add(id); });
  markDirty();
  renderAll();
  scheduleLocalSave();
  return result;
}

/* プロジェクトの丸ごと差し替え（新規・開く・サンプル）。元に戻せるよう履歴に積む。
   置き換え前が空でも積む。積まないと、以前の「やり直す」が置き換え後の工程表を上書きし、
   「元に戻す」が空の状態を飛ばして以前の工程表へ戻るため */
function replaceProject(label, newProject, ui, cleanState, announce) {
  var before = snapshotProject();
  state.project = newProject;
  state.ui.expandedMajors = new Set(ui && ui.expanded ? ui.expanded : []);
  if (ui && ui.scale) state.ui.scale = ui.scale;
  if (ui && typeof ui.detailMode === 'boolean') state.ui.detailMode = ui.detailMode;
  state.ui.filterOwner = '';
  state.ui.filterStatus = '';
  pushHistory(label, before);
  syncProjectNameInput();
  lastCycleKey = null;
  recompute({ silent: !announce });
  if (cleanState) markClean(); else markDirty();
  renderAll();
  scheduleLocalSave();
  keepFocusInWorkArea();
}

/* 差し替えで空の状態の入口が隠れると、そこにあったフォーカスが失われるため、名前の欄へ移す
   （起動画面から「サンプルで試す」「ファイルを開く」へ進んだ場合など）。ダイアログ中は何もしない */
function keepFocusInWorkArea() {
  if (dialogStack.length > 0) return;
  var a = document.activeElement;
  if (a && a !== document.body && a.offsetParent !== null) return;
  var input = document.getElementById('project-name-input');
  if (input) input.focus();
}

function undo() {
  var entry = historyUndo(undoHistory, snapshotProject());
  if (!entry) return;
  restoreSnapshot(entry.json);
  showToast('元に戻しました（' + entry.label + '）', 'info', 2500);
}

function redo() {
  var entry = historyRedo(undoHistory, snapshotProject());
  if (!entry) return;
  restoreSnapshot(entry.json);
  showToast('やり直しました（' + entry.label + '）', 'info', 2500);
}

function restoreSnapshot(json) {
  state.project = JSON.parse(json);
  syncProjectNameInput();
  // 削除済みの大事業を展開集合から外す
  var ids = new Set(state.project.tasks.map(function (t) { return t.id; }));
  state.ui.expandedMajors.forEach(function (id) { if (!ids.has(id)) state.ui.expandedMajors.delete(id); });
  lastCycleKey = null;
  recompute({ silent: true });
  markDirty();
  renderAll();
  scheduleLocalSave();
}

function markDirty() { saveInfo.dirty = true; }
function markClean() { saveInfo.dirty = false; saveInfo.savedAt = new Date().toISOString(); }

/* ツールバーの保存状態の種類（DOMに触れない）。未保存かどうかは内容の有無と独立に決める
   （最後の作業を消した・名前を消した場合も、ファイルに保存していなければ未保存）。
   'dirty': 未保存の変更あり ／ 'none': 何も表示しない（保存していない変更が無く、内容も無い）／ 'clean': 保存済み */
function saveStateKind(dirty, empty) {
  if (dirty) return 'dirty';
  return empty ? 'none' : 'clean';
}

/* 再計算。自動スライド・循環の通知もここで出す（B4: 動いたタスク名を示し、その大事業を展開する） */
function recompute(opts) {
  opts = opts || {};
  rebuildTaskIndex();
  var result = recomputeAll(state.project, state.ui.referenceDate);
  derived = result.derived;
  wbsNumbers = computeWbsNumbers(state.project);
  lastCycleInfo = result.cycleInfo;

  if (result.slideChangedIds.length > 0) {
    var names = [];
    result.slideChangedIds.forEach(function (id) {
      var t = getTaskById(id);
      if (!t) return;
      names.push('「' + truncateText(t.name, 16) + '」');
      if (t.parentId) state.ui.expandedMajors.add(t.parentId);
    });
    state.ui.recentlySlidIds = new Set(result.slideChangedIds);
    if (!opts.silent) {
      var shown = names.slice(0, 3).join('・') + (names.length > 3 ? ' ほか' + (names.length - 3) + '件' : '');
      showToast('先行タスクの制約により ' + shown + ' の日程を後ろへ自動調整しました。', 'warning', 6000);
    }
    if (slideHighlightTimer) clearTimeout(slideHighlightTimer);
    slideHighlightTimer = setTimeout(function () { state.ui.recentlySlidIds = new Set(); }, 3200);
  }
  // C4: 循環は「新たに生じたとき」だけトースト（常時はバナー）
  var cycleKey = lastCycleInfo ? lastCycleInfo.path.join('>') : null;
  if (cycleKey && cycleKey !== lastCycleKey && !opts.silent) {
    showToast('先行タスクの指定が循環しています: ' + lastCycleInfo.message, 'error', 7000);
  }
  lastCycleKey = cycleKey;
  return result;
}

/* ---- 自動保存（キャッシュ。正本は .json） ---- */
function serializeProjectData(project, ui, pretty) {
  var out = {
    format: FILE_FORMAT,
    name: project.name,
    tasks: project.tasks,
    baselineSavedAt: project.baselineSavedAt,
    period: project.period ? { start: project.period.start, end: project.period.end } : null,
    schemaVersion: SCHEMA_VERSION,
    ui: ui
  };
  return pretty ? JSON.stringify(out, null, 2) : JSON.stringify(out);
}
function currentUiForSave() {
  return { scale: state.ui.scale, expanded: Array.from(state.ui.expandedMajors), detailMode: state.ui.detailMode };
}
function serializeProject(pretty) {
  return serializeProjectData(state.project, currentUiForSave(), pretty);
}

function scheduleLocalSave() {
  if (localSaveTimer) clearTimeout(localSaveTimer);
  localSaveTimer = setTimeout(saveToLocalStorageNow, 500);
}

function saveToLocalStorageNow() {
  localSaveTimer = null;
  // 別のタブの更新・消去を検知した後は、このタブの古い内容で控えを上書きしない
  if (autosaveConflict) return;
  var failReason = null, outcome = null;
  try {
    var json = serializeProject(false);
    if (!checkWbsprojSaveSize(json).ok) {
      failReason = 'size'; // 上限を超えたデータは次回起動時に復元できないため書き込まない
    } else {
      // 保存する文字列を作ってサイズを確かめてから、比較と書込みを続けて行う（間に重い処理を挟まない）
      outcome = writeAutosave(localStorage, autosaveBase, json, buildAutosaveMeta(saveInfo, json));
      autosaveBase = outcome.base;
      // project だけ書けた（partial）場合も失敗として知らせ、次の変更で再び書く（metaの指紋が合わないため、
      // それまでに再起動しても「未保存」として復元される）
      if (outcome.result === 'error' || outcome.result === 'partial') {
        console.error('[NovaChart] localStorage save failed', outcome.error);
        failReason = 'storage';
      }
    }
  } catch (e) {
    console.error('[NovaChart] localStorage save failed', e);
    failReason = 'storage';
  }
  // 表示の更新は try の外で行う（描画の例外を保存失敗と取り違えないため）
  if (outcome && (outcome.result === 'conflict' || outcome.result === 'cleared')) {
    enterAutosaveConflict(outcome.result === 'cleared' ? 'cleared' : 'changed');
    return;
  }
  setAutosaveFailure(failReason);
}

function setAutosaveFailure(reason) {
  if (autosaveFailReason === reason) return;
  autosaveFailReason = reason;
  if (reason) showToast(autosaveFailureMessage(reason).toast, 'error', 9000);
  renderSaveState();
}

/* 自動保存の失敗文言。データが上限を超えた場合はファイル保存もできないので、ファイル保存を勧めない */
function autosaveFailureMessage(reason) {
  if (reason === 'size') {
    var sizeMsg = 'データ量が上限（' + MAX_FILE_SIZE_LABEL + '）を超えたため、ブラウザへの自動保存もファイルへの保存もできません。' +
      'メモを短くする、不要なタスクを削除する等で減らしてください。';
    return { toast: sizeMsg, title: sizeMsg };
  }
  return {
    toast: 'ブラウザへの自動保存ができません（容量超過または利用が制限されています）。「保存(.json)」でファイルに保存してください。',
    title: 'ブラウザへの自動保存に失敗しています（容量超過または利用が制限されています）。最新の変更はブラウザの控えに含まれません。「保存(.json)」でファイルに保存してください。'
  };
}

/* 自動保存のmeta（未保存の有無・ファイル保存日時）。欠落・破損は安全側で「未保存」とする
   （保存済みと誤表示すると、閉じるときの離脱警告まで失われるため）。
   v1.6.0: meta には対応する project の指紋（project）を入れる。projectText を渡したとき（復元時）は、指紋が無いか一致しなければ
   （project だけ書けて meta の書込みに失敗した後や、v1.5 以前の meta が残っている間など）、対応を確かめられないので「未保存」とする。
   指紋の無い試用版の控えを復元すると、安全側で「未保存の変更あり」と表示する（離脱時の警告を失うよりよい）。projectText を渡さない呼び出しは従来どおり */
function parseAutosaveMeta(text, projectText) {
  var meta = null;
  try { meta = JSON.parse(text || 'null'); } catch (e) { meta = null; }
  if (meta == null || typeof meta !== 'object' || Array.isArray(meta)) return { dirty: true, savedAt: null };
  var mismatched = typeof projectText === 'string' && meta.project !== autosaveFingerprint(projectText);
  return {
    dirty: mismatched || (typeof meta.dirty === 'boolean' ? meta.dirty : true), // 欠落・型違いも未保存扱い
    savedAt: typeof meta.savedAt === 'string' ? meta.savedAt : null
  };
}

/* 控えの project の指紋（文字数と FNV-1a 32bit）。meta との対応を確かめるためだけに使い、改ざん検知には使わない */
function autosaveFingerprint(text) {
  var h = 0x811c9dc5;
  for (var i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return text.length + ':' + h.toString(16);
}

function buildAutosaveMeta(info, projectText) {
  return JSON.stringify({ dirty: info.dirty, savedAt: info.savedAt, project: autosaveFingerprint(projectText) });
}

/* 起動時に復元する控えを選ぶ。JSON保存版の控えが無ければ、v1.2 の控えを引き継ぐ（getItem は localStorage.getItem 相当） */
function chooseAutosaveText(getItem) {
  var text = getItem(STORAGE_KEY_PROJECT);
  if (text) return { text: text, migrated: false };
  if (getItem(STORAGE_KEY_LEGACY_IMPORTED)) return null; // 一度引き継いだら再び取り込まない（消去後の復活を防ぐ）
  text = getItem(LEGACY_STORAGE_KEY_PROJECT);
  if (text) return { text: text, migrated: true };
  return null;
}

/* 起動時の復元。読めないデータは上書きされる前に退避する（A2） */
function loadFromLocalStorageIfAny() {
  var src, json, snap;
  try {
    // 画面に読み込む控えと、競合判定の基準を同じ時点の文字列にそろえる（project と meta を検証より先に一度だけ読む）
    snap = readAutosaveSnapshot(localStorage);
    src = chooseAutosaveText(function (k) { return k === STORAGE_KEY_PROJECT ? snap.project : localStorage.getItem(k); });
  } catch (e) {
    console.error('[NovaChart] localStorage read failed', e);
    return false;
  }
  autosaveBase = snap;
  if (!src) return false;
  json = src.text;
  var result = validateWbsprojText(json, utf8ByteLength(json));
  if (!result.ok && src.migrated) {
    // v1.2 の控えは v1.2 のもの。読めなくても退避や削除はせず、引き継がないだけにする
    console.error('[NovaChart] legacy autosave data failed validation:', result.message);
    return false;
  }
  if (!result.ok) {
    console.error('[NovaChart] localStorage data failed validation:', result.message);
    try { localStorage.setItem(STORAGE_KEY_RECOVERY, json); } catch (e2) { console.error(e2); }
    recoveryInfo = { reason: result.message, text: json };
    return false;
  }
  state.project = result.project;
  if (result.ui) {
    if (result.ui.scale) state.ui.scale = result.ui.scale;
    if (result.ui.expanded) state.ui.expandedMajors = new Set(result.ui.expanded);
    if (typeof result.ui.detailMode === 'boolean') state.ui.detailMode = result.ui.detailMode;
  }
  startupWarnings = result.warnings;
  var meta;
  if (src.migrated) {
    try { meta = parseAutosaveMeta(localStorage.getItem(LEGACY_STORAGE_KEY_META)); } catch (e3) { meta = parseAutosaveMeta(null); }
  } else {
    meta = parseAutosaveMeta(snap.meta, snap.project);
  }
  saveInfo.dirty = meta.dirty;
  saveInfo.savedAt = meta.savedAt;
  if (src.migrated) {
    startupWarnings.push('旧版（.wbsproj 保存版）のブラウザ自動保存から内容を引き継ぎました。旧版の控えはそのまま残っています。');
    // 本体とmetaを一組でこの版の領域へ書き、引き継ぎ済みの印を付ける（通常の保存と同じく、基準と一致するときだけ書く）
    var migrated = writeAutosave(localStorage, autosaveBase, json, buildAutosaveMeta(saveInfo, json), { requireAbsent: STORAGE_KEY_LEGACY_IMPORTED });
    autosaveBase = migrated.base;
    if (migrated.result === 'saved') {
      try { localStorage.setItem(STORAGE_KEY_LEGACY_IMPORTED, '1'); } catch (e5) { console.error(e5); }
    } else if (migrated.result === 'conflict' || migrated.result === 'cleared') {
      autosaveConflict = migrated.result === 'cleared' ? 'cleared' : 'changed'; // 初回描画で知らせる
    } else {
      console.error('[NovaChart] legacy autosave migration write failed', migrated.error);
      autosaveFailReason = 'storage'; // 初回描画でツールバーに表示される
      startupWarnings.push('引き継いだ内容を、この版のブラウザ自動保存に書き込めませんでした。「保存(.json)」でファイルに保存してください。');
    }
  }
  return true;
}

function hasLegacyAutosave() {
  try { return !!localStorage.getItem(LEGACY_STORAGE_KEY_PROJECT); } catch (e) { return false; }
}

/* ローカルデータ消去。JSON保存版の領域を消し、「引き継ぎ済み」の印は消さずに必ず付ける。
   消去後に旧版の控えを自動で取り込まないため（共有PCで消去したのに別のデータが出てこないように）。印の値は '1' だけで業務データを含まない */
function clearLocalData(storage) {
  var st = storage || localStorage;
  var keys = [];
  for (var i = 0; i < st.length; i++) {
    var k = st.key(i);
    if (k && k.indexOf(STORAGE_PREFIX) === 0 && k !== STORAGE_KEY_LEGACY_IMPORTED) keys.push(k);
  }
  for (i = 0; i < keys.length; i++) st.removeItem(keys[i]);
  if (!st.getItem(STORAGE_KEY_LEGACY_IMPORTED)) st.setItem(STORAGE_KEY_LEGACY_IMPORTED, '1');
}

/* ---- 複数タブの自動保存の競合（v1.6.0） ----
   同じ工程表を複数のタブで開くと、どのタブも同じ控え（novachart-json:project / :meta）を書く。
   保存の直前に控えの現在値を読み、このタブの基準（最後に読んだ・書いた文字列）と完全に一致するときだけ書く。
   別のタブの更新・消去は storage イベントでも検知し、このタブの自動保存を止める。
   限界: localStorage には「読む→比べる→書く」を一体にする仕組みがないため、2つのタブの保存処理が重なった場合の
   競合までは防げない。また、別のタブが変更したあと同じ内容に戻した場合は、文字列が一致するため区別できない。 */

/* storage イベントの key を分類する。null は localStorage.clear()（すべて消去）。表示設定・退避データの変化は対象外 */
function classifyStorageEvent(key) {
  if (key === null) return 'clear';
  if (key === STORAGE_KEY_PROJECT || key === STORAGE_KEY_META) return 'autosave';
  return null;
}

/* 控えの現在値を読む。キーが無いときは null（空文字列とは区別する）。読取りの例外はそのまま投げる */
function readAutosaveSnapshot(storage) {
  return { project: storage.getItem(STORAGE_KEY_PROJECT), meta: storage.getItem(STORAGE_KEY_META) };
}

/* 基準と現在値が違うときの理由。両方のキーが消えていれば消去、それ以外は更新 */
function autosaveChangeReason(current) {
  return current.project === null && current.meta === null ? 'cleared' : 'conflict';
}

/* 基準と一致するときだけ控えを書く。
   result: 'saved' | 'conflict'（別のタブが更新）| 'cleared'（別のタブが消去）| 'partial'（project だけ書けた）| 'error'
   base: 以後このタブが基準にする文字列。実際に setItem へ渡した値にする（読み直した値は、その間の他タブの更新を取り込みうるため使わない）
   opts.requireAbsent: このキーが既にあれば書かない（旧版の取込み中に、別のタブが消去して引き継ぎ済みの印を付けた場合）。
     消去では project・meta は「無い」ままで変わらないため、基準との比較だけでは気づけない */
function writeAutosave(storage, base, projectText, metaText, opts) {
  var current, guarded = false;
  try {
    current = readAutosaveSnapshot(storage);
    guarded = !!(opts && opts.requireAbsent) && storage.getItem(opts.requireAbsent) !== null;
  } catch (e) { return { result: 'error', base: base, error: e }; }
  if (current.project !== base.project || current.meta !== base.meta) return { result: autosaveChangeReason(current), base: base };
  if (guarded) return { result: 'cleared', base: base };
  try { storage.setItem(STORAGE_KEY_PROJECT, projectText); } catch (e1) { return { result: 'error', base: base, error: e1 }; }
  try { storage.setItem(STORAGE_KEY_META, metaText); } catch (e2) {
    // project だけ書けた。元に戻すと、その間の他タブの更新を消しうるため戻さず、失敗として知らせる
    return { result: 'partial', base: { project: projectText, meta: base.meta }, error: e2 };
  }
  return { result: 'saved', base: { project: projectText, meta: metaText } };
}

/* =========================================================================
 * 8. トースト・ダイアログ・メニュー（共通部品）
 * ========================================================================= */
function showToast(message, type, duration) {
  type = type || 'info';
  duration = duration || 4000;
  var container = document.getElementById('toast-container');
  if (!container) return;
  var toast = el('div', { className: 'toast ' + type, text: message, title: 'クリックで閉じる' });
  if (type === 'error') toast.setAttribute('role', 'alert');
  toast.addEventListener('click', function () { if (toast.parentNode) toast.parentNode.removeChild(toast); });
  container.appendChild(toast);
  while (container.children.length > 5) container.removeChild(container.firstChild);
  setTimeout(function () { if (toast.parentNode) toast.parentNode.removeChild(toast); }, duration);
}

/* モーダルダイアログ。背景を inert にし、フォーカスをダイアログ内に閉じ込め、閉じたら元の場所へ戻す（C2） */
var dialogStack = [];
function openDialog(opts) {
  var root = document.getElementById('dialog-root');
  var titleId = 'dlg-title-' + (dialogStack.length + 1);
  var dialog = el('div', { className: 'dialog' + (opts.wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId });
  dialog.appendChild(el('h2', { id: titleId, text: opts.title }));
  var backdrop = el('div', { className: 'dialog-backdrop' }, [dialog]);
  var ctx = { dialog: dialog, backdrop: backdrop, prevFocus: document.activeElement, onClose: opts.onClose, returnFocus: opts.returnFocus };
  ctx.close = function () { closeDialog(ctx); };
  opts.build(dialog, ctx);
  backdrop.addEventListener('mousedown', function (ev) { if (ev.target === backdrop) ctx.close(); });
  dialog.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') { ev.stopPropagation(); ctx.close(); return; }
    if (ev.key !== 'Tab') return;
    var f = focusablesIn(dialog);
    if (f.length === 0) return;
    if (ev.shiftKey && document.activeElement === f[0]) { ev.preventDefault(); f[f.length - 1].focus(); }
    else if (!ev.shiftKey && document.activeElement === f[f.length - 1]) { ev.preventDefault(); f[0].focus(); }
  });
  root.appendChild(backdrop);
  dialogStack.push(ctx);
  document.getElementById('app-root').setAttribute('inert', '');
  var first = opts.initialFocus ? opts.initialFocus() : focusablesIn(dialog)[0];
  if (first) first.focus();
  return ctx;
}

function closeDialog(ctx) {
  var i = dialogStack.indexOf(ctx);
  if (i === -1) return;
  dialogStack.splice(i, 1);
  if (ctx.backdrop.parentNode) ctx.backdrop.parentNode.removeChild(ctx.backdrop);
  if (dialogStack.length === 0) document.getElementById('app-root').removeAttribute('inert');
  if (ctx.onClose) ctx.onClose();
  // opts.returnFocus: 開く前の場所（起動時の body など）へ戻しても作業が続かない場合の戻し先
  var back = ctx.returnFocus ? ctx.returnFocus() : ctx.prevFocus;
  if (back && back.isConnected && typeof back.focus === 'function') back.focus();
}

function focusablesIn(container) {
  return Array.prototype.filter.call(
    container.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'),
    function (e) {
      if (e.disabled || e.offsetParent === null) return false;
      if (e.type !== 'radio' || e.checked || !e.name) return true;
      var group = container.querySelectorAll('input[type="radio"][name="' + e.name + '"]');
      var anyChecked = Array.prototype.some.call(group, function (r) { return r.checked; });
      if (anyChecked) return false;
      // 未選択のグループへ Shift+Tab で戻ると最後のラジオに入るブラウザがあるため、フォーカス中のものを代表にする
      var focusedInGroup = Array.prototype.indexOf.call(group, document.activeElement) >= 0;
      return focusedInGroup ? e === document.activeElement : group[0] === e;
    });
}

/* ポップオーバーメニュー（行の「⋯」・進捗の選択）。矢印キーで移動、Esc/外側クリックで閉じる */
var openMenuCtx = null;
function openMenu(anchor, items) {
  closeMenu();
  var menu = el('div', { className: 'menu', role: 'menu' });
  items.forEach(function (it) {
    if (it === '-') { menu.appendChild(el('hr')); return; }
    menu.appendChild(el('button', {
      type: 'button', role: 'menuitem', className: (it.danger ? 'danger' : '') + (it.current ? ' current' : ''),
      disabled: !!it.disabled, text: it.label,
      onclick: function (ev) { ev.stopPropagation(); closeMenu(); it.action(); }
    }));
  });
  document.getElementById('menu-root').appendChild(menu);
  var r = anchor.getBoundingClientRect();
  var top = r.bottom + 2, left = Math.max(4, r.right - menu.offsetWidth);
  if (top + menu.offsetHeight > window.innerHeight - 4) top = Math.max(4, r.top - menu.offsetHeight - 2);
  menu.style.top = top + 'px';
  menu.style.left = left + 'px';
  anchor.setAttribute('aria-expanded', 'true');
  openMenuCtx = { menu: menu, anchor: anchor };
  var btns = menu.querySelectorAll('button:not([disabled])');
  var cur = menu.querySelector('button.current:not([disabled])');
  (cur || btns[0]).focus();
  menu.addEventListener('keydown', function (ev) {
    var list = Array.prototype.slice.call(menu.querySelectorAll('button:not([disabled])'));
    var i = list.indexOf(document.activeElement);
    if (ev.key === 'ArrowDown') { ev.preventDefault(); list[(i + 1) % list.length].focus(); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); list[(i - 1 + list.length) % list.length].focus(); }
    else if (ev.key === 'Escape' || ev.key === 'Tab') { ev.preventDefault(); var a = anchor; closeMenu(); a.focus(); }
  });
}

function closeMenu() {
  if (!openMenuCtx) return;
  openMenuCtx.anchor.setAttribute('aria-expanded', 'false');
  if (openMenuCtx.menu.parentNode) openMenuCtx.menu.parentNode.removeChild(openMenuCtx.menu);
  openMenuCtx = null;
}

/* =========================================================================
 * 9. 表示行の構築（テーブル・ガント共通。表示順＝タスク配列順）
 * ========================================================================= */
var taskById = new Map();
var currentRows = [];

function rebuildTaskIndex() {
  taskById = new Map();
  for (var i = 0; i < state.project.tasks.length; i++) taskById.set(state.project.tasks[i].id, state.project.tasks[i]);
}
function getTaskById(id) { return taskById.get(id) || null; }
function getMajors() { return state.project.tasks.filter(function (t) { return t.level === 'major'; }); }
function getChildrenOf(majorId) { return state.project.tasks.filter(function (t) { return t.level === 'minor' && t.parentId === majorId; }); }

function isFilterActive() { return !!(state.ui.filterOwner || state.ui.filterStatus); }

function taskMatchesFilter(task) {
  var ui = state.ui;
  if (ui.filterOwner) {
    var want = ui.filterOwner === '__none__' ? '' : ui.filterOwner;
    if ((task.owner || '') !== want) return false;
  }
  if (ui.filterStatus) {
    var d = derived.get(task.id) || {};
    if (ui.filterStatus === 'risk' && d.delayStatus !== 'atRisk' && d.delayStatus !== 'delayed') return false;
    if (ui.filterStatus === 'delayed' && d.delayStatus !== 'delayed') return false;
    if (ui.filterStatus === 'critical' && !d.isCritical) return false;
    if (ui.filterStatus === 'open') {
      var p = task.level === 'major' ? d.displayProgress : task.progress;
      if (p != null && p >= 100) return false;
    }
  }
  return true;
}

/* 絞り込み中は該当する小事業を持つ大事業を自動で展開して示す（D7） */
function buildVisibleRows() {
  var rows = [], filtering = isFilterActive(), childrenIdx = buildChildrenIndex(state.project.tasks);
  for (var i = 0; i < state.project.tasks.length; i++) {
    var major = state.project.tasks[i];
    if (major.level !== 'major') continue;
    var children = childrenIdx.get(major.id) || [];
    var shown = filtering ? children.filter(taskMatchesFilter) : children;
    if (filtering && shown.length === 0 && !taskMatchesFilter(major)) continue;
    rows.push({ type: 'major', task: major, childCount: children.length });
    if (filtering || state.ui.expandedMajors.has(major.id)) {
      for (var j = 0; j < shown.length; j++) rows.push({ type: 'minor', task: shown[j] });
    }
  }
  return rows;
}

/* =========================================================================
 * 10. 描画: WBSテーブル
 * ========================================================================= */
var printHideOwner = false;

function fmtDays(task, d) {
  var r = rangeOf(task, d);
  return (r.start && r.end) ? String(inclusiveDays(r.start, r.end)) : '';
}

function renderStatusChip(status) {
  return el('span', { className: 'status-chip status-' + (status || 'unknown') }, [
    el('span', { className: 'status-dot', 'aria-hidden': 'true' }), DELAY_LABELS[status] || '—'
  ]);
}

function progressEditable(task, d) { return task.level === 'minor' || !d.hasChildren; }

/* 一覧の列（v1.4）。シンプル表示は 事業名・担当者・開始・終了・当初比、詳細表示は日数・進捗・状態も出す */
function tableColumns() {
  var cols = [['c-wbs', 'WBS'], ['c-name', '事業名'], ['c-owner', '担当者'], ['c-start', '開始'], ['c-end', '終了']];
  if (state.ui.detailMode) cols.push(['c-days', '日数'], ['c-progress', '進捗'], ['c-status', '状態']);
  cols.push(['c-diff', '当初比（終了）']);
  cols.push(['c-ops appbox-print-hidden', null]);
  return cols;
}

function renderTableHead() {
  var colgroup = document.getElementById('table-cols'), headRow = document.getElementById('table-head-row');
  clearChildren(colgroup); clearChildren(headRow);
  tableColumns().forEach(function (c) {
    colgroup.appendChild(el('col', { className: c[0] }));
    if (c[1] === null) headRow.appendChild(el('th', { scope: 'col', className: 'appbox-print-hidden' }, el('span', { className: 'appbox-sr-only', text: '操作' })));
    else {
      var th = el('th', { scope: 'col', text: c[1] });
      if (c[0] === 'c-diff') th.title = '修正後の終了日と当初計画の終了日の差（＋は遅れ）。「当初計画を確定」で記録します';
      headRow.appendChild(th);
    }
  });
}

function renderTable() {
  renderTableHead();
  var tbody = document.getElementById('table-body');
  clearChildren(tbody);
  var rows = buildVisibleRows();
  currentRows = rows;
  document.getElementById('table-empty').hidden = state.project.tasks.length !== 0;
  if (rows.length === 0) return;
  var focusId = state.ui.focusTaskId;
  if (!focusId || !rows.some(function (r) { return r.task.id === focusId; })) focusId = state.ui.focusTaskId = rows[0].task.id;
  for (var i = 0; i < rows.length; i++) tbody.appendChild(renderRow(rows[i], focusId));
  tbody.appendChild(renderAddRow());
}

/* v1.5: 一覧の最下段の「＋ 作業を追加」。表の一番下に足すので、最後の大事業の末尾へ追加する
   （ガント側の同じ行をドラッグしても、最後の大事業へ追加される） */
function renderAddRow() {
  var td = el('td', { colSpan: tableColumns().length }, [
    el('button', { type: 'button', text: '＋ 作業を追加', title: '最後の大事業の末尾に小事業を追加します（ガントの空いている所をドラッグしても作れます）',
      onclick: function () { openAddMinorForm(lastMajorId()); } }),
    el('button', { type: 'button', text: '＋ 大事業を追加', onclick: openAddMajorForm })
  ]);
  return el('tr', { className: 'add-row appbox-print-hidden' }, td);
}

function lastMajorId() {
  var majors = getMajors();
  return majors.length ? majors[majors.length - 1].id : null;
}

function renderRow(row, focusId) {
  var task = row.task, d = derived.get(task.id) || {}, isMajor = row.type === 'major';
  var tr = el('tr', {
    className: 'row-' + row.type + (state.ui.recentlySlidIds.has(task.id) ? ' row-just-slid' : ''),
    tabindex: task.id === focusId ? '0' : '-1',
    'data-id': task.id
  });
  tr.addEventListener('click', function (ev) {
    if (ev.target.closest('button')) return;
    state.ui.focusTaskId = task.id;
    openEditForm(task.id);
  });
  tr.addEventListener('keydown', function (ev) { onRowKeyDown(ev, row); });
  tr.addEventListener('focus', function () { setRovingFocus(task.id, false); });

  tr.appendChild(el('td', {}, wbsNumbers.get(task.id) || ''));

  var nameChildren = [];
  if (isMajor) {
    if (row.childCount > 0) {
      var expanded = isFilterActive() || state.ui.expandedMajors.has(task.id);
      nameChildren.push(el('button', {
        type: 'button', className: 'toggle-btn', tabindex: '-1',
        'aria-expanded': expanded ? 'true' : 'false', disabled: isFilterActive(),
        'aria-label': (expanded ? '小事業を隠す: ' : '小事業を表示: ') + task.name,
        title: isFilterActive() ? '絞り込み中は自動で展開されます' : (expanded ? '小事業を隠す' : '小事業を表示'),
        text: expanded ? '▼' : '▶',
        onclick: function (ev) { ev.stopPropagation(); toggleMajor(task.id); }
      }));
    } else {
      nameChildren.push(el('span', { className: 'toggle-placeholder', 'aria-hidden': 'true' }));
    }
  }
  // v1.5: 目安の印は名前の前に置く（長い名前の末尾は省略されて見えなくなるため）
  if (task.tentative) nameChildren.push(el('span', { className: 'tentative-mark', title: '日程は目安です（はっきり決まっていません）', text: '目安' }));
  nameChildren.push(document.createTextNode(task.name));
  if (task.isMilestone) nameChildren.push(el('span', { className: 'milestone-mark', title: 'マイルストーン', text: '◆' }));
  if (!isMajor && !state.ui.detailMode && task.predecessors.length > 0) {
    // シンプル表示でも先行タスクによる自動調整は働くので、指定があることを示す
    nameChildren.push(el('span', { className: 'pred-mark', title: '先行タスクの指定があります（先行が延びると、この作業は自動で後ろへずれます）', text: '先行' }));
  }
  if (!isMajor && d.isCritical && state.ui.detailMode) nameChildren.push(el('span', { className: 'cp-badge', title: 'クリティカルパス上のタスク（遅れると全体の完了が遅れる）', text: 'CP' }));
  var nameTd = el('td', { className: 'name-cell' }, nameChildren);
  nameTd.title = task.name + (task.memo ? '\n' + truncateText(task.memo, 200) : '');
  tr.appendChild(nameTd);

  tr.appendChild(el('td', { className: 'owner-cell' }, printHideOwner ? '—' : (task.owner || '')));
  var r = rangeOf(task, d);
  tr.appendChild(el('td', {}, r.start || ''));
  tr.appendChild(el('td', {}, r.end || ''));
  if (state.ui.detailMode) {
  tr.appendChild(el('td', {}, fmtDays(task, d)));

  var progTd = el('td', {});
  if (progressEditable(task, d)) {
    progTd.appendChild(el('button', {
      type: 'button', className: 'progress-btn', tabindex: '-1', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
      'aria-label': '進捗率 ' + task.progress + '%（クリックで変更）', text: task.progress + '%',
      onclick: function (ev) { ev.stopPropagation(); openProgressMenu(ev.currentTarget, task.id); }
    }));
  } else {
    progTd.appendChild(document.createTextNode(d.displayProgress == null ? '—' : d.displayProgress + '%'));
    progTd.title = '小事業の進捗から自動計算（期間の長さで加重平均）';
  }
  tr.appendChild(progTd);
  tr.appendChild(el('td', {}, renderStatusChip(d.delayStatus)));
  }
  var delta = planDeltaOf(task, d);
  var deltaTd = el('td', { className: delta ? (delta.days > 0 ? 'delta-late' : (delta.days < 0 ? 'delta-early' : '')) : '' }, delta ? delta.text : '');
  if (delta) deltaTd.title = '当初計画: ' + task.baselineStart + (task.isMilestone ? '' : ' 〜 ' + task.baselineEnd);
  tr.appendChild(deltaTd);

  var ops = el('td', { className: 'ops-cell appbox-print-hidden' });
  if (isMajor) {
    ops.appendChild(el('button', {
      type: 'button', tabindex: '-1', title: 'この大事業に小事業を追加', 'aria-label': '小事業を追加: ' + task.name, text: '＋',
      onclick: function (ev) { ev.stopPropagation(); openAddMinorForm(task.id); }
    }));
  }
  ops.appendChild(el('button', {
    type: 'button', tabindex: '-1', title: '操作（編集・複製・移動・削除）', 'aria-label': '操作メニュー: ' + task.name,
    'aria-haspopup': 'menu', 'aria-expanded': 'false', text: '⋯',
    onclick: function (ev) { ev.stopPropagation(); openRowMenu(ev.currentTarget, task.id); }
  }));
  tr.appendChild(ops);
  return tr;
}

/* 行はロービング tabindex（Tab で一覧に入り、↑↓で行を移動）。行内のボタンは Tab で辿らせず、行のキーで操作する */
function setRovingFocus(taskId, moveFocus) {
  state.ui.focusTaskId = taskId;
  var trs = document.querySelectorAll('#table-body tr');
  for (var i = 0; i < trs.length; i++) {
    var on = trs[i].getAttribute('data-id') === taskId;
    trs[i].setAttribute('tabindex', on ? '0' : '-1');
    if (on && moveFocus) trs[i].focus();
  }
}

function focusedRowId() {
  var a = document.activeElement;
  var tr = a && a.closest ? a.closest('#table-body tr') : null;
  return tr ? tr.getAttribute('data-id') : null;
}

/* =========================================================================
 * 11. 描画: ガントチャート（SVG。日付ヘッダは別SVGで上部に固定＝B6）
 * ========================================================================= */
var ganttGeom = null;   // { range, pxPerDay, rows, scale }

function collectAllDates(withReference) {
  var dates = [];
  for (var i = 0; i < state.project.tasks.length; i++) {
    var t = state.project.tasks[i];
    var r = rangeOf(t, derived.get(t.id) || {});
    if (r.start) dates.push(r.start);
    if (r.end) dates.push(r.end);
    if (t.baselineStart) dates.push(t.baselineStart);
    if (t.baselineEnd) dates.push(t.baselineEnd);
  }
  if (withReference !== false) dates.push(state.ui.referenceDate);
  return dates;
}

function computeGanttRange() {
  var period = state.project.period;
  if (period) { // v1.4: 期間を指定したときは、期間とタスクの日付を合わせた範囲（基準日では広げない）
    var pd = collectAllDates(false);
    return pd.length ? unionPeriod({ start: minDateStr(pd), end: maxDateStr(pd) }, period) : { start: period.start, end: period.end };
  }
  var dates = collectAllDates();
  var minD = minDateStr(dates), maxD = maxDateStr(dates);
  if (state.project.tasks.length === 0) { minD = dayAdd(state.ui.referenceDate, -3); maxD = dayAdd(state.ui.referenceDate, 27); }
  // 余白4日（許容範囲の端では広げない）
  return { start: clampDate(dayAdd(minD, -4)), end: clampDate(dayAdd(maxD, 4)) };
}

/* A4: 期間が長すぎて描画が重くなる粒度は、粗い粒度へ自動で切り替える */
function chooseRenderScale(totalDays) {
  var order = SCALE_ORDER, i = order.indexOf(state.ui.scale);
  if (i === -1) i = order.indexOf('week');
  while (i < order.length - 1 && totalDays > MAX_RENDER_DAYS[order[i]]) i++;
  return order[i];
}

function xOf(dateStr) { return dayDiff(dateStr, ganttGeom.range.start) * ganttGeom.pxPerDay; }

function renderGantt() {
  if (dragState) { // ドラッグ中に元に戻す等で描き直すときは、ドラッグを打ち切る（古いSVG・行の並びを使い続けないため）
    dragState = null;
    document.getElementById('drag-tip').hidden = true;
  }
  var headerWrap = document.getElementById('gantt-header');
  var bodyWrap = document.getElementById('gantt-body');
  clearChildren(headerWrap);
  clearChildren(bodyWrap);

  var rows = currentRows;
  var range = computeGanttRange();
  var totalDays = dayDiff(range.end, range.start) + 1;
  var scale = chooseRenderScale(totalDays);
  if (scale !== state.ui.scale) {
    var from = state.ui.scale;
    state.ui.scale = scale;
    document.getElementById('scale-select').value = scale;
    showToast('期間が長いため、表示を「' + SCALE_LABELS[from] + '」から「' + SCALE_LABELS[scale] + '」に切り替えました。', 'info', 5000);
  }
  range = snapRangeToBuckets(range, scale); // 旬・半月・月・年度は端のマスを丸ごと描く
  totalDays = dayDiff(range.end, range.start) + 1;
  var pxPerDay = PX_PER_DAY[scale];
  var totalW = Math.max(totalDays * pxPerDay + GANTT_LABEL_PAD, 200); // 右端のバー・マイルストーンの名前が切れないよう余白を取る
  var addRowIdx = rows.length > 0 ? rows.length : -1; // 一覧の最下段（追加用の行）に対応する行。行が無ければ作らない
  var bodyH = Math.max((rows.length + (addRowIdx >= 0 ? 1 : 0)) * ROW_H, ROW_H);
  ganttGeom = { addRowIdx: addRowIdx, gridW: totalDays * pxPerDay, range: range, pxPerDay: pxPerDay, rows: rows, scale: scale, totalW: totalW, bodyH: bodyH };

  var head = svgEl('svg', { width: totalW, height: HEAD_H, viewBox: '0 0 ' + totalW + ' ' + HEAD_H, 'aria-hidden': 'true' });
  renderGanttHeader(head, totalDays, totalW);
  headerWrap.appendChild(head);

  var body = svgEl('svg', { width: totalW, height: bodyH, viewBox: '0 0 ' + totalW + ' ' + bodyH, role: 'img',
    'aria-label': 'ガントチャート（' + rows.length + '行）。各行は左の一覧と対応しています' });
  body.appendChild(buildSvgDefs('g'));
  renderGanttBackground(body, totalDays, totalW, bodyH, rows);
  renderGanttDependencies(body, rows);
  renderGanttBars(body, rows);
  renderGanttTodayLine(body, bodyH);
  if (addRowIdx >= 0) {
    var hint = svgEl('text', { x: 8, y: addRowIdx * ROW_H + ROW_H / 2 + 4, 'class': 'gantt-add-hint' });
    hint.textContent = '空いている所を横にドラッグすると、その期間の作業を追加できます';
    body.appendChild(hint);
  }
  bodyWrap.appendChild(body);
  wireGanttPointer(body);

  if (state.project.tasks.length === 0) {
    bodyWrap.appendChild(el('div', { className: 'gantt-empty', text: 'タスクを追加すると、ここにガントチャートが表示されます。' }));
  }
}

var BUCKET_LONG_LABELS = { '上': '上旬', '中': '中旬', '下': '下旬', '前': '前半', '後': '後半' };

/* 旬・半月・月・年度: 上段＝まとめ（月 or 年度）、下段＝マス。罫線はマスの境目 */
function renderBucketHeader(svg, totalW) {
  var scale = ganttGeom.scale, px = ganttGeom.pxPerDay, range = ganttGeom.range;
  var buckets = buildDateBuckets(range.start, range.end, scale), groups = groupBucketsForScale(buckets, scale);
  var half = HEAD_H / 2;
  groups.forEach(function (g) {
    var gx = Math.max(0, xOf(buckets[g.startIdx].start));
    svg.appendChild(svgEl('line', { x1: gx, y1: 0, x2: gx, y2: HEAD_H, 'class': 'gantt-head-line-strong' }));
    var t = svgEl('text', { x: gx + 3, y: 12, 'class': 'gantt-header-month' });
    t.textContent = scale === 'month' ? g.label : (g.label.slice(5) === '1月' || g.startIdx === 0 ? g.label : g.label.replace(/^\d+年/, ''));
    svg.appendChild(t);
  });
  buckets.forEach(function (b) {
    var bx = Math.max(0, xOf(b.start)), w = xOf(b.end) + px - bx;
    svg.appendChild(svgEl('line', { x1: bx, y1: groups.length ? half : 0, x2: bx, y2: HEAD_H, 'class': 'gantt-head-line' }));
    var label = (w >= 34 && BUCKET_LONG_LABELS[b.label]) ? BUCKET_LONG_LABELS[b.label] : b.label;
    if (w < 14) return; // 狭すぎるマスは文字を省く
    var t = svgEl('text', { x: bx + w / 2, y: groups.length ? HEAD_H - 5 : half + 4, 'text-anchor': 'middle', 'class': 'gantt-header-bucket' });
    t.textContent = label;
    t.appendChild(svgTitle(b.start + ' 〜 ' + b.end));
    svg.appendChild(t);
  });
  svg.appendChild(svgEl('line', { x1: 0, y1: HEAD_H - 0.5, x2: totalW, y2: HEAD_H - 0.5, 'class': 'gantt-head-line' }));
}

function renderGanttHeader(svg, totalDays, totalW) {
  var scale = ganttGeom.scale, px = ganttGeom.pxPerDay, start = ganttGeom.range.start;
  svg.appendChild(svgEl('rect', { x: 0, y: 0, width: totalW, height: HEAD_H, 'class': 'gantt-head-bg' }));
  if (BUCKET_SCALES.indexOf(scale) !== -1) { renderBucketHeader(svg, totalW); return; }
  var lastMonthX = -1000;
  for (var i = 0; i < totalDays; i++) {
    var ds = dayAdd(start, i), x = i * px, day = ds.slice(8, 10);
    if (day === '01' || i === 0) {
      svg.appendChild(svgEl('line', { x1: x, y1: 0, x2: x, y2: HEAD_H, 'class': 'gantt-head-line' }));
      // C14: 月ラベルは重ならない間隔（34px）を空けて描く
      if (x - lastMonthX >= 34) {
        var monthLbl = svgEl('text', { x: x + 3, y: 12, 'class': 'gantt-header-month' });
        monthLbl.textContent = (day === '01' && ds.slice(5, 7) === '01') || i === 0 ? ds.slice(0, 4) + '/' + Number(ds.slice(5, 7)) : Number(ds.slice(5, 7)) + '月';
        svg.appendChild(monthLbl);
        lastMonthX = x;
      }
    }
    if (scale === 'month') continue;
    var wd = dowOfStr(ds);
    if (scale === 'day' || wd === 1) {
      var holiday = holidayNameOf(ds);
      var t = svgEl('text', { x: x + (scale === 'day' ? px / 2 : 2), y: HEAD_H - 5, 'text-anchor': scale === 'day' ? 'middle' : 'start',
        'class': 'gantt-header-label' + (holiday ? ' holiday' : (wd === 0 || wd === 6 ? ' weekend' : '')) });
      t.textContent = scale === 'day' ? Number(day) + DOW_NAMES[wd] : Number(day);
      if (holiday) t.appendChild(svgTitle(holiday));
      svg.appendChild(t);
    }
  }
  svg.appendChild(svgEl('line', { x1: 0, y1: HEAD_H - 0.5, x2: totalW, y2: HEAD_H - 0.5, 'class': 'gantt-head-line' }));
}

function buildSvgDefs(prefix) {
  var defs = svgEl('defs');
  var pattern = svgEl('pattern', { id: prefix + 'hatchPattern', patternUnits: 'userSpaceOnUse', width: 6, height: 6, patternTransform: 'rotate(45)' });
  pattern.appendChild(svgEl('rect', { width: 6, height: 6, 'class': 'gantt-hatch-bg' }));
  pattern.appendChild(svgEl('line', { x1: 0, y1: 0, x2: 0, y2: 6, 'class': 'gantt-hatch-line' }));
  defs.appendChild(pattern);
  [['arrowHead', 'gantt-arrow-head'], ['arrowHeadCritical', 'gantt-arrow-head critical']].forEach(function (a) {
    var marker = svgEl('marker', { id: prefix + a[0], markerWidth: 8, markerHeight: 8, refX: 6, refY: 3, orient: 'auto' });
    marker.appendChild(svgEl('path', { d: 'M0,0 L6,3 L0,6 Z', 'class': a[1] }));
    defs.appendChild(marker);
  });
  return defs;
}

function renderGanttBackground(svg, totalDays, totalW, bodyH, rows) {
  var g = svgEl('g');
  for (var r = 0; r < rows.length; r++) {
    var y = r * ROW_H;
    if (rows[r].type === 'major') g.appendChild(svgEl('rect', { x: 0, y: y, width: totalW, height: ROW_H, 'class': 'gantt-row-bg-major' }));
    else if (r % 2 === 1) g.appendChild(svgEl('rect', { x: 0, y: y, width: totalW, height: ROW_H, 'class': 'gantt-row-bg-odd' }));
  }
  var scale = ganttGeom.scale, px = ganttGeom.pxPerDay, start = ganttGeom.range.start;
  if (BUCKET_SCALES.indexOf(scale) !== -1) { // 旬・半月・月・年度: 土日の縞は描かず、マスの境目に罫線を引く
    var bks = buildDateBuckets(ganttGeom.range.start, ganttGeom.range.end, scale), grs = groupBucketsForScale(bks, scale);
    var strong = new Set(grs.map(function (gg) { return gg.startIdx; }));
    bks.forEach(function (b, bi) {
      var bx = xOf(b.start);
      if (bx > 0) g.appendChild(svgEl('line', { x1: bx, y1: 0, x2: bx, y2: bodyH, 'class': strong.has(bi) ? 'gantt-gridline-strong' : 'gantt-gridline' }));
    });
  }
  if (BUCKET_SCALES.indexOf(scale) === -1) { // A4/C14: 粗い単位では土日の縞を描かない（数px間隔の縞は判読性もない）
    for (var i = 0; i < totalDays; i++) {
      var ds = dayAdd(start, i), x = i * px;
      if (holidayNameOf(ds)) g.appendChild(svgEl('rect', { x: x, y: 0, width: px, height: bodyH, 'class': 'gantt-holiday' }));
      else if (isWeekend(ds)) g.appendChild(svgEl('rect', { x: x, y: 0, width: px, height: bodyH, 'class': 'gantt-weekend' }));
      if (scale === 'day') g.appendChild(svgEl('line', { x1: x, y1: 0, x2: x, y2: bodyH, 'class': 'gantt-gridline' }));
    }
  }
  for (var r2 = 1; r2 <= rows.length; r2++) {
    g.appendChild(svgEl('line', { x1: 0, y1: r2 * ROW_H - 0.5, x2: totalW, y2: r2 * ROW_H - 0.5, 'class': 'gantt-gridline' }));
  }
  svg.appendChild(g);
}

function barTooltip(task, d) {
  var r = rangeOf(task, d);
  var lines = [(wbsNumbers.get(task.id) || '') + ' ' + task.name];
  if (r.start && r.end) lines.push(r.start + ' 〜 ' + r.end + '（' + inclusiveDays(r.start, r.end) + '日）');
  var p = task.level === 'major' ? d.displayProgress : task.progress;
  if (state.ui.detailMode) lines.push('進捗 ' + (p == null ? '—' : p + '%') + '　状態 ' + (DELAY_LABELS[d.delayStatus] || '—'));
  if (task.owner && !printHideOwner) lines.push('担当 ' + task.owner);
  if (task.tentative) lines.push('日程は目安です（はっきり決まっていません）');
  if (task.level === 'minor' && d.isCritical && state.ui.detailMode) lines.push('クリティカルパス上');
  if (task.baselineStart && task.baselineEnd) {
    var dl = planDeltaOf(task, d);
    lines.push('当初計画 ' + task.baselineStart + (task.isMilestone ? '' : ' 〜 ' + task.baselineEnd) + (dl ? '（当初比 ' + dl.text + '）' : ''));
  }
  lines.push(task.level === 'major' ? 'ドラッグで配下ごと移動／クリックで編集' : (task.isMilestone ? 'ドラッグで移動／クリックで編集' : 'ドラッグで移動・端をドラッグで期間変更／クリックで編集'));
  return lines.join('\n');
}

function shortDate(ds) { return Number(ds.slice(5, 7)) + '/' + Number(ds.slice(8, 10)); }

/* 当初より延びた部分（下段のバーの、当初計画の終了日より後ろ）をオレンジで重ねる */
function appendDelayOverlay(bg, task, x1, x2, y, h) {
  if (!task.baselineEnd) return;
  var dx = Math.max(x1, xOf(task.baselineEnd) + ganttGeom.pxPerDay);
  if (x2 - dx >= 1) bg.appendChild(svgEl('rect', { x: dx, y: y, width: x2 - dx, height: h, rx: 2, 'class': 'gantt-bar-delay' }));
}

function renderGanttBars(svg, rows) {
  var g = svgEl('g'), detail = state.ui.detailMode;
  var og = svgEl('g', { 'class': 'gantt-orig-layer' }); // 当初計画（上段）はバーと別の層に描き、ドラッグ中も動かさない
  for (var r = 0; r < rows.length; r++) {
    var task = rows[r].task, d = derived.get(task.id) || {}, y = r * ROW_H, isMajor = rows[r].type === 'major';
    var bg = svgEl('g', { 'class': 'gantt-bar-g', 'data-id': task.id, 'data-row': r });
    bg.appendChild(svgTitle(barTooltip(task, d)));
    // v1.4: 当初計画があるタスクは2段書き（上段＝当初計画、下段＝修正後の予定）
    var twoTier = !!(task.baselineStart && task.baselineEnd);
    var crit = detail && d.isCritical;

    if (!isMajor && task.isMilestone) {
      if (task.plannedStart) {
        var mx = xOf(task.plannedStart) + ganttGeom.pxPerDay / 2;
        var moved = twoTier && task.baselineStart !== task.plannedStart;
        var my = moved ? y + 20 : y + ROW_H / 2, h = moved ? 6 : 8;
        if (twoTier && task.baselineStart !== task.plannedStart) { // 当初の日付から動いたときだけ白抜きの◆
          var ox = xOf(task.baselineStart) + ganttGeom.pxPerDay / 2, oy = y + 8, oh = 5;
          og.appendChild(svgEl('polygon', { points: [ox, oy - oh, ox + oh, oy, ox, oy + oh, ox - oh, oy].join(','), 'class': 'gantt-milestone-orig' }));
        }
        bg.setAttribute('data-kind', 'milestone');
        bg.appendChild(svgEl('polygon', { points: [mx, my - h, mx + h, my, mx, my + h, mx - h, my].join(','),
          'class': 'gantt-milestone' + (crit ? ' critical' : '') + (task.tentative ? ' tentative' : '') }));
        var ml = svgEl('text', { x: mx + h + 4, y: my + 4, 'class': 'gantt-ms-label' });
        var dl = planDeltaOf(task, d);
        ml.textContent = (task.tentative ? TENTATIVE_PREFIX : '') + task.name + '（' + shortDate(task.plannedStart) + (dl && dl.days !== 0 ? '・当初' + shortDate(task.baselineStart) : '') + '）';
        bg.appendChild(ml);
      }
      g.appendChild(bg);
      continue;
    }
    var rg = rangeOf(task, d);
    if (!rg.start || !rg.end) { g.appendChild(bg); continue; }
    var x1 = xOf(rg.start), x2 = xOf(rg.end) + ganttGeom.pxPerDay;
    if (twoTier) {
      var bx1 = xOf(task.baselineStart), bx2 = xOf(task.baselineEnd) + ganttGeom.pxPerDay;
      og.appendChild(svgEl('rect', { x: bx1, y: y + 3, width: Math.max(2, bx2 - bx1), height: 7, rx: 2, 'class': 'gantt-plan-orig' }));
    }
    if (isMajor) {
      var barH = twoTier ? 13 : MAJOR_BAR_H, barY = twoTier ? y + 13 : y + (ROW_H - MAJOR_BAR_H) / 2;
      bg.setAttribute('data-kind', 'major');
      var hasManual = task.plannedStart != null && task.plannedEnd != null;
      var tcls = task.tentative ? ' tentative' : '';
      if (!detail) { // シンプル表示: 大事業は期間全体を1本の塗りつぶしで描く（自動で広がった部分の斜線は詳細表示で）
        bg.appendChild(svgEl('rect', { x: x1, y: barY, width: x2 - x1, height: barH, rx: 2, 'class': 'gantt-bar-major' + tcls }));
      } else if (hasManual) {
        var mS = xOf(task.plannedStart), mE = xOf(task.plannedEnd) + ganttGeom.pxPerDay;
        if (x1 < mS) bg.appendChild(svgEl('rect', { x: x1, y: barY, width: mS - x1, height: barH, rx: 2, 'class': 'gantt-bar-major-ext' + tcls }));
        if (x2 > mE) bg.appendChild(svgEl('rect', { x: mE, y: barY, width: x2 - mE, height: barH, rx: 2, 'class': 'gantt-bar-major-ext' + tcls }));
        bg.appendChild(svgEl('rect', { x: mS, y: barY, width: mE - mS, height: barH, rx: 2, 'class': 'gantt-bar-major' + tcls }));
      } else {
        bg.appendChild(svgEl('rect', { x: x1, y: barY, width: x2 - x1, height: barH, rx: 2, 'class': 'gantt-bar-major-ext' + tcls }));
      }
      if (detail && d.displayProgress != null) {
        bg.appendChild(svgEl('rect', { x: x1, y: barY, width: (x2 - x1) * (d.displayProgress / 100), height: barH, rx: 2, 'class': 'gantt-bar-progress' }));
      }
      if (twoTier) appendDelayOverlay(bg, task, x1, x2, barY, barH);
      var lbl = svgEl('text', { x: x2 + 4, y: barY + barH - 3, 'class': 'gantt-bar-label' });
      lbl.textContent = (task.tentative ? TENTATIVE_PREFIX : '') + task.name;
      bg.appendChild(lbl);
    } else {
      var mh = twoTier ? 11 : MINOR_BAR_H, mbarY = twoTier ? y + 14 : y + (ROW_H - MINOR_BAR_H) / 2;
      bg.setAttribute('data-kind', 'minor');
      bg.appendChild(svgEl('rect', { x: x1, y: mbarY, width: x2 - x1, height: mh, rx: 2,
        'class': 'gantt-bar-minor' + (crit ? ' critical' : '') + (task.tentative ? ' tentative' : '') }));
      if (detail) bg.appendChild(svgEl('rect', { x: x1, y: mbarY, width: (x2 - x1) * (task.progress / 100), height: mh, rx: 2, 'class': 'gantt-bar-progress' }));
      if (twoTier) appendDelayOverlay(bg, task, x1, x2, mbarY, mh);
      var nl = svgEl('text', { x: x2 + 4, y: mbarY + mh - 2, 'class': 'gantt-bar-label' });
      nl.textContent = (task.tentative ? TENTATIVE_PREFIX : '') + task.name;
      bg.appendChild(nl);
    }
    g.appendChild(bg);
  }
  svg.appendChild(og);
  svg.appendChild(g);
}

/* C13: 後続が先行の直後（隣接）でも、行間を経由して後続の左側から入る経路にする */
function renderGanttDependencies(svg, rows) {
  var g = svgEl('g');
  var rowIndexById = new Map();
  for (var r = 0; r < rows.length; r++) rowIndexById.set(rows[r].task.id, r);
  for (var r2 = 0; r2 < rows.length; r2++) {
    var task = rows[r2].task;
    if (rows[r2].type !== 'minor' || !task.plannedStart || task.predecessors.length === 0) continue;
    var toX = xOf(task.plannedStart), toY = r2 * ROW_H + ROW_H / 2;
    for (var p = 0; p < task.predecessors.length; p++) {
      var predId = task.predecessors[p];
      if (!rowIndexById.has(predId)) continue; // 折りたたみ・絞り込みで非表示なら描かない
      var pred = getTaskById(predId);
      if (!pred || !pred.plannedEnd) continue;
      var fromX = xOf(pred.plannedEnd) + ganttGeom.pxPerDay, fromY = rowIndexById.get(predId) * ROW_H + ROW_H / 2;
      var pathD;
      if (toX - fromX >= 14) {
        var midX = fromX + 7;
        pathD = 'M' + fromX + ' ' + fromY + ' H' + midX + ' V' + toY + ' H' + (toX - 1);
      } else {
        var laneY = toY > fromY ? toY - ROW_H / 2 : toY + ROW_H / 2;
        pathD = 'M' + fromX + ' ' + fromY + ' H' + (fromX + 6) + ' V' + laneY + ' H' + (toX - 8) + ' V' + toY + ' H' + (toX - 1);
      }
      var crit = state.ui.detailMode && isCriticalEdge(predId, task.id, derived);
      g.appendChild(svgEl('path', { d: pathD, 'class': 'gantt-dep-arrow' + (crit ? ' critical' : ''),
        'marker-end': 'url(#g' + (crit ? 'arrowHeadCritical' : 'arrowHead') + ')' }));
    }
  }
  svg.appendChild(g);
}

function renderGanttTodayLine(svg, bodyH) {
  var x = xOf(state.ui.referenceDate) + ganttGeom.pxPerDay / 2;
  svg.appendChild(svgEl('line', { x1: x, y1: 0, x2: x, y2: bodyH, 'class': 'gantt-today-line' }));
  var t = svgEl('text', { x: x + 3, y: 9, 'class': 'gantt-today-label' });
  t.textContent = state.ui.referenceDate === todayStr() ? '今日' : '基準日';
  svg.appendChild(t);
}

/* =========================================================================
 * 12. 凡例・印刷ヘッダー・バナー・全体再描画
 * ========================================================================= */
function legendSwatch(kind) {
  var s = svgEl('svg', { width: 22, height: 12, 'aria-hidden': 'true' });
  if (kind === 'hatch') {
    var defs = svgEl('defs'), pat = svgEl('pattern', { id: 'lgHatch', patternUnits: 'userSpaceOnUse', width: 6, height: 6, patternTransform: 'rotate(45)' });
    pat.appendChild(svgEl('rect', { width: 6, height: 6, 'class': 'gantt-hatch-bg' }));
    pat.appendChild(svgEl('line', { x1: 0, y1: 0, x2: 0, y2: 6, 'class': 'gantt-hatch-line' }));
    defs.appendChild(pat); s.appendChild(defs);
    s.appendChild(svgEl('rect', { x: 1, y: 1, width: 20, height: 10, rx: 2, 'class': 'lg-ext' }));
  } else if (kind === 'major') s.appendChild(svgEl('rect', { x: 1, y: 1, width: 20, height: 10, rx: 2, 'class': 'lg-fill-major' }));
  else if (kind === 'minor') s.appendChild(svgEl('rect', { x: 1, y: 3, width: 20, height: 7, rx: 2, 'class': 'lg-fill-minor' }));
  else if (kind === 'progress') {
    s.appendChild(svgEl('rect', { x: 1, y: 3, width: 20, height: 7, rx: 2, 'class': 'lg-fill-minor' }));
    s.appendChild(svgEl('rect', { x: 1, y: 3, width: 12, height: 7, rx: 2, 'class': 'gantt-bar-progress' }));
  } else if (kind === 'critical') s.appendChild(svgEl('rect', { x: 2, y: 3, width: 18, height: 7, rx: 2, 'class': 'lg-critical' }));
  else if (kind === 'milestone') s.appendChild(svgEl('polygon', { points: '11,0 17,6 11,12 5,6', 'class': 'lg-fill-milestone' }));
  else if (kind === 'baseline') s.appendChild(svgEl('rect', { x: 1, y: 5, width: 20, height: 3, 'class': 'lg-fill-baseline' }));
  else if (kind === 'orig') s.appendChild(svgEl('rect', { x: 1, y: 3, width: 20, height: 6, rx: 2, 'class': 'lg-orig' }));
  else if (kind === 'delay') {
    s.appendChild(svgEl('rect', { x: 1, y: 3, width: 20, height: 7, rx: 2, 'class': 'lg-fill-minor' }));
    s.appendChild(svgEl('rect', { x: 12, y: 3, width: 9, height: 7, rx: 2, 'class': 'lg-fill-delay' }));
  }
  else if (kind === 'tentative') s.appendChild(svgEl('rect', { x: 1.5, y: 2.5, width: 19, height: 8, rx: 2, 'class': 'lg-tentative' }));
  else if (kind === 'today') s.appendChild(svgEl('line', { x1: 11, y1: 0, x2: 11, y2: 12, 'class': 'lg-today' }));
  else if (kind === 'weekend') s.appendChild(svgEl('rect', { x: 1, y: 1, width: 20, height: 10, 'class': 'lg-weekend' }));
  else if (kind === 'holiday') s.appendChild(svgEl('rect', { x: 1, y: 1, width: 20, height: 10, 'class': 'lg-holiday' }));
  return s;
}

function renderLegend() {
  var bar = document.getElementById('legend-bar');
  clearChildren(bar);
  var items = [['major', '大事業'], ['minor', '小事業'], ['orig', '当初計画（2段書きの上段）'], ['delay', '当初より延びた部分'],
    ['milestone', 'マイルストーン（◆。白抜きは当初の日付）'], ['tentative', '日程が目安（点線）'], ['today', '基準日']];
  if (state.ui.detailMode) items.splice(1, 0, ['hatch', '大事業（小事業に合わせて自動で広がった期間）']);
  if (state.ui.detailMode) items.push(['progress', '進捗済み（濃い部分）'], ['critical', 'クリティカルパス（赤枠）']);
  if (BUCKET_SCALES.indexOf(state.ui.scale) === -1) items.push(['weekend', '土日'], ['holiday', '祝日']);
  items.forEach(function (it) {
    bar.appendChild(el('span', { className: 'lg-item' }, [legendSwatch(it[0]), it[1]]));
  });
  bar.appendChild(el('span', { className: 'lg-note', text: '祝日は祝日法の規則で計算（2000〜2099年。将来の法改正は反映されません）' }));
}

function renderPrintHeader() {
  var header = document.getElementById('print-header');
  clearChildren(header);
  header.appendChild(el('h1', { text: state.project.name || '（無題プロジェクト）' }));
  var meta = '出力日: ' + todayStr() + ' ／ 基準日: ' + state.ui.referenceDate;
  if (state.project.period) meta += ' ／ 期間: ' + state.project.period.start + ' 〜 ' + state.project.period.end;
  if (state.project.baselineSavedAt) meta += ' ／ 当初計画の確定: ' + formatLocalDateTime(state.project.baselineSavedAt);
  if (isFilterActive()) meta += ' ／ 絞り込み: ' + filterDescription();
  header.appendChild(el('div', { className: 'meta', text: meta }));
}

function filterDescription() {
  var parts = [];
  if (state.ui.filterOwner) parts.push('担当者＝' + (state.ui.filterOwner === '__none__' ? '（未設定）' : state.ui.filterOwner));
  if (state.ui.filterStatus) {
    var sel = document.getElementById('filter-status');
    var opt = sel ? sel.querySelector('option[value="' + state.ui.filterStatus + '"]') : null;
    parts.push('状態＝' + (opt ? opt.textContent : state.ui.filterStatus));
  }
  return parts.join('、');
}

function renderBanners() {
  var area = document.getElementById('banner-area');
  clearChildren(area);
  if (recoveryInfo) {
    area.appendChild(el('div', { className: 'banner error', role: 'alert' }, [
      '⚠ 前回の自動保存データを読み込めませんでした（' + recoveryInfo.reason + '）。上書きされないよう退避してあります。',
      el('button', { type: 'button', text: '退避データをファイルに保存', onclick: exportRecoveryData }),
      el('button', { type: 'button', text: '退避データを削除', onclick: discardRecoveryData })
    ]));
  }
  if (lastCycleInfo) {
    area.appendChild(el('div', { className: 'banner error' }, [
      '⚠ 先行タスクの指定が循環しています（' + lastCycleInfo.message + '）。解消するまで日程の自動調整とクリティカルパスの計算を止めています。',
      el('button', { type: 'button', text: '循環しているタスクを開く', onclick: function () { openEditForm(lastCycleInfo.path[0]); } })
    ]));
  }
  var anyBase = state.project.tasks.some(function (t) { return t.baselineStart && t.baselineEnd; });
  if (state.project.tasks.length > 0 && !anyBase && !state.ui.baselineHintClosed) {
    area.appendChild(el('div', { className: 'banner info', role: 'status' }, [
      '当初計画はまだ確定していません。日程が固まったら「当初計画を確定」を押すと、以後の変更が当初計画との2段書きで表示されます。',
      el('button', { type: 'button', text: '当初計画を確定', onclick: actionSaveBaseline }),
      el('button', { type: 'button', text: '閉じる', onclick: function () { state.ui.baselineHintClosed = true; renderAll(); } })
    ]));
  }
  if (isFilterActive()) {
    var shownMinors = currentRows.filter(function (r) { return r.type === 'minor'; }).length;
    area.appendChild(el('div', { className: 'banner info', role: 'status' }, [
      '絞り込み中: ' + filterDescription() + '（小事業 ' + shownMinors + ' 件を表示）',
      el('button', { type: 'button', text: '絞り込みを解除', onclick: clearFilters })
    ]));
  }
}

/* ツールバーの保存状態の表示だけを更新する（自動保存の成否からも呼ぶ） */
function renderSaveState() {
  var ss = document.getElementById('save-state');
  var kind = saveStateKind(saveInfo.dirty, !hasContent());
  if (kind === 'none') { ss.textContent = ''; ss.className = 'save-state'; ss.title = ''; }
  else if (kind === 'dirty') { ss.textContent = '● 未保存の変更あり'; ss.className = 'save-state dirty'; ss.title = '「保存(.json)」でファイルに保存してください'; }
  else { ss.textContent = '✓ 保存済み' + (saveInfo.savedAt ? '（' + formatLocalDateTime(saveInfo.savedAt).slice(11) + '）' : ''); ss.className = 'save-state clean'; ss.title = ''; }
  if (autosaveFailReason) {
    ss.textContent = '⚠ 自動保存できていません' + (saveInfo.dirty ? '・未保存の変更あり' : '');
    ss.className = 'save-state dirty';
    ss.title = autosaveFailureMessage(autosaveFailReason).title;
  }
  if (autosaveConflict) {
    ss.textContent = '⚠ 自動保存を停止中（別のタブで控えを' + (autosaveConflict === 'cleared' ? '消去' : '更新') + '）' + (saveInfo.dirty ? '・未保存の変更あり' : '');
    ss.className = 'save-state dirty';
    ss.title = 'このタブの内容はブラウザに自動保存されません。「保存(.json)」でファイルに保存するか、画面上部の知らせから最新の控えを読み込んでください。';
  }
}

function renderToolbarState() {
  document.getElementById('btn-undo').disabled = undoHistory.past.length === 0;
  document.getElementById('btn-redo').disabled = undoHistory.future.length === 0;
  document.getElementById('btn-undo').title = undoHistory.past.length ? '元に戻す: ' + undoHistory.past[undoHistory.past.length - 1].label + ' (Ctrl+Z)' : '元に戻す (Ctrl+Z)';
  document.getElementById('btn-redo').title = undoHistory.future.length ? 'やり直す: ' + undoHistory.future[undoHistory.future.length - 1].label + ' (Ctrl+Y)' : 'やり直す (Ctrl+Y)';
  var nameInput = document.getElementById('project-name-input');
  if (document.activeElement !== nameInput) nameInput.value = state.project.name || '';
  renderSaveState();
  document.getElementById('scale-select').value = state.ui.scale;
  document.getElementById('detail-mode').checked = !!state.ui.detailMode;
  // シンプル表示では、進捗に基づく「状態」の絞り込みと担当者別の負荷を隠す
  ['filter-status', 'btn-workload'].forEach(function (fid) { document.getElementById(fid).hidden = !state.ui.detailMode; });
  document.querySelector('label[for="filter-status"]').hidden = !state.ui.detailMode;
  var pbtn = document.getElementById('btn-period');
  pbtn.textContent = state.project.period ? '期間 ' + shortDate(state.project.period.start) + '〜' + shortDate(state.project.period.end) : '期間';
  var refInput = document.getElementById('reference-date-input');
  if (document.activeElement !== refInput) refInput.value = state.ui.referenceDate;
  renderOwnerFilterOptions();
  document.getElementById('filter-status').value = state.ui.filterStatus;
  document.title = (state.project.name ? state.project.name + ' - ' : '') + APP_DISPLAY_NAME;
}

function collectOwnerList() {
  var set = new Set();
  for (var i = 0; i < state.project.tasks.length; i++) if (state.project.tasks[i].owner) set.add(state.project.tasks[i].owner);
  return Array.from(set).sort(function (a, b) { return a.localeCompare(b, 'ja'); });
}

function renderOwnerFilterOptions() {
  var sel = document.getElementById('filter-owner');
  var owners = collectOwnerList();
  var hasUnassigned = state.project.tasks.some(function (t) { return !t.owner; });
  var key = owners.join('\u0000') + (hasUnassigned ? '\u0000__none__' : '');
  if (sel.getAttribute('data-key') !== key) {
    clearChildren(sel);
    sel.appendChild(el('option', { value: '', text: 'すべて' }));
    owners.forEach(function (o) { sel.appendChild(el('option', { value: o, text: o })); });
    if (hasUnassigned) sel.appendChild(el('option', { value: '__none__', text: '（未設定）' }));
    sel.setAttribute('data-key', key);
  }
  if (state.ui.filterOwner && (state.ui.filterOwner === '__none__' ? !hasUnassigned : owners.indexOf(state.ui.filterOwner) === -1)) state.ui.filterOwner = '';
  sel.value = state.ui.filterOwner;
}

function renderAll() {
  var refocus = focusedRowId();
  rebuildTaskIndex();
  renderToolbarState();
  renderLegend();
  renderTable();
  renderGantt();
  renderBanners();
  renderPrintHeader();
  syncScrollExtents();
  if (refocus) setRovingFocus(refocus, true);
}

/* =========================================================================
 * 13. スクロール同期・高さ揃え（B7）・スプリッタ（D10）
 * ========================================================================= */
var scrollSyncing = false;
function wireScrollSync() {
  var tp = document.getElementById('table-panel'), gp = document.getElementById('gantt-panel');
  tp.addEventListener('scroll', function () {
    if (scrollSyncing) return;
    scrollSyncing = true; gp.scrollTop = tp.scrollTop; scrollSyncing = false;
  });
  gp.addEventListener('scroll', function () {
    if (scrollSyncing) return;
    scrollSyncing = true; tp.scrollTop = gp.scrollTop; scrollSyncing = false;
  });
  window.addEventListener('resize', syncScrollExtents);
}

/* 表とガントの縦スクロール量の上限を揃える（横スクロールバーの有無で最下部の行がずれていた） */
function syncScrollExtents() {
  var tp = document.getElementById('table-panel'), gp = document.getElementById('gantt-panel');
  var ts = document.getElementById('table-spacer'), gs = document.getElementById('gantt-spacer');
  ts.style.height = '0px'; gs.style.height = '0px';
  var tMax = tp.scrollHeight - tp.clientHeight, gMax = gp.scrollHeight - gp.clientHeight;
  if (tMax < gMax) ts.style.height = (gMax - tMax) + 'px';
  else if (gMax < tMax) gs.style.height = (tMax - gMax) + 'px';
  gp.scrollTop = tp.scrollTop;
}

function wireSplitter() {
  var sp = document.getElementById('splitter'), tp = document.getElementById('table-panel');
  function setWidth(w, persist) {
    var max = Math.max(320, window.innerWidth - 280);
    w = Math.round(clamp(w, 320, max));
    tp.style.width = w + 'px';
    sp.setAttribute('aria-valuenow', String(w));
    if (persist) { try { localStorage.setItem(STORAGE_KEY_TABLE_W, String(w)); } catch (e) { /* 表示設定のみ。保存できなくても支障なし */ } }
    syncScrollExtents();
  }
  try {
    var saved = Number(localStorage.getItem(STORAGE_KEY_TABLE_W));
    if (saved > 0) setWidth(saved, false);
  } catch (e) { /* 表示設定のみ */ }
  sp.setAttribute('aria-valuemin', '320');
  sp.addEventListener('pointerdown', function (ev) {
    ev.preventDefault();
    try { sp.setPointerCapture(ev.pointerId); } catch (e) { /* 既に離されたポインタ等。捕捉できなくてもドラッグは続行できる */ }
    sp.classList.add('dragging');
    var startX = ev.clientX, startW = tp.getBoundingClientRect().width;
    function move(e) { setWidth(startW + (e.clientX - startX), false); }
    function up(e) {
      try { sp.releasePointerCapture(ev.pointerId); } catch (err) { /* 捕捉していない場合 */ }
      sp.classList.remove('dragging');
      sp.removeEventListener('pointermove', move);
      sp.removeEventListener('pointerup', up);
      setWidth(startW + (e.clientX - startX), true);
    }
    sp.addEventListener('pointermove', move);
    sp.addEventListener('pointerup', up);
  });
  sp.addEventListener('keydown', function (ev) {
    var w = tp.getBoundingClientRect().width;
    if (ev.key === 'ArrowLeft') { ev.preventDefault(); setWidth(w - 24, true); }
    else if (ev.key === 'ArrowRight') { ev.preventDefault(); setWidth(w + 24, true); }
  });
  sp.addEventListener('dblclick', function () {
    tp.style.width = '';
    try { localStorage.removeItem(STORAGE_KEY_TABLE_W); } catch (e) { /* 表示設定のみ */ }
    syncScrollExtents();
  });
}

/* =========================================================================
 * 14. ガントバーのドラッグ: 小事業は移動・端で期間変更、マイルストーンは移動、大事業は配下ごと移動
 * クリック（ほぼ動かさずに離す）は編集フォームを開く。Esc でドラッグを取り消す。
 * ========================================================================= */
var dragState = null;
var EDGE_PX = 6;

function wireGanttPointer(svg) {
  svg.addEventListener('pointerdown', function (ev) { if (ev.button === 0) onGanttPointerDown(svg, ev); });
  svg.addEventListener('pointermove', function (ev) {
    if (dragState && dragState.pointerId === ev.pointerId) onDragMove(ev); else if (!dragState) updateHoverCursor(svg, ev);
  });
  svg.addEventListener('pointerup', function (ev) { onGanttPointerUp(svg, ev); });
  svg.addEventListener('pointercancel', function () { cancelDrag(); });
  // 捕捉を失ったとき（ウィンドウ外での解放など）は取り消す。通常の終了では先に dragState が消えているので何もしない
  svg.addEventListener('lostpointercapture', function (ev) { if (dragState && dragState.pointerId === ev.pointerId) cancelDrag(); });
}

function barMainRect(g) {
  return g.querySelector('.gantt-bar-minor') || g.querySelector('.gantt-bar-major') || g.querySelector('.gantt-bar-major-ext') || g.querySelector('.gantt-milestone');
}

function edgeModeAt(g, clientX) {
  if (g.getAttribute('data-kind') !== 'minor') return 'move';
  var rect = barMainRect(g).getBoundingClientRect();
  if (rect.width < 18) return 'move';
  if (clientX - rect.left <= EDGE_PX) return 'resize-start';
  if (rect.right - clientX <= EDGE_PX) return 'resize-end';
  return 'move';
}

function isBarShape(target) {
  var c = target.getAttribute && target.getAttribute('class');
  return !!c && /gantt-bar-minor|gantt-bar-major|gantt-milestone/.test(c);
}

function updateHoverCursor(svg, ev) {
  var g = ev.target.closest ? ev.target.closest('.gantt-bar-g') : null;
  var resize = !!(g && isBarShape(ev.target) && edgeModeAt(g, ev.clientX) !== 'move');
  svg.classList.toggle('resize-cursor', resize);
}

function onGanttPointerDown(svg, ev) {
  closeMenu();
  var box = svg.getBoundingClientRect();
  var y = ev.clientY - box.top;
  var hit = null, g = ev.target.closest ? ev.target.closest('.gantt-bar-g') : null;
  if (g && isBarShape(ev.target)) {
    var task = getTaskById(g.getAttribute('data-id'));
    if (task) hit = { task: task, g: g, kind: g.getAttribute('data-kind'), mode: edgeModeAt(g, ev.clientX) };
  }
  var rowIdx = Math.floor(y / ROW_H);
  dragState = { svg: svg, startX: ev.clientX, startY: ev.clientY, rowIdx: rowIdx, hit: hit, moved: false, days: 0, pointerId: ev.pointerId, create: null };
  // v1.5: バー以外の所を横にドラッグすると、その期間の作業を作る（タッチはスクロールを優先し、作成しない）
  var gx = ev.clientX - box.left;
  // 日付のマスの上だけ（右端のラベル用の余白は日付にしない）
  if (!hit && ev.pointerType !== 'touch' && gx >= 0 && gx < ganttGeom.gridW && createTargetFor(rowIdx)) dragState.create = { x0: gx };
  if (hit || dragState.create) { try { svg.setPointerCapture(ev.pointerId); } catch (e) { /* 捕捉できなくてもドラッグは続行できる */ } ev.preventDefault(); }
}

/* ドラッグで作る作業の追加先（v1.5）。大事業の行→その大事業の末尾、小事業の行→同じ大事業でその行の直後、
   最下段（追加用の行）→最後の大事業の末尾。追加先が無ければ null */
function createTargetFor(rowIdx) {
  if (!ganttGeom) return null;
  return createTargetForRow(ganttGeom.rows, rowIdx, ganttGeom.addRowIdx, lastMajorId());
}

/* 純粋関数版（テスト用）。rows: 表示中の行 / addRowIdx: 追加用の行の位置 / lastMajor: 最後の大事業のid */
function createTargetForRow(rows, rowIdx, addRowIdx, lastMajor) {
  if (rowIdx < 0) return null;
  if (rowIdx === addRowIdx) return lastMajor ? { parentId: lastMajor, afterId: null } : null;
  var row = rows[rowIdx];
  if (!row) return null;
  if (row.type === 'major') return { parentId: row.task.id, afterId: null };
  return { parentId: row.task.parentId, afterId: row.task.id };
}

/* ガント上の x 座標（SVG内）を日付にする。表示範囲の外は端に寄せる */
function dateAtX(x) {
  var days = Math.floor(x / ganttGeom.pxPerDay);
  var last = dayDiff(ganttGeom.range.end, ganttGeom.range.start);
  return dayAdd(ganttGeom.range.start, clamp(days, 0, last));
}

/* ドラッグした範囲の日程。旬・半月・月・年度はマスの境目に合わせる（始点を含むマスの初日〜終点を含むマスの末日） */
function createdDates(x0, x1) {
  return snapCreatedRange(dateAtX(Math.min(x0, x1)), dateAtX(Math.max(x0, x1)), ganttGeom.scale, ganttGeom.range);
}

/* 純粋関数版（テスト用）。a<=b の日付を、旬・半月・月・年度ならマスの初日〜末日へ広げる。許容範囲に収める */
function snapCreatedRange(a, b, scale, range) {
  if (BUCKET_SCALES.indexOf(scale) !== -1) {
    var buckets = buildDateBuckets(range.start, range.end, scale);
    var ia = findBucketIndexContaining(buckets, a), ib = findBucketIndexContaining(buckets, b);
    if (ia >= 0) a = buckets[ia].start;
    if (ib >= 0) b = buckets[ib].end;
  }
  return { start: clampDate(a), end: clampDate(b) };
}

function onCreateMove(ev) {
  var ds = dragState, svg = ds.svg, x = ev.clientX - svg.getBoundingClientRect().left;
  var nd = createdDates(ds.create.x0, x);
  var rect = ds.create.preview;
  if (!rect) {
    rect = ds.create.preview = svgEl('rect', { height: ROW_H - 8, rx: 3, 'class': 'gantt-create-preview' });
    svg.appendChild(rect);
    svg.classList.add('creating');
  }
  var x1 = xOf(nd.start), x2 = xOf(nd.end) + ganttGeom.pxPerDay;
  rect.setAttribute('x', x1); rect.setAttribute('width', Math.max(2, x2 - x1)); rect.setAttribute('y', ds.rowIdx * ROW_H + 4);
  ds.create.dates = nd;
  var tip = document.getElementById('drag-tip');
  tip.textContent = '新しい作業: ' + nd.start + ' 〜 ' + nd.end + '（' + inclusiveDays(nd.start, nd.end) + '日）';
  tip.style.left = (ev.clientX + 14) + 'px';
  tip.style.top = (ev.clientY + 14) + 'px';
  tip.hidden = false;
}

/* ドラッグ後の新しい日程（許容範囲に収める）。変化が無ければ null */
function draggedDates(ds) {
  var t = ds.hit.task, d = derived.get(t.id) || {}, days = ds.days;
  if (ds.hit.kind === 'major') {
    var r = rangeOf(t, d);
    if (!r.start || !r.end) return null;
    days = clamp(days, dayDiff(DATE_MIN, r.start), dayDiff(DATE_MAX, r.end));
    return days === 0 ? null : { start: dayAdd(r.start, days), end: dayAdd(r.end, days), days: days };
  }
  if (!t.plannedStart || !t.plannedEnd) return null;
  var s = t.plannedStart, e = t.plannedEnd;
  if (ds.hit.mode === 'resize-start') s = clampDate(dayAdd(s, days) > e ? e : dayAdd(s, days));
  else if (ds.hit.mode === 'resize-end') e = clampDate(dayAdd(e, days) < s ? s : dayAdd(e, days));
  else {
    days = clamp(days, dayDiff(DATE_MIN, s), dayDiff(DATE_MAX, e));
    s = dayAdd(s, days); e = dayAdd(e, days);
  }
  return (s === t.plannedStart && e === t.plannedEnd) ? null : { start: s, end: e, days: days };
}

function onDragMove(ev) {
  var ds = dragState;
  var dx = ev.clientX - ds.startX;
  var dy = ev.clientY - ds.startY;
  if (!ds.moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
  if (!ds.moved && ds.create && Math.abs(dy) >= Math.abs(dx)) ds.create = null; // 縦に動かしたときは作らない（クリック扱いにもしない）
  ds.moved = true;
  if (ds.create) { onCreateMove(ev); return; }
  if (!ds.hit) return;
  ds.days = Math.round(dx / ganttGeom.pxPerDay);
  var g = ds.hit.g;
  g.classList.add('dragging');
  var nd = draggedDates(ds);
  var tip = document.getElementById('drag-tip');
  if (ds.hit.mode === 'move') {
    g.setAttribute('transform', 'translate(' + ((nd ? nd.days : 0) * ganttGeom.pxPerDay) + ',0)');
  } else {
    var main = barMainRect(g), prog = g.querySelector('.gantt-bar-progress');
    var t = ds.hit.task, s = nd ? nd.start : t.plannedStart, e = nd ? nd.end : t.plannedEnd;
    var x1 = xOf(s), w = xOf(e) + ganttGeom.pxPerDay - x1;
    main.setAttribute('x', x1); main.setAttribute('width', w);
    if (prog) { prog.setAttribute('x', x1); prog.setAttribute('width', w * (t.progress / 100)); }
  }
  var shown = nd || { start: rangeOf(ds.hit.task, derived.get(ds.hit.task.id) || {}).start, end: rangeOf(ds.hit.task, derived.get(ds.hit.task.id) || {}).end };
  tip.textContent = shown.start && shown.end ? shown.start + ' 〜 ' + shown.end + '（' + inclusiveDays(shown.start, shown.end) + '日）' : '';
  tip.style.left = (ev.clientX + 14) + 'px';
  tip.style.top = (ev.clientY + 14) + 'px';
  tip.hidden = !tip.textContent;
}

function onGanttPointerUp(svg, ev) {
  var ds = dragState;
  if (ds && ds.pointerId !== ev.pointerId) return;
  dragState = null;
  document.getElementById('drag-tip').hidden = true;
  if (!ds) return;
  try { if ((ds.hit || ds.create) && svg.hasPointerCapture && svg.hasPointerCapture(ds.pointerId)) svg.releasePointerCapture(ds.pointerId); } catch (e) { /* 捕捉していない場合 */ }
  if (!ds.moved) {
    var row = ganttGeom.rows[ds.rowIdx];
    if (row) { state.ui.focusTaskId = row.task.id; openEditForm(row.task.id); }
    return;
  }
  if (ds.create) {
    var target = createTargetFor(ds.rowIdx), dates = createdDates(ds.create.x0, ev.clientX - svg.getBoundingClientRect().left);
    renderGantt(); // プレビューを消す
    if (target && dates) openAddMinorForm(target.parentId, { dates: dates, afterId: target.afterId });
    return;
  }
  var nd = ds.hit ? draggedDates(ds) : null;
  if (!nd) { renderGantt(); return; }
  commitDrag(ds.hit, nd);
}

function cancelDrag() {
  if (!dragState) return;
  var ds = dragState;
  dragState = null;
  try { if (ds.svg && ds.svg.hasPointerCapture && ds.svg.hasPointerCapture(ds.pointerId)) ds.svg.releasePointerCapture(ds.pointerId); } catch (e) { /* 捕捉していない場合 */ }
  document.getElementById('drag-tip').hidden = true;
  renderGantt();
}

function commitDrag(hit, nd) {
  var id = hit.task.id;
  if (hit.kind === 'major') {
    applyMutation('大事業の移動（配下ごと）', function (p) {
      var major = findTask(p, id);
      if (major.plannedStart) major.plannedStart = dayAdd(major.plannedStart, nd.days);
      if (major.plannedEnd) major.plannedEnd = dayAdd(major.plannedEnd, nd.days);
      p.tasks.forEach(function (c) {
        if (c.level !== 'minor' || c.parentId !== id) return;
        if (c.plannedStart) c.plannedStart = clampDate(dayAdd(c.plannedStart, nd.days));
        if (c.plannedEnd) c.plannedEnd = clampDate(dayAdd(c.plannedEnd, nd.days));
      });
    });
  } else {
    applyMutation(hit.mode === 'move' ? '日程の移動' : '期間の変更', function (p) {
      var t = findTask(p, id);
      t.plannedStart = nd.start;
      t.plannedEnd = t.isMilestone ? nd.start : nd.end;
    });
  }
}

function findTask(project, id) {
  for (var i = 0; i < project.tasks.length; i++) if (project.tasks[i].id === id) return project.tasks[i];
  return null;
}

/* =========================================================================
 * 15. 行の操作（キーボード・メニュー・展開・複製・並べ替え・削除・進捗）
 * ========================================================================= */
function onRowKeyDown(ev, row) {
  if (ev.target !== ev.currentTarget) return;
  var id = row.task.id, rows = currentRows, i = -1;
  for (var k = 0; k < rows.length; k++) if (rows[k].task.id === id) { i = k; break; }
  var isMajor = row.type === 'major', mod = ev.ctrlKey || ev.metaKey;
  var handled = true;
  if (ev.key === 'ArrowDown' && ev.altKey) moveTask(id, 1);
  else if (ev.key === 'ArrowUp' && ev.altKey) moveTask(id, -1);
  else if (ev.key === 'ArrowDown') { if (rows[i + 1]) setRovingFocus(rows[i + 1].task.id, true); }
  else if (ev.key === 'ArrowUp') { if (rows[i - 1]) setRovingFocus(rows[i - 1].task.id, true); }
  else if (ev.key === 'Home') setRovingFocus(rows[0].task.id, true);
  else if (ev.key === 'End') setRovingFocus(rows[rows.length - 1].task.id, true);
  else if (ev.key === 'ArrowRight' && isMajor) toggleMajor(id, true);
  else if (ev.key === 'ArrowLeft' && isMajor) toggleMajor(id, false);
  else if (ev.key === 'ArrowLeft' && !isMajor) setRovingFocus(row.task.parentId, true);
  else if (ev.key === ' ' && isMajor) toggleMajor(id);
  else if (ev.key === ' ' && !isMajor) {
    var pbtn = ev.currentTarget.querySelector('.progress-btn');
    if (pbtn) openProgressMenu(pbtn, id); else openEditForm(id); // シンプル表示では進捗の列が無いので編集を開く
  }
  else if (ev.key === 'Enter') openEditForm(id);
  else if (ev.key === 'Delete') confirmDelete(id);
  else if (mod && (ev.key === 'd' || ev.key === 'D')) duplicateTask(id);
  else if (ev.key === 'Insert' || ev.key === '+') openAddMinorForm(isMajor ? id : row.task.parentId);
  else handled = false;
  if (handled) ev.preventDefault();
}

function toggleMajor(id, force) {
  if (isFilterActive()) return;
  var has = state.ui.expandedMajors.has(id);
  var want = force == null ? !has : force;
  if (want === has) return;
  if (want) state.ui.expandedMajors.add(id); else state.ui.expandedMajors.delete(id);
  renderAll();
  scheduleLocalSave();
}

function setAllExpanded(expand) {
  state.ui.expandedMajors = new Set(expand ? getMajors().map(function (m) { return m.id; }) : []);
  renderAll();
  scheduleLocalSave();
}

function siblingsIn(project, task) {
  return project.tasks.filter(function (t) {
    return task.level === 'major' ? t.level === 'major' : (t.level === 'minor' && t.parentId === task.parentId);
  });
}

function openRowMenu(anchor, id) {
  var t = getTaskById(id);
  if (!t) return;
  var sib = siblingsIn(state.project, t), idx = sib.indexOf(t), isMajor = t.level === 'major';
  var items = [];
  if (isMajor) items.push({ label: '＋ 小事業を追加', action: function () { openAddMinorForm(id); } });
  items.push({ label: '編集…', action: function () { openEditForm(id); } });
  items.push({ label: isMajor ? '複製（配下の小事業ごと）' : '複製', action: function () { duplicateTask(id); } });
  items.push({ label: '上へ移動', disabled: idx <= 0, action: function () { moveTask(id, -1); } });
  items.push({ label: '下へ移動', disabled: idx >= sib.length - 1, action: function () { moveTask(id, 1); } });
  items.push('-');
  items.push({ label: isMajor ? '削除（配下の小事業ごと）…' : '削除…', danger: true, action: function () { confirmDelete(id); } });
  openMenu(anchor, items);
}

function openProgressMenu(anchor, id) {
  var t = getTaskById(id);
  if (!t || !anchor) return;
  openMenu(anchor, progressOptionsFor(t.progress).map(function (po) {
    return { label: po.label, current: po.selected, action: function () { setProgress(id, po.value); } };
  }));
}

/* 進捗の選択肢。6値以外の現在値（子を削除した大事業に残った集計値など）は「36%（現在値）」として加え、
   選ばれた状態にする。6値だけだと先頭の0%が選ばれ、名前だけ直して保存しても進捗が0%に書き換わっていた */
function progressOptionsFor(current) {
  // 0〜100の整数以外（null・NaN・範囲外・小数・文字列）は0として扱う。読込み検査で弾かれる値だが、ここでも防ぐ
  if (typeof current !== 'number' || !Number.isInteger(current) || current < 0 || current > 100) current = 0;
  var values = VALID_PROGRESS.slice();
  var extra = values.indexOf(current) === -1;
  if (extra) values.push(current);
  values.sort(function (a, b) { return a - b; });
  return values.map(function (v) {
    return { value: v, label: v + '%' + (extra && v === current ? '（現在値）' : ''), selected: v === current };
  });
}

function setProgress(id, v) {
  applyMutation('進捗の変更', function (p) {
    var t = findTask(p, id);
    if (!t || t.progress === v) return false;
    t.progress = v;
  });
}

function duplicateTask(id) {
  var src = getTaskById(id);
  if (!src) return;
  var add = src.level === 'major' ? 1 + getChildrenOf(id).length : 1;
  if (state.project.tasks.length + add > MAX_TASKS) { showToast('タスク数の上限（' + MAX_TASKS + '件）を超えるため複製できません。', 'error'); return; }
  var newId = generateId();
  function copyName(n) { var s = n + '（コピー）'; return s.length > MAX_NAME_LEN ? n.slice(0, MAX_NAME_LEN - 5) + '（コピー）' : s; }
  applyMutation(src.level === 'major' ? '大事業の複製' : '小事業の複製', function (p) {
    var s = findTask(p, id), at = p.tasks.indexOf(s);
    var clone = JSON.parse(JSON.stringify(s));
    clone.id = newId;
    clone.name = copyName(s.name);
    clone.baselineStart = null; clone.baselineEnd = null;
    if (s.level === 'minor') {
      clone.progress = 0;
      p.tasks.splice(at + 1, 0, clone);
      return;
    }
    // 大事業: 配下の小事業も複製し、配下どうしの先行関係は新しいidへ付け替える
    var kids = p.tasks.filter(function (t) { return t.level === 'minor' && t.parentId === id; });
    var remap = new Map(kids.map(function (k) { return [k.id, generateId()]; }));
    var newKids = kids.map(function (k) {
      var c = JSON.parse(JSON.stringify(k));
      c.id = remap.get(k.id); c.parentId = newId; c.progress = 0; c.baselineStart = null; c.baselineEnd = null;
      c.predecessors = k.predecessors.map(function (pid) { return remap.get(pid) || pid; });
      return c;
    });
    clone.progress = 0;
    p.tasks.splice.apply(p.tasks, [at + 1, 0, clone].concat(newKids));
  }, { expand: [src.level === 'major' ? newId : src.parentId] });
  state.ui.focusTaskId = newId;
  renderAll();
  setRovingFocus(newId, true);
  showToast('複製しました。元に戻すには Ctrl+Z を押します。', 'success', 3000);
}

function moveTask(id, dir) {
  applyMutation(dir < 0 ? '上へ移動' : '下へ移動', function (p) {
    var t = findTask(p, id), sib = siblingsIn(p, t), i = sib.indexOf(t), j = i + dir;
    if (j < 0 || j >= sib.length) return false;
    var a = p.tasks.indexOf(t), b = p.tasks.indexOf(sib[j]);
    p.tasks[a] = sib[j]; p.tasks[b] = t;
  });
  setRovingFocus(id, true);
}

function confirmDelete(id) {
  var t = getTaskById(id);
  if (!t) return;
  var kids = t.level === 'major' ? getChildrenOf(id).length : 0;
  confirmDialog({
    title: '削除の確認',
    message: '『' + truncateText(t.name, 40) + '』を削除します。' + (kids > 0 ? '配下の小事業 ' + kids + ' 件もすべて削除されます。' : '') +
      '\n削除した直後なら「元に戻す」（Ctrl+Z）で取り消せます。',
    okLabel: '削除する', danger: true
  }).then(function (ok) { if (ok) deleteTask(id); });
}

function deleteTask(id) {
  var t = getTaskById(id);
  if (!t) return;
  applyMutation(t.level === 'major' ? '大事業の削除' : '小事業の削除', function (p) {
    var remove = new Set([id]);
    if (t.level === 'major') p.tasks.forEach(function (x) { if (x.parentId === id) remove.add(x.id); });
    p.tasks = p.tasks.filter(function (x) { return !remove.has(x.id); });
    p.tasks.forEach(function (x) { x.predecessors = x.predecessors.filter(function (pid) { return !remove.has(pid); }); });
  });
  showToast('削除しました。元に戻すには Ctrl+Z を押します。', 'info', 4000);
}

/* 確認ダイアログ（window.confirm の代わり。キーボード操作・読み上げに対応） */
function confirmDialog(o) {
  return new Promise(function (resolve) {
    var decided = false;
    openDialog({
      title: o.title,
      onClose: function () { if (!decided) resolve(false); },
      build: function (dialog, ctx) {
        o.message.split('\n').forEach(function (line) { dialog.appendChild(el('p', { text: line })); });
        var ok = el('button', { type: 'button', className: o.danger ? BTN_DANGER : BTN_PRIMARY, text: o.okLabel || 'OK',
          onclick: function () { decided = true; ctx.close(); resolve(true); } });
        dialog.appendChild(el('div', { className: 'form-actions' }, [el('div', { className: 'left' }),
          el('div', { className: 'right' }, [el('button', { type: 'button', className: BTN_SECONDARY, text: 'キャンセル', onclick: ctx.close }), ok])]));
      }
    });
  });
}

/* =========================================================================
 * 16. 入力フォーム（大事業／小事業。追加・編集共用）— M1 / C2 / C7 / C9 / D1 / D2 / B2 / B3
 * ========================================================================= */
var chainPrevDefault = false;

function openAddMajorForm() { openTaskForm('addMajor', null, null); }
/* opts.dates: ガントのドラッグで決めた日程 {start,end} / opts.afterId: この小事業の直後に入れる（v1.5） */
function openAddMinorForm(parentId, opts) {
  var majors = getMajors();
  if (majors.length === 0) { showToast('先に大事業を追加してください。', 'warning'); return; }
  openTaskForm('addMinor', null, parentId || majors[majors.length - 1].id, opts);
}
function openEditForm(taskId) {
  var t = getTaskById(taskId);
  if (t) openTaskForm('edit', taskId, t.parentId);
}

/* D1: 小事業の既定日程＝「同じ大事業で最も遅く終わる小事業の翌日」と「基準日」の遅い方から5日間 */
function defaultMinorDates(parentId) {
  var start = state.ui.referenceDate, sibs = getChildrenOf(parentId), latest = null;
  sibs.forEach(function (s) { if (s.plannedEnd && (!latest || s.plannedEnd > latest)) latest = s.plannedEnd; });
  if (latest) { var next = dayAdd(latest, 1); if (next > start) start = next; }
  else {
    var parent = getTaskById(parentId);
    if (parent && parent.plannedStart && parent.plannedStart > start) start = parent.plannedStart;
  }
  start = clampDate(start);
  return { start: start, end: clampDate(dayAdd(start, 4)) };
}

function lastSiblingOf(parentId) {
  var sibs = getChildrenOf(parentId);
  return sibs.length ? sibs[sibs.length - 1] : null;
}

function formRow(labelText, input, hint) {
  var id = input.id;
  return el('div', { className: 'form-row' }, [el('label', { 'for': id, text: labelText }), input, hint ? el('div', { className: 'hint', text: hint }) : null]);
}

function openTaskForm(mode, taskId, parentId, opts) {
  opts = opts || {};
  closeMenu();
  var task = mode === 'edit' ? getTaskById(taskId) : null;
  var isMajor = mode === 'addMajor' || (task && task.level === 'major');
  var d = task ? (derived.get(task.id) || {}) : {};
  var hasChildren = isMajor && task ? getChildrenOf(task.id).length > 0 : false;
  var defaults;
  if (mode === 'addMajor') defaults = { name: '', owner: '', plannedStart: null, plannedEnd: null, progress: 0, memo: '' };
  else if (mode === 'addMinor') {
    var dd = opts.dates || defaultMinorDates(parentId);
    defaults = { name: '', owner: (lastSiblingOf(parentId) || {}).owner || '', plannedStart: dd.start, plannedEnd: dd.end, progress: 0, isMilestone: false, predecessors: [], memo: '' };
  } else defaults = task;

  var title = (mode === 'edit' ? '編集: ' : '追加: ') + (isMajor ? '大事業' : '小事業') + (task ? '（' + (wbsNumbers.get(task.id) || '') + '）' : '');
  openDialog({
    title: title,
    initialFocus: function () { return document.getElementById('f-name'); },
    build: function (dialog, ctx) {
      var form = el('form', { novalidate: true });
      var nameInput = el('input', { type: 'text', id: 'f-name', maxlength: MAX_NAME_LEN, value: defaults.name || '', autocomplete: 'off', required: true });
      form.appendChild(formRow('事業名（必須）', nameInput));

      var parentSelect = null;
      if (!isMajor) {
        parentSelect = el('select', { id: 'f-parent' });
        getMajors().forEach(function (m) {
          var opt = el('option', { value: m.id, text: (wbsNumbers.get(m.id) || '') + ' ' + m.name });
          if (m.id === parentId) opt.selected = true;
          parentSelect.appendChild(opt);
        });
        form.appendChild(formRow('親の大事業（必須）', parentSelect));
      }

      var ownerInput = el('input', { type: 'text', id: 'f-owner', maxlength: MAX_OWNER_LEN, list: 'f-owner-list', value: defaults.owner || '', autocomplete: 'off' });
      var datalist = el('datalist', { id: 'f-owner-list' });
      collectOwnerList().forEach(function (o) { datalist.appendChild(el('option', { value: o })); });
      form.appendChild(formRow('担当者', ownerInput, '既に入力した担当者は候補から選べます'));
      form.appendChild(datalist);

      var startInput = el('input', { type: 'date', id: 'f-start', min: DATE_MIN, max: DATE_MAX, value: defaults.plannedStart || '' });
      var endInput = el('input', { type: 'date', id: 'f-end', min: DATE_MIN, max: DATE_MAX, value: defaults.plannedEnd || '' });
      form.appendChild(el('div', { className: 'form-row-2col' }, [
        formRow('開始日' + (isMajor ? '' : '（必須）'), startInput), formRow('終了日' + (isMajor ? '' : '（必須）'), endInput)]));
      var tentativeBox = el('input', { type: 'checkbox', id: 'f-tentative' });
      tentativeBox.checked = !!defaults.tentative;
      form.appendChild(el('div', { className: 'form-row checkbox-row' }, [tentativeBox,
        el('label', { 'for': 'f-tentative', text: '日程は目安（はっきり決まっていない）' })]));
      form.appendChild(el('div', { className: 'hint', text: 'ガントでは点線で描き、Excel・PDFでも目安と分かるように出力します。だいたいの時期で入れておき、決まったらチェックを外してください。' }));
      if (isMajor) {
        var extHint = (task && d.effectiveStart && (d.effectiveStart !== task.plannedStart || d.effectiveEnd !== task.plannedEnd))
          ? '　現在の実効期間: ' + d.effectiveStart + ' 〜 ' + d.effectiveEnd + '（小事業に合わせて自動で広がっています）' : '';
        form.appendChild(el('div', { className: 'hint', text: '開始日・終了日はセットで入力するか、両方空欄にしてください（空欄なら小事業の日程から自動算出）。小事業がはみ出すと、その分だけ自動で広がります。' + extHint }));
      }

      var msBox = null, progressSelect = null;
      // v1.4: 進捗・先行タスク・当初計画・メモは「詳しい設定」に畳む（詳細表示のときは開いた状態）
      var more = el('details', { className: 'form-more' });
      if (state.ui.detailMode) more.open = true;
      more.appendChild(el('summary', { text: '詳しい設定（' + (isMajor ? '進捗・当初計画・メモ' : '進捗・先行タスク・当初計画・メモ') + '）' }));
      if (!isMajor) {
        msBox = el('input', { type: 'checkbox', id: 'f-ms' });
        msBox.checked = !!defaults.isMilestone;
        var syncMs = function () {
          endInput.disabled = msBox.checked;
          if (msBox.checked) endInput.value = startInput.value;
        };
        msBox.addEventListener('change', syncMs);
        startInput.addEventListener('input', function () { if (msBox.checked) endInput.value = startInput.value; }); // C9
        syncMs();
        form.appendChild(el('div', { className: 'form-row checkbox-row' }, [msBox,
          el('label', { 'for': 'f-ms', text: 'マイルストーン（節目の1日。終了日＝開始日）' })]));
      }
      form.appendChild(more);
      if (!isMajor || !hasChildren) {
        progressSelect = el('select', { id: 'f-progress' });
        progressOptionsFor(defaults.progress || 0).forEach(function (po) {
          var o = el('option', { value: String(po.value), text: po.label });
          if (po.selected) o.selected = true;
          progressSelect.appendChild(o);
        });
        more.appendChild(formRow('進捗率', progressSelect, isMajor ? '小事業を追加すると、進捗は小事業から自動で計算されます。' : null));
      } else {
        more.appendChild(el('div', { className: 'form-row' }, [el('label', { text: '進捗率' }),
          el('div', { className: 'hint', text: (d.displayProgress == null ? '—' : d.displayProgress + '%') + '（小事業の進捗を期間の長さで加重平均した自動計算値）' })]));
      }

      var predChecks = [];
      if (!isMajor) more.appendChild(buildPredecessorPicker(task, defaults.predecessors || [], predChecks));

      var chainBox = null;
      if (mode === 'addMinor') {
        chainBox = el('input', { type: 'checkbox', id: 'f-chain' });
        // ドラッグで日程を決めたときは引き継がない（先行の指定で、決めた日程が自動で後ろへずれるのを防ぐ）
        chainBox.checked = opts.dates ? false : chainPrevDefault;
        more.appendChild(el('div', { className: 'form-row checkbox-row' }, [chainBox,
          el('label', { 'for': 'f-chain', text: '同じ大事業の最後の小事業を先行タスクにする（順番に並ぶ作業を続けて入力するとき）' })]));
      }

      var memoInput = el('textarea', { id: 'f-memo', maxlength: MAX_MEMO_LEN, rows: 3 });
      memoInput.value = defaults.memo || '';
      var baseStartInput = el('input', { type: 'date', id: 'f-base-start', min: DATE_MIN, max: DATE_MAX, value: (task && task.baselineStart) || '' });
      var baseEndInput = el('input', { type: 'date', id: 'f-base-end', min: DATE_MIN, max: DATE_MAX, value: (task && task.baselineEnd) || '' });
      more.appendChild(el('div', { className: 'form-row-2col' }, [formRow('当初計画の開始日', baseStartInput), formRow('当初計画の終了日', baseEndInput)]));
      if (msBox) { // マイルストーンは当初計画も1日（終了日＝開始日）
        var syncBase = function () { baseEndInput.disabled = msBox.checked; if (msBox.checked) baseEndInput.value = baseStartInput.value; };
        msBox.addEventListener('change', syncBase);
        baseStartInput.addEventListener('input', syncBase);
        syncBase();
      }
      more.appendChild(el('div', { className: 'hint', text: 'ふだんはツールバーの「当初計画を確定」でまとめて記録します。ここで個別に直すこともできます（両方空欄にすると当初計画を外します）。' }));
      more.appendChild(formRow('メモ', memoInput, 'Excelの「備考」列に出力されます（画面の一覧・PDFには出ません）'));

      var errorBox = el('div', { className: 'form-error', role: 'alert', 'aria-live': 'assertive' });
      form.appendChild(errorBox);

      var continueAfter = false;
      var left = el('div', { className: 'left' });
      if (mode === 'edit') left.appendChild(el('button', { type: 'button', className: BTN_SECONDARY + ' nc-button--danger-outline', text: '削除…',
        onclick: function () { ctx.close(); confirmDelete(task.id); } }));
      var right = el('div', { className: 'right' }, [el('button', { type: 'button', className: BTN_SECONDARY, text: 'キャンセル', onclick: ctx.close })]);
      if (mode !== 'edit') right.appendChild(el('button', { type: 'submit', className: BTN_SECONDARY, text: '保存して続けて追加', onclick: function () { continueAfter = true; } }));
      right.appendChild(el('button', { type: 'submit', className: BTN_PRIMARY, text: '保存', onclick: function () { continueAfter = false; } }));
      form.appendChild(el('div', { className: 'form-actions' }, [left, right]));

      // Enter は常に「保存」（送信ボタンが2つあると、HTMLの既定ではDOM上で先の「保存して続けて追加」が押されるため）
      form.addEventListener('keydown', function (ev) {
        var tg = ev.target;
        if (ev.key !== 'Enter' || ev.isComposing || tg.tagName === 'TEXTAREA' || tg.tagName === 'BUTTON' || tg.tagName === 'SUMMARY') return;
        if (tg.classList && tg.classList.contains('pred-filter')) return;
        ev.preventDefault();
        continueAfter = false;
        form.requestSubmit();
      });
      form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var data = {
          name: nameInput.value.trim(),
          owner: ownerInput.value.trim(),
          plannedStart: startInput.value || null,
          plannedEnd: (msBox && msBox.checked) ? (startInput.value || null) : (endInput.value || null),
          memo: memoInput.value,
          tentative: tentativeBox.checked,
          progress: progressSelect ? Number(progressSelect.value) : null,
          baselineStart: baseStartInput.value || null,
          baselineEnd: (msBox && msBox.checked) ? (baseStartInput.value || null) : (baseEndInput.value || null)
        };
        if (!isMajor) {
          data.parentId = parentSelect.value;
          data.isMilestone = msBox.checked;
          data.predecessors = predChecks.filter(function (c) { return c.checked; }).map(function (c) { return c.value; });
          if (chainBox && chainBox.checked) {
            var last = lastSiblingOf(data.parentId);
            if (last && data.predecessors.indexOf(last.id) === -1) data.predecessors.push(last.id);
          }
        }
        var err = validateFormData(data, isMajor, mode, task);
        if (err) { errorBox.textContent = err; return; }
        if (chainBox && !opts.dates) chainPrevDefault = chainBox.checked;
        if (opts.afterId && data.parentId === parentId) data.afterId = opts.afterId; // 親を変えたら末尾へ
        var newId = submitTaskForm(data, isMajor, mode, task);
        ctx.close();
        if (mode !== 'edit' && newId && isFilterActive() && !currentRows.some(function (r) { return r.task.id === newId; })) {
          showToast('追加しましたが、いまの絞り込みの条件に合わないため一覧には表示されていません。', 'info', 5000);
        }
        if (continueAfter) {
          if (isMajor) openAddMajorForm(); else openAddMinorForm(data.parentId);
        } else if (newId) {
          setRovingFocus(newId, true);
        }
      });
      dialog.appendChild(form);
    }
  });
}

/* C7: 先行タスクの選択（大事業ごとのチェックボックス一覧＋絞り込み。循環を生む候補は選択不可） */
function buildPredecessorPicker(task, selected, outChecks) {
  var minors = state.project.tasks.filter(function (t) { return t.level === 'minor'; });
  var blocked = task ? transitiveSuccessorsOf(minors, task.id) : new Set();
  var selectedSet = new Set(selected);
  var box = el('div', { className: 'pred-box', id: 'f-preds', role: 'group', 'aria-labelledby': 'f-preds-label' });
  var childrenIdx = buildChildrenIndex(state.project.tasks);
  getMajors().forEach(function (m) {
    var kids = (childrenIdx.get(m.id) || []).filter(function (k) { return !task || k.id !== task.id; });
    if (kids.length === 0) return;
    box.appendChild(el('div', { className: 'pred-group', text: (wbsNumbers.get(m.id) || '') + ' ' + m.name }));
    kids.forEach(function (k) {
      var isBlocked = blocked.has(k.id);
      var cb = el('input', { type: 'checkbox', value: k.id, id: 'f-pred-' + k.id, disabled: isBlocked && !selectedSet.has(k.id) });
      cb.checked = selectedSet.has(k.id);
      outChecks.push(cb);
      box.appendChild(el('label', { className: 'pred-item' + (isBlocked ? ' disabled' : ''), 'for': cb.id, 'data-text': ((wbsNumbers.get(k.id) || '') + ' ' + k.name).toLowerCase() }, [
        cb, (wbsNumbers.get(k.id) || '') + ' ' + k.name,
        isBlocked ? el('span', { className: 'why', text: '（このタスクの後続のため選択不可）' }) : null
      ]));
    });
  });
  var filter = el('input', { type: 'text', className: 'pred-filter', placeholder: '名前・番号で絞り込み', 'aria-label': '先行タスクの候補を絞り込む' });
  filter.addEventListener('input', function () {
    var q = filter.value.trim().toLowerCase();
    Array.prototype.forEach.call(box.querySelectorAll('.pred-item'), function (item) {
      item.hidden = q !== '' && item.getAttribute('data-text').indexOf(q) === -1;
    });
  });
  filter.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') ev.preventDefault(); });
  var hasItems = outChecks.length > 0;
  return el('div', { className: 'form-row' }, [
    el('label', { id: 'f-preds-label', text: '先行タスク（この小事業の前に終わっている必要があるもの）' }),
    hasItems ? filter : null,
    hasItems ? box : el('div', { className: 'hint', text: '選べる小事業がまだありません。' }),
    el('div', { className: 'hint', text: '先行タスクが延びると、この小事業は自動で後ろへずれます。' })
  ]);
}

function validateFormData(data, isMajor, mode, task) {
  if (!data.name) return '事業名を入力してください。';
  if (data.name.length > MAX_NAME_LEN) return '事業名が長すぎます（' + MAX_NAME_LEN + '字以内）。';
  if (data.owner.length > MAX_OWNER_LEN) return '担当者名が長すぎます（' + MAX_OWNER_LEN + '字以内）。';
  if (data.memo.length > MAX_MEMO_LEN) return 'メモが長すぎます（' + MAX_MEMO_LEN + '字以内）。';
  var dates = [data.plannedStart, data.plannedEnd];
  for (var i = 0; i < 2; i++) {
    if (dates[i] != null && !isAppDate(dates[i])) return '日付は ' + DATE_MIN + '〜' + DATE_MAX + ' の実在する日付で入力してください（年の桁の打ち間違いにご注意ください）。';
  }
  if (!isMajor && (!data.plannedStart || !data.plannedEnd)) return '小事業は開始日・終了日の両方が必要です。';
  if (isMajor && (!!data.plannedStart !== !!data.plannedEnd)) return '大事業の開始日・終了日はセットで入力してください（両方空欄にすると小事業の日程から自動算出します）。';
  if (data.plannedStart && data.plannedEnd && data.plannedStart > data.plannedEnd) return '開始日が終了日より後になっています。';
  if (!!data.baselineStart !== !!data.baselineEnd) return '当初計画の開始日・終了日はセットで入力してください（両方空欄にすると当初計画を外します）。';
  if (data.baselineStart && (!isAppDate(data.baselineStart) || !isAppDate(data.baselineEnd))) return '当初計画の日付は ' + DATE_MIN + '〜' + DATE_MAX + ' の実在する日付で入力してください。';
  if (data.baselineStart && data.baselineStart > data.baselineEnd) return '当初計画の開始日が終了日より後になっています。';
  if (mode !== 'edit' && state.project.tasks.length >= MAX_TASKS) return 'タスク数が上限（' + MAX_TASKS + '件）に達しています。';
  if (!isMajor) {
    if (data.predecessors.length > MAX_PREDECESSORS) return '先行タスクは' + MAX_PREDECESSORS + '件以内にしてください。';
    var minors = state.project.tasks.filter(function (t) { return t.level === 'minor'; });
    var probeId = task ? task.id : '__new__';
    if (!task) minors = minors.concat([{ id: probeId, predecessors: [] }]);
    var cyc = findCycleIfPredecessorsSet(minors, probeId, data.predecessors);
    if (cyc) {
      var names = cyc.map(function (id) { return id === probeId ? (data.name || 'このタスク') : truncateText((getTaskById(id) || {}).name, 16); });
      return '先行タスクの指定が循環します（' + names.join(' → ') + '）。どれかの指定を外してください。';
    }
  }
  return null;
}

/* 新しい小事業を入れる位置（v1.5）。既定は親の大事業の配下の末尾。afterId がその親の小事業なら、その直後 */
function insertIndexForNewMinor(tasks, parentId, afterId) {
  var lastIdx = -1;
  tasks.forEach(function (x, i) { if (x.id === parentId || x.parentId === parentId) lastIdx = i; });
  if (afterId) {
    for (var i = 0; i < tasks.length; i++) {
      if (tasks[i].id === afterId && tasks[i].level === 'minor' && tasks[i].parentId === parentId) return i + 1;
    }
  }
  return lastIdx + 1;
}

function submitTaskForm(data, isMajor, mode, task) {
  var newId = null, expand = [];
  if (mode === 'edit') {
    var parentChanged = !isMajor && data.parentId !== task.parentId;
    if (!isMajor) expand.push(data.parentId);
    applyMutation((isMajor ? '大事業' : '小事業') + 'の編集', function (p) {
      var t = findTask(p, task.id);
      t.name = data.name; t.owner = data.owner; t.plannedStart = data.plannedStart; t.plannedEnd = data.plannedEnd; t.memo = data.memo;
      t.baselineStart = data.baselineStart; t.baselineEnd = data.baselineEnd; t.tentative = data.tentative;
      if (data.progress != null) t.progress = data.progress;
      if (!isMajor) {
        t.parentId = data.parentId; t.isMilestone = data.isMilestone; t.predecessors = data.predecessors;
        if (parentChanged) { // 付け替え先の末尾へ移す（WBS番号が自然に並ぶように）
          p.tasks.splice(p.tasks.indexOf(t), 1);
          var lastIdx = -1;
          p.tasks.forEach(function (x, i) { if (x.id === data.parentId || x.parentId === data.parentId) lastIdx = i; });
          p.tasks.splice(lastIdx + 1, 0, t);
        }
      }
    }, { expand: expand });
    return task.id;
  }
  var nt = createTask(isMajor ? 'major' : 'minor', isMajor ? null : data.parentId);
  newId = nt.id;
  nt.name = data.name; nt.owner = data.owner; nt.plannedStart = data.plannedStart; nt.plannedEnd = data.plannedEnd; nt.memo = data.memo;
  nt.baselineStart = data.baselineStart; nt.baselineEnd = data.baselineEnd; nt.tentative = data.tentative;
  if (data.progress != null) nt.progress = data.progress;
  if (!isMajor) { nt.isMilestone = data.isMilestone; nt.predecessors = data.predecessors; expand.push(data.parentId); }
  applyMutation(isMajor ? '大事業の追加' : '小事業の追加', function (p) {
    if (isMajor) { p.tasks.push(nt); return; }
    p.tasks.splice(insertIndexForNewMinor(p.tasks, data.parentId, data.afterId), 0, nt);
  }, { expand: expand });
  state.ui.focusTaskId = newId;
  return newId;
}

/* =========================================================================
 * 17. 印刷（PDF）: 印刷前に範囲・担当者名・用紙を選ぶ
 * ========================================================================= */
function openPrintDialog() {
  commitProjectNameInput();
  openDialog({
    title: 'PDF出力（印刷）',
    build: function (dialog, ctx) {
      var rAll = el('input', { type: 'radio', name: 'print-scope', id: 'p-all', value: 'all' });
      var rView = el('input', { type: 'radio', name: 'print-scope', id: 'p-view', value: 'view' });
      rAll.checked = true;
      var hide = el('input', { type: 'checkbox', id: 'p-hide-owner' });
      var paper = el('select', { id: 'p-paper' }, [el('option', { value: 'A3', text: 'A3 横（推奨）' }), el('option', { value: 'A4', text: 'A4 横' })]);
      dialog.appendChild(el('div', { className: 'form-row' }, [el('label', { text: '印刷する範囲' }),
        el('div', { className: 'radio-group', role: 'radiogroup' }, [
          el('label', { 'for': 'p-all' }, [rAll, 'すべてのタスク（小事業をすべて展開し、絞り込みも外して印刷）']),
          el('label', { 'for': 'p-view' }, [rView, '画面の表示のまま（折りたたみ・絞り込みをそのまま反映）'])])]));
      dialog.appendChild(el('div', { className: 'form-row checkbox-row' }, [hide, el('label', { 'for': 'p-hide-owner', text: '担当者名を伏せる（社外に渡すとき）' })]));
      dialog.appendChild(formRow('用紙', paper));
      dialog.appendChild(el('p', { className: 'hint', text: '次に開くブラウザの印刷画面で、送信先を「PDFに保存」にしてください。1ページ目が一覧、2ページ目以降がガントチャートです。' +
        'なお、PDFの作成者情報にPCのアカウント名が入る場合があります。社外に渡す前にPDFのプロパティをご確認ください。' }));
      var go = el('button', { type: 'button', className: BTN_PRIMARY, text: '印刷する', onclick: function () {
        var opts = { all: rAll.checked, hideOwner: hide.checked, paper: paper.value };
        ctx.close();
        doPrint(opts);
      } });
      dialog.appendChild(el('div', { className: 'form-actions' }, [el('div', { className: 'left' }),
        el('div', { className: 'right' }, [el('button', { type: 'button', className: BTN_SECONDARY, text: 'キャンセル', onclick: ctx.close }), go])]));
    }
  });
}

function doPrint(opts) {
  var saved = { expanded: new Set(state.ui.expandedMajors), owner: state.ui.filterOwner, status: state.ui.filterStatus, title: document.title };
  if (opts.all) {
    state.ui.expandedMajors = new Set(getMajors().map(function (m) { return m.id; }));
    state.ui.filterOwner = ''; state.ui.filterStatus = '';
  }
  printHideOwner = !!opts.hideOwner;
  // 用紙の大きさは app.css の名前付きページ（nc-a3 / nc-a4）をクラスで選ぶ（CSPで <style> を後から足せないため）
  var paperClass = opts.paper === 'A4' ? 'nc-print-a4' : 'nc-print-a3';
  document.documentElement.classList.remove('nc-print-a3', 'nc-print-a4'); // 前回の印刷で残った指定があっても選んだ用紙にする
  document.documentElement.classList.add(paperClass);
  renderAll();
  document.title = sanitizeFilenamePart(state.project.name || DEFAULT_FILE_BASENAME) + '_WBS_' + todayStr().replace(/-/g, '');
  var restored = false;
  var restore = function () {
    if (restored) return;
    restored = true;
    window.removeEventListener('afterprint', restore);
    printHideOwner = false;
    state.ui.expandedMajors = saved.expanded; state.ui.filterOwner = saved.owner; state.ui.filterStatus = saved.status;
    document.documentElement.classList.remove(paperClass);
    renderAll();
    document.title = saved.title;
  };
  window.addEventListener('afterprint', restore);
  window.print();
  // afterprint が発火しないブラウザ向けの保険（print() は多くのブラウザで印刷画面を閉じるまで戻らない）
  setTimeout(restore, 1500);
}

/* =========================================================================
 * 18. 担当者別の負荷（D8）: 週ごとに、期間が重なる未完了の小事業の数
 * ========================================================================= */
function openWorkloadDialog() {
  var minors = state.project.tasks.filter(function (t) { return t.level === 'minor' && !t.isMilestone && t.plannedStart && t.plannedEnd; });
  if (minors.length === 0) { showToast('日程の入った小事業がまだありません。', 'info'); return; }
  var s = minDateStr(minors.map(function (t) { return t.plannedStart; }));
  var e = maxDateStr(minors.map(function (t) { return t.plannedEnd; }));
  var buckets = buildDateBuckets(s, e, 'week'), note = '';
  if (buckets.length > 156) {
    var ri = findBucketIndexContaining(buckets, state.ui.referenceDate);
    var from = clamp((ri < 0 ? 0 : ri) - 26, 0, buckets.length - 156);
    buckets = buckets.slice(from, from + 156);
    note = '（期間が長いため、基準日を中心に156週だけ表示しています）';
  }
  var owners = collectOwnerList();
  if (minors.some(function (t) { return !t.owner; })) owners.push('');
  var table = el('table', { className: 'load-table' });
  var head = el('tr', {}, [el('th', { text: '担当者' }), el('th', { text: '未完了' }), el('th', { text: '遅延' })]);
  buckets.forEach(function (b) {
    var isToday = b.start <= state.ui.referenceDate && state.ui.referenceDate <= b.end;
    head.appendChild(el('th', { text: b.label, title: b.start + '〜' + b.end + (isToday ? '（基準日を含む週）' : ''), className: isToday ? 'today' : '' }));
  });
  table.appendChild(el('thead', {}, head));
  var tbody = el('tbody');
  var dlgCtx = null;
  owners.forEach(function (o) {
    var mine = minors.filter(function (t) { return (t.owner || '') === o; });
    var open = mine.filter(function (t) { return t.progress < 100; });
    var delayed = mine.filter(function (t) { return (derived.get(t.id) || {}).delayStatus === 'delayed'; }).length;
    var tr = el('tr', {}, [
      el('td', { className: 'owner', text: o || '（未設定）', title: 'クリックでこの担当者に絞り込む', tabindex: '0',
        onclick: function () { applyOwnerFilter(o); }, onkeydown: function (ev) { if (ev.key === 'Enter') applyOwnerFilter(o); } }),
      el('td', { text: String(open.length) }), el('td', { text: String(delayed) })
    ]);
    buckets.forEach(function (b) {
      var n = open.filter(function (t) { return !(t.plannedEnd < b.start || t.plannedStart > b.end); }).length;
      var isToday = b.start <= state.ui.referenceDate && state.ui.referenceDate <= b.end;
      tr.appendChild(el('td', { className: (n >= 3 ? 'l3' : n === 2 ? 'l2' : n === 1 ? 'l1' : '') + (isToday ? ' today' : ''),
        text: n ? String(n) : '', title: (o || '（未設定）') + '：' + b.start + '〜' + b.end + ' に ' + n + ' 件' }));
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  function applyOwnerFilter(o) {
    state.ui.filterOwner = o === '' ? '__none__' : o;
    if (dlgCtx) dlgCtx.close();
    renderAll();
  }
  dlgCtx = openDialog({
    title: '担当者別の負荷（週ごとの同時進行数）', wide: true,
    build: function (dialog, ctx) {
      dialog.appendChild(el('p', { className: 'hint', text: '数字は、その週に期間が重なっている未完了（進捗100%未満）の小事業の数です。3件以上は濃い赤の背景に白い数字で示します。太い枠で囲んだ列は基準日を含む週です。担当者名をクリックすると、その人のタスクだけに絞り込みます。' + note }));
      dialog.appendChild(el('div', { className: 'load-wrap' }, table));
      dialog.appendChild(el('div', { className: 'form-actions' }, [el('div', { className: 'left' }),
        el('div', { className: 'right' }, el('button', { type: 'button', className: BTN_PRIMARY, text: '閉じる', onclick: ctx.close }))]));
    }
  });
}

/* =========================================================================
 * 19. ヘルプ（C6）: v1.6.0 で help.html（共通ヘッダーの「ヘルプ」）へ移した
 * ========================================================================= */

/* =========================================================================
 * 20. ファイル・ツールバーの操作
 * ========================================================================= */
/* E2: 制御文字・禁止文字・末尾のドットや空白・予約名・長さに対処する */
function sanitizeFilenamePart(s) {
  var out = String(s || '').replace(/[\x00-\x1F\x7F]/g, '').replace(/[\/\\:*?"<>|]/g, '_').replace(/[. ]+$/, '').trim();
  if (out.length > 80) out = out.slice(0, 80).replace(/[. ]+$/, '');
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(out)) out = '_' + out;
  return out || 'project';
}
/* 保存ファイル名。.json だけでは何のデータか分からないため「WBS」を入れる */
function buildSaveFilename(projectName, today) {
  return sanitizeFilenamePart(projectName || DEFAULT_FILE_BASENAME) + '_WBS_' + today.replace(/-/g, '') + '.json';
}
function buildExportFilename(projectName, ext, today) {
  return sanitizeFilenamePart(projectName || DEFAULT_FILE_BASENAME) + '_' + today.replace(/-/g, '') + '.' + ext;
}
function downloadBlob(bytesOrString, filename, mime) {
  var url = URL.createObjectURL(new Blob([bytesOrString], { type: mime }));
  var a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function () { URL.revokeObjectURL(url); }, 30000); // E6: 大きいファイルのダウンロード完了を待つ
}

function hasContent() { return state.project.tasks.length > 0 || !!state.project.name; }

function confirmReplaceIfDirty(what) {
  if (!saveInfo.dirty) return Promise.resolve(true); // 内容が空でも、全削除などの未保存の変更があれば確かめる
  return confirmDialog({ title: '確認', okLabel: '続ける',
    message: 'ファイルに保存していない変更があります。' + what + 'と、いまの内容は置き換わります。\n（直後なら「元に戻す」で戻せます）' });
}

/* mode: 'template'（テンプレートから作成）・'blank'（白紙）・それ以外（ツールバーの「新規」。白紙も選べる） */
function actionNew(mode) {
  if (mode !== 'template' && mode !== 'blank') mode = 'any';
  confirmReplaceIfDirty('新規作成する').then(function (ok) { if (ok) openNewProjectDialog(mode); });
}

/* v1.7.0: 起動時の入口。「テンプレートから作成」「新規作成（白紙）」「続きから作成」を選ぶ。
   自動保存の控えの復元は init() で済ませておき、ここでは何から始めるかを選ぶだけにする
   （「前回の続きから」は閉じるだけで、読込み・自動保存・競合の状態を変えない）。 */
function openStartDialog(restored, onClose) {
  var continueBtn = null;
  openDialog({
    title: '作り方を選んでください',
    wide: true,
    initialFocus: function () { return continueBtn || document.getElementById('start-template'); },
    returnFocus: function () {
      return hasContent() ? document.getElementById('project-name-input') : document.getElementById('btn-empty-new');
    },
    onClose: onClose,
    build: function (dialog, ctx) {
      function card(title, desc, buttons) {
        var descId = 'start-desc-' + buttons[0].id;
        buttons.forEach(function (b) { b.setAttribute('aria-describedby', descId); });
        return el('section', { className: 'start-choice', 'aria-label': title }, [
          el('h3', { text: title }), el('p', { id: descId, text: desc }), el('div', { className: 'start-choice__actions' }, buttons)]);
      }
      function go(fn) { return function () { ctx.close(); fn(); }; }
      var cards = el('div', { className: 'start-choices' });
      cards.appendChild(card('テンプレートから作成',
        'イベント・広報・契約・工事・教育委員会など、自治体の業務でよくある工程のたたき台（' + TEMPLATES.length + '種類）から作ります。',
        [el('button', { type: 'button', id: 'start-template', className: restored ? BTN_SECONDARY : BTN_PRIMARY, text: 'テンプレートを選ぶ',
          onclick: go(function () { actionNew('template'); }) })]));
      cards.appendChild(card('新規作成',
        '何も入っていない工程表から作ります。期間とマスの単位だけ先に決めます。',
        [el('button', { type: 'button', id: 'start-blank', className: BTN_SECONDARY, text: '白紙から作る',
          onclick: go(function () { actionNew('blank'); }) })]));
      var openBtn = el('button', { type: 'button', id: 'start-open-file', className: BTN_SECONDARY, text: '保存したファイル(.json)を開く',
        onclick: go(actionOpen) });
      var desc;
      if (restored) {
        continueBtn = el('button', { type: 'button', id: 'start-continue', className: BTN_PRIMARY, text: '前回の続きから', onclick: ctx.close });
        desc = 'このブラウザの自動保存の控え「' + truncateText(state.project.name || '名前未設定', 40) + '」（作業' +
          state.project.tasks.length + '件）を画面に復元しています。「保存(.json)」で書き出したファイルから続けることもできます。';
      } else {
        desc = 'このブラウザに前回の控えはありません。「保存(.json)」で書き出したファイルを開いて続けます。';
      }
      cards.appendChild(card('続きから作成', desc, continueBtn ? [continueBtn, openBtn] : [openBtn]));
      dialog.appendChild(cards);
      // 開いている間に別のタブで控えが変わった場合の知らせ（renderAutosaveConflict が書く）
      dialog.appendChild(el('div', { id: 'start-conflict-note', className: 'start-note', role: 'status' }));
      dialog.appendChild(el('div', { className: 'form-actions' }, [
        el('div', { className: 'left' }, [el('button', { type: 'button', className: BTN_SECONDARY, text: 'サンプルで試す',
          onclick: go(loadSampleProject) })]),
        el('div', { className: 'right' }, [el('button', { type: 'button', className: BTN_SECONDARY, text: '閉じる', onclick: ctx.close })])]));
    }
  });
  renderAutosaveConflict();
}

/* v1.4: 新規作成ダイアログ。テンプレート・期間・マスの単位を最初に決める
   v1.7.0: テンプレートは分類ごとのカード（共通の name のラジオボタン）で選ぶ。mode は actionNew() を参照 */
function firstOfThisMonth() { return todayStr().slice(0, 8) + '01'; }
function buildTemplatePicker(withBlank) {
  var picker = el('fieldset', { className: 'tpl-picker' }, [el('legend', { text: 'テンプレート' })]);
  function option(value, name, desc) {
    var key = value || 'blank';
    var input = el('input', { type: 'radio', name: 'np-tpl', value: value, id: 'f-np-tpl-' + key,
      'aria-labelledby': 'f-np-tpl-name-' + key, 'aria-describedby': 'f-np-tpl-desc-' + key });
    return el('label', { className: 'tpl-card' }, [input, el('span', { className: 'tpl-card__text' }, [
      el('span', { className: 'tpl-card__name', id: 'f-np-tpl-name-' + key, text: name }),
      el('span', { className: 'tpl-card__desc', id: 'f-np-tpl-desc-' + key, text: desc })])]);
  }
  function group(title, options) {
    return el('fieldset', { className: 'tpl-group' }, [el('legend', { text: title }), el('div', { className: 'tpl-cards' }, options)]);
  }
  if (withBlank) picker.appendChild(group('テンプレートを使わない', [option('', '白紙', '何も入っていない状態から作ります。')]));
  TEMPLATE_CATEGORIES.forEach(function (c) {
    var list = TEMPLATES.filter(function (t) { return t.cat === c.id; });
    if (list.length) picker.appendChild(group(c.name, list.map(function (t) { return option(t.id, t.name, t.desc); })));
  });
  return picker;
}
function openNewProjectDialog(mode) {
  var useTemplate = mode !== 'blank';
  openDialog({
    title: mode === 'template' ? 'テンプレートから作成' : mode === 'blank' ? '新規作成（白紙）' : '新規作成', wide: useTemplate,
    initialFocus: function () {
      if (!useTemplate) return document.getElementById('f-np-name');
      return document.querySelector('input[name="np-tpl"]:checked') || document.querySelector('input[name="np-tpl"]');
    },
    build: function (dialog, ctx) {
      var form = el('form', { novalidate: true });
      var picker = null;
      if (useTemplate) {
        picker = buildTemplatePicker(mode === 'any');
        form.appendChild(picker);
        if (mode === 'any') picker.querySelector('input[value=""]').checked = true;
      }
      var nameInput = el('input', { type: 'text', id: 'f-np-name', maxlength: MAX_PROJECT_NAME_LEN, autocomplete: 'off' });
      form.appendChild(formRow('プロジェクト名', nameInput, useTemplate ? '空欄ならテンプレート名を使います（あとから変えられます）' : 'あとから変えられます'));
      var startInput = el('input', { type: 'date', id: 'f-np-start', min: DATE_MIN, max: DATE_MAX, value: firstOfThisMonth() });
      var endInput = el('input', { type: 'date', id: 'f-np-end', min: DATE_MIN, max: DATE_MAX });
      form.appendChild(el('div', { className: 'form-row-2col' }, [formRow('期間の開始日', startInput), formRow('期間の終了日', endInput)]));
      if (useTemplate) form.appendChild(el('div', { className: 'hint', text: 'テンプレートの作業は、この期間に合わせて伸び縮みします。議決日・開催日などの節目も一緒に動くので、日程は目安として、実際の日付に直してください。' }));
      var unitSelect = el('select', { id: 'f-np-unit' });
      SCALE_ORDER.slice().reverse().forEach(function (u) { unitSelect.appendChild(el('option', { value: u, text: SCALE_LABELS[u] })); });
      form.appendChild(formRow('マスの単位', unitSelect, '1マスの大きさです。あとからツールバーの「マス」で変えられます'));
      var errorBox = el('div', { className: 'form-error', role: 'alert', 'aria-live': 'assertive' });
      var endTouched = false, unitTouched = false;
      function currentTpl() {
        var checked = picker && picker.querySelector('input[name="np-tpl"]:checked');
        var id = checked ? checked.value : '';
        return TEMPLATES.filter(function (t) { return t.id === id; })[0] || null;
      }
      function sync() {
        var t = currentTpl();
        nameInput.placeholder = t ? t.name : 'プロジェクト名（未設定）';
        if (!endTouched && isAppDate(startInput.value)) endInput.value = defaultTemplateEnd(t, startInput.value);
        if (!unitTouched) unitSelect.value = t ? t.unit : 'month';
      }
      if (picker) picker.addEventListener('change', function () { errorBox.textContent = ''; sync(); });
      startInput.addEventListener('change', sync);
      endInput.addEventListener('change', function () { endTouched = true; });
      unitSelect.addEventListener('change', function () { unitTouched = true; });
      sync();
      form.appendChild(errorBox);
      form.appendChild(el('div', { className: 'form-actions' }, [el('div', { className: 'left' }),
        el('div', { className: 'right' }, [el('button', { type: 'button', className: BTN_SECONDARY, text: 'キャンセル', onclick: ctx.close }),
          el('button', { type: 'submit', className: BTN_PRIMARY, text: '作成する' })])]));
      form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var t = currentTpl();
        if (mode === 'template' && !t) {
          errorBox.textContent = 'テンプレートを選んでください。';
          picker.querySelector('input[name="np-tpl"]').focus();
          return;
        }
        var s0 = startInput.value, e0 = endInput.value;
        if (!isAppDate(s0) || !isAppDate(e0)) { errorBox.textContent = '期間は ' + DATE_MIN + '〜' + DATE_MAX + ' の実在する日付で入力してください。'; return; }
        if (s0 > e0) { errorBox.textContent = '期間の開始日が終了日より後になっています。'; return; }
        if (t && inclusiveDays(s0, e0) < TEMPLATE_MIN_DAYS) { errorBox.textContent = 'テンプレートを使うときは、期間を' + TEMPLATE_MIN_DAYS + '日以上にしてください。'; return; }
        var proj = t ? instantiateTemplate(t, s0, e0) : createEmptyProject();
        proj.period = { start: s0, end: e0 };
        var nm = nameInput.value.trim().slice(0, MAX_PROJECT_NAME_LEN);
        if (nm) proj.name = nm;
        var majorIds = proj.tasks.filter(function (x) { return x.level === 'major'; }).map(function (x) { return x.id; });
        ctx.close();
        // 白紙で名前も無いときだけ保存済み（内容が無いので表示も出ない）。テンプレート・名前があるときは未保存
        replaceProject('新規作成', proj, { scale: unitSelect.value, expanded: majorIds }, !t && !nm);
        if (t) showToast('テンプレート「' + t.name + '」から作成しました。作業名や日程を直したら、ツールバーの「当初計画を確定」を押してください。以後の変更が当初計画との2段書きで表示されます。', 'info', 9000);
        else showToast('新規プロジェクトを作成しました。「＋ 大事業」から工程を追加してください。', 'info');
        // 作成後は空の状態の入口が隠れることがあるため、名前の欄へ移す
        document.getElementById('project-name-input').focus();
      });
      dialog.appendChild(form);
    }
  });
}

/* v1.4: 期間の設定（ガントに表示する範囲） */
function openPeriodDialog() {
  var cur = state.project.period;
  openDialog({
    title: '期間の設定',
    initialFocus: function () { return document.getElementById('f-pd-start'); },
    build: function (dialog, ctx) {
      var form = el('form', { novalidate: true });
      var startInput = el('input', { type: 'date', id: 'f-pd-start', min: DATE_MIN, max: DATE_MAX, value: cur ? cur.start : firstOfThisMonth() });
      var endInput = el('input', { type: 'date', id: 'f-pd-end', min: DATE_MIN, max: DATE_MAX, value: cur ? cur.end : clampDate(dayAdd(firstOfThisMonth(), 364)) });
      form.appendChild(el('div', { className: 'form-row-2col' }, [formRow('開始日', startInput), formRow('終了日', endInput)]));
      form.appendChild(el('div', { className: 'hint', text: 'ガントには、この期間を表示します（期間の外にある作業も隠しません）。期間を外すと、作業の日程に合わせて自動で決まります。' }));
      var errorBox = el('div', { className: 'form-error', role: 'alert', 'aria-live': 'assertive' });
      form.appendChild(errorBox);
      var left = el('div', { className: 'left' });
      if (cur) left.appendChild(el('button', { type: 'button', className: BTN_SECONDARY, text: '期間の指定を外す', onclick: function () {
        ctx.close(); applyMutation('期間の指定を外す', function (p) { p.period = null; });
      } }));
      form.appendChild(el('div', { className: 'form-actions' }, [left,
        el('div', { className: 'right' }, [el('button', { type: 'button', className: BTN_SECONDARY, text: 'キャンセル', onclick: ctx.close }),
          el('button', { type: 'submit', className: BTN_PRIMARY, text: '保存' })])]));
      form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var s0 = startInput.value, e0 = endInput.value;
        if (!isAppDate(s0) || !isAppDate(e0)) { errorBox.textContent = '期間は ' + DATE_MIN + '〜' + DATE_MAX + ' の実在する日付で入力してください。'; return; }
        if (s0 > e0) { errorBox.textContent = '開始日が終了日より後になっています。'; return; }
        ctx.close();
        applyMutation('期間の変更', function (p) {
          if (p.period && p.period.start === s0 && p.period.end === e0) return false;
          p.period = { start: s0, end: e0 };
        });
      });
      dialog.appendChild(form);
    }
  });
}

function actionOpen() {
  confirmReplaceIfDirty('ファイルを開く').then(function (ok) { if (ok) document.getElementById('file-input').click(); });
}

/* 開けるのは .json だけ。accept 属性は選択画面の絞り込みにすぎず、他の拡張子も選べるため読込み時にも検査する */
function isJsonFileName(name) {
  return /\.json$/i.test(String(name || ''));
}

/* ファイル読込みの完了時に、読み込んだ内容を適用してよいかを決める（DOMに触れない）。
   req: 読込み開始時の { seq, generation, snapshot }、now: 完了時の同じ値と dialogOpen。
   'stale': 後から別のファイルを選んだ、または最新の控えの読込み・消去があった（黙って捨てる）
   'busy': ダイアログ（作業の編集フォームなど）が開いている。フォームは置き換え前の工程表の作業を指すため適用しない
   'changed': 読込み中に工程表が変わった。置き換えるとその変更が失われるため適用しない
   'apply': 適用する */
function fileOpenDecision(req, now) {
  if (req.seq !== now.seq || req.generation !== now.generation) return 'stale';
  if (now.dialogOpen) return 'busy';
  if (req.snapshot !== now.snapshot) return 'changed';
  return 'apply';
}

function actionOpenFileSelected(file) {
  if (!file) return;
  // 選び直した時点で、前に選んだファイルの読込みを取り消す（後のファイルが開けない場合も、前のファイルは開かない）
  var seq = ++fileOpenSeq;
  if (!isJsonFileName(file.name)) {
    showToast('開けるのは .json ファイルだけです。旧版の .wbsproj は、ファイルをコピーしてから拡張子を .json に変えると開けます。', 'error', 10000);
    return;
  }
  if (file.size > MAX_FILE_SIZE) { showToast('ファイルサイズが上限（' + MAX_FILE_SIZE_LABEL + '）を超えています。', 'error', 6000); return; }
  var reader = new FileReader();
  commitProjectNameInput(); // 入力中の名前も、読込み中の変更の比較に入れる
  var req = { seq: seq, generation: autosaveGeneration, snapshot: snapshotProject() };
  function decide() {
    var now = { seq: fileOpenSeq, generation: autosaveGeneration, dialogOpen: dialogStack.length > 0, snapshot: req.snapshot };
    var pre = fileOpenDecision(req, now);
    if (pre !== 'apply') return pre; // 捨てる要求・ダイアログ中は、入力中の名前に触れない
    commitProjectNameInput();
    now.snapshot = snapshotProject();
    return fileOpenDecision(req, now);
  }
  reader.onload = function () {
    var decision = decide();
    if (decision === 'stale') return;
    var fname = '「' + truncateText(file.name, 40) + '」';
    if (decision === 'busy') { showToast('ダイアログを開いている間に読み込みが終わったため、' + fname + 'は開きませんでした。ダイアログを閉じてから、もう一度開いてください。', 'warning', 9000); return; }
    if (decision === 'changed') { showToast('読み込みの間に工程表が変更されたため、' + fname + 'は開きませんでした。いまの内容を残す場合は「保存(.json)」で保存してから、もう一度開いてください。', 'warning', 10000); return; }
    var result = validateWbsprojText(String(reader.result), file.size);
    if (!result.ok) { showToast('開けませんでした: ' + result.message, 'error', 8000); return; }
    replaceProject('ファイルを開く', result.project, result.ui, true);
    var collapsedWithKids = getMajors().some(function (m) { return !state.ui.expandedMajors.has(m.id) && getChildrenOf(m.id).length > 0; });
    showToast('「' + truncateText(file.name, 40) + '」を開きました。' + (collapsedWithKids ? '小事業は大事業の ▶ で表示できます（「すべて展開」も使えます）。' : ''), 'success', 6000);
    result.warnings.forEach(function (w) { showToast(w, 'warning', 9000); });
  };
  reader.onerror = function () {
    // 後から別のファイルを選んだ・最新の控えの読込みや消去があった場合は、取り消した要求として失敗も知らせない
    if (req.seq !== fileOpenSeq || req.generation !== autosaveGeneration) return;
    console.error('[NovaChart] file read error', reader.error);
    showToast('ファイルの読み込みに失敗しました。', 'error');
  };
  reader.readAsText(file);
}

/* 保存ファイルの文字列を作る。字下げ付きで上限を超えるときだけ字下げなしで再試行し、それでも超えるなら書き出さない */
function buildSaveText(project, ui, maxBytes) {
  var text = serializeProjectData(project, ui, true);
  if (checkWbsprojSaveSize(text, maxBytes).ok) return { ok: true, text: text };
  text = serializeProjectData(project, ui, false);
  var size = checkWbsprojSaveSize(text, maxBytes);
  return size.ok ? { ok: true, text: text } : { ok: false, message: size.message };
}

function actionSave() {
  commitProjectNameInput();
  var saved = buildSaveText(state.project, currentUiForSave());
  if (!saved.ok) { showToast(saved.message, 'error', 10000); return; }
  var text = saved.text;
  downloadBlob(text, buildSaveFilename(state.project.name, todayStr()), 'application/json');
  markClean();
  renderToolbarState();
  scheduleLocalSave();
  showToast('.json として保存しました（ブラウザのダウンロード先をご確認ください）。', 'success');
}

function actionExportExcel() {
  commitProjectNameInput();
  recompute({ silent: true });
  var pre = excelPreflight(state.project, derived, state.ui.scale);
  if (!pre.ok) { showToast(pre.message, 'error', 9000); return; }
  if (state.project.tasks.length === 0) { showToast('タスクがありません。', 'info'); return; }
  var btn = document.getElementById('btn-export-excel');
  btn.disabled = true;
  // 圧縮を待つ間に別の工程表へ切り替えても、内容とファイル名が同じ工程表を指すよう、ここで決める
  var filename = buildExportFilename(state.project.name, 'xlsx', todayStr());
  buildXlsxBytesAsync(state.project, derived, wbsNumbers, state.ui.referenceDate, state.ui.scale, pre.buckets, { detail: state.ui.detailMode }).then(function (bytes) {
    downloadBlob(bytes, filename, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    var kb = Math.max(1, Math.round(bytes.length / 1024));
    showToast('Excel を出力しました（' + pre.buckets.length + '列のガント・' + kb.toLocaleString('ja-JP') + 'KB）。', 'success', 5000);
    if (pre.buckets.length > 400) showToast('ガントが' + pre.buckets.length + '列あります。表示を「週」または「月」にすると見やすくなります。', 'info', 7000);
  }).catch(function (e) {
    console.error('[NovaChart] xlsx export failed', e);
    showToast('Excel出力に失敗しました。', 'error');
  }).then(function () { btn.disabled = false; });
}

function actionSaveBaseline() {
  if (state.project.tasks.length === 0) { showToast('タスクがありません。', 'info'); return; }
  var hasAny = state.project.tasks.some(function (t) { return t.baselineStart && t.baselineEnd; });
  function record(onlyMissing) {
    var targets = state.project.tasks.filter(function (t) {
      if (onlyMissing && t.baselineStart && t.baselineEnd) return false;
      var r = rangeOf(t, derived.get(t.id) || {});
      return !!(r.start && r.end);
    });
    if (targets.length === 0) { showToast('記録する対象がありません（日付の入ったタスクが無いか、すべて記録済みです）。', 'info', 6000); return; }
    applyMutation('当初計画の確定', function (p) {
      var changed = false;
      p.tasks.forEach(function (t) {
        if (onlyMissing && t.baselineStart && t.baselineEnd) return;
        var r = rangeOf(t, derived.get(t.id) || {});
        if (!r.start || !r.end) return;
        t.baselineStart = r.start; t.baselineEnd = r.end; changed = true;
      });
      if (!changed) return false;
      p.baselineSavedAt = new Date().toISOString();
    });
    showToast('当初計画を確定しました。以後、日程を変えると当初計画（上段）と修正後の予定（下段）の2段で表示されます。', 'success', 7000);
  }
  openDialog({
    title: '当初計画の確定',
    build: function (dialog, ctx) {
      dialog.appendChild(el('p', { text: 'いまの日程を当初計画として記録します。以後、日程を変えると、当初計画（上段）と修正後の予定（下段）の2段で表示され、一覧の「当初比」に遅れの日数が出ます。' }));
      if (hasAny) dialog.appendChild(el('p', { text: '既に当初計画が記録されているタスクがあります。新しく追加したタスクだけ記録するか、すべて記録し直すかを選んでください。' }));
      dialog.appendChild(el('p', { className: 'hint', text: '直後なら「元に戻す」で戻せます。' }));
      var right = el('div', { className: 'right' }, [el('button', { type: 'button', className: BTN_SECONDARY, text: 'キャンセル', onclick: ctx.close })]);
      if (hasAny) {
        right.appendChild(el('button', { type: 'button', className: BTN_SECONDARY, text: 'すべて記録し直す', onclick: function () { ctx.close(); record(false); } }));
        right.appendChild(el('button', { type: 'button', className: BTN_PRIMARY, text: '未記録のタスクだけ記録', onclick: function () { ctx.close(); record(true); } }));
      } else {
        right.appendChild(el('button', { type: 'button', className: BTN_PRIMARY, text: '確定する', onclick: function () { ctx.close(); record(false); } }));
      }
      dialog.appendChild(el('div', { className: 'form-actions' }, [el('div', { className: 'left' }), right]));
    }
  });
}

function actionSetReferenceDate(v) {
  var input = document.getElementById('reference-date-input');
  if (!isAppDate(v)) {
    input.value = state.ui.referenceDate;
    showToast('基準日は ' + DATE_MIN + '〜' + DATE_MAX + ' の日付で指定してください。', 'warning');
    return;
  }
  state.ui.referenceDate = v;
  recompute({ silent: true });
  renderAll();
}

/* 別のタブの更新・消去を確かめる（storage イベント・bfcache からの復帰・タブの再表示で呼ぶ）。
   届いた値は使わず、いまの控えを読み直して判定する。一致し直しても、一度止めた自動保存は解除しない */
function checkAutosaveConflict() {
  var current;
  try { current = readAutosaveSnapshot(localStorage); } catch (e) { return; }
  if (current.project === autosaveBase.project && current.meta === autosaveBase.meta) return;
  enterAutosaveConflict(autosaveChangeReason(current) === 'cleared' ? 'cleared' : 'changed');
}

function enterAutosaveConflict(reason) {
  if (localSaveTimer) { clearTimeout(localSaveTimer); localSaveTimer = null; }
  if (autosaveConflict === reason) return;
  autosaveConflict = reason;
  renderAutosaveConflict();
  renderSaveState();
}

/* 競合の知らせ。再描画のたびに作り直すと読み上げが繰り返されるため、状態が変わったときだけ描く */
function renderAutosaveConflict() {
  var area = document.getElementById('autosave-conflict');
  if (!area) return;
  clearChildren(area);
  area.hidden = !autosaveConflict;
  var startNote = document.getElementById('start-conflict-note');
  if (startNote) startNote.textContent = autosaveConflict ? '別のタブで自動保存の控えが変わりました。「前回の続きから」は、この画面に復元した内容のままです。閉じて、画面上部の知らせを確認してください。' : '';
  if (!autosaveConflict) return;
  var cleared = autosaveConflict === 'cleared';
  area.appendChild(el('div', { className: 'banner error', role: 'alert' }, [
    (cleared ? '⚠ 別のタブで、ブラウザの自動保存の控えが消去されました。' : '⚠ 別のタブで、ブラウザの自動保存の控えが更新されました。') +
      'このタブの古い内容で控えを上書きしないよう、このタブの自動保存を止めています。このタブの内容を残すときは、ファイルに保存してください。',
    el('button', { type: 'button', text: 'このタブの内容をファイルに保存', onclick: actionSave }),
    el('button', { type: 'button', text: cleared ? '消去後の状態を読み込む' : '最新の控えを読み込む', onclick: actionReloadLatestAutosave })
  ]));
}

/* 最新の控えから、このタブへ読み込む内容を決める（状態は変えない）。
   ok:false のときは何も入れ替えず、止めた状態のままにする。project:null は控えが消去済み（空の工程表にする） */
function planReloadLatest(snap) {
  if (snap.project === null) {
    return { ok: true, project: null, ui: null, warnings: [], saveInfo: { dirty: false, savedAt: null }, base: snap };
  }
  var result = validateWbsprojText(snap.project, utf8ByteLength(snap.project));
  if (!result.ok) return { ok: false, message: result.message };
  var meta = parseAutosaveMeta(snap.meta, snap.project);
  return { ok: true, project: result.project, ui: result.ui, warnings: result.warnings, saveInfo: { dirty: meta.dirty, savedAt: meta.savedAt }, base: snap };
}

/* 最新の控えを読み込み、このタブの自動保存を再開する。読込み・検証に成功したときだけ状態を入れ替える */
function actionReloadLatestAutosave() {
  var cleared = autosaveConflict === 'cleared';
  confirmDialog({ title: cleared ? '消去後の状態を読み込む' : '最新の控えを読み込む', okLabel: '読み込む', danger: true,
    message: (cleared ? 'ブラウザの自動保存の控えが消去された状態（空の工程表）をこのタブに読み込みます。' : 'ブラウザの自動保存の控えにある最新の内容を、このタブに読み込みます。') +
      '\nこのタブで行った未保存の変更と、「元に戻す」の履歴は消えます。このタブの内容を残すときは、先に「このタブの内容をファイルに保存」を押してください。' })
    .then(function (ok) {
      if (!ok) return;
      var snap;
      try { snap = readAutosaveSnapshot(localStorage); } catch (e) {
        console.error('[NovaChart] localStorage read failed', e);
        showToast('ブラウザの自動保存の控えを読み取れませんでした。', 'error', 8000);
        return;
      }
      var plan = planReloadLatest(snap);
      if (!plan.ok) { showToast('最新の控えを読み込めませんでした: ' + plan.message, 'error', 9000); return; }
      autosaveGeneration++;
      if (localSaveTimer) { clearTimeout(localSaveTimer); localSaveTimer = null; }
      state.project = plan.project || createEmptyProject();
      var ui = plan.ui;
      state.ui.expandedMajors = new Set(ui && ui.expanded ? ui.expanded : []);
      if (ui && ui.scale) state.ui.scale = ui.scale;
      if (ui && typeof ui.detailMode === 'boolean') state.ui.detailMode = ui.detailMode;
      state.ui.filterOwner = '';
      state.ui.filterStatus = '';
      undoHistory = { past: [], future: [], bytes: 0 };
      saveInfo = plan.saveInfo;
      autosaveBase = plan.base;
      autosaveConflict = null;
      autosaveFailReason = null;
      lastCycleKey = null;
      recompute({ silent: true });
      renderAll();
      renderAutosaveConflict();
      // 押したボタンは知らせと一緒に消えるため、ツールバーの先頭へフォーカスを移す
      document.getElementById('project-name-input').focus();
      showToast((plan.project ? '最新の控えを読み込みました。' : '控えが消去された状態を読み込みました。') + 'このタブの自動保存を再開しました。', 'success', 6000);
      plan.warnings.forEach(function (w) { showToast(w, 'warning', 9000); });
    });
}

function actionClearLocal() {
  confirmDialog({ title: 'ローカルデータの消去', okLabel: '消去する', danger: true,
    message: 'このブラウザに自動保存された' + APP_DISPLAY_NAME + 'のデータと、いま画面にある内容を消去します。\n必要なら先に「保存(.json)」でファイルに保存してください。この操作は元に戻せません。' +
      (hasLegacyAutosave() ? '\n\n旧版（.wbsproj 保存版）のブラウザ自動保存は別の場所にあるため消えません（この版が今後それを読み込むこともありません）。必要なら旧版の画面で消去してください。' : '') +
      (autosaveConflict === 'changed' ? '\n\n別のタブで更新された控えも、あわせて消去されます。' : '') })
    .then(function (ok) {
      if (!ok) return;
      // ブラウザ保存が禁止された環境（プライベートモード等）では localStorage へのアクセス自体が例外になる。
      // その場合も画面の消去は続行し、ブラウザ内データの消去を確認できなかったことを伝える（R02-08。部分失敗もありうるため断定しない）。
      var storageNote = 'ローカルデータと画面の内容を消去しました。';
      try {
        clearLocalData();
        // 消去した状態をこのタブの基準にし、自動保存を再開する（別のタブはこの消去を検知して止まる）
        autosaveBase = { project: null, meta: null };
        autosaveConflict = null;
      } catch (e) {
        console.warn('[NovaChart] clearing localStorage failed or unavailable', e);
        storageNote = '画面の内容を消去しました。ブラウザ内データの消去は確認できませんでした（ブラウザ保存が使えない環境の可能性があります）。';
      }
      autosaveGeneration++;
      if (localSaveTimer) { clearTimeout(localSaveTimer); localSaveTimer = null; }
      state.project = createEmptyProject();
      state.ui.expandedMajors = new Set();
      undoHistory = { past: [], future: [], bytes: 0 };
      recoveryInfo = null;
      saveInfo = { dirty: false, savedAt: null };
      recompute({ silent: true });
      renderAll();
      renderAutosaveConflict();
      showToast(storageNote, 'success', 5000);
    });
}

function exportRecoveryData() {
  if (!recoveryInfo) return;
  downloadBlob(recoveryInfo.text, DEFAULT_FILE_BASENAME + '_退避データ_' + todayStr().replace(/-/g, '') + '.json', 'application/json');
}
function discardRecoveryData() {
  confirmDialog({ title: '退避データの削除', okLabel: '削除する', danger: true, message: '退避してある自動保存データを削除します。この操作は元に戻せません。' })
    .then(function (ok) {
      if (!ok) return;
      try { localStorage.removeItem(STORAGE_KEY_RECOVERY); } catch (e) { console.error(e); }
      recoveryInfo = null;
      renderBanners();
    });
}

function clearFilters() {
  state.ui.filterOwner = ''; state.ui.filterStatus = '';
  renderAll();
}

/* =========================================================================
 * 20b. テンプレート（v1.4。自治体業務でよくある工程の「たたき台」）
 * 各作業は「標準の日数（days）の中で、開始から何日目〜何日目か」で持つ。新規作成時に指定した期間へ
 * 比率で伸び縮みさせて展開する（instantiateTemplate）。要素が2つの作業はマイルストーン（節目の1日）。
 * 大事業の日付は持たない（小事業の日程から自動で決まる）。担当者は空欄。
 * ========================================================================= */
/* 分類（新規作成の画面で、この順に見出しを付けて並べる） */
var TEMPLATE_CATEGORIES = [
  { id: 'event', name: 'イベント・広報' },
  { id: 'contract', name: '契約・調達' },
  { id: 'works', name: '工事・施設' },
  { id: 'plan', name: '計画・予算・制度' },
  { id: 'education', name: '教育委員会' }
];
var TEMPLATES = [
  { id: 'system', cat: 'contract', name: 'システム更改（調達〜本稼働）', unit: 'month', days: 365, months: 12,
    desc: '業務システムの入替え。要件整理から調達・構築・移行・研修を経て本稼働まで（標準12か月）',
    tasks: [
      { n: '要件整理', c: [['現行業務・課題の整理', 0, 44], ['要件定義書の作成', 30, 89], ['予算の確保（予算要求）', 60, 120]] },
      { n: '調達', c: [['仕様書・評価基準の作成', 90, 134], ['入札公告', 135], ['事業者の選定', 136, 174], ['契約締結', 180]] },
      { n: '設計・構築', c: [['基本設計・詳細設計', 181, 239], ['構築・設定', 220, 284]] },
      { n: '移行・テスト', c: [['データ移行', 270, 319], ['受入テスト', 300, 334], ['職員研修・操作説明会', 320, 344]] },
      { n: '本稼働', c: [['本稼働', 345], ['稼働後のフォロー・問合せ対応', 346, 364]] }
    ] },
  { id: 'event', cat: 'event', name: 'イベント・講演会の開催', unit: 'half', days: 120, months: 4,
    desc: '講演会・説明会・地域イベントの準備。企画決裁から広報・申込受付・当日運営・報告まで（標準4か月）',
    tasks: [
      { n: '企画', c: [['企画書の作成・決裁', 0, 13], ['会場・講師の調整', 7, 27], ['支出負担行為の手続き', 14, 24]] },
      { n: '広報・申込', c: [['チラシ・ポスターの作成', 28, 48], ['広報紙・ホームページへの掲載依頼', 42, 55], ['申込受付', 56, 97]] },
      { n: '準備', c: [['物品・資材の手配', 70, 97], ['当日運営マニュアルの作成', 84, 104], ['関係者打合せ', 105]] },
      { n: '開催', c: [['開催当日', 112]] },
      { n: '事後', c: [['アンケート集計・報告書の作成', 113, 119]] }
    ] },
  { id: 'plan', cat: 'plan', name: '行政計画の策定（委員会・パブコメ）', unit: 'month', days: 365, months: 12,
    desc: '〇〇計画の策定・改定。現状分析・策定委員会・素案・パブリックコメントを経て公表まで（標準12か月）',
    tasks: [
      { n: '現状分析', c: [['統計・現行計画の評価', 0, 59], ['住民アンケート', 30, 89], ['関係課ヒアリング', 60, 99]] },
      { n: '策定委員会', c: [['第1回 策定委員会', 90], ['第2回 策定委員会', 180], ['第3回 策定委員会', 270]] },
      { n: '素案の作成', c: [['骨子案の作成', 100, 159], ['素案の作成', 160, 229]] },
      { n: 'パブリックコメント', c: [['意見募集', 230, 259], ['意見への考え方・修正', 260, 289]] },
      { n: '策定・公表', c: [['議会への報告', 300], ['計画の決定・公表', 330], ['概要版の作成・ホームページ掲載', 331, 364]] }
    ] },
  { id: 'budget', cat: 'plan', name: '当初予算の要求〜議決', unit: 'half', days: 240, months: 8,
    desc: '翌年度の当初予算。事業の見直し・要求・査定・内示から議会の議決まで（標準8か月）',
    tasks: [
      { n: '要求準備', c: [['事業の見直し・積算', 0, 44], ['予算要求書の作成', 30, 59], ['予算要求書の提出', 60]] },
      { n: '査定', c: [['財政課ヒアリング', 61, 89], ['査定・復活要求', 90, 129], ['予算の内示', 140]] },
      { n: '議会', c: [['予算説明資料の作成', 141, 179], ['議案の提出', 190], ['委員会審査', 200, 219], ['議決', 225]] },
      { n: '執行準備', c: [['執行計画・契約の準備', 226, 239]] }
    ] },
  { id: 'ordinance', cat: 'plan', name: '条例の制定・改正', unit: 'half', days: 240, months: 8,
    desc: '議会の議決が必要な条例の制定・改正。内容の検討・法制審査・パブリックコメント・議決から施行まで（標準8か月）',
    tasks: [
      { n: '検討', c: [['改正内容の検討・他自治体の調査', 0, 44], ['関係課との協議', 30, 59]] },
      { n: '法制執務', c: [['条例案の作成', 60, 89], ['法制担当の審査', 90, 119]] },
      { n: '意見募集', c: [['パブリックコメント', 120, 149], ['意見の整理・反映', 150, 164]] },
      { n: '議会', c: [['議案の提出', 170], ['議決', 190], ['公布', 196]] },
      { n: '施行準備', c: [['規則・要綱の整備', 197, 224], ['住民・事業者への周知', 200, 234], ['施行', 239]] }
    ] },
  { id: 'subsidy', cat: 'plan', name: '国・県補助金の申請〜実績報告', unit: 'month', days: 365, months: 12,
    desc: '補助事業の1年間。事前協議・交付申請・交付決定・事業実施から実績報告・額の確定まで（標準12か月）',
    tasks: [
      { n: '申請', c: [['要綱の確認・事前協議', 0, 29], ['事業計画書・申請書の作成', 30, 59], ['交付申請', 60]] },
      { n: '交付決定', c: [['交付決定', 90], ['執行伺い', 91, 104]] },
      { n: '事業実施', c: [['契約・発注', 105, 134], ['事業の実施', 135, 299], ['変更承認申請（必要なとき）', 200, 219]] },
      { n: '実績報告', c: [['実績報告書の作成', 300, 334], ['実績報告', 335], ['額の確定・請求', 336, 364]] }
    ] },
  { id: 'proposal', cat: 'contract', name: '委託業務の発注（プロポーザル方式）', unit: 'third', days: 150, months: 5,
    desc: '公募型プロポーザルでの委託先選定。仕様・評価基準の作成から公募・審査・契約まで（標準5か月）',
    tasks: [
      { n: '準備', c: [['仕様書の作成', 0, 24], ['実施要領・評価基準の作成', 15, 34], ['選定委員の選任', 25, 39]] },
      { n: '公募', c: [['公募開始', 40], ['質問の受付・回答', 41, 54], ['参加申込・企画提案書の受付', 55, 74]] },
      { n: '審査', c: [['書類審査', 75, 84], ['プレゼンテーション審査', 90], ['選定結果の通知', 91, 97]] },
      { n: '契約', c: [['仕様の詳細協議', 98, 119], ['契約締結', 125], ['業務開始', 135]] }
    ] },
  { id: 'survey', cat: 'plan', name: '住民アンケート調査', unit: 'half', days: 180, months: 6,
    desc: '住民意識調査など。調査票の設計・発送・回収・集計分析から結果の公表まで（標準6か月）',
    tasks: [
      { n: '調査設計', c: [['調査目的・項目の検討', 0, 29], ['調査票の作成', 20, 49], ['対象者の抽出', 45, 59]] },
      { n: '実施', c: [['調査票の印刷・発送', 60, 69], ['回答期間', 70, 99], ['お礼状兼督促状の送付', 85]] },
      { n: '集計・分析', c: [['データ入力・集計', 100, 129], ['分析・クロス集計', 125, 149]] },
      { n: '報告', c: [['報告書の作成', 150, 169], ['結果の公表', 175]] }
    ] },
  { id: 'repair', cat: 'works', name: '施設の修繕工事（設計〜完了検査）', unit: 'month', days: 300, months: 10,
    desc: '公共施設の修繕・改修工事。現地調査・設計から入札・契約・施工・完了検査まで（標準10か月）',
    tasks: [
      { n: '設計', c: [['現地調査', 0, 29], ['設計委託', 30, 119], ['設計書・積算', 100, 139]] },
      { n: '入札・契約', c: [['入札公告', 145], ['入札・開札', 165], ['契約締結', 175]] },
      { n: '工事', c: [['施工計画・近隣への周知', 176, 194], ['工事の施工', 195, 274], ['中間検査', 235]] },
      { n: '完了', c: [['完了検査', 280], ['引渡し・支払', 281, 299]] }
    ] },
  { id: 'notice', cat: 'event', name: '制度改正の周知・窓口準備', unit: 'third', days: 120, months: 4,
    desc: '法改正・新制度の開始に向けた準備。事務処理の見直し・広報・窓口の体制づくりまで（標準4か月）',
    tasks: [
      { n: '事務の準備', c: [['改正内容の整理', 0, 19], ['事務処理要領の改訂', 15, 44], ['システム改修の確認', 20, 59]] },
      { n: '周知', c: [['広報紙の原稿作成・掲載', 40, 69], ['チラシの作成・配布', 50, 79], ['ホームページ・SNSでの周知', 60, 119]] },
      { n: '窓口準備', c: [['様式・記載例の作成', 45, 74], ['想定問答（FAQ）の作成', 70, 94], ['職員説明会', 85]] },
      { n: '開始', c: [['新制度の開始', 100], ['問合せ対応・振り返り', 101, 119]] }
    ] },
  // v1.7.0: メンバーの要望（契約管理・広報・教育委員会・工事）で追加
  { id: 'pr', cat: 'event', name: '広報紙の特集記事', unit: 'week', days: 90, months: 3,
    desc: '広報紙の特集ページ。企画・掲載枠の調整から取材・原稿・関係課の確認・校正を経て、発行とホームページ掲載まで（標準3か月）',
    tasks: [
      { n: '企画', c: [['特集テーマの決定・掲載枠の調整', 0, 13], ['取材先への依頼・日程調整', 7, 20]] },
      { n: '取材・原稿', c: [['取材・写真撮影', 21, 34], ['写真・データなど素材の確認', 30, 39], ['原稿の作成', 28, 44], ['関係課の確認・決裁', 45, 51]] },
      { n: '校正', c: [['入稿', 52], ['初校・再校の確認', 53, 62], ['校了', 63]] },
      { n: '発行', c: [['印刷・配布', 64, 74], ['ホームページ・SNSへの掲載', 75, 89]] }
    ] },
  { id: 'press', cat: 'event', name: '報道発表（記者発表・資料提供）', unit: 'day', days: 30, months: 1,
    desc: '報道機関への発表。発表の方針・日時の調整、資料・想定問答の作成、決裁を経て発表し、ホームページ掲載と取材対応まで（標準1か月）',
    tasks: [
      { n: '準備', c: [['発表の方針・日時の調整', 0, 6], ['発表資料の作成', 5, 12], ['想定問答の作成', 8, 14]] },
      { n: '確認', c: [['関係課の確認', 13, 15], ['決裁', 16, 17], ['記者クラブ・広報担当への予告', 18]] },
      { n: '発表', c: [['資料提供・記者発表', 20], ['ホームページへの掲載', 20, 22]] },
      { n: '発表後', c: [['取材対応', 21, 29], ['掲載記事の確認・記録', 23, 29]] }
    ] },
  { id: 'contract', cat: 'contract', name: '委託・賃貸借契約の年間管理', unit: 'month', days: 365, months: 12,
    desc: '毎年度の委託・賃貸借契約。契約から履行の確認・検査・支払と、並行して進める次期契約の準備まで（標準12か月）。検査や支払の時期は契約の条件に合わせて直してください',
    tasks: [
      { n: '契約', c: [['契約締結', 0], ['履行条件・連絡体制の確認', 1, 20]] },
      { n: '履行管理', c: [['履行の確認（契約で定める時期に）', 21, 339], ['変更契約の手続き（必要なとき）', 150, 179], ['中間検査（必要なとき）', 180]] },
      { n: '次期契約の準備', c: [['継続の要否・仕様の見直し', 150, 209], ['参考見積の徴取', 180, 219], ['予算要求', 210, 239],
        ['次期の調達手続き（入札・見積合わせ）', 290, 339], ['次期契約の締結', 355]] },
      { n: '完了・支払', c: [['完了報告の受理・完了検査', 340, 359], ['請求書の受理', 360], ['支払', 361, 364]] }
    ] },
  { id: 'building', cat: 'works', name: '建設工事（設計〜竣工・供用開始）', unit: 'month', days: 548, months: 18,
    desc: '公共施設の新築・大規模改修。基本設計・実施設計から入札・契約・施工・完成検査を経て供用開始まで（標準18か月）。仮契約と議会の議決は、条例で定める額以上の工事のときに必要です',
    tasks: [
      { n: '設計', c: [['基本設計', 0, 119], ['実施設計', 120, 239], ['関係機関との協議・許認可（建築確認など）', 200, 259]] },
      { n: '入札・契約', c: [['工事費の積算・予算の確保', 230, 269], ['入札公告', 275], ['入札・開札', 300], ['仮契約（議決が必要な工事のとき）', 305], ['議会の議決・本契約（議決が必要な工事のとき）', 320]] },
      { n: '施工', c: [['近隣への説明・施工の準備', 321, 334], ['着工', 335], ['工事の施工', 336, 499], ['中間検査', 420]] },
      { n: '完成', c: [['完成検査', 505], ['引渡し', 510], ['供用開始の準備・周知', 511, 546], ['供用開始', 547]] }
    ] },
  { id: 'school', cat: 'education', name: '新入学児童の就学事務（学齢簿〜入学式）', unit: 'half', days: 242, months: 8,
    desc: '翌年度の新1年生の就学事務。学齢簿の作成・就学時健康診断・入学通知・学校への引継ぎから入学式まで（9月開始の標準8か月）。学齢簿の基準日や通知の期限など、法令で決まった日付は実際の日程に直してください',
    tasks: [
      { n: '就学相談', c: [['就学相談・教育支援委員会', 0, 119]] },
      { n: '学齢簿', c: [['対象者の確認', 10, 29], ['学齢簿の作成（10月1日現在）', 30, 60], ['就学時健康診断の通知', 35, 50]] },
      { n: '就学時健康診断', c: [['就学時健康診断の実施', 45, 89], ['結果の通知・事後措置', 80, 110]] },
      { n: '就学校・入学通知', c: [['指定校変更・区域外就学の受付', 90, 170], ['入学通知書の発送', 145, 152], ['入学説明会（各学校）', 155, 180]] },
      { n: '入学', c: [['転出入の反映・学校への引継ぎ', 181, 205], ['入学の確認', 210, 225], ['入学式', 217]] }
    ] },
  { id: 'evaluation', cat: 'education', name: '教育委員会の点検・評価（報告書〜公表）', unit: 'half', days: 180, months: 6,
    desc: '前年度の教育行政の点検・評価。実績の照会・自己評価・学識経験者の意見から、議会への提出・公表まで（標準6か月）',
    tasks: [
      { n: '準備', c: [['前年度の事業実績の照会', 0, 29], ['各課の自己評価', 20, 59]] },
      { n: '評価', c: [['学識経験者の意見聴取', 60, 89], ['報告書（案）の作成', 75, 109]] },
      { n: '審議', c: [['教育委員会会議での審議', 115], ['報告書の修正', 116, 135]] },
      { n: '報告・公表', c: [['議会への提出', 140], ['ホームページでの公表', 145, 160], ['次年度の事業への反映', 150, 179]] }
    ] }
];

/* 既定の終了日: 開始日から暦の月で数える（4月1日開始の12か月 → 翌年3月31日）。テンプレート無しは12か月 */
function defaultTemplateEnd(tpl, start) {
  var p = parseISO(start), months = tpl ? tpl.months : 12;
  var y = p.y, m = p.mo + months;
  while (m > 12) { m -= 12; y += 1; }
  return clampDate(dayAdd(ymd(y, m, Math.min(p.d, lastDayOfMonth(y, m))), -1));
}
var TEMPLATE_MIN_DAYS = 14; // これより短い期間では工程が同じ日に集まってしまう

/* テンプレートを期間 [start, end] に比率で伸び縮みさせて展開する */
function instantiateTemplate(tpl, start, end) {
  var p = createEmptyProject();
  p.name = tpl.name;
  p.period = { start: start, end: end };
  var total = inclusiveDays(start, end), f = total / tpl.days;
  function off(x) { return Math.min(total - 1, Math.max(0, Math.floor(x * f))); }
  tpl.tasks.forEach(function (g) {
    var major = createTask('major', null);
    major.name = g.n;
    p.tasks.push(major);
    g.c.forEach(function (c) {
      var t = createTask('minor', major.id);
      t.name = c[0];
      var s = off(c[1]);
      if (c.length === 2) {
        t.isMilestone = true;
        t.plannedStart = t.plannedEnd = dayAdd(start, s);
      } else {
        var e = Math.max(s, Math.min(total - 1, Math.floor((c[2] + 1) * f) - 1));
        t.plannedStart = dayAdd(start, s);
        t.plannedEnd = dayAdd(start, e);
      }
      p.tasks.push(t);
    });
  });
  return p;
}

/* =========================================================================
 * 21. サンプルデータ（練習用。日付は基準日に合わせてずらし、いつ開いても「進行中」の状態になる）
 * ========================================================================= */
function buildSampleProject(anchor) {
  var shift = dayDiff(anchor, '2026-09-08');
  function D(s) { return s ? clampDate(dayAdd(s, shift)) : null; }
  var p = createEmptyProject();
  p.name = 'サンプルプロジェクト（新サービス立ち上げ）';
  function mkMajor(id, name, owner, start, end) {
    var t = createTask('major', null);
    t.id = id; t.name = name; t.owner = owner; t.plannedStart = D(start); t.plannedEnd = D(end);
    p.tasks.push(t);
  }
  function mkMinor(id, parentId, name, owner, start, end, progress, opts) {
    opts = opts || {};
    var t = createTask('minor', parentId);
    t.id = id; t.name = name; t.owner = owner; t.plannedStart = D(start); t.plannedEnd = D(opts.milestone ? start : end);
    t.progress = progress; t.isMilestone = !!opts.milestone; t.predecessors = opts.pred || [];
    t.baselineStart = D(opts.baseStart); t.baselineEnd = D(opts.baseEnd); t.memo = opts.memo || '';
    p.tasks.push(t);
  }
  // 日付はFS制約を満たすよう組んである。smp-2-4 だけ意図的に制約違反させ、読込直後の自動調整を実演する。
  mkMajor('smp-maj1', '要件定義・設計', '田中彩', '2026-06-01', '2026-07-12');
  mkMinor('smp-1-1', 'smp-maj1', '要件ヒアリング', '田中彩', '2026-06-01', '2026-06-10', 100, { baseStart: '2026-06-01', baseEnd: '2026-06-10' });
  mkMinor('smp-1-2', 'smp-maj1', '要件定義書作成', '田中彩', '2026-06-11', '2026-06-23', 100, { pred: ['smp-1-1'] });
  mkMinor('smp-1-3', 'smp-maj1', '基本設計', '佐々木亮', '2026-06-24', '2026-07-11', 100, { pred: ['smp-1-2'] });
  mkMinor('smp-1-4', 'smp-maj1', '要件定義完了', '田中彩', '2026-07-12', '2026-07-12', 100, { milestone: true, pred: ['smp-1-3'] });
  mkMinor('smp-1-5', 'smp-maj1', 'デザインレビュー', '片山結', '2026-06-25', '2026-06-28', 100, {});
  mkMajor('smp-maj2', '開発', '佐々木亮', '2026-07-13', '2026-08-26');
  mkMinor('smp-2-1', 'smp-maj2', '詳細設計', '佐々木亮', '2026-07-13', '2026-07-24', 100, { pred: ['smp-1-4'] });
  mkMinor('smp-2-2', 'smp-maj2', 'フロントエンド実装', '鈴木海斗', '2026-07-25', '2026-08-26', 40, { pred: ['smp-2-1'], baseStart: '2026-07-25', baseEnd: '2026-08-10', memo: '要件追加により遅延中' });
  mkMinor('smp-2-3', 'smp-maj2', 'バックエンド実装', '高橋美咲', '2026-07-25', '2026-08-19', 80, { pred: ['smp-2-1'], baseStart: '2026-07-25', baseEnd: '2026-08-25' });
  mkMinor('smp-2-4', 'smp-maj2', '結合テスト', '山本健', '2026-08-18', '2026-08-25', 20, { pred: ['smp-2-2', 'smp-2-3'], baseStart: '2026-08-18', baseEnd: '2026-08-25' });
  mkMajor('smp-maj3', 'リリース準備', '山本健', null, null);
  mkMinor('smp-3-1', 'smp-maj3', 'ユーザー受入テスト', '山本健', '2026-09-04', '2026-09-13', 60, { pred: ['smp-2-4'] });
  mkMinor('smp-3-2', 'smp-maj3', 'バグ修正', '鈴木海斗', '2026-09-14', '2026-09-21', 0, { pred: ['smp-3-1'] });
  mkMinor('smp-3-3', 'smp-maj3', 'リリース', '山本健', '2026-09-22', '2026-09-22', 0, { milestone: true, pred: ['smp-3-2'] });
  mkMinor('smp-3-4', 'smp-maj3', 'ドキュメント整備', '田中彩', '2026-09-08', '2026-09-18', 0, {});
  var bl = D('2026-06-01');
  p.baselineSavedAt = bl + 'T00:00:00.000Z';
  return p;
}

function loadSampleProject() {
  confirmReplaceIfDirty('サンプルを読み込む').then(function (ok) {
    if (!ok) return;
    // ファイルに保存していないので未保存として扱う（テンプレートからの新規作成と同じ）
    replaceProject('サンプルの読み込み', buildSampleProject(state.ui.referenceDate), null, false, true);
    showToast('サンプルを読み込みました（元に戻すで取り消せます）。大事業の ▶ か「すべて展開」で小事業を表示できます。', 'info', 6500);
  });
}

/* =========================================================================
 * 22. 初期化
 * ========================================================================= */
function wireToolbar() {
  function on(id, ev, fn) { document.getElementById(id).addEventListener(ev, fn); }
  on('btn-new', 'click', actionNew);
  on('btn-open', 'click', actionOpen);
  on('file-input', 'change', function (ev) { actionOpenFileSelected(ev.target.files && ev.target.files[0]); ev.target.value = ''; });
  on('btn-save', 'click', actionSave);
  on('btn-undo', 'click', undo);
  on('btn-redo', 'click', redo);
  on('btn-add-major', 'click', openAddMajorForm);
  on('btn-add-minor', 'click', function () {
    var fid = state.ui.focusTaskId, t = fid ? getTaskById(fid) : null;
    openAddMinorForm(t ? (t.level === 'major' ? t.id : t.parentId) : null);
  });
  on('btn-export-pdf', 'click', openPrintDialog);
  on('btn-export-excel', 'click', actionExportExcel);
  on('btn-save-baseline', 'click', actionSaveBaseline);
  on('scale-select', 'change', function (ev) { state.ui.scale = ev.target.value; renderAll(); scheduleLocalSave(); });
  on('btn-period', 'click', openPeriodDialog);
  on('detail-mode', 'change', function (ev) {
    state.ui.detailMode = ev.target.checked;
    if (!state.ui.detailMode) state.ui.filterStatus = ''; // 隠す絞り込みは解除する
    renderAll(); scheduleLocalSave();
  });
  on('reference-date-input', 'change', function (ev) { actionSetReferenceDate(ev.target.value); });
  on('btn-today', 'click', function () { actionSetReferenceDate(todayStr()); });
  on('btn-expand-all', 'click', function () { setAllExpanded(true); });
  on('btn-collapse-all', 'click', function () { setAllExpanded(false); });
  on('filter-owner', 'change', function (ev) { state.ui.filterOwner = ev.target.value; renderAll(); });
  on('filter-status', 'change', function (ev) { state.ui.filterStatus = ev.target.value; renderAll(); });
  on('btn-workload', 'click', openWorkloadDialog);
  on('btn-load-sample', 'click', loadSampleProject);
  on('btn-clear-local', 'click', actionClearLocal);
  on('btn-empty-new', 'click', function () { actionNew('template'); });
  on('btn-empty-open', 'click', actionOpen);
  on('btn-empty-add-major', 'click', openAddMajorForm);
  on('btn-empty-load-sample', 'click', loadSampleProject);
  var nameInput = document.getElementById('project-name-input');
  nameInput.addEventListener('change', commitProjectNameInput);
  nameInput.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') nameInput.blur(); });
}

/* 工程表を差し替えたときは、入力中でも名前の欄を書き直す（描画は入力中の欄を上書きしないため。
   古い名前が残ると、保存前の取り込み（commitProjectNameInput）で差し替え後の工程表へ入ってしまう） */
function syncProjectNameInput() {
  var input = typeof document !== 'undefined' && document.getElementById('project-name-input');
  if (input) input.value = state.project.name || '';
}
function normalizeProjectName(v) { return String(v || '').trim().slice(0, MAX_PROJECT_NAME_LEN); }
/* 入力欄の名前を工程表へ取り込む。change は入力欄を離れるまで起きないため、入力中の Ctrl+S や
   保存・出力の直前にも呼んで、入力中の名前が保存から漏れないようにする */
function commitProjectNameInput() {
  var input = document.getElementById('project-name-input');
  if (!input) return;
  var v = normalizeProjectName(input.value);
  applyMutation('プロジェクト名の変更', function (p) { if (p.name === v) return false; p.name = v; });
}

function wireGlobalKeys() {
  document.addEventListener('keydown', function (ev) {
    if (dialogStack.length > 0) return; // ダイアログ内のキーはダイアログが処理する
    if (ev.key === 'Escape') { cancelDrag(); closeMenu(); return; }
    var t = ev.target, inField = t && t.matches && t.matches('input, select, textarea');
    if (ev.isComposing || ev.keyCode === 229) return; // 日本語の変換中は、確定前の文字を保存しない
    var mod = ev.ctrlKey || ev.metaKey, k = ev.key.toLowerCase();
    if (mod && !ev.altKey && k === 'z' && !inField) { ev.preventDefault(); if (ev.shiftKey) redo(); else undo(); }
    else if (mod && !ev.altKey && k === 'y' && !inField) { ev.preventDefault(); redo(); }
    else if (mod && !ev.altKey && k === 's') { ev.preventDefault(); actionSave(); }
  });
  document.addEventListener('pointerdown', function (ev) {
    if (openMenuCtx && !openMenuCtx.menu.contains(ev.target) && !openMenuCtx.anchor.contains(ev.target)) closeMenu();
  }, true);
  window.addEventListener('storage', function (ev) {
    var area;
    try { area = window.localStorage; } catch (e) { return; }
    if (ev.storageArea && ev.storageArea !== area) return; // sessionStorage の変化は対象外
    if (!classifyStorageEvent(ev.key)) return;
    checkAutosaveConflict();
  });
  // 戻る操作でキャッシュから復帰したタブや、裏にあったタブには通知が遅れて届くことがあるため、表に出たときも確かめる
  window.addEventListener('pageshow', function (ev) { if (ev.persisted) checkAutosaveConflict(); });
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') checkAutosaveConflict(); });
  window.addEventListener('beforeunload', function (ev) {
    commitProjectNameInput(); // 名前を入力したまま閉じる場合も、控えと離脱の確認に入れる
    if (localSaveTimer) { clearTimeout(localSaveTimer); saveToLocalStorageNow(); }
    if (saveInfo.dirty) { ev.preventDefault(); ev.returnValue = ''; } // 内容が空でも、未保存の変更（全削除など）があれば確かめる
  });
}

function init() {
  var hadLocal = loadFromLocalStorageIfAny();
  if (!recoveryInfo) {
    try {
      var rec = localStorage.getItem(STORAGE_KEY_RECOVERY);
      if (rec) recoveryInfo = { reason: '以前の起動時に読み込めなかったデータ', text: rec };
    } catch (e) { /* ストレージが使えない環境では何もしない */ }
  }
  wireToolbar();
  wireScrollSync();
  wireSplitter();
  wireGlobalKeys();
  recompute({ silent: true });
  renderLegend();
  renderAll();
  renderAutosaveConflict();
  function showStartupWarnings() { startupWarnings.forEach(function (w) { showToast(w, 'warning', 9000); }); }
  // 退避データ・競合の知らせがあるときは、その知らせ（画面上部）を先に読めるよう入口を出さない
  if (!recoveryInfo && !autosaveConflict) {
    openStartDialog(hadLocal, showStartupWarnings); // 警告は入口を閉じてから出す（読む前に消えないように）
    return;
  }
  if (hadLocal) {
    var collapsedWithKids = getMajors().some(function (m) { return !state.ui.expandedMajors.has(m.id) && getChildrenOf(m.id).length > 0; });
    showToast('前回の自動保存データを復元しました。' + (collapsedWithKids ? '小事業は大事業の ▶ で表示できます。' : ''), 'info', 5000);
  }
  showStartupWarnings();
}

if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('DOMContentLoaded', init);
}

/* Node.jsからのテスト実行用エクスポート（ブラウザでは module が未定義のため無害）。tests/*.test.js で使用する。 */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    // 日付・祝日
    isValidDateString: isValidDateString, isAppDate: isAppDate, dayDiff: dayDiff, inclusiveDays: inclusiveDays, dayAdd: dayAdd,
    toEpochDay: toEpochDay, fromEpochDay: fromEpochDay, holidayNameOf: holidayNameOf, isWeekend: isWeekend,
    computeHolidaysOfYear: computeHolidaysOfYear, holidaysOfYear: holidaysOfYear, formatLocalDateTime: formatLocalDateTime,
    DATE_MIN: DATE_MIN, DATE_MAX: DATE_MAX,
    // 計算エンジン
    computeEffectivePeriod: computeEffectivePeriod, computeMajorRawProgress: computeMajorRawProgress,
    computeDelayStatus: computeDelayStatus, computeBaselineDiff: computeBaselineDiff,
    requiredMinStart: requiredMinStart, applyFsConstraint: applyFsConstraint, applyAutoSlideAll: applyAutoSlideAll,
    detectCycle: detectCycle, topologicalSortSafe: topologicalSortSafe, computeCriticalPath: computeCriticalPath,
    isCriticalEdge: isCriticalEdge, transitiveSuccessorsOf: transitiveSuccessorsOf,
    findCycleIfPredecessorsSet: findCycleIfPredecessorsSet,
    recomputeAll: recomputeAll, computeWbsNumbers: computeWbsNumbers, rangeOf: rangeOf,
    // データモデル・検証
    createTask: createTask, createEmptyProject: createEmptyProject, validateWbsprojText: validateWbsprojText,
    checkWbsprojSaveSize: checkWbsprojSaveSize, buildSaveText: buildSaveText, progressOptionsFor: progressOptionsFor,
    MAX_FILE_SIZE: MAX_FILE_SIZE, STORAGE_KEY_PROJECT: STORAGE_KEY_PROJECT,
    SCALE_ORDER: SCALE_ORDER, SCALE_LABELS: SCALE_LABELS, groupBucketsForScale: groupBucketsForScale,
    snapRangeToBuckets: snapRangeToBuckets, unionPeriod: unionPeriod, planDeltaOf: planDeltaOf,
    TEMPLATES: TEMPLATES, TEMPLATE_CATEGORIES: TEMPLATE_CATEGORIES, instantiateTemplate: instantiateTemplate, EXCEL_BASELINE_ROWS: EXCEL_BASELINE_ROWS,
    buildRowModels: buildRowModels, APP_VERSION: APP_VERSION,
    parseAutosaveMeta: parseAutosaveMeta, autosaveFailureMessage: autosaveFailureMessage, clearLocalData: clearLocalData,
    serializeProjectData: serializeProjectData, buildSaveFilename: buildSaveFilename, defaultTemplateEnd: defaultTemplateEnd,
    isJsonFileName: isJsonFileName, chooseAutosaveText: chooseAutosaveText,
    buildSampleProject: buildSampleProject, sanitizeFilenamePart: sanitizeFilenamePart,
    // v1.7.0
    historyPush: historyPush, historyUndo: historyUndo, historyRedo: historyRedo,
    normalizeProjectName: normalizeProjectName, buildExportFilename: buildExportFilename,
    saveStateKind: saveStateKind, fileOpenDecision: fileOpenDecision,
    // xlsx
    crc32: crc32, buildZip: buildZip, buildZipAsync: buildZipAsync, escapeXml: escapeXml,
    buildXlsxBytes: buildXlsxBytes, buildXlsxBytesAsync: buildXlsxBytesAsync, buildXlsxFiles: buildXlsxFiles,
    excelPreflight: excelPreflight, buildExcelRows: buildExcelRows, colLetter: colLetter,
    computeGanttDateRange: computeGanttDateRange, buildDateBuckets: buildDateBuckets,
    computeGanttColumns: computeGanttColumns, groupBucketsByMonth: groupBucketsByMonth,
    mergeRefsForGroups: mergeRefsForGroups, computeCutoffEpoch: computeCutoffEpoch,
    isBucketDark: isBucketDark, findBucketIndexContaining: findBucketIndexContaining,
    baseStyleKeyForBucket: baseStyleKeyForBucket, statusStyleKeyFor: statusStyleKeyFor,
    buildGanttCellsForRow: buildGanttCellsForRow, createStyleRegistry: createStyleRegistry,
    buildStyleRegistry: buildStyleRegistry, buildStylesXml: buildStylesXml,
    buildRowModels: buildRowModels, buildSheetXml: buildSheetXml,
    // v1.5
    SCHEMA_VERSION: SCHEMA_VERSION, TENTATIVE_PREFIX: TENTATIVE_PREFIX,
    createTargetForRow: createTargetForRow, snapCreatedRange: snapCreatedRange, insertIndexForNewMinor: insertIndexForNewMinor,
    // v1.6.0
    classifyStorageEvent: classifyStorageEvent, readAutosaveSnapshot: readAutosaveSnapshot, writeAutosave: writeAutosave,
    autosaveFingerprint: autosaveFingerprint, buildAutosaveMeta: buildAutosaveMeta, planReloadLatest: planReloadLatest,
    STORAGE_KEY_LEGACY_IMPORTED: STORAGE_KEY_LEGACY_IMPORTED,
    STORAGE_KEY_META: STORAGE_KEY_META
  };
}

})(typeof window !== 'undefined' ? window : globalThis);
