// Stamps are rendered to a PNG once and placed as image annotations.
// This module keeps the settings, date expansion, layout and template files testable.
export const MM_TO_PT = 72 / 25.4;
export const STAMP_TEMPLATE_FORMAT = "appbox-pdfeditor-stamp-templates";
export const STAMP_TEMPLATE_VERSION = 1;
export const MAX_STAMP_TEMPLATES = 50;
export const MAX_STAMP_TEMPLATE_FILE_BYTES = 200 * 1024;
export const STAMP_DATE_FORMATS = ["seireki", "wareki", "wareki-kanji"];
export const STAMP_BORDER_WIDTHS = [1, 1.5, 2.5];

const MAX_LINES = 3;
const MAX_LINE_LENGTH = 20;
const MAX_NAME_LENGTH = 40;
const MIN_SIZE_MM = 8;
const MAX_SIZE_MM = 60;
const MIN_FONT_SIZE = 3;

const preset = (name, shape, widthMm, heightMm, lines, extra = {}) => ({
  name, shape, widthMm, heightMm, lines, dateFormat: "seireki", color: "#d7261e",
  borderWidth: 1.5, fill: "none", justify: true, dividers: false, ...extra,
});

export const STAMP_PRESETS = [
  preset("承認", "ellipse", 15, 15, ["承認"]),
  preset("確認", "ellipse", 15, 15, ["確認"]),
  preset("済", "ellipse", 12, 12, ["済"]),
  preset("回覧", "rect", 24, 12, ["回覧"]),
  preset("至急", "rect", 24, 12, ["至急"]),
  preset("受付（日付）", "rect", 30, 18, ["受付", "{date}"], { justify: false }),
  preset("日付印（所属・氏名）", "ellipse", 18, 18, ["所属名", "{date}", "氏名"],
    { dateFormat: "wareki", borderWidth: 1, justify: false, dividers: true }),
];

function text(value, max, label) {
  const result = String(value ?? "");
  if (/[\r\n\t]/.test(result) || [...result].length > max)
    throw new Error(`${label}は${max}文字以内の1行で入力してください。`);
  return result;
}

export function normalizeStampSettings(settings) {
  if (!settings || typeof settings !== "object") throw new Error("スタンプの設定を読み込めませんでした。");
  const name = text(settings.name, MAX_NAME_LENGTH, "テンプレート名").trim();
  const shape = settings.shape === "ellipse" ? "ellipse" : settings.shape === "rect" ? "rect" : null;
  if (!shape) throw new Error("スタンプの形を選択してください。");
  const widthMm = Number(settings.widthMm), heightMm = Number(settings.heightMm);
  for (const value of [widthMm, heightMm])
    if (!Number.isFinite(value) || value < MIN_SIZE_MM || value > MAX_SIZE_MM || !Number.isInteger(value * 2))
      throw new Error(`スタンプの幅と高さは${MIN_SIZE_MM}〜${MAX_SIZE_MM}mmの範囲で0.5mm刻みに指定してください。`);
  if (!Array.isArray(settings.lines)) throw new Error("スタンプの文字を入力してください。");
  const lines = settings.lines.map(line => text(line, MAX_LINE_LENGTH, "スタンプの各行").trim());
  if (lines.length > MAX_LINES) throw new Error(`スタンプの文字は${MAX_LINES}行以内にしてください。`);
  if (!lines.length || lines.every(line => !line)) throw new Error("スタンプの文字を入力してください。");
  const dateFormat = STAMP_DATE_FORMATS.includes(settings.dateFormat) ? settings.dateFormat : null;
  if (!dateFormat) throw new Error("日付の書式を選択してください。");
  const color = String(settings.color ?? "");
  if (!/^#[0-9a-f]{6}$/i.test(color)) throw new Error("スタンプの色を選択してください。");
  const borderWidth = Number(settings.borderWidth);
  if (!STAMP_BORDER_WIDTHS.includes(borderWidth)) throw new Error("枠線の太さを選択してください。");
  const fill = settings.fill === "white" ? "white" : settings.fill === "none" ? "none" : null;
  if (!fill) throw new Error("背景を選択してください。");
  return { name, shape, widthMm, heightMm, lines, dateFormat, color: color.toLowerCase(), borderWidth,
    fill, justify: settings.justify === true, dividers: settings.dividers === true };
}

const pad2 = value => String(value).padStart(2, "0");

function japaneseEra(date) {
  const y = date.getFullYear(), m = date.getMonth() + 1, d = date.getDate();
  const key = y * 10000 + m * 100 + d;
  if (key >= 20190501) return { name: "令和", initial: "R", year: y - 2018 };
  if (key >= 19890108) return { name: "平成", initial: "H", year: y - 1988 };
  return null;
}

export function formatStampDate(date, format) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) throw new Error("日付を取得できませんでした。");
  const y = date.getFullYear(), m = date.getMonth() + 1, d = date.getDate();
  if (format === "seireki") return `${y}.${pad2(m)}.${pad2(d)}`;
  const era = japaneseEra(date);
  if (!era) return `${y}.${pad2(m)}.${pad2(d)}`;
  if (format === "wareki") return `${era.initial}${era.year}.${m}.${d}`;
  if (format === "wareki-kanji") return `${era.name}${era.year === 1 ? "元" : era.year}年${m}月${d}日`;
  throw new Error("日付の書式を選択してください。");
}

export function expandStampLines(lines, date, format) {
  const formatted = formatStampDate(date, format);
  return lines.map(line => line.replaceAll("{date}", formatted));
}

// Width of the shape at a distance dy (points) from its vertical center.
function chordWidth(settings, size, inset, dy) {
  const halfWidth = size.width / 2 - inset;
  if (settings.shape === "rect") return halfWidth * 2;
  const halfHeight = size.height / 2 - inset;
  const ratio = Math.min(1, Math.abs(dy) / halfHeight);
  return halfWidth * 2 * Math.sqrt(1 - ratio * ratio);
}

/*
 * Lays out each line inside its own row. Font sizes shrink per line until the
 * text fits the shape at that row; justified lines spread characters evenly.
 * measure(text, fontSize) returns the advance width in points.
 */
export function layoutStamp(settings, lines, measure) {
  const size = { width: settings.widthMm * MM_TO_PT, height: settings.heightMm * MM_TO_PT };
  const inset = settings.borderWidth + Math.min(size.width, size.height) * 0.06;
  const rowHeight = (size.height - inset * 2) / lines.length;
  const centerY = size.height / 2;
  const rows = lines.map((line, index) => {
    const rowCenter = inset + rowHeight * (index + 0.5);
    const chars = [...line];
    if (!chars.length) return { text: line, fontSize: 0, centerY: rowCenter, chars: [] };
    let fontSize = rowHeight * 0.78, available = 0;
    // Recompute the available width after each shrink: a smaller font fits a wider chord of an ellipse.
    for (let i = 0; i < 24; i++) {
      const edge = Math.abs(rowCenter - centerY) + fontSize / 2;
      available = chordWidth(settings, size, inset, edge) * 0.92;
      const width = Number(measure(line, fontSize));
      if (!Number.isFinite(width) || width < 0) throw new Error("スタンプの文字を配置できませんでした。");
      if (width <= available + 0.01 || fontSize === MIN_FONT_SIZE) break;
      fontSize = Math.max(MIN_FONT_SIZE, fontSize * Math.max(0.5, available / width) * 0.995);
    }
    const widths = chars.map(ch => Number(measure(ch, fontSize)));
    const natural = widths.reduce((sum, value) => sum + value, 0);
    if (natural > available + 0.5)
      throw new Error(`${index + 1}行目の文字がスタンプに収まりません。文字を短くするか、サイズを大きくしてください。`);
    const spread = settings.justify && chars.length > 1
      ? Math.min((available * 0.86 - natural) / (chars.length - 1), fontSize * 0.9)
      : 0;
    const gap = Math.max(0, spread);
    const total = natural + gap * (chars.length - 1);
    let x = (size.width - total) / 2;
    const placed = chars.map((ch, i) => {
      const item = { ch, x };
      x += widths[i] + gap;
      return item;
    });
    return { text: line, fontSize, centerY: rowCenter, chars: placed };
  });
  const dividers = settings.dividers && lines.length > 1
    ? Array.from({ length: lines.length - 1 }, (_, i) => {
        const y = inset + rowHeight * (i + 1);
        const width = chordWidth(settings, size, settings.borderWidth / 2, y - centerY);
        return { y, x1: (size.width - width) / 2, x2: (size.width + width) / 2 };
      })
    : [];
  return { width: size.width, height: size.height, inset, rows, dividers };
}

export function serializeStampTemplates(templates) {
  const list = templates.map(template => {
    const normalized = normalizeStampSettings(template);
    if (!normalized.name) throw new Error("テンプレート名を入力してください。");
    return normalized;
  });
  if (list.length > MAX_STAMP_TEMPLATES)
    throw new Error(`テンプレートは${MAX_STAMP_TEMPLATES}件までです。`);
  return `${JSON.stringify({ format: STAMP_TEMPLATE_FORMAT, version: STAMP_TEMPLATE_VERSION, templates: list }, null, 2)}\n`;
}

export function parseStampTemplates(source) {
  let data;
  try {
    data = JSON.parse(String(source).replace(/^\uFEFF/, ""));
  } catch {
    throw new Error("スタンプのテンプレートファイルを読み込めませんでした。");
  }
  if (data?.format !== STAMP_TEMPLATE_FORMAT || !Array.isArray(data.templates))
    throw new Error("PDFかんたん編集のスタンプテンプレートファイルを選択してください。");
  if (data.version !== STAMP_TEMPLATE_VERSION)
    throw new Error("このバージョンでは読み込めないテンプレートファイルです。");
  if (data.templates.length > MAX_STAMP_TEMPLATES)
    throw new Error(`テンプレートは${MAX_STAMP_TEMPLATES}件までです。`);
  return data.templates.map((template, index) => {
    try {
      const normalized = normalizeStampSettings(template);
      if (!normalized.name) throw new Error("テンプレート名がありません。");
      return normalized;
    } catch (error) {
      throw new Error(`${index + 1}件目のテンプレート：${error.message}`);
    }
  });
}

// Later templates replace earlier ones with the same name.
export function mergeStampTemplates(current, loaded) {
  const byName = new Map(current.map(template => [template.name, template]));
  for (const template of loaded) byName.set(template.name, template);
  if (byName.size > MAX_STAMP_TEMPLATES)
    throw new Error(`テンプレートは${MAX_STAMP_TEMPLATES}件までです。`);
  return [...byName.values()];
}
