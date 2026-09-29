import { isLine, bounds, translate, rotateAnnotation, movePages, stepPages, rangeIds, nearestCorner, selectionRects, samePageRaster, samePageLayout } from "./editor-core.mjs?v=1.3.1";
import {
  PDFDocument,
  rgb,
  degrees
} from "./vendor/pdf-lib.esm.js";

import * as pdfjsLib
  from "./vendor/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "./vendor/pdf.worker.min.mjs";

const PDFJS_CMAP_BUNDLE_URL =
  "./vendor/cmaps.bundle.json.gz";

let pdfJsCMapBundlePromise = null;

class PdfCMapError extends Error {
  constructor(message, cause = null) {
    super(message);

    this.name = "PdfCMapError";

    if (cause) {
      this.cause = cause;
    }
  }
}

function isPlainObject(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return false;
  }

  const prototype =
    Object.getPrototypeOf(value);

  return (
    prototype === Object.prototype ||
    prototype === null
  );
}

async function fetchPdfJsCMapBundle() {
  if (
    typeof DecompressionStream !==
    "function"
  ) {
    throw new PdfCMapError(
      "このブラウザはPDF表示用CMapデータの展開に対応していません。Microsoft EdgeまたはGoogle Chromeの最新版を使用してください。"
    );
  }

  let response;

  try {
    response = await fetch(
      PDFJS_CMAP_BUNDLE_URL,
      {
        cache: "no-store",
        credentials: "same-origin"
      }
    );
  } catch (error) {
    throw new PdfCMapError(
      "PDF表示用CMapデータへ接続できませんでした。IIS上のvendor/cmaps.bundle.json.gzとCSP設定を確認してください。",
      error
    );
  }

  if (!response.ok) {
    throw new PdfCMapError(
      `PDF表示用CMapデータを取得できませんでした（HTTP ${response.status}）。IIS上のvendor/cmaps.bundle.json.gzを確認してください。`
    );
  }

  if (!response.body) {
    throw new PdfCMapError(
      "PDF表示用CMapデータの応答本文がありません。IISの静的ファイル配信設定を確認してください。"
    );
  }

  let text;

  try {
    const decompressed =
      response.body.pipeThrough(
        new DecompressionStream(
          "gzip"
        )
      );

    text = await new Response(
      decompressed
    ).text();
  } catch (error) {
    throw new PdfCMapError(
      "PDF表示用CMapデータを展開できませんでした。ファイルが正しいgzip形式か確認してください。",
      error
    );
  }

  if (!text.trim()) {
    throw new PdfCMapError(
      "PDF表示用CMapデータが空です。cmaps.bundle.json.gzの生成結果を確認してください。"
    );
  }

  let bundle;

  try {
    bundle = JSON.parse(text);
  } catch (error) {
    throw new PdfCMapError(
      "PDF表示用CMapデータをJSONとして読み込めませんでした。cmaps.bundle.json.gzの内容を確認してください。",
      error
    );
  }

  if (!isPlainObject(bundle)) {
    throw new PdfCMapError(
      "PDF表示用CMapデータの形式が正しくありません。"
    );
  }

  return bundle;
}

async function loadPdfJsCMapBundle() {
  if (!pdfJsCMapBundlePromise) {
    pdfJsCMapBundlePromise =
      fetchPdfJsCMapBundle();
  }

  try {
    return await pdfJsCMapBundlePromise;
  } catch (error) {
    /*
     * 一時的な配信失敗等から復旧した後、
     * ページを再読込みせず再試行できるようにします。
     */
    pdfJsCMapBundlePromise = null;

    if (
      error instanceof
      PdfCMapError
    ) {
      throw error;
    }

    throw new PdfCMapError(
      "PDF表示用CMapデータの読み込みに失敗しました。",
      error
    );
  }
}


class BundledTextCMapReaderFactory {
  async fetch({ name }) {
    if (
      typeof name !== "string" ||
      !name ||
      !/^[A-Za-z0-9._-]+$/.test(
        name
      )
    ) {
      throw new PdfCMapError(
        "PDFから不正なCMap名が指定されました。"
      );
    }

    const bundle =
      await loadPdfJsCMapBundle();

    if (
      !Object.prototype
        .hasOwnProperty.call(
          bundle,
          name
        )
    ) {
      throw new PdfCMapError(
        `PDFが必要とするCMap「${name}」がローカルバンドルに含まれていません。`
      );
    }

    const cmapText =
      bundle[name];

    if (
      typeof cmapText !==
        "string" ||
      !cmapText.trim()
    ) {
      throw new PdfCMapError(
        `PDF表示用CMap「${name}」のデータ形式が正しくありません。`
      );
    }

    let cMapData;

    try {
      cMapData =
        new TextEncoder().encode(
          cmapText
        );
    } catch (error) {
      throw new PdfCMapError(
        `PDF表示用CMap「${name}」を変換できませんでした。`,
        error
      );
    }

    return {
      cMapData,
      isCompressed: false
    };
  }
}


function getPdfJsAuxiliaryOptions() {
  return {
    // cMapUrl is required by PDF.js even when a custom reader factory is used.
    cMapUrl: "./vendor/",
    cMapPacked: false,
    CMapReaderFactory:
      BundledTextCMapReaderFactory,
    wasmUrl:
      new URL(
        "./vendor/wasm/",
        document.baseURI
      ).href,
    useWasm: true,
    useWorkerFetch: false
  };
}

const $ = id =>
  document.getElementById(id);

const uid = () =>
  globalThis.crypto?.randomUUID?.() ||
  `id-${Date.now()}-${
    Math.random()
      .toString(16)
      .slice(2)
  }`;

const clone = value =>
  JSON.parse(
    JSON.stringify(value)
  );

const clamp = (
  value,
  minimum,
  maximum
) =>
  Math.max(
    minimum,
    Math.min(maximum, value)
  );

const normRotation = rotation =>
  (
    (
      Math.round(rotation / 90) *
      90
    ) %
      360 +
    360
  ) % 360;

const isTextEditingTarget = element =>
  Boolean(
    element?.closest?.(
      "[contenteditable='true']," +
      "input,select,textarea"
    )
  );

const FONT_STACKS = {
  "biz-udgothic":
    '"BIZ UDGothic",' +
    '"BIZ UDゴシック",' +
    '"Yu Gothic UI",' +
    '"Meiryo",sans-serif',

  "biz-udpgothic":
    '"BIZ UDPGothic",' +
    '"BIZ UDPゴシック",' +
    '"Yu Gothic UI",' +
    '"Meiryo",sans-serif',

  "yu-gothic":
    '"Yu Gothic",' +
    '"游ゴシック",' +
    '"Yu Gothic UI",' +
    '"Meiryo",sans-serif',

  "yu-gothic-ui":
    '"Yu Gothic UI",' +
    '"游ゴシック UI",' +
    '"Yu Gothic",' +
    '"Meiryo",sans-serif',

  "meiryo":
    '"Meiryo",' +
    '"メイリオ",' +
    '"Yu Gothic UI",sans-serif',

  "ms-gothic":
    '"MS Gothic",' +
    '"ＭＳ ゴシック",' +
    '"Meiryo",monospace',

  "ms-pgothic":
    '"MS PGothic",' +
    '"ＭＳ Ｐゴシック",' +
    '"Meiryo",sans-serif',

  "ms-mincho":
    '"MS Mincho",' +
    '"ＭＳ 明朝",' +
    '"Yu Mincho",serif',

  "ms-pmincho":
    '"MS PMincho",' +
    '"ＭＳ Ｐ明朝",' +
    '"Yu Mincho",serif',

  "segoe-ui":
    '"Segoe UI",' +
    '"Yu Gothic UI",' +
    '"Meiryo",sans-serif',

  "arial":
    '"Arial",' +
    '"Yu Gothic UI",' +
    '"Meiryo",sans-serif',

  "times-new-roman":
    '"Times New Roman",' +
    '"Yu Mincho",' +
    '"MS PMincho",serif'
};

const DEFAULT_FONT_FAMILY =
  "yu-gothic-ui";

const fontStackFor = key =>
  FONT_STACKS[key] ||
  FONT_STACKS[
    DEFAULT_FONT_FAMILY
  ];

const FONT_LABELS = {
  "biz-udgothic": "BIZ UDゴシック",
  "biz-udpgothic": "BIZ UDPゴシック",
  "yu-gothic": "游ゴシック",
  "yu-gothic-ui": "游ゴシック UI",
  "meiryo": "メイリオ",
  "ms-gothic": "MS ゴシック",
  "ms-pgothic": "MS Pゴシック",
  "ms-mincho": "MS 明朝",
  "ms-pmincho": "MS P明朝",
  "segoe-ui": "Segoe UI",
  "arial": "Arial",
  "times-new-roman": "Times New Roman"
};

const fontLabelFor = key =>
  FONT_LABELS[key] ||
  FONT_LABELS[
    DEFAULT_FONT_FAMILY
  ];

/*
 * PDF入力上限
 */

const MAX_SINGLE_FILE_BYTES =
  100 * 1024 * 1024;

const MAX_TOTAL_FILE_BYTES =
  200 * 1024 * 1024;

const MAX_TOTAL_PAGES = 300;

/*
 * プレビューCanvas上限
 */

const PREVIEW_BASE_QUALITY = 2;
const PREVIEW_MAX_DPR = 2.5;
const PREVIEW_MAX_PIXELS =
  20_000_000;
const PREVIEW_MAX_EDGE = 8192;
const PREVIEW_MIN_QUALITY = 0.1;

/*
 * テキスト画像化上限
 *
 * テキストは通常小さい領域ですが、
 * 極端に大きい図形によるメモリ消費を抑制します。
 */

const TEXT_RASTER_SCALE = 3;
const TEXT_RASTER_MAX_PIXELS =
  8_000_000;
const TEXT_RASTER_MAX_EDGE = 4096;

const state = {
  mode: "overview",
  pageSelection: new Set(),
  selectionAnchor: null,
  figureSelection: new Set(),
  clipboard: [],
  markerColor: "#ffe04a",
  markerOpacity: 0.35,
  sources: new Map(),
  pages: [],
  currentPageId: null,
  selectedAnnotationId: null,
  tool: "select",

  defaults: {
    color: "#d63a4a",
    textColor: "#d63a4a",
    stroke: 2,
    fontSize: 14,
    fontFamily:
      DEFAULT_FONT_FAMILY,
    bold: false,
    bgColor: "#ffffff",
    bgTransparent: true,
    outline: true,
    fill: "#fdecef",
    fillNone: true
  },

  viewScale: 1,
  renderToken: 0,
  thumbToken: 0,
  history: [],
  future: [],
  busy: false,
  restoringHistory: false,
  dragPageId: null
};

const els = {
  input: $("pdfInput"),
  append: $("appendPdfBtn"),
  close: $("closePdfBtn"),
  save: $("saveBtn"),
  collapseToggle:
    document.querySelector(
      '[data-appbox-collapse="pdfBrand pdfNotice"]'
    ),
  annotationMenu:
    $("annotationToolsMenu"),

  empty: $("emptyState"),
  editor: $("editor"),
  drop: $("dropZone"),

  thumbs: $("thumbList"),
  pageCount: $("pageCount"),
  movePageUp: $("movePageUpBtn"),
  movePageDown:
    $("movePageDownBtn"),

  documentName:
    $("documentName"),
  pageIndicator:
    $("pageIndicator"),

  canvas: $("pdfCanvas"),
  layer: $("annotationLayer"),
  pageHost: $("pageHost"),
  viewerArea: $("viewerArea"),
  loading: $("loadingOverlay"),

  status: $("statusText"),
  zoom: $("zoomSelect"),
  zoomOut: $("zoomOutBtn"),
  zoomIn: $("zoomInBtn"),

  prev: $("prevPageBtn"),
  next: $("nextPageBtn"),

  rotateLeft:
    $("rotateLeftBtn"),
  rotateRight:
    $("rotateRightBtn"),
  deletePage:
    $("deletePageBtn"),

  undo: $("undoBtn"),
  redo: $("redoBtn"),

  deleteAnn:
    $("deleteAnnotationBtn"),

  color: $("colorInput"),
  stroke: $("strokeInput"),
  fontFamilyButton:
    $("fontFamilyButton"),
  fontFamilyMenu:
    $("fontFamilyMenu"),
  fontFamilyPicker:
    $("fontFamilyPicker"),
  font: $("fontSizeInput"),
  bold: $("boldInput"),
  bgColor:
    $("textBgColorInput"),
  bgTransparent:
    $("textBgTransparentInput"),

  strokeField:
    $("strokeField"),
  fontFamilyField:
    $("fontFamilyField"),
  fontField:
    $("fontField"),
  boldField:
    $("boldInput"),
  bgColorField:
    $("bgColorField"),
  bgTransparentField:
    $("bgTransparentField"),

  toast: $("toast")
};

let currentRenderTask = null;
let currentThumbnailRenderTask = null;
let toastTimer = null;
let resizeRenderFrame = 0;
let sourceReleasePromise = Promise.resolve();

/*
 * 共通処理
 */

function showToast(
  message,
  error = false
) {
  clearTimeout(toastTimer);

  els.toast.textContent =
    message;

  els.toast.className =
    "toast show" +
    (error ? " error" : "");

  toastTimer = setTimeout(
    () => {
      els.toast.className =
        "toast";
    },
    3200
  );
}

function updateStatus(text) {
  els.status.textContent = text;
}

function setBusy(
  enabled,
  label = "処理しています…"
) {
  state.busy = Boolean(enabled);

  const loadingLabel =
    els.loading.querySelector(
      "span"
    );

  if (loadingLabel) {
    loadingLabel.textContent =
      label;
  }

  /*
   * PDF編集画面内のローディング表示です。
   * 初回読込み時はeditorが非表示なので、
   * emptyStateにもbusy状態を設定します。
   */
  els.loading.classList.toggle(
    "hidden",
    !enabled
  );

  els.loading.setAttribute(
    "aria-hidden",
    String(!enabled)
  );

  els.editor.classList.toggle(
    "is-busy",
    enabled
  );

  els.editor.setAttribute(
    "aria-busy",
    String(enabled)
  );

  els.empty.classList.toggle(
    "is-busy",
    enabled
  );

  els.drop.setAttribute(
    "aria-busy",
    String(enabled)
  );

  /*
   * CSSの疑似要素で表示する処理文言としても使用します。
   */
  els.drop.dataset.busyLabel =
    enabled ? label : "";

  syncUI();
}


function currentPage() {
  return (
    state.pages.find(
      page =>
        page.id ===
        state.currentPageId
    ) || null
  );
}

function currentPageIndex() {
  return state.pages.findIndex(
    page =>
      page.id ===
      state.currentPageId
  );
}

function currentAnnotation() {
  const page = currentPage();

  return (
    page?.annotations.find(
      annotation =>
        annotation.id ===
        state.selectedAnnotationId
    ) || null
  );
}

function sourceFor(page) {
  return page
    ? state.sources.get(
        page.sourceId
      )
    : null;
}

function snapshot() {
  return {
    pages: clone(state.pages),
    currentPageId: state.currentPageId,
    selectedPages: [...state.pageSelection]
  };
}

function currentTotalSourceBytes() {
  let total = 0;

  for (
    const source of
    state.sources.values()
  ) {
    total +=
      source.bytes.byteLength;
  }

  return total;
}

function referencedSourceIds() {
  const ids =
    new Set();

  const collect =
    pages => {
      for (
        const page of
        pages || []
      ) {
        if (page?.sourceId) {
          ids.add(
            page.sourceId
          );
        }
      }
    };

  collect(state.pages);

  for (
    const historyItem of
    state.history
  ) {
    collect(
      historyItem.pages
    );
  }

  for (
    const futureItem of
    state.future
  ) {
    collect(
      futureItem.pages
    );
  }

  return ids;
}

async function performUnusedSourceRelease() {
  const referenced =
    referencedSourceIds();

  for (
    const [
      sourceId,
      source
    ] of [
      ...state.sources
    ]
  ) {
    if (
      referenced.has(sourceId)
    ) {
      continue;
    }

    /*
     * 解放開始直前に、現在のページ・履歴・Redo履歴から
     * 再度参照状態を確認します。
     */
    if (
      referencedSourceIds()
        .has(sourceId)
    ) {
      continue;
    }

    try {
      await source
        .pdfjsDoc
        ?.destroy?.();
    } catch {
      // 他のsourceの解放を継続します。
    }

    if (
      state.sources.get(
        sourceId
      ) === source
    ) {
      state.sources.delete(
        sourceId
      );
    }
  }
}

function releaseUnusedSources() {
  sourceReleasePromise =
    sourceReleasePromise
      .catch(() => {
        // 前回の解放失敗後も継続します。
      })
      .then(
        performUnusedSourceRelease
      );

  return sourceReleasePromise;
}

function sanitizePdfName(name) {
  let base = String(
    name || "document"
  )
    .replace(/\.pdf$/i, "")
    .replace(
      /[\\/:*?"<>|\u0000-\u001f]/g,
      "_"
    )
    .replace(/\.{2,}/g, "_")
    .replace(/[. ]+$/g, "")
    .trim();

  if (
    /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:[. ]|$)/i
      .test(base)
  ) {
    base = "_" + base;
  }

  base =
    Array.from(base)
      .slice(0, 80)
      .join("") ||
    "document";

  return `${base}_編集済.pdf`;
}

function previewRenderQuality(
  cssWidth,
  cssHeight
) {
  const dpr = clamp(
    globalThis.devicePixelRatio ||
      1,
    1,
    PREVIEW_MAX_DPR
  );

  const desired =
    Math.max(
      PREVIEW_BASE_QUALITY,
      dpr
    );

  const safeWidth =
    Math.max(1, cssWidth);

  const safeHeight =
    Math.max(1, cssHeight);

  const byPixels =
    Math.sqrt(
      PREVIEW_MAX_PIXELS /
      (
        safeWidth *
        safeHeight
      )
    );

  const byEdge =
    Math.min(
      PREVIEW_MAX_EDGE /
        safeWidth,
      PREVIEW_MAX_EDGE /
        safeHeight
    );

  return clamp(
    Math.min(
      desired,
      byPixels,
      byEdge
    ),
    PREVIEW_MIN_QUALITY,
    desired
  );
}

/*
 * 履歴
 */

function pushHistory(
  snap = snapshot()
) {
  state.history.push(snap);

  if (
    state.history.length > 40
  ) {
    state.history.shift();
  }

  state.future.length = 0;
  syncUndoRedo();
  void releaseUnusedSources();
}

async function restoreSnapshot(
  snap
) {
  const previousPages =
    state.pages;
  const previousCurrentPage =
    currentPage();
  const nextPages =
    clone(snap.pages);

  const nextCurrentPageId =
    nextPages.some(
      page =>
        page.id ===
        snap.currentPageId
    )
      ? snap.currentPageId
      : nextPages[0]?.id ||
        null;

  const nextCurrentPage =
    nextPages.find(
      page =>
        page.id ===
        nextCurrentPageId
    ) || null;

  const canReuseCurrentRaster =
    samePageRaster(
      previousCurrentPage,
      nextCurrentPage
    );

  const canReuseThumbnailLayout =
    samePageLayout(
      previousPages,
      nextPages
    );

  state.pages = nextPages;
  state.pageSelection = new Set(
    snap.selectedPages || []
  );
  state.figureSelection.clear();
  state.currentPageId =
    nextCurrentPageId;
  state.selectedAnnotationId =
    null;

  syncUI();

  const refreshThumbnailState =
    () => {
      syncThumbnailSelection();

      for (
        const page of
        state.pages
      ) {
        updateThumbnailAnnotationMarker(
          page.id
        );
      }
    };

  if (state.mode === "overview") {
    if (
      canReuseThumbnailLayout
    ) {
      refreshThumbnailState();
    } else {
      await renderThumbnails();
    }
    return;
  }

  const pending = [];

  if (
    canReuseThumbnailLayout
  ) {
    refreshThumbnailState();
  } else {
    pending.push(
      renderThumbnails()
    );
  }

  if (
    canReuseCurrentRaster
  ) {
    renderAnnotations();
  } else {
    pending.push(
      renderCurrentPage()
    );
  }

  await Promise.all(pending);
}

async function undo() {
  if (
    state.busy ||
    state.restoringHistory
  ) {
    return;
  }

  finishTextEditing();

  if (!state.history.length) {
    syncUndoRedo();
    return;
  }

  state.restoringHistory = true;
  setBusy(true, "編集履歴を反映しています…");
  syncUndoRedo();

  try {
    state.future.push(
      snapshot()
    );

    if (
      state.future.length > 40
    ) {
      state.future.shift();
    }

    const snap =
      state.history.pop();

    await restoreSnapshot(
      snap
    );

    await releaseUnusedSources();
  } catch (error) {
    console.error(
      "Undo failed:",
      error
    );

    showToast(
      "元に戻す処理に失敗しました。",
      true
    );
  } finally {
    state.restoringHistory =
      false;

    setBusy(false);
    syncUndoRedo();
  }
}

async function redo() {
  if (
    state.busy ||
    state.restoringHistory
  ) {
    return;
  }

  finishTextEditing();

  if (!state.future.length) {
    syncUndoRedo();
    return;
  }

  state.restoringHistory = true;
  setBusy(true, "編集履歴を反映しています…");
  syncUndoRedo();

  try {
    state.history.push(
      snapshot()
    );

    if (
      state.history.length > 40
    ) {
      state.history.shift();
    }

    const snap =
      state.future.pop();

    await restoreSnapshot(
      snap
    );

    await releaseUnusedSources();
  } catch (error) {
    console.error(
      "Redo failed:",
      error
    );

    showToast(
      "やり直し処理に失敗しました。",
      true
    );
  } finally {
    state.restoringHistory =
      false;

    setBusy(false);
    syncUndoRedo();
  }
}

function syncUndoRedo() {
  els.undo.disabled =
    !state.history.length ||
    state.busy ||
    state.restoringHistory;

  els.redo.disabled =
    !state.future.length ||
    state.busy ||
    state.restoringHistory;
}


/*
 * UI同期
 */

function syncToolButtons() {
  document
    .querySelectorAll(
      ".mode-btn"
    )
    .forEach(button => {
      const active =
        button.dataset.tool ===
        state.tool;

      button.classList.toggle(
        "active",
        active
      );

      button.setAttribute(
        "aria-pressed",
        String(active)
      );

      button.disabled =
        state.busy ||
        !state.pages.length;
    });
}

function syncUI() {
  const hasPages =
    state.pages.length > 0;

  /*
   * PDF読込み後は編集領域を最優先にします。
   * アプリ説明・注意喚起・折りたたみボタン・フッターは
   * CSS側で隠し、PDFを閉じると自動で元へ戻します。
   */
  document.body.classList.toggle(
    "pdf-editor-active",
    hasPages
  );

  const index =
    currentPageIndex();

  els.empty.classList.toggle(
    "hidden",
    hasPages
  );

  els.editor.classList.toggle(
    "hidden",
    !hasPages
  );

  els.append.disabled =
    state.busy;

  els.close.disabled =
    state.busy ||
    !hasPages;

  els.save.disabled =
    state.busy ||
    !hasPages;

  els.pageCount.textContent =
    `${state.pages.length}ページ`;

  els.pageIndicator.textContent =
    hasPages && index >= 0
      ? `${index + 1} / ${
          state.pages.length
        }`
      : "0 / 0";

  els.prev.disabled =
    state.busy ||
    index <= 0;

  els.next.disabled =
    state.busy ||
    index < 0 ||
    index >=
      state.pages.length - 1;

  els.rotateLeft.disabled =
    state.busy ||
    !hasPages;

  els.rotateRight.disabled =
    state.busy ||
    !hasPages;

  els.deletePage.disabled =
    state.busy ||
    !hasPages;

  els.movePageUp.disabled =
    state.busy ||
    index <= 0;

  els.movePageDown.disabled =
    state.busy ||
    index < 0 ||
    index >=
      state.pages.length - 1;

  els.zoom.disabled =
    state.busy ||
    !hasPages;

  els.zoomOut.disabled =
    els.zoom.disabled;

  els.zoomIn.disabled =
    els.zoom.disabled;

  const activeSource =
    sourceFor(
      currentPage()
    );

  const sourceNames = [
    ...new Set(
      state.pages
        .map(page =>
          state.sources.get(
            page.sourceId
          )?.name
        )
        .filter(Boolean)
    )
  ];

  const documentLabel =
    sourceNames.length <= 1
      ? activeSource?.name || ""
      : `${activeSource?.name ||
          sourceNames[0]} ほか${
          sourceNames.length - 1
        }ファイル`;

  els.documentName.textContent =
    documentLabel;

  els.documentName.title =
    sourceNames.join(" / ");

  syncToolButtons();
  syncToolProperties();
  syncUndoRedo();
  syncWorkspace();
}

/*
 * PDF読込み
 */

async function readPdfFiles(
  fileList
) {
  if (state.busy) {
    return;
  }

  const selectedFiles = [
    ...fileList
  ];

  const files =
    selectedFiles.filter(
      file =>
        file.type ===
          "application/pdf" ||
        /\.pdf$/i.test(file.name)
    );

  if (!files.length) {
    els.input.value = "";

    showToast(
      "PDFファイルを選択してください。",
      true
    );

    return;
  }

  if (
    files.length !==
    selectedFiles.length
  ) {
    els.input.value = "";

    showToast(
      "PDF以外のファイルが含まれています。PDFファイルだけを選択してください。",
      true
    );

    return;
  }

  for (const file of files) {
    if (
      file.size >
      MAX_SINGLE_FILE_BYTES
    ) {
      els.input.value = "";

      showToast(
        `${file.name}は100MBを超えているため読み込めません。`,
        true
      );

      return;
    }
  }

  const selectedTotalBytes =
    files.reduce(
      (total, file) =>
        total + file.size,
      0
    );

  if (
    currentTotalSourceBytes() +
      selectedTotalBytes >
    MAX_TOTAL_FILE_BYTES
  ) {
    els.input.value = "";

    showToast(
      "PDFの合計容量が上限の200MBを超えるため読み込めません。",
      true
    );

    return;
  }

  finishTextEditing();

  const before = snapshot();

  const hadPages =
    before.pages.length > 0;

  /*
   * 今回の処理でstate.sourcesへ登録した
   * sourceだけを記録します。
   */
  const addedSourceIds = [];

  setBusy(
    true,
    "PDFを読み込んでいます…"
  );

  updateStatus(
    "PDFを読み込んでいます。"
  );

  try {
    for (const file of files) {
      let pdfjsDoc = null;
      let loadingTask = null;
      let sourceRegistered = false;

      const sourceId = uid();

      try {
        const bytes =
          new Uint8Array(
            await file.arrayBuffer()
          );

        const pdfJsAuxiliaryOptions =
          getPdfJsAuxiliaryOptions();

        loadingTask =
          pdfjsLib.getDocument({
            data: bytes.slice(0),
            ...pdfJsAuxiliaryOptions
          });

        try {
          pdfjsDoc =
            await loadingTask.promise;
        } catch (error) {
          if (
            error?.name ===
            "PasswordException"
          ) {
            throw new Error(
              `${file.name}はパスワード保護されています。保護を解除したPDFを使用してください。`
            );
          }

          if (
            error instanceof
              PdfCMapError ||
            error?.name ===
              "PdfCMapError"
          ) {
            throw error;
          }

          /*
          * PDF.jsがFactory内のエラーを別のErrorで
          * 包む場合にも、causeをたどって判定します。
          */
          let cause =
            error?.cause;

          while (cause) {
            if (
              cause instanceof
                PdfCMapError ||
              cause?.name ===
                "PdfCMapError"
            ) {
              throw cause;
            }

            cause = cause.cause;
          }

          console.error(
            "PDF.js loading error:",
            error
          );

          throw new Error(
            `${file.name}を開けませんでした。PDFが破損していないか、未対応の形式でないか確認してください。`
          );
        }

        if (
          state.pages.length +
            pdfjsDoc.numPages >
          MAX_TOTAL_PAGES
        ) {
          throw new Error(
            `総ページ数が上限（${MAX_TOTAL_PAGES}ページ）を超えるため、読み込みを中断しました。`
          );
        }

        /*
         * source登録後の失敗は、外側のcatchで
         * addedSourceIdsを基に一括解放します。
         */
        state.sources.set(
          sourceId,
          {
            id: sourceId,
            name: file.name,
            bytes,
            pdfjsDoc
          }
        );

        addedSourceIds.push(
          sourceId
        );

        sourceRegistered = true;

        for (
          let pageIndex = 0;
          pageIndex <
            pdfjsDoc.numPages;
          pageIndex++
        ) {
          const pdfPage =
            await pdfjsDoc.getPage(
              pageIndex + 1
            );

          const unrotated =
            pdfPage.getViewport({
              scale: 1,
              rotation: 0
            });

          state.pages.push({
            id: uid(),
            sourceId,
            sourceIndex:
              pageIndex,
            width:
              unrotated.width,
            height:
              unrotated.height,
            baseRotation:
              normRotation(
                pdfPage.rotate || 0
              ),
            rotationExtra: 0,
            annotations: []
          });

          /*
           * PDF.jsのページオブジェクトがcleanupを
           * 提供している場合は、初期情報取得後に解放します。
           */
          try {
            pdfPage.cleanup?.();
          } catch {
            // 読込み処理を継続します。
          }
        }
      } catch (error) {
        /*
         * source登録前にPDF.jsドキュメントを作成済みなら、
         * ここで解放します。
         *
         * source登録後は外側catchの一括ロールバックに任せ、
         * 二重destroyを避けます。
         */
        if (
          pdfjsDoc &&
          !sourceRegistered
        ) {
          try {
            await pdfjsDoc.destroy();
          } catch {
            // 元のエラーを優先します。
          }
        } else if (
          loadingTask &&
          !pdfjsDoc
        ) {
          try {
            await loadingTask.destroy?.();
          } catch {
            // 元のエラーを優先します。
          }
        }

        throw error;
      }
    }

    if (hadPages) {
      pushHistory(before);
    } else {
      state.history = [];
      state.future = [];
    }

    state.currentPageId ||=
      state.pages[0]?.id ||
      null;

    syncUI();

    await renderThumbnails();
    await renderCurrentPage();

    updateStatus(
      `${files.length}ファイルを読み込みました。全${state.pages.length}ページです。`
    );

    showToast(
      hadPages
        ? "PDFを末尾へ追加しました。"
        : "PDFを読み込みました。"
    );
  } catch (error) {
    /*
     * 初回読込み・追加読込みのどちらでも、
     * ページ状態を開始前へ戻します。
     */
    state.pages =
      clone(before.pages);

    state.currentPageId =
      before.currentPageId;

    state.selectedAnnotationId =
      null;

    /*
     * 今回登録したsourceだけを解放します。
     */
    for (
      const sourceId of
      addedSourceIds
    ) {
      const source =
        state.sources.get(
          sourceId
        );

      try {
        await source
          ?.pdfjsDoc
          ?.destroy?.();
      } catch {
        // 他のsourceの解放を継続します。
      }

      state.sources.delete(
        sourceId
      );
    }

    syncUI();
    await renderThumbnails();

    if (state.pages.length) {
      await renderCurrentPage();

      updateStatus(
        "PDFの追加に失敗したため、追加前の状態へ戻しました。"
      );
    } else {
      clearViewer();

      updateStatus(
        "PDFを選択してください。"
      );
    }

    showToast(
      error?.message ||
        "PDFの読み込みに失敗しました。",
      true
    );
  } finally {
    /*
     * 同じファイルを再選択した場合にも
     * changeイベントが発生するようにします。
     */
    els.input.value = "";

    setBusy(false);
  }
}

/*
 * プレビュー
 */

function clearViewer() {
  state.renderToken++;

  try {
    currentRenderTask
      ?.cancel?.();
  } catch {
    // キャンセル不能でもクリアを継続します。
  }

  currentRenderTask = null;

  els.layer.replaceChildren();

  const context =
    els.canvas.getContext(
      "2d"
    );

  if (context) {
    context.clearRect(
      0,
      0,
      els.canvas.width,
      els.canvas.height
    );
  }

  els.canvas.width = 1;
  els.canvas.height = 1;
  els.canvas.style.width = "1px";
  els.canvas.style.height = "1px";

  els.pageHost.style.width =
    "1px";

  els.pageHost.style.height =
    "1px";

  els.layer.style.width =
    "1px";

  els.layer.style.height =
    "1px";
}

async function cancelPdfRenderTask(task, warningLabel) {
  if (!task) return;

  try {
    task.cancel?.();
    await task.promise;
  } catch (error) {
    if (
      error?.name !==
      "RenderingCancelledException"
    ) {
      console.warn(
        warningLabel,
        error
      );
    }
  }
}

async function renderCurrentPage() {
  if (state.mode !== "edit") return;
  $("pdfTextLayer").replaceChildren();
  state.textReady = false;
  const pageRef =
    currentPage();

  const token =
    ++state.renderToken;

  if (!pageRef) {
    clearViewer();
    return;
  }

  const source =
    sourceFor(pageRef);

  if (!source) {
    showToast(
      "ページの元データが見つかりません。",
      true
    );
    return;
  }

  let pdfPage = null;
  els.pageHost.inert = true;
  els.layer.replaceChildren();

  try {
    const previousRenderTask =
      currentRenderTask;

    await cancelPdfRenderTask(
      previousRenderTask,
      "Page rendering cancellation failed:"
    );

    if (
      currentRenderTask ===
      previousRenderTask
    ) {
      currentRenderTask = null;
    }

    if (
      token !==
      state.renderToken
    ) {
      return;
    }

    pdfPage =
      await source.pdfjsDoc
        .getPage(
          pageRef.sourceIndex +
            1
        );

    if (
      token !==
      state.renderToken
    ) {
      return;
    }

    const rotation =
      normRotation(
        pageRef.baseRotation +
          pageRef.rotationExtra
      );

    const unit =
      pdfPage.getViewport({
        scale: 1,
        rotation
      });

    const availableWidth =
      Math.max(
        220,
        els.viewerArea
          .clientWidth - 64
      );

    const availableHeight =
      Math.max(
        220,
        els.viewerArea
          .clientHeight - 104
      );

    let cssScale;

    if (
      els.zoom.value ===
      "fit"
    ) {
      cssScale = clamp(
        Math.min(
          availableWidth /
            unit.width,
          availableHeight /
            unit.height
        ),
        0.25,
        2.2
      );
    } else if (
      els.zoom.value ===
      "fit-width"
    ) {
      /*
       * 幅に合わせる。
       * A4縦などを横長の表示領域で読むとき、
       * 「画面に合わせる」は高さ基準で縮むため小さくなります。
       * 高さは表示領域のスクロールへ任せます。
       */
      cssScale = clamp(
        availableWidth /
          unit.width,
        0.25,
        3
      );
    } else {
      cssScale = clamp(
        Number(
          els.zoom.value
        ) / 100,
        0.25,
        3
      );
    }

    state.viewScale =
      cssScale;

    const cssWidth =
      unit.width *
      cssScale;

    const cssHeight =
      unit.height *
      cssScale;

    const renderQuality =
      previewRenderQuality(
        cssWidth,
        cssHeight
      );

    const viewport =
      pdfPage.getViewport({
        scale:
          cssScale *
          renderQuality,
        rotation
      });

    const canvasWidth =
      Math.max(
        1,
        Math.round(
          viewport.width
        )
      );

    const canvasHeight =
      Math.max(
        1,
        Math.round(
          viewport.height
        )
      );

    if (
      canvasWidth >
        PREVIEW_MAX_EDGE ||
      canvasHeight >
        PREVIEW_MAX_EDGE ||
      canvasWidth *
        canvasHeight >
        PREVIEW_MAX_PIXELS
    ) {
      throw new Error(
        "プレビュー画像が大きすぎます。表示倍率を下げてください。"
      );
    }

    els.canvas.width =
      canvasWidth;

    els.canvas.height =
      canvasHeight;

    els.canvas.style.width =
      `${cssWidth}px`;

    els.canvas.style.height =
      `${cssHeight}px`;

    els.pageHost.style.width =
      `${cssWidth}px`;

    els.pageHost.style.height =
      `${cssHeight}px`;

    els.layer.style.width =
      `${cssWidth}px`;

    els.layer.style.height =
      `${cssHeight}px`;

    const context =
      els.canvas.getContext(
        "2d",
        {
          alpha: false
        }
      );

    if (!context) {
      throw new Error(
        "Canvasを初期化できませんでした。"
      );
    }

    context.fillStyle =
      "#ffffff";

    context.fillRect(
      0,
      0,
      canvasWidth,
      canvasHeight
    );

    const task =
      pdfPage.render({
        canvasContext:
          context,
        viewport,
        intent: "display"
      });

    currentRenderTask =
      task;

    try {
      await task.promise;
    } catch (error) {
      if (
        error?.name ===
        "RenderingCancelledException"
      ) {
        return;
      }

      throw error;
    }

    if (
      token !==
      state.renderToken
    ) {
      return;
    }

    await renderPdfTextLayer(pdfPage, unit, cssScale, token);
    if (token !== state.renderToken) return;
    renderAnnotations();
    syncUI();
  } catch (error) {
    if (
      token !==
      state.renderToken
    ) {
      return;
    }

    console.error(error);

    const fallbackContext =
      els.canvas.getContext("2d");

    if (fallbackContext) {
      fallbackContext.fillStyle =
        "#ffffff";
      fallbackContext.fillRect(
        0,
        0,
        els.canvas.width,
        els.canvas.height
      );
    }

    showToast(
      error?.message ||
        "ページの表示に失敗しました。",
      true
    );

    updateStatus(
      "ページの表示に失敗しました。表示倍率を下げるか、別のPDFをお試しください。"
    );
  } finally {
    /*
     * 描画完了後または中断後に、ページ固有の
     * 描画リソースを可能な範囲で解放します。
     */
    if (pdfPage) {
      try {
        pdfPage.cleanup?.();
      } catch {
        // 解放失敗で画面表示は停止しません。
      }
    }

    if (
      token ===
      state.renderToken
    ) {
      currentRenderTask =
        null;
      els.pageHost.inert = false;
    }
  }
}


function pageDisplaySize(
  pageRef
) {
  const rotation =
    normRotation(
      pageRef.baseRotation +
        pageRef.rotationExtra
    );

  return (
    rotation === 90 ||
    rotation === 270
  )
    ? {
        width:
          pageRef.height,
        height:
          pageRef.width
      }
    : {
        width:
          pageRef.width,
        height:
          pageRef.height
      };
}

/*
 * サムネイル
 */

function createThumbnailItem(page, index) {
  const item = document.createElement("div");
  item.className = "thumb-item";
  item.dataset.pageId = page.id;
  item.draggable = !state.busy;
  item.tabIndex = 0;
  item.setAttribute("role", "listitem");
  item.setAttribute("aria-label", `${index + 1}ページ目`);
  const canvas = document.createElement("canvas");
  canvas.width = 120; canvas.height = 160; canvas.setAttribute("aria-hidden", "true");
  const meta = document.createElement("div"); meta.className = "thumb-meta";
  const number = document.createElement("span"); number.className = "thumb-page"; number.textContent = index + 1;
  const source = document.createElement("span"); source.className = "thumb-source"; source.textContent = state.sources.get(page.sourceId)?.name || "";
  const check = document.createElement("input"); check.type = "checkbox"; check.className = "page-check";
  check.setAttribute("aria-label", `${index + 1}ページ目を選択`);
  check.addEventListener("click", e => {e.stopPropagation(); choosePage(page.id, {ctrlKey:true});});
  const edit = document.createElement("button"); edit.type = "button"; edit.className = "thumb-edit"; edit.textContent = "編集";
  edit.setAttribute("aria-label", `${index + 1}ページ目を編集`);
  edit.addEventListener("click", e => {e.stopPropagation(); openPageEditor(page.id);});
  meta.append(number, source, edit); item.append(canvas, meta, check);
  if (page.annotations.length) {const dot=document.createElement("span");dot.className="thumb-annotation-dot";dot.title="図形あり";dot.setAttribute("aria-label","図形あり");item.append(dot);}
  item.addEventListener("click", e => choosePage(page.id, e));
  item.addEventListener("keydown", e => {
    if (e.target !== item || state.busy) return;
    if (e.key === "Enter") {e.preventDefault();openPageEditor(page.id);}
    if (e.key === " ") {e.preventDefault();choosePage(page.id,e);}
    if (["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"].includes(e.key)) {
      e.preventDefault(); const columns=state.mode==='overview'?Math.max(1,Math.round(els.thumbs.clientWidth/item.offsetWidth)):1;
      const d={ArrowLeft:-1,ArrowRight:1,ArrowUp:-columns,ArrowDown:columns}[e.key];
      const next=state.pages[Math.max(0,Math.min(state.pages.length-1,index+d))];
      choosePage(next.id,e);els.thumbs.querySelector(`[data-page-id="${CSS.escape(next.id)}"]`)?.focus();
    }
  });
  item.addEventListener("dragstart", e => {
    if(state.busy || state.mode !== 'overview' || e.target.closest('button,input')) {e.preventDefault();return;}
    if(!state.pageSelection.has(page.id)) choosePage(page.id,{});
    state.dragPageId=page.id;e.dataTransfer.effectAllowed="move";e.dataTransfer.setData("text/plain",page.id);item.classList.add('dragging');
  });
  item.addEventListener("dragend", clearPageDrag);
  item.addEventListener("dragover", e => {
    if(state.busy || !state.dragPageId) return;
    e.preventDefault();const r=item.getBoundingClientRect();
    const after=e.clientX>r.left+r.width/2;
    els.thumbs.querySelectorAll('[data-drop]').forEach(n=>delete n.dataset.drop);
    item.dataset.drop=after?'after':'before'; e.dataTransfer.dropEffect='move';
    updatePageDragScroll(e.clientY);
  });
  item.addEventListener("dragleave", e=> {if(!item.contains(e.relatedTarget)) delete item.dataset.drop;});
  item.addEventListener("drop", e=> {
    if(!state.dragPageId || state.busy)return;
    e.preventDefault();e.stopPropagation();reorderPage(state.dragPageId,page.id,item.dataset.drop==='after');clearPageDrag();
  });
  return item;
}


function thumbnailRenderKey(pageRef) {
  return [
    pageRef.sourceId,
    pageRef.sourceIndex,
    normRotation(
      pageRef.baseRotation +
        pageRef.rotationExtra
    )
  ].join(":");
}

async function stopThumbnailRendering() {
  const task =
    currentThumbnailRenderTask;

  await cancelPdfRenderTask(
    task,
    "Thumbnail rendering cancellation failed:"
  );

  if (
    currentThumbnailRenderTask ===
    task
  ) {
    currentThumbnailRenderTask =
      null;
  }
}

async function renderThumbnails() {
  const token =
    ++state.thumbToken;

  await stopThumbnailRendering();

  if (
    token !==
    state.thumbToken
  ) {
    return;
  }

  const activeThumb =
    document.activeElement
      ?.closest?.(".thumb-item");
  const focusedPageId =
    activeThumb?.dataset.pageId ||
    null;
  const focusWasEdit =
    document.activeElement
      ?.classList?.contains(
        "thumb-edit"
      ) || false;
  const focusWasCheck =
    document.activeElement
      ?.classList?.contains(
        "page-check"
      ) || false;

  const reusableCanvases =
    new Map();

  for (
    const item of
    els.thumbs.children
  ) {
    const canvas =
      item.querySelector("canvas");

    if (
      item.dataset.pageId &&
      canvas
    ) {
      reusableCanvases.set(
        item.dataset.pageId,
        canvas
      );
    }
  }

  els.thumbs.replaceChildren();

  const fragment =
    document.createDocumentFragment();

  for (
    let index = 0;
    index < state.pages.length;
    index++
  ) {
    const pageRef =
      state.pages[index];
    const item =
      createThumbnailItem(
        pageRef,
        index
      );
    const canvas =
      item.querySelector("canvas");
    const reusable =
      reusableCanvases.get(
        pageRef.id
      );

    if (
      canvas &&
      reusable?.dataset
        .renderKey ===
        thumbnailRenderKey(
          pageRef
        )
    ) {
      canvas.replaceWith(
        reusable
      );
    }

    fragment.append(item);
  }

  els.thumbs.append(fragment);
  syncThumbnailSelection();

  if (focusedPageId) {
    const focusedItem =
      els.thumbs.querySelector(
        `[data-page-id="${
          CSS.escape(
            focusedPageId
          )
        }"]`
      );
    const focusTarget =
      focusWasEdit
        ? focusedItem?.querySelector(
            ".thumb-edit"
          )
        : focusWasCheck
          ? focusedItem?.querySelector(
              ".page-check"
            )
          : focusedItem;
    focusTarget?.focus();
  }

  for (
    let index = 0;
    index < state.pages.length;
    index++
  ) {
    if (
      token !==
      state.thumbToken
    ) {
      return;
    }

    const pageRef =
      state.pages[index];

    const item =
      els.thumbs.querySelector(
        `[data-page-id="${
          CSS.escape(
            pageRef.id
          )
        }"]`
      );

    const canvas =
      item?.querySelector(
        "canvas"
      );

    if (!canvas) {
      continue;
    }

    const renderKey =
      thumbnailRenderKey(
        pageRef
      );

    if (
      canvas.dataset
        .renderKey ===
      renderKey
    ) {
      continue;
    }

    let pdfPage = null;
    let renderTask = null;

    try {
      const source =
        sourceFor(pageRef);

      if (!source) {
        continue;
      }

      pdfPage =
        await source.pdfjsDoc
          .getPage(
            pageRef.sourceIndex +
              1
          );

      if (
        token !==
        state.thumbToken
      ) {
        return;
      }

      const rotation =
        normRotation(
          pageRef.baseRotation +
            pageRef.rotationExtra
        );

      const unit =
        pdfPage.getViewport({
          scale: 1,
          rotation
        });

      const scale =
        Math.min(
          155 / unit.width,
          218 / unit.height
        );

      const viewport =
        pdfPage.getViewport({
          scale,
          rotation
        });

      canvas.width =
        Math.max(
          1,
          Math.floor(
            viewport.width
          )
        );

      canvas.height =
        Math.max(
          1,
          Math.floor(
            viewport.height
          )
        );

      const context =
        canvas.getContext(
          "2d",
          {
            alpha: false
          }
        );

      if (!context) {
        continue;
      }

      context.fillStyle =
        "#ffffff";
      context.fillRect(
        0,
        0,
        canvas.width,
        canvas.height
      );

      renderTask =
        pdfPage.render({
          canvasContext:
            context,
          viewport,
          intent: "display"
        });

      currentThumbnailRenderTask =
        renderTask;

      await renderTask.promise;

      if (
        token ===
        state.thumbToken
      ) {
        canvas.dataset.renderKey =
          renderKey;
      }
    } catch (error) {
      if (
        error?.name !==
          "RenderingCancelledException" &&
        token ===
          state.thumbToken
      ) {
        console.warn(
          "Thumbnail rendering failed:",
          error
        );
      }
    } finally {
      if (
        currentThumbnailRenderTask ===
        renderTask
      ) {
        currentThumbnailRenderTask =
          null;
      }

      if (
        token !==
          state.thumbToken
      ) {
        try {
          renderTask?.cancel?.();
        } catch {
          // 解放処理を継続します。
        }
      }

      if (pdfPage) {
        try {
          pdfPage.cleanup?.();
        } catch {
          // ほかのサムネイル描画を継続します。
        }
      }
    }
  }
}

function syncThumbnailSelection() {
  for(const item of els.thumbs.children) {
    const id=item.dataset.pageId, selected=state.pageSelection.has(id);
    item.classList.toggle('active', state.mode==='edit'?id===state.currentPageId:selected);
    item.querySelector('.page-check').checked=selected;
    item.setAttribute('aria-label', `${state.pages.findIndex(p=>p.id===id)+1}ページ目${selected?' 選択中':''}`);
    if(id===state.currentPageId) item.setAttribute('aria-current','page'); else item.removeAttribute('aria-current');
  }
}


function updateThumbnailAnnotationMarker(
  pageId
) {
  const page =
    state.pages.find(
      item =>
        item.id === pageId
    );

  const item =
    els.thumbs.querySelector(
      `[data-page-id="${
        CSS.escape(pageId)
      }"]`
    );

  if (!page || !item) {
    return;
  }

  let dot =
    item.querySelector(
      ".thumb-annotation-dot"
    );

  if (
    page.annotations.length &&
    !dot
  ) {
    dot =
      document.createElement(
        "span"
      );

    dot.className =
      "thumb-annotation-dot";

    dot.title = "図形あり";

    dot.setAttribute(
      "aria-label",
      "図形あり"
    );

    item.append(dot);
  } else if (
    !page.annotations.length &&
    dot
  ) {
    dot.remove();
  }
}

/*
 * ページ操作
 */

function selectPage(pageId, render = true) {
  if(state.busy || !state.pages.some(p=>p.id===pageId))return;
  finishTextEditing();state.currentPageId=pageId;state.selectedAnnotationId=null;state.figureSelection.clear();
  state.pageSelection=new Set([pageId]);state.selectionAnchor=pageId;
  syncUI();syncThumbnailSelection();
  if(render) renderCurrentPage();
}


function reorderPage(draggedId, targetId, after=false) {
  if(state.busy || !draggedId)return;
  commitPageOrder(movePages(state.pages, state.pageSelection.has(draggedId)?[...state.pageSelection]:[draggedId], targetId, after));
}


function moveCurrentPage(direction) {
  if(state.busy)return;
  commitPageOrder(stepPages(state.pages,[...state.pageSelection],direction));
}


function transformAnnotationsForRotation(page, delta) {
  const size=pageDisplaySize(page);
  page.annotations.forEach(a=>rotateAnnotation(a,size,delta));
}


function rotateCurrent(delta) {
  const pages=selectedPages(); if(state.busy || !pages.length)return;
  finishTextEditing();pushHistory();
  pages.forEach(page=>{transformAnnotationsForRotation(page,delta);page.rotationExtra=normRotation(page.rotationExtra+delta);});
  state.selectedAnnotationId=null;state.figureSelection.clear();
  if(state.mode==="overview") renderThumbnails(); else renderCurrentPage();
  syncUI();
  updateStatus(`${pages.length}ページを${delta>0?'右':'左'}へ90度回転しました。`);
}


function deleteCurrentPage() {
  const pages=selectedPages();if(state.busy||!pages.length)return;
  if(pages.length===state.pages.length){showToast('最後の1ページは残してください。すべて閉じる場合は「閉じる」を使用します。');return;}
  if(!confirm(`${pages.length}ページを削除しますか？ 元に戻すことができます。`))return;
  finishTextEditing();pushHistory();const index=currentPageIndex();
  state.pages=state.pages.filter(p=>!state.pageSelection.has(p.id));
  state.currentPageId=state.pages[Math.min(index,state.pages.length-1)].id;
  state.pageSelection=new Set([state.currentPageId]);state.selectionAnchor=state.currentPageId;state.selectedAnnotationId=null;state.figureSelection.clear();
  syncUI();
  if(state.mode==="overview") renderThumbnails(); else renderCurrentPage();
  updateStatus(`${pages.length}ページを削除しました。`);
}


/*
 * ツール・図形表示
 */

function setTool(tool) {
  if (
    state.busy ||
    ![
      "select",
      "text",
      "rect",
      "arrow", "ellipse", "line", "highlight"
    ].includes(tool)
  ) {
    return;
  }

  finishTextEditing();

  state.tool = tool;
  state.figureSelection.clear();
  getSelection()?.removeAllRanges();

  state.selectedAnnotationId =
    null;

  els.layer.classList.remove(
    "tool-text",
    "tool-rect",
    "tool-arrow", "tool-ellipse", "tool-line", "tool-highlight"
  );

  if (tool !== "select") {
    els.layer.classList.add(
      `tool-${tool}`
    );
  }

  syncToolButtons();
  syncToolProperties();
  renderAnnotations();
}

function syncToolProperties() {
  syncFloatingProperties();
  const annotation =
    currentAnnotation();

  const type =
    annotation?.type ||
    state.tool;

  const color =
    annotation?.color ||
    (type === "text"
      ? state.defaults.textColor
      : type === "highlight" ? state.markerColor : state.defaults.color);

  const stroke =
    annotation?.strokeWidth ||
    state.defaults.stroke;

  const fontSize =
    annotation?.fontSize ||
    state.defaults.fontSize;

  const fontFamily =
    annotation?.fontFamily ||
    state.defaults.fontFamily;

  const bold =
    annotation?.bold ??
    state.defaults.bold;

  const backgroundColor =
    annotation?.bgColor ||
    state.defaults.bgColor;

  const transparent =
    annotation?.bgTransparent ??
    (
      annotation?.whiteBg ===
        false
        ? true
        : state.defaults
            .bgTransparent
    );

  if (els.color) {
    els.color.value = color;
    els.color.disabled =
      state.busy ||
      !state.pages.length;
  }

  if (els.stroke) {
    els.stroke.value =
      String(stroke);

    els.stroke.disabled =
      state.busy ||
      !state.pages.length;
  }

  if (els.font) {
    els.font.value =
      String(fontSize);

    els.font.disabled =
      state.busy ||
      !state.pages.length;
  }

  if (els.fontFamilyButton) {
    const safeFontFamily =
      FONT_STACKS[fontFamily]
        ? fontFamily
        : DEFAULT_FONT_FAMILY;

    els.fontFamilyButton.textContent =
      fontLabelFor(safeFontFamily);

    els.fontFamilyButton.style.fontFamily =
      fontStackFor(safeFontFamily);

    els.fontFamilyButton.disabled =
      state.busy ||
      !state.pages.length;

    els.fontFamilyMenu
      ?.querySelectorAll(
        "[data-font-family]"
      )
      .forEach(option => {
        option.setAttribute(
          "aria-selected",
          String(
            option.dataset.fontFamily ===
              safeFontFamily
          )
        );
      });
  }

  if (els.bold) {
    els.bold.setAttribute(
      "aria-pressed",
      String(Boolean(bold))
    );
    els.bold.classList.toggle(
      "active",
      Boolean(bold)
    );
    els.bold.disabled =
      state.busy ||
      !state.pages.length;
  }

  if (els.bgColor) {
    els.bgColor.value =
      backgroundColor;

    els.bgColor.disabled =
      state.busy ||
      !state.pages.length ||
      Boolean(transparent);
  }

  if (els.bgTransparent) {
    els.bgTransparent.checked =
      Boolean(transparent);

    els.bgTransparent.disabled =
      state.busy ||
      !state.pages.length;
  }

  els.strokeField
    ?.classList.toggle(
      "hidden",
      type === "text" || type === "highlight"
    );

  els.fontFamilyField
    ?.classList.toggle(
      "hidden",
      type !== "text"
    );

  els.fontField
    ?.classList.toggle(
      "hidden",
      type !== "text"
    );

  els.boldField
    ?.classList.toggle(
      "hidden",
      type !== "text"
    );

  els.bgColorField
    ?.classList.toggle(
      "hidden",
      type !== "text"
    );

  els.bgTransparentField
    ?.classList.toggle(
      "hidden",
      type !== "text"
    );

  if (els.deleteAnn) {
    els.deleteAnn.disabled =
      state.busy ||
      !annotation;
  }
}

function renderAnnotations() { renderFigures(); }


function selectAnnotation(id) {
  if (state.busy) {
    return;
  }

  state.selectedAnnotationId =
    id;

  state.tool = "select";

  els.layer.className =
    "annotation-layer";

  syncToolButtons();
  renderAnnotations();
}

function pagePointFromEvent(
  event
) {
  const rect =
    els.layer
      .getBoundingClientRect();

  const scale =
    Math.max(
      state.viewScale,
      0.0001
    );

  return {
    x: clamp(
      (
        event.clientX -
        rect.left
      ) / scale,
      0,
      rect.width / scale
    ),

    y: clamp(
      (
        event.clientY -
        rect.top
      ) / scale,
      0,
      rect.height / scale
    )
  };
}

function addTextAt(point) {
  if (state.busy) {
    return;
  }

  const page =
    currentPage();

  if (!page) {
    return;
  }

  const size =
    pageDisplaySize(page);

  const width =
    Math.min(
      250,
      Math.max(
        120,
        size.width -
          point.x -
          10
      )
    );

  const height =
    Math.min(
      72,
      Math.max(
        30,
        size.height -
          point.y
      )
    );

  pushHistory();

  const annotation = {
    id: uid(),
    type: "text",

    x: clamp(
      point.x,
      0,
      Math.max(
        0,
        size.width - width
      )
    ),

    y: clamp(
      point.y,
      0,
      Math.max(
        0,
        size.height -
          height
      )
    ),

    w: width,
    h: height,
    text: "",

    fontSize:
      state.defaults.fontSize,

    fontFamily:
      state.defaults
        .fontFamily,

    color:
      state.defaults.textColor,

    bold:
      state.defaults.bold,

    outline: state.defaults.outline,
    bgColor:
      state.defaults.bgColor,

    bgTransparent:
      state.defaults
        .bgTransparent
  };

  page.annotations.push(
    annotation
  );

  state.selectedAnnotationId = annotation.id;
  state.figureSelection = new Set([annotation.id]);

  state.tool = "select";
  syncToolButtons();

  els.layer.className =
    "annotation-layer";

  renderAnnotations();

  requestAnimationFrame(
    () =>
      startTextEditing(
        annotation.id,
        true
      )
  );
}

function beginDrawing(
  event,
  type
) {
  if (
    state.busy ||
    event.button !== 0
  ) {
    return;
  }

  const page =
    currentPage();

  if (!page) {
    return;
  }

  event.preventDefault();

  const start =
    pagePointFromEvent(event);

  const before =
    snapshot();

  const annotation =
    ["rect", "ellipse"].includes(type)
      ? {
          id: uid(),
          type, fill: state.defaults.fill, fillNone: state.defaults.fillNone,
          x: start.x,
          y: start.y,
          w: 0,
          h: 0,
          color:
            state.defaults
              .color,
          strokeWidth:
            state.defaults
              .stroke
        }
      : {
          id: uid(),
          type, outline: type === "arrow" && state.defaults.outline,
          x1: start.x,
          y1: start.y,
          x2: start.x,
          y2: start.y,
          color:
            state.defaults
              .color,
          strokeWidth:
            state.defaults
              .stroke
        };

  page.annotations.push(
    annotation
  );

  state.selectedAnnotationId = annotation.id;
  state.figureSelection = new Set([annotation.id]);

  els.layer
    .setPointerCapture?.(
      event.pointerId
    );

  els.layer.classList.add(
    "drawing"
  );

  const move =
    moveEvent => {
      if (state.busy) {
        return;
      }

      const point =
        pagePointFromEvent(
          moveEvent
        );

      if (["rect", "ellipse"].includes(type)) {
        annotation.x =
          Math.min(
            start.x,
            point.x
          );

        annotation.y =
          Math.min(
            start.y,
            point.y
          );

        annotation.w =
          Math.abs(
            point.x -
            start.x
          );

        annotation.h =
          Math.abs(
            point.y -
            start.y
          );
      } else {
        annotation.x2 =
          point.x;

        annotation.y2 =
          point.y;
      }

      renderAnnotations();

      els.layer.classList.add(
        "drawing"
      );
    };

  const finish =
    finishEvent => {
      els.layer.removeEventListener(
        "pointermove",
        move
      );

      els.layer.removeEventListener(
        "pointerup",
        finish
      );

      els.layer.removeEventListener(
        "pointercancel",
        finish
      );

      els.layer.classList.remove(
        "drawing"
      );

      try {
        els.layer
          .releasePointerCapture?.(
            finishEvent.pointerId
          );
      } catch {
        // 解放不能でも終了処理を継続します。
      }

      const tooSmall =
        ["rect", "ellipse"].includes(type)
          ? (
              annotation.w < 5 ||
              annotation.h < 5
            )
          : (
              Math.hypot(
                annotation.x2 -
                  annotation.x1,
                annotation.y2 -
                  annotation.y1
              ) < 8
            );

      if (tooSmall || finishEvent.type === "pointercancel") {
        page.annotations =
          page.annotations.filter(
            item =>
              item.id !==
              annotation.id
          );

        state
          .selectedAnnotationId =
          null;
      } else {
        pushHistory(before);

        state.tool = "select";
        els.layer.className = "annotation-layer";

        syncToolButtons();
      }

      renderAnnotations();

      updateThumbnailAnnotationMarker(
        page.id
      );
    };

  els.layer.addEventListener(
    "pointermove",
    move
  );

  els.layer.addEventListener(
    "pointerup",
    finish
  );

  els.layer.addEventListener(
    "pointercancel",
    finish
  );
}

function beginMove(event, annotationId) { beginFigureMove(event, annotationId); }


function beginResize(
  event,
  annotationId
) {
  if (
    state.busy ||
    state.tool !== "select" ||
    event.button !== 0
  ) {
    return;
  }

  const page =
    currentPage();

  const annotation =
    page?.annotations.find(
      item =>
        item.id ===
        annotationId
    );

  if (
    !page ||
    !annotation ||
    annotation.type ===
      "arrow"
  ) {
    return;
  }

  event.stopPropagation();
  event.preventDefault();

  const before =
    snapshot();

  const startClient = {
    x: event.clientX,
    y: event.clientY
  };

  const original =
    clone(annotation);

  const size =
    pageDisplaySize(page);

  let changed = false;

  const move =
    moveEvent => {
      if (state.busy) {
        return;
      }

      const dx =
        (
          moveEvent.clientX -
          startClient.x
        ) /
        state.viewScale;

      const dy =
        (
          moveEvent.clientY -
          startClient.y
        ) /
        state.viewScale;

      annotation.w =
        clamp(
          original.w + dx,
          annotation.type ===
            "text"
            ? 70
            : 8,
          Math.max(
            annotation.type ===
              "text"
              ? 70
              : 8,
            size.width -
              annotation.x
          )
        );

      annotation.h =
        clamp(
          original.h + dy,
          annotation.type ===
            "text"
            ? 30
            : 8,
          Math.max(
            annotation.type ===
              "text"
              ? 30
              : 8,
            size.height -
              annotation.y
          )
        );

      changed ||=
        Math.abs(dx) +
          Math.abs(dy) >
        1;

      renderAnnotations();
    };

  const finish = event => {
    document.removeEventListener(
      "pointermove",
      move
    );

    document.removeEventListener(
      "pointerup",
      finish
    );

    document.removeEventListener(
      "pointercancel",
      finish
    );

    if (event.type === "pointercancel") { Object.assign(annotation, original); renderAnnotations(); }
    else if (changed) { pushHistory(before); }

    updateThumbnailAnnotationMarker(
      page.id
    );
  };

  document.addEventListener(
    "pointermove",
    move
  );

  document.addEventListener(
    "pointerup",
    finish,
    {
      once: true
    }
  );

  document.addEventListener(
    "pointercancel",
    finish,
    {
      once: true
    }
  );
}

function startTextEditing(
  annotationId,
  isNew = false
) {
  if (state.busy) {
    return;
  }

  const page =
    currentPage();

  const annotation =
    page?.annotations.find(
      item =>
        item.id ===
          annotationId &&
        item.type === "text"
    );

  if (!page || !annotation) {
    return;
  }

  state.figureSelection = new Set([annotationId]);
  state.selectedAnnotationId =
    annotationId;

  const element =
    els.layer.querySelector(
      `[data-ann-id="${
        CSS.escape(
          annotationId
        )
      }"]`
    );

  if (!element) {
    return;
  }

  const beforeText =
    annotation.text;

  /*
   * 新規作成の場合、addTextAt()が作成直前に積んだ
   * 履歴の位置を記録します。
   *
   * 現在の実装では作成直後に編集を開始するため、
   * 通常は末尾の履歴が該当します。
   */
  const creationHistoryIndex =
    isNew
      ? state.history.length - 1
      : -1;

  const creationHistoryEntry =
    creationHistoryIndex >= 0
      ? state.history[
          creationHistoryIndex
        ]
      : null;

  element.classList.add(
    "editing"
  );

  element.contentEditable =
    "true";

  element.spellcheck = false;

  element.textContent =
    annotation.text;

  element.focus();

  if (isNew) {
    const range =
      document.createRange();

    range.selectNodeContents(
      element
    );

    const selection =
      getSelection();

    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  const finish = () => {
    element.removeEventListener(
      "blur",
      finish
    );

    const newText =
      element.textContent
        .replace(/\r/g, "");

    annotation.text =
      newText;

    element.contentEditable =
      "false";

    element.classList.remove(
      "editing"
    );

    if (
      newText !== beforeText &&
      !isNew
    ) {
      const snapBefore =
        snapshot();

      const pageBefore =
        snapBefore.pages.find(
          item =>
            item.id === page.id
        );

      const annotationBefore =
        pageBefore?.annotations
          .find(
            item =>
              item.id ===
              annotationId
          );

      if (annotationBefore) {
        annotationBefore.text =
          beforeText;
      }

      pushHistory(
        snapBefore
      );
    }

    if (
      !annotation.text.trim() &&
      isNew
    ) {
      page.annotations =
        page.annotations.filter(
          item =>
            item.id !==
            annotationId
        );

      state.selectedAnnotationId =
        null;

      /*
       * 履歴の同じ位置に同じオブジェクトが残っている場合だけ、
       * 新規テキスト作成前の履歴を取り除きます。
       *
       * 他の操作で履歴が変化していた場合は、
       * 誤った履歴を削除しません。
       */
      if (
        creationHistoryIndex >= 0 &&
        state.history[
          creationHistoryIndex
        ] === creationHistoryEntry
      ) {
        state.history.splice(
          creationHistoryIndex,
          1
        );

        /*
         * 空テキスト作成は操作として成立しないため、
         * この操作によって消去されたRedo履歴は
         * 復元できません。通常の編集操作と同じ扱いです。
         */
        syncUndoRedo();
      }
    }

    renderAnnotations();

    updateThumbnailAnnotationMarker(
      page.id
    );
  };

  element.addEventListener(
    "blur",
    finish
  );
}


function finishTextEditing() {
  const editing =
    els.layer.querySelector(
      "[contenteditable='true']"
    );

  editing?.blur();
}

function deleteSelectedAnnotation() {
  if(state.busy || !currentPage())return;
  finishTextEditing();const ids=selectedFigures().map(a=>a.id);if(!ids.length)return;
  pushHistory();currentPage().annotations=currentPage().annotations.filter(a=>!ids.includes(a.id));
  state.selectedAnnotationId=null;state.figureSelection.clear();renderAnnotations();updateThumbnailAnnotationMarker(currentPage().id);
  updateStatus(`${ids.length}個の図形を削除しました。`);
}


function applyProperty(kind,value) {
  if(state.busy)return;
  finishTextEditing();const annotations=selectedFigures();
  if(!annotations.length) {
    const keys={color:state.tool==='text'?'textColor':'color',strokeWidth:'stroke'};
    if(state.tool==='highlight'&&kind==='color')state.markerColor=value;
    else if(state.tool==='highlight'&&kind==='opacity')state.markerOpacity=Number(value);
    else state.defaults[keys[kind]||kind]=value;
    syncToolProperties();return;
  }
  const textKeys=['fontSize','fontFamily','bold','bgColor','bgTransparent'];
  const eligible=annotations.filter(a=>textKeys.includes(kind)?a.type==='text':kind==='outline'?['text','arrow'].includes(a.type):['fill','fillNone'].includes(kind)?['rect','ellipse'].includes(a.type):kind==='opacity'?a.type==='highlight':kind==='strokeWidth'?!['text','highlight'].includes(a.type):true);
  if(!eligible.length||eligible.every(a=>a[kind]===value))return;
  pushHistory();eligible.forEach(a=>a[kind]=value);renderAnnotations();updateThumbnailAnnotationMarker(currentPage().id);
}


/*
 * PDF保存
 */

function hexToRgb(hex) {
  const match =
    /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i
      .exec(hex);

  return match
    ? [
        parseInt(
          match[1],
          16
        ) / 255,

        parseInt(
          match[2],
          16
        ) / 255,

        parseInt(
          match[3],
          16
        ) / 255
      ]
    : [
        0.8,
        0.2,
        0.3
      ];
}

function wrapCanvasText(
  context,
  text,
  maximumWidth
) {
  const paragraphs =
    String(text || "")
      .split("\n");

  const lines = [];

  for (
    const paragraph of
    paragraphs
  ) {
    if (!paragraph) {
      lines.push("");
      continue;
    }

    let current = "";

    for (
      const character of
      Array.from(paragraph)
    ) {
      const trial =
        current +
        character;

      if (
        current &&
        context
          .measureText(trial)
          .width >
          maximumWidth
      ) {
        lines.push(current);
        current = character;
      } else {
        current = trial;
      }
    }

    lines.push(current);
  }

  return lines;
}

async function renderTextAnnotationPng(
  annotation
) {
  let rasterScale =
    TEXT_RASTER_SCALE;

  const width =
    Math.max(
      1,
      annotation.w
    );

  const height =
    Math.max(
      1,
      annotation.h
    );

  const byPixels =
    Math.sqrt(
      TEXT_RASTER_MAX_PIXELS /
      (width * height)
    );

  const byEdge =
    Math.min(
      TEXT_RASTER_MAX_EDGE /
        width,
      TEXT_RASTER_MAX_EDGE /
        height
    );

  rasterScale =
    clamp(
      Math.min(
        rasterScale,
        byPixels,
        byEdge
      ),
      0.25,
      TEXT_RASTER_SCALE
    );

  const canvas =
    document.createElement(
      "canvas"
    );

  canvas.width =
    Math.max(
      2,
      Math.ceil(
        width *
        rasterScale
      )
    );

  canvas.height =
    Math.max(
      2,
      Math.ceil(
        height *
        rasterScale
      )
    );

  if (
    canvas.width >
      TEXT_RASTER_MAX_EDGE ||
    canvas.height >
      TEXT_RASTER_MAX_EDGE ||
    canvas.width *
      canvas.height >
      TEXT_RASTER_MAX_PIXELS
  ) {
    throw new Error(
      "テキスト領域が大きすぎるため画像化できません。テキスト枠を小さくしてください。"
    );
  }

  const context =
    canvas.getContext("2d");

  if (!context) {
    throw new Error(
      "テキスト画像を初期化できませんでした。"
    );
  }

  context.scale(
    rasterScale,
    rasterScale
  );

  context.clearRect(
    0,
    0,
    width,
    height
  );

  const transparent =
    annotation
      .bgTransparent ??
    (
      annotation.whiteBg ===
      false
    );

  if (!transparent) {
    context.fillStyle =
      annotation.bgColor ||
      "#ffffff";

    context.fillRect(
      0,
      0,
      width,
      height
    );
  }

  const padding = 4;

  context.font =
    `${annotation.bold ? "700 " : "400 "}` +
    `${annotation.fontSize}px ` +
    fontStackFor(
      annotation.fontFamily
    );

  context.textBaseline =
    "top";

  context.fillStyle =
    annotation.color;

  const lineHeight =
    annotation.fontSize *
    1.32;

  const lines =
    wrapCanvasText(
      context,
      annotation.text,
      Math.max(
        1,
        width -
          padding * 2
      )
    );

  let y = padding;

  for (const line of lines) {
    if (
      y + lineHeight >
      height + 0.5
    ) {
      break;
    }

    if (annotation.outline) {
      context.strokeStyle = "#ffffff";
      context.lineWidth = 2;
      context.lineJoin = "round";
      context.strokeText(line, padding, y);
    }
    context.fillText(
      line,
      padding,
      y
    );

    y += lineHeight;
  }

  const blob =
    await new Promise(
      (resolve, reject) => {
        canvas.toBlob(
          result =>
            result
              ? resolve(result)
              : reject(
                  new Error(
                    "テキスト画像の作成に失敗しました。"
                  )
                ),
          "image/png"
        );
      }
    );

  return new Uint8Array(
    await blob.arrayBuffer()
  );
}

function drawEmbeddedPage(
  outputPage,
  embeddedPage,
  width,
  height,
  rotation
) {
  const normalized =
    normRotation(rotation);

  if (normalized === 0) {
    outputPage.drawPage(
      embeddedPage,
      {
        x: 0,
        y: 0,
        width,
        height
      }
    );
  } else if (
    normalized === 90
  ) {
    outputPage.drawPage(
      embeddedPage,
      {
        x: 0,
        y: width,
        width,
        height,
        rotate: degrees(270)
      }
    );
  } else if (
    normalized === 180
  ) {
    outputPage.drawPage(
      embeddedPage,
      {
        x: width,
        y: height,
        width,
        height,
        rotate: degrees(180)
      }
    );
  } else {
    outputPage.drawPage(
      embeddedPage,
      {
        x: height,
        y: 0,
        width,
        height,
        rotate: degrees(90)
      }
    );
  }
}

function drawArrowOnPdf(page, annotation, outputHeight) {
  const a=annotation, segments=[[a.x1,a.y1,a.x2,a.y2]];
  if(a.type==='arrow') {
    const angle=Math.atan2(a.y2-a.y1,a.x2-a.x1),head=7+a.strokeWidth*2.2;
    for(const d of [-Math.PI/6,Math.PI/6])segments.push([a.x2,a.y2,a.x2-head*Math.cos(angle+d),a.y2-head*Math.sin(angle+d)]);
  }
  for(const outline of a.outline&&a.type==='arrow'?[true,false]:[false]) {
    const color=outline?rgb(1,1,1):rgb(...hexToRgb(a.color));
    for(const [x1,y1,x2,y2] of segments)page.drawLine({start:{x:x1,y:outputHeight-y1},end:{x:x2,y:outputHeight-y2},thickness:a.strokeWidth+(outline?2:0),color,lineCap:1});
  }
}

function hasCoveringAnnotations(
  pages = state.pages
) {
  return pages.some(
    page =>
      page.annotations.some(
        annotation =>
          [
            "rect",
            "ellipse",
            "text"
          ].includes(
            annotation.type
          )
      )
  );
}

/*
 * 1つのPDFを開いただけで、ページ順・回転・図形に変更がない場合は
 * pdf-libで再構築せず元PDFのバイト列をそのまま保存します。
 *
 * v3.3の容量改善ロジックを監査版へ統合したものです。
 */
function originalSourceIfUnchanged() {
  if (
    state.sources.size !== 1 ||
    !state.pages.length
  ) {
    return null;
  }

  const source =
    [...state.sources.values()][0];

  if (
    state.pages.length !==
    source.pdfjsDoc.numPages
  ) {
    return null;
  }

  for (
    let index = 0;
    index < state.pages.length;
    index++
  ) {
    const page = state.pages[index];

    if (
      page.sourceId !== source.id ||
      page.sourceIndex !== index ||
      normRotation(
        page.rotationExtra
      ) !== 0 ||
      page.annotations.length !== 0
    ) {
      return null;
    }
  }

  return source;
}

function downloadPdfBytes(
  bytes,
  fileName
) {
  const blob =
    new Blob(
      [bytes],
      {
        type: "application/pdf"
      }
    );

  const url =
    URL.createObjectURL(blob);

  const anchor =
    document.createElement("a");

  anchor.href = url;
  anchor.download =
    sanitizePdfName(fileName);

  document.body.append(anchor);
  anchor.click();
  anchor.remove();

  setTimeout(
    () => URL.revokeObjectURL(url),
    2000
  );
}

function effectivePageRotation(
  reference
) {
  return normRotation(
    reference.baseRotation +
      reference.rotationExtra
  );
}

function outputPageSize(
  width,
  height,
  rotation
) {
  const normalized =
    normRotation(rotation);

  return (
    normalized === 90 ||
    normalized === 270
  )
    ? {
        width: height,
        height: width
      }
    : {
        width,
        height
      };
}


/*
 * 回転済みページへ図形を置いた場合だけ、図形座標との互換性を優先して
 * 従来のembedPage()方式へフォールバックします。
 *
 * それ以外はcopyPages()を使い、元PDFのフォント・画像等の共有リソースが
 * ページごとに大量複製されることを抑えます。
 */
function needsFlattenedPageExport(
  reference
) {
  /*
   * 図形座標は画面上の回転後座標で保持しています。
   *
   * 回転があるページへ図形を配置する場合は、
   * 元ページを明示的に回転して新しいページへ配置し、
   * その上へ図形を描画します。
   */
  return (
    reference.annotations.length > 0 &&
    effectivePageRotation(
      reference
    ) !== 0
  );
}


async function drawAnnotationsOnPdf(output, page, reference, height) {
  for(const a of reference.annotations) {
    const color=rgb(...hexToRgb(a.color));
    if(['rect','ellipse'].includes(a.type)) {
      const options={borderColor:color,borderWidth:a.strokeWidth,color:a.fillNone!==false?undefined:rgb(...hexToRgb(a.fill))};
      if(a.type==='rect')page.drawRectangle({...options,x:a.x,y:height-a.y-a.h,width:a.w,height:a.h});
      else page.drawEllipse({...options,x:a.x+a.w/2,y:height-a.y-a.h/2,xScale:a.w/2,yScale:a.h/2});
    } else if(isLine(a))drawArrowOnPdf(page,a,height);
    else if(a.type==='highlight') {
      for(const r of a.rects)page.drawRectangle({x:r.x,y:height-r.y-r.h,width:r.w,height:r.h,color,opacity:a.opacity,blendMode:'Multiply',borderWidth:0});
    } else if(a.type==='text'&&a.text.trim()) {
      const image=await output.embedPng(await renderTextAnnotationPng(a));
      page.drawImage(image,{x:a.x,y:height-a.y-a.h,width:a.w,height:a.h});
    }
  }
}

async function exportPdf(extract = false) {
  extract = extract === true;
  const exportPages = extract ? selectedPages() : [...state.pages];
  if (
    !exportPages.length ||
    state.busy
  ) {
    return;
  }

  finishTextEditing();

  if (
    hasCoveringAnnotations(
      exportPages
    )
  ) {
    const accepted =
      confirm(
        "【必読】\nマスキング用途で使用しないでください（データは見えます）\n四角・丸やテキストを重ねても、元の文字や画像データはPDF内に残ります。\n個人情報・機密情報の削除や非表示には使用しないでください。\n\nPDFを保存しますか？"
      );

    if (!accepted) {
      return;
    }
  }

  setBusy(
    true,
    "編集済PDFを作成しています…"
  );

  updateStatus(
    "PDFを書き出しています。ページ数が多い場合は時間がかかります。"
  );

  try {
    const unchangedSource =
      extract ? null : originalSourceIfUnchanged();

    if (unchangedSource) {
      downloadPdfBytes(
        unchangedSource.bytes.slice(
          0
        ),
        unchangedSource.name
      );

      updateStatus(
        "変更がないため、元PDFをそのまま保存しました。"
      );

      showToast(
        "変更がないため、元PDFをそのまま保存しました。"
      );

      return;
    }

    const output =
      await PDFDocument.create({
        updateMetadata: false
      });

    const loadedSources =
      new Map();

    for (
      const [
        sourceId,
        source
      ] of state.sources
    ) {
      if (
        !exportPages.some(
          page =>
            page.sourceId ===
            sourceId
        )
      ) {
        continue;
      }

      try {
        loadedSources.set(
          sourceId,
          await PDFDocument.load(
            source.bytes.slice(0),
            {
              updateMetadata: false
            }
          )
        );
      } catch {
        throw new Error(
          `${source.name}を書き出し用に読み込めませんでした。暗号化PDFや未対応形式は利用できません。`
        );
      }
    }

    /*
     * 通常経路で使用するページを、
     * 元PDFごとにまとめてコピーします。
     */
    const copiedPages =
      new Map();

    /*
     * 回転ページへ図形を追加した場合に使用する、
     * 回転情報を0度へ正規化したコピーです。
     *
     * 通常経路のコピーと分離することで、
     * 同じPDFPageを複数回outputへ追加しません。
     */
    const flattenedSourcePages =
      new Map();

    for (
      const [
        sourceId,
        sourceDocument
      ] of loadedSources
    ) {
      const regularReferences =
        exportPages.filter(
          reference =>
            reference.sourceId ===
              sourceId &&
            !needsFlattenedPageExport(
              reference
            )
        );

      if (
        regularReferences.length
      ) {
        const copies =
          await output.copyPages(
            sourceDocument,
            regularReferences.map(
              reference =>
                reference.sourceIndex
            )
          );

        regularReferences.forEach(
          (
            reference,
            index
          ) => {
            copiedPages.set(
              reference.id,
              copies[index]
            );
          }
        );
      }

      const flattenedReferences =
        exportPages.filter(
          reference =>
            reference.sourceId ===
              sourceId &&
            needsFlattenedPageExport(
              reference
            )
        );

      if (
        flattenedReferences.length
      ) {
        const copies =
          await output.copyPages(
            sourceDocument,
            flattenedReferences.map(
              reference =>
                reference.sourceIndex
            )
          );

        flattenedReferences.forEach(
          (
            reference,
            index
          ) => {
            const copied =
              copies[index];

            copied.setRotation(
              degrees(0)
            );

            flattenedSourcePages.set(
              reference.id,
              copied
            );
          }
        );
      }
    }

    for (
      let index = 0;
      index < exportPages.length;
      index++
    ) {
      const reference =
        exportPages[index];

      updateStatus(
        `PDFを書き出しています… ${index + 1} / ${exportPages.length}`
      );

      const sourceDocument =
        loadedSources.get(
          reference.sourceId
        );

      if (!sourceDocument) {
        throw new Error(
          "PDFの元データが見つかりません。"
        );
      }

      const sourcePage =
        sourceDocument.getPage(
          reference.sourceIndex
        );

      const {
        width,
        height
      } =
        sourcePage.getSize();

      const rotation =
        effectivePageRotation(
          reference
        );

      if (
        needsFlattenedPageExport(
          reference
        )
      ) {
        const flattenedCopy =
          flattenedSourcePages.get(
            reference.id
          );

        if (!flattenedCopy) {
          throw new Error(
            "回転ページの書き出し準備に失敗しました。"
          );
        }

        const size =
          outputPageSize(
            width,
            height,
            rotation
          );

        const outputPage =
          output.addPage([
            size.width,
            size.height
          ]);

        /*
         * 回転情報を0度に正規化したコピーを
         * Form XObjectとして埋め込みます。
         */
        const embedded =
          await output.embedPage(
            flattenedCopy
          );

        drawEmbeddedPage(
          outputPage,
          embedded,
          width,
          height,
          rotation
        );

        await drawAnnotationsOnPdf(
          output,
          outputPage,
          reference,
          size.height
        );

        continue;
      }

      const copied =
        copiedPages.get(
          reference.id
        );

      if (!copied) {
        throw new Error(
          "ページのコピーに失敗しました。"
        );
      }

      /*
       * copyPages()で引き継がれた元の回転角を、
       * 編集後の最終回転角で上書きします。
       */
      copied.setRotation(
        degrees(rotation)
      );

      output.addPage(copied);

      /*
       * この経路で図形が存在する場合、rotationは0度です。
       * そのため、画面座標を通常のPDF座標へ変換して
       * コピー済みページへ直接描画できます。
       */
      if (
        reference.annotations.length
      ) {
        await drawAnnotationsOnPdf(
          output,
          copied,
          reference,
          height
        );
      }
    }

    const bytes =
      await output.save({
        useObjectStreams: true
      });

    const firstOutputPage =
      exportPages[0];

    const firstOutputSource =
      firstOutputPage
        ? state.sources.get(
            firstOutputPage.sourceId
          )
        : null;

    downloadPdfBytes(
      bytes,
      extract ? `抽出_${firstOutputSource?.name || "document.pdf"}` : firstOutputSource?.name || "document.pdf"
    );


    updateStatus(
      "編集済PDFを保存しました。"
    );

    showToast(
      "編集済PDFを保存しました。"
    );
  } catch (error) {
    console.error(error);

    updateStatus(
      "PDFの保存に失敗しました。"
    );

    showToast(
      error?.message ||
        "PDFの保存に失敗しました。",
      true
    );
  } finally {
    setBusy(false);
  }
}


/*
 * PDFを閉じる
 */

function restoreIntroDisclosure() {
  if (
    els.collapseToggle?.getAttribute(
      "aria-expanded"
    ) === "false"
  ) {
    /*
     * 共通appbox-collapse.jsの状態更新を再利用し、
     * ラベル・aria属性・対象要素をまとめて初期表示へ戻します。
     */
    els.collapseToggle.click();
  }
}

async function clearDocument() {
  if (
    !state.pages.length ||
    state.busy
  ) {
    return;
  }

  finishTextEditing();

  const accepted =
    confirm(
      "現在読み込んでいるPDFと図形をすべて閉じますか？\n未保存の編集内容は失われます。"
    );

  if (!accepted) {
    return;
  }

  setBusy(
    true,
    "PDFを閉じています…"
  );

  state.renderToken++;
  state.thumbToken++;

  try {
    const pageRenderTask =
      currentRenderTask;
    await cancelPdfRenderTask(
      pageRenderTask,
      "Page rendering cancellation failed while closing:"
    );
    if (
      currentRenderTask ===
      pageRenderTask
    ) {
      currentRenderTask = null;
    }

    const thumbnailRenderTask =
      currentThumbnailRenderTask;
    await cancelPdfRenderTask(
      thumbnailRenderTask,
      "Thumbnail rendering cancellation failed while closing:"
    );
    if (
      currentThumbnailRenderTask ===
      thumbnailRenderTask
    ) {
      currentThumbnailRenderTask =
        null;
    }

    for (
      const source of
      state.sources.values()
    ) {
      try {
        await source
          .pdfjsDoc
          ?.destroy?.();
      } catch {
        // 他のsourceの解放を継続します。
      }
    }

    state.sources.clear();
    state.pages = [];
    state.currentPageId = null;
    state.selectedAnnotationId =
      null;
    state.history = [];
    state.future = [];
    state.dragPageId = null;
    state.tool = "select";

    state.mode = "overview";
    state.pageSelection.clear();
    state.figureSelection.clear();
    state.clipboard = [];
    $("pdfTextLayer").replaceChildren();
    restoreIntroDisclosure();

    els.thumbs.replaceChildren();

    clearViewer();

    updateStatus(
      "PDFを選択してください。"
    );

    showToast(
      "PDFを閉じました。"
    );
  } finally {
    setBusy(false);
    syncUI();
  }
}

/*
 * イベント
 */

els.append.addEventListener(
  "click",
  () => {
    if (!state.busy) {
      els.input.click();
    }
  }
);

els.close.addEventListener(
  "click",
  clearDocument
);

els.input.addEventListener(
  "change",
  () => {
    if (
      els.input.files?.length
    ) {
      readPdfFiles(
        els.input.files
      );
    }
  }
);

els.drop.addEventListener(
  "click",
  () => {
    if (!state.busy) {
      els.input.click();
    }
  }
);

els.drop.addEventListener(
  "keydown",
  event => {
    if (
      state.busy
    ) {
      return;
    }

    if (
      event.key ===
        "Enter" ||
      event.key === " "
    ) {
      event.preventDefault();
      els.input.click();
    }
  }
);

[
  "dragenter",
  "dragover"
].forEach(type => {
  els.drop.addEventListener(
    type,
    event => {
      if (state.busy) {
        return;
      }

      event.preventDefault();

      els.drop.classList.add(
        "drag"
      );
    }
  );
});

[
  "dragleave",
  "drop"
].forEach(type => {
  els.drop.addEventListener(
    type,
    event => {
      event.preventDefault();

      els.drop.classList.remove(
        "drag"
      );
    }
  );
});

els.drop.addEventListener(
  "drop",
  event => {
    if (
      state.busy
    ) {
      return;
    }

    if (
      event.dataTransfer
        .files?.length
    ) {
      readPdfFiles(
        event.dataTransfer.files
      );
    }
  }
);

document.body.addEventListener(
  "dragover",
  event => {
    if (
      state.pages.length &&
      !state.busy
    ) {
      event.preventDefault();
    }
  }
);

document.body.addEventListener(
  "drop",
  event => {
    if (
      !state.pages.length ||
      state.busy
    ) {
      return;
    }

    if (
      event.target.closest(
        "#dropZone"
      )
    ) {
      return;
    }

    event.preventDefault();

    if (
      event.dataTransfer
        .files?.length
    ) {
      readPdfFiles(
        event.dataTransfer.files
      );
    }
  }
);

document
  .querySelectorAll(
    ".mode-btn"
  )
  .forEach(button => {
    button.addEventListener(
      "click",
      () => {
        setTool(
          button.dataset.tool
        );

      }
    );
  });

els.layer.addEventListener(
  "pointerdown",
  event => {
    if (
      state.busy ||
      event.target.closest(
        ".ann"
      )
    ) {
      return;
    }

    if (!(state.tool === "select" && event.shiftKey)) {
      state.selectedAnnotationId = null;
      state.figureSelection.clear();
    }

    if (
      state.tool === "text"
    ) {
      addTextAt(
        pagePointFromEvent(
          event
        )
      );
    } else if (
      ["rect", "ellipse", "arrow", "line"].includes(state.tool)
    ) {
      beginDrawing(
        event,
        state.tool
      );
    } else if (state.tool === "select") {
      beginMarquee(event);
    }
  }
);

els.color?.addEventListener(
  "change",
  () =>
    applyProperty(
      "color",
      els.color.value
    )
);

els.stroke?.addEventListener(
  "change",
  () =>
    applyProperty(
      "strokeWidth",
      Number(
        els.stroke.value
      )
    )
);

let fontPreviewRestore = null;

function fontMenuOptions() {
  return els.fontFamilyMenu
    ? Array.from(
        els.fontFamilyMenu
          .querySelectorAll(
            "[data-font-family]"
          )
      )
    : [];
}

function selectedTextElement() {
  const annotation =
    currentAnnotation();

  if (
    annotation?.type !==
    "text"
  ) {
    return null;
  }

  return Array.from(
    els.layer.querySelectorAll(
      ".ann-text"
    )
  ).find(
    element =>
      element.dataset.annId ===
      annotation.id
  ) || null;
}

function previewFontFamily(
  fontFamily
) {
  if (
    !FONT_STACKS[fontFamily]
  ) {
    return;
  }

  const element =
    selectedTextElement();

  if (!element) {
    return;
  }

  if (
    fontPreviewRestore === null
  ) {
    fontPreviewRestore =
      element.style.fontFamily;
  }

  element.style.fontFamily =
    fontStackFor(fontFamily);
}

function restoreFontPreview() {
  if (
    fontPreviewRestore === null
  ) {
    return;
  }

  const element =
    selectedTextElement();

  if (element) {
    element.style.fontFamily =
      fontPreviewRestore;
  }

  fontPreviewRestore = null;
}

function currentFontFamilyKey() {
  const annotation =
    currentAnnotation();

  const candidate =
    annotation?.type === "text"
      ? annotation.fontFamily
      : state.defaults.fontFamily;

  return FONT_STACKS[candidate]
    ? candidate
    : DEFAULT_FONT_FAMILY;
}

function syncFontMenuTabStops(
  focusOption = null
) {
  const options =
    fontMenuOptions();

  if (!options.length) {
    return;
  }

  const selectedFamily =
    currentFontFamilyKey();

  const selected =
    options.find(
      option =>
        option.dataset
          .fontFamily ===
        selectedFamily
    );

  const active =
    focusOption &&
    options.includes(focusOption)
      ? focusOption
      : selected || options[0];

  options.forEach(option => {
    option.tabIndex =
      option === active
        ? 0
        : -1;
  });
}

function positionFontMenu() {
  if (
    !els.fontFamilyMenu ||
    !els.fontFamilyButton ||
    els.fontFamilyMenu.hidden
  ) {
    return;
  }

  const menu =
    els.fontFamilyMenu;

  const buttonRect =
    els.fontFamilyButton
      .getBoundingClientRect();

  const margin = 8;
  const gap = 6;

  const preferredWidth = 220;

  const menuWidth =
    Math.min(
      preferredWidth,
      Math.max(
        160,
        window.innerWidth -
          margin * 2
      )
    );

  menu.style.width =
    `${menuWidth}px`;

  const left =
    clamp(
      buttonRect.left,
      margin,
      Math.max(
        margin,
        window.innerWidth -
          menuWidth -
          margin
      )
    );

  menu.style.left =
    `${left}px`;

  /*
   * まず十分な高さを仮設定し、実寸を取得します。
   */
  menu.style.maxHeight =
    `${
      Math.max(
        120,
        window.innerHeight -
          margin * 2
      )
    }px`;

  const naturalHeight =
    Math.min(
      menu.scrollHeight,
      320
    );

  const roomBelow =
    window.innerHeight -
    buttonRect.bottom -
    gap -
    margin;

  const roomAbove =
    buttonRect.top -
    gap -
    margin;

  const openAbove =
    roomBelow <
      Math.min(
        naturalHeight,
        180
      ) &&
    roomAbove > roomBelow;

  const availableHeight =
    Math.max(
      96,
      openAbove
        ? roomAbove
        : roomBelow
    );

  const renderedHeight =
    Math.min(
      naturalHeight,
      availableHeight
    );

  menu.style.maxHeight =
    `${availableHeight}px`;

  const top =
    openAbove
      ? Math.max(
          margin,
          buttonRect.top -
            gap -
            renderedHeight
        )
      : Math.min(
          window.innerHeight -
            margin -
            renderedHeight,
          buttonRect.bottom +
            gap
        );

  menu.style.top =
    `${Math.max(
      margin,
      top
    )}px`;
}

function closeFontMenu(
  {
    restorePreview = true,
    returnFocus = false
  } = {}
) {
  if (restorePreview) {
    restoreFontPreview();
  } else {
    fontPreviewRestore = null;
  }

  if (els.fontFamilyMenu) {
    els.fontFamilyMenu.hidden =
      true;

    els.fontFamilyMenu
      .style.removeProperty(
        "left"
      );

    els.fontFamilyMenu
      .style.removeProperty(
        "top"
      );

    els.fontFamilyMenu
      .style.removeProperty(
        "width"
      );

    els.fontFamilyMenu
      .style.removeProperty(
        "max-height"
      );
  }

  els.fontFamilyButton
    ?.setAttribute(
      "aria-expanded",
      "false"
    );

  if (returnFocus) {
    els.fontFamilyButton
      ?.focus();
  }
}

function focusFontOption(
  target
) {
  const options =
    fontMenuOptions();

  if (!options.length) {
    return;
  }

  const option =
    typeof target === "number"
      ? options[
          clamp(
            target,
            0,
            options.length - 1
          )
        ]
      : target;

  if (
    !option ||
    !options.includes(option)
  ) {
    return;
  }

  syncFontMenuTabStops(
    option
  );

  previewFontFamily(
    option.dataset.fontFamily
  );

  option.focus({
    preventScroll: true
  });

  option.scrollIntoView({
    block: "nearest"
  });
}

function openFontMenu(
  {
    focusSelected = false
  } = {}
) {
  if (
    !els.fontFamilyMenu ||
    !els.fontFamilyButton ||
    els.fontFamilyButton.disabled
  ) {
    return;
  }

  finishTextEditing();
  restoreFontPreview();

  els.fontFamilyMenu.hidden =
    false;

  els.fontFamilyButton
    .setAttribute(
      "aria-expanded",
      "true"
    );

  syncFontMenuTabStops();
  positionFontMenu();

  if (focusSelected) {
    const options =
      fontMenuOptions();

    const selected =
      options.find(
        option =>
          option.getAttribute(
            "aria-selected"
          ) === "true"
      ) || options[0];

    requestAnimationFrame(
      () => {
        focusFontOption(
          selected
        );
      }
    );
  }
}

els.fontFamilyButton
  ?.addEventListener(
    "click",
    event => {
      event.stopPropagation();

      if (
        els.fontFamilyMenu
          ?.hidden
      ) {
        openFontMenu();
      } else {
        closeFontMenu();
      }
    }
  );

els.fontFamilyButton
  ?.addEventListener(
    "keydown",
    event => {
      if (
        ![
          "ArrowDown",
          "ArrowUp",
          "Home",
          "End"
        ].includes(event.key)
      ) {
        return;
      }

      event.preventDefault();

      openFontMenu({
        focusSelected: true
      });

      requestAnimationFrame(
        () => {
          const options =
            fontMenuOptions();

          if (!options.length) {
            return;
          }

          if (
            event.key === "Home"
          ) {
            focusFontOption(0);
          } else if (
            event.key === "End"
          ) {
            focusFontOption(
              options.length - 1
            );
          }
        }
      );
    }
  );

fontMenuOptions().forEach(
  option => {
    const family =
      option.dataset.fontFamily;

    option.addEventListener(
      "pointerenter",
      () => {
        syncFontMenuTabStops(
          option
        );

        previewFontFamily(
          family
        );
      }
    );

    option.addEventListener(
      "focus",
      () => {
        syncFontMenuTabStops(
          option
        );

        previewFontFamily(
          family
        );
      }
    );

    option.addEventListener(
      "click",
      event => {
        event.stopPropagation();

        restoreFontPreview();

        applyProperty(
          "fontFamily",
          family
        );

        closeFontMenu({
          restorePreview: false,
          returnFocus: true
        });
      }
    );

    option.addEventListener(
      "keydown",
      event => {
        const options =
          fontMenuOptions();

        const index =
          options.indexOf(option);

        if (
          event.key ===
          "ArrowDown"
        ) {
          event.preventDefault();

          focusFontOption(
            (
              index + 1
            ) %
              options.length
          );

          return;
        }

        if (
          event.key ===
          "ArrowUp"
        ) {
          event.preventDefault();

          focusFontOption(
            (
              index -
              1 +
              options.length
            ) %
              options.length
          );

          return;
        }

        if (
          event.key ===
          "Home"
        ) {
          event.preventDefault();
          focusFontOption(0);
          return;
        }

        if (
          event.key ===
          "End"
        ) {
          event.preventDefault();

          focusFontOption(
            options.length - 1
          );

          return;
        }

        if (
          event.key ===
            "Enter" ||
          event.key === " "
        ) {
          event.preventDefault();
          option.click();
          return;
        }

        if (
          event.key === "Escape"
        ) {
          event.preventDefault();

          closeFontMenu({
            returnFocus: true
          });

          return;
        }

        if (
          event.key === "Tab"
        ) {
          closeFontMenu();
        }
      }
    );
  }
);

els.fontFamilyMenu
  ?.addEventListener(
    "pointerleave",
    restoreFontPreview
  );

document.addEventListener(
  "click",
  event => {
    if (
      !els.fontFamilyPicker
        ?.contains(event.target)
    ) {
      closeFontMenu();
    }
  }
);

window.addEventListener(
  "resize",
  () => {
    if (
      els.fontFamilyMenu &&
      !els.fontFamilyMenu.hidden
    ) {
      positionFontMenu();
    }
  }
);

window.addEventListener(
  "scroll",
  () => closeFontMenu(),
  true
);

document.addEventListener(
  "keydown",
  event => {
    if (
      event.key === "Escape" &&
      els.fontFamilyMenu &&
      !els.fontFamilyMenu.hidden
    ) {
      event.preventDefault();

      closeFontMenu({
        returnFocus: true
      });
    }
  }
);

/*
 * 編集操作イベント
 */

els.save.addEventListener(
  "click",
  exportPdf
);

els.undo.addEventListener(
  "click",
  undo
);

els.redo.addEventListener(
  "click",
  redo
);

els.rotateLeft.addEventListener(
  "click",
  () => rotateCurrent(-90)
);

els.rotateRight.addEventListener(
  "click",
  () => rotateCurrent(90)
);

els.deletePage.addEventListener(
  "click",
  deleteCurrentPage
);

els.movePageUp.addEventListener(
  "click",
  () => moveCurrentPage(-1)
);

els.movePageDown.addEventListener(
  "click",
  () => moveCurrentPage(1)
);

els.prev.addEventListener(
  "click",
  () => {
    const index =
      currentPageIndex();

    if (
      index > 0 &&
      !state.busy
    ) {
      selectPage(
        state.pages[index - 1].id
      );
    }
  }
);

els.next.addEventListener(
  "click",
  () => {
    const index =
      currentPageIndex();

    if (
      index >= 0 &&
      index <
        state.pages.length - 1 &&
      !state.busy
    ) {
      selectPage(
        state.pages[index + 1].id
      );
    }
  }
);

els.zoom.addEventListener(
  "change",
  () => {
    if (
      !state.busy &&
      state.pages.length
    ) {
      renderCurrentPage();
    }
  }
);

/*
 * 拡大・縮小
 *
 * 倍率の正はels.zoom.valueです。段階の値は
 * index.htmlの<option>と一致させてください。
 * 一致していないとselect.valueの代入が無視されます。
 */

const zoomSteps = [
  /*
   * 25は内部の下限（0.25倍）に合わせた段です。
   * これが無いと、「画面に合わせる」で25%付近まで
   * 縮んでいる状態で「－」を押したときに、
   * 最小段が50%しか無いため逆に拡大してしまいます。
   */
  25,
  50,
  75,
  100,
  125,
  150,
  200,
  250,
  300
];

function currentZoomPercent() {
  const value = els.zoom.value;

  if (
    value === "fit" ||
    value === "fit-width"
  ) {
    /*
     * 自動調整のときは、直前の描画で
     * 実際に使われた倍率を基準にします。
     */
    return Math.round(
      (state.viewScale || 1) *
        100
    );
  }

  return Number(value);
}

function stepZoom(direction) {
  if (
    state.busy ||
    !state.pages.length
  ) {
    return;
  }

  const current =
    currentZoomPercent();

  let next;

  if (direction > 0) {
    next = zoomSteps.find(
      (value) =>
        value > current + 0.5
    );
  } else {
    const lower =
      zoomSteps.filter(
        (value) =>
          value < current - 0.5
      );

    next =
      lower[lower.length - 1];
  }

  if (next === undefined) {
    next =
      direction > 0
        ? zoomSteps[
            zoomSteps.length - 1
          ]
        : zoomSteps[0];
  }

  const nextValue =
    String(next);

  if (
    els.zoom.value === nextValue
  ) {
    return;
  }

  els.zoom.value = nextValue;

  /*
   * 現在の倍率は<select>の表示がそのまま示すため、
   * ステータス欄への通知は行いません。
   * renderCurrentPage()が非同期に自分のステータスを
   * 書くため、ここで書いても上書きされます。
   */
  renderCurrentPage();
}

els.zoomOut.addEventListener(
  "click",
  () => {
    stepZoom(-1);
  }
);

els.zoomIn.addEventListener(
  "click",
  () => {
    stepZoom(1);
  }
);

/*
 * Ctrlキーを押しながらのホイールで拡大・縮小します。
 * Ctrlを押していない通常のスクロールは妨げません。
 * 表示領域の上だけに限定しているため、
 * 他の場所ではブラウザ標準の拡大縮小が働きます。
 */
els.viewerArea.addEventListener(
  "wheel",
  (event) => {
    if (!event.ctrlKey) {
      return;
    }

    if (
      state.busy ||
      !state.pages.length
    ) {
      return;
    }

    event.preventDefault();

    stepZoom(
      event.deltaY < 0 ? 1 : -1
    );
  },
  { passive: false }
);

els.deleteAnn.addEventListener(
  "click",
  deleteSelectedAnnotation
);

els.font?.addEventListener(
  "change",
  () =>
    applyProperty(
      "fontSize",
      Number(els.font.value)
    )
);

els.bold?.addEventListener(
  "click",
  () => {
    const annotation =
      currentAnnotation();

    const current =
      annotation?.type === "text"
        ? Boolean(
            annotation.bold
          )
        : Boolean(
            state.defaults.bold
          );

    applyProperty(
      "bold",
      !current
    );
  }
);

els.bgColor?.addEventListener(
  "change",
  () =>
    applyProperty(
      "bgColor",
      els.bgColor.value
    )
);

els.bgTransparent
  ?.addEventListener(
    "change",
    () =>
      applyProperty(
        "bgTransparent",
        els.bgTransparent.checked
      )
  );

/*
 * キーボード操作
 */

document.addEventListener(
  "keydown",
  event => {
    if (
      state.busy ||
      isTextEditingTarget(
        event.target
      )
    ) {
      return;
    }

    const modifier =
      event.ctrlKey ||
      event.metaKey;

    if (
      modifier &&
      !event.altKey &&
      event.key.toLowerCase() ===
        "z"
    ) {
      event.preventDefault();

      if (event.shiftKey) {
        redo();
      } else {
        undo();
      }

      return;
    }

    if (
      modifier &&
      !event.altKey &&
      event.key.toLowerCase() ===
        "y"
    ) {
      event.preventDefault();
      redo();
      return;
    }

    if (
      (
        event.key ===
          "Delete" ||
        event.key ===
          "Backspace"
      ) &&
      state.selectedAnnotationId
    ) {
      event.preventDefault();
      deleteSelectedAnnotation();
    }
  }
);

/*
 * 画面サイズ変更時の再描画
 */

window.addEventListener(
  "resize",
  () => {
    if (
      state.busy ||
      !state.pages.length
    ) {
      return;
    }

    cancelAnimationFrame(
      resizeRenderFrame
    );

    resizeRenderFrame =
      requestAnimationFrame(
        () => {
          resizeRenderFrame = 0;

          /*
           * 表示領域の大きさに追従する指定のときだけ
           * 再描画します。
           */
          if (
            els.zoom.value ===
              "fit" ||
            els.zoom.value ===
              "fit-width"
          ) {
            renderCurrentPage();
          }
        }
      );
  }
);


/*
 * 初期化
 */

function selectedPages() {
  return state.pages.filter((p) => state.pageSelection.has(p.id));
}
function selectedFigures() {
  const page = currentPage();
  if (!page) return [];
  return page.annotations.filter(
    (a) => state.figureSelection.has(a.id) || a.id === state.selectedAnnotationId,
  );
}
function syncWorkspace() {
  const valid = new Set(state.pages.map((p) => p.id));
  state.pageSelection = new Set([...state.pageSelection].filter((id) => valid.has(id)));
  if (!state.pageSelection.size && state.currentPageId)
    state.pageSelection.add(state.currentPageId);
  els.editor.dataset.mode = state.mode;
  const count = state.pageSelection.size;
  $("selectionCount").textContent = `${count}ページを選択`;
  ["extractBtn", "selectAllPagesBtn", "backToPagesBtn"].forEach(
    (id) => ($(id).disabled = state.busy || !state.pages.length),
  );
  els.movePageUp.disabled =
    state.busy ||
    !state.pages.some(
      (p, i) =>
        i > 0 && state.pageSelection.has(p.id) && !state.pageSelection.has(state.pages[i - 1].id),
    );
  els.movePageDown.disabled =
    state.busy ||
    !state.pages.some(
      (p, i) =>
        i < state.pages.length - 1 &&
        state.pageSelection.has(p.id) &&
        !state.pageSelection.has(state.pages[i + 1].id),
    );
  syncThumbnailSelection();
  els.thumbs.querySelectorAll("button,input").forEach((n) => (n.disabled = state.busy));
  els.thumbs
    .querySelectorAll(".thumb-item")
    .forEach((n) => (n.draggable = !state.busy && state.mode === "overview"));
  syncFloatingProperties();
}
function choosePage(id, event = {}) {
  if (state.busy) return;
  if (state.mode === "edit") {
    selectPage(id);
    return;
  }
  finishTextEditing();
  if (event.shiftKey) {
    const ids = rangeIds(state.pages, state.selectionAnchor || state.currentPageId, id);
    state.pageSelection = new Set(
      event.ctrlKey || event.metaKey ? [...state.pageSelection, ...ids] : ids,
    );
  } else if (event.ctrlKey || event.metaKey) {
    if (state.pageSelection.has(id) && state.pageSelection.size > 1) state.pageSelection.delete(id);
    else state.pageSelection.add(id);
    state.selectionAnchor = id;
  } else {
    state.pageSelection = new Set([id]);
    state.selectionAnchor = id;
  }
  state.currentPageId = id;
  state.selectedAnnotationId = null;
  state.figureSelection.clear();
  syncUI();
}
async function openPageEditor(id) {
  if (state.busy) return;
  state.mode = "edit";
  selectPage(id, false);
  setTool("select");
  requestAnimationFrame(() => $("backToPagesBtn").focus());

  state.thumbToken++;
  await stopThumbnailRendering();

  if (
    state.mode !== "edit" ||
    state.currentPageId !== id
  ) {
    return;
  }

  renderCurrentPage();
}
async function showPageOverview() {
  if (state.busy) return;
  finishTextEditing();
  state.mode = "overview";
  state.renderToken++;

  const pageRenderTask =
    currentRenderTask;
  await cancelPdfRenderTask(
    pageRenderTask,
    "Page rendering cancellation failed while returning to overview:"
  );
  if (
    currentRenderTask ===
    pageRenderTask
  ) {
    currentRenderTask = null;
  }

  setTool("select");
  syncUI();
  void renderThumbnails();
  els.thumbs
    .querySelector(`[data-page-id="${CSS.escape(state.currentPageId)}"] .thumb-edit`)
    ?.focus();
}
function commitPageOrder(pages) {
  if (pages.every((p, i) => p === state.pages[i])) return;
  finishTextEditing();
  pushHistory();
  state.pages = pages;
  if(state.mode==="overview") renderThumbnails();
  syncUI();
  updateStatus("ページの順番を変更しました。");
}
let pageScrollFrame = 0,
  pageScrollVelocity = 0;
function updatePageDragScroll(y) {
  const r = els.thumbs.getBoundingClientRect();
  pageScrollVelocity = y < r.top + 55 ? -12 : y > r.bottom - 55 ? 12 : 0;
  if (!pageScrollFrame) {
    const tick = () => {
      if (!state.dragPageId) {
        pageScrollFrame = 0;
        return;
      }
      els.thumbs.scrollTop += pageScrollVelocity;
      pageScrollFrame = requestAnimationFrame(tick);
    };
    pageScrollFrame = requestAnimationFrame(tick);
  }
}
function clearPageDrag() {
  state.dragPageId = null;
  pageScrollVelocity = 0;
  cancelAnimationFrame(pageScrollFrame);
  pageScrollFrame = 0;
  els.thumbs.querySelectorAll(".thumb-item").forEach((n) => {
    delete n.dataset.drop;
    n.classList.remove("dragging");
  });
}
function syncFloatingProperties() {
  const selected = selectedFigures(),
    a = selected[0],
    type = a?.type || state.tool;
  const panel = $("formatPanel");
  if (!panel) return;
  panel.classList.toggle(
    "hidden",
    state.mode !== "edit" ||
      (!selected.length && state.tool === "select" && !state.clipboard.length),
  );
  const labels = {
    text: "テキスト",
    rect: "四角",
    ellipse: "丸",
    arrow: "矢印",
    line: "線",
    highlight: "マーカー",
    select: "図形",
  };
  $("formatTitle").textContent =
    selected.length > 1 ? `${selected.length}個の図形` : labels[type] + "の設定";
  const mixed = selected.length > 1;
  panel.querySelector(".property-controls").classList.toggle("hidden", mixed || type === "select");
  const value = (key, fallback) => a?.[key] ?? fallback;
  $("outlineField").classList.toggle("hidden", !["text", "arrow"].includes(type));
  $("outlineInput").checked = value("outline", state.defaults.outline);
  $("fillField").classList.toggle("hidden", !["rect", "ellipse"].includes(type));
  $("fillNoneField").classList.toggle("hidden", !["rect", "ellipse"].includes(type));
  $("fillInput").value = value("fill", state.defaults.fill);
  $("fillNoneInput").checked = value("fillNone", state.defaults.fillNone);
  $("opacityField").classList.toggle("hidden", type !== "highlight");
  $("opacityInput").value = String(value("opacity", state.markerOpacity));
  $("copyFiguresBtn").disabled = state.busy || !selected.length;
  $("pasteFiguresBtn").disabled = state.busy || !state.clipboard.length;
  $("editTextBtn").classList.toggle("hidden", selected.length !== 1 || type !== "text");
  $("deleteAnnotationBtn").disabled = state.busy || !selected.length;
  for (const id of [
    "outlineInput",
    "fillInput",
    "fillNoneInput",
    "opacityInput",
    "formatCorner",
    "editTextBtn",
  ])
    $(id).disabled = state.busy;
  $("fillInput").disabled = state.busy || $("fillNoneInput").checked;
  $("pdfTextLayer").classList.toggle("selectable", state.tool === "highlight" && state.textReady);
  els.layer.classList.toggle("marker-active", state.tool === "highlight");
  $("canvasHint").textContent =
    state.tool === "highlight"
      ? state.textReady
        ? "PDFの文字をドラッグして選択してください。"
        : "このページには選択できる文字がありません。"
      : mixed
        ? "まとめて移動・コピー・削除できます。"
        : state.tool === "select"
          ? "Shift＋クリック／余白のドラッグで複数選択"
          : state.tool === "text"
            ? "文字を追加する場所をクリック"
            : "ドラッグして図形を追加";
}
function svgNode(name, attrs = {}) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}
function renderFigures() {
  const page = currentPage();
  els.layer.replaceChildren();
  if (!page) {
    syncToolProperties();
    return;
  }
  const scale = state.viewScale,
    selection = new Set(selectedFigures().map((a) => a.id));
  for (const a of page.annotations) {
    const b = bounds(a);
    let el;
    if (a.type === "text") {
      el = document.createElement("div");
      el.className = "ann ann-text";
      el.textContent = a.text || "テキスト";
      Object.assign(el.style, {
        fontSize: `${a.fontSize * scale}px`,
        fontFamily: fontStackFor(a.fontFamily),
        fontWeight: a.bold ? "700" : "400",
        color: a.color,
        backgroundColor:
          (a.bgTransparent ?? a.whiteBg === false) ? "transparent" : a.bgColor || "#fff",
        padding: `${3 * scale}px ${4 * scale}px`,
        lineHeight: "1.32",
      });
      if (a.outline) {
        el.style.webkitTextStroke = `${2 * scale}px #fff`;
        el.style.paintOrder = "stroke fill";
      }
      el.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        startTextEditing(a.id);
      });
    } else if (["rect", "ellipse"].includes(a.type)) {
      el = document.createElement("div");
      el.className = `ann ann-${a.type}`;
      Object.assign(el.style, {
        border: `${a.strokeWidth * scale}px solid ${a.color}`,
        backgroundColor: a.fillNone !== false ? "transparent" : a.fill,
      });
    } else if (isLine(a)) {
      el = svgNode("svg");
      el.classList.add("ann", "ann-arrow");
      // Keep the SVG's coordinates in PDF points to match exported arrow heads.
      const pad = 12,
        w = Math.max(b.w, 1),
        h = Math.max(b.h, 1);
      el.setAttribute("viewBox", `${b.x - pad} ${b.y - pad} ${w + pad * 2} ${h + pad * 2}`);
      el.style.left = `${(b.x - pad) * scale}px`;
      el.style.top = `${(b.y - pad) * scale}px`;
      el.style.width = `${(w + pad * 2) * scale}px`;
      el.style.height = `${(h + pad * 2) * scale}px`;
      const segments = [[a.x1, a.y1, a.x2, a.y2]];
      if (a.type === "arrow") {
        const angle = Math.atan2(a.y2 - a.y1, a.x2 - a.x1),
          head = 7 + a.strokeWidth * 2.2;
        for (const angleOffset of [-Math.PI / 6, Math.PI / 6])
          segments.push([
            a.x2,
            a.y2,
            a.x2 - head * Math.cos(angle + angleOffset),
            a.y2 - head * Math.sin(angle + angleOffset),
          ]);
      }
      for (const outline of a.outline && a.type === "arrow" ? [true, false] : [false])
        for (const [x1, y1, x2, y2] of segments)
          el.append(
            svgNode("line", {
              x1,
              y1,
              x2,
              y2,
              stroke: outline ? "#fff" : a.color,
              "stroke-width": a.strokeWidth + (outline ? 2 : 0),
              "stroke-linecap": "round",
            }),
          );
    } else if (a.type === "highlight") {
      el = document.createElement("div");
      el.className = "ann ann-highlight";
      a.rects.forEach((r) => {
        const mark = document.createElement("span");
        mark.className = "highlight-fragment";
        Object.assign(mark.style, {
          left: `${(r.x - b.x) * scale}px`,
          top: `${(r.y - b.y) * scale}px`,
          width: `${r.w * scale}px`,
          height: `${r.h * scale}px`,
          backgroundColor: a.color,
          opacity: a.opacity,
        });
        el.append(mark);
      });
    }
    if (!el) continue;
    if (!isLine(a))
      Object.assign(el.style, {
        left: `${b.x * scale}px`,
        top: `${b.y * scale}px`,
        width: `${b.w * scale}px`,
        height: `${b.h * scale}px`,
      });
    el.dataset.annId = a.id;
    if (selection.has(a.id)) {
      el.classList.add("selected");
      if (selection.size === 1 && a.type !== "highlight") {
        if (isLine(a)) {
          for (const end of [1, 2]) {
            const handle = svgNode("circle", {
              cx: a[`x${end}`],
              cy: a[`y${end}`],
              r: 5 / scale,
              fill: "#fff",
              stroke: "#1473e6",
              "stroke-width": 1 / scale,
            });
            handle.classList.add("endpoint-handle");
            handle.addEventListener("pointerdown", (e) => resizeEndpoint(e, a, end));
            el.append(handle);
          }
        } else {
          const handle = document.createElement("span");
          handle.className = "resize-handle";
          handle.addEventListener("pointerdown", (e) => beginResize(e, a.id));
          el.append(handle);
        }
      }
    }
    el.addEventListener("pointerdown", (e) => beginMove(e, a.id));
    els.layer.append(el);
  }
  syncToolProperties();
}
let lastFigurePress = null;
function beginFigureMove(event, id) {
  if (
    state.busy ||
    state.tool !== "select" ||
    event.button !== 0 ||
    event.target.closest(".resize-handle,.endpoint-handle") ||
    event.target.isContentEditable
  )
    return;
  event.preventDefault();
  event.stopPropagation();
  finishTextEditing();
  if (event.shiftKey || event.ctrlKey || event.metaKey) {
    if (state.figureSelection.has(id)) state.figureSelection.delete(id);
    else state.figureSelection.add(id);
    state.selectedAnnotationId = [...state.figureSelection].at(-1) || null;
    renderAnnotations();
    return;
  }
  if (!state.figureSelection.has(id)) {
    state.figureSelection = new Set([id]);
    state.selectedAnnotationId = id;
  }
  renderAnnotations();
  const doublePress =
    lastFigurePress?.id === id &&
    event.timeStamp - lastFigurePress.time < 400 &&
    Math.hypot(event.clientX - lastFigurePress.x, event.clientY - lastFigurePress.y) < 5;
  lastFigurePress = { id, time: event.timeStamp, x: event.clientX, y: event.clientY };
  if (doublePress && currentAnnotation()?.type === "text") {
    lastFigurePress = null;
    startTextEditing(id);
    return;
  }
  const items = selectedFigures(),
    originals = clone(items),
    before = snapshot(),
    start = pagePointFromEvent(event),
    size = pageDisplaySize(currentPage());
  const boxes = originals.map(bounds),
    left = Math.min(...boxes.map((b) => b.x)),
    top = Math.min(...boxes.map((b) => b.y)),
    right = Math.max(...boxes.map((b) => b.x + b.w)),
    bottom = Math.max(...boxes.map((b) => b.y + b.h));
  let changed = false;
  trackPointer(
    event,
    (e) => {
      const point = pagePointFromEvent(e),
        dx = clamp(point.x - start.x, -left, Math.max(-left, size.width - right)),
        dy = clamp(point.y - start.y, -top, Math.max(-top, size.height - bottom));
      changed = Math.abs(dx) + Math.abs(dy) > 0.5;
      items.forEach((a, i) => Object.assign(a, translate(clone(originals[i]), dx, dy)));
      renderAnnotations();
    },
    (cancelled) => {
      if (cancelled) items.forEach((a, i) => Object.assign(a, originals[i]));
      else if (changed) pushHistory(before);
      renderAnnotations();
      updateThumbnailAnnotationMarker(currentPage().id);
    },
  );
}
function trackPointer(event, move, finish) {
  const id = event.pointerId;
  const onMove = (e) => {
    if (e.pointerId === id) move(e);
  };
  const end = (e) => {
    if (e.pointerId !== id) return;
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", end);
    document.removeEventListener("pointercancel", end);
    finish(e.type === "pointercancel");
  };
  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", end);
  document.addEventListener("pointercancel", end);
}
function resizeEndpoint(event, a, end) {
  if (state.busy) return;
  event.preventDefault();
  event.stopPropagation();
  const before = snapshot(),
    original = clone(a);
  trackPointer(
    event,
    (e) => {
      const p = pagePointFromEvent(e);
      a[`x${end}`] = p.x;
      a[`y${end}`] = p.y;
      renderAnnotations();
    },
    (cancel) => {
      if (cancel) Object.assign(a, original);
      else if (JSON.stringify(a) !== JSON.stringify(original)) pushHistory(before);
      renderAnnotations();
    },
  );
}
function beginMarquee(event) {
  if (event.button !== 0 || state.busy) return;
  event.preventDefault();
  const start = pagePointFromEvent(event),
    base = event.shiftKey ? new Set(state.figureSelection) : new Set();
  const box = document.createElement("div");
  box.className = "selection-marquee";
  els.layer.append(box);
  trackPointer(
    event,
    (e) => {
      const p = pagePointFromEvent(e),
        r = {
          x: Math.min(start.x, p.x),
          y: Math.min(start.y, p.y),
          w: Math.abs(start.x - p.x),
          h: Math.abs(start.y - p.y),
        };
      Object.assign(box.style, {
        left: `${r.x * state.viewScale}px`,
        top: `${r.y * state.viewScale}px`,
        width: `${r.w * state.viewScale}px`,
        height: `${r.h * state.viewScale}px`,
      });
      state.figureSelection = new Set(base);
      currentPage().annotations.forEach((a) => {
        const b = bounds(a);
        if (b.x >= r.x && b.y >= r.y && b.x + b.w <= r.x + r.w && b.y + b.h <= r.y + r.h)
          state.figureSelection.add(a.id);
      });
    },
    (cancel) => {
      if (cancel) state.figureSelection = base;
      state.selectedAnnotationId = [...state.figureSelection].at(-1) || null;
      renderAnnotations();
    },
  );
}
function copyFigures() {
  if (state.busy) return;
  finishTextEditing();
  const items = selectedFigures();
  if (!items.length) return;
  state.clipboard = clone(items);
  showToast(`${items.length}個の図形をコピーしました。別のページにも貼り付けできます。`);
  syncToolProperties();
}
function pasteFigures() {
  if (state.busy || !state.clipboard.length || !currentPage()) return;
  finishTextEditing();
  const items = clone(state.clipboard),
    size = pageDisplaySize(currentPage()),
    boxes = items.map(bounds);
  const left = Math.min(...boxes.map((b) => b.x)),
    top = Math.min(...boxes.map((b) => b.y)),
    right = Math.max(...boxes.map((b) => b.x + b.w)),
    bottom = Math.max(...boxes.map((b) => b.y + b.h));
  if (right - left > size.width || bottom - top > size.height) {
    showToast(
      "貼り付け先のページに収まりません。元の図形を小さくしてからコピーしてください。",
      true,
    );
    return;
  }
  const dx = clamp(12, -left, size.width - right),
    dy = clamp(12, -top, size.height - bottom);
  pushHistory();
  items.forEach((a) => {
    a.id = uid();
    translate(a, dx, dy);
  });
  currentPage().annotations.push(...items);
  state.tool = "select";
  state.figureSelection = new Set(items.map((a) => a.id));
  state.selectedAnnotationId = items.at(-1).id;
  syncToolButtons();
  renderAnnotations();
  updateThumbnailAnnotationMarker(currentPage().id);
}
// PDF.js builds the transparent text layer using the same viewport as the canvas.
// It handles character widths, writing direction and font metrics without OCR.
async function renderPdfTextLayer(pdfPage, unit, scale, token) {
  const target = $("pdfTextLayer");
  try {
    const content = await pdfPage.getTextContent();
    if (token !== state.renderToken) return;
    const container = document.createElement("div");
    container.className = "textLayer";
    container.style.setProperty("--scale-factor", String(scale));
    const viewport = pdfPage.getViewport({ scale, rotation: unit.rotation });
    const layer = new pdfjsLib.TextLayer({ textContentSource: content, container, viewport });
    await layer.render();
    if (token !== state.renderToken) return;
    target.replaceChildren(container);
    state.textReady = content.items.some((item) => item.str?.trim());
  } catch (error) {
    if (token !== state.renderToken) return;
    state.textReady = false;
    target.replaceChildren();
    console.warn("PDFの文字選択を準備できませんでした。", error);
  }
  syncFloatingProperties();
}
function addTextHighlight() {
  if (state.busy || state.tool !== "highlight" || !state.textReady) return;
  const selection = getSelection(),
    layer = $("pdfTextLayer");
  if (
    !selection?.rangeCount ||
    selection.isCollapsed ||
    !layer.contains(selection.anchorNode) ||
    !layer.contains(selection.focusNode)
  )
    return;
  const range = selection.getRangeAt(0),
    host = els.pageHost.getBoundingClientRect();
  const rects = selectionRects(
    [...range.getClientRects()],
    host,
    state.viewScale,
    pageDisplaySize(currentPage()),
  );
  if (!rects.length) return;
  pushHistory();
  const a = {
    id: uid(),
    type: "highlight",
    rects,
    color: state.markerColor,
    opacity: state.markerOpacity,
  };
  currentPage().annotations.push(a);
  selection.removeAllRanges();
  state.figureSelection = new Set([a.id]);
  state.selectedAnnotationId = a.id;
  // Stay in marker mode for repeated passages; Select is always one click away.
  renderAnnotations();
  updateThumbnailAnnotationMarker(currentPage().id);
  updateStatus("選択した文字にマーカーを付けました。");
}
function setupWorkspace() {
  $("backToPagesBtn").addEventListener("click", showPageOverview);
  $("extractBtn").addEventListener("click", () => exportPdf(true));
  $("selectAllPagesBtn").addEventListener("click", () => {
    if (!state.busy) {
      state.pageSelection = new Set(state.pages.map((p) => p.id));
      syncUI();
    }
  });
  $("copyFiguresBtn").addEventListener("click", copyFigures);
  $("pasteFiguresBtn").addEventListener("click", pasteFigures);
  $("editTextBtn").addEventListener("click", () => startTextEditing(state.selectedAnnotationId));
  for (const [id, key, kind] of [
    ["outlineInput", "outline", "checked"],
    ["fillInput", "fill", "value"],
    ["fillNoneInput", "fillNone", "checked"],
    ["opacityInput", "opacity", "number"],
  ])
    $(id).addEventListener("change", () =>
      applyProperty(key, kind === "number" ? Number($(id).value) : $(id)[kind]),
    );
  const panel = $("formatPanel"),
    handle = $("formatDragHandle"),
    preview = $("dockPreview");
  const dock = (corner) => {
    panel.dataset.corner = corner;
    $("formatCorner").value = corner;
  };
  $("formatCorner").addEventListener("change", () => dock($("formatCorner").value));
  handle.addEventListener("keydown", (e) => {
    if (!e.key.startsWith("Arrow")) return;
    e.preventDefault();
    let [vertical, horizontal] = panel.dataset.corner.split("-");
    if (e.key === "ArrowUp") vertical = "top";
    if (e.key === "ArrowDown") vertical = "bottom";
    if (e.key === "ArrowLeft") horizontal = "left";
    if (e.key === "ArrowRight") horizontal = "right";
    dock(`${vertical}-${horizontal}`);
  });
  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || state.busy) return;
    e.preventDefault();
    closeFontMenu();
    const area = panel.parentElement.getBoundingClientRect(),
      start = panel.getBoundingClientRect(),
      original = panel.dataset.corner;
    let corner = original,
      dx = 0,
      dy = 0;
    panel.classList.add("is-dragging");
    handle.setPointerCapture(e.pointerId);
    trackPointer(
      e,
      (m) => {
        dx = clamp(m.clientX - e.clientX, area.left - start.left + 8, area.right - start.right - 8);
        dy = clamp(m.clientY - e.clientY, area.top - start.top + 8, area.bottom - start.bottom - 8);
        panel.style.transform = `translate(${dx}px,${dy}px)`;
        corner = nearestCorner(
          start.left + dx + start.width / 2 - area.left,
          start.top + dy + start.height / 2 - area.top,
          area.width,
          area.height,
        );
        preview.hidden = false;
        preview.dataset.corner = corner;
      },
      (cancel) => {
        const from = panel.getBoundingClientRect();
        panel.classList.remove("is-dragging");
        panel.style.transform = "";
        preview.hidden = true;
        dock(cancel ? original : corner);
        const to = panel.getBoundingClientRect();
        if (!matchMedia("(prefers-reduced-motion: reduce)").matches)
          panel.animate(
            [
              {
                transform: `translate(${from.left - to.left}px,${from.top - to.top}px) scale(.98)`,
              },
              { transform: "translate(0,0) scale(1)" },
            ],
            { duration: 260, easing: "cubic-bezier(.2,.85,.25,1.12)" },
          );
      },
    );
  });
  $("pdfTextLayer").addEventListener("pointerup", () => requestAnimationFrame(addTextHighlight));
  $("pdfTextLayer").addEventListener("keyup", (e) => {
    if (e.key === "Shift") addTextHighlight();
  });
  document.addEventListener("keydown", (e) => {
    if (state.busy || isTextEditingTarget(e.target) || !state.pages.length) return;
    const modifier = e.ctrlKey || e.metaKey,
      key = e.key.toLowerCase();
    if (modifier && !e.altKey) {
      if (key === "s") {
        e.preventDefault();
        exportPdf();
      }
      if (key === "a") {
        e.preventDefault();
        if (state.mode === "overview") $("selectAllPagesBtn").click();
        else {
          state.figureSelection = new Set(currentPage().annotations.map((a) => a.id));
          state.selectedAnnotationId = [...state.figureSelection].at(-1) || null;
          renderAnnotations();
        }
      }
      if (state.mode === "edit" && key === "c" && selectedFigures().length) {
        e.preventDefault();
        copyFigures();
      }
      if (state.mode === "edit" && key === "v" && state.clipboard.length) {
        e.preventDefault();
        pasteFigures();
      }
    }
    if (e.key === "Escape" && state.mode === "edit") {
      setTool("select");
    }
    if (e.key === "Delete" && state.mode === "overview" && e.target.closest("#thumbList")) {
      e.preventDefault();
      deleteCurrentPage();
    }
  });
}

setupWorkspace();

syncUI();
state.tool = "select";
syncToolButtons();
syncToolProperties();
clearViewer();
updateStatus("PDFを選択してください。");
