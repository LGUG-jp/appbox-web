import { PDFImage, PngEmbedder } from "./vendor/pdf-lib.esm.js";

/** Embed outlined text without a dark fringe at the transparent edge. */
export async function embedTextPng(document, pngBytes, whiteOutline) {
  if (!whiteOutline) return document.embedPng(pngBytes);

  // Use the bundled pdf-lib low-level PNG embedder before it compresses RGB.
  // Canvas PNGs (and the PNG decoder) store black in fully transparent pixels.
  // PDF viewers may interpolate RGB separately from the soft mask, allowing
  // that invisible black to bleed into the white outline. White RGB at alpha 0
  // removes the fringe while retaining every visible pixel and its opacity.
  const embedder = await PngEmbedder.for(pngBytes);
  const { rgbChannel, alphaChannel } = embedder.image;
  if (alphaChannel) {
    for (let pixel = 0; pixel < alphaChannel.length; pixel++) {
      if (alphaChannel[pixel] !== 0) continue;
      const offset = pixel * 3;
      rgbChannel[offset] = 255;
      rgbChannel[offset + 1] = 255;
      rgbChannel[offset + 2] = 255;
    }
  }
  const ref = document.context.nextRef();
  await embedder.embedIntoContext(document.context, ref);
  return PDFImage.of(ref, document, embedder);
}
