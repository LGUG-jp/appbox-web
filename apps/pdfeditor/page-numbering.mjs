// Page numbers are separate from editable figures and use displayed page points.
export const PAGE_NUMBER_POSITIONS = [
  "top-left", "top-center", "top-right",
  "bottom-left", "bottom-center", "bottom-right",
];
// "same" keeps one position; the mirrors swap it on even printed numbers (left/right or top/bottom).
export const PAGE_NUMBER_LAYOUTS = ["same", "mirror-x", "mirror-y"];
export const PAGE_NUMBER_FORMATS = ["number", "number-last", "dash"];
// Explicit margins are millimetres from the paper edge to the text box; omitted means the automatic margin.
export const PAGE_NUMBER_MARGIN_MM = { min: 3, max: 50, step: 0.5, initial: 10 };
export const PAGE_NUMBER_FONT = "arial";
const PADDING = 4;
const MM_TO_PT = 72 / 25.4;

export function resolvePageNumberPosition(position, layout = "same", number = 1) {
  if (layout === "same" || number % 2 === 1) return position;
  const [vertical, horizontal] = position.split("-");
  if (layout === "mirror-x")
    return `${vertical}-${{ left: "right", right: "left" }[horizontal] ?? horizontal}`;
  return `${vertical === "top" ? "bottom" : "top"}-${horizontal}`;
}

export function pageNumberText({ number, format = "number", lastNumber }) {
  if (format === "number-last") return `${number} / ${lastNumber}`;
  if (format === "dash") return `- ${number} -`;
  return String(number);
}

export function pageNumberAnnotation(page, measureText) {
  if (!page.pageNumber) return null;
  const { number, fontSize, position, layout, marginX, marginY } = page.pageNumber;
  const rotation = ((page.baseRotation + page.rotationExtra) % 360 + 360) % 360;
  const [width, height] = rotation === 90 || rotation === 270
    ? [page.height, page.width] : [page.width, page.height];
  const text = pageNumberText(page.pageNumber);
  const measuredWidth = measureText(text, fontSize);
  const w = Math.ceil(measuredWidth) + PADDING * 2 + 1;
  const h = Math.ceil(fontSize * 1.32) + PADDING * 2;
  // The automatic margin reaches the padded box and shrinks on small paper; explicit margins never shrink.
  const explicit = marginX !== undefined;
  const auto = Math.min(72 / 2.54, width / 10, height / 10);
  const mx = explicit ? marginX * MM_TO_PT - PADDING : auto;
  const my = explicit ? marginY * MM_TO_PT - PADDING : auto;
  if (![width, height, measuredWidth].every(Number.isFinite) ||
      measuredWidth < 0 || width <= 0 || height <= 0 ||
      w + mx * 2 > width || h + my * 2 > height) {
    throw new Error(explicit
      ? "ページ番号が用紙に収まりません。余白か文字サイズを小さくしてください。"
      : "ページ番号が用紙に収まりません。文字サイズを小さくしてください。");
  }
  const [vertical, horizontal] = resolvePageNumberPosition(position, layout, number).split("-");
  const x = horizontal === "left" ? mx
    : horizontal === "right" ? width - mx - w : (width - w) / 2;
  const y = vertical === "top" ? my : height - my - h;
  return {
    type: "text", text, x, y, w, h, fontSize, fontFamily: PAGE_NUMBER_FONT,
    color: "#000000", bold: false, bgTransparent: true, outline: false,
  };
}

function validMargin(value) {
  const { min, max, step } = PAGE_NUMBER_MARGIN_MM;
  return Number.isFinite(value) && value >= min && value <= max && Number.isInteger(value / step);
}

export function createPageNumberPlan(pages, settings, measureText) {
  const { startPage, startNumber, fontSize, position, layout = "same", format = "number", marginX, marginY } = settings;
  if (!Number.isInteger(startPage) || startPage < 1 || startPage > pages.length)
    throw new Error(`開始ページは1〜${pages.length}の整数で指定してください。`);
  const count = pages.length - startPage + 1;
  if (!Number.isInteger(startNumber) || startNumber < 0 || startNumber + count - 1 > 999999)
    throw new Error("ページ番号は0〜999999に収まる整数で指定してください。");
  if (!Number.isFinite(fontSize) || fontSize < 6 || fontSize > 72 || !Number.isInteger(fontSize * 2))
    throw new Error("文字サイズは6〜72ptの範囲で0.5pt刻みに指定してください。");
  if (!PAGE_NUMBER_POSITIONS.includes(position))
    throw new Error("ページ番号の表示位置を選択してください。");
  if (!PAGE_NUMBER_LAYOUTS.includes(layout))
    throw new Error("ページ番号の配置を選択してください。");
  if (!PAGE_NUMBER_FORMATS.includes(format))
    throw new Error("ページ番号の書式を選択してください。");
  const explicit = marginX !== undefined || marginY !== undefined;
  if (explicit && !(validMargin(marginX) && validMargin(marginY))) {
    const { min, max, step } = PAGE_NUMBER_MARGIN_MM;
    throw new Error(`余白は上下・左右とも${min}〜${max}mmの範囲で${step}mm刻みに指定してください。`);
  }
  const lastNumber = startNumber + count - 1;
  const entries = pages.slice(startPage - 1).map((page, index) => {
    const pageNumber = { number: startNumber + index, fontSize, position, layout, format };
    if (format === "number-last") pageNumber.lastNumber = lastNumber;
    if (explicit) Object.assign(pageNumber, { marginX, marginY });
    // Check every page before modifying any page or adding a history entry.
    let annotation;
    try { annotation = pageNumberAnnotation({ ...page, pageNumber }, measureText); }
    catch (error) { throw new Error(`${startPage + index}ページ目：${error.message}`); }
    return { pageId: page.id, pageNumber, annotation };
  });
  return { startPage, startNumber, fontSize, position, layout, format, count, lastNumber, entries,
    ...(explicit ? { marginX, marginY } : {}) };
}

export function replacePageNumbers(pages, plan) {
  const numbers = new Map(plan.entries.map(({ pageId, pageNumber }) => [pageId, pageNumber]));
  return pages.map((page) => {
    const copy = { ...page };
    delete copy.pageNumber;
    if (numbers.has(page.id)) copy.pageNumber = { ...numbers.get(page.id) };
    return copy;
  });
}

export function removePageNumbers(pages) {
  return replacePageNumbers(pages, { entries: [] });
}
