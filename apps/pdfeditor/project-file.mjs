// Work files (.abpdf) are uncompressed ZIP archives: project.json, base.pdf and images/.
// Pages are fixed at save time; only annotations, page numbers and watermarks stay editable.
// Everything read here comes from an external file, so each field is checked and copied
// into a new object instead of trusting the stored structure.
import { PAGE_NUMBER_POSITIONS, PAGE_NUMBER_LAYOUTS, PAGE_NUMBER_FORMATS, PAGE_NUMBER_MARGIN_MM } from "./page-numbering.mjs?v=1.13.0";
import { WATERMARK_ANGLES } from "./watermark.mjs?v=1.10.0";
import { MAX_STROKE_POINTS, MAX_DOCUMENT_INK_POINTS } from "./ink.mjs?v=1.8.0";
import { PDFArray, PDFDict, PDFName, PDFNull, PDFPageLeaf, PDFPageTree, PDFRef, PDFStream } from "./vendor/pdf-lib.esm.js";

export const PROJECT_FORMAT = "appbox-pdfeditor-project";
export const PROJECT_VERSION = 1;
export const PROJECT_EXTENSION = ".abpdf";
export const MAX_PROJECT_JSON_BYTES = 20 * 1024 * 1024;
export const MAX_PROJECT_PAGES = 300;
// The editor has no explicit limits for these; they bound what an external file can make us render.
export const MAX_PROJECT_ANNOTATIONS = 10_000;
export const MAX_PROJECT_HIGHLIGHT_RECTS = 20_000;
export const MAX_PROJECT_TEXT_LENGTH = 500_000;
export const MAX_TEXT_LENGTH = 10_000;

const ZIP_LOCAL = 0x04034b50, ZIP_CENTRAL = 0x02014b50, ZIP_END = 0x06054b50;
const ZIP_UTF8 = 0x0800;
const IMAGE_ENTRY = /^images\/(\d{1,5})\.(png|jpg)$/;

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let value = n;
  for (let k = 0; k < 8; k++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  CRC_TABLE[n] = value >>> 0;
}

export function crc32(data) {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function header(size, write) {
  const bytes = new Uint8Array(size);
  write(new DataView(bytes.buffer));
  return bytes;
}

function dosDateTime(date) {
  const year = Math.min(2107, Math.max(1980, date.getFullYear()));
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/*
 * Returns the archive as a list of parts for new Blob(parts). Entry data is
 * passed through without copying so a large base.pdf is not duplicated in memory.
 * entries: [{ name, data: Uint8Array }]
 */
export function storedZipParts(entries, date = new Date()) {
  const encoder = new TextEncoder(), stamp = dosDateTime(date);
  const parts = [], central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = encoder.encode(name), checksum = crc32(data);
    if (offset + 30 + nameBytes.length + data.length > 0xffffffff)
      throw new Error("作業ファイルが大きすぎるため保存できません。");
    const local = header(30, view => {
      view.setUint32(0, ZIP_LOCAL, true);
      view.setUint16(4, 20, true);
      view.setUint16(6, ZIP_UTF8, true);
      view.setUint16(10, stamp.time, true);
      view.setUint16(12, stamp.date, true);
      view.setUint32(14, checksum, true);
      view.setUint32(18, data.length, true);
      view.setUint32(22, data.length, true);
      view.setUint16(26, nameBytes.length, true);
    });
    central.push(header(46, view => {
      view.setUint32(0, ZIP_CENTRAL, true);
      view.setUint16(4, 20, true);
      view.setUint16(6, 20, true);
      view.setUint16(8, ZIP_UTF8, true);
      view.setUint16(12, stamp.time, true);
      view.setUint16(14, stamp.date, true);
      view.setUint32(16, checksum, true);
      view.setUint32(20, data.length, true);
      view.setUint32(24, data.length, true);
      view.setUint16(28, nameBytes.length, true);
      view.setUint32(42, offset, true);
    }), nameBytes);
    parts.push(local, nameBytes, data);
    offset += 30 + nameBytes.length + data.length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = header(22, view => {
    view.setUint32(0, ZIP_END, true);
    view.setUint16(8, entries.length, true);
    view.setUint16(10, entries.length, true);
    view.setUint32(12, centralSize, true);
    view.setUint32(16, offset, true);
  });
  return [...parts, ...central, end];
}

const INVALID_ZIP = "作業ファイルが壊れているか、PDFかんたん編集の作業ファイルではありません。";

/*
 * Reads only archives in the shape storedZipParts writes: stored entries, no
 * encryption, no ZIP64 and a fixed set of names. Returns Map(name -> Uint8Array view).
 */
export function readStoredZip(bytes) {
  const fail = () => { throw new Error(INVALID_ZIP); };
  if (!(bytes instanceof Uint8Array) || bytes.length < 22) fail();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The archive comment is always empty, so the end record is the last 22 bytes.
  const endAt = bytes.length - 22;
  if (view.getUint32(endAt, true) !== ZIP_END || view.getUint16(endAt + 20, true) !== 0) fail();
  const count = view.getUint16(endAt + 10, true);
  const centralSize = view.getUint32(endAt + 12, true), centralAt = view.getUint32(endAt + 16, true);
  if (view.getUint16(endAt + 4, true) || view.getUint16(endAt + 6, true) ||
      view.getUint16(endAt + 8, true) !== count || !count || count > 2 + MAX_PROJECT_ANNOTATIONS ||
      centralAt + centralSize !== endAt) fail();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const entries = new Map();
  let pos = centralAt, dataEnd = 0;
  for (let i = 0; i < count; i++) {
    if (pos + 46 > endAt || view.getUint32(pos, true) !== ZIP_CENTRAL) fail();
    const flags = view.getUint16(pos + 8, true), method = view.getUint16(pos + 10, true);
    const checksum = view.getUint32(pos + 16, true);
    const compressed = view.getUint32(pos + 20, true), size = view.getUint32(pos + 24, true);
    const nameLength = view.getUint16(pos + 28, true);
    const extraLength = view.getUint16(pos + 30, true), commentLength = view.getUint16(pos + 32, true);
    const disk = view.getUint16(pos + 34, true), localAt = view.getUint32(pos + 42, true);
    // Bit 0: encrypted, bit 3: sizes after data. Only bit 11 (UTF-8) is expected.
    if ((flags & ~ZIP_UTF8) || method !== 0 || compressed !== size || disk ||
        extraLength || commentLength || pos + 46 + nameLength > endAt) fail();
    let name;
    try { name = decoder.decode(bytes.subarray(pos + 46, pos + 46 + nameLength)); } catch { fail(); }
    if (entries.has(name) || !(name === "project.json" || name === "base.pdf" || IMAGE_ENTRY.test(name))) fail();
    // Entries are packed back to back from offset 0 and each local header repeats the
    // central record, so no byte of the archive is left unchecked.
    if (localAt !== dataEnd || localAt + 30 > centralAt || view.getUint32(localAt, true) !== ZIP_LOCAL ||
        view.getUint16(localAt + 6, true) !== flags || view.getUint16(localAt + 8, true) !== 0 ||
        view.getUint32(localAt + 14, true) !== checksum || view.getUint32(localAt + 18, true) !== size ||
        view.getUint32(localAt + 22, true) !== size || view.getUint16(localAt + 26, true) !== nameLength ||
        view.getUint16(localAt + 28, true) !== 0) fail();
    for (let j = 0; j < nameLength; j++) if (bytes[localAt + 30 + j] !== bytes[pos + 46 + j]) fail();
    const start = localAt + 30 + nameLength, end = start + size;
    if (end > centralAt) fail();
    const data = bytes.subarray(start, end);
    if (crc32(data) !== checksum) fail();
    entries.set(name, data);
    dataEnd = end;
    pos += 46 + nameLength;
  }
  if (pos !== endAt || dataEnd !== centralAt || !entries.has("project.json") || !entries.has("base.pdf")) fail();
  return entries;
}

const INVALID_PROJECT = "作業ファイルの内容を読み込めませんでした。";

function number(value, min, max) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max)
    throw new Error(INVALID_PROJECT);
  return value;
}

function color(value) {
  if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error(INVALID_PROJECT);
  return value.toLowerCase();
}

function flag(value) {
  if (typeof value !== "boolean") throw new Error(INVALID_PROJECT);
  return value;
}

function list(value, max) {
  if (!Array.isArray(value) || value.length > max) throw new Error(INVALID_PROJECT);
  return value;
}

/*
 * Copies one annotation with only the fields its type uses. Coordinates are
 * displayed page points; a generous margin around the page keeps figures that
 * were dragged partly outside, while rejecting values that cannot come from the editor.
 * imageCount: number of images in the file (image refers to 1..imageCount).
 */
export function normalizeProjectAnnotation(a, size, fontFamilies, imageCount) {
  if (!a || typeof a !== "object") throw new Error(INVALID_PROJECT);
  const span = Math.max(size.width, size.height);
  const x = value => number(value, -span, span * 2);
  const length = value => number(value, 0, span * 2);
  const positive = value => number(value, 0.01, span * 2);
  const stroke = value => number(value, 0.1, 50);
  switch (a.type) {
    case "rect":
    case "ellipse":
      return { type: a.type, x: x(a.x), y: x(a.y), w: length(a.w), h: length(a.h), color: color(a.color),
        strokeWidth: stroke(a.strokeWidth), fill: color(a.fill), fillNone: flag(a.fillNone) };
    case "line":
    case "arrow":
      return { type: a.type, x1: x(a.x1), y1: x(a.y1), x2: x(a.x2), y2: x(a.y2), color: color(a.color),
        strokeWidth: stroke(a.strokeWidth), outline: flag(a.outline) };
    case "text": {
      if (typeof a.text !== "string" || a.text.length > MAX_TEXT_LENGTH) throw new Error(INVALID_PROJECT);
      if (!fontFamilies.includes(a.fontFamily)) throw new Error(INVALID_PROJECT);
      return { type: "text", x: x(a.x), y: x(a.y), w: length(a.w), h: length(a.h), text: a.text,
        fontSize: number(a.fontSize, 1, 200), fontFamily: a.fontFamily, color: color(a.color), bold: flag(a.bold),
        outline: flag(a.outline), bgColor: color(a.bgColor), bgTransparent: flag(a.bgTransparent) };
    }
    case "highlight": {
      const rects = list(a.rects, MAX_PROJECT_HIGHLIGHT_RECTS);
      if (!rects.length) throw new Error(INVALID_PROJECT);
      return { type: "highlight", rects: rects.map(r => ({ x: x(r?.x), y: x(r?.y), w: positive(r?.w), h: positive(r?.h) })),
        color: color(a.color), opacity: number(a.opacity, 0.05, 1) };
    }
    case "ink": {
      const points = list(a.points, MAX_STROKE_POINTS);
      if (!points.length) throw new Error(INVALID_PROJECT);
      return { type: "ink", points: points.map(p => ({ x: x(p?.x), y: x(p?.y) })), color: color(a.color),
        strokeWidth: stroke(a.strokeWidth) };
    }
    case "image": {
      if (!Number.isInteger(a.image) || a.image < 1 || a.image > imageCount) throw new Error(INVALID_PROJECT);
      if (![0, 90, 180, 270].includes(a.rotation)) throw new Error(INVALID_PROJECT);
      if (a.stamp !== undefined && a.stamp !== true) throw new Error(INVALID_PROJECT);
      const result = { type: "image", image: a.image, x: x(a.x), y: x(a.y), w: positive(a.w), h: positive(a.h),
        rotation: a.rotation };
      if (a.stamp) result.stamp = true;
      return result;
    }
    default:
      throw new Error(INVALID_PROJECT);
  }
}

export function normalizeProjectPageNumber(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || !Number.isInteger(value.number) || value.number < 0 || value.number > 999999 ||
      !PAGE_NUMBER_POSITIONS.includes(value.position)) throw new Error(INVALID_PROJECT);
  const fontSize = number(value.fontSize, 6, 72);
  if (!Number.isInteger(fontSize * 2)) throw new Error(INVALID_PROJECT);
  // Only an omitted layout or format means the original behaviour; unknown values are rejected, not defaulted.
  const layout = value.layout === undefined ? "same" : value.layout;
  const format = value.format === undefined ? "number" : value.format;
  if (!PAGE_NUMBER_LAYOUTS.includes(layout) || !PAGE_NUMBER_FORMATS.includes(format)) throw new Error(INVALID_PROJECT);
  const result = { number: value.number, fontSize, position: value.position, layout, format };
  if (format === "number-last") {
    if (!Number.isInteger(value.lastNumber) || value.lastNumber < value.number || value.lastNumber > 999999)
      throw new Error(INVALID_PROJECT);
    result.lastNumber = value.lastNumber;
  }
  // Margins are both present (millimetres) or both absent (the automatic margin).
  if (value.marginX !== undefined || value.marginY !== undefined) {
    const { min, max, step } = PAGE_NUMBER_MARGIN_MM;
    for (const margin of [value.marginX, value.marginY])
      if (!Number.isInteger(number(margin, min, max) / step)) throw new Error(INVALID_PROJECT);
    Object.assign(result, { marginX: value.marginX, marginY: value.marginY });
  }
  return result;
}

export function normalizeProjectWatermark(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || typeof value.text !== "string") throw new Error(INVALID_PROJECT);
  const text = value.text.trim();
  if (!text || text.length > 40 || /[\r\n]/.test(text)) throw new Error(INVALID_PROJECT);
  const fontSize = number(value.fontSize, 24, 120);
  if (fontSize % 2 || !WATERMARK_ANGLES.includes(value.angle)) throw new Error(INVALID_PROJECT);
  return { text, color: color(value.color), opacity: number(value.opacity, 0.1, 0.8), fontSize, angle: value.angle };
}

// Document-wide limits, applied the same way when saving and reading.
function checkTotals(pages) {
  let annotations = 0, inkPoints = 0, rects = 0, text = 0;
  for (const page of pages)
    for (const a of page.annotations) {
      annotations++;
      if (a.type === "ink") inkPoints += a.points.length;
      else if (a.type === "highlight") rects += a.rects.length;
      else if (a.type === "text") text += a.text.length;
    }
  if (annotations > MAX_PROJECT_ANNOTATIONS || inkPoints > MAX_DOCUMENT_INK_POINTS ||
      rects > MAX_PROJECT_HIGHLIGHT_RECTS || text > MAX_PROJECT_TEXT_LENGTH)
    throw new Error("図形や文字が多すぎるため、作業ファイルとして扱えません。");
}

const imageFile = (index, mime) => `images/${index}.${mime === "image/jpeg" ? "jpg" : "png"}`;

/*
 * Builds project.json and the image entries from the editor pages.
 * pages: editor pages in order; sizes: displayed size of each page;
 * images: Map(imageId -> { bytes, mime }). Only images still used on a page are written.
 * The same checks as reading run here, so a saved file can always be opened again.
 */
export function serializeProject({ name, pages, sizes, images, fontFamilies }) {
  if (!pages.length || pages.length > MAX_PROJECT_PAGES || sizes.length !== pages.length)
    throw new Error("作業ファイルに保存できるページ数を超えています。");
  checkTotals(pages);
  const imageIndexes = new Map(), imageEntries = [];
  const projectPages = pages.map((page, pageIndex) => {
    const annotations = page.annotations.map(a => {
      let image = 0;
      if (a.type === "image") {
        if (!imageIndexes.has(a.imageId)) {
          const asset = images.get(a.imageId);
          if (!asset) throw new Error("挿入画像を読み込めませんでした。");
          imageIndexes.set(a.imageId, imageEntries.length + 1);
          imageEntries.push({ name: imageFile(imageEntries.length + 1, asset.mime), data: asset.bytes });
        }
        image = imageIndexes.get(a.imageId);
      }
      try {
        return normalizeProjectAnnotation(image ? { ...a, image } : a, sizes[pageIndex], fontFamilies, imageEntries.length);
      } catch {
        throw new Error(`${pageIndex + 1}ページ目の図形を作業ファイルへ保存できませんでした。`);
      }
    });
    const result = { annotations };
    const pageNumber = normalizeProjectPageNumber(page.pageNumber);
    const watermark = normalizeProjectWatermark(page.watermark);
    if (pageNumber) result.pageNumber = pageNumber;
    if (watermark) result.watermark = watermark;
    return result;
  });
  const json = new TextEncoder().encode(`${JSON.stringify({
    format: PROJECT_FORMAT, version: PROJECT_VERSION, name: projectSourceName(name),
    images: imageEntries.map(entry => entry.name), pages: projectPages,
  })}\n`);
  if (json.length > MAX_PROJECT_JSON_BYTES) throw new Error("図形が多すぎるため、作業ファイルに保存できません。");
  return { json, images: imageEntries };
}

/*
 * First pass over project.json, before base.pdf is opened: format, version,
 * page count and the image list. Annotations are checked by normalizeProjectPages
 * once the page sizes are known.
 */
// The original PDF name, kept for the display and later save names. Same limit as reading.
function projectSourceName(name) {
  return Array.from(String(name || "document.pdf")).slice(0, 255).join("") || "document.pdf";
}

export function readProjectManifest(bytes, entries) {
  if (bytes.length > MAX_PROJECT_JSON_BYTES) throw new Error("作業ファイルの図形データが大きすぎます。");
  let data;
  try {
    data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error(INVALID_PROJECT);
  }
  if (data?.format !== PROJECT_FORMAT) throw new Error(INVALID_ZIP);
  if (data.version !== PROJECT_VERSION)
    throw new Error("このバージョンでは開けない作業ファイルです。PDFかんたん編集を最新版にしてください。");
  if (typeof data.name !== "string" || !data.name || Array.from(data.name).length > 255) throw new Error(INVALID_PROJECT);
  const pages = list(data.pages, MAX_PROJECT_PAGES), images = list(data.images, MAX_PROJECT_ANNOTATIONS);
  if (!pages.length) throw new Error(INVALID_PROJECT);
  // Every image entry is listed exactly once, in order, and nothing else is in images/.
  images.forEach((file, index) => {
    const match = typeof file === "string" && IMAGE_ENTRY.exec(file);
    if (!match || Number(match[1]) !== index + 1 || !entries.has(file)) throw new Error(INVALID_PROJECT);
  });
  if (entries.size !== images.length + 2) throw new Error(INVALID_PROJECT);
  return { name: data.name, pages, images: images.map(file => ({ file, mime: file.endsWith(".jpg") ? "image/jpeg" : "image/png" })) };
}

// sizes: displayed size of each base.pdf page, in the same order as manifest.pages.
export function normalizeProjectPages(manifest, sizes, fontFamilies) {
  if (sizes.length !== manifest.pages.length) throw new Error(INVALID_PROJECT);
  const pages = manifest.pages.map((page, index) => {
    try {
      if (!page || typeof page !== "object") throw new Error(INVALID_PROJECT);
      const annotations = list(page.annotations, MAX_PROJECT_ANNOTATIONS)
        .map(a => normalizeProjectAnnotation(a, sizes[index], fontFamilies, manifest.images.length));
      return { annotations, pageNumber: normalizeProjectPageNumber(page.pageNumber),
        watermark: normalizeProjectWatermark(page.watermark) };
    } catch (error) {
      throw new Error(`${index + 1}ページ目：${error.message}`);
    }
  });
  checkTotals(pages);
  // Every image must be used; an unused image would only carry data nobody can see.
  const used = new Set(pages.flatMap(page => page.annotations.filter(a => a.type === "image").map(a => a.image)));
  if (used.size !== manifest.images.length) throw new Error(INVALID_PROJECT);
  return pages;
}

// "資料.pdf" -> "資料.abpdf". Same rules as sanitizePdfName in app.js.
export function projectFileName(name) {
  let base = String(name || "document").replace(/\.(pdf|abpdf)$/i, "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/\.{2,}/g, "_").replace(/[. ]+$/g, "").trim();
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:[. ]|$)/i.test(base)) base = `_${base}`;
  return `${Array.from(base).slice(0, 80).join("") || "document"}${PROJECT_EXTENSION}`;
}

/*
 * base.pdf is built by copyPages(), which copies everything a page refers to.
 * A link, form field or bead pointing at a deleted page would copy that page's
 * content as well, and removing the reference after copying leaves the data in the
 * output. detachExcludedPages() therefore edits the source PDF (loaded only for this
 * save) before copying:
 * - references to deleted pages, their annotations (e.g. a widget of a field shared
 *   with a kept page) and the page tree are cut (dictionary key removed, array item null);
 * - attachments are not carried over: file attachment annotations, associated files
 *   (/AF) and embedded file specifications (/EF) are cut;
 * - per-page XMP metadata (/Metadata) and private application data (/PieceInfo) are removed;
 * - references to kept pages (internal links) are replaced with a placeholder name,
 *   because copyPages() would otherwise copy the target again as a hidden duplicate.
 *   relinkKeptPages() points them at the output pages after copying.
 * Page dictionaries outside the page tree count as deleted pages.
 * Returns Map(sourceIndex -> placeholder name). Each call uses a random token, so the
 * names neither collide between sources nor match names already in a PDF.
 */
function placeholderToken() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

export function detachExcludedPages(document, keepIndices) {
  const context = document.context, pages = document.getPages();
  const keep = new Set(keepIndices), kept = new Map(), excluded = new Set(), placeholders = new Map();
  const token = placeholderToken();
  pages.forEach((page, index) => {
    if (keep.has(index)) kept.set(page.node, index);
    else excluded.add(page.node);
  });
  const resolve = value => (value instanceof PDFRef ? context.lookup(value) : value);
  // Annotations placed on deleted pages, found through each page's own /Annots.
  for (const node of excluded) {
    const annots = resolve(node.get(PDFName.of("Annots")));
    if (annots instanceof PDFArray)
      for (let i = 0; i < annots.size(); i++) {
        const annot = resolve(annots.get(i));
        if (annot instanceof PDFDict) excluded.add(annot);
      }
  }
  const nameOf = key => resolve(key)?.asString?.();
  // Only plain dictionaries: a file attachment annotation or a file specification
  // with embedded files. Streams (drawing content) are never dropped as a whole.
  const isAttachment = target => target instanceof PDFDict && !(target instanceof PDFPageLeaf) &&
    (nameOf(target.get(PDFName.of("Subtype"))) === "/FileAttachment" || target.has(PDFName.of("EF")));
  const replacement = value => {
    const target = resolve(value);
    if (kept.has(target)) {
      const index = kept.get(target);
      if (!placeholders.has(index)) placeholders.set(index, PDFName.of(`AppboxProjectPage-${token}-${index}`));
      return placeholders.get(index);
    }
    if (excluded.has(target) || target instanceof PDFPageLeaf || target instanceof PDFPageTree ||
        isAttachment(target)) return null;
    return undefined;
  };
  // Move inherited values (Resources etc.) onto every kept page first, as copyPages()
  // does, so they are walked even when a page is reached earlier through a link.
  for (const node of kept.keys()) {
    for (const name of PDFPageLeaf.InheritableEntries) {
      const key = PDFName.of(name), value = node.getInheritableAttribute(key);
      if (!node.get(key) && value) node.set(key, value);
    }
    for (const name of ["Metadata", "PieceInfo", "AF"]) node.delete(PDFName.of(name));
  }
  const seen = new Set();
  const visit = value => {
    const object = resolve(value);
    if (!object || seen.has(object)) return;
    seen.add(object);
    const dict = object instanceof PDFStream ? object.dict : object;
    if (dict instanceof PDFDict) {
      for (const [key, entry] of dict.entries()) {
        if (key === PDFName.of("Parent") && dict instanceof PDFPageLeaf) continue;
        if (key === PDFName.of("AF")) { dict.delete(key); continue; }
        const next = replacement(entry);
        if (next === null) dict.delete(key);
        else if (next) dict.set(key, next);
        else visit(entry);
      }
    } else if (dict instanceof PDFArray) {
      for (let i = 0; i < dict.size(); i++) {
        const next = replacement(dict.get(i));
        if (next !== undefined) dict.set(i, next ?? PDFNull);
        else visit(dict.get(i));
      }
    }
  };
  for (const node of kept.keys()) {
    seen.add(node);
    for (const [key, entry] of node.entries()) {
      if (key === PDFName.of("Parent")) continue;
      const next = replacement(entry);
      if (next === null) node.delete(key);
      else if (next) node.set(key, next);
      else visit(entry);
    }
  }
  return new Map([...placeholders].map(([index, name]) => [index, name.asString()]));
}

/*
 * After copyPages(), replaces the placeholders issued by detachExcludedPages() with
 * the output pages. targets: Map(placeholder name -> PDFRef of the output page).
 * Only issued names are replaced; other names in the PDF are left as they are.
 */
export function relinkKeptPages(document, targets) {
  const context = document.context, seen = new Set();
  const target = value => (value instanceof PDFName ? targets.get(value.asString()) : undefined);
  const visit = value => {
    const object = value instanceof PDFRef ? context.lookup(value) : value;
    if (!object || seen.has(object)) return;
    seen.add(object);
    const dict = object instanceof PDFStream ? object.dict : object;
    if (dict instanceof PDFDict) {
      for (const [key, entry] of dict.entries()) {
        if (key === PDFName.of("Parent") && dict instanceof PDFPageLeaf) continue;
        const next = target(entry);
        if (next) dict.set(key, next);
        else visit(entry);
      }
    } else if (dict instanceof PDFArray) {
      for (let i = 0; i < dict.size(); i++) {
        const next = target(dict.get(i));
        if (next) dict.set(i, next);
        else visit(dict.get(i));
      }
    }
  };
  for (const page of document.getPages()) visit(page.node);
}
