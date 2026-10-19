const test = require("node:test");
const assert = require("node:assert/strict");
const imageModule = import("../text-image.mjs");
const pdfModule = import("../vendor/pdf-lib.esm.js");
// Transparent black, half-transparent white, opaque black, transparent red.
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAQAAAABCAYAAAD5PA/NAAAAGUlEQVR4nGNgYGBg+P//fwMDA8P//wwMDgAupwW8KZ3epgAAAABJRU5ErkJggg==", "base64");

for (const outline of [true, false]) {
  test(`PDF保存は白縁取り${outline ? "あり" : "なし"}のRGBと透明度を維持する`, async () => {
    const { embedTextPng } = await imageModule;
    const { PDFDocument, PDFName, PDFRef, decodePDFRawStream } = await pdfModule;
    const document = await PDFDocument.create();
    const image = await embedTextPng(document, png, outline);
    document.addPage([100, 100]).drawImage(image, { x: 0, y: 0, width: 80, height: 20 });
    const reopened = await PDFDocument.load(await document.save());
    const stream = reopened.context.lookup(PDFRef.of(image.ref.objectNumber));
    const rgb = Array.from(decodePDFRawStream(stream).decode());
    assert.deepEqual(rgb.slice(0, 3), outline ? [255, 255, 255] : [0, 0, 0]);
    assert.deepEqual(rgb.slice(3), [255, 255, 255, 0, 0, 0, 255, 0, 0]);
    const mask = reopened.context.lookup(stream.dict.get(PDFName.of("SMask")));
    assert.deepEqual(Array.from(decodePDFRawStream(mask).decode()), [0, 128, 255, 64]);
    assert.equal(stream.dict.get(PDFName.of("Width")).asNumber(), 4);
    assert.equal(stream.dict.get(PDFName.of("Height")).asNumber(), 1);
  });
}
