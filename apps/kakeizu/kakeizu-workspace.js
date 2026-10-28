'use strict';

// モードはUIだけを変更する。モデルの正規化・保存・履歴更新は行わない。
const WORKSPACE_MODES = Object.freeze({
  drawing: {
    description: "簡易モード: 氏名・性別・続柄を中心に編集します。",
    panels: []
  },
  consultation: {
    description: "詳細モード: 相続相談向けの住所・相続・業務情報も編集します。",
    panels: ["personDetails"]
  }
});
let uiMode = "drawing";
if (typeof window !== "undefined") window.uiMode = uiMode;
let personToolActive = false;
let propertySelectionKey = "";
let selectionPanelDismissed = false;

function setUiMode(mode) {
  const definition = WORKSPACE_MODES[mode];
  if (!definition) return;
  uiMode = mode;
  if (typeof window !== "undefined") window.uiMode = mode;
  document.querySelectorAll("[data-ui-mode]").forEach(button => {
    button.setAttribute("aria-pressed", String(button.dataset.uiMode === mode));
  });
  document.querySelectorAll("[data-ui-panel]").forEach(panel => {
    panel.hidden = !definition.panels.includes(panel.dataset.uiPanel);
  });
  document.getElementById("uiModeDescription").textContent = definition.description;
  if (typeof renderChart === "function") renderChart({ preserveSnapshot: true });
  if (typeof refreshPlacementPreview === "function") refreshPlacementPreview();
}

function closeToolMenus() {
  document.querySelectorAll(".tool-menu[open]").forEach(menu => { menu.open = false; });
  document.querySelectorAll(".color-picker-menu[open]").forEach(menu => { menu.open = false; });
}

function updateCanvasToolStatus() {
  if (personToolActive || relationMode || annotationTool) dismissCanvasHint();
  if (personToolActive) selectionPanelDismissed = true;
  updateSelectionProperties();
  document.getElementById("addPersonTool").setAttribute("aria-pressed", String(personToolActive));
  svg.classList.toggle("person-add-mode", personToolActive);
  refreshPlacementPreview();
  updateCanvasModeBanner();
}

function updateViewportControls() {
  const undoButton = document.getElementById("undoButton");
  const redoButton = document.getElementById("redoButton");
  const zoomLevel = document.getElementById("zoomLevel");
  if (undoButton) undoButton.disabled = undoStack.length === 0;
  if (redoButton) redoButton.disabled = redoStack.length === 0;
  if (zoomLevel) zoomLevel.textContent = `${Math.round(scale * 100)}%`;
}

function cancelCanvasTool() {
  clearCanvasFeedback();
  personToolActive = false;
  if (relationMode) cancelRelationMode();
  if (annotationTool || annotationCreating) cancelAnnotationTool();
  updateCanvasToolStatus();
}

function startPersonTool() {
  if (!commitPropertyFieldBeforeCanvasAction()) return;
  finishAnnotationTextEdit(true);
  if (annotationTextEdit) return;
  const toggleOff = personToolActive;
  cancelCanvasTool();
  personToolActive = !toggleOff;
  suppressNextSvgClick = false;
  closeToolMenus();
  updateCanvasToolStatus();
  svg.focus({ preventScroll: true });
}

// 選択や図のデータは保ち、作図・移動・メニュー操作では詳細だけを閉じる。
function setSelectionPanelVisible(visible) {
  selectionPanelDismissed = !visible;
  updateSelectionProperties();
}

function updateSelectionProperties(force = false) {
  const personIds = [...selectedIds].filter(id => person(id));
  const items = getSelectedAnnotations();
  const relation = typeof selectedRelation === "undefined" ? null : selectedRelation;
  const p = person(selectedId);
  const hasSelection = !!(relation || p || personIds.length || items.length);
  const visible = hasSelection && !personToolActive && !selectionPanelDismissed;
  const sidebar = document.getElementById("selectionSidebar");
  if (sidebar) {
    const restoreFocus = !visible && sidebar.contains?.(document.activeElement);
    if (!visible && !sidebar.hidden) closeSelectionMenus();
    sidebar.hidden = !visible;
    if (restoreFocus) svg.focus({ preventScroll: true });
  }
  const relationProperties = document.getElementById("relationProperties");
  if (relationProperties) relationProperties.hidden = !relation;
  if (hasSelection) dismissCanvasHint();
  const key = JSON.stringify([selectedId, personIds, selectedAnnotationId, uiMode,
    items.map(item => {
      const display = getAnnotationDisplayItem(item);
      return [item.id, display.width, display.height];
    }), typeof selectedRelation === "undefined" ? null : selectedRelation]);
  if (!force && key === propertySelectionKey) return;
  propertySelectionKey = key;
  if (typeof selectedRelation !== "undefined" && selectedRelation) {
    document.getElementById("personProperties").hidden = true;
    document.getElementById("annotationProperties").hidden = true;
    document.getElementById("multipleProperties").hidden = true;
    document.getElementById("selectionStatus").textContent =
      selectedRelation.type === "family"
        ? "夫婦・親ペア関係を選択中（Deleteキーで解除）"
        : "親子関係を選択中（Deleteキーで解除）";
    return;
  }
  const multiple = personIds.length + items.length > 1;
  const item = items[0] ? getAnnotationDisplayItem(items[0]) : null;
  document.getElementById("personProperties").hidden = !p || multiple;
  document.getElementById("annotationProperties").hidden = !item || multiple;
  document.getElementById("multipleProperties").hidden = !multiple;
  document.getElementById("multiplePeopleActions").hidden = personIds.length < 2;
  document.getElementById("multipleAnnotationActions").hidden = items.length < 2;
  document.getElementById("selectionStatus").textContent = multiple
    ? personIds.length && items.length
      ? `${personIds.length}人・${items.length}個の図形・注釈を選択中`
      : personIds.length > 1 ? `${personIds.length}人を選択中` : `${items.length}個の図形・注釈を選択中`
    : p || item ? "" : "人物または図形を選択してください。";
  if (!item || multiple) return;
  const supportsText = ["text", "rect", "ellipse"].includes(item.type);
  document.getElementById("annotationQuickPersonFront").disabled =
    item.type === "text" || item.layer === "front";
  document.getElementById("annotationQuickPersonBack").disabled =
    item.type === "text" || item.layer === "back";
  document.getElementById("annotationQuickTextArea").hidden = !supportsText;
  document.getElementById("annotationTextStandardFill").hidden = item.type !== "text";
  document.getElementById("annotationQuickText").value = item.text;
  document.getElementById("annotationQuickFontSize").value = item.fontSize;
  document.getElementById("annotationQuickStrokeWidth").value = item.strokeWidth;
  const textColor = normalizeColorForPicker(item.color, "#222222");
  const strokeColor = normalizeColorForPicker(item.stroke, "#7557a6");
  const isNoFill = ["none", "transparent"].includes(item.fill);
  const fillColor = isNoFill ? "#ffffff" : normalizeColorForPicker(item.fill, "#ffffff");
  document.getElementById("annotationQuickColor").value = textColor;
  document.getElementById("annotationQuickStroke").value = strokeColor;
  document.getElementById("annotationQuickFill").value = fillColor;
  document.getElementById("annotationQuickNoFill").checked = isNoFill;
  updateColorPaletteSelection("annotationQuickColor", textColor);
  updateColorPaletteSelection("annotationQuickStroke", strokeColor);
  updateColorPaletteSelection("annotationQuickFill", isNoFill ? "" : fillColor);
  document.getElementById("annotationQuickWidth").value = Math.abs(item.width);
  document.getElementById("annotationQuickHeight").value = Math.abs(item.height);
}

function closeSelectionMenus() {
  closeToolMenus();
  if (typeof hideNodeContextMenu === "function") hideNodeContextMenu();
  if (typeof hideAnnotationContextMenu === "function") hideAnnotationContextMenu();
}

function closeSelectionPanel() {
  if (!commitPropertyFieldBeforeCanvasAction()) return;
  closeSelectionMenus();
  clearSelection();
  selectedAnnotationId = null;
  selectedAnnotationIds.clear();
  selectedRelation = null;
  sync();
  svg.focus({ preventScroll: true });
}

function updateColorPaletteSelection(targetId, currentColor) {
  const normalized = normalizeColorForPicker(currentColor, "").toLowerCase();
  const menu = typeof document.querySelector === "function"
    ? document.querySelector(`.color-picker-menu[data-color-target="${targetId}"]`)
    : null;
  const preview = document.getElementById(`${targetId}Preview`);
  if (preview) {
    const isTransparent = targetId === "annotationQuickFill" && (!currentColor || ["none", "transparent"].includes(currentColor));
    if (preview.classList && typeof preview.classList.toggle === "function") {
      preview.classList.toggle("is-transparent", isTransparent);
    }
    if (preview.style && typeof preview.style.setProperty === "function") {
      preview.style.setProperty("--preview-color", isTransparent ? "transparent" : (normalized || "#222222"));
    }
  }
  if (!menu || typeof menu.querySelectorAll !== "function") return;
  menu.querySelectorAll(".color-swatch").forEach(swatch => {
    const isSelected = !!normalized && swatch.dataset.color.toLowerCase() === normalized;
    if (swatch.classList && typeof swatch.classList.toggle === "function") {
      swatch.classList.toggle("selected", isSelected);
    }
    if (typeof swatch.setAttribute === "function") {
      swatch.setAttribute("aria-checked", String(isSelected));
    }
  });
}

// フォーカス中の入力を一つの編集単位とし、IME確定後に描画する。
let propertyEditSession = null;
let propertyComposingField = null;

function finishPropertyComposition() {
  if (!propertyComposingField) return true;
  propertyComposingField.blur();
  return propertyComposingField === null;
}

function commitActivePropertyField() {
  if (!finishPropertyComposition()) return false;
  const active = document.activeElement;
  if (!active) return true;
  const isPropertyField =
    (active.closest?.("#personEditorFields, #annotationProperties") ||
     active.id?.startsWith("annotationQuick") ||
     ["name", "gender", "relation", "address", "birth", "death", "deceased", "deathLegacy", "renunciation", "representative", "share", "taxpayer", "manager"].includes(active.id)) &&
    (["INPUT", "SELECT", "TEXTAREA"].includes(active.tagName) || typeof active.blur === "function");
  if (isPropertyField) {
    active.blur();
  }
  return true;
}
if (typeof window !== "undefined") window.commitActivePropertyField = commitActivePropertyField;

function applyPropertyChange(kind, mutate) {
  const id = kind === "person" ? selectedId : selectedAnnotationId;
  const startsEdit = !propertyEditSession || propertyEditSession.kind !== kind ||
    propertyEditSession.id !== id || propertyEditSession.history !== undoStack.at(-1);
  const before = startsEdit ? makeSnapshot("プロパティ変更前") : null;
  const beforeKey = getCurrentContentKey();
  mutate();
  if (beforeKey === getCurrentContentKey()) return;
  if (startsEdit) {
    pushUndoSnapshot(before);
    propertyEditSession = { kind, id, history: before };
  } else {
    redoStack.length = 0;
  }
  renderChart();
  if (kind === "person") refreshPersonSearch();
}

function applyAnnotationProperties() {
  const item = annotation(selectedAnnotationId);
  if (!item || getSelectedAnnotations().length !== 1) return;
  const display = getAnnotationDisplayItem(item);
  const supportsText = ["text", "rect", "ellipse"].includes(item.type);
  const field = id => document.getElementById(id);
  const numeric = (id, min, max) => {
    const input = field(id);
    const value = Number(input.value);
    const valid = input.value !== "" && Number.isFinite(value) && value >= min && value <= max;
    input.setCustomValidity(valid ? "" : `${min}～${max}の数値を入力してください。`);
    return valid ? value : NaN;
  };
  const strokeWidth = numeric("annotationQuickStrokeWidth", 1, 12);
  const fontSize = supportsText ? numeric("annotationQuickFontSize", 8, 72) : item.fontSize;
  const minSize = ["arrow", "cross"].includes(item.type) ? 0 : 20;
  const width = numeric("annotationQuickWidth", minSize, 1000000);
  const height = numeric("annotationQuickHeight", minSize, 1000000);
  if (![strokeWidth, fontSize, width, height].every(Number.isFinite)) return;
  const text = supportsText ? field("annotationQuickText").value : item.text;
  const error = getAnnotationTextEditError(item.id, text);
  field("annotationQuickText").setCustomValidity(error || "");
  if (error) return;
  applyPropertyChange("annotation", () => {
    if (width !== Math.abs(display.width) || height !== Math.abs(display.height)) {
      updateAttachedArrowCoordinates(item);
      item.width = display.width < 0 ? -width : width;
      item.height = display.height < 0 ? -height : height;
      clearArrowAttachment(item);
    }
    item.strokeWidth = strokeWidth;
    item.stroke = field("annotationQuickStroke").value;
    item.fill = field("annotationQuickNoFill").checked ? "none" : field("annotationQuickFill").value;
    if (supportsText) {
      item.text = text;
      item.fontSize = fontSize;
      item.color = field("annotationQuickColor").value;
    }
  });
}

function initializePropertyEditing() {
  for (const [selector, apply] of [
    ["#personEditorFields input, #personEditorFields select", savePersonForm],
    ["#annotationProperties input, #annotationProperties textarea", applyAnnotationProperties]
  ]) {
    document.querySelectorAll(selector).forEach(field => {
      let composing = false;
      field.addEventListener("focus", () => { propertyEditSession = null; });
      field.addEventListener("blur", () => { propertyEditSession = null; });
      field.addEventListener("compositionstart", () => { composing = true; propertyComposingField = field; });
      field.addEventListener("compositionend", () => {
        composing = false;
        propertyComposingField = null;
        apply();
      });
      field.addEventListener("input", event => {
        if (composing || event.isComposing) return;
        if (field.type === "number") {
          const val = Number(field.value);
          const min = field.min !== "" ? Number(field.min) : -Infinity;
          const max = field.max !== "" ? Number(field.max) : Infinity;
          if (field.value !== "" && Number.isFinite(val) && val >= min && val <= max) {
            apply();
          }
        } else {
          apply();
        }
      });
      field.addEventListener("change", () => {
        if (composing) return;
        apply();
        if (typeof field.reportValidity === "function") field.reportValidity();
      });
    });
  }
  document.querySelectorAll(".color-picker-menu").forEach(menu => {
    const targetId = menu.dataset.colorTarget;
    const targetInput = document.getElementById(targetId);
    if (!targetInput) return;
    menu.querySelectorAll(".color-swatch").forEach(swatch => {
      swatch.addEventListener("click", () => {
        const color = swatch.dataset.color;
        targetInput.value = color;
        if (targetId === "annotationQuickFill") {
          const noFill = document.getElementById("annotationQuickNoFill");
          if (noFill && noFill.checked) noFill.checked = false;
        }
        updateColorPaletteSelection(targetId, color);
        menu.open = false;
        propertyEditSession = null;
        applyAnnotationProperties();
      });
    });
    menu.addEventListener("toggle", () => {
      if (!menu.open) return;
      document.querySelectorAll(".color-picker-menu").forEach(other => {
        if (other !== menu) other.open = false;
      });
    });
  });
  document.getElementById("annotationQuickNoFill")?.addEventListener("change", e => {
    if (e.target.checked) {
      updateColorPaletteSelection("annotationQuickFill", "none");
    } else {
      const fillInput = document.getElementById("annotationQuickFill");
      updateColorPaletteSelection("annotationQuickFill", fillInput?.value || "#ffffff");
    }
  });
}

function closeWorkspaceDialog(id) {
  const dialog = document.getElementById(id);
  if (dialog && dialog.open) dialog.close();
}

function openPrintModal() {
  closeToolMenus();
  const sheet = document.getElementById("printPreviewSheet");
  if (sheet) delete sheet.dataset.creationDate;
  updatePrintPreview();
  document.getElementById("printDialog").showModal();
  fitPrintPreview();
}

function closePrintModal() {
  closeWorkspaceDialog("printDialog");
}

function executePrint() {
  if (!getPrintSettings()) {
    document.querySelectorAll("#printDialog input").forEach(input => input.reportValidity());
    return;
  }
  preparePrintLayout();
  closeWorkspaceDialog("printDialog");
  printChart();
}

function openValidationDialog() {
  closeToolMenus();
  validateDataAndShow();
  document.getElementById("validationDialog").showModal();
}

function closeValidationDialog() {
  closeWorkspaceDialog("validationDialog");
}

function openLegacyMigrationDialog() {
  closeToolMenus();
  document.getElementById("legacyMigrationDialog").showModal();
}

function closeLegacyMigrationDialog() {
  closeWorkspaceDialog("legacyMigrationDialog");
}






function fitPrintPreview() {
  const container = document.getElementById("printPreviewContainer");
  const sheet = document.getElementById("printPreviewSheet");
  if (!container || !sheet || !container.clientWidth || !container.clientHeight) return;
  const style = getComputedStyle(container);
  const width = container.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const height = container.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
  if (!(width > 0 && height > 0)) return;
  const portrait = sheet.dataset.orientation === "portrait";
  const pxPerMm = 96 / 25.4;
  const zoom = Math.min(1, width / ((portrait ? 210 : 297) * pxPerMm),
    height / ((portrait ? 297 : 210) * pxPerMm));
  container.style.setProperty("--print-preview-zoom", String(zoom));
}

function updatePrintPreview() {
  updatePrintSheet();
  fitPrintPreview();
}
function openSamplePicker() {
  closeToolMenus();
  document.getElementById("sampleDialog").showModal();
}

const CANVAS_HINT_DISMISS_KEY = "kakeizu.ui.canvasFirstHint.dismissed";
let canvasHintDismissed = false;
let personSearchMatches = [];
let personSearchActiveIndex = -1;
let personSearchComposing = false;

function dismissCanvasHint() {
  const hint = document.getElementById("canvasFirstHint");
  if (hint) hint.hidden = true;
  if (canvasHintDismissed) return;
  canvasHintDismissed = true;
  try {
    localStorage.setItem(CANVAS_HINT_DISMISS_KEY, "1");
  } catch (_) {
    // 保存できない環境でも、この画面では再表示しない。
  }
}

function initializeCanvasHint() {
  try {
    canvasHintDismissed = canvasHintDismissed ||
      localStorage.getItem(CANVAS_HINT_DISMISS_KEY) === "1";
  } catch (_) {
    // ストレージを利用できなくてもヒントは操作できる。
  }
  const hint = document.getElementById("canvasFirstHint");
  if (hint) hint.hidden = canvasHintDismissed;
  svg.addEventListener("pointerdown", dismissCanvasHint, true);
}

function normalizePersonSearch(value) {
  return String(value ?? "").normalize("NFKC").toLowerCase().trim();
}

function findPeopleForSearch(value) {
  const terms = normalizePersonSearch(value).split(/\s+/u).filter(Boolean);
  return people.filter(p => {
    const text = normalizePersonSearch(`${p.name ?? ""} ${p.relation ?? ""} ${p.id}`);
    return terms.every(term => text.includes(term));
  });
}

function closePersonSearch() {
  const popup = document.getElementById("personSearchPopup");
  const input = document.getElementById("personSearchInput");
  if (popup) popup.hidden = true;
  if (input) {
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  }
  personSearchMatches = [];
  personSearchActiveIndex = -1;
}

function setPersonSearchActiveIndex(index) {
  personSearchActiveIndex = index;
  const input = document.getElementById("personSearchInput");
  const results = document.getElementById("personSearchResults");
  const options = results ? [...results.children] : [];
  options.forEach((option, optionIndex) => {
    option.setAttribute("aria-selected", String(optionIndex === index));
  });
  const active = options[index];
  if (active) {
    input.setAttribute("aria-activedescendant", active.id);
    active.scrollIntoView?.({ block: "nearest" });
  } else {
    input?.removeAttribute("aria-activedescendant");
  }
}

function renderPersonSearchResults() {
  const input = document.getElementById("personSearchInput");
  const popup = document.getElementById("personSearchPopup");
  const results = document.getElementById("personSearchResults");
  const summary = document.getElementById("personSearchSummary");
  if (!input || !popup || !results || !summary) return;
  const query = normalizePersonSearch(input.value);
  if (!query) {
    closePersonSearch();
    return;
  }
  const previousId = personSearchMatches[personSearchActiveIndex]?.id;
  personSearchMatches = findPeopleForSearch(query);
  results.replaceChildren();
  personSearchMatches.forEach((p, index) => {
    const option = document.createElement("div");
    option.id = `personSearchOption-${index}`;
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", "false");
    option.textContent = `${p.name || "（氏名未入力）"} / ${p.relation || "続柄未入力"} / ${p.id}`;
    option.addEventListener("pointerdown", event => event.preventDefault());
    option.addEventListener("click", () => confirmPersonSearch(p.id));
    results.appendChild(option);
  });
  summary.textContent = personSearchMatches.length
    ? `${personSearchMatches.length}人が見つかりました。`
    : "一致する人物はいません。";
  popup.hidden = false;
  input.setAttribute("aria-expanded", "true");
  setPersonSearchActiveIndex(personSearchMatches.findIndex(p => p.id === previousId));
}

// データ更新は表示中の候補だけに反映し、閉じた検索を再開しない。
function refreshPersonSearch() {
  const popup = document.getElementById("personSearchPopup");
  if (!popup || popup.hidden || personSearchComposing) return;
  renderPersonSearchResults();
}

function confirmPersonSearch(id) {
  if (personSearchComposing || !commitPropertyFieldBeforeCanvasAction()) return;
  if (!person(id)) {
    refreshPersonSearch();
    return;
  }
  finishAnnotationTextEdit(true);
  if (annotationTextEdit) return;
  cancelCanvasTool();
  closeSelectionMenus();
  closePersonSearch();
  selectPerson(id);
  focusSelected();
  svg.focus({ preventScroll: true });
}

function initializePersonSearch() {
  const root = document.getElementById("personSearch");
  const input = document.getElementById("personSearchInput");
  if (!root || !input) return;
  closePersonSearch();
  input.addEventListener("pointerdown", event => {
    if (!commitPropertyFieldBeforeCanvasAction()) event.preventDefault();
  });
  input.addEventListener("focus", () => {
    if (!commitPropertyFieldBeforeCanvasAction()) input.blur();
  });
  input.addEventListener("compositionstart", () => { personSearchComposing = true; });
  input.addEventListener("compositionend", () => {
    personSearchComposing = false;
    if (document.activeElement === input) renderPersonSearchResults();
  });
  input.addEventListener("input", event => {
    if (!personSearchComposing && !event.isComposing) renderPersonSearchResults();
  });
  input.addEventListener("keydown", event => {
    if (personSearchComposing || event.isComposing || event.keyCode === 229) {
      event.stopPropagation();
      return;
    }
    if (event.key === "Tab") {
      closePersonSearch();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closePersonSearch();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      if (document.getElementById("personSearchPopup").hidden) renderPersonSearchResults();
      const count = personSearchMatches.length;
      if (!count) return;
      const next = personSearchActiveIndex < 0
        ? event.key === "ArrowDown" ? 0 : count - 1
        : (personSearchActiveIndex + (event.key === "ArrowDown" ? 1 : -1) + count) % count;
      setPersonSearchActiveIndex(next);
    } else if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      const match = personSearchMatches[personSearchActiveIndex < 0 ? 0 : personSearchActiveIndex];
      if (match) confirmPersonSearch(match.id);
    }
  });
  root.addEventListener("focusout", event => {
    if (!root.contains(event.relatedTarget)) closePersonSearch();
  });
  const closeOutsideSearch = event => {
    if (!root.contains(event.target)) closePersonSearch();
  };
  document.addEventListener("pointerdown", closeOutsideSearch, true);
  document.addEventListener("click", closeOutsideSearch, true);
  document.addEventListener("keydown", event => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== "k" ||
        event.isComposing || event.keyCode === 229 || personSearchComposing ||
        propertyComposingField || document.querySelector("dialog[open], .app-modal-backdrop.show")) return;
    if (!commitPropertyFieldBeforeCanvasAction()) return;
    event.preventDefault();
    event.stopPropagation();
    input.focus({ preventScroll: true });
    input.select();
  }, true);
}

function loadSample(kind) {
  if (!KakeizuSamples.catalog.some(sample => sample.id === kind)) return;
  if ((people.length || annotations.length || chartMemo) &&
      !confirm("現在の図を置き換えます。必要なデータはJSON保存してください。\n元に戻すこともできます。続けますか？")) return;
  cancelCanvasTool();
  finishAnnotationTextEdit(true);
  if (annotationTextEdit) return;
  ++saveOperationSequence;
  pushUndo("サンプル読込前");
  resetSample(kind);
  sync();
  closeWorkspaceDialog("sampleDialog");
  requestAnimationFrame(() => { if (people.length) fitAll(); else resetView(); });
}

// 表示領域だけを追従させ、図の座標・倍率・履歴は変更しない。
function updateCanvasViewportSize() {
  const rect = svg.getBoundingClientRect();
  const width = Math.max(1, rect.width || 1000);
  const height = Math.max(1, rect.height || 700);
  const viewBox = `0 0 ${width} ${height}`;
  if (svg.getAttribute("viewBox") !== viewBox) {
    svg.setAttribute("viewBox", viewBox);
  }
}

function initializeWorkspaceUi() {
  initializePlacementPreview();
  initializePropertyEditing();
  initializeCanvasHint();
  initializePersonSearch();
  updateSelectionProperties(true);
  setUiMode("drawing");
  const cards = document.getElementById("sampleCards");
  KakeizuSamples.catalog.forEach(sample => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "sample-card";
    const title = document.createElement("strong");
    title.textContent = sample.title;
    const diagram = document.createElement("span");
    diagram.className = "sample-diagram";
    diagram.textContent = sample.diagram;
    const description = document.createElement("span");
    description.textContent = sample.description;
    button.append(title, diagram, description);
    button.addEventListener("click", () => loadSample(sample.id));
    cards.appendChild(button);
  });
  document.querySelectorAll(".drawing-toolbar [data-kakeizu-click]").forEach(button => {
    button.addEventListener("click", closeToolMenus);
  });
  document.querySelectorAll(".tool-menu").forEach(menu => {
    menu.addEventListener("toggle", () => {
      if (!menu.open) return;
      document.querySelectorAll(".tool-menu").forEach(other => {
        if (other !== menu) other.open = false;
      });
    });
  });
  const closeOutsideToolMenus = event => {
    if (!event.target.closest?.(".tool-menu, .color-picker-menu")) closeToolMenus();
  };
  // 人物・図形側が伝播を止めても、クリック対象の処理より前に閉じる。
  document.addEventListener("pointerdown", closeOutsideToolMenus, true);
  document.addEventListener("click", closeOutsideToolMenus, true);
  document.querySelectorAll("#printDialog input, #printDialog select").forEach(input => {
    input.addEventListener("input", updatePrintPreview);
    input.addEventListener("change", updatePrintPreview);
  });
  const previewContainer = document.getElementById("printPreviewContainer");
  if (typeof ResizeObserver === "function") {
    const previewObserver = new ResizeObserver(fitPrintPreview);
    previewObserver.observe(previewContainer);
    const canvasObserver = new ResizeObserver(updateCanvasViewportSize);
    canvasObserver.observe(svg);
  }
  window.addEventListener("resize", fitPrintPreview);
  window.addEventListener("resize", updateCanvasViewportSize);
  updateCanvasViewportSize();
}
