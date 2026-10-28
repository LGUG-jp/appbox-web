// The output accepts only freshly painted pixels. Never copy/embed a source PDF page here.
import { PDFDocument, PDFDict, PDFName, PDFStream } from "./vendor/pdf-lib.esm.js";

export const REDACTION_DPI = 150;
export const MAX_REDACTION_PIXELS = 16_000_000;
export const MAX_REDACTION_EDGE = 8192;
export const MAX_REDACTION_IMAGE_BYTES = 160 * 1024 * 1024;

export function hasRedactions(pages) {
  return pages.some(page => page.annotations.some(a => a.type === "redact"));
}

export function redactionColor(annotation) {
  const color = annotation.redactColor === undefined ? "#000000" : annotation.redactColor;
  if (typeof color !== "string" || !/^#(?:000000|ffffff)$/i.test(color))
    throw new Error("墨消しの色が正しくありません。黒または白を選び直してください。");
  return color.toLowerCase();
}

export function redactionRasterSize(width, height) {
  if (![width, height].every(n => Number.isFinite(n) && n > 0))
    throw new Error("墨消しするページの寸法が正しくありません。");
  const scale = REDACTION_DPI / 72;
  const w = Math.ceil(width * scale), h = Math.ceil(height * scale);
  if (w > MAX_REDACTION_EDGE || h > MAX_REDACTION_EDGE || w * h > MAX_REDACTION_PIXELS)
    throw new Error("ページが大きすぎるため墨消しPDFを作成できません。ページ寸法を小さくしてください。");
  return { width: w, height: h, scale };
}

export function redactionPixelRects(annotations, width, height, scale) {
  if (![width, height].every(n => Number.isInteger(n) && n > 0) || !Number.isFinite(scale) || scale <= 0)
    throw new Error("墨消し画像の寸法が正しくありません。");
  return annotations.filter(a => a.type === "redact").map(a => {
    if (![a.x, a.y, a.w, a.h].every(Number.isFinite) || a.w <= 0 || a.h <= 0)
      throw new Error("墨消し範囲が正しくありません。範囲を指定し直してください。");
    // Cover intersecting pixels plus one guard pixel; no antialiased edges or transparency.
    const left = Math.max(0, Math.floor(a.x * scale) - 1);
    const top = Math.max(0, Math.floor(a.y * scale) - 1);
    const right = Math.min(width, Math.ceil((a.x + a.w) * scale) + 1);
    const bottom = Math.min(height, Math.ceil((a.y + a.h) * scale) + 1);
    if (left >= right || top >= bottom)
      throw new Error("ページ外の墨消し範囲があります。範囲をページ内へ移動するか削除してください。");
    return { x: left, y: top, w: right - left, h: bottom - top };
  });
}

export function paintRedactions(canvas, annotations, scale) {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("墨消し画像を作成できませんでした。");
  const rects = redactionPixelRects(annotations, canvas.width, canvas.height, scale);
  const colors = annotations.filter(a => a.type === "redact").map(redactionColor);
  context.save();
  try {
    context.resetTransform();
    context.globalAlpha = 1;
    context.globalCompositeOperation = "source-over";
    context.filter = "none";
    context.shadowBlur = 0;
    context.shadowColor = "transparent";
    for (const [index, r] of rects.entries()) {
      context.fillStyle = colors[index];
      context.fillRect(r.x, r.y, r.w, r.h);
      // Verify each opaque replacement before the next mask. Later masks may overlap
      // with another color; their final order is the same as the editor's overlays.
      const channel = colors[index] === "#ffffff" ? 255 : 0;
      for (let y = r.y; y < r.y + r.h; y += 128) {
        const { data } = context.getImageData(r.x, y, r.w, Math.min(128, r.y + r.h - y));
        for (let i = 0; i < data.length; i += 4)
          if (data[i] !== channel || data[i + 1] !== channel || data[i + 2] !== channel || data[i + 3] !== 255)
            throw new Error("墨消し範囲の画素を確認できなかったため、保存を中止しました。");
      }
    }
  } finally {
    context.restore();
  }
}

function canvasPng(canvas) {
  return new Promise((resolve, reject) => canvas.toBlob(blob => {
    if (!blob || blob.type !== "image/png") reject(new Error("墨消し画像のPNG変換に失敗しました。"));
    else resolve(blob);
  }, "image/png"));
}

// Reopen the serialized bytes; reject missing pages, annotations and unexpected source structures.
export async function verifyRedactedPdf(bytes, expected) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const allowedCatalog = new Set(["/Type", "/Pages"]);
  if (doc.getPageCount() !== expected.length || doc.context.trailerInfo.Info ||
      doc.catalog.keys().some(key => !allowedCatalog.has(key.toString())))
    throw new Error("墨消しPDFの構造を確認できなかったため、保存を中止しました。");
  for (const [index, page] of doc.getPages().entries()) {
    const target = expected[index];
    const resources = page.node.Resources();
    const images = resources?.lookup(PDFName.of("XObject"), PDFDict);
    const image = images?.values().length === 1 ? doc.context.lookup(images.values()[0]) : null;
    if (page.node.Annots() || page.node.has(PDFName.of("Metadata")) || page.getRotation().angle !== 0 ||
        Math.abs(page.getWidth() - target.width) > 0.001 || Math.abs(page.getHeight() - target.height) > 0.001 ||
        !(image instanceof PDFStream) || image.dict.get(PDFName.of("Subtype"))?.toString() !== "/Image" ||
        image.dict.get(PDFName.of("Width"))?.asNumber() !== target.pixelWidth ||
        image.dict.get(PDFName.of("Height"))?.asNumber() !== target.pixelHeight)
      throw new Error(`${index + 1}ページ目の墨消し結果を確認できなかったため、保存を中止しました。`);
  }
}

// renderPage returns a fresh canvas for exactly one displayed page (including ordinary edits).
export async function createRedactedPdf(pages, renderPage, onProgress = () => {}) {
  const output = await PDFDocument.create({ updateMetadata: false });
  const expected = [];
  let totalImageBytes = 0;
  if (!pages.length) throw new Error("墨消しするページがありません。");
  for (const [index, reference] of pages.entries()) {
    const annotations = reference.annotations.filter(a => a.type === "redact").map(a => ({ ...a }));
    onProgress(index + 1, pages.length);
    const raster = await renderPage(reference);
    try {
      const { canvas, width, height } = raster;
      const size = redactionRasterSize(width, height);
      if (canvas.width !== size.width || canvas.height !== size.height)
        throw new Error("ページ画像の寸法が一致しないため、保存を中止しました。");
      paintRedactions(canvas, annotations, size.scale);
      const png = await canvasPng(canvas);
      totalImageBytes += png.size;
      if (totalImageBytes > MAX_REDACTION_IMAGE_BYTES)
        throw new Error("墨消し画像の合計容量が160MiBを超えました。ページを分けて処理してください。");
      const image = await output.embedPng(await png.arrayBuffer());
      // Compress now and let pdf-lib discard its decoded image buffers before the next page.
      await image.embed();
      const page = output.addPage([width, height]);
      page.drawImage(image, { x: 0, y: 0, width, height });
      page.node.delete(PDFName.of("Annots")); // pdf-lib normalizes new pages with an empty annotation array.
      expected.push({ width, height, pixelWidth: size.width, pixelHeight: size.height });
    } finally {
      // The PDF keeps only the encoded, redacted image. Release the unencoded pixels each page.
      raster.canvas.width = 0;
      raster.canvas.height = 0;
    }
  }
  const bytes = await output.save({ useObjectStreams: true });
  await verifyRedactedPdf(bytes, expected);
  return bytes;
}
