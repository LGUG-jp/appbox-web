import { isLine, bounds, translate, rotateAnnotation, reorderAnnotations, movePages, stepPages, rangeIds, nearestCorner, drawingBox, constrainedLinePoint, angleLockedLinePoint, resizeBox, selectionRects, samePageRaster, samePageLayout, thumbnailRasterSize, thumbnailColumns } from "./editor-core.mjs?v=1.13.2";
import { MAX_STROKE_POINTS, MAX_DOCUMENT_INK_POINTS, appendInkPoint, stabilizeInkPoint, inkPath, inkIntersectsSegment, documentInkPointCount, acceptsInkPointer } from "./ink.mjs?v=1.8.0";
import { embedTextPng } from "./text-image.mjs?v=1.4.0";
import { MAX_IMAGE_BYTES, MAX_TOTAL_IMAGE_BYTES, checkImageSize, imageMetadata, initialImageBox, imagePlacement, referencedImageIds, clipboardFiles } from "./image-insertion.mjs?v=1.7.0";
import { PAGE_NUMBER_MARGIN_MM, createPageNumberPlan, pageNumberAnnotation, replacePageNumbers, removePageNumbers, resolvePageNumberPosition } from "./page-numbering.mjs?v=1.13.0";
import { WATERMARK_PRESETS, createWatermarkPlan, watermarkAnnotation, replaceWatermarks, removeWatermarks } from "./watermark.mjs?v=1.10.0";
import { MAX_PROJECT_JSON_BYTES, storedZipParts, readStoredZip, serializeProject, readProjectManifest, normalizeProjectPages, projectFileName, detachExcludedPages, relinkKeptPages } from "./project-file.mjs?v=1.14.1";
import { hasRedactions, redactionColor, redactionRasterSize, createRedactedPdf } from "./redaction.mjs?v=1.14.1";
import { MM_TO_PT, STAMP_PRESETS, MAX_STAMP_TEMPLATE_FILE_BYTES, normalizeStampSettings, formatStampDate, expandStampLines, layoutStamp, serializeStampTemplates, parseStampTemplates, mergeStampTemplates } from "./stamp.mjs?v=1.11.0";
import {
  PDFDocument,
  rgb,
  degrees, pushGraphicsState, popGraphicsState, setLineJoin
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
    !element?.closest?.(".page-check") &&
    element?.closest?.(
      "[contenteditable='true']," +
      "input,select,textarea,dialog"
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

const embeddedImages = new WeakMap();
const state = {
  mode: "overview",
  thumbnailSize: "medium",
  pagesPanelPreference: null,
  pageSelection: new Set(),
  selectionAnchor: null,
  figureSelection: new Set(),
  clipboard: [],
  markerColor: "#ffe04a",
  markerOpacity: 0.35,
  redactionColor: "#000000",
  pdfSavePending: false,
  sources: new Map(),
  images: new Map(),
  pages: [],
  currentPageId: null,
  selectedAnnotationId: null,
  tool: "select",
  inkTouch: false,
  inkStabilization: "none",

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
  revision: 0,
  savedRevision: 0,
  nextRevision: 1,
  busy: false,
  restoringHistory: false,
  historyRecoveryFailed: false,
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

// 初期選択ではPDFと作業ファイル、読込み後の追加ではPDFのみを表示します。
const initialFileAccept = els.input.accept;

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
  if (enabled) cancelInkGesture();
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
  $("selectPdfBtn").disabled = Boolean(enabled);

  /*
   * CSSの疑似要素で表示する処理文言としても使用します。
   */
  els.drop.dataset.busyLabel =
    enabled ? label : "";

  syncUI();
  syncInkAccessibility();
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
  ensureRevisionState();
  return {
    pages: clone(state.pages),
    currentPageId: state.currentPageId,
    selectedPages: [...state.pageSelection],
    revision: state.revision
  };
}
function ensureRevisionState() {
  state.pendingEdits ||= new Set();
  if (!Number.isInteger(state.revision)) {
    state.revision = 0;
  }
  if (!Number.isInteger(state.savedRevision)) {
    state.savedRevision = state.revision;
  }
  if (!Number.isInteger(state.nextRevision) || state.nextRevision <= state.revision) {
    state.nextRevision = state.revision + 1;
  }
}
function hasUnsavedChanges() {
  ensureRevisionState();
  return state.pages.length > 0 && (
    state.revision !== state.savedRevision ||
    [...state.pendingEdits].some(isChanged => isChanged())
  );
}
function trackUnsavedEdit(isChanged) {
  ensureRevisionState();
  state.pendingEdits.add(isChanged);
  return () => state.pendingEdits.delete(isChanged);
}
function markDocumentSaved() {
  ensureRevisionState();
  state.savedRevision = state.revision;
}
function advanceDocumentRevision() {
  ensureRevisionState();
  state.revision = state.nextRevision++;
}
function resetDocumentRevision() {
  state.pendingEdits?.clear();
  state.revision = 0;
  state.savedRevision = 0;
  state.nextRevision = 1;
}
function handleBeforeUnload(event) {
  finishTextEditing();
  if (!hasUnsavedChanges()) {
    return;
  }
  event.preventDefault();
  event.returnValue = "";
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
  releaseUnusedImages();
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
  snap = snapshot(),
  { deferTrim = false } = {}
) {
  ensureRevisionState();
  if (!Number.isInteger(snap.revision)) {
    snap.revision = state.revision;
  }
  state.history.push(snap);
  advanceDocumentRevision();

  if (!deferTrim) trimHistory();

  state.future.length = 0;
  syncUndoRedo();
  void releaseUnusedSources();
}

function trimHistory() {
  while (state.history.length > 40) state.history.shift();
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
  state.revision = Number.isInteger(snap.revision) ? snap.revision : state.revision;
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
      await renderThumbnails(null, null, { throwOnError: true });
    }
    return;
  }

  const pending = [];

  /*
   * 同期描画の注釈を先に処理します。ここで失敗した場合は、
   * サムネイル等の非同期描画を開始せず、そのまま復旧へ移れます。
   */
  if (
    canReuseCurrentRaster
  ) {
    renderAnnotations();
  } else {
    pending.push(
      renderCurrentPage({ throwOnError: true })
    );
  }

  if (
    canReuseThumbnailLayout
  ) {
    refreshThumbnailState();
  } else {
    pending.push(
      renderThumbnails(null, null, { throwOnError: true })
    );
  }

  /*
   * 片方の描画が失敗しても、並列で開始済みの描画が終わるまで待ちます。
   * 失敗直後にロールバックを始めて、遅れて完了した古い描画が
   * 復旧後の表示を上書きする競合を防ぎます。
   */
  const results =
    await Promise.allSettled(
      pending
    );

  const failed =
    results.find(
      result =>
        result.status ===
        "rejected"
    );

  if (failed) {
    throw failed.reason;
  }
}

const HISTORY_RECOVERY_MESSAGE =
  "表示の復旧に失敗しました。PDFを閉じて読み込み直してください。";

function captureHistoryOperationState() {
  return {
    document: snapshot(),
    history: [...state.history],
    future: [...state.future],
    savedRevision: state.savedRevision,
    nextRevision: state.nextRevision,
    figureSelection: [
      ...state.figureSelection
    ],
    selectedAnnotationId:
      state.selectedAnnotationId
  };
}

function applyHistoryOperationState(
  before
) {
  state.pages = clone(
    before.document.pages
  );
  state.currentPageId =
    before.document.currentPageId;
  state.pageSelection = new Set(
    before.document.selectedPages || []
  );
  state.revision =
    before.document.revision;
  state.history = [
    ...before.history
  ];
  state.future = [
    ...before.future
  ];
  state.savedRevision =
    before.savedRevision;
  state.nextRevision =
    before.nextRevision;
  state.figureSelection.clear();
  for (
    const id of
    before.figureSelection
  ) {
    state.figureSelection.add(id);
  }
  state.selectedAnnotationId =
    before.selectedAnnotationId;

  syncUI();
}

async function recoverHistoryOperation(
  before
) {
  state.history = [
    ...before.history
  ];
  state.future = [
    ...before.future
  ];
  state.savedRevision =
    before.savedRevision;
  state.nextRevision =
    before.nextRevision;

  await restoreSnapshot(
    before.document
  );

  state.figureSelection.clear();
  for (
    const id of
    before.figureSelection
  ) {
    state.figureSelection.add(id);
  }
  state.selectedAnnotationId =
    before.selectedAnnotationId;

  if (state.mode === "edit") {
    renderAnnotations();
  }

  syncUI();
}

async function handleHistoryOperationFailure(
  operationLabel,
  before,
  error
) {
  console.error(
    `${operationLabel} failed:`,
    error
  );

  try {
    await recoverHistoryOperation(
      before
    );

    state.historyRecoveryFailed =
      false;

    showToast(
      `${operationLabel}処理に失敗したため、操作前の状態に戻しました。`,
      true
    );
  } catch (recoveryError) {
    console.error(
      `${operationLabel} recovery failed:`,
      recoveryError
    );

    state.historyRecoveryFailed =
      true;

    /*
     * 再描画そのものが失敗しても、内部状態と履歴は
     * 操作前へ戻しておきます。表示の正しさを保証できないため、
     * 以後の編集はbusy状態でロックし、PDFを閉じる操作だけ許可します。
     */
    applyHistoryOperationState(
      before
    );

    updateStatus(
      HISTORY_RECOVERY_MESSAGE
    );

    showToast(
      HISTORY_RECOVERY_MESSAGE,
      true
    );
  }
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

  const before =
    captureHistoryOperationState();

  const snap =
    state.history[
      state.history.length - 1
    ];

  state.restoringHistory = true;
  setBusy(true, "編集履歴を反映しています…");
  syncUndoRedo();

  try {
    /*
     * 描画に成功するまで履歴スタックは動かしません。
     * これにより失敗したUndoがhistory/futureを消費しません。
     */
    await restoreSnapshot(
      snap
    );

    state.future.push(
      before.document
    );

    if (
      state.future.length > 40
    ) {
      state.future.shift();
    }

    state.history.pop();

    await releaseUnusedSources();
  } catch (error) {
    await handleHistoryOperationFailure(
      "Undo",
      before,
      error
    );
  } finally {
    state.restoringHistory =
      false;

    if (
      state.historyRecoveryFailed
    ) {
      setBusy(
        true,
        HISTORY_RECOVERY_MESSAGE
      );
      updateStatus(
        HISTORY_RECOVERY_MESSAGE
      );
    } else {
      setBusy(false);
    }

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

  const before =
    captureHistoryOperationState();

  const snap =
    state.future[
      state.future.length - 1
    ];

  state.restoringHistory = true;
  setBusy(true, "編集履歴を反映しています…");
  syncUndoRedo();

  try {
    /*
     * Undoと同様に、描画成功後だけ履歴スタックを確定します。
     */
    await restoreSnapshot(
      snap
    );

    state.history.push(
      before.document
    );

    if (
      state.history.length > 40
    ) {
      state.history.shift();
    }

    state.future.pop();

    await releaseUnusedSources();
  } catch (error) {
    await handleHistoryOperationFailure(
      "Redo",
      before,
      error
    );
  } finally {
    state.restoringHistory =
      false;

    if (
      state.historyRecoveryFailed
    ) {
      setBusy(
        true,
        HISTORY_RECOVERY_MESSAGE
      );
      updateStatus(
        HISTORY_RECOVERY_MESSAGE
      );
    } else {
      setBusy(false);
    }

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
  els.layer.dataset.tool = state.tool;
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
  $("pdfHeaderActions").hidden = !hasPages;

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
    (
      state.busy &&
      !state.historyRecoveryFailed
    ) ||
    !hasPages;

  els.save.disabled =
    state.busy ||
    !hasPages;
  syncPdfSaveOptions();
  $("saveRedactedPdfMenuItem").disabled = state.busy || !hasPages;
  $("saveProjectBtn").disabled = state.busy || !hasPages;
  if (els.save.disabled) closeSaveMenu();
  $("insertImageBtn").disabled = state.busy || !hasPages || state.mode !== "edit";
  $("stampBtn").disabled = state.busy || !hasPages || state.mode !== "edit";
  $("pageNumberBtn").disabled = state.busy || !hasPages;
  $("watermarkBtn").disabled = state.busy || !hasPages;

  els.pageCount.textContent =
    `${state.pages.length}ページ`;

  els.pageIndicator.textContent =
    hasPages && index >= 0
      ? `${index + 1} / ${
          state.pages.length
        }ページ`
      : "0 / 0ページ";

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
  fileList,
  insertionIndex = state.pages.length
) {
  if (state.busy) {
    return;
  }

  const selectedFiles = [
    ...fileList
  ];

  if (selectedFiles.some(isProjectFile)) {
    if (selectedFiles.length !== 1) {
      els.input.value = "";

      showToast(
        "作業ファイルは1つだけを、PDFと混ぜずに開いてください。",
        true
      );

      return;
    }

    return openProjectFile(selectedFiles[0]);
  }

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

  const historyBefore = [...state.history];
  const futureBefore = [...state.future];

  const hadPages =
    before.pages.length > 0;
  const insertAt = Number.isInteger(insertionIndex)
    ? clamp(insertionIndex, 0, before.pages.length)
    : before.pages.length;

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

    insertLoadedPages(before.pages.length, insertAt);

    state.currentPageId ||=
      state.pages[0]?.id ||
      null;

    syncUI();

    await renderThumbnails();
    await renderCurrentPage();

    // 描画成功後に確定し、失敗時にRedoが参照するPDFを解放しない。
    if (hadPages) {
      pushHistory(before);
    } else {
      state.history = [];
      state.future = [];
      resetDocumentRevision();
    }
    syncUI();

    updateStatus(
      `${files.length}ファイルを読み込みました。全${state.pages.length}ページです。`
    );

    showToast(
      hadPages
        ? (insertAt === before.pages.length ? "PDFを末尾へ追加しました。" : `PDFを${insertAt + 1}ページ目の位置へ追加しました。`)
        : "PDFを読み込みました。"
    );
  } catch (error) {
    /*
     * 初回読込み・追加読込みのどちらでも、
     * ページ状態を開始前へ戻します。
     */
    state.pages =
      clone(before.pages);

    // 描画まで成功する前の失敗では、保存判定と履歴も読込み前へ戻す。
    state.revision = before.revision;
    state.history = historyBefore;
    state.future = futureBefore;
    state.pageSelection = new Set(before.selectedPages);

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

async function renderCurrentPage({ throwOnError = false } = {}) {
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
    if (throwOnError) {
      throw new Error("ページの元データが見つかりません。");
    }
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
        "RenderingCancelledException" &&
        !throwOnError
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

    // 履歴の反映・復旧では呼び出し元が表示と履歴をまとめて復旧する。
    if (throwOnError) throw error;

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
  const preview = document.createElement("div");
  preview.className = "thumb-preview";
  preview.append(canvas);
  const meta = document.createElement("div"); meta.className = "thumb-meta";
  const number = document.createElement("span"); number.className = "thumb-page"; number.textContent = index + 1;
  const source = document.createElement("span"); source.className = "thumb-source"; source.textContent = state.sources.get(page.sourceId)?.name || "";
  const check = document.createElement("input"); check.type = "checkbox"; check.className = "page-check";
  check.setAttribute("aria-label", `${index + 1}ページ目を選択`);
  check.addEventListener("click", e => e.stopPropagation());
  check.addEventListener("change", () => choosePage(page.id, {ctrlKey:true}));
  const checkTarget = document.createElement("label"); checkTarget.className = "page-check-target";
  checkTarget.append(check);
  checkTarget.addEventListener("click", e => e.stopPropagation());
  let pageDragFromControl = false;
  item.addEventListener("pointerdown", e => {
    pageDragFromControl = Boolean(e.target.closest("button, input, label"));
  });
  const edit = document.createElement("button"); edit.type = "button"; edit.className = "thumb-edit"; edit.textContent = "編集";
  edit.setAttribute("aria-label", `${index + 1}ページ目を編集`);
  edit.addEventListener("click", e => {e.stopPropagation(); openPageEditor(page.id);});
  meta.append(number, source, edit); item.append(preview, meta, checkTarget);
  if (page.annotations.length || page.pageNumber || page.watermark) {
    const dot = document.createElement("span");
    dot.className = "thumb-annotation-dot";
    const kinds = [
      page.annotations.length ? "図形" : "",
      page.pageNumber ? "ページ番号" : "",
      page.watermark ? "透かし" : "",
    ].filter(Boolean);
    const label = `${kinds.join("・")}あり`;
    dot.title = label;
    dot.setAttribute("aria-label", label);
    item.append(dot);
  }
  item.addEventListener("click", e => choosePage(page.id, e));
  item.addEventListener("keydown", e => {
    if (e.target !== item || state.busy) return;
    if (e.key === "Enter") {e.preventDefault();openPageEditor(page.id);}
    if (e.key === " ") {e.preventDefault();choosePage(page.id,e);}
    if (["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"].includes(e.key)) {
      e.preventDefault(); const columns=state.mode==='overview'?thumbnailColumns([...els.thumbs.children]):1;
      const d={ArrowLeft:-1,ArrowRight:1,ArrowUp:-columns,ArrowDown:columns}[e.key];
      const next=state.pages[Math.max(0,Math.min(state.pages.length-1,index+d))];
      choosePage(next.id,e);els.thumbs.querySelector(`[data-page-id="${CSS.escape(next.id)}"]`)?.focus();
    }
  });
  item.addEventListener("dragstart", e => {
    if(state.busy || state.mode !== 'overview' || pageDragFromControl || e.target.closest('button,input,label')) {e.preventDefault();return;}
    if(!state.pageSelection.has(page.id)) choosePage(page.id,{});
    state.dragPageId=page.id;e.dataTransfer.effectAllowed="move";e.dataTransfer.setData("text/plain",page.id);
    for (const thumb of els.thumbs.children) {
      thumb.classList.toggle("dragging", state.pageSelection.has(thumb.dataset.pageId));
    }
  });
  item.addEventListener("dragend", clearPageDrag);
  item.addEventListener("dragover", handlePageDragOver);
  item.addEventListener("drop", handlePageDrop);
  return item;
}


function thumbnailRenderKey(pageRef) {
  return [
    pageRef.sourceId,
    pageRef.sourceIndex,
    thumbnailRasterSize(state.thumbnailSize).width,
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

function restoreDeletedPageFocus(pageId) {
  // Do not steal focus if the user moved to another control during rendering.
  if (state.mode !== "overview" || document.activeElement !== els.thumbs ||
      !state.pageSelection.has(pageId)) return;
  els.thumbs.querySelector(`[data-page-id="${CSS.escape(pageId)}"]`)?.focus();
}

async function renderThumbnails(anchorPageId = null, focusPageId = null, { throwOnError = false } = {}) {
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

  if (focusPageId) restoreDeletedPageFocus(focusPageId);

  if (!focusPageId && focusedPageId) {
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
  if (anchorPageId) {
    els.thumbs.querySelector(`[data-page-id="${CSS.escape(anchorPageId)}"]`)
      ?.scrollIntoView({ block: "start", inline: "nearest" });
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
      if (throwOnError) throw new Error("サムネイルのCanvasが見つかりません。");
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
        if (throwOnError) throw new Error("ページの元データが見つかりません。");
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
          thumbnailRasterSize(state.thumbnailSize).width / unit.width,
          thumbnailRasterSize(state.thumbnailSize).height / unit.height
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
        if (throwOnError) throw new Error("Canvasを初期化できませんでした。");
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
      // 通常表示では他ページの描画を継続し、履歴復元では失敗を伝える。
      if (throwOnError) throw error;
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
    (page.annotations.length || page.pageNumber || page.watermark) &&
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
    !page.annotations.length && !page.pageNumber && !page.watermark &&
    dot
  ) {
    dot.remove();
  }
  if (dot) {
    const kinds = [
      page.annotations.length ? "図形" : "",
      page.pageNumber ? "ページ番号" : "",
      page.watermark ? "透かし" : "",
    ].filter(Boolean);
    const label = `${kinds.join("・")}あり`;
    dot.title = label;
    dot.setAttribute("aria-label", label);
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
  try {
    for (const page of pages) {
      if (page.pageNumber)
        resolvedPageNumber({ ...page, rotationExtra: normRotation(page.rotationExtra + delta) });
      if (page.watermark)
        resolvedWatermark({ ...page, rotationExtra: normRotation(page.rotationExtra + delta) });
    }
  } catch (error) {
    showToast(`回転できません。${error.message}`);
    return;
  }
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
  const restoreFocus = state.mode === "overview" && els.thumbs.contains(document.activeElement);
  // Keep focus within the list until the replacement thumbnail is available.
  if (restoreFocus)
    els.thumbs.focus({ preventScroll: true });
  finishTextEditing();pushHistory();
  const index = state.pages.findIndex(page => state.pageSelection.has(page.id));
  state.pages=state.pages.filter(p=>!state.pageSelection.has(p.id));
  state.currentPageId=state.pages[Math.min(index,state.pages.length-1)].id;
  state.pageSelection=new Set([state.currentPageId]);state.selectionAnchor=state.currentPageId;state.selectedAnnotationId=null;state.figureSelection.clear();
  syncUI();
  if(state.mode==="overview") renderThumbnails(null, restoreFocus ? state.currentPageId : null); else renderCurrentPage();
  const message = `${pages.length}ページを削除しました（残り${state.pages.length}ページ）。元に戻すで復元できます。`;
  updateStatus(message);
  showToast(message);
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
      "rect", "redact",
      "arrow", "ellipse", "line", "highlight", "ink", "ink-eraser"
    ].includes(tool)
  ) {
    return;
  }

  cancelInkGesture();
  finishTextEditing();

  state.tool = tool;
  state.figureSelection.clear();
  getSelection()?.removeAllRanges();

  state.selectedAnnotationId =
    null;

  els.layer.classList.remove(
    "tool-text",
    "tool-rect", "tool-redact",
    "tool-arrow", "tool-ellipse", "tool-line", "tool-highlight", "tool-ink", "tool-ink-eraser"
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
  syncFigureOrderControls();
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
      type === "text" || type === "highlight" || type === "ink-eraser"
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

}

function renderAnnotations() { cancelInkGesture(); renderFigures(); }


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

  // 空テキスト取消時に、上限40件から最古の履歴を落とさない。
  pushHistory(snapshot(), { deferTrim: true });

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

let activeInkGesture = null;
let inkTouchHintShown = false;
function cancelInkGesture() { activeInkGesture?.cancel(); }

function beginInkGesture(event) {
  if (activeInkGesture || state.busy || state.mode !== "edit" ||
      !["ink", "ink-eraser"].includes(state.tool)) return;
  const page = currentPage();
  if (!page) return;
  if (!acceptsInkPointer(event, state.inkTouch)) {
    if (event.pointerType === "touch" && !state.inkTouch && event.isPrimary !== false && !inkTouchHintShown) {
      inkTouchHintShown = true;
      showToast("指で描く・消すには設定パネルの「指でも描く・消す」をオンにしてください。スクロールは「選択」（Esc）へ戻します。");
    }
    return;
  }
  const erase = state.tool === "ink-eraser", tool = state.tool, scale = state.viewScale,
    stabilization = state.inkStabilization;
  const limit = Math.min(MAX_STROKE_POINTS, MAX_DOCUMENT_INK_POINTS - documentInkPointCount(state.pages));
  if (!erase && limit < 1) {
    showToast("手書きデータの上限です。不要なストロークを削除するか、保存して開き直してください。", true);
    return;
  }
  event.preventDefault();
  finishTextEditing();
  closeFigureContextMenu();
  const before = snapshot(), size = pageDisplaySize(page), rect = els.layer.getBoundingClientRect();
  // Fix the coordinate mapping for this gesture; cancel if layout/view changes.
  const point = e => ({ x: clamp((e.clientX - rect.left) / scale, 0, size.width),
    y: clamp((e.clientY - rect.top) / scale, 0, size.height) });
  const annotation = { id: uid(), type: "ink", points: [], color: state.defaults.color, strokeWidth: state.defaults.stroke };
  const erasable = erase ? page.annotations.filter(a => a.type === "ink").map(a => ({ annotation: a, box: bounds(a) })) : [];
  const erased = new Set(), preview = svgNode("svg", { viewBox: `0 0 ${size.width} ${size.height}`, "aria-hidden": "true" });
  preview.classList.add("ink-preview");
  const path = svgNode("path", { fill: "none", stroke: annotation.color, "stroke-width": annotation.strokeWidth,
    "stroke-linecap": "round", "stroke-linejoin": "round" });
  const dot = svgNode("circle", { fill: annotation.color, r: annotation.strokeWidth / 2 });
  preview.append(path, dot);
  if (!erase) els.layer.append(preview);
  let lastPoint = point(event), stablePoint = null, frame = 0, ended = false;
  const paint = () => {
    frame = 0;
    if (erase) {
      for (const id of erased) els.layer.querySelector(`[data-ann-id="${CSS.escape(id)}"]`)?.classList.add("ink-erasing");
    } else {
      path.setAttribute("d", inkPath(annotation.points));
      dot.setAttribute("cx", annotation.points[0].x); dot.setAttribute("cy", annotation.points[0].y);
      dot.setAttribute("visibility", annotation.points.length === 1 ? "visible" : "hidden");
    }
  };
  const valid = () => {
    const now = els.layer.getBoundingClientRect();
    return !state.busy && state.mode === "edit" && currentPage() === page && state.tool === tool &&
      state.viewScale === scale && Math.abs(now.left - rect.left) < 0.5 && Math.abs(now.top - rect.top) < 0.5 &&
      Math.abs(now.width - rect.width) < 0.5 && Math.abs(now.height - rect.height) < 0.5;
  };
  const finish = (cancelled, limited = false) => {
    if (ended) return;
    ended = true;
    cancelled ||= !valid();
    activeInkGesture = null;
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", end);
    document.removeEventListener("pointercancel", end);
    document.removeEventListener("lostpointercapture", end, true);
    document.removeEventListener("pointerdown", outside, true);
    document.removeEventListener("keydown", cancelByKey, true);
    document.removeEventListener("wheel", cancel, true);
    window.removeEventListener("blur", cancel);
    window.removeEventListener("resize", cancel);
    cancelAnimationFrame(frame); preview.remove();
    try { if (els.layer.hasPointerCapture(event.pointerId)) els.layer.releasePointerCapture(event.pointerId); } catch { /* already released */ }
    if (!cancelled && (erase ? erased.size : annotation.points.length)) {
      if (erase) {
        page.annotations = page.annotations.filter(a => !erased.has(a.id));
        state.figureSelection = new Set([...state.figureSelection].filter(id => !erased.has(id)));
        if (erased.has(state.selectedAnnotationId)) state.selectedAnnotationId = null;
      } else {
        page.annotations.push(annotation);
        state.figureSelection.clear(); state.selectedAnnotationId = null;
      }
      pushHistory(before);
      updateThumbnailAnnotationMarker(page.id);
    }
    renderAnnotations();
    if (limited) showToast("1本の手書きデータの上限に達しました。ペンを離し、続きは新しいストロークで描いてください。", true);
  };
  const sample = (e, final = false) => {
    const p = point(e);
    if (erase) {
      for (const { annotation: a, box } of erasable) if (!erased.has(a.id) &&
        inkIntersectsSegment(a, lastPoint, p, 8 / scale, box)) erased.add(a.id);
    } else {
      // End at the release position rather than leaving the tail behind the pen.
      stablePoint = final ? p : stabilizeInkPoint(stablePoint, p, stabilization);
      appendInkPoint(annotation.points, stablePoint, limit);
    }
    lastPoint = p;
  };
  const move = e => {
    if (e.pointerId !== event.pointerId) return;
    if (!valid()) { finish(true); return; }
    e.preventDefault();
    for (const sampleEvent of e.getCoalescedEvents?.() || []) sample(sampleEvent);
    sample(e);
    if (!erase && annotation.points.length >= limit) { finish(false, true); return; }
    if (!frame) frame = requestAnimationFrame(paint);
  };
  const end = e => {
    if (e.pointerId !== event.pointerId) return;
    if (e.type === "pointerup" && valid()) sample(e, true);
    finish(e.type !== "pointerup");
  };
  const cancel = () => finish(true);
  const cancelByKey = e => { if (e.key === "Escape") cancel(); };
  const outside = e => {
    if (e.pointerType !== "touch" && !e.target.closest("#annotationLayer")) cancel();
  };
  activeInkGesture = { cancel };
  sample(event); paint();
  try { els.layer.setPointerCapture(event.pointerId); } catch { finish(true); return; }
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", end);
  document.addEventListener("pointercancel", end);
  document.addEventListener("lostpointercapture", end, true);
  document.addEventListener("pointerdown", outside, true);
  document.addEventListener("keydown", cancelByKey, true);
  document.addEventListener("wheel", cancel, true);
  window.addEventListener("blur", cancel);
  window.addEventListener("resize", cancel);
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

  const pageSize =
    pageDisplaySize(page);

  const annotation =
    type === "redact"
      ? { id: uid(), type, x: start.x, y: start.y, w: 0, h: 0, redactColor: state.redactionColor }
      : ["rect", "ellipse"].includes(type)
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

  const endPendingEdit = trackUnsavedEdit(() =>
    ["rect", "ellipse", "redact"].includes(type)
      ? annotation.w >= 5 && annotation.h >= 5
      : Math.hypot(annotation.x2 - annotation.x1, annotation.y2 - annotation.y1) >= 8
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

      if (["rect", "ellipse", "redact"].includes(type)) {
        const box = drawingBox(
          start,
          point,
          pageSize,
          moveEvent.shiftKey || moveEvent.ctrlKey,
        );
        Object.assign(annotation, box);
      } else {
        const endpoint = constrainedLinePoint(
          start,
          point,
          moveEvent.ctrlKey,
        );
        annotation.x2 = endpoint.x;
        annotation.y2 = endpoint.y;
      }

      renderAnnotations();

      els.layer.classList.add(
        "drawing"
      );
    };

  const finish =
    finishEvent => {
      endPendingEdit();
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
        ["rect", "ellipse", "redact"].includes(type)
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
        // Keep the drawing tool active so the next drag adds another shape.
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

  const isChanged = () => JSON.stringify(annotation) !== JSON.stringify(original);
  const endPendingEdit = trackUnsavedEdit(isChanged);

  const size =
    pageDisplaySize(page);

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

      const verticalText = annotation.type === "text" && [90, 270].includes(annotation.rotation || 0);
      const minWidth =
          annotation.type === "text" ? (verticalText ? 30 : 70) : 8,
        minHeight =
          annotation.type === "text" ? (verticalText ? 70 : 30) : 8,
        preserveAspect =
          annotation.type === "image" ||
          (["rect", "ellipse"].includes(annotation.type) &&
          (moveEvent.shiftKey || moveEvent.ctrlKey)),
        resized = resizeBox(
          original,
          dx,
          dy,
          size,
          preserveAspect,
          minWidth,
          minHeight,
        );

      annotation.w = resized.w;
      annotation.h = resized.h;

      renderAnnotations();
    };

  const finish = event => {
    endPendingEdit();
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
    else if (isChanged()) { pushHistory(before); }

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
        if (Number.isInteger(creationHistoryEntry.revision)) {
          state.revision = creationHistoryEntry.revision;
        }

        /*
         * 空テキスト作成は操作として成立しないため、
         * この操作によって消去されたRedo履歴は
         * 復元できません。通常の編集操作と同じ扱いです。
         */
        syncUndoRedo();
      }
    }

    if (isNew) {
      trimHistory();
      void releaseUnusedSources();
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

function moveSelectedFigures(position) {
  if (state.busy || state.mode !== "edit" || !currentPage()) return;
  finishTextEditing();
  const page = currentPage(),
    selected = selectedFigures();
  if (selected.some(a => a.type === "redact")) return;
  const next = reorderAnnotations(page.annotations, selected.map((a) => a.id), position);
  if (next === page.annotations) return;
  pushHistory();
  page.annotations = next;
  renderAnnotations();
  updateThumbnailAnnotationMarker(page.id);
  updateStatus(`${selected.length}個の図形を${position === "front" ? "最前面" : "最背面"}に移動しました。`);
  // The completed action becomes disabled; keep keyboard focus on a visible action.
  $(position === "front" ? "sendFiguresBackBtn" : "bringFiguresFrontBtn").focus({ preventScroll: true });
}

function deleteSelectedAnnotation() {
  if(state.busy || !currentPage())return;
  finishTextEditing();const ids=selectedFigures().map(a=>a.id);if(!ids.length)return;
  pushHistory();currentPage().annotations=currentPage().annotations.filter(a=>!ids.includes(a.id));
  state.selectedAnnotationId=null;state.figureSelection.clear();renderAnnotations();updateThumbnailAnnotationMarker(currentPage().id);
  updateStatus(`${ids.length}個の図形を削除しました。`);
}


function applyRedactionColor(value) {
  if (state.busy || !["#000000", "#ffffff"].includes(value)) return;
  finishTextEditing();
  const selected = selectedFigures();
  if (!selected.length) {
    state.redactionColor = value;
    syncToolProperties();
    return;
  }
  if (selected.some(a => a.type !== "redact") || selected.every(a => redactionColor(a) === value)) return;
  pushHistory();
  selected.forEach(a => { a.redactColor = value; });
  renderAnnotations();
  updateThumbnailAnnotationMarker(currentPage().id);
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
  const eligible=annotations.filter(a=>a.type!=='image' && a.type!=='redact' && (textKeys.includes(kind)?a.type==='text':kind==='outline'?['text','arrow'].includes(a.type):['fill','fillNone'].includes(kind)?['rect','ellipse'].includes(a.type):kind==='opacity'?a.type==='highlight':kind==='strokeWidth'?!['text','highlight'].includes(a.type):true));
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

  // Page-space bounds swap on quarter turns; rasterize the original text layout.
  const layout = annotation.watermark
    ? { width: annotation.w, height: annotation.h }
    : imagePlacement(annotation, 0);
  const width = Math.max(1, layout.width);
  const height = Math.max(1, layout.height);

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

  if (annotation.watermark) {
    // 透かしはプレビューのSVGと同じ基準線で、箱の中央へ1行で描きます。
    context.textAlign = "center";
    context.textBaseline = "alphabetic";
    context.fillText(annotation.text, width / 2, height / 2 + watermarkBaselineOffset(annotation));
  }

  const lines = annotation.watermark ? [] :
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
      page.pageNumber || page.annotations.some(
        annotation =>
          [
            "rect", "redact",
            "ellipse",
            "text", "image", "ink"
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
      page.annotations.length !== 0 || page.pageNumber || page.watermark
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
  downloadBlob(
    new Blob(
      [bytes],
      {
        type: "application/pdf"
      }
    ),
    sanitizePdfName(fileName)
  );
}

function downloadBlob(
  blob,
  fileName
) {
  const url =
    URL.createObjectURL(blob);

  const anchor =
    document.createElement("a");

  anchor.href = url;
  anchor.download =
    fileName;

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
    (reference.annotations.length > 0 || reference.pageNumber || reference.watermark) &&
    effectivePageRotation(
      reference
    ) !== 0
  );
}


async function drawAnnotationsOnPdf(output, page, reference, height) {
  const watermark = reference.watermark ? resolvedWatermark(reference) : null;
  const number = resolvedPageNumber(reference);
  const items = [
    ...(watermark ? [watermark] : []),
    ...reference.annotations,
    ...(number ? [number] : []),
  ];
  for(const a of items) {
    // Dedicated masks are applied to pixels only, after all ordinary edits have been rendered.
    if (a.type === "redact") continue;
    if (a.type === "image") {
      const asset = state.images.get(a.imageId);
      if (!asset) throw new Error("挿入画像を読み込めませんでした。");
      let cache = embeddedImages.get(output);
      if (!cache) embeddedImages.set(output, cache = new Map());
      if (!cache.has(a.imageId)) cache.set(a.imageId, asset.mime === "image/jpeg"
        ? await output.embedJpg(asset.bytes) : await output.embedPng(asset.bytes));
      const placement = imagePlacement(a, height);
      page.drawImage(cache.get(a.imageId), { x: placement.x, y: placement.y,
        width: placement.width, height: placement.height, rotate: degrees(-placement.rotation) });
      continue;
    }
    const color=rgb(...hexToRgb(a.color));
    if(['rect','ellipse'].includes(a.type)) {
      const options={borderColor:color,borderWidth:a.strokeWidth,color:a.fillNone!==false?undefined:rgb(...hexToRgb(a.fill))};
      if(a.type==='rect')page.drawRectangle({...options,x:a.x,y:height-a.y-a.h,width:a.w,height:a.h});
      else page.drawEllipse({...options,x:a.x+a.w/2,y:height-a.y-a.h/2,xScale:a.w/2,yScale:a.h/2});
    } else if (a.type === "ink") {
      if (a.points.length === 1) page.drawCircle({ x: a.points[0].x, y: height - a.points[0].y,
        size: a.strokeWidth / 2, color, borderWidth: 0 });
      else {
        page.pushOperators(pushGraphicsState(), setLineJoin(1));
        page.drawSvgPath(inkPath(a.points), { x: 0, y: height, borderColor: color,
          borderWidth: a.strokeWidth, borderLineCap: 1 });
        page.pushOperators(popGraphicsState());
      }
    } else if(isLine(a))drawArrowOnPdf(page,a,height);
    else if(a.type==='highlight') {
      for(const r of a.rects)page.drawRectangle({x:r.x,y:height-r.y-r.h,width:r.w,height:r.h,color,opacity:a.opacity,blendMode:'Multiply',borderWidth:0});
    } else if(a.type==='text'&&a.text.trim()) {
      const image=await embedTextPng(output, await renderTextAnnotationPng(a), a.outline);
      if (a.watermark) {
        const angle = Number(a.rotation) || 0;
        const radians = -angle * Math.PI / 180;
        const centerX = a.x + a.w / 2;
        const centerY = height - (a.y + a.h / 2);
        const halfX = Math.cos(radians) * a.w / 2 - Math.sin(radians) * a.h / 2;
        const halfY = Math.sin(radians) * a.w / 2 + Math.cos(radians) * a.h / 2;
        page.drawImage(image, {
          x: centerX - halfX,
          y: centerY - halfY,
          width: a.w,
          height: a.h,
          rotate: degrees(-angle),
          opacity: a.opacity,
        });
      } else {
        const placement = imagePlacement(a, height);
        page.drawImage(image, { x: placement.x, y: placement.y,
          width: placement.width, height: placement.height, rotate: degrees(-placement.rotation) });
      }
    }
  }
}

// Use a separate, strict PDF.js document for export; preview rendering may recover from errors.
async function renderRedactionPage(reference, sources) {
  let canvas = null, overlayCanvas = null, overlayDoc = null;
  try {
    if (!sources.has(reference.sourceId)) {
      const source = sourceFor(reference);
      if (!source) throw new Error("PDFの元データが見つかりません。");
      const task = pdfjsLib.getDocument({ data: source.bytes.slice(0), stopAtErrors: true,
        ...getPdfJsAuxiliaryOptions() });
      try { sources.set(reference.sourceId, await task.promise); }
      catch (error) { await task.destroy(); throw error; }
    }
    const pdfPage = await sources.get(reference.sourceId).getPage(reference.sourceIndex + 1);
    const rotation = effectivePageRotation(reference);
    const unit = pdfPage.getViewport({ scale: 1, rotation });
    const size = redactionRasterSize(unit.width, unit.height);
    canvas = document.createElement("canvas");
    canvas.width = size.width; canvas.height = size.height;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("ページ画像を作成できませんでした。");
    await pdfPage.render({ canvasContext: context, viewport: pdfPage.getViewport({ scale: size.scale, rotation }),
      intent: "display", annotationMode: pdfjsLib.AnnotationMode.ENABLE, background: "#ffffff" }).promise;
    pdfPage.cleanup();

    const annotations = reference.annotations.filter(a => a.type !== "redact");
    if (annotations.length || reference.watermark || reference.pageNumber) {
      // Render ordinary edits separately. No original PDF page/objects enter this temporary document.
      const overlay = await PDFDocument.create({ updateMetadata: false });
      const page = overlay.addPage([unit.width, unit.height]);
      await drawAnnotationsOnPdf(overlay, page, { ...reference, annotations }, unit.height);
      const task = pdfjsLib.getDocument({ data: await overlay.save(), stopAtErrors: true,
        ...getPdfJsAuxiliaryOptions() });
      try { overlayDoc = await task.promise; }
      catch (error) { await task.destroy(); throw error; }
      const overlayPage = await overlayDoc.getPage(1);
      overlayCanvas = document.createElement("canvas");
      overlayCanvas.width = size.width; overlayCanvas.height = size.height;
      const overlayContext = overlayCanvas.getContext("2d");
      if (!overlayContext) throw new Error("編集内容の画像を作成できませんでした。");
      await overlayPage.render({ canvasContext: overlayContext, viewport: overlayPage.getViewport({ scale: size.scale }),
        background: "rgba(0,0,0,0)" }).promise;
      context.drawImage(overlayCanvas, 0, 0);
    }
    return { canvas, width: unit.width, height: unit.height };
  } catch (error) {
    if (canvas) { canvas.width = 0; canvas.height = 0; }
    throw error;
  } finally {
    if (overlayCanvas) { overlayCanvas.width = 0; overlayCanvas.height = 0; }
    if (overlayDoc) await overlayDoc.destroy();
  }
}

// A modal keeps the confirmation compact and makes editing inert while the choice is pending.
// The same dialog can switch an ordinary overlay save to the image-only export.
function confirmPdfSave({ rasterize, extract, masked }) {
  const dialog = $("pdfSaveDialog"), form = $("pdfSaveForm");
  if (dialog.open || state.pdfSavePending) return Promise.resolve(null);
  const previousFocus = document.activeElement;
  const render = () => {
    const kind = masked ? "墨消し" : "画像化";
    $("pdfSaveTitle").textContent = rasterize ? `${kind}PDFを保存しますか？` : "通常のPDFを保存しますか？";
    $("pdfSaveSummary").textContent = rasterize
      ? `元の文字や画像データが公開後に取り出されないよう、${extract ? "選択したページ" : "全ページ"}を一度画像化して保存します。`
      : "四角形や画像などを重ねても、PDF内部に元の文字や画像データが残ります。マスキング用途では「墨消しPDFとして保存」を選んでください。";
    $("pdfSaveSelectionNotice").hidden = !rasterize || masked;
    $("pdfSaveSelectionNotice").textContent = `${extract ? "選択したページには" : "専用の"}墨消し範囲がありません。四角形や画像で隠す場合は、不透明で完全に覆われているか確認してください。`;
    $("pdfSaveCautions").hidden = !rasterize;
    $("pdfSaveReview").hidden = !rasterize;
    $("pdfSaveConfirmBtn").textContent = rasterize ? `${kind}PDFを保存` : "通常のPDFを保存";
    $("pdfSaveConfirmBtn").classList.toggle("primary", rasterize);
    $("pdfSaveRasterizeBtn").hidden = rasterize;
  };
  render();
  dialog.returnValue = "";
  state.pdfSavePending = true;
  return new Promise(resolve => {
    const submit = event => {
      event.preventDefault();
      dialog.close(event.submitter?.value === "save" ? (rasterize ? "rasterized" : "normal") : "cancel");
    };
    const switchToRaster = () => { rasterize = true; render(); $("pdfSaveConfirmBtn").focus(); };
    const cancel = () => { dialog.returnValue = "cancel"; };
    const keydown = event => {
      // Let the dialog handle Escape/Tab/Enter, without invoking document shortcuts.
      event.stopPropagation();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") event.preventDefault();
    };
    const cleanup = () => {
      state.pdfSavePending = false;
      form.removeEventListener("submit", submit);
      $("pdfSaveRasterizeBtn").removeEventListener("click", switchToRaster);
      dialog.removeEventListener("cancel", cancel);
      dialog.removeEventListener("keydown", keydown);
      dialog.removeEventListener("close", close);
    };
    const close = () => {
      cleanup();
      if (previousFocus?.isConnected && !previousFocus.disabled && !previousFocus.hidden) previousFocus.focus({ preventScroll: true });
      else els.save.focus({ preventScroll: true });
      resolve(["normal", "rasterized"].includes(dialog.returnValue) ? dialog.returnValue : null);
    };
    form.addEventListener("submit", submit);
    $("pdfSaveRasterizeBtn").addEventListener("click", switchToRaster);
    dialog.addEventListener("cancel", cancel);
    dialog.addEventListener("keydown", keydown);
    dialog.addEventListener("close", close);
    try { dialog.showModal(); }
    catch (error) {
      cleanup();
      console.error(error);
      showToast("保存の確認画面を開けませんでした。もう一度お試しください。", true);
      resolve(null);
    }
  });
}

async function exportRedactedPdf(exportPages, extract, confirmed = false) {
  // Freeze the selected pages/ranges before any asynchronous work or pending pointer completion.
  exportPages = clone(exportPages);
  const masked = hasRedactions(exportPages);
  const outputKind = masked ? "墨消し" : "画像化";
  if (!confirmed && await confirmPdfSave({ rasterize: true, extract, masked }) !== "rasterized") return;
  const sources = new Map();
  setBusy(true, `${outputKind}PDFを作成しています…`);
  try {
    const bytes = await createRedactedPdf(exportPages, reference => renderRedactionPage(reference, sources),
      (index, total) => updateStatus(`${outputKind}PDFを作成しています… ${index} / ${total}`));
    const name = sourceFor(exportPages[0])?.name || "document.pdf";
    downloadPdfBytes(bytes, `${extract ? "抽出_" : ""}${outputKind}_${name}`);
    if (!extract) markDocumentSaved();
    updateStatus(`${outputKind}PDFを保存しました。保存したPDFを開き、墨消し範囲や隠し忘れがないか確認してください。`);
    showToast(`${outputKind}PDFを保存しました。保存したPDFを開き、墨消し範囲や隠し忘れがないか確認してください。`);
  } catch (error) {
    console.error(error);
    updateStatus(`${outputKind}PDFの保存を中止しました。ファイルは保存していません。`);
    showToast(error?.message || `${outputKind}PDFの作成に失敗しました。`, true);
  } finally {
    for (const doc of sources.values()) {
      try { await doc.destroy(); } catch (error) { console.warn("墨消し用PDFの解放に失敗しました。", error); }
    }
    setBusy(false);
  }
}

async function exportPdf(extract = false, rasterize = false) {
  extract = extract === true;
  const exportPages = extract ? selectedPages() : [...state.pages];
  if (
    !exportPages.length ||
    state.busy || state.pdfSavePending || $("pdfSaveDialog").open
  ) {
    return;
  }

  finishTextEditing();

  // All PDF save paths (including extraction and Ctrl/Command+S) share this guard.
  if (rasterize === true || hasRedactions(state.pages)) return exportRedactedPdf(exportPages, extract);

  if (
    hasCoveringAnnotations(
      exportPages
    )
  ) {
    const choice = await confirmPdfSave({ rasterize: false, extract, masked: false });
    if (choice === "rasterized") return exportRedactedPdf(exportPages, extract, true);
    if (choice !== "normal") return;
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
      markDocumentSaved();

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
         * 内容がある場合だけ、回転情報を0度に正規化したコピーを
         * Form XObjectとして埋め込みます。Contentsのない空白ページは
         * 埋め込む描画内容がないため、番号や図形だけを描画します。
         */
        if (flattenedCopy.node.Contents()) {
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
        }

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
        reference.annotations.length || reference.pageNumber || reference.watermark
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
    if (!extract) {
      markDocumentSaved();
    }

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
    (
      state.busy &&
      !state.historyRecoveryFailed
    )
  ) {
    return;
  }

  finishTextEditing();

  if (hasUnsavedChanges()) {
    const accepted =
      confirm(
        "未保存の編集内容があります。PDFを閉じると失われます。\nこのまま閉じますか？"
      );
    if (!accepted) {
      return;
    }
  }

  /*
   * 復旧不能状態から閉じる場合も、ここからは通常のbusy制御へ戻し、
   * 閉じる処理への二重進入を防ぎます。確認を取り消した場合は
   * ここへ到達しないため、復旧ロックを維持します。
   */
  state.historyRecoveryFailed =
    false;

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
    for (const asset of state.images.values()) URL.revokeObjectURL(asset.url);
    state.images.clear();
    state.pages = [];
    // 初期画面では作業ファイルも選べるよう、選択条件を戻します。
    els.input.accept = initialFileAccept;
    state.currentPageId = null;
    state.selectedAnnotationId =
      null;
    state.history = [];
    state.future = [];
    state.historyRecoveryFailed =
      false;
    resetDocumentRevision();
    state.dragPageId = null;
    state.tool = "select";
    state.thumbnailSize = "medium";
    state.pagesPanelPreference = null;
    $("thumbnailSize").value = "medium";

    state.mode = "overview";
    state.pageSelection.clear();
    state.figureSelection.clear();
    state.clipboard = [];
    clearStampSession();
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
 * 作業ファイル（.abpdf）
 *
 * ページ構成を確定したbase.pdfと、再編集できる図形・ページ番号・透かしを
 * 1つの無圧縮ZIPへまとめます。Undo履歴は保存しません。
 */

const PROJECT_COVERING_MESSAGE =
  "【必読】\n作業ファイルは続きを編集するためのファイルです。配布しないでください。\n墨消し範囲を指定していても、元の文字や画像データは作業ファイルに残ります。\n四角・丸・テキスト・画像・手書きで覆った部分は、作業ファイルを開いて図形を動かすとそのまま見えます。\n\n作業ファイルを保存しますか？";

async function saveProjectFile() {
  if (
    !state.pages.length ||
    state.busy
  ) {
    return;
  }

  finishTextEditing();

  if (
    hasCoveringAnnotations() &&
    !confirm(PROJECT_COVERING_MESSAGE)
  ) {
    return;
  }

  setBusy(
    true,
    "作業ファイルを作成しています…"
  );

  updateStatus(
    "作業ファイルを作成しています。ページ数が多い場合は時間がかかります。"
  );

  try {
    const name =
      sourceFor(state.pages[0])?.name ||
      "document.pdf";

    // PDFを組み立てる前に図形を検証し、開けない作業ファイルを作らない。
    const project =
      serializeProject({
        name,
        pages: state.pages,
        sizes: state.pages.map(pageDisplaySize),
        images: state.images,
        fontFamilies: Object.keys(FONT_STACKS)
      });

    const output =
      await PDFDocument.create({
        updateMetadata: false
      });

    const copiedPages =
      new Map();

    // 元PDFごとの「元ページ番号→付け替え用の名前」。ページ間リンクの付け替えに使います。
    const placeholders =
      new Map();

    for (
      const [
        sourceId,
        source
      ] of state.sources
    ) {
      const references =
        state.pages.filter(
          page =>
            page.sourceId ===
            sourceId
        );

      if (!references.length) {
        continue;
      }

      let sourceDocument;

      try {
        sourceDocument =
          await PDFDocument.load(
            source.bytes.slice(0),
            {
              updateMetadata: false
            }
          );
      } catch {
        throw new Error(
          `${source.name}を作業ファイル用に読み込めませんでした。暗号化PDFや未対応形式は利用できません。`
        );
      }

      // 削除したページへのリンク等をたどって、その内容がbase.pdfへ入らないようにします。
      placeholders.set(
        sourceId,
        detachExcludedPages(
          sourceDocument,
          references.map(
            page =>
              page.sourceIndex
          )
        )
      );

      const copies =
        await output.copyPages(
          sourceDocument,
          references.map(
            page =>
              page.sourceIndex
          )
        );

      references.forEach(
        (page, index) =>
          copiedPages.set(
            page.id,
            copies[index]
          )
      );
    }

    /*
     * 回転は最終角度でbase.pdfへ確定します。図形は回転後の表示座標で
     * 保持しているため、読込み時はそのまま同じ位置に戻ります。
     */
    for (const page of state.pages) {
      const copied =
        copiedPages.get(page.id);

      if (!copied) {
        throw new Error(
          "ページのコピーに失敗しました。"
        );
      }

      copied.setRotation(
        degrees(
          effectivePageRotation(page)
        )
      );

      output.addPage(copied);
    }

    // 残したページ同士のリンクを、出力したページへ付け替えます。
    const linkTargets =
      new Map();

    state.pages.forEach((page, index) => {
      const name =
        placeholders
          .get(page.sourceId)
          ?.get(page.sourceIndex);

      if (name && !linkTargets.has(name)) {
        linkTargets.set(name, output.getPage(index).ref);
      }
    });

    relinkKeptPages(output, linkTargets);

    const basePdf =
      await output.save({
        useObjectStreams: true
      });

    if (
      basePdf.byteLength >
      MAX_TOTAL_FILE_BYTES
    ) {
      throw new Error(
        "ページの合計容量が上限の200MBを超えるため、作業ファイルを保存できません。ページを減らしてください。"
      );
    }

    downloadBlob(
      new Blob(
        storedZipParts([
          { name: "project.json", data: project.json },
          { name: "base.pdf", data: basePdf },
          ...project.images
        ]),
        {
          type: "application/octet-stream"
        }
      ),
      projectFileName(name)
    );

    markDocumentSaved();

    updateStatus(
      "作業ファイルを保存しました。"
    );

    showToast(
      "作業ファイルを保存しました。続きの編集用です。配布には「全体を保存」でPDFを保存してください。"
    );
  } catch (error) {
    console.error(error);

    updateStatus(
      "作業ファイルの保存に失敗しました。"
    );

    showToast(
      error?.message ||
        "作業ファイルの保存に失敗しました。",
      true
    );
  } finally {
    setBusy(false);
  }
}

const isProjectFile = file =>
  /\.abpdf$/i.test(file.name);

// 作業ファイルの上限: base.pdf（合計上限）＋画像（合計上限）＋project.json＋ZIPの管理領域。
const MAX_PROJECT_FILE_BYTES =
  MAX_TOTAL_FILE_BYTES +
  MAX_TOTAL_IMAGE_BYTES +
  MAX_PROJECT_JSON_BYTES +
  4 * 1024 * 1024;

async function decodeProjectImage(entry, data) {
  if (data.byteLength > MAX_IMAGE_BYTES) {
    throw new Error("作業ファイル内の画像が20MBを超えています。");
  }

  const metadata = imageMetadata(data);

  if (metadata.mime !== entry.mime) {
    throw new Error("作業ファイル内の画像を読み込めませんでした。");
  }

  const bytes = data.slice();
  const url = URL.createObjectURL(new Blob([bytes], { type: metadata.mime }));

  try {
    const image = new Image();
    image.src = url;
    await image.decode();

    if (
      image.naturalWidth !== metadata.width ||
      image.naturalHeight !== metadata.height
    ) {
      throw new Error("作業ファイル内の画像を読み込めませんでした。");
    }
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error?.message?.startsWith("作業ファイル")
      ? error
      : new Error("作業ファイル内の画像を読み込めませんでした。");
  }

  return { bytes, mime: metadata.mime, width: metadata.width, height: metadata.height, url };
}

async function openProjectFile(file) {
  if (state.busy) {
    return;
  }

  if (state.pages.length) {
    els.input.value = "";

    showToast(
      "作業ファイルは、開いているPDFを閉じてから開いてください。",
      true
    );

    return;
  }

  if (file.size > MAX_PROJECT_FILE_BYTES) {
    els.input.value = "";

    showToast(
      `${file.name}は作業ファイルの上限を超えているため読み込めません。`,
      true
    );

    return;
  }

  setBusy(
    true,
    "作業ファイルを読み込んでいます…"
  );

  updateStatus(
    "作業ファイルを読み込んでいます。"
  );

  const sourceId = uid();
  const images = [];
  let loadingTask = null;
  let pdfjsDoc = null;

  try {
    const entries =
      readStoredZip(
        new Uint8Array(
          await file.arrayBuffer()
        )
      );

    const manifest =
      readProjectManifest(
        entries.get("project.json"),
        entries
      );

    const basePdf =
      entries.get("base.pdf");

    if (
      basePdf.byteLength >
      MAX_TOTAL_FILE_BYTES
    ) {
      throw new Error(
        "作業ファイル内のPDFが上限の200MBを超えるため読み込めません。"
      );
    }

    let imageBytes = 0;

    for (const entry of manifest.images) {
      imageBytes += entries.get(entry.file).byteLength;

      if (imageBytes > MAX_TOTAL_IMAGE_BYTES) {
        throw new Error("作業ファイル内の画像の合計が100MBを超えています。");
      }

      images.push(
        await decodeProjectImage(
          entry,
          entries.get(entry.file)
        )
      );
    }

    // ZIP全体のバッファーを保持し続けないよう、PDF部分だけを複製します。
    const sourceBytes =
      basePdf.slice();

    loadingTask =
      pdfjsLib.getDocument({
        data: sourceBytes.slice(0),
        ...getPdfJsAuxiliaryOptions()
      });

    try {
      pdfjsDoc =
        await loadingTask.promise;
    } catch (error) {
      if (
        error instanceof PdfCMapError ||
        error?.name === "PdfCMapError"
      ) {
        throw error;
      }

      console.error(
        "PDF.js loading error:",
        error
      );

      throw new Error(
        "作業ファイル内のPDFを開けませんでした。作業ファイルが壊れていないか確認してください。"
      );
    }

    if (
      pdfjsDoc.numPages !==
        manifest.pages.length ||
      pdfjsDoc.numPages >
        MAX_TOTAL_PAGES
    ) {
      throw new Error(
        "作業ファイルのページ情報が一致しません。作業ファイルが壊れていないか確認してください。"
      );
    }

    const pages = [];

    for (
      let pageIndex = 0;
      pageIndex < pdfjsDoc.numPages;
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

      pages.push({
        id: uid(),
        sourceId,
        sourceIndex: pageIndex,
        width: unrotated.width,
        height: unrotated.height,
        baseRotation:
          normRotation(
            pdfPage.rotate || 0
          ),
        rotationExtra: 0,
        annotations: []
      });

      try {
        pdfPage.cleanup?.();
      } catch {
        // 読込み処理を継続します。
      }
    }

    const restored =
      normalizeProjectPages(
        manifest,
        pages.map(pageDisplaySize),
        Object.keys(FONT_STACKS)
      );

    // 注釈と画像のIDは作業ファイルの値を使わず、新しく振り直します。
    const imageIds =
      images.map(() => uid());

    pages.forEach((page, index) => {
      const {
        annotations,
        pageNumber,
        watermark
      } = restored[index];

      page.annotations =
        annotations.map(
          ({ image, ...annotation }) => ({
            id: uid(),
            ...annotation,
            ...(annotation.type === "image"
              ? { imageId: imageIds[image - 1] }
              : {})
          })
        );

      if (pageNumber) {
        page.pageNumber = pageNumber;
      }

      if (watermark) {
        page.watermark = watermark;
      }

      // 表示・保存時と同じ計算で、用紙に収まることを確認します。
      try {
        if (pageNumber) {
          pageNumberAnnotation(page, measurePageNumberText);
        }

        if (watermark) {
          watermarkAnnotation(page, measureWatermarkText);
        }
      } catch (error) {
        throw new Error(
          `${index + 1}ページ目：${error.message}`
        );
      }
    });

    state.sources.set(
      sourceId,
      {
        id: sourceId,
        name: manifest.name,
        bytes: sourceBytes,
        pdfjsDoc
      }
    );

    images.forEach(
      (asset, index) =>
        state.images.set(
          imageIds[index],
          asset
        )
    );

    state.pages = pages;
    state.currentPageId =
      pages[0].id;
    state.history = [];
    state.future = [];
    resetDocumentRevision();

    syncUI();

    // 初回表示の失敗も読込み失敗として、開く前の状態へ戻します。
    await renderThumbnails(null, null, { throwOnError: true });
    await renderCurrentPage({ throwOnError: true });

    syncUI();

    updateStatus(
      `作業ファイルを開きました。全${state.pages.length}ページです。`
    );

    showToast(
      "作業ファイルを開きました。追加した図形・ページ番号・透かしを続けて編集できます。"
    );
  } catch (error) {
    state.sources.delete(sourceId);
    state.pages = [];
    state.currentPageId = null;
    state.selectedAnnotationId = null;
    state.pageSelection.clear();
    state.figureSelection.clear();
    state.history = [];
    state.future = [];
    resetDocumentRevision();

    for (const asset of images) {
      URL.revokeObjectURL(asset.url);
    }

    for (const [id, asset] of [...state.images]) {
      if (images.includes(asset)) {
        state.images.delete(id);
      }
    }

    try {
      if (pdfjsDoc) {
        await pdfjsDoc.destroy();
      } else {
        await loadingTask?.destroy?.();
      }
    } catch {
      // 元のエラーを優先します。
    }

    syncUI();
    await renderThumbnails();
    clearViewer();

    updateStatus(
      "PDFを選択してください。"
    );

    showToast(
      error?.message ||
        "作業ファイルの読み込みに失敗しました。",
      true
    );
  } finally {
    els.input.value = "";
    setBusy(false);
  }
}

/*
 * イベント
 */

els.append.addEventListener(
  "click",
  () => {
    if (!state.busy) {
      els.input.accept = "application/pdf,.pdf";
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

$("selectPdfBtn").addEventListener(
  "click",
  () => {
    if (!state.busy) {
      els.input.accept = initialFileAccept;
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
    if (["ink", "ink-eraser"].includes(state.tool)) {
      beginInkGesture(event);
      return;
    }
    if (
      state.busy ||
      event.button !== 0 ||
      event.isPrimary === false ||
      (state.tool === "select" && event.target.closest(".ann"))
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
      ["rect", "ellipse", "arrow", "line", "redact"].includes(state.tool)
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

$("inkTouchInput").addEventListener("change", event => {
  if (state.busy) return;
  cancelInkGesture();
  state.inkTouch = event.target.checked;
  syncToolProperties();
});

$("inkStabilizationInput").addEventListener("change", event => {
  if (state.busy) return;
  cancelInkGesture();
  state.inkStabilization = ["weak", "medium", "strong"].includes(event.target.value) ? event.target.value : "none";
  syncToolProperties();
});

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

setupSaveMenu();
$("redactionColorInput").addEventListener("change", event => applyRedactionColor(event.target.value));

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
    syncWorkspaceLayout();
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
  if (state.mode !== "edit" || state.busy) closeFigureContextMenu();
  const valid = new Set(state.pages.map((p) => p.id));
  state.pageSelection = new Set([...state.pageSelection].filter((id) => valid.has(id)));
  if (state.mode === "edit" && !state.pageSelection.size && state.currentPageId)
    state.pageSelection.add(state.currentPageId);
  els.editor.dataset.mode = state.mode;
  const count = state.pageSelection.size;
  $("selectionCount").textContent = `${count}ページ選択`;
  syncWorkspaceLayout();
  $("thumbnailSize").disabled = state.busy || !state.pages.length;
  ["selectAllPagesBtn", "backToPagesBtn"].forEach(
    (id) => ($(id).disabled = state.busy || !state.pages.length),
  );
  $("extractBtn").disabled = state.busy || !count;
  els.rotateLeft.disabled = els.rotateRight.disabled = els.deletePage.disabled = state.busy || !count;
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
  if (state.busy || !state.pages.some((page) => page.id === id)) return;
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
    if (state.pageSelection.has(id)) state.pageSelection.delete(id);
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

let pageMarqueeActive = false;
function beginPageMarquee(event) {
  const list = els.thumbs;
  if (event.button !== 0 || event.isPrimary === false || state.busy || state.mode !== "overview" ||
      !state.pages.length || state.dragPageId || pageMarqueeActive ||
      event.target.closest(".thumb-item, button, input, select, label")) return;
  const viewport = list.getBoundingClientRect();
  // Leave the native scrollbar available, including at 200% browser zoom.
  if (event.clientX < viewport.left + list.clientLeft ||
      event.clientX >= viewport.left + list.clientLeft + list.clientWidth ||
      event.clientY < viewport.top + list.clientTop ||
      event.clientY >= viewport.top + list.clientTop + list.clientHeight) return;
  event.preventDefault();
  finishTextEditing();
  list.focus({ preventScroll: true });
  const pages = state.pages, original = new Set(state.pageSelection), originalAnchor = state.selectionAnchor,
    base = event.ctrlKey || event.metaKey || event.shiftKey ? new Set(original) : new Set(),
    start = { x: event.clientX - viewport.left + list.scrollLeft,
      y: event.clientY - viewport.top + list.scrollTop };
  let x = event.clientX, y = event.clientY, dragging = false, frame = 0;
  const box = document.createElement("div");
  box.className = "page-selection-marquee";
  box.setAttribute("aria-hidden", "true");
  box.hidden = true;
  $("pagesPanel").append(box);
  pageMarqueeActive = true;
  list.setPointerCapture(event.pointerId);
  const applySelection = (ids) => {
    if (ids.size === state.pageSelection.size && [...ids].every((id) => state.pageSelection.has(id))) return;
    state.pageSelection = new Set(ids);
    state.selectedAnnotationId = null;
    state.figureSelection.clear();
    syncUI();
  };
  if (!base.size) applySelection(new Set());
  const finish = (cancelled) => {
    cancelAnimationFrame(frame);
    list.removeEventListener("lostpointercapture", lostCapture);
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", end);
    document.removeEventListener("pointercancel", end);
    document.removeEventListener("keydown", key);
    window.removeEventListener("blur", blur);
    pageMarqueeActive = false;
    list.classList.remove("is-selecting");
    box.remove();
    if (list.hasPointerCapture(event.pointerId)) list.releasePointerCapture(event.pointerId);
    if (state.pages === pages && state.mode === "overview" && !state.busy) {
      if (cancelled) applySelection(original);
      else if (!dragging) applySelection(new Set());
      state.selectionAnchor = cancelled ? originalAnchor : [...state.pageSelection].at(-1) || null;
    }
  };
  const update = () => {
    if (state.pages !== pages || state.mode !== "overview" || state.busy) { finish(true); return false; }
    const rect = list.getBoundingClientRect(),
      endX = clamp(x - rect.left, 0, list.clientWidth) + list.scrollLeft,
      endY = clamp(y - rect.top, 0, list.clientHeight) + list.scrollTop,
      left = Math.min(start.x, endX), top = Math.min(start.y, endY),
      right = Math.max(start.x, endX), bottom = Math.max(start.y, endY), ids = new Set(base);
    for (const item of list.querySelectorAll(".thumb-item")) {
      const r = item.getBoundingClientRect(),
        itemLeft = r.left - rect.left + list.scrollLeft,
        itemTop = r.top - rect.top + list.scrollTop;
      if (itemLeft < right && itemLeft + r.width > left && itemTop < bottom && itemTop + r.height > top)
        ids.add(item.dataset.pageId);
    }
    applySelection(ids);
    const host = $("pagesPanel").getBoundingClientRect(),
      visibleLeft = clamp(left - list.scrollLeft, 0, list.clientWidth),
      visibleTop = clamp(top - list.scrollTop, 0, list.clientHeight),
      visibleRight = clamp(right - list.scrollLeft, 0, list.clientWidth),
      visibleBottom = clamp(bottom - list.scrollTop, 0, list.clientHeight);
    Object.assign(box.style, { left: `${rect.left - host.left + visibleLeft}px`,
      top: `${rect.top - host.top + visibleTop}px`, width: `${visibleRight - visibleLeft}px`,
      height: `${visibleBottom - visibleTop}px` });
    box.hidden = false;
    return true;
  };
  const tick = () => {
    const r = list.getBoundingClientRect();
    const speed = y < r.top + 40 ? -12 : y > r.top + list.clientHeight - 40 ? 12 : 0;
    list.scrollTop = clamp(list.scrollTop + speed, 0, Math.max(0, list.scrollHeight - list.clientHeight));
    if (update()) frame = requestAnimationFrame(tick);
  };
  const move = (e) => {
    if (e.pointerId !== event.pointerId) return;
    x = e.clientX; y = e.clientY;
    if (!dragging) {
      if (Math.hypot(x - event.clientX, y - event.clientY) < 6) return;
      dragging = true;
      list.classList.add("is-selecting");
      frame = requestAnimationFrame(tick);
    }
    update();
  };
  const end = (e) => {
    if (e.pointerId !== event.pointerId) return;
    if (e.type === "pointerup" && dragging) {
      x = e.clientX; y = e.clientY;
      if (!update()) return;
    }
    finish(e.type === "pointercancel");
  };
  const key = (e) => { if (e.key === "Escape") { e.preventDefault(); finish(true); } };
  const blur = () => finish(true);
  const lostCapture = (e) => { if (e.pointerId === event.pointerId) finish(true); };
  list.addEventListener("lostpointercapture", lostCapture);
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", end);
  document.addEventListener("pointercancel", end);
  document.addEventListener("keydown", key);
  window.addEventListener("blur", blur);
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
// Loaded files are appended during reading so existing rollback and limits remain intact.
// Move the complete batch only after every file has loaded successfully.
function insertLoadedPages(originalCount, insertionIndex) {
  if (insertionIndex === originalCount) return;
  const added = state.pages.splice(originalCount);
  state.pages.splice(insertionIndex, 0, ...added);
}

let filePageDrag = false, pageDragPoint = null;
function isFilePageDrag(event) {
  return Array.from(event.dataTransfer?.types || []).includes("Files") ||
    Boolean(event.dataTransfer?.files?.length);
}
function pageDropIndex(event) {
  const items = [...els.thumbs.querySelectorAll(".thumb-item")];
  if (!items.length) return state.pages.length;
  // Use current geometry, not the drag event's stale target after scrolling.
  let item = null;
  let nearest = Infinity;
  for (const candidate of items) {
    const r = candidate.getBoundingClientRect();
    const dx = Math.max(r.left - event.clientX, 0, event.clientX - (r.left + r.width));
    const dy = Math.max(r.top - event.clientY, 0, event.clientY - r.bottom);
    const distance = dx * dx + dy * dy;
    if (distance < nearest) { nearest = distance; item = candidate; }
  }
  if (state.dragPageId && state.pageSelection.has(item.dataset.pageId)) return null;
  const index = state.pages.findIndex(page => page.id === item.dataset.pageId);
  if (index < 0) return null;
  const r = item.getBoundingClientRect();
  const after = event.clientY > r.bottom ||
    (event.clientY >= r.top && event.clientX > r.left + r.width / 2);
  return index + Number(after);
}
function showPageInsertion(index) {
  const items = [...els.thumbs.querySelectorAll(".thumb-item")];
  for (const item of items) delete item.dataset.drop;
  if (index == null) return;
  // A shared boundary always belongs to the following page: one bar per position.
  const target = items[index] || items[items.length - 1];
  if (target) target.dataset.drop = index < items.length ? "before" : "after";
}
function handlePageDragOver(event) {
  if (state.busy || state.mode !== "overview" || (!state.dragPageId && !isFilePageDrag(event))) return;
  event.preventDefault();
  event.stopPropagation();
  filePageDrag = !state.dragPageId;
  pageDragPoint = { clientX: event.clientX, clientY: event.clientY };
  const index = pageDropIndex(event);
  showPageInsertion(index);
  event.dataTransfer.dropEffect = index == null ? "none" : filePageDrag ? "copy" : "move";
  updatePageDragScroll(event.clientY);
}
function handlePageDrop(event) {
  if (state.busy || state.mode !== "overview" || (!state.dragPageId && !isFilePageDrag(event))) return;
  event.preventDefault();
  event.stopPropagation();
  const index = pageDropIndex(event);
  const draggedId = state.dragPageId;
  const files = event.dataTransfer?.files;
  clearPageDrag();
  if (index == null) return;
  if (draggedId) {
    const selected = state.pageSelection;
    const next = state.pages.slice(index).find(page => !selected.has(page.id));
    const previous = state.pages.slice(0, index).reverse().find(page => !selected.has(page.id));
    const target = next || previous;
    if (target) reorderPage(draggedId, target.id, !next);
  } else if (files?.length) {
    void readPdfFiles(files, index);
  }
}
let pageScrollFrame = 0,
  pageScrollVelocity = 0;
function updatePageDragScroll(y) {
  const r = els.thumbs.getBoundingClientRect();
  pageScrollVelocity = y < r.top + 55 ? -12 : y > r.bottom - 55 ? 12 : 0;
  if (!pageScrollFrame) {
    const tick = () => {
      if (!state.dragPageId && !filePageDrag) {
        pageScrollFrame = 0;
        return;
      }
      els.thumbs.scrollTop += pageScrollVelocity;
      if (pageDragPoint) showPageInsertion(pageDropIndex(pageDragPoint));
      pageScrollFrame = requestAnimationFrame(tick);
    };
    pageScrollFrame = requestAnimationFrame(tick);
  }
}
function clearPageDrag() {
  filePageDrag = false;
  pageDragPoint = null;
  state.dragPageId = null;
  pageScrollVelocity = 0;
  cancelAnimationFrame(pageScrollFrame);
  pageScrollFrame = 0;
  els.thumbs.querySelectorAll(".thumb-item").forEach((n) => {
    delete n.dataset.drop;
    n.classList.remove("dragging");
  });
}

function syncWorkspaceLayout() {
  const expanded = state.pagesPanelPreference ?? !matchMedia("(max-width: 700px)").matches;
  els.editor.dataset.pagesExpanded = String(expanded);
  els.editor.dataset.thumbnailSize = state.thumbnailSize;
  const button = $("togglePagesBtn");
  const label = expanded ? "ページ一覧を閉じる" : "ページ一覧を表示";
  button.setAttribute("aria-expanded", String(expanded));
  button.setAttribute("aria-label", label);
  button.setAttribute("title", label);
  button.disabled = state.busy || !state.pages.length;
}

function schedulePageLayoutRender() {
  cancelAnimationFrame(resizeRenderFrame);
  resizeRenderFrame = requestAnimationFrame(() => {
    resizeRenderFrame = 0;
    if (!state.busy && state.mode === "edit" && ["fit", "fit-width"].includes(els.zoom.value)) {
      void renderCurrentPage();
    }
  });
}

function togglePagesPanel() {
  if (state.busy || state.mode !== "edit") return;
  finishTextEditing();
  state.pagesPanelPreference = els.editor.dataset.pagesExpanded !== "true";
  syncWorkspaceLayout();
  schedulePageLayoutRender();
}

function setThumbnailSize(size) {
  if (state.busy || state.mode !== "overview" || !["small", "medium", "large"].includes(size)) return;
  if (state.thumbnailSize === size) return;
  const viewport = els.thumbs.getBoundingClientRect();
  const anchor = [...els.thumbs.children].find((item) => {
    const rect = item.getBoundingClientRect();
    return rect.bottom > viewport.top && rect.top < viewport.bottom;
  });
  state.thumbnailSize = size;
  syncWorkspaceLayout();
  // Reuse matching canvases; only the large size needs a higher resolution.
  void renderThumbnails(anchor?.dataset.pageId);
}

function syncFloatingProperties() {
  const selected = selectedFigures(),
    a = selected[0],
    type = a?.type || state.tool;
  const panel = $("formatPanel");
  if (!panel) return;
  panel.dataset.figureType = selected.length > 1 ? "mixed" : type;
  panel.classList.toggle(
    "hidden",
    state.mode !== "edit" ||
      (!selected.length && state.tool === "select" && !state.clipboard.length),
  );
  const labels = {
    image: "画像",
    text: "テキスト",
    rect: "四角",
    redact: "墨消し範囲",
    ellipse: "丸",
    arrow: "矢印",
    line: "線",
    highlight: "マーカー",
    ink: "手書き",
    "ink-eraser": "手書き消しゴム",
    select: "図形",
  };
  $("formatTitle").textContent =
    selected.length > 1 ? `${selected.length}個の図形` : (a?.stamp ? "スタンプ" : labels[type]) + "の設定";
  const mixed = selected.length > 1;
  const allRedactions = selected.length ? selected.every(a => a.type === "redact") : type === "redact";
  $("redactionColorField").hidden = !allRedactions;
  const maskColors = new Set(selected.map(a => a.type === "redact" ? redactionColor(a) : null));
  $("redactionColorInput").value = maskColors.size > 1 ? "" : a?.type === "redact" ? redactionColor(a) : state.redactionColor;
  $("redactionColorInput").disabled = state.busy;
  panel.querySelector(".property-controls").classList.toggle("hidden", mixed || type === "select" || type === "image" || type === "redact");
  $("inkTouchControls").hidden = !["ink", "ink-eraser"].includes(state.tool);
  $("inkTouchInput").checked = state.inkTouch;
  $("inkTouchInput").disabled = state.busy;
  $("inkStabilizationField").hidden = state.tool !== "ink";
  $("inkStabilizationInput").value = state.inkStabilization;
  $("inkStabilizationInput").disabled = state.busy;
  $("colorField").classList.toggle("hidden", type === "ink-eraser");
  const colorLabel =
    type === "text" ? "文字" : ["rect", "ellipse"].includes(type) ? "枠" : "色";
  const colorAriaLabel =
    type === "text" ? "文字の色" : ["rect", "ellipse"].includes(type) ? "枠の色" : "図形の色";
  $("colorFieldLabel").textContent = colorLabel;
  $("colorField").title = colorAriaLabel;
  $("colorInput").setAttribute("aria-label", colorAriaLabel);
  const value = (key, fallback) => a?.[key] ?? fallback;
  $("outlineField").classList.toggle("hidden", !["text", "arrow"].includes(type));
  $("outlineInput").checked = value("outline", state.defaults.outline);
  $("fillField").classList.toggle("hidden", !["rect", "ellipse"].includes(type));
  $("fillNoneField").classList.toggle("hidden", !["rect", "ellipse"].includes(type));
  $("fillInput").value = value("fill", state.defaults.fill);
  $("fillNoneInput").checked = value("fillNone", state.defaults.fillNone);
  $("opacityField").classList.toggle("hidden", type !== "highlight");
  $("opacityInput").value = String(value("opacity", state.markerOpacity));
  for (const id of [
    "outlineInput",
    "fillInput",
    "fillNoneInput",
    "opacityInput",
    "formatDragHandle",
  ])
    $(id).disabled = state.busy;
  $("fillInput").disabled = state.busy || $("fillNoneInput").checked;
  $("pdfTextLayer").classList.toggle("selectable", state.tool === "highlight" && state.textReady);
  els.layer.classList.toggle("marker-active", state.tool === "highlight");
  $("canvasHint").textContent =
    ["ink", "ink-eraser"].includes(state.tool)
      ? `${state.tool === "ink" ? "ドラッグして手書き" : "なぞった手書きを1本ずつ消去"}。指でスクロールするには「選択」へ切替（Esc）`
      : state.tool === "redact"
      ? "ドラッグして墨消し範囲を追加。選択で移動・サイズ変更、Deleteで削除。保存後のPDFで確認してください。"
      : state.tool === "highlight"
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
// Ordinary PDF, image-only PDF and the work file are separate visible choices.
function saveMenuItems() {
  return [...$("saveMenu").querySelectorAll('[role="menuitem"]')].filter(item => !item.disabled);
}
function syncPdfSaveOptions() {
  const guarded = state.pages.some(page => page.annotations?.some(a => a.type === "redact"));
  $("savePdfMenuItem").disabled = state.busy || !state.pages.length || guarded;
  $("savePdfGuardNote").hidden = !guarded;
}
function openSaveMenu(focus = "first") {
  if (state.busy || els.save.disabled) return;
  syncPdfSaveOptions();
  $("saveMenu").hidden = false;
  els.save.setAttribute("aria-expanded", "true");
  const items = saveMenuItems();
  (focus === "last" ? items.at(-1) : items[0])?.focus();
}
function closeSaveMenu({ restoreFocus = false } = {}) {
  if ($("saveMenu").hidden) return;
  $("saveMenu").hidden = true;
  els.save.setAttribute("aria-expanded", "false");
  if (restoreFocus) els.save.focus();
}
function setupSaveMenu() {
  const menu = $("saveMenu");
  els.save.addEventListener("click", () => {
    if (menu.hidden) openSaveMenu();
    else closeSaveMenu({ restoreFocus: true });
  });
  els.save.addEventListener("keydown", event => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    event.stopPropagation();
    openSaveMenu(event.key === "ArrowUp" ? "last" : "first");
  });
  for (const [id, action] of [["savePdfMenuItem", exportPdf],
    ["saveRedactedPdfMenuItem", () => exportPdf(false, true)], ["saveProjectBtn", saveProjectFile]]) {
    $(id).addEventListener("click", () => {
      // Hide the menu and return focus first so no hidden item keeps focus during the save.
      closeSaveMenu({ restoreFocus: true });
      action();
    });
  }
  menu.addEventListener("keydown", event => {
    // Keys pressed in the menu never reach document shortcuts (Escape, Delete, Ctrl+A ...).
    event.stopPropagation();
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "s") {
      // Keep Ctrl／Command+S as the PDF save rather than letting the browser save the page.
      event.preventDefault();
      closeSaveMenu({ restoreFocus: true });
      exportPdf();
      return;
    }
    const items = saveMenuItems(), index = items.indexOf(document.activeElement);
    const move = {
      ArrowDown: () => items[(index + 1) % items.length],
      ArrowUp: () => items[(index - 1 + items.length) % items.length],
      Home: () => items[0],
      End: () => items.at(-1),
    }[event.key];
    if (move) {
      event.preventDefault();
      move()?.focus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeSaveMenu({ restoreFocus: true });
    } else if (event.key === "Tab") {
      // Move focus to the trigger and let the browser continue the normal tab order from there.
      closeSaveMenu({ restoreFocus: true });
    }
  });
  document.addEventListener("pointerdown", event => {
    if (!$("saveMenuGroup").contains(event.target)) closeSaveMenu();
  });
  for (const type of ["resize", "blur"]) window.addEventListener(type, () => closeSaveMenu());
}
let pageNumberMeasureContext = null;
function measurePageNumberText(text, fontSize) {
  const context = pageNumberMeasureContext ||= document.createElement("canvas").getContext("2d");
  if (!context) throw new Error("ページ番号の描画を準備できませんでした。");
  context.font = `400 ${fontSize}px ${fontStackFor("arial")}`;
  return context.measureText(text).width;
}
function resolvedPageNumber(page) {
  return pageNumberAnnotation(page, measurePageNumberText);
}
function pageNumberOverlay(page, annotation) {
  const { width, height } = pageDisplaySize(page);
  const svg = svgNode("svg", {
    viewBox: `0 0 ${width} ${height}`,
    "aria-hidden": "true",
    focusable: "false",
  });
  svg.classList.add("page-number-overlay");
  const text = svgNode("text", {
    x: annotation.x + 4,
    y: annotation.y + 4,
    "font-size": annotation.fontSize,
    "font-family": fontStackFor("arial"),
    "dominant-baseline": "text-before-edge",
    fill: annotation.color,
  });
  text.textContent = annotation.text;
  svg.append(text);
  return svg;
}

let pageNumberPreviewToken = 0;
let pageNumberPreviewTask = null;
function cancelPageNumberPreview() {
  pageNumberPreviewToken++;
  pageNumberPreviewTask?.cancel();
  pageNumberPreviewTask = null;
}
const PAGE_NUMBER_POSITION_LABELS = {
  "top-left": "上・左", "top-center": "上・中央", "top-right": "上・右",
  "bottom-left": "下・左", "bottom-center": "下・中央", "bottom-right": "下・右",
};
function syncPageNumberMarginFields() {
  const custom = $("pageNumberMarginMode").value === "custom";
  $("pageNumberMarginFields").hidden = !custom;
  // Disabled inputs keep their values but are skipped by the browser's form validation.
  $("pageNumberMarginX").disabled = !custom;
  $("pageNumberMarginY").disabled = !custom;
}
function readPageNumberPlan() {
  const custom = $("pageNumberMarginMode").value === "custom";
  return createPageNumberPlan(state.pages, {
    startPage: $("pageNumberStartPage").valueAsNumber,
    startNumber: $("pageNumberStartNumber").valueAsNumber,
    fontSize: $("pageNumberFontSize").valueAsNumber,
    position: $("pageNumberPosition").value,
    layout: $("pageNumberLayout").value || "same",
    format: $("pageNumberFormat").value || "number",
    ...(custom ? { marginX: $("pageNumberMarginX").valueAsNumber, marginY: $("pageNumberMarginY").valueAsNumber } : {}),
  }, measurePageNumberText);
}
function pageNumberPlanSummary(plan) {
  const first = plan.entries[0].annotation.text, last = plan.entries.at(-1).annotation.text;
  const range = plan.count > 1 ? `「${first}」〜「${last}」` : `「${first}」`;
  let summary = `${plan.startPage}〜${state.pages.length}ページに ${range} を追加します（${plan.count}ページ）。`;
  if (plan.layout !== "same") {
    const odd = resolvePageNumberPosition(plan.position, plan.layout, 1);
    const even = resolvePageNumberPosition(plan.position, plan.layout, 2);
    summary += `奇数の番号は${PAGE_NUMBER_POSITION_LABELS[odd]}、偶数の番号は${PAGE_NUMBER_POSITION_LABELS[even]}に入ります。`;
  }
  return summary + (state.pages.some(p => p.pageNumber) ? "追加済みのページ番号は置き換えます。" : "");
}
async function previewPageNumbers() {
  cancelPageNumberPreview();
  const token = pageNumberPreviewToken;
  $("pageNumberApply").disabled = true;
  // Deleting never depends on the inputs, so it stays available while they are invalid.
  $("pageNumberDelete").disabled = !state.pages.some(p => p.pageNumber);
  syncPageNumberMarginFields();
  $("pageNumberError").textContent = "";
  $("pageNumberPreview").replaceChildren();
  $("pageNumberPreviewLabel").textContent = "プレビューを準備しています。";
  let task = null;
  try {
    const plan = readPageNumberPlan();
    const page = state.pages[plan.startPage - 1];
    $("pageNumberSummary").textContent = pageNumberPlanSummary(plan);
    const source = state.sources.get(page.sourceId);
    const pdfPage = await source.pdfjsDoc.getPage(page.sourceIndex + 1);
    if (token !== pageNumberPreviewToken || !$("pageNumberDialog").open) return;
    const rotation = effectivePageRotation(page);
    const size = pdfPage.getViewport({ scale: 1, rotation });
    const viewport = pdfPage.getViewport({
      scale: Math.min(420 / size.width, 420 / size.height), rotation,
    });
    // Each request renders into its own canvas so canceled renders cannot overwrite a newer preview.
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));
    canvas.setAttribute("aria-hidden", "true");
    task = pdfPage.render({ canvasContext: canvas.getContext("2d"), viewport });
    pageNumberPreviewTask = task;
    await task.promise;
    if (token !== pageNumberPreviewToken || !$("pageNumberDialog").open) return;
    $("pageNumberPreview").append(canvas, pageNumberOverlay(page, plan.entries[0].annotation));
    $("pageNumberPreviewLabel").textContent = `${plan.startPage}ページ目の追加予定`;
    $("pageNumberApply").disabled = false;
  } catch (error) {
    if (token !== pageNumberPreviewToken || !$("pageNumberDialog").open) return;
    $("pageNumberSummary").textContent = "";
    $("pageNumberPreviewLabel").textContent = "プレビューを表示できません。";
    $("pageNumberError").textContent = error.message || "プレビューを準備できませんでした。";
  } finally {
    if (pageNumberPreviewTask === task) pageNumberPreviewTask = null;
  }
}
function openPageNumberDialog() {
  if (state.busy || !state.pages.length) return;
  const existingIndex = state.pages.findIndex(page => page.pageNumber);
  const existing = state.pages[existingIndex]?.pageNumber;
  $("pageNumberStartPage").max = state.pages.length;
  $("pageNumberStartPage").value = existingIndex >= 0 ? existingIndex + 1 : 1;
  $("pageNumberStartNumber").value = existing?.number ?? 1;
  $("pageNumberFontSize").value = existing?.fontSize ?? 12;
  $("pageNumberPosition").value = existing?.position ?? "bottom-center";
  $("pageNumberLayout").value = existing?.layout ?? "same";
  $("pageNumberFormat").value = existing?.format ?? "number";
  // Numbers added before explicit margins existed keep the automatic margin when reapplied.
  const custom = existing?.marginX !== undefined;
  $("pageNumberMarginMode").value = custom ? "custom" : "auto";
  $("pageNumberMarginX").value = custom ? existing.marginX : PAGE_NUMBER_MARGIN_MM.initial;
  $("pageNumberMarginY").value = custom ? existing.marginY : PAGE_NUMBER_MARGIN_MM.initial;
  $("pageNumberDialog").showModal();
  previewPageNumbers();
}
function deletePageNumbers() {
  if (state.busy) return;
  const affected = state.pages.filter(page => page.pageNumber);
  if (!affected.length) return;
  pushHistory();
  state.pages = removePageNumbers(state.pages);
  $("pageNumberDialog").close();
  for (const page of affected) updateThumbnailAnnotationMarker(page.id);
  if (state.mode === "edit") renderAnnotations();
  syncUI();
  updateStatus(`${affected.length}ページのページ番号を削除しました。元に戻すで取り消せます。`);
}
function applyPageNumbers(event) {
  event.preventDefault();
  if (state.busy || $("pageNumberApply").disabled) return;
  try {
    // Validate every target before creating the single undo entry or changing pages.
    const plan = readPageNumberPlan();
    pushHistory();
    state.pages = replacePageNumbers(state.pages, plan);
    $("pageNumberDialog").close();
    for (const page of state.pages) updateThumbnailAnnotationMarker(page.id);
    if (state.mode === "edit") renderAnnotations();
    syncUI();
    updateStatus(`${plan.count}ページにページ番号を追加しました。元に戻すで取り消せます。`);
  } catch (error) {
    $("pageNumberError").textContent = error.message;
  }
}
function setupPageNumbering() {
  $("pageNumberBtn").addEventListener("click", openPageNumberDialog);
  $("pageNumberForm").addEventListener("input", previewPageNumbers);
  $("pageNumberForm").addEventListener("submit", applyPageNumbers);
  $("pageNumberCancel").addEventListener("click", () => $("pageNumberDialog").close());
  $("pageNumberDelete").addEventListener("click", deletePageNumbers);
  $("pageNumberDialog").addEventListener("close", () => {
    if (!$("pageNumberDialog").open) cancelPageNumberPreview();
  });
  $("pageNumberDialog").addEventListener("cancel", cancelPageNumberPreview);
  for (const type of ["dragover", "drop"])
    $("pageNumberDialog").addEventListener(type, event => {
      // Do not let a file dropped onto the modal reach the document's PDF-add handler.
      event.preventDefault();
      event.stopPropagation();
    });
}

let watermarkMeasureContext = null;
function measureWatermarkText(text, fontSize) {
  const context = watermarkMeasureContext ||= document.createElement("canvas").getContext("2d");
  if (!context) throw new Error("透かしの描画を準備できませんでした。");
  context.font = `700 ${fontSize}px ${fontStackFor("arial")}`;
  return context.measureText(text).width;
}
// 字形の上下中央が箱の中央へ来るよう、中央から基準線までの距離を返します。
function watermarkBaselineOffset(annotation) {
  const context = watermarkMeasureContext ||= document.createElement("canvas").getContext("2d");
  if (!context) throw new Error("透かしの描画を準備できませんでした。");
  context.font = `700 ${annotation.fontSize}px ${fontStackFor("arial")}`;
  const { actualBoundingBoxAscent: ascent, actualBoundingBoxDescent: descent } = context.measureText(annotation.text);
  return Number.isFinite(ascent) && Number.isFinite(descent)
    ? (ascent - descent) / 2
    : annotation.fontSize * 0.35;
}
function resolvedWatermark(page) {
  return watermarkAnnotation(page, measureWatermarkText);
}
function watermarkOverlay(page, annotation) {
  const { width, height } = pageDisplaySize(page);
  const svg = svgNode("svg", {
    viewBox: `0 0 ${width} ${height}`,
    "aria-hidden": "true",
    focusable: "false",
  });
  svg.classList.add("watermark-overlay");
  const text = svgNode("text", {
    x: width / 2,
    y: height / 2 + watermarkBaselineOffset(annotation),
    "font-size": annotation.fontSize,
    "font-family": fontStackFor("arial"),
    "font-weight": "700",
    "text-anchor": "middle",
    fill: annotation.color,
    opacity: annotation.opacity,
    transform: `rotate(${annotation.rotation} ${width / 2} ${height / 2})`,
  });
  text.textContent = annotation.text;
  svg.append(text);
  return svg;
}
function selectedWatermarkScope() {
  return document.querySelector('input[name="watermarkTarget"]:checked')?.value === "selected"
    ? "selected" : "all";
}
function watermarkTargetPages() {
  const scope = selectedWatermarkScope();
  return scope === "selected"
    ? state.pages.filter(page => state.pageSelection.has(page.id))
    : [...state.pages];
}
function readWatermarkPlan() {
  return createWatermarkPlan(state.pages, state.pageSelection, {
    text: $("watermarkText").value,
    color: $("watermarkColor").value,
    opacity: $("watermarkOpacity").valueAsNumber / 100,
    fontSize: $("watermarkFontSize").valueAsNumber,
    angle: Number($("watermarkAngle").value),
    scope: selectedWatermarkScope(),
  }, measureWatermarkText);
}
let watermarkPreviewToken = 0;
let watermarkPreviewTask = null;
function cancelWatermarkPreview() {
  watermarkPreviewToken++;
  watermarkPreviewTask?.cancel();
  watermarkPreviewTask = null;
}
async function previewWatermarks() {
  cancelWatermarkPreview();
  const token = watermarkPreviewToken;
  $("watermarkApply").disabled = true;
  $("watermarkError").textContent = "";
  $("watermarkPreview").replaceChildren();
  $("watermarkPreviewLabel").textContent = "プレビューを準備しています。";
  $("watermarkOpacityValue").textContent = `${$("watermarkOpacity").value}%`;
  const targets = watermarkTargetPages();
  $("watermarkDelete").disabled = !targets.some(page => page.watermark);
  let task = null;
  try {
    const plan = readWatermarkPlan();
    const entry = plan.entries[0];
    const page = state.pages.find(item => item.id === entry.pageId);
    const scopeLabel = plan.scope === "selected" ? "選択した" : "全";
    const replacing = targets.some(item => item.watermark) ? "既存の透かしは置き換えます。" : "";
    $("watermarkSummary").textContent =
      `${scopeLabel}${plan.count}ページに「${plan.text}」を追加します。${replacing}`;
    const source = state.sources.get(page.sourceId);
    const pdfPage = await source.pdfjsDoc.getPage(page.sourceIndex + 1);
    if (token !== watermarkPreviewToken || !$("watermarkDialog").open) return;
    const rotation = effectivePageRotation(page);
    const size = pdfPage.getViewport({ scale: 1, rotation });
    const viewport = pdfPage.getViewport({
      scale: Math.min(420 / size.width, 420 / size.height), rotation,
    });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));
    canvas.setAttribute("aria-hidden", "true");
    task = pdfPage.render({ canvasContext: canvas.getContext("2d"), viewport });
    watermarkPreviewTask = task;
    await task.promise;
    if (token !== watermarkPreviewToken || !$("watermarkDialog").open) return;
    $("watermarkPreview").append(canvas, watermarkOverlay(page, entry.annotation));
    $("watermarkPreviewLabel").textContent =
      `${state.pages.findIndex(item => item.id === page.id) + 1}ページ目の追加予定`;
    $("watermarkApply").disabled = false;
  } catch (error) {
    if (token !== watermarkPreviewToken || !$("watermarkDialog").open) return;
    $("watermarkSummary").textContent = "";
    $("watermarkPreviewLabel").textContent = "プレビューを表示できません。";
    $("watermarkError").textContent = error.message || "プレビューを準備できませんでした。";
  } finally {
    if (watermarkPreviewTask === task) watermarkPreviewTask = null;
  }
}
function openWatermarkDialog() {
  if (state.busy || !state.pages.length) return;
  const existing = state.pages.find(page => page.watermark)?.watermark;
  const text = existing?.text || WATERMARK_PRESETS[0];
  $("watermarkText").value = text;
  $("watermarkPreset").value = WATERMARK_PRESETS.includes(text) ? text : "custom";
  $("watermarkColor").value = existing?.color || "#6b7280";
  $("watermarkOpacity").value = String(Math.round((existing?.opacity ?? 0.2) * 100));
  $("watermarkFontSize").value = String(existing?.fontSize ?? 72);
  $("watermarkAngle").value = String(existing?.angle ?? -45);
  $("watermarkTargetAll").checked = true;
  $("watermarkTargetSelected").disabled = state.pageSelection.size === 0;
  $("watermarkDelete").disabled = !state.pages.some(page => page.watermark);
  $("watermarkDialog").showModal();
  previewWatermarks();
}
function applyWatermarks(event) {
  event.preventDefault();
  if (state.busy || $("watermarkApply").disabled) return;
  try {
    const plan = readWatermarkPlan();
    pushHistory();
    state.pages = replaceWatermarks(state.pages, plan);
    $("watermarkDialog").close();
    for (const { pageId } of plan.entries) updateThumbnailAnnotationMarker(pageId);
    if (state.mode === "edit") renderAnnotations();
    syncUI();
    updateStatus(`${plan.count}ページに透かしを追加しました。元に戻すで取り消せます。`);
  } catch (error) {
    $("watermarkError").textContent = error.message;
  }
}
function deleteWatermarks() {
  if (state.busy) return;
  const targets = watermarkTargetPages();
  const affected = targets.filter(page => page.watermark);
  if (!affected.length) {
    $("watermarkError").textContent = "対象ページに削除できる透かしがありません。";
    return;
  }
  pushHistory();
  state.pages = removeWatermarks(state.pages, affected.map(page => page.id));
  $("watermarkDialog").close();
  for (const page of affected) updateThumbnailAnnotationMarker(page.id);
  if (state.mode === "edit") renderAnnotations();
  syncUI();
  updateStatus(`${affected.length}ページの透かしを削除しました。元に戻すで取り消せます。`);
}
function setupWatermarking() {
  $("watermarkBtn").addEventListener("click", openWatermarkDialog);
  $("watermarkPreset").addEventListener("change", () => {
    const preset = $("watermarkPreset").value;
    if (preset !== "custom") $("watermarkText").value = preset;
    previewWatermarks();
  });
  $("watermarkText").addEventListener("input", () => {
    const value = $("watermarkText").value;
    $("watermarkPreset").value = WATERMARK_PRESETS.includes(value) ? value : "custom";
  });
  $("watermarkForm").addEventListener("input", event => {
    if (event.target.id !== "watermarkPreset") previewWatermarks();
  });
  $("watermarkForm").addEventListener("submit", applyWatermarks);
  $("watermarkDelete").addEventListener("click", deleteWatermarks);
  $("watermarkCancel").addEventListener("click", () => $("watermarkDialog").close());
  $("watermarkDialog").addEventListener("close", () => {
    if (!$("watermarkDialog").open) cancelWatermarkPreview();
  });
  $("watermarkDialog").addEventListener("cancel", cancelWatermarkPreview);
  for (const type of ["dragover", "drop"])
    $("watermarkDialog").addEventListener(type, event => {
      event.preventDefault();
      event.stopPropagation();
    });
}

const STAMP_PX_PER_PT = 4;
const stampFontStack = () => fontStackFor(DEFAULT_FONT_FAMILY);
let stampMeasureContext = null;
let stampTemplates = [];
let stampTargetPageId = null;
// Bumped when the PDF is closed so a slow template read cannot restore cleared names.
let stampSession = 0;
function measureStampText(text, fontSize) {
  const context = stampMeasureContext ||= document.createElement("canvas").getContext("2d");
  if (!context) throw new Error("スタンプの描画を準備できませんでした。");
  context.font = `700 ${fontSize}px ${stampFontStack()}`;
  return context.measureText(text).width;
}
// The preview and the placed stamp use this same canvas drawing.
function drawStampCanvas(settings, date = new Date()) {
  const lines = expandStampLines(settings.lines, date, settings.dateFormat);
  const layout = layoutStamp(settings, lines, measureStampText);
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(layout.width * STAMP_PX_PER_PT);
  canvas.height = Math.ceil(layout.height * STAMP_PX_PER_PT);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("スタンプの描画を準備できませんでした。");
  context.scale(canvas.width / layout.width, canvas.height / layout.height);
  const half = settings.borderWidth / 2;
  context.beginPath();
  if (settings.shape === "ellipse")
    context.ellipse(layout.width / 2, layout.height / 2, layout.width / 2 - half, layout.height / 2 - half, 0, 0, Math.PI * 2);
  else context.rect(half, half, layout.width - settings.borderWidth, layout.height - settings.borderWidth);
  if (settings.fill === "white") {
    context.fillStyle = "#fff";
    context.fill();
  }
  context.strokeStyle = settings.color;
  context.lineWidth = settings.borderWidth;
  context.stroke();
  context.lineWidth = Math.max(0.5, settings.borderWidth * 0.7);
  for (const line of layout.dividers) {
    context.beginPath();
    context.moveTo(line.x1, line.y);
    context.lineTo(line.x2, line.y);
    context.stroke();
  }
  context.fillStyle = settings.color;
  context.textAlign = "left";
  context.textBaseline = "middle";
  for (const row of layout.rows) {
    context.font = `700 ${row.fontSize}px ${stampFontStack()}`;
    for (const { ch, x } of row.chars) context.fillText(ch, x, row.centerY);
  }
  return { canvas, layout };
}
function readStampSettings() {
  const lines = $("stampText").value.split(/\r?\n/);
  while (lines.length > 1 && !lines.at(-1).trim()) lines.pop();
  return normalizeStampSettings({
    name: $("stampName").value,
    shape: $("stampShape").value,
    widthMm: $("stampWidth").valueAsNumber,
    heightMm: $("stampHeight").valueAsNumber,
    lines,
    dateFormat: $("stampDateFormat").value,
    color: $("stampColor").value,
    borderWidth: Number($("stampBorder").value),
    fill: $("stampFill").value,
    justify: $("stampJustify").checked,
    dividers: $("stampDividers").checked,
  });
}
function readStampSettingsOrNull() {
  try {
    return readStampSettings();
  } catch {
    return null;
  }
}
function selectedStampTemplate() {
  const [group, index] = $("stampTemplate").value.split(":");
  return (group === "template" ? stampTemplates : STAMP_PRESETS)[Number(index)] || STAMP_PRESETS[0];
}
function renderStampTemplateOptions(value = $("stampTemplate").value) {
  const groups = [["標準", "preset", STAMP_PRESETS], ["保存・読み込んだテンプレート", "template", stampTemplates]];
  $("stampTemplate").replaceChildren(...groups.filter(([, , list]) => list.length).map(([label, key, list]) => {
    const group = document.createElement("optgroup");
    group.label = label;
    group.append(...list.map((template, index) => new Option(template.name, `${key}:${index}`)));
    return group;
  }));
  $("stampTemplate").value = value;
  if (!$("stampTemplate").value) $("stampTemplate").value = "preset:0";
}
function applyStampTemplate(template) {
  $("stampName").value = template.name;
  $("stampText").value = template.lines.join("\n");
  $("stampShape").value = template.shape;
  $("stampWidth").value = String(template.widthMm);
  $("stampHeight").value = String(template.heightMm);
  $("stampDateFormat").value = template.dateFormat;
  $("stampColor").value = template.color;
  $("stampBorder").value = String(template.borderWidth);
  $("stampFill").value = template.fill;
  $("stampJustify").checked = template.justify;
  $("stampDividers").checked = template.dividers;
  previewStamp();
}
// Lists what "まとめて保存" will write, so personal templates are not shared unnoticed.
function stampTemplatesToSave(settings) {
  return settings?.name ? mergeStampTemplates(stampTemplates, [settings]) : stampTemplates;
}
function syncStampSaveAll(settings) {
  try {
    const names = stampTemplatesToSave(settings).map(template => template.name);
    $("stampSaveAll").textContent = `まとめて保存（${names.length}件）`;
    $("stampSaveAll").disabled = !settings?.name || names.length < 2;
    $("stampSaveAllNote").textContent = names.length > 1 ? `まとめて保存の対象：${names.join("、")}` : "";
  } catch (error) {
    $("stampSaveAll").disabled = true;
    $("stampSaveAllNote").textContent = error.message;
  }
}
function previewStamp() {
  $("stampError").textContent = "";
  $("stampApply").disabled = true;
  $("stampSave").disabled = true;
  let settings = null;
  try {
    settings = readStampSettings();
    const { canvas } = drawStampCanvas(settings);
    canvas.setAttribute("aria-hidden", "true");
    $("stampPreview").replaceChildren(canvas);
    $("stampApply").disabled = false;
    $("stampSave").disabled = false;
  } catch (error) {
    settings = null;
    $("stampPreview").replaceChildren();
    $("stampError").textContent = error.message || "スタンプを準備できませんでした。";
  }
  syncStampSaveAll(settings);
}
// Closing the PDF also forgets names typed into stamps on shared terminals.
function clearStampSession() {
  stampSession++;
  stampTemplates = [];
  $("stampTemplate").replaceChildren();
  $("stampForm").reset();
  $("stampPreview").replaceChildren();
  $("stampStatus").textContent = "";
  $("stampError").textContent = "";
  $("stampSaveAllNote").textContent = "";
  $("stampSaveSection").open = false;
}
function openStampDialog() {
  if (state.busy || state.mode !== "edit" || !currentPage()) return;
  finishTextEditing();
  stampTargetPageId = currentPage().id;
  const today = new Date();
  for (const option of $("stampDateFormat").options)
    option.textContent = `${option.dataset.label}（${formatStampDate(today, option.value)}）`;
  const initialized = Boolean($("stampTemplate").options.length);
  renderStampTemplateOptions();
  $("stampStatus").textContent = "";
  $("stampDialog").showModal();
  if (initialized) previewStamp();
  else applyStampTemplate(selectedStampTemplate());
}
async function placeStamp(event) {
  event.preventDefault();
  if (state.busy || $("stampApply").disabled) return;
  const page = currentPage();
  let settings;
  try {
    settings = readStampSettings();
  } catch (error) {
    $("stampError").textContent = error.message;
    return;
  }
  if (state.mode !== "edit" || !page || page.id !== stampTargetPageId) {
    $("stampDialog").close();
    return;
  }
  const size = pageDisplaySize(page);
  if (settings.widthMm * MM_TO_PT > size.width + 0.01 || settings.heightMm * MM_TO_PT > size.height + 0.01) {
    $("stampError").textContent = "スタンプがページより大きいため配置できません。幅・高さを小さくしてください。";
    return;
  }
  $("stampDialog").close();
  setBusy(true, "スタンプを作成しています…");
  try {
    const { canvas, layout } = drawStampCanvas(settings);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("スタンプ画像を作成できませんでした。");
    const asset = { bytes: new Uint8Array(await blob.arrayBuffer()), mime: "image/png",
      width: canvas.width, height: canvas.height };
    canvas.width = canvas.height = 0;
    const w = layout.width, h = layout.height;
    addImageAnnotation(page, asset, { x: (size.width - w) / 2, y: (size.height - h) / 2, w, h }, { stamp: true });
    showToast("スタンプを配置しました。ドラッグで移動、右下のハンドルでサイズを変更できます。");
  } catch (error) {
    showToast(error.message || "スタンプを配置できませんでした。", true);
  } finally {
    setBusy(false);
    $("stampBtn").focus();
  }
}
// "このテンプレートを保存" writes only the current stamp; "まとめて保存" writes every listed template.
function saveStampTemplates(all) {
  try {
    const settings = readStampSettings();
    if (!settings.name) throw new Error("テンプレート名を入力してください。");
    // Saving one template must not fail just because the in-memory list is full.
    let templates = null;
    try {
      templates = mergeStampTemplates(stampTemplates, [settings]);
    } catch (error) {
      if (all) throw error;
    }
    const json = serializeStampTemplates(all ? templates : [settings]);
    if (templates) {
      stampTemplates = templates;
      renderStampTemplateOptions(`template:${templates.findIndex(template => template.name === settings.name)}`);
    }
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = all ? "スタンプテンプレート.json"
      : `スタンプ_${settings.name.replace(/[\\/:*?"<>|]/g, "_")}.json`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    syncStampSaveAll(settings);
    $("stampStatus").textContent = all
      ? `${templates.length}件のテンプレートをファイルに保存しました。`
      : `「${settings.name}」をファイルに保存しました。` + (templates
        ? "次回は「テンプレートを読み込む」で使えます。"
        : "一覧は上限の件数に達しているため、一覧には追加していません。");
  } catch (error) {
    $("stampError").textContent = error.message;
  }
}
async function loadStampTemplates() {
  const file = $("stampTemplateInput").files?.[0];
  $("stampTemplateInput").value = "";
  if (!file) return;
  $("stampError").textContent = "";
  const session = stampSession;
  try {
    if (file.size > MAX_STAMP_TEMPLATE_FILE_BYTES)
      throw new Error("テンプレートファイルは200KB以下にしてください。");
    const source = await file.text();
    if (session !== stampSession) return;
    const loaded = parseStampTemplates(source);
    if (!loaded.length) throw new Error("テンプレートファイルにテンプレートがありません。");
    stampTemplates = mergeStampTemplates(stampTemplates, loaded);
    renderStampTemplateOptions(`template:${stampTemplates.findIndex(template => template.name === loaded[0].name)}`);
    applyStampTemplate(selectedStampTemplate());
    $("stampStatus").textContent = `${loaded.length}件のテンプレートを読み込みました。`;
  } catch (error) {
    if (session !== stampSession) return;
    $("stampError").textContent = error.message || "テンプレートファイルを読み込めませんでした。";
  }
}
function setupStamping() {
  $("stampBtn").addEventListener("click", openStampDialog);
  $("stampTemplate").addEventListener("change", () => applyStampTemplate(selectedStampTemplate()));
  $("stampForm").addEventListener("input", event => {
    if (event.target.id === "stampName") syncStampSaveAll(readStampSettingsOrNull());
    else if (event.target.id !== "stampTemplate") previewStamp();
  });
  $("stampForm").addEventListener("submit", placeStamp);
  // Enter in the template name must not place the stamp; IME confirmation still works.
  $("stampName").addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.isComposing) event.preventDefault();
  });
  $("stampLoad").addEventListener("click", () => $("stampTemplateInput").click());
  $("stampTemplateInput").addEventListener("change", loadStampTemplates);
  $("stampSave").addEventListener("click", () => saveStampTemplates(false));
  $("stampSaveAll").addEventListener("click", () => saveStampTemplates(true));
  $("stampCancel").addEventListener("click", () => $("stampDialog").close());
  for (const type of ["dragover", "drop"])
    $("stampDialog").addEventListener(type, event => {
      event.preventDefault();
      event.stopPropagation();
    });
}

function renderFigures() {
  const page = currentPage();
  const redactionOverlays = [];
  els.layer.replaceChildren();
  if (!page) {
    syncToolProperties();
    return;
  }
  const scale = state.viewScale,
    selection = new Set(selectedFigures().map((a) => a.id));
  const watermark = page.watermark ? resolvedWatermark(page) : null;
  if (watermark) els.layer.append(watermarkOverlay(page, watermark));
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
    } else if (a.type === "image") {
      const asset = state.images.get(a.imageId);
      if (!asset) continue;
      el = svgNode("svg", { viewBox: `0 0 ${a.w} ${a.h}`, tabindex: 0, role: "group",
        "aria-label": `${a.stamp ? "スタンプ" : "挿入画像"}（Enterで選択・矢印キーで移動）` });
      el.classList.add("ann", "ann-image");
      el.addEventListener("keydown", event => moveImageByKey(event, a));
      const placement = imagePlacement(a, 0);
      el.append(svgNode("image", { href: asset.url, width: placement.width, height: placement.height,
        preserveAspectRatio: "none", transform: placement.transform }));
    } else if (a.type === "ink") {
      const pad = a.strokeWidth / 2 + 2 / scale;
      el = svgNode("svg", { viewBox: `${b.x - pad} ${b.y - pad} ${Math.max(b.w, 0.01) + pad * 2} ${Math.max(b.h, 0.01) + pad * 2}`,
        role: "group", ...inkAccessibility() });
      el.classList.add("ann", "ann-ink");
      el.addEventListener("keydown", event => moveInkByKey(event, a));
      Object.assign(el.style, { left: `${(b.x - pad) * scale}px`, top: `${(b.y - pad) * scale}px`,
        width: `${(Math.max(b.w, 0.01) + pad * 2) * scale}px`, height: `${(Math.max(b.h, 0.01) + pad * 2) * scale}px` });
      if (a.points.length === 1) el.append(svgNode("circle", { cx: a.points[0].x, cy: a.points[0].y, r: a.strokeWidth / 2, fill: a.color }));
      else el.append(svgNode("path", { d: inkPath(a.points), fill: "none", stroke: a.color,
        "stroke-width": a.strokeWidth, "stroke-linecap": "round", "stroke-linejoin": "round" }));
    } else if (a.type === "redact") {
      el = document.createElement("div");
      el.className = "ann ann-redact";
      el.dataset.redactionColor = redactionColor(a) === "#ffffff" ? "white" : "black";
      redactionOverlays.push(el);
      el.setAttribute("role", "group");
      el.setAttribute("tabindex", "0");
      el.setAttribute("aria-label", `${redactionColor(a) === "#ffffff" ? "白" : "黒"}の墨消し範囲（Enterで選択・矢印キーで移動）`);
      el.addEventListener("keydown", event => moveInkByKey(event, a));
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
    if (!isLine(a) && a.type !== "ink") {
      let box = b;
      if (a.type === "text") {
        const placement = imagePlacement(a, 0), rotation = placement.rotation;
        el.dataset.rotation = String(rotation);
        box = { x: b.x + ([90, 180].includes(rotation) ? b.w : 0),
          y: b.y + ([180, 270].includes(rotation) ? b.h : 0),
          w: placement.width, h: placement.height };
      }
      Object.assign(el.style, {
        left: `${box.x * scale}px`,
        top: `${box.y * scale}px`,
        width: `${box.w * scale}px`,
        height: `${box.h * scale}px`,
      });
    }
    el.dataset.annId = a.id;
    if (selection.has(a.id)) {
      el.classList.add("selected");
      if (state.tool === "select" && selection.size === 1 && !["highlight", "ink"].includes(a.type)) {
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
          let handle = document.createElement("span");
          handle.className = "resize-handle";
          if (a.type === "image") {
            handle = svgNode("rect", { x: Math.max(0, a.w - 10 / scale), y: Math.max(0, a.h - 10 / scale),
              width: 10 / scale, height: 10 / scale, tabindex: 0, role: "button",
              "aria-label": `${a.stamp ? "スタンプ" : "画像"}のサイズ変更（矢印キー）` });
            handle.classList.add("image-resize-handle");
            handle.addEventListener("keydown", event => resizeImageByKey(event, a));
          }
          handle.addEventListener("pointerdown", (e) => beginResize(e, a.id));
          el.append(handle);
        }
      }
    }
    el.addEventListener("pointerdown", (e) => beginMove(e, a.id));
    el.addEventListener("contextmenu", (event) => {
      if (event.target.isContentEditable) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = el.getBoundingClientRect();
      openFigureContextMenu(
        event.clientX || rect.left + Math.min(24, rect.width / 2),
        event.clientY || rect.top + Math.min(24, rect.height / 2),
        a.id,
      );
    });
    els.layer.append(el);
  }
  const number = resolvedPageNumber(page);
  if (number) els.layer.append(pageNumberOverlay(page, number));
  // Masks always cover ordinary edits in both preview and output, regardless of figure order.
  redactionOverlays.forEach(mask => els.layer.append(mask));
  syncToolProperties();
}
function inkAccessibility() {
  const selectable = state.mode === "edit" && state.tool === "select" && !state.busy;
  return { tabindex: selectable ? 0 : -1, "aria-label": "手書き" };
}
function syncInkAccessibility() {
  // Busy transitions must refresh keyboard access without replacing focused nodes.
  const strokes = els.layer.querySelectorAll(".ann-ink");
  strokes.forEach(el => {
    for (const [key, value] of Object.entries(inkAccessibility()))
      el.setAttribute(key, String(value));
  });
}
function moveInkByKey(event, a) {
  if (state.busy || state.mode !== "edit" || state.tool !== "select") return;
  const step = event.shiftKey ? 10 : 1,
    delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
  if (event.key !== "Enter" && !delta) return;
  event.preventDefault(); event.stopPropagation();
  state.figureSelection = new Set([a.id]); state.selectedAnnotationId = a.id;
  if (delta) {
    const b = bounds(a), size = pageDisplaySize(currentPage()),
      dx = clamp(delta[0], -b.x, size.width - b.x - b.w), dy = clamp(delta[1], -b.y, size.height - b.y - b.h);
    if (dx || dy) { pushHistory(); translate(a, dx, dy); updateThumbnailAnnotationMarker(currentPage().id); }
  }
  renderAnnotations();
  els.layer.querySelector(`[data-ann-id="${CSS.escape(a.id)}"]`)?.focus();
}
let lastFigurePress = null;
const FIGURE_LONG_PRESS_MS = 550;
const FIGURE_LONG_PRESS_MOVE_PX = 10;

function beginFigureMove(event, id) {
  if (
    state.busy ||
    state.tool !== "select" ||
    event.button !== 0 ||
    event.target.closest(".resize-handle,.endpoint-handle,.image-resize-handle") ||
    event.target.isContentEditable
  )
    return;
  event.preventDefault();
  event.stopPropagation();
  closeFigureContextMenu();
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

  const touchLike = event.pointerType === "touch" || event.pointerType === "pen";
  const pressX = event.clientX, pressY = event.clientY;
  let contextOpened = false;
  let longPressTimer = touchLike
    ? setTimeout(() => {
        longPressTimer = null;
        contextOpened = true;
        openFigureContextMenu(pressX, pressY, id);
      }, FIGURE_LONG_PRESS_MS)
    : null;
  const cancelLongPress = () => {
    if (longPressTimer !== null) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  };

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
  const isChanged = () => JSON.stringify(items) !== JSON.stringify(originals);
  const endPendingEdit = trackUnsavedEdit(isChanged);
  trackPointer(
    event,
    (e) => {
      if (contextOpened) return;
      if (touchLike && longPressTimer !== null) {
        const distance = Math.hypot(e.clientX - pressX, e.clientY - pressY);
        if (distance <= FIGURE_LONG_PRESS_MOVE_PX) return;
        cancelLongPress();
      }
      const point = pagePointFromEvent(e),
        dx = clamp(point.x - start.x, -left, Math.max(-left, size.width - right)),
        dy = clamp(point.y - start.y, -top, Math.max(-top, size.height - bottom));
      items.forEach((a, i) => Object.assign(a, translate(clone(originals[i]), dx, dy)));
      renderAnnotations();
    },
    (cancelled) => {
      endPendingEdit();
      cancelLongPress();
      if (contextOpened) return;
      if (cancelled) items.forEach((a, i) => Object.assign(a, originals[i]));
      else if (isChanged()) pushHistory(before);
      renderAnnotations();
      updateThumbnailAnnotationMarker(currentPage().id);
    },
  );
}
function trackPointer(event, move, finish, { cancelOnLostCapture = false } = {}) {
  const id = event.pointerId;
  let ended = false;
  const onMove = (e) => {
    if (e.pointerId === id) move(e);
  };
  const end = (e) => {
    if (ended || (e.type !== "blur" && e.pointerId !== id)) return;
    ended = true;
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", end);
    document.removeEventListener("pointercancel", end);
    if (cancelOnLostCapture) document.removeEventListener("lostpointercapture", end, true);
    window.removeEventListener("blur", end);
    finish(e.type !== "pointerup");
  };
  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", end);
  document.addEventListener("pointercancel", end);
  if (cancelOnLostCapture) document.addEventListener("lostpointercapture", end, true);
  window.addEventListener("blur", end);
}
function resizeEndpoint(event, a, end) {
  if (state.busy || state.tool !== "select") return;
  event.preventDefault();
  event.stopPropagation();
  const before = snapshot(),
    original = clone(a),
    size = pageDisplaySize(currentPage());
  const endPendingEdit = trackUnsavedEdit(() => JSON.stringify(a) !== JSON.stringify(original));
  trackPointer(
    event,
    (e) => {
      const anchorEnd = end === 1 ? 2 : 1,
        anchor = {
          x: original[`x${anchorEnd}`],
          y: original[`y${anchorEnd}`],
        },
        originalPoint = {
          x: original[`x${end}`],
          y: original[`y${end}`],
        },
        point = pagePointFromEvent(e),
        p = e.shiftKey
          ? angleLockedLinePoint(anchor, originalPoint, point, size)
          : constrainedLinePoint(anchor, point, e.ctrlKey);
      a[`x${end}`] = p.x;
      a[`y${end}`] = p.y;
      renderAnnotations();
    },
    (cancel) => {
      endPendingEdit();
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
  const touchLike = event.pointerType === "touch" || event.pointerType === "pen";
  const pageId = state.currentPageId;
  let contextOpened = false;
  let longPressTimer = touchLike && state.clipboard.length
    ? setTimeout(() => {
        longPressTimer = null;
        if (state.currentPageId !== pageId) return;
        contextOpened = openFigureContextMenu(event.clientX, event.clientY);
        if (contextOpened) box.remove();
      }, FIGURE_LONG_PRESS_MS)
    : null;
  const cancelLongPress = () => {
    if (longPressTimer !== null) clearTimeout(longPressTimer);
    longPressTimer = null;
  };
  trackPointer(
    event,
    (e) => {
      if (contextOpened) return;
      if (Math.hypot(e.clientX - event.clientX, e.clientY - event.clientY) > FIGURE_LONG_PRESS_MOVE_PX)
        cancelLongPress();
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
      cancelLongPress();
      box.remove();
      if (contextOpened) return;
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
  releaseUnusedImages();
  showToast(`${items.length}個の図形をコピーしました。別のページにも貼り付けできます。`);
  syncToolProperties();
}
function pasteFigures() {
  if (state.busy || !state.clipboard.length || !currentPage()) return;
  finishTextEditing();
  const items = clone(state.clipboard),
    size = pageDisplaySize(currentPage()),
    boxes = items.map(bounds);
  if (documentInkPointCount(state.pages) + documentInkPointCount([{ annotations: items }]) > MAX_DOCUMENT_INK_POINTS) {
    showToast("手書きデータの上限を超えるため貼り付けできません。不要なストロークを削除してください。", true);
    return;
  }
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
let figureContextTargetId = null;
function syncFigureOrderControls() {
  const annotations = currentPage()?.annotations.filter(a => a.type !== "redact") || [],
    selected = selectedFigures(),
    ids = new Set(selected.map((a) => a.id)),
    inactive = state.busy || state.mode !== "edit" || !selected.length || selected.some(a => a.type === "redact"),
    atFront = !annotations.slice(-selected.length).some((a) => !ids.has(a.id)),
    atBack = !annotations.slice(0, selected.length).some((a) => !ids.has(a.id));
  for (const id of ["bringFiguresFrontBtn", "figureContextFrontBtn"])
    $(id).disabled = inactive || atFront;
  for (const id of ["sendFiguresBackBtn", "figureContextBackBtn"])
    $(id).disabled = inactive || atBack;
}
function closeFigureContextMenu({ restoreFocus = false } = {}) {
  const menu = $("figureContextMenu");
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  if (restoreFocus && figureContextTargetId) {
    els.layer.querySelector(`[data-ann-id="${CSS.escape(figureContextTargetId)}"]`)?.focus?.({ preventScroll: true });
  }
  figureContextTargetId = null;
}
function selectFigureForContextMenu(id) {
  if (!currentPage()?.annotations.some((annotation) => annotation.id === id)) return false;
  finishTextEditing();
  if (!state.figureSelection.has(id)) {
    state.figureSelection = new Set([id]);
    state.selectedAnnotationId = id;
    renderAnnotations();
  } else {
    state.selectedAnnotationId = id;
    syncToolProperties();
  }
  return true;
}
function openFigureContextMenu(clientX, clientY, id) {
  if (state.busy || state.mode !== "edit" || !currentPage()) return false;
  if (id != null) {
    if (!selectFigureForContextMenu(id)) return false;
  } else {
    if (!state.clipboard.length) return false;
    finishTextEditing();
    state.figureSelection.clear();
    state.selectedAnnotationId = null;
    renderAnnotations();
  }
  const menu = $("figureContextMenu");
  figureContextTargetId = id ?? null;
  $("figureContextCopyBtn").disabled = !selectedFigures().length;
  $("figureContextPasteBtn").disabled = !state.clipboard.length;
  $("figureContextDeleteBtn").disabled = !selectedFigures().length;
  syncFigureOrderControls();
  menu.hidden = false;
  menu.style.left = "0px";
  menu.style.top = "0px";
  const rect = menu.getBoundingClientRect(),
    margin = 8,
    maxLeft = Math.max(margin, window.innerWidth - rect.width - margin),
    maxTop = Math.max(margin, window.innerHeight - rect.height - margin);
  menu.style.left = `${clamp(clientX, margin, maxLeft)}px`;
  menu.style.top = `${clamp(clientY, margin, maxTop)}px`;
  [...menu.querySelectorAll("button")].find((button) => !button.disabled)?.focus({ preventScroll: true });
  return true;
}
function setupFigureContextMenu() {
  const menu = $("figureContextMenu");
  for (const [buttonId, menuId, position] of [
    ["bringFiguresFrontBtn", "figureContextFrontBtn", "front"],
    ["sendFiguresBackBtn", "figureContextBackBtn", "back"],
  ]) {
    const move = () => {
      closeFigureContextMenu();
      moveSelectedFigures(position);
    };
    $(buttonId).addEventListener("click", move);
    $(menuId).addEventListener("click", move);
  }
  els.layer.addEventListener("contextmenu", (event) => {
    if (event.target.closest(".ann") || event.target.isContentEditable) return;
    if (openFigureContextMenu(event.clientX, event.clientY)) event.preventDefault();
  });
  $("figureContextCopyBtn").addEventListener("click", () => {
    closeFigureContextMenu();
    copyFiguresFromMenu();
  });
  $("figureContextPasteBtn").addEventListener("click", () => {
    closeFigureContextMenu();
    pasteFigures();
  });
  $("figureContextDeleteBtn").addEventListener("click", () => {
    closeFigureContextMenu();
    deleteSelectedAnnotation();
  });
  document.addEventListener("pointerdown", (event) => {
    if (!menu.hidden && !menu.contains(event.target)) closeFigureContextMenu();
  });
  menu.addEventListener("keydown", (event) => {
    const items = [...menu.querySelectorAll("button")].filter((item) => !item.disabled);
    if (!items.length) return;
    const current = items.indexOf(document.activeElement);
    let next = null;
    if (event.key === "ArrowDown") next = items[(current + 1 + items.length) % items.length];
    if (event.key === "ArrowUp") next = items[(current - 1 + items.length) % items.length];
    if (event.key === "Home") next = items[0];
    if (event.key === "End") next = items.at(-1);
    if (!next) return;
    event.preventDefault();
    next.focus({ preventScroll: true });
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !menu.hidden) {
      event.preventDefault();
      closeFigureContextMenu({ restoreFocus: true });
    }
  });
  document.addEventListener("scroll", (event) => {
    if (!menu.contains(event.target)) closeFigureContextMenu();
  }, true);
  window.addEventListener("resize", () => closeFigureContextMenu());
  window.addEventListener("blur", () => closeFigureContextMenu());
}

function setupWorkspace() {
  setupFigureContextMenu();
  $("togglePagesBtn").addEventListener("click", togglePagesPanel);
  $("thumbnailSize").addEventListener("change", () => setThumbnailSize($("thumbnailSize").value));
  els.thumbs.addEventListener("dragover", handlePageDragOver);
  els.thumbs.addEventListener("drop", handlePageDrop);
  els.thumbs.addEventListener("dragleave", (e) => {
    if (!els.thumbs.contains(e.relatedTarget)) {
      filePageDrag = false;
      pageDragPoint = null;
      pageScrollVelocity = 0;
      showPageInsertion(null);
    }
  });
  document.addEventListener("dragend", clearPageDrag);
  document.addEventListener("drop", clearPageDrag);
  window.addEventListener("blur", clearPageDrag);
  els.thumbs.addEventListener("pointerdown", beginPageMarquee);
  $("backToPagesBtn").addEventListener("click", showPageOverview);
  setupPageNumbering();
  setupWatermarking();
  setupStamping();
  $("extractBtn").addEventListener("click", () => exportPdf(true));
  $("selectAllPagesBtn").addEventListener("click", () => {
    if (!state.busy) {
      state.pageSelection = new Set(state.pages.map((p) => p.id));
      syncUI();
    }
  });
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
  };
  let panelPointerActive = false;
  panel.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.isPrimary === false || state.busy || panelPointerActive) return;
    // Labels and their contents belong to the setting, including disabled buttons.
    const control = e.target.closest(
      "button, input, select, textarea, label, a, [role='button'], [role='listbox'], [contenteditable], .font-picker-field",
    );
    if (control && control !== handle) return;
    e.preventDefault();
    if (control === handle) handle.focus({ preventScroll: true });
    const area = panel.parentElement.getBoundingClientRect(),
      start = panel.getBoundingClientRect(),
      original = panel.dataset.corner;
    let corner = original,
      dragging = false,
      dx = 0,
      dy = 0;
    panelPointerActive = true;
    panel.setPointerCapture(e.pointerId);
    trackPointer(
      e,
      (m) => {
        if (!dragging) {
          if (Math.hypot(m.clientX - e.clientX, m.clientY - e.clientY) < 6) return;
          dragging = true;
          closeFontMenu();
          panel.classList.add("is-dragging");
        }
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
        panelPointerActive = false;
        if (panel.hasPointerCapture(e.pointerId)) panel.releasePointerCapture(e.pointerId);
        if (!dragging) return;
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
      { cancelOnLostCapture: true },
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
    }
    if (e.key === "Escape" && state.mode === "edit") {
      setTool("select");
    }
    if (e.key === "Delete" && !e.repeat && state.mode === "overview" && e.target.closest("#thumbList")) {
      e.preventDefault();
      deleteCurrentPage();
    }
  });
}

function releaseUnusedImages() {
  const referenced = referencedImageIds(state.pages, state.history, state.future, state.clipboard);
  for (const [id, asset] of state.images) if (!referenced.has(id)) {
    URL.revokeObjectURL(asset.url);
    state.images.delete(id);
  }
}

async function decodeInsertionImage(file) {
  if (!file.size || file.size > MAX_IMAGE_BYTES) throw new Error("画像は1ファイル20MB以下にしてください。");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const metadata = imageMetadata(bytes);
  const url = URL.createObjectURL(new Blob([bytes], { type: metadata.mime }));
  const canvas = document.createElement("canvas");
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    checkImageSize(image.naturalWidth, image.naturalHeight);
    // Bake EXIF orientation into pixels and remove metadata. Preserve PNG alpha.
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("画像の読込みを準備できませんでした。");
    context.drawImage(image, 0, 0);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, metadata.mime, .92));
    if (!blob || blob.size > MAX_IMAGE_BYTES) throw new Error("変換後の画像が20MBを超えています。画像を小さくしてください。");
    return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: blob.type,
      width: canvas.width, height: canvas.height };
  } finally {
    URL.revokeObjectURL(url);
    canvas.width = canvas.height = 0;
  }
}

async function insertImage(file, targetPageId) {
  const page = currentPage();
  if (state.busy || state.mode !== "edit" || !page || page.id !== targetPageId) return;
  finishTextEditing();
  setBusy(true, "画像を読み込んでいます…");
  try {
    const asset = await decodeInsertionImage(file);
    addImageAnnotation(page, asset, initialImageBox(asset.width, asset.height, pageDisplaySize(page)));
    showToast("画像を挿入しました。右下のハンドルで比率を保ってサイズを変更できます。");
  } catch (error) {
    showToast(error.message || "画像を読み込めませんでした。PNG・JPEG画像を確認してください。", true);
  } finally {
    setBusy(false);
    $("imageInput").value = "";
    $("insertImageBtn").focus();
  }
}

function addImageAnnotation(page, asset, box, extra = {}) {
  releaseUnusedImages();
  const total = [...state.images.values()].reduce((sum, image) => sum + image.bytes.byteLength, 0);
  if (total + asset.bytes.byteLength > MAX_TOTAL_IMAGE_BYTES)
    throw new Error("画像の合計容量（Undo・Redo履歴を含む）が100MBを超えています。");
  const imageId = uid(), id = uid();
  const annotation = { id, type: "image", imageId, rotation: 0, ...extra, ...box };
  const url = URL.createObjectURL(new Blob([asset.bytes], { type: asset.mime }));
  // Register references before history cleanup can release the new asset.
  const before = snapshot();
  state.images.set(imageId, { ...asset, url });
  page.annotations.push(annotation);
  pushHistory(before);
  state.tool = "select";
  els.layer.classList.remove("tool-text", "tool-rect", "tool-arrow", "tool-ellipse", "tool-line", "tool-highlight");
  state.figureSelection = new Set([id]);
  state.selectedAnnotationId = id;
  syncToolButtons(); renderAnnotations(); updateThumbnailAnnotationMarker(page.id);
}

function moveImageByKey(event, annotation) {
  if (state.busy || !["Enter", " ", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
  event.preventDefault(); event.stopPropagation();
  if (state.tool !== "select") setTool("select");
  state.figureSelection = new Set([annotation.id]); state.selectedAnnotationId = annotation.id;
  const size = pageDisplaySize(currentPage()), step = event.shiftKey ? 10 : 1;
  const dx = event.key === "ArrowRight" ? Math.min(step, size.width - annotation.x - annotation.w)
    : event.key === "ArrowLeft" ? -Math.min(step, annotation.x) : 0;
  const dy = event.key === "ArrowDown" ? Math.min(step, size.height - annotation.y - annotation.h)
    : event.key === "ArrowUp" ? -Math.min(step, annotation.y) : 0;
  if (dx || dy) { pushHistory(); translate(annotation, dx, dy); }
  renderAnnotations(); updateThumbnailAnnotationMarker(currentPage().id);
  els.layer.querySelector(`[data-ann-id="${CSS.escape(annotation.id)}"]`)?.focus();
}

function resizeImageByKey(event, annotation) {
  if (state.busy || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
  event.preventDefault(); event.stopPropagation();
  const change = ["ArrowRight", "ArrowDown"].includes(event.key) ? 5 : -5;
  const resized = resizeBox(annotation, change, change, pageDisplaySize(currentPage()), true);
  if (resized.w === annotation.w && resized.h === annotation.h) return;
  pushHistory(); Object.assign(annotation, resized);
  renderAnnotations(); updateThumbnailAnnotationMarker(currentPage().id);
  els.layer.querySelector(".image-resize-handle")?.focus();
}

function handleInitialPdfPaste(event) {
  if (state.busy || state.pages.length || isTextEditingTarget(event.target)) return;
  const files = clipboardFiles(event.clipboardData);
  if (!files.length) return;
  event.preventDefault();
  readPdfFiles(files);
}

let nativeFigureCopyHandled = false;
function handleFigureCopy(event) {
  if (state.busy || state.mode !== "edit" || isTextEditingTarget(event.target) ||
      !selectedFigures().length || !event.clipboardData) return;
  event.preventDefault();
  // Replace a stale system image without putting figure or PDF data on the OS clipboard.
  event.clipboardData.setData("text/plain", "AppBox: コピーした図形（このアプリ内のみ）");
  copyFigures();
  nativeFigureCopyHandled = true;
}

function copyFiguresFromMenu() {
  if (state.busy || !selectedFigures().length) return;
  nativeFigureCopyHandled = false;
  try {
    // A user-initiated copy command also works on the app's HTTP deployments.
    // The copy handler writes only a marker and keeps figure data inside the app.
    document.execCommand("copy");
  } catch {
    // Unsupported/blocked clipboard commands must not report a successful copy.
  }
  if (!nativeFigureCopyHandled)
    showToast("この環境ではメニューからコピーできません。図形を選択してCtrl＋Cを押してください。", true);
}

function handleEditorPaste(event) {
  if (state.busy || state.mode !== "edit" || !currentPage() || isTextEditingTarget(event.target)) return;
  const files = clipboardFiles(event.clipboardData);
  if (files.length) {
    event.preventDefault();
    if (files.length !== 1) {
      showToast("画像は1枚ずつ貼り付けてください。", true);
      return;
    }
    // System clipboard images take priority over the app's figure clipboard.
    // insertImage checks the actual format, decoded dimensions and memory limits.
    insertImage(files[0], currentPage().id);
  } else if (state.clipboard.length) {
    event.preventDefault();
    pasteFigures();
  }
}

let imageTargetPageId = null;
$("insertImageBtn").addEventListener("click", () => {
  if (state.busy || state.mode !== "edit" || !currentPage()) return;
  imageTargetPageId = currentPage().id;
  $("imageInput").click();
});
$("imageInput").addEventListener("change", () => {
  const file = $("imageInput").files?.[0];
  $("imageInput").value = "";
  if (file) insertImage(file, imageTargetPageId);
});
document.addEventListener("paste", handleInitialPdfPaste);
document.addEventListener("paste", handleEditorPaste);
document.addEventListener("copy", handleFigureCopy);
window.addEventListener("beforeunload", handleBeforeUnload);

setupWorkspace();

syncUI();
state.tool = "select";
syncToolButtons();
syncToolProperties();
clearViewer();
updateStatus("PDFを選択してください。");
