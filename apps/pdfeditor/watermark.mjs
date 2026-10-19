// Watermarks are stored separately from editable figures and use displayed page points.
export const WATERMARK_PRESETS = [
  "取扱注意",
  "部外秘",
  "庁内限り",
  "案",
  "参考",
  "見本",
  "DRAFT",
];

export const WATERMARK_ANGLES = [-45, 0, 45];

function displaySize(page) {
  const rotation = (((Number(page.baseRotation) || 0) + (Number(page.rotationExtra) || 0)) % 360 + 360) % 360;
  return rotation === 90 || rotation === 270
    ? { width: page.height, height: page.width }
    : { width: page.width, height: page.height };
}

function normalizeSettings(settings) {
  const text = String(settings.text ?? "").trim();
  const color = String(settings.color ?? "");
  const opacity = Number(settings.opacity);
  const fontSize = Number(settings.fontSize);
  const angle = Number(settings.angle);

  if (!text) throw new Error("透かし文字を入力してください。");
  if (text.length > 40 || /[\r\n]/.test(text))
    throw new Error("透かし文字は40文字以内の1行で入力してください。");
  if (!/^#[0-9a-f]{6}$/i.test(color))
    throw new Error("透かしの色を選択してください。");
  if (!Number.isFinite(opacity) || opacity < 0.1 || opacity > 0.8)
    throw new Error("不透明度は10〜80%の範囲で指定してください。");
  if (!Number.isFinite(fontSize) || fontSize < 24 || fontSize > 120 || fontSize % 2 !== 0)
    throw new Error("文字サイズは24〜120ptの範囲で2pt刻みに指定してください。");
  if (!WATERMARK_ANGLES.includes(angle))
    throw new Error("角度を選択してください。");

  return { text, color, opacity, fontSize, angle };
}

export function watermarkAnnotation(page, measureText) {
  if (!page?.watermark) return null;
  const settings = normalizeSettings(page.watermark);
  const { width, height } = displaySize(page);
  const measuredWidth = Number(measureText(settings.text, settings.fontSize));
  if (![width, height, measuredWidth].every(Number.isFinite) || width <= 0 || height <= 0 || measuredWidth < 0)
    throw new Error("透かしの描画を準備できませんでした。");

  const padding = 8;
  const w = Math.ceil(measuredWidth) + padding * 2;
  const h = Math.ceil(settings.fontSize * 1.32) + padding * 2;
  const radians = Math.abs(settings.angle) * Math.PI / 180;
  const rotatedWidth = Math.abs(w * Math.cos(radians)) + Math.abs(h * Math.sin(radians));
  const rotatedHeight = Math.abs(w * Math.sin(radians)) + Math.abs(h * Math.cos(radians));
  const margin = Math.min(24, width / 20, height / 20);

  if (rotatedWidth + margin * 2 > width || rotatedHeight + margin * 2 > height)
    throw new Error("透かしが用紙に収まりません。文字サイズを小さくするか、文字を短くしてください。");

  return {
    type: "text",
    text: settings.text,
    x: (width - w) / 2,
    y: (height - h) / 2,
    w,
    h,
    fontSize: settings.fontSize,
    fontFamily: "arial",
    color: settings.color,
    bold: true,
    bgTransparent: true,
    outline: false,
    opacity: settings.opacity,
    rotation: settings.angle,
    watermark: true,
  };
}

export function createWatermarkPlan(pages, selectedPageIds, settings, measureText) {
  const normalized = normalizeSettings(settings);
  const scope = settings.scope === "selected" ? "selected" : "all";
  const selected = new Set(selectedPageIds || []);
  const targets = scope === "selected"
    ? pages.filter(page => selected.has(page.id))
    : [...pages];

  if (!targets.length)
    throw new Error(scope === "selected" ? "透かしを付けるページを選択してください。" : "対象ページがありません。");

  const entries = targets.map(page => {
    const watermark = { ...normalized };
    let annotation;
    try {
      annotation = watermarkAnnotation({ ...page, watermark }, measureText);
    } catch (error) {
      const index = pages.findIndex(item => item.id === page.id);
      throw new Error(`${index + 1}ページ目：${error.message}`);
    }
    return { pageId: page.id, watermark, annotation };
  });

  return { scope, count: entries.length, entries, text: normalized.text };
}

export function replaceWatermarks(pages, plan) {
  const values = new Map(plan.entries.map(({ pageId, watermark }) => [pageId, watermark]));
  return pages.map(page => values.has(page.id)
    ? { ...page, watermark: { ...values.get(page.id) } }
    : page);
}

export function removeWatermarks(pages, pageIds) {
  const targets = new Set(pageIds || []);
  return pages.map(page => {
    if (!targets.has(page.id) || !page.watermark) return page;
    const copy = { ...page };
    delete copy.watermark;
    return copy;
  });
}
