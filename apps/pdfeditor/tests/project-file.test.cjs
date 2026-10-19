const test = require("node:test");
const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");
const path = require("node:path");

const modulePromise = import(pathToFileURL(path.resolve(__dirname, "../project-file.mjs")).href);
const pdfModule = import(pathToFileURL(path.resolve(__dirname, "../vendor/pdf-lib.esm.js")).href);
const fonts = ["yu-gothic-ui", "arial"];
const encoder = new TextEncoder();
const png = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAQAAAABCAYAAAD5PA/NAAAAGUlEQVR4nGNgYGBg+P//fwMDA8P//wwMDgAupwW8KZ3epgAAAABJRU5ErkJggg==", "base64"));

async function zipBytes(entries) {
  const { storedZipParts } = await modulePromise;
  return new Uint8Array(await new Blob(storedZipParts(entries)).arrayBuffer());
}

// One annotation of every type, in the shape the editor creates them (ids and image ids included).
function editorPages() {
  return [
    {
      id: "p1", annotations: [
        { id: "a1", type: "rect", x: 10, y: 20, w: 100, h: 50, color: "#D63A4A", strokeWidth: 2, fill: "#fdecef", fillNone: false },
        { id: "a2", type: "ellipse", x: 0, y: 0, w: 30, h: 30, color: "#d63a4a", strokeWidth: 4, fill: "#ffffff", fillNone: true },
        { id: "a3", type: "arrow", x1: 1, y1: 2, x2: 300, y2: 400, color: "#000000", strokeWidth: 6, outline: true },
        { id: "a4", type: "line", x1: 5, y1: 5, x2: 50, y2: 5, color: "#000000", strokeWidth: 1, outline: false },
        { id: "a5", type: "text", x: 40, y: 60, w: 250, h: 72, text: "確認済\n2行目", fontSize: 10.5, fontFamily: "yu-gothic-ui",
          color: "#d63a4a", bold: true, outline: true, bgColor: "#ffffff", bgTransparent: false },
        { id: "a6", type: "image", imageId: "img-1", rotation: 90, stamp: true, x: 100, y: 100, w: 40, h: 40 },
      ],
      pageNumber: { number: 3, fontSize: 10.5, position: "bottom-center" },
    },
    {
      id: "p2", annotations: [
        { id: "b1", type: "highlight", rects: [{ x: 1, y: 2, w: 30, h: 10 }], color: "#ffe04a", opacity: 0.35 },
        { id: "b2", type: "ink", points: [{ x: 3, y: 4 }], color: "#d63a4a", strokeWidth: 2 },
        { id: "b3", type: "image", imageId: "img-1", rotation: 0, x: 0, y: 0, w: 20, h: 20 },
      ],
      watermark: { text: "取扱注意", color: "#d63a4a", opacity: 0.2, fontSize: 72, angle: -45 },
    },
  ];
}
const sizes = [{ width: 595, height: 842 }, { width: 842, height: 595 }];
const images = new Map([["img-1", { bytes: png, mime: "image/png" }], ["unused", { bytes: png, mime: "image/png" }]]);

async function saveAndRead(pages = editorPages()) {
  const { serializeProject, readStoredZip, readProjectManifest, normalizeProjectPages } = await modulePromise;
  const project = serializeProject({ name: "会議資料.pdf", pages, sizes, images, fontFamilies: fonts });
  const entries = readStoredZip(await zipBytes([
    { name: "project.json", data: project.json }, { name: "base.pdf", data: encoder.encode("%PDF-1.7") }, ...project.images,
  ]));
  const manifest = readProjectManifest(entries.get("project.json"), entries);
  return { project, entries, manifest, pages: normalizeProjectPages(manifest, sizes, fonts) };
}

test("CRC32は標準の検査値と一致し、ZIPは書いた内容をそのまま読み戻す", async () => {
  const { crc32, readStoredZip } = await modulePromise;
  assert.equal(crc32(encoder.encode("123456789")), 0xcbf43926);
  const entries = readStoredZip(await zipBytes([
    { name: "project.json", data: encoder.encode("{}") },
    { name: "base.pdf", data: encoder.encode("%PDF") },
    { name: "images/1.png", data: png },
  ]));
  assert.deepEqual([...entries.keys()], ["project.json", "base.pdf", "images/1.png"]);
  assert.deepEqual(Array.from(entries.get("images/1.png")), Array.from(png));
});

test("ZIPは想定外の名前・重複・破損・圧縮・暗号化・末尾の追加データを拒否する", async () => {
  const { readStoredZip } = await modulePromise;
  const base = [{ name: "project.json", data: encoder.encode("{}") }, { name: "base.pdf", data: encoder.encode("%PDF") }];
  const reject = bytes => assert.throws(() => readStoredZip(bytes), /作業ファイルが壊れているか/);
  reject(new Uint8Array(10));
  reject(await zipBytes([...base, { name: "../evil.js", data: encoder.encode("x") }]));
  reject(await zipBytes([...base, { name: "images/a.svg", data: encoder.encode("x") }]));
  reject(await zipBytes([...base, { name: "base.pdf", data: encoder.encode("%PDF") }]));
  reject(await zipBytes([base[0]]));

  const valid = await zipBytes(base);
  const corrupt = valid.slice(); corrupt[30 + "project.json".length] ^= 1;
  reject(corrupt);
  const trailing = new Uint8Array(valid.length + 1); trailing.set(valid);
  reject(trailing);
  // セントラルディレクトリに載らない領域を先頭に挟み、オフセットを合わせたZIPも拒否する。
  const hidden = new Uint8Array(valid.length + 4); hidden.set([1, 2, 3, 4]); hidden.set(valid, 4);
  const hiddenView = new DataView(hidden.buffer), endAt = hidden.length - 22;
  hiddenView.setUint32(endAt + 16, hiddenView.getUint32(endAt + 16, true) + 4, true);
  for (let i = 0, pos = hiddenView.getUint32(endAt + 16, true); i < 2; i++) {
    hiddenView.setUint32(pos + 42, hiddenView.getUint32(pos + 42, true) + 4, true);
    pos += 46 + hiddenView.getUint16(pos + 28, true);
  }
  reject(hidden);
  for (const [offset, value] of [[8, 8], [6, 1], [6, 8]]) {
    // Compression method, encryption flag and data descriptor flag in the first local and central headers.
    const changed = valid.slice(), view = new DataView(changed.buffer);
    const central = view.getUint32(changed.length - 6, true);
    view.setUint16(offset, value, true);
    view.setUint16(central + offset + 2, value, true);
    reject(changed);
  }
});

test("全種類の図形・重ね順・共有画像・スタンプ・ページ番号・透かしを往復で復元し、IDは保存しない", async () => {
  const { project, manifest, pages } = await saveAndRead();
  // 使われていない画像は書き出さず、2つの注釈で共有した画像は1件にまとめる。
  assert.deepEqual(project.images.map(entry => entry.name), ["images/1.png"]);
  assert.equal(manifest.name, "会議資料.pdf");
  assert.deepEqual(pages[0].annotations.map(a => a.type), ["rect", "ellipse", "arrow", "line", "text", "image"]);
  assert.deepEqual(pages[1].annotations.map(a => a.type), ["highlight", "ink", "image"]);
  assert.deepEqual(pages[0].annotations[0], { type: "rect", x: 10, y: 20, w: 100, h: 50, color: "#d63a4a", strokeWidth: 2,
    fill: "#fdecef", fillNone: false });
  assert.equal(pages[0].annotations[4].text, "確認済\n2行目");
  assert.equal(pages[0].annotations[4].bgTransparent, false);
  assert.deepEqual(pages[0].annotations[5], { type: "image", image: 1, x: 100, y: 100, w: 40, h: 40, rotation: 90, stamp: true });
  assert.equal(pages[1].annotations[2].image, 1);
  assert.equal("stamp" in pages[1].annotations[2], false);
  assert.deepEqual(pages[0].pageNumber, { number: 3, fontSize: 10.5, position: "bottom-center", layout: "same", format: "number" });
  assert.equal(pages[0].watermark, null);
  assert.deepEqual(pages[1].watermark, { text: "取扱注意", color: "#d63a4a", opacity: 0.2, fontSize: 72, angle: -45 });
  const json = new TextDecoder().decode(project.json);
  assert.doesNotMatch(json, /"id"|imageId|img-1/);
});

test("注釈は種類ごとに使う項目だけを写し、型・範囲・参照の不正を拒否する", async () => {
  const { normalizeProjectAnnotation } = await modulePromise;
  const size = { width: 100, height: 200 };
  const text = { type: "text", x: 0, y: 0, w: 10, h: 10, text: "a", fontSize: 12, fontFamily: "arial", color: "#000000",
    bold: false, outline: false, bgColor: "#ffffff", bgTransparent: true };
  // 透かし専用の項目や未知の項目は一般のテキストへ持ち込まない。
  const copied = normalizeProjectAnnotation({ ...text, watermark: true, opacity: 0.1, rotation: 45, onclick: "x" }, size, fonts, 0);
  assert.deepEqual(Object.keys(copied).sort(), Object.keys(text).sort());
  const reject = (a, imageCount = 1) => assert.throws(() => normalizeProjectAnnotation(a, size, fonts, imageCount), /読み込めませんでした/);
  reject({ ...text, type: "script" });
  reject({ ...text, bold: "false" });
  reject({ ...text, bgTransparent: undefined });
  reject({ ...text, fontSize: "12" });
  reject({ ...text, fontFamily: "Comic Sans" });
  reject({ ...text, x: 401 });
  reject({ ...text, y: Number.NaN });
  reject({ ...text, text: "a".repeat(10_001) });
  reject({ ...text, color: "red" });
  reject({ type: "ink", points: [], color: "#000000", strokeWidth: 2 });
  reject({ type: "ink", points: Array.from({ length: 8193 }, () => ({ x: 1, y: 1 })), color: "#000000", strokeWidth: 2 });
  reject({ type: "highlight", rects: [], color: "#000000", opacity: 0.35 });
  reject({ type: "highlight", rects: [{ x: 0, y: 0, w: 0, h: 5 }], color: "#000000", opacity: 0.35 });
  const image = { type: "image", image: 1, x: 0, y: 0, w: 10, h: 10, rotation: 0 };
  assert.doesNotThrow(() => normalizeProjectAnnotation(image, size, fonts, 1));
  reject({ ...image, image: 2 });
  reject({ ...image, image: 1.5 });
  reject({ ...image, rotation: 45 });
  reject({ ...image, stamp: false });
  reject({ ...image, w: 0 });
});

test("ページ番号と透かしは既存の入力制約で検証する", async () => {
  const { normalizeProjectPageNumber, normalizeProjectWatermark } = await modulePromise;
  assert.equal(normalizeProjectPageNumber(undefined), null);
  for (const value of [{ number: -1, fontSize: 10, position: "top-left" }, { number: 1, fontSize: 10.25, position: "top-left" },
    { number: 1, fontSize: 80, position: "top-left" }, { number: 1, fontSize: 10, position: "middle" }, { number: "1", fontSize: 10, position: "top-left" }])
    assert.throws(() => normalizeProjectPageNumber(value));
  // 配置・書式・余白のない従来の形は、従来どおりの配置（すべて同じ位置・番号のみ・自動の余白）として読む。
  assert.deepEqual(normalizeProjectPageNumber({ number: 3, fontSize: 12, position: "bottom-right", extra: 1 }),
    { number: 3, fontSize: 12, position: "bottom-right", layout: "same", format: "number" });
  const full = { number: 3, fontSize: 12, position: "bottom-right", layout: "mirror-x", format: "number-last", lastNumber: 10,
    marginX: 15, marginY: 7.5 };
  assert.deepEqual(normalizeProjectPageNumber(full), full);
  // 最終番号は「番号 / 最終番号」の書式のときだけ持つ。
  assert.deepEqual(normalizeProjectPageNumber({ ...full, format: "dash" }),
    { number: 3, fontSize: 12, position: "bottom-right", layout: "mirror-x", format: "dash", marginX: 15, marginY: 7.5 });
  for (const value of [{ ...full, layout: "booklet" }, { ...full, layout: 1 }, { ...full, format: "roman" },
    { ...full, layout: null }, { ...full, format: null }, { ...full, marginX: null, marginY: null },
    { ...full, lastNumber: undefined }, { ...full, lastNumber: 2 }, { ...full, lastNumber: 1_000_000 }, { ...full, lastNumber: 10.5 },
    { ...full, marginX: undefined }, { ...full, marginY: undefined }, { ...full, marginX: 2.5 }, { ...full, marginY: 50.5 },
    { ...full, marginX: 10.2 }, { ...full, marginX: "10" }])
    assert.throws(() => normalizeProjectPageNumber(value), JSON.stringify(value));
  const watermark = { text: "案", color: "#000000", opacity: 0.2, fontSize: 48, angle: 0 };
  assert.deepEqual(normalizeProjectWatermark({ ...watermark, extra: 1 }), watermark);
  for (const value of [{ ...watermark, text: "" }, { ...watermark, text: "a".repeat(41) }, { ...watermark, opacity: 0.9 },
    { ...watermark, fontSize: 49 }, { ...watermark, angle: 30 }])
    assert.throws(() => normalizeProjectWatermark(value));
});

test("project.jsonの形式・版・画像一覧・ページ数の不一致を拒否する", async () => {
  const { readProjectManifest, normalizeProjectPages, PROJECT_FORMAT } = await modulePromise;
  const entries = new Map([["project.json", null], ["base.pdf", null], ["images/1.png", png]]);
  const read = data => readProjectManifest(encoder.encode(JSON.stringify(data)), entries);
  const valid = { format: PROJECT_FORMAT, version: 1, name: "a.pdf", images: ["images/1.png"],
    pages: [{ annotations: [{ type: "image", image: 1, x: 0, y: 0, w: 10, h: 10, rotation: 0 }] }] };
  const manifest = read(valid);
  assert.deepEqual(manifest.images, [{ file: "images/1.png", mime: "image/png" }]);
  assert.throws(() => read({ ...valid, format: "other" }), /作業ファイルではありません/);
  assert.throws(() => read({ ...valid, version: 2 }), /このバージョンでは開けない/);
  assert.throws(() => read({ ...valid, images: ["images/2.png"] }));
  assert.throws(() => read({ ...valid, images: [] }), "一覧にない画像がZIPに入っている");
  assert.throws(() => read({ ...valid, pages: [] }));
  assert.throws(() => read({ ...valid, pages: Array(301).fill({ annotations: [] }) }));
  assert.throws(() => readProjectManifest(encoder.encode("{"), entries));
  assert.throws(() => normalizeProjectPages(manifest, [], fonts));
  // 参照されない画像は受け付けない。
  assert.throws(() => normalizeProjectPages(read({ ...valid, pages: [{ annotations: [] }] }), [{ width: 100, height: 100 }], fonts));
  assert.throws(() => normalizeProjectPages(read({ ...valid, pages: [{ annotations: [{ type: "image", image: 1, x: 0, y: 0, w: 10, h: 10, rotation: 0 }], pageNumber: { number: 1 } }] }),
    [{ width: 100, height: 100 }], fonts), /1ページ目/);
});

test("保存時も同じ上限と検証を適用し、開けない作業ファイルを作らない", async () => {
  const { serializeProject, MAX_PROJECT_ANNOTATIONS } = await modulePromise;
  const line = { type: "line", x1: 0, y1: 0, x2: 10, y2: 10, color: "#000000", strokeWidth: 2, outline: false };
  const save = pages => serializeProject({ name: "a.pdf", pages, sizes: pages.map(() => sizes[0]), images, fontFamilies: fonts });
  assert.throws(() => save([{ annotations: Array(MAX_PROJECT_ANNOTATIONS + 1).fill(line) }]), /多すぎる/);
  assert.throws(() => save([{ annotations: [{ ...line, x2: 5000 }] }]), /1ページ目の図形/);
  assert.throws(() => save([{ annotations: [{ type: "image", imageId: "missing", rotation: 0, x: 0, y: 0, w: 1, h: 1 }] }]), /挿入画像/);
  assert.throws(() => save([]));
  // 長い元ファイル名でも、保存した作業ファイルは開ける長さに収める。
  const { readProjectManifest } = await modulePromise;
  const long = serializeProject({ name: `${"あ".repeat(300)}.pdf`, pages: [{ annotations: [] }], sizes: [sizes[0]], images, fontFamilies: fonts });
  const manifest = readProjectManifest(long.json, new Map([["project.json", null], ["base.pdf", null]]));
  assert.equal(Array.from(manifest.name).length, 255);
});

test("作業ファイル名は元のPDF名を引き継ぎ、Windowsで使えない文字を置き換える", async () => {
  const { projectFileName } = await modulePromise;
  assert.equal(projectFileName("会議資料.pdf"), "会議資料.abpdf");
  assert.equal(projectFileName("前回.abpdf"), "前回.abpdf");
  assert.equal(projectFileName('a/b:c*?.PDF'), "a_b_c__.abpdf");
  assert.equal(projectFileName("CON.pdf"), "_CON.abpdf");
  assert.equal(projectFileName(""), "document.abpdf");
});

// Pages 0 and 1 are kept, page 2 is deleted. Each case plants text that must not reach base.pdf.
async function sourceDocument(build) {
  const { PDFDocument, PDFName, PDFString } = await pdfModule;
  const document = await PDFDocument.create();
  const pages = [document.addPage([200, 200]), document.addPage([200, 200]), document.addPage([200, 200])];
  pages[1].node.set(PDFName.of("AppboxMarker"), PDFString.of("KEPT-PAGE-CONTENT"));
  pages[2].node.set(PDFName.of("AppboxMarker"), PDFString.of("DELETED-PAGE-CONTENT"));
  const { context } = document;
  const annots = (page, ...items) =>
    page.node.set(PDFName.of("Annots"), context.obj(items.map(item => context.register(context.obj(item)))));
  build({ document, pages, context, annots, PDFName });
  return PDFDocument.load(await document.save({ useObjectStreams: false }));
}

// Same steps as saveProjectFile(): detach, copy, add pages, relink.
async function buildBase(source, keep = [0, 1], detach = true) {
  const { detachExcludedPages, relinkKeptPages } = await modulePromise;
  const { PDFDocument } = await pdfModule;
  const placeholders = detach ? detachExcludedPages(source, keep) : new Map();
  const output = await PDFDocument.create();
  for (const page of await output.copyPages(source, keep)) output.addPage(page);
  if (detach) relinkKeptPages(output, new Map(keep.filter(index => placeholders.has(index))
    .map(index => [placeholders.get(index), output.getPage(keep.indexOf(index)).ref])));
  const bytes = await output.save({ useObjectStreams: false });
  return { text: Buffer.from(bytes).toString("latin1"), document: await PDFDocument.load(bytes) };
}

const linkToDeleted = ({ pages, context, annots, PDFName }) => {
  annots(pages[0], { Type: "Annot", Subtype: "Link", Rect: [0, 0, 10, 10], Dest: [pages[2].ref, "Fit"] },
    { Type: "Annot", Subtype: "Link", Rect: [10, 0, 20, 10], Dest: [pages[1].ref, "Fit"] });
  pages[0].node.set(PDFName.of("Metadata"), context.register(context.stream("PRIVATE-XMP")));
};

test("base.pdfの作成前に、削除したページへのリンクとページのメタデータを切り離す", async () => {
  // 対策なしでは、リンク先の削除ページまでコピーされることを確認する。
  assert.match((await buildBase(await sourceDocument(linkToDeleted), [0, 1], false)).text, /DELETED-PAGE-CONTENT/);
  const { text } = await buildBase(await sourceDocument(linkToDeleted));
  assert.doesNotMatch(text, /DELETED-PAGE-CONTENT|PRIVATE-XMP|AppboxProjectPage/);
  assert.equal((text.match(/\/Subtype \/Link/g) || []).length, 2);
});

test("残したページ同士のリンクは出力したページを指すよう付け替え、ページを複製しない", async () => {
  const { PDFName, PDFArray, PDFNull } = await pdfModule;
  const { text, document } = await buildBase(await sourceDocument(linkToDeleted));
  assert.equal((text.match(/KEPT-PAGE-CONTENT/g) || []).length, 1, "リンク先のページが隠れた複製として増えない");
  const annots = document.getPage(0).node.lookup(PDFName.of("Annots"), PDFArray);
  const target = ref => document.context.lookup(document.context.lookup(ref).get(PDFName.of("Dest"))).get(0);
  assert.equal(target(annots.get(0)), PDFNull, "削除ページへのリンクは行先を外す");
  assert.equal(target(annots.get(1)), document.getPage(1).ref);
});

test("継承されたResourcesから削除ページへ届く参照も、リンク経由の走査順に関係なく切り離す", async () => {
  const source = await sourceDocument(({ document, pages, context, annots, PDFName }) => {
    // Page 0 links to page 1 first; page 1 inherits Resources that refer to the deleted page.
    annots(pages[0], { Type: "Annot", Subtype: "Link", Rect: [0, 0, 10, 10], Dest: [pages[1].ref, "Fit"] });
    const xobject = context.register(context.stream("q Q",
      { Type: "XObject", Subtype: "Form", BBox: [0, 0, 1, 1], Ref: pages[2].ref }));
    pages[1].node.delete(PDFName.of("Resources"));
    document.catalog.Pages().set(PDFName.of("Resources"), context.obj({ XObject: { X1: xobject } }));
  });
  assert.doesNotMatch((await buildBase(source)).text, /DELETED-PAGE-CONTENT/);
});

test("残したページと共有するフォームから、削除ページのウィジェットと外観を持ち込まない", async () => {
  const source = await sourceDocument(({ pages, context, PDFName }) => {
    const appearance = context.register(context.stream("(DELETED-WIDGET-AP) Tj",
      { Type: "XObject", Subtype: "Form", BBox: [0, 0, 10, 10] }));
    const field = context.register(context.obj({ FT: "Tx", T: "name" }));
    const kept = context.register(context.obj({ Type: "Annot", Subtype: "Widget", Rect: [0, 0, 10, 10], Parent: field, P: pages[0].ref }));
    const removed = context.register(context.obj({ Type: "Annot", Subtype: "Widget", Rect: [0, 0, 10, 10], Parent: field, AP: { N: appearance } }));
    context.lookup(field).set(PDFName.of("Kids"), context.obj([kept, removed]));
    pages[0].node.set(PDFName.of("Annots"), context.obj([kept]));
    pages[2].node.set(PDFName.of("Annots"), context.obj([removed]));
  });
  const { text } = await buildBase(source);
  assert.doesNotMatch(text, /DELETED-WIDGET-AP|DELETED-PAGE-CONTENT/);
  assert.match(text, /\/Subtype \/Widget/);
});

test("ページに付いた添付ファイル（添付注釈・/AF・埋込みファイル）を持ち込まない", async () => {
  const source = await sourceDocument(({ pages, context, annots, PDFName }) => {
    const embedded = () => context.register(context.obj({ Type: "Filespec", F: "a.txt",
      EF: { F: context.register(context.stream("ATTACHED-SECRET", { Type: "EmbeddedFile" })) } }));
    annots(pages[0], { Type: "Annot", Subtype: "FileAttachment", Rect: [0, 0, 10, 10], FS: embedded() },
      { Type: "Annot", Subtype: "Square", Rect: [0, 0, 10, 10] });
    pages[1].node.set(PDFName.of("AF"), context.obj([embedded()]));
  });
  const { text } = await buildBase(source);
  assert.doesNotMatch(text, /ATTACHED-SECRET|FileAttachment|\/AF/);
  assert.match(text, /\/Subtype \/Square/, "添付以外の注釈は維持する");
});

test("付け替え用の名前は元PDFの名前と衝突せず、/EFを持つ描画データとツリー外のページは正しく扱う", async () => {
  const { PDFName } = await pdfModule;
  const source = await sourceDocument(({ pages, context, annots, PDFName: Name }) => {
    annots(pages[0], { Type: "Annot", Subtype: "Link", Rect: [0, 0, 10, 10], Dest: [pages[1].ref, "Fit"] });
    // 特色名がたまたま同じ接頭辞でも、元PDFの名前は書き換えない。
    const form = context.register(context.stream("(KEPT-FORM-DRAWING) Tj",
      { Type: "XObject", Subtype: "Form", BBox: [0, 0, 10, 10], EF: { Custom: 1 } }));
    const hiddenPage = context.register(context.obj({ Type: "Page", MediaBox: [0, 0, 10, 10],
      AppboxMarker: context.obj("HIDDEN-PAGE-CONTENT") }));
    pages[0].node.set(Name.of("Resources"), context.obj({
      ColorSpace: { CS0: ["Separation", "AppboxProjectPage-0-0", "DeviceGray", { FunctionType: 2, Domain: [0, 1], C0: [0], C1: [1], N: 1 }] },
      XObject: { X0: form },
    }));
    pages[0].node.set(Name.of("Thumb"), hiddenPage);
  });
  const { text, document } = await buildBase(source);
  assert.match(text, /\/AppboxProjectPage-0-0/, "元PDFの特色名を維持する");
  assert.match(text, /KEPT-FORM-DRAWING/, "/EFを持つForm XObjectは消さない");
  assert.doesNotMatch(text, /HIDDEN-PAGE-CONTENT/, "ページツリー外のPage辞書は持ち込まない");
  assert.equal(document.context.enumerateIndirectObjects()
    .filter(([, object]) => object?.get?.(PDFName.of("Type"))?.asString?.() === "/Page").length, 2);
});

test("base.pdfはページ寸法と最終回転角を保ち、継承された属性も持ち込む", async () => {
  const { detachExcludedPages } = await modulePromise;
  const { PDFDocument, PDFName, degrees } = await pdfModule;
  const document = await PDFDocument.create();
  document.addPage([300, 500]);
  document.addPage([400, 600]);
  // Rotate and CropBox inherited from the page tree.
  document.catalog.Pages().set(PDFName.of("Rotate"), document.context.obj(90));
  document.getPages()[1].node.set(PDFName.of("CropBox"), document.context.obj([10, 20, 210, 320]));
  const source = await PDFDocument.load(await document.save());
  detachExcludedPages(source, [1]);
  const output = await PDFDocument.create();
  const [copied] = await output.copyPages(source, [1]);
  copied.setRotation(degrees(180));
  output.addPage(copied);
  const page = (await PDFDocument.load(await output.save())).getPage(0);
  assert.equal(page.getRotation().angle, 180);
  assert.deepEqual(page.getCropBox(), { x: 10, y: 20, width: 200, height: 300 });
  assert.deepEqual(page.getMediaBox(), { x: 0, y: 0, width: 400, height: 600 });
});
