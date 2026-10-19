export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_TOTAL_IMAGE_BYTES = 100 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 16_000_000;
export const MAX_IMAGE_EDGE = 8192;

export function checkImageSize(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      width > MAX_IMAGE_EDGE || height > MAX_IMAGE_EDGE || width * height > MAX_IMAGE_PIXELS)
    throw new Error("画像は各辺8192px以下・1600万画素以下にしてください。");
}

// Check dimensions before the browser allocates a decoded raster. File extensions
// and MIME types alone cannot establish the format or the memory needed to decode it.
export function imageMetadata(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const png = [137, 80, 78, 71, 13, 10, 26, 10];
  let mime, width, height;
  if (bytes.length >= 33 && png.every((b, i) => bytes[i] === b) &&
      view.getUint32(8) === 13 && view.getUint32(12) === 0x49484452) {
    mime = "image/png";
    width = view.getUint32(16); height = view.getUint32(20);
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    mime = "image/jpeg";
    let pos = 2;
    while (pos + 3 < bytes.length) {
      if (bytes[pos++] !== 0xff) break;
      while (bytes[pos] === 0xff) pos++;
      const marker = bytes[pos++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
      if (pos + 2 > bytes.length) break;
      const length = view.getUint16(pos);
      if (length < 2 || pos + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8) {
        height = view.getUint16(pos + 3); width = view.getUint16(pos + 5);
        break;
      }
      pos += length;
    }
  }
  if (!mime || !width || !height) throw new Error("有効なPNG・JPEG画像を選択してください。");
  checkImageSize(width, height);
  return { mime, width, height };
}

export function initialImageBox(width, height, size) {
  const scale = Math.min(1, size.width * .6 / width, size.height * .6 / height);
  const w = width * scale, h = height * scale;
  return { x: (size.width - w) / 2, y: (size.height - h) / 2, w, h };
}

export function imagePlacement(a, pageHeight) {
  const rotation = ((a.rotation || 0) % 360 + 360) % 360;
  const swapped = rotation === 90 || rotation === 270;
  return {
    x: a.x + (rotation === 180 || rotation === 270 ? a.w : 0),
    y: pageHeight - a.y - (rotation === 0 || rotation === 270 ? a.h : 0),
    width: swapped ? a.h : a.w, height: swapped ? a.w : a.h,
    rotation,
    transform: `translate(${rotation === 90 || rotation === 180 ? a.w : 0} ${rotation === 180 || rotation === 270 ? a.h : 0}) rotate(${rotation})`,
  };
}

export function referencedImageIds(pages, history, future, clipboard) {
  const ids = new Set();
  const collect = annotations => {
    for (const a of annotations || []) if (a.type === "image") ids.add(a.imageId);
  };
  for (const group of [pages, ...history.map(h => h.pages), ...future.map(h => h.pages)])
    for (const page of group || []) collect(page.annotations);
  collect(clipboard);
  return ids;
}

export function clipboardFiles(data) {
  const files = Array.from(data?.files || []);
  if (files.length) return files;
  return Array.from(data?.items || []).filter(item => item.kind === "file")
    .map(item => item.getAsFile()).filter(Boolean);
}
