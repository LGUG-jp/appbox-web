'use strict';

const { NODE_W, NODE_H, calculateAutoLayout } = KakeizuLayout;

let people = [];
let selectedId = null;
let selectedIds = new Set();

let families = [];
let familyModelInitialized = false;

let chartMemo = "";

let annotations = [];
let selectedAnnotationId = null;
let selectedAnnotationIds = new Set();
let annotationTool = null;
let annotationContextTargetId = null;

/*
 * 矢印端点のドラッグ中に、吸着候補となっている人物ID。
 */
let arrowSnapTargetId = null;

/*
 * 四角・楕円・×印・矢印をドラッグ作成するときの一時状態。
 * pointerupまではannotations配列へ追加しない。
 */
let annotationCreating = null;
let annotationTextEdit = null;
/*
 * pointerdown時にSVGを再描画するため、文字注釈の連続クリックを追跡する。
 */
let lastAnnotationTextPointerDown = null;
let renderingChart = false;


let relationMode = null;
let relationClicks = [];

let scale = 1;
let offsetX = 40;
let offsetY = 40;

/*
 * アプリ内の図形クリップボード。
 * 個人情報をOSのクリップボードへ送らず、ブラウザ内だけで保持する。
 */
let annotationClipboard = null;
let annotationPasteCount = 0;

const svg = document.getElementById("canvas");
const viewport = document.getElementById("viewport");

let relationPreviewMouse = null;

let nodeContextTargetId = null;

const undoStack = [];
const redoStack = [];
const UNDO_LIMIT = 50;

const AUTO_SAVE_ENABLED_KEY =
  "fixedTaxInheritanceChart_autoSaveEnabled_v2";

const AUTO_SAVE_DATA_KEY =
  "fixedTaxInheritanceChart_autoSaveData_v2";

const AUTO_SAVE_DELAY_MS = 5000;

let autoSaveTimer = null;
let autoSaveReady = false;
let autoSaveLastSavedAt = "";

function nextId() {
let max = 0;
people.forEach(p => {
  const m = String(p.id || "").match(/^P(\d+)$/);
  if (m) max = Math.max(max, Number(m[1]));
});
return "P" + String(max + 1).padStart(3, "0");
}

function person(id) {
return people.find(p => p.id === id);
}

function unique(arr) {
return [...new Set((arr || []).filter(Boolean))];
}

function parseIds(text) {
return String(text || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);
}

function toFiniteNumber(value, fallback) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return fallback;
  }

  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : fallback;
}


function createPerson(base = {}) {
  return {
    id: base.id || nextId(),
    name: base.name || "新規人物",
    relation: base.relation || "",
    gender: base.gender || "",
    address: base.address || "",
    birth: base.birth || "",
    death: base.death || "",
    renunciation:
      base.renunciation || "未確認",
    representative: !!base.representative,
    share: base.share || "",
    taxpayer: !!base.taxpayer,
    manager: !!base.manager,
    note: base.note || "",
    parents: unique(base.parents || []),
    spouses: unique(base.spouses || []),

    x: toFiniteNumber(
      base.x,
      120 + people.length * 30
    ),

    y: toFiniteNumber(
      base.y,
      120 + people.length * 30
    )
  };
}


function sampleData() {
  people = [];
  families = [];
  annotations = [];

  selectedId = null;
  selectedIds.clear();

  selectedAnnotationId = null;
  selectedAnnotationIds.clear();

  annotationTool = null;
  annotationContextTargetId = null;
  annotationCreating = null;

  chartMemo =
    "サンプルデータです。実際の業務データ作成時は全消去してから入力してください。";

  const a = createPerson({
    id: "P001",
    name: "被相続人",
    relation: "所有者・死亡",
    death: "不明",
    renunciation: "なし",
    x: 320,
    y: 120
  });

  const b = createPerson({
    id: "P002",
    name: "配偶者",
    relation: "配偶者",
    representative: true,
    share: "1/2",
    taxpayer: true,
    x: 540,
    y: 120
  });

  const c = createPerson({
    id: "P003",
    name: "子",
    relation: "長男・長女等",
    renunciation: "未確認",
    share: "1/2",
    parents: ["P001", "P002"],
    x: 430,
    y: 300
  });

  people = [a, b, c];

  families = [
    createFamily({
      id: "F001",
      parents: ["P001", "P002"],
      children: ["P003"]
    })
  ];

  familyModelInitialized = true;

  selectedId = "P001";
  selectedIds = new Set(["P001"]);

  normalizeRelations();
}


function nextFamilyId() {
let max = 0;

families.forEach(f => {
  const m = String(f.id || "").match(/^F(\d+)$/);
  if (m) max = Math.max(max, Number(m[1]));
});

return "F" + String(max + 1).padStart(3, "0");
}

function createFamily(base = {}) {
return {
  id: base.id || nextFamilyId(),
  parents: unique(base.parents || []),
  children: unique(base.children || [])
};
}

function sameIdSet(a, b) {
const aa = unique(a).sort();
const bb = unique(b).sort();

return aa.length === bb.length && aa.every((v, i) => v === bb[i]);
}

function findFamilyByParents(parentIds) {
const target = unique(parentIds).sort();

return families.find(f => sameIdSet(f.parents, target));
}

function getOrCreateFamily(parentIds) {
const ids = unique(parentIds).filter(id => person(id));

let f = findFamilyByParents(ids);

if (!f) {
  f = createFamily({
    parents: ids,
    children: []
  });
  families.push(f);
}

return f;
}

function normalizeFamilies() {
const ids = new Set(people.map(p => p.id));

families = families
  .map(f => createFamily(f))
  .filter(f => f.parents.length || f.children.length);

families.forEach(f => {
  f.parents = unique(f.parents).filter(id => ids.has(id));
  f.children = unique(f.children).filter(id => ids.has(id) && !f.parents.includes(id));
});

families = families.filter(f => f.parents.length || f.children.length);

mergeDuplicateFamilies();
}

function mergeDuplicateFamilies() {
const map = new Map();

families.forEach(f => {
  const key = unique(f.parents).sort().join("|");

  if (!map.has(key)) {
    map.set(key, createFamily(f));
  } else {
    const existing = map.get(key);
    existing.children = unique([
      ...existing.children,
      ...f.children
    ]);
  }
});

families = [...map.values()];
}

function syncPeopleRelationsFromFamilies() {
people.forEach(p => {
  p.parents = [];
  p.spouses = [];
});

families.forEach(f => {
  const parentIds = unique(f.parents);

  // 配偶者関係を人物側にも反映
  if (parentIds.length >= 2) {
    parentIds.forEach(pid => {
      const p = person(pid);
      if (!p) return;

      parentIds.forEach(otherId => {
        if (otherId !== pid && !p.spouses.includes(otherId)) {
          p.spouses.push(otherId);
        }
      });
    });
  }

  // 親子関係を人物側にも反映
  f.children.forEach(childId => {
    const c = person(childId);
    if (!c) return;

    c.parents = unique([
      ...c.parents,
      ...parentIds
    ]);
  });
});

people.forEach(p => {
  p.parents = unique(p.parents);
  p.spouses = unique(p.spouses);
});
}

function migrateLegacyRelationsToFamilies() {
if (familyModelInitialized) return;

const newFamilies = [];

function getTempFamily(parentIds) {
  const ids = unique(parentIds).filter(id => person(id));
  let f = newFamilies.find(x => sameIdSet(x.parents, ids));

  if (!f) {
    f = createFamily({
      parents: ids,
      children: []
    });
    newFamilies.push(f);
  }

  return f;
}

// 既存の spouses から夫婦単位を作る
people.forEach(p => {
  (p.spouses || []).forEach(sid => {
    if (person(sid) && sid !== p.id) {
      getTempFamily([p.id, sid]);
    }
  });
});

// 既存の parents から親子単位を作る
people.forEach(p => {
  const parentIds = unique(p.parents || []).filter(id => person(id));

  if (parentIds.length) {
    const f = getTempFamily(parentIds);
    if (!f.children.includes(p.id)) {
      f.children.push(p.id);
    }
  }
});

families = newFamilies;
familyModelInitialized = true;
}

function normalizeRelations() {
migrateLegacyRelationsToFamilies();
normalizeFamilies();
syncPeopleRelationsFromFamilies();
}

function newPerson() {
  const p = createPerson();

  people.push(p);
  activateNewPersonForEditing(p.id);
}


function deletePerson(id) {
const p = person(id);
if (!p) return;

if (!confirm(`${p.name || id} を削除しますか？`)) return;

/*
 * 人物を配列から削除する前に、
 * 吸着矢印を現在の人物位置へ確定する。
 */
updateAllAttachedArrows();

people = people.filter(x => x.id !== id);

families.forEach(f => {
  f.parents = f.parents.filter(pid => pid !== id);
  f.children = f.children.filter(cid => cid !== id);
});

families = families.filter(f => f.parents.length || f.children.length);

people.forEach(x => {
  x.parents = x.parents.filter(pid => pid !== id);
  x.spouses = x.spouses.filter(sid => sid !== id);
});

/*
 * 削除人物へ吸着していた矢印は、
 * 現在の座標を維持したまま吸着だけ解除する。
 */
annotations.forEach(item => {
  if (item.type !== "arrow") {
    return;
  }

  if (item.startPersonId === id) {
    item.startPersonId = "";
    item.startAnchor = "";
  }

  if (item.endPersonId === id) {
    item.endPersonId = "";
    item.endAnchor = "";
  }
});

selectedId = people[0]?.id || null;
selectedIds = selectedId ? new Set([selectedId]) : new Set();

relationClicks = relationClicks.filter(pid => pid !== id);

sync();
}


function deleteSelected() {
if (selectedId) deletePerson(selectedId);
}

function selectPerson(id) {
  selectedId = id || null;
  selectedIds = id
    ? new Set([id])
    : new Set();

  selectedAnnotationId = null;
  selectedAnnotationIds.clear();

  sync();
}


function selectOnly(id) {
  selectedId = id || null;
  selectedIds = id
    ? new Set([id])
    : new Set();

  selectedAnnotationId = null;
  selectedAnnotationIds.clear();
}

function togglePersonSelection(id) {
  if (!id) {
    return;
  }

  selectedAnnotationId = null;
  selectedAnnotationIds.clear();

  if (selectedIds.has(id)) {
    selectedIds.delete(id);

    if (selectedId === id) {
      selectedId = selectedIds.size
        ? [...selectedIds][0]
        : null;
    }
  } else {
    selectedIds.add(id);
    selectedId = id;
  }
}


function clearSelection() {
selectedId = null;
selectedIds.clear();
}

function clearSelectionAndRender() {
  clearSelection();

  selectedAnnotationId = null;
  selectedAnnotationIds.clear();

  hideNodeContextMenu();
  hideAnnotationContextMenu();

  sync();
}


function isSelected(id) {
return selectedIds.has(id) || selectedId === id;
}

function savePersonForm() {
const p = person(selectedId);
if (!p) return;

p.name = document.getElementById("name").value;
p.gender = document.getElementById("gender").value;
p.relation = document.getElementById("relation").value;
p.address = document.getElementById("address").value;
p.birth = document.getElementById("birth").value;
p.death = document.getElementById("death").value;
p.renunciation = document.getElementById("renunciation").value;
p.representative = document.getElementById("representative").checked;
p.share = document.getElementById("share").value;
p.taxpayer = document.getElementById("taxpayer").checked;
p.manager = document.getElementById("manager").checked;

sync();
}

function loadPersonForm() {
  const p = person(selectedId);
  const managementId = document.getElementById("personManagementId");
  const editorFields = document.getElementById("personEditorFields");
  const status = document.getElementById("personEditorStatus");

  document.getElementById("idView").textContent = p?.id || "";
  managementId.hidden = !p;
  editorFields.disabled = !p;

  if (status) {
    if (!p) {
      status.textContent = people.length
        ? "人物一覧から人物を選択すると、人物情報を編集できます。"
        : "人物がいません。「人物を追加」から最初の人物を登録してください。";
    } else if (selectedIds.size > 1) {
      status.textContent =
        `${p.name || "無名"}を主に選択中です。` +
        `${selectedIds.size}人を複数選択しています。`;
    } else {
      status.textContent = `${p.name || "無名"}の情報を編集中です。`;
    }
  }

  document.getElementById("name").value = p?.name || "";
  document.getElementById("gender").value = p?.gender || "";
  document.getElementById("relation").value = p?.relation || "";
  document.getElementById("address").value = p?.address || "";
  document.getElementById("birth").value = p?.birth || "";
  document.getElementById("death").value = p?.death || "";
  document.getElementById("renunciation").value =
    p?.renunciation || "未確認";
  document.getElementById("representative").checked =
    !!p?.representative;
  document.getElementById("share").value = p?.share || "";
  document.getElementById("taxpayer").checked = !!p?.taxpayer;
  document.getElementById("manager").checked = !!p?.manager;
}

function updateChartMemoFromInput() {
const el = document.getElementById("chartMemo");
chartMemo = el ? el.value : "";

if (typeof scheduleAutoSave === "function") {
  scheduleAutoSave();
}
}

function loadChartMemoToInput() {
const el = document.getElementById("chartMemo");
if (!el) return;

if (el.value !== chartMemo) {
  el.value = chartMemo || "";
}
}







function addSpouse() {
const otherId = document.getElementById("spouseSelect").value;
const p = person(selectedId);
const s = person(otherId);

if (!p || !s || p.id === s.id) return;

getOrCreateFamily([p.id, s.id]);

// 座標は動かさない
sync();
}

function addChild() {
const childId = document.getElementById("childSelect").value;
const otherParentId = document.getElementById("otherParentSelect").value;

const parent1 = person(selectedId);
const child = person(childId);
const parent2 = person(otherParentId);

if (!parent1 || !child || parent1.id === child.id) return;

const parentIds = [parent1.id];

if (parent2 && parent2.id !== parent1.id && parent2.id !== child.id) {
  parentIds.push(parent2.id);
} else {
  const spouseIds = parent1.spouses || [];

  if (spouseIds.length === 1 && spouseIds[0] !== child.id) {
    parentIds.push(spouseIds[0]);
  }
}

const f = getOrCreateFamily(parentIds);

if (!f.children.includes(child.id)) {
  f.children.push(child.id);
}

// 座標は動かさない
sync();
}

function beginRelationMode(mode, initialPersonIds = []) {
  relationMode = mode;
  relationClicks = initialPersonIds.filter(id => person(id));
  relationPreviewMouse = null;

  hideNodeContextMenu();
  switchSideTab("relation");
  updateRelationModeStatus();
  renderChart();
}

function startRelationMode(mode) {
  beginRelationMode(mode);
}

function cancelRelationMode() {
  relationMode = null;
  relationClicks = [];
  relationPreviewMouse = null;

  updateRelationModeStatus();
  updateRelationToolUi();
  renderChart();
}

function updateRelationModeStatus(message) {
  const el = document.getElementById("relationModeStatus");
  if (!el) return;

  el.classList.remove("active", "warning");

  if (message) {
    el.textContent = message;
    el.classList.add("warning");
    return;
  }

  const progress = getRelationModeProgress();

  if (!progress) {
    el.textContent = "関係作成モードは未選択です。";
    return;
  }

  el.classList.add("active");

  const selectedNames = progress.selectedNames.length
    ? `選択中: ${progress.selectedNames.join("、")}。`
    : "";

  el.textContent =
    `${progress.definition.title} ` +
    `（${progress.selectedCount}/${progress.definition.total}人選択済み）。` +
    `${selectedNames}${progress.instruction} Escまたは「関係作成を中止」でキャンセルできます。`;

  updateRelationToolUi();
}



function handleRelationNodeClick(id, e) {
if (!relationMode) return;

e.stopPropagation();

if (relationMode === "spouse") {
  handleSpouseRelationClick(id);
  return;
}

if (relationMode === "child1") {
  handleChildOneParentRelationClick(id);
  return;
}

if (relationMode === "child2") {
  handleChildTwoParentsRelationClick(id);
  return;
}
}

function handleSpouseRelationClick(id) {
  if (relationClicks.length === 0) {
    relationClicks.push(id);
    updateRelationModeStatus();
    renderChart();
    return;
  }

  const firstId = relationClicks[0];

  if (firstId === id) {
    updateRelationModeStatus("同じ人物同士では夫婦関係を作成できません。別の人物をクリックしてください。");
    return;
  }

  // ここでundo用スナップショットを保存
  pushUndo("canvas夫婦関係作成前");

  getOrCreateFamily([firstId, id]);
  familyModelInitialized = true;

  finishRelationMode(
    `夫婦関係を作成しました: ${personDisplayName(firstId)} + ${personDisplayName(id)}`
  );

}

function handleChildOneParentRelationClick(id) {
  if (relationClicks.length === 0) {
    relationClicks.push(id);
    updateRelationModeStatus();
    renderChart();
    return;
  }

  const parentId = relationClicks[0];
  const childId = id;

  if (parentId === childId) {
    updateRelationModeStatus("同じ人物を親と子にはできません。子にする人物をクリックしてください。");
    return;
  }

  // ここでundo用スナップショットを保存
  pushUndo("canvas親子関係作成前");

  const f = getOrCreateFamily([parentId]);

  if (!f.children.includes(childId)) {
    f.children.push(childId);
  }

  familyModelInitialized = true;

  finishRelationMode(
    `親子関係を作成しました: 親 ${personDisplayName(parentId)} → 子 ${personDisplayName(childId)}`
  );

}

function handleChildTwoParentsRelationClick(id) {
  if (relationClicks.length === 0) {
    relationClicks.push(id);
    updateRelationModeStatus();
    renderChart();
    return;
  }

  if (relationClicks.length === 1) {
    const parent1Id = relationClicks[0];

    if (parent1Id === id) {
      updateRelationModeStatus("親1と親2に同じ人物は指定できません。別の親2をクリックしてください。");
      return;
    }

    relationClicks.push(id);
    updateRelationModeStatus();
    renderChart();
    return;
  }

  const parent1Id = relationClicks[0];
  const parent2Id = relationClicks[1];
  const childId = id;

  if (childId === parent1Id || childId === parent2Id) {
    updateRelationModeStatus("親に指定した人物を子にはできません。子にする人物をクリックしてください。");
    return;
  }

  // ここでundo用スナップショットを保存
  pushUndo("canvas親子関係作成前");

  const f = getOrCreateFamily([parent1Id, parent2Id]);

  if (!f.children.includes(childId)) {
    f.children.push(childId);
  }

  familyModelInitialized = true;

  finishRelationMode(
    `親子関係を作成しました: 親 ${personDisplayName(parent1Id)} + ${personDisplayName(parent2Id)} → 子 ${personDisplayName(childId)}`
  );

}

function sync() {
normalizeRelations();
renderList();
renderSelects();

const relationModal = document.getElementById("relationListModalBackdrop");

if (
  document.getElementById("familyTable") &&
  relationModal &&
  relationModal.classList.contains("show")
) {
  renderFamilyTable();
}


loadPersonForm();
loadChartMemoToInput();
renderChart();

  // チェック結果が表示中なら、最新状態で再チェックする
  // const result = document.getElementById("validationResult");
  // if (result && result.innerHTML.trim()) {
  //  validationIssues = validateData();
  //  renderValidationResult(validationIssues);
  // }

scheduleAutoSave();
}

function renderList() {
  const box = document.getElementById("personList");
  box.innerHTML = "";

  if (!people.length) {
    const emptyState = document.createElement("p");
    emptyState.className = "person-list-empty";
    emptyState.textContent =
      "人物が登録されていません。「人物を追加」から始めてください。";
    box.appendChild(emptyState);
    return;
  }

  people.forEach(p => {
    const btn = document.createElement("button");
    const flags = [];
    const selected = isSelected(p.id);
    const isMultiSelected = selectedIds.size > 1 && selected;

    if (p.death) flags.push("死亡");
    if (p.renunciation === "放棄済") flags.push("放棄");
    if (p.representative) flags.push("代表");
    if (p.share) flags.push(p.share);

    btn.textContent =
      `${p.name || "無名"}` +
      `${p.relation ? " / " + p.relation : ""}` +
      `${flags.length ? " [" + flags.join("・") + "]" : ""}`;
    btn.classList.toggle("selected", selected);
    btn.classList.toggle("multi-selected", isMultiSelected);
    btn.classList.toggle(
      "primary-selected",
      isMultiSelected && p.id === selectedId
    );
    btn.setAttribute("aria-pressed", String(selected));
    btn.onclick = () => selectPerson(p.id);
    box.appendChild(btn);
  });
}

function renderSelects() {
const selects = [
  document.getElementById("spouseSelect"),
  document.getElementById("childSelect"),
  document.getElementById("otherParentSelect")
];

selects.forEach(sel => {
  sel.innerHTML = "";

  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = "選択してください";
  sel.appendChild(empty);

  people.forEach(p => {
    if (p.id === selectedId && sel !== document.getElementById("otherParentSelect")) return;

    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = `${p.id} ${p.name || "無名"}`;
    sel.appendChild(opt);
  });
});
}

function toggleTable() {
document.getElementById("tableWrap").classList.toggle("open");
}

function renderBulkEditTables() {
renderBulkPersonTable();
renderBulkRelationTable();
renderBulkBusinessTable();
}

function renderBulkPersonTable() {
const tbody = document.getElementById("bulkPersonTbody");
if (!tbody) return;

tbody.innerHTML = "";

people.forEach(p => {
  const tr = document.createElement("tr");
  tr.dataset.id = p.id;

  tr.innerHTML = `
    <td class="bulk-id-cell">${escapeHtml(p.id)}</td>

    <td>
      <input data-field="name" value="${escapeAttr(p.name || "")}">
    </td>

    <td>
      <select data-field="gender">
        ${option("", p.gender || "", "未設定")}
        ${option("男性", p.gender || "")}
        ${option("女性", p.gender || "")}
        ${option("不明", p.gender || "")}
      </select>
    </td>

    <td>
      <input data-field="relation" value="${escapeAttr(p.relation || "")}" placeholder="例: 長男、長女、配偶者">
    </td>

    <td>
      <input data-field="address" value="${escapeAttr(p.address || "")}">
    </td>

    <td>
      <input data-field="birth" value="${escapeAttr(p.birth || "")}" placeholder="例: 1950/01/01">
    </td>

    <td>
      <input data-field="death" value="${escapeAttr(p.death || "")}" placeholder="例: 2024/01/01、不明">
    </td>

  `;

  tbody.appendChild(tr);
});
}

function renderBulkRelationTable() {
const tbody = document.getElementById("bulkRelationTbody");
if (!tbody) return;

tbody.innerHTML = "";

people.forEach(p => {
  const parents = getParentsForBulkEdit(p.id);
  const parent1 = parents[0] || "";
  const parent2 = parents[1] || "";

  const tr = document.createElement("tr");
  tr.dataset.id = p.id;

  tr.innerHTML = `
    <td class="bulk-id-cell">${escapeHtml(p.id)}</td>
    <td class="bulk-name-readonly">${escapeHtml(p.name || "")}</td>

    <td>
      <input data-field="parent1" value="${escapeAttr(parent1)}" placeholder="例: P001">
    </td>

    <td>
      <input data-field="parent2" value="${escapeAttr(parent2)}" placeholder="例: P002">
    </td>

    <td>
      <input data-field="spouses" value="${escapeAttr((p.spouses || []).join(","))}" placeholder="例: P003,P004">
    </td>
  `;

  tbody.appendChild(tr);
});
}

function renderBulkBusinessTable() {
const tbody = document.getElementById("bulkBusinessTbody");
if (!tbody) return;

tbody.innerHTML = "";

people.forEach(p => {
  const tr = document.createElement("tr");
  tr.dataset.id = p.id;

  tr.innerHTML = `
    <td class="bulk-id-cell">${escapeHtml(p.id)}</td>
    <td class="bulk-name-readonly">${escapeHtml(p.name || "")}</td>

    <td>
      <select data-field="renunciation">
        ${option("未確認", p.renunciation || "未確認")}
        ${option("なし", p.renunciation || "未確認")}
        ${option("確認中", p.renunciation || "未確認")}
        ${option("放棄済", p.renunciation || "未確認")}
      </select>
    </td>

    <td style="text-align:center;">
      <input data-field="representative" type="checkbox" ${p.representative ? "checked" : ""} style="width:auto;">
    </td>

    <td style="text-align:center;">
      <input data-field="taxpayer" type="checkbox" ${p.taxpayer ? "checked" : ""} style="width:auto;">
    </td>

    <td style="text-align:center;">
      <input data-field="manager" type="checkbox" ${p.manager ? "checked" : ""} style="width:auto;">
    </td>

    <td>
      <input data-field="share" value="${escapeAttr(p.share || "")}" placeholder="例: 1/2、3分の1">
    </td>
  `;

  tbody.appendChild(tr);
});
}

function applyBulkEditAndClose() {
const ok = applyBulkEdit();

if (ok !== false) {
closeBulkEditModal();
}
}

function applyBulkEdit() {
const checkResult = validateBulkEditBeforeApply();

if (checkResult.errors.length) {
  showBulkEditValidationMessage(checkResult, false);
  return false;
}

if (checkResult.warnings.length) {
  const okWarning = confirm(
    "一括編集表に確認が必要な項目があります。\n\n" +
    buildBulkEditIssueText(checkResult.warnings) +
    "\n\nこのまま反映しますか？"
  );

  if (!okWarning) {
    switchBulkEditTab("relation");
    focusFirstBulkEditIssue(checkResult);
    return false;
  }
}

const ok = confirm(
  "一括編集表の内容を図に反映します。\n\n" +
  "人物情報、関係情報、業務情報が表の内容で更新されます。\n" +
  "よろしいですか？"
);

if (!ok) return false;

if (typeof pushUndo === "function") {
  pushUndo("一括編集反映前");
}

applyBulkPersonInfo();
applyBulkBusinessInfo();
applyBulkRelationInfo();

normalizeRelations();
sync();

if (typeof validateData === "function") {
  validationIssues = validateData();

  const result = document.getElementById("validationResult");
  if (result && result.innerHTML.trim()) {
    renderValidationResult(validationIssues);
  }
}

alert("一括編集表の内容を反映しました。");

return true;
}

function checkBulkEditInputsOnly() {
const checkResult = validateBulkEditBeforeApply();

if (!checkResult.errors.length && !checkResult.warnings.length) {
  alert("入力チェック完了: 問題は見つかりませんでした。");
  return true;
}

showBulkEditValidationMessage(checkResult, true);
return false;
}

function validateBulkEditBeforeApply() {
clearBulkEditInputMarks();

const errors = [];
const warnings = [];
const ids = new Set(people.map(p => p.id));

document.querySelectorAll("#bulkRelationTbody tr").forEach(tr => {
  const targetId = tr.dataset.id;
  const targetLabel = personLabel(targetId);

  const parent1Input = tr.querySelector('[data-field="parent1"]');
  const parent2Input = tr.querySelector('[data-field="parent2"]');
  const spousesInput = tr.querySelector('[data-field="spouses"]');

  const parent1 = normalizeIdInput(parent1Input?.value || "");
  const parent2 = normalizeIdInput(parent2Input?.value || "");

  const parentValues = [
    { value: parent1, input: parent1Input, label: "親1ID" },
    { value: parent2, input: parent2Input, label: "親2ID" }
  ];

  parentValues.forEach(item => {
    if (!item.value) return;

    if (!ids.has(item.value)) {
      markBulkInputError(item.input);
      errors.push({
        severity: "error",
        tab: "relation",
        input: item.input,
        message: `${targetLabel} の ${item.label} に存在しないID「${item.value}」が入力されています。`
      });
      return;
    }

    if (item.value === targetId) {
      markBulkInputError(item.input);
      errors.push({
        severity: "error",
        tab: "relation",
        input: item.input,
        message: `${targetLabel} の ${item.label} に自分自身のIDが入力されています。`
      });
    }
  });

  if (parent1 && parent2 && parent1 === parent2) {
    markBulkInputError(parent1Input);
    markBulkInputError(parent2Input);

    errors.push({
      severity: "error",
      tab: "relation",
      input: parent1Input,
      message: `${targetLabel} の 親1ID と 親2ID に同じID「${parent1}」が入力されています。`
    });
  }

  const spouseRawList = String(spousesInput?.value || "")
    .split(",")
    .map(x => x.trim())
    .filter(Boolean);

  const spouseSeen = new Set();

  spouseRawList.forEach(spouseId => {
    if (!ids.has(spouseId)) {
      markBulkInputError(spousesInput);
      errors.push({
        severity: "error",
        tab: "relation",
        input: spousesInput,
        message: `${targetLabel} の 配偶者ID に存在しないID「${spouseId}」が入力されています。`
      });
      return;
    }

    if (spouseId === targetId) {
      markBulkInputError(spousesInput);
      errors.push({
        severity: "error",
        tab: "relation",
        input: spousesInput,
        message: `${targetLabel} の 配偶者ID に自分自身のIDが入力されています。`
      });
      return;
    }

    if (spouseSeen.has(spouseId)) {
      markBulkInputWarning(spousesInput);
      warnings.push({
        severity: "warning",
        tab: "relation",
        input: spousesInput,
        message: `${targetLabel} の 配偶者ID に同じID「${spouseId}」が複数回入力されています。反映時には重複は整理されます。`
      });
      return;
    }

    spouseSeen.add(spouseId);

    if ([parent1, parent2].includes(spouseId)) {
      markBulkInputWarning(spousesInput);
      warnings.push({
        severity: "warning",
        tab: "relation",
        input: spousesInput,
        message: `${targetLabel} の 配偶者ID「${spouseId}」が親IDにも入力されています。意図した関係か確認してください。`
      });
    }
  });
});

return {
  errors,
  warnings
};
}

function clearBulkEditInputMarks() {
document.querySelectorAll(".bulk-input-error, .bulk-input-warning").forEach(el => {
  el.classList.remove("bulk-input-error", "bulk-input-warning");
});
}

function markBulkInputError(input) {
if (!input) return;
input.classList.remove("bulk-input-warning");
input.classList.add("bulk-input-error");
}

function markBulkInputWarning(input) {
if (!input) return;

if (input.classList.contains("bulk-input-error")) {
  return;
}

input.classList.add("bulk-input-warning");
}

function showBulkEditValidationMessage(checkResult, isManualCheck = false) {
const errors = checkResult.errors || [];
const warnings = checkResult.warnings || [];

const lines = [];

if (errors.length) {
  lines.push(`エラー ${errors.length}件`);
  lines.push(buildBulkEditIssueText(errors));
}

if (warnings.length) {
  if (lines.length) lines.push("");
  lines.push(`警告 ${warnings.length}件`);
  lines.push(buildBulkEditIssueText(warnings));
}

const prefix = isManualCheck
  ? "入力チェックの結果、確認が必要な項目があります。"
  : "一括編集表にエラーがあります。修正してから反映してください。";

alert(
  prefix +
  "\n\n" +
  lines.join("\n") +
  "\n\n問題のある入力欄を赤色または黄色で表示しています。"
);

switchBulkEditTab("relation");
focusFirstBulkEditIssue(checkResult);
}

function buildBulkEditIssueText(issues) {
const max = 12;
const list = issues.slice(0, max).map((issue, index) => {
  return `${index + 1}. ${issue.message}`;
});

if (issues.length > max) {
  list.push(`...ほか ${issues.length - max}件`);
}

return list.join("\n");
}

function focusFirstBulkEditIssue(checkResult) {
const first =
  (checkResult.errors && checkResult.errors[0]) ||
  (checkResult.warnings && checkResult.warnings[0]);

if (!first || !first.input) return;

setTimeout(() => {
  try {
    first.input.scrollIntoView({
      behavior: "smooth",
      block: "center",
      inline: "center"
    });
    first.input.focus();
  } catch {}
}, 100);
}


function applyBulkPersonInfo() {
document.querySelectorAll("#bulkPersonTbody tr").forEach(tr => {
  const id = tr.dataset.id;
  const p = person(id);
  if (!p) return;

  p.name = tr.querySelector('[data-field="name"]')?.value || "";
  p.gender = tr.querySelector('[data-field="gender"]')?.value || "";
  p.relation = tr.querySelector('[data-field="relation"]')?.value || "";
  p.address = tr.querySelector('[data-field="address"]')?.value || "";
  p.birth = tr.querySelector('[data-field="birth"]')?.value || "";
  p.death = tr.querySelector('[data-field="death"]')?.value || "";
});
}

function applyBulkBusinessInfo() {
document.querySelectorAll("#bulkBusinessTbody tr").forEach(tr => {
  const id = tr.dataset.id;
  const p = person(id);
  if (!p) return;

  p.renunciation = tr.querySelector('[data-field="renunciation"]')?.value || "未確認";
  p.representative = !!tr.querySelector('[data-field="representative"]')?.checked;
  p.taxpayer = !!tr.querySelector('[data-field="taxpayer"]')?.checked;
  p.manager = !!tr.querySelector('[data-field="manager"]')?.checked;
  p.share = tr.querySelector('[data-field="share"]')?.value || "";
});
}

function applyBulkRelationInfo() {
// 関係は表の内容を正とするため、一度クリアして再構築する
people.forEach(p => {
  p.parents = [];
  p.spouses = [];
});

families = [];

document.querySelectorAll("#bulkRelationTbody tr").forEach(tr => {
  const childId = tr.dataset.id;
  const child = person(childId);
  if (!child) return;

  const parent1 = normalizeIdInput(tr.querySelector('[data-field="parent1"]')?.value || "");
  const parent2 = normalizeIdInput(tr.querySelector('[data-field="parent2"]')?.value || "");

  const parentIds = unique([parent1, parent2])
    .filter(Boolean)
    .filter(pid => pid !== childId)
    .filter(pid => person(pid));

  if (parentIds.length) {
    const family = getOrCreateBulkFamily(parentIds);

    if (!family.children.includes(childId)) {
      family.children.push(childId);
    }
  }

  const spousesText = tr.querySelector('[data-field="spouses"]')?.value || "";
  const spouseIds = parseIdList(spousesText)
    .filter(sid => sid !== childId)
    .filter(sid => person(sid));

  spouseIds.forEach(spouseId => {
    getOrCreateBulkFamily([childId, spouseId]);
  });
});
}

function normalizeIdInput(value) {
return String(value || "").trim();
}

function parseIdList(value) {
return unique(
  String(value || "")
    .split(",")
    .map(x => x.trim())
    .filter(Boolean)
);
}

function getParentsForBulkEdit(childId) {
const parents = [];

families.forEach(f => {
  if ((f.children || []).includes(childId)) {
    (f.parents || []).forEach(pid => {
      if (!parents.includes(pid)) {
        parents.push(pid);
      }
    });
  }
});

const p = person(childId);
if (p && Array.isArray(p.parents)) {
  p.parents.forEach(pid => {
    if (!parents.includes(pid)) {
      parents.push(pid);
    }
  });
}

return parents.slice(0, 2);
}

function getOrCreateBulkFamily(parentIds) {
const normalizedParents = unique(parentIds)
  .filter(Boolean)
  .sort();

let family = families.find(f => {
  const current = unique(f.parents || []).sort();

  return current.length === normalizedParents.length &&
    current.every((id, index) => id === normalizedParents[index]);
});

if (family) {
  return family;
}

family = createBulkFamily(normalizedParents);
families.push(family);

return family;
}

function createBulkFamily(parentIds) {
if (typeof createFamily === "function") {
  return createFamily({
    id: nextBulkFamilyId(),
    parents: unique(parentIds),
    children: []
  });
}

return {
  id: nextBulkFamilyId(),
  parents: unique(parentIds),
  children: []
};
}

function nextBulkFamilyId() {
const used = new Set((families || []).map(f => f.id));

let n = 1;

while (used.has(`F${String(n).padStart(3, "0")}`)) {
  n++;
}

return `F${String(n).padStart(3, "0")}`;
}


function personLabel(id) {
const p = person(id);
if (!p) return id || "";

return `${p.id} ${p.name || "無名"}`;
}

function personDisplayName(id) {
  const p = person(id);
  return p ? p.name || "無名" : id || "";
}

function renderFamilyTable() {
const tbody = document.querySelector("#familyTable tbody");
if (!tbody) return;

tbody.innerHTML = "";

normalizeFamilies();

if (!families.length) {
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td colspan="5" style="text-align:center; color:#666;">
      登録されている関係はありません
    </td>
  `;
  tbody.appendChild(tr);
  return;
}

families.forEach(f => {
  const tr = document.createElement("tr");

  const parent1 = f.parents[0] || "";
  const parent2 = f.parents[1] || "";

  const childrenHtml = f.children.length
    ? f.children.map(cid => `
        <div style="margin-bottom:4px;">
          ${escapeHtml(personLabel(cid))}
          <button type="button" class="small danger" data-family-action="remove-child" data-child-id="${escapeAttr(cid)}">
            子関係解除
          </button>
        </div>
      `).join("")
    : `<span style="color:#777;">子なし</span>`;

  tr.innerHTML = `
    <td class="id-cell">${escapeHtml(f.id)}</td>
    <td>${escapeHtml(personLabel(parent1))}</td>
    <td>${escapeHtml(personLabel(parent2))}</td>
    <td>${childrenHtml}</td>
    <td>
      <button type="button" class="small danger" data-family-action="remove-family">
        この関係を削除
      </button>
    </td>
  `;

  // JSON由来のIDをJavaScript文字列へ埋め込まず、データとして渡す。
  tr.querySelectorAll('[data-family-action="remove-child"]').forEach(button => {
    button.addEventListener("click", () => removeChildFromFamily(f.id, button.dataset.childId));
  });
  tr.querySelector('[data-family-action="remove-family"]')
    .addEventListener("click", () => removeFamily(f.id));

  tbody.appendChild(tr);
});
}

function removeChildFromFamily(familyId, childId) {
const f = families.find(x => x.id === familyId);
if (!f) return;

const child = person(childId);
const childName = child ? `${child.id} ${child.name || "無名"}` : childId;

if (!confirm(`${childName} をこの親・夫婦関係から外しますか？\n人物ノード自体は削除されません。`)) {
  return;
}

f.children = f.children.filter(id => id !== childId);

// 子なしの1親familyは不要なので削除する。
// ただし、親が2人以上いるfamilyは夫婦関係として残す。
families = families.filter(x => x.children.length || x.parents.length >= 2);


normalizeRelations();
sync();
}

function removeFamily(familyId) {
const f = families.find(x => x.id === familyId);
if (!f) return;

const parentsText = f.parents.map(personLabel).join(" + ") || "親なし";
const childrenText = f.children.map(personLabel).join("、") || "子なし";

const message =
  `この関係を削除しますか？\n\n` +
  `親・夫婦: ${parentsText}\n` +
  `子: ${childrenText}\n\n` +
  `人物ノード自体は削除されません。\n` +
  `ただし、このfamilyに登録されている親子関係も解除されます。`;

if (!confirm(message)) {
  return;
}

families = families.filter(x => x.id !== familyId);

normalizeRelations();
sync();
}


let validationIssues = [];

function validateDataAndShow() {
validationIssues = validateData();
renderValidationResult(validationIssues);
}

function clearValidationResult() {
validationIssues = [];

const summary = document.getElementById("validationSummary");
const result = document.getElementById("validationResult");

if (summary) summary.innerHTML = "";
if (result) result.innerHTML = "";
}

function validateData() {
const issues = [];
const ids = new Set(people.map(p => p.id));

checkBasicPeopleData(issues, ids);
checkFamilyReferences(issues, ids);
checkDuplicateFamilies(issues);
checkChildrenInMultipleFamilies(issues);
checkParentChildCycles(issues);
checkBusinessFlags(issues);
checkShareFormat(issues);

return issues;
}

function addIssue(issues, severity, title, message, relatedIds = [], familyId = "") {
issues.push({
  severity,
  title,
  message,
  relatedIds: unique(relatedIds),
  familyId
});
}

function severityLabel(severity) {
if (severity === "error") return "エラー";
if (severity === "warning") return "警告";
return "注意";
}

function checkBasicPeopleData(issues, ids) {
people.forEach(p => {
  if (!p.id) {
    addIssue(
      issues,
      "error",
      "人物IDが空です",
      "IDが空の人物があります。データの保存・復元や関係管理に支障が出ます。",
      []
    );
    return;
  }

  if (!p.name || !p.name.trim()) {
    addIssue(
      issues,
      "info",
      "氏名が未入力です",
      `${p.id} の氏名が未入力です。`,
      [p.id]
    );
  }

// 人物側 parents の直接チェック
(p.parents || []).forEach(pid => {
  if (!ids.has(pid)) {
    addIssue(
      issues,
      "error",
      "存在しない親IDがあります",
      `${personLabel(p.id)} の親として存在しないID ${pid} が指定されています。`,
      [p.id]
    );
  }

  if (pid === p.id) {
    addIssue(
      issues,
      "error",
      "自分自身が親に指定されています",
      `${personLabel(p.id)} の親に自分自身が指定されています。`,
      [p.id]
    );
  }
});

// 人物側 spouses の直接チェック
(p.spouses || []).forEach(sid => {
  if (!ids.has(sid)) {
    addIssue(
      issues,
      "error",
      "存在しない配偶者IDがあります",
      `${personLabel(p.id)} の配偶者として存在しないID ${sid} が指定されています。`,
      [p.id]
    );
  }

  if (sid === p.id) {
    addIssue(
      issues,
      "error",
      "自分自身が配偶者に指定されています",
      `${personLabel(p.id)} の配偶者に自分自身が指定されています。`,
      [p.id]
    );
  }
});
});
}

function checkFamilyReferences(issues, ids) {
families.forEach(f => {
  const parentSet = new Set(f.parents || []);
  const childSet = new Set(f.children || []);

  if (!f.id) {
    addIssue(
      issues,
      "warning",
      "familyIDが空です",
      "familyIDが空の関係データがあります。保存・復元時の識別が難しくなる可能性があります。",
      [...parentSet, ...childSet]
    );
  }

  (f.parents || []).forEach(pid => {
    if (!ids.has(pid)) {
      addIssue(
        issues,
        "error",
        "familyが存在しない親IDを参照しています",
        `${f.id || "IDなしfamily"} の親として存在しないID ${pid} が指定されています。`,
        [],
        f.id
      );
    }
  });

  (f.children || []).forEach(cid => {
    if (!ids.has(cid)) {
      addIssue(
        issues,
        "error",
        "familyが存在しない子IDを参照しています",
        `${f.id || "IDなしfamily"} の子として存在しないID ${cid} が指定されています。`,
        [],
        f.id
      );
    }
  });

  // 自分が親かつ子
  (f.children || []).forEach(cid => {
    if (parentSet.has(cid)) {
      addIssue(
        issues,
        "error",
        "同一family内で親と子が重複しています",
        `${personLabel(cid)} が ${f.id} の親と子の両方に入っています。`,
        [cid, ...(f.parents || [])],
        f.id
      );
    }
  });

  // 親が同じ人物で重複
  if ((f.parents || []).length !== unique(f.parents || []).length) {
    addIssue(
      issues,
      "error",
      "family内で親IDが重複しています",
      `${f.id} の親IDに重複があります。`,
      f.parents || [],
      f.id
    );
  }

  // 子が同じ人物で重複
  if ((f.children || []).length !== unique(f.children || []).length) {
    addIssue(
      issues,
      "error",
      "family内で子IDが重複しています",
      `${f.id} の子IDに重複があります。`,
      f.children || [],
      f.id
    );
  }

  // 親が3人以上
  if ((f.parents || []).length >= 3) {
    addIssue(
      issues,
      "warning",
      "親・配偶者が3人以上のfamilyがあります",
      `${f.id} に親・配偶者が3人以上登録されています。再婚関係を別familyに分ける必要がないか確認してください。`,
      f.parents || [],
      f.id
    );
  }

  // 親なしで子だけ
  if (!(f.parents || []).length && (f.children || []).length) {
    addIssue(
      issues,
      "warning",
      "親なしで子だけのfamilyがあります",
      `${f.id} は親が登録されていない状態で子だけが登録されています。`,
      f.children || [],
      f.id
    );
  }
});
}

function checkDuplicateFamilies(issues) {
const map = new Map();

families.forEach(f => {
  const key = unique(f.parents || []).sort().join("|");

  if (!key) return;

  if (!map.has(key)) {
    map.set(key, []);
  }

  map.get(key).push(f);
});

map.forEach(list => {
  if (list.length <= 1) return;

  const familyIds = list.map(f => f.id || "IDなし").join(", ");
  const parentIds = list[0].parents || [];

  addIssue(
    issues,
    "warning",
    "同じ親ペアのfamilyが複数あります",
    `同じ親・配偶者の組み合わせで複数のfamilyがあります: ${familyIds}`,
    parentIds,
    list[0].id
  );
});
}

function checkChildrenInMultipleFamilies(issues) {
const childMap = new Map();

families.forEach(f => {
  (f.children || []).forEach(cid => {
    if (!childMap.has(cid)) {
      childMap.set(cid, []);
    }

    childMap.get(cid).push(f);
  });
});

childMap.forEach((list, childId) => {
  if (list.length <= 1) return;

  const familyIds = list.map(f => f.id || "IDなし").join(", ");

  addIssue(
    issues,
    "warning",
    "同じ子が複数のfamilyに所属しています",
    `${personLabel(childId)} が複数のfamilyに子として登録されています: ${familyIds}。養子縁組等で意図した登録か確認してください。`,
    [childId, ...list.flatMap(f => f.parents || [])],
    list[0].id
  );
});
}

function checkParentChildCycles(issues) {
  const graph = new Map();

  people.forEach(p => {
    graph.set(p.id, []);
  });

  families.forEach(f => {
    (f.parents || []).forEach(parentId => {
      if (!graph.has(parentId)) {
        graph.set(parentId, []);
      }

      (f.children || []).forEach(childId => {
        if (!graph.get(parentId).includes(childId)) {
          graph.get(parentId).push(childId);
        }
      });
    });
  });

  /*
   * state:
   * 0または未登録 = 未訪問
   * 1 = 現在の探索経路上
   * 2 = 探索完了
   */
  const state = new Map();
  const reportedCycles = new Set();

  for (const startId of graph.keys()) {
    if (state.get(startId) === 2) {
      continue;
    }

    const path = [];
    const pathIndex = new Map();

    /*
     * 再帰呼出しの代わりに、探索中のノードと
     * 次に調べる子の位置を明示的に保持する。
     */
    const stack = [
      {
        id: startId,
        nextChildIndex: 0,
        entered: false
      }
    ];

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const id = frame.id;

      if (!frame.entered) {
        frame.entered = true;
        state.set(id, 1);
        pathIndex.set(id, path.length);
        path.push(id);
      }

      const children = graph.get(id) || [];

      if (frame.nextChildIndex < children.length) {
        const childId = children[frame.nextChildIndex];
        frame.nextChildIndex++;

        const childState = state.get(childId) || 0;

        if (childState === 0) {
          stack.push({
            id: childId,
            nextChildIndex: 0,
            entered: false
          });
          continue;
        }

        /*
         * 探索中の経路上にあるノードへ戻った場合は循環。
         */
        if (childState === 1 && pathIndex.has(childId)) {
          const cycleStart = pathIndex.get(childId);
          const cycle = path.slice(cycleStart).concat(childId);

          /*
           * 同じ循環を異なる開始点から重複報告しないよう、
           * 循環部分のID集合を正規化して識別する。
           */
          const cycleKey = [...new Set(cycle)]
            .sort()
            .join("|");

          if (!reportedCycles.has(cycleKey)) {
            reportedCycles.add(cycleKey);

            addIssue(
              issues,
              "error",
              "親子関係が循環しています",
              `親子関係が循環しています: ${cycle
                .map(personLabel)
                .join(" → ")}`,
              [...new Set(cycle)]
            );
          }
        }

        continue;
      }

      /*
       * 全ての子を調査し終えたため、このノードの探索を完了する。
       */
      stack.pop();
      state.set(id, 2);
      pathIndex.delete(id);

      if (path[path.length - 1] === id) {
        path.pop();
      }
    }
  }
}


function checkBusinessFlags(issues) {
people.forEach(p => {
  if (p.death && p.representative) {
    addIssue(
      issues,
      "warning",
      "死亡者が代表相続人に設定されています",
      `${personLabel(p.id)} は死亡年月日が入力されていますが、代表相続人にも設定されています。`,
      [p.id]
    );
  }

  if (p.death && p.taxpayer) {
    addIssue(
      issues,
      "warning",
      "死亡者が納税義務者候補に設定されています",
      `${personLabel(p.id)} は死亡年月日が入力されていますが、納税義務者候補にも設定されています。`,
      [p.id]
    );
  }

  if (p.renunciation === "放棄済" && p.representative) {
    addIssue(
      issues,
      "warning",
      "相続放棄済の人物が代表相続人に設定されています",
      `${personLabel(p.id)} は相続放棄済ですが、代表相続人にも設定されています。`,
      [p.id]
    );
  }

  if (p.renunciation === "放棄済" && p.taxpayer) {
    addIssue(
      issues,
      "warning",
      "相続放棄済の人物が納税義務者候補に設定されています",
      `${personLabel(p.id)} は相続放棄済ですが、納税義務者候補にも設定されています。`,
      [p.id]
    );
  }

  if (p.renunciation === "放棄済" && p.share) {
    addIssue(
      issues,
      "warning",
      "相続放棄済の人物に共有持分が入力されています",
      `${personLabel(p.id)} は相続放棄済ですが、共有持分 ${p.share} が入力されています。`,
      [p.id]
    );
  }

  if (p.manager && !p.address) {
    addIssue(
      issues,
      "info",
      "納税管理人候補の住所が未入力です",
      `${personLabel(p.id)} は納税管理人候補ですが、住所が未入力です。`,
      [p.id]
    );
  }
});
}

function checkShareFormat(issues) {
people.forEach(p => {
  const share = String(p.share || "").trim();

  if (!share) return;

  const patterns = [
    /^\d+\/\d+$/,
    /^\d+分の\d+$/,
    /^\d+\s*\/\s*\d+$/,
    /^\d+％$/,
    /^\d+%$/,
    /^全部$/,
    /^なし$/
  ];

  const ok = patterns.some(re => re.test(share));

  if (!ok) {
    addIssue(
      issues,
      "info",
      "共有持分の形式を確認してください",
      `${personLabel(p.id)} の共有持分「${share}」の形式を確認してください。例: 1/2、3分の1、50%、全部`,
      [p.id]
    );
  }
});
}

function renderValidationResult(issues) {
const summary = document.getElementById("validationSummary");
const result = document.getElementById("validationResult");

if (!summary || !result) return;

const errorCount = issues.filter(x => x.severity === "error").length;
const warningCount = issues.filter(x => x.severity === "warning").length;
const infoCount = issues.filter(x => x.severity === "info").length;

if (!issues.length) {
  summary.innerHTML = `<span class="validation-summary-ok">チェック完了: 問題は見つかりませんでした。</span>`;
  result.innerHTML = "";
  return;
}

let summaryClass = "validation-summary-warning";

if (errorCount > 0) {
  summaryClass = "validation-summary-error";
}

summary.innerHTML = `
  <span class="${summaryClass}">
    チェック完了:
    エラー ${errorCount}件 /
    警告 ${warningCount}件 /
    注意 ${infoCount}件
  </span>
`;

result.innerHTML = `
  <div class="validation-list">
    ${issues.map((issue, index) => renderValidationItem(issue, index)).join("")}
  </div>
`;
}

function renderValidationItem(issue, index) {
const relatedText = issue.relatedIds && issue.relatedIds.length
  ? issue.relatedIds.map(personLabel).join("、")
  : "";

const familyText = issue.familyId
  ? `family: ${issue.familyId}`
  : "";

const meta = [familyText, relatedText ? `関連人物: ${relatedText}` : ""]
  .filter(Boolean)
  .join(" / ");

return `
  <div class="validation-item ${escapeAttr(issue.severity)}">
    <div class="validation-title">
      [${escapeHtml(severityLabel(issue.severity))}] ${escapeHtml(issue.title)}
    </div>
    <div class="validation-message">
      ${escapeHtml(issue.message)}
    </div>
    ${meta ? `<div class="hint">${escapeHtml(meta)}</div>` : ""}
    <div class="validation-actions">
      ${issue.relatedIds && issue.relatedIds.length
        ? `<button onclick="focusValidationIssue(${index})">関連人物へ移動</button>`
        : ""}
    </div>
  </div>
`;
}

function focusValidationIssue(index) {
const issue = validationIssues[index];
if (!issue || !issue.relatedIds || !issue.relatedIds.length) return;

const validIds = issue.relatedIds.filter(id => person(id));

if (!validIds.length) return;

selectedIds = new Set(validIds);
selectedId = validIds[0];

selectedAnnotationId = null;
selectedAnnotationIds.clear();

renderList();
loadPersonForm();
renderChart();

if (typeof focusSelected === "function") {
  focusSelected();
}
}

function option(value, current, label) {
const text = label ?? (value || "未設定");

return `
  <option value="${escapeAttr(value)}" ${value === current ? "selected" : ""}>
    ${escapeHtml(text)}
  </option>
`;
}


function applyTable() {
const rows = [...document.querySelectorAll("#dataTable tbody tr")];
const ids = new Set(people.map(p => p.id));

const nextFamilies = [];

function getTableFamily(parentIds) {
  const clean = unique(parentIds).filter(x => ids.has(x));

  let f = nextFamilies.find(x => sameIdSet(x.parents, clean));

  if (!f) {
    f = createFamily({
      parents: clean,
      children: []
    });
    nextFamilies.push(f);
  }

  return f;
}

rows.forEach(tr => {
  const id = tr.dataset.id;
  const p = person(id);
  if (!p) return;

  const name = tr.querySelector('[data-field="name"]').value;
  const gender = tr.querySelector('[data-field="gender"]')?.value || "";
  const relation = tr.querySelector('[data-field="relation"]')?.value || "";

  const parent1 = tr.querySelector('[data-field="parent1"]').value.trim();
  const parent2 = tr.querySelector('[data-field="parent2"]').value.trim();


  const parents = unique([parent1, parent2])
    .filter(x => ids.has(x) && x !== id);

  const spouses = parseIds(tr.querySelector('[data-field="spouses"]').value)
    .filter(x => ids.has(x) && x !== id);

  const deathCheck = tr.querySelector('[data-field="deathCheck"]').checked;
  const renunciation = tr.querySelector('[data-field="renunciation"]').value;
  const representative = tr.querySelector('[data-field="representative"]').checked;
  const share = tr.querySelector('[data-field="share"]').value;

  p.name = name;
  p.gender = gender;
  p.relation = relation;
  p.death = deathCheck ? (p.death || "不明") : "";
  p.renunciation = renunciation;
  p.representative = representative;
  p.share = share;

  // 親子関係
  if (parents.length) {
    const f = getTableFamily(parents);
    if (!f.children.includes(id)) {
      f.children.push(id);
    }
  }

  // 配偶者関係
  spouses.forEach(sid => {
    getTableFamily([id, sid]);
  });
});

families = nextFamilies;
familyModelInitialized = true;

normalizeRelations();
sync();
}

function renderChart() {
  updateAllAttachedArrows();
  const activeInlineEditor =
    document.activeElement?.id === "annotationInlineEditor"
      ? document.activeElement
      : null;
  const selectionStart = activeInlineEditor?.selectionStart ?? null;
  const selectionEnd = activeInlineEditor?.selectionEnd ?? null;
  renderingChart = true;
  viewport.innerHTML = "";
  renderingChart = false;

  const emptyState = document.getElementById("canvasEmptyState");
  if (emptyState) {
    emptyState.hidden = people.length > 0;
  }

  const rect = svg.getBoundingClientRect();
  const width = Math.max(
    1,
    rect.width || 1000
  );
  const height = Math.max(
    1,
    rect.height || 700
  );

  svg.setAttribute(
    "viewBox",
    `0 0 ${width} ${height}`
  );

  viewport.setAttribute(
    "transform",
    `translate(${offsetX}, ${offsetY}) scale(${scale})`
  );

  /* 背面図形、関係線、人物、前面注釈、操作ハンドルの順に描画する。 */
  drawAnnotations("back");
  drawRelations();
  drawRelationPreview();
  drawNodes();
  drawAnnotations("front");
  drawAnnotationCreatePreview();
  drawNodeHitTargets();
  drawAnnotationSelectionOverlays();

  /*
   * 最前面へ選択矩形を描画する。
   */
  drawMarqueeSelection();
  drawAnnotationTextEditor();

  if (activeInlineEditor && annotationTextEdit) {
    const editor = document.getElementById("annotationInlineEditor");
    if (editor) {
      editor.focus({ preventScroll: true });
      if (selectionStart !== null && selectionEnd !== null) {
        editor.setSelectionRange(
          Math.min(selectionStart, editor.value.length),
          Math.min(selectionEnd, editor.value.length)
        );
      }
    }
  }
}

function drawMarqueeSelection() {
  if (!marqueeSelecting) {
    return;
  }

  const bounds =
    getMarqueeBounds(marqueeSelecting);

  viewport.appendChild(svgEl("rect", {
    x: bounds.minX,
    y: bounds.minY,
    width: Math.max(
      1,
      bounds.maxX - bounds.minX
    ),
    height: Math.max(
      1,
      bounds.maxY - bounds.minY
    ),
    class: "marquee-selection"
  }));
}


function drawRelations() {
  normalizeFamilies();

  families.forEach(f => {
    const parents = f.parents.map(person).filter(Boolean);
    const children = f.children.map(person).filter(Boolean);

    if (!parents.length) return;

    const anchor = getFamilyAnchor(f);

    // 夫婦線
    if (parents.length >= 2) {
      const sorted = [...parents].sort((a, b) => a.x - b.x);
      const left = sorted[0];
      const right = sorted[1];

      const x1 = left.x + NODE_W;
      const x2 = right.x;
      const y = (left.y + NODE_H / 2 + right.y + NODE_H / 2) / 2;

      const l1 = drawLine(x1, y - 4, x2, y - 4, "spouse-line");
      const l2 = drawLine(x1, y + 4, x2, y + 4, "spouse-line");

      attachRelationContextMenu(l1, {
        type: "family",
        familyId: f.id
      });

      attachRelationContextMenu(l2, {
        type: "family",
        familyId: f.id
      });

    }

    // 子への線
    children.forEach(child => {
      const endX = child.x + NODE_W / 2;
      const endY = child.y;

      const startX = anchor.x;
      const startY = anchor.y;

      const midY = (startY + endY) / 2;

      const childPath = drawPath(
        `M ${startX} ${startY}
        L ${startX} ${midY}
        L ${endX} ${midY}
        L ${endX} ${endY}`,
        "child-line"
      );

      attachRelationContextMenu(childPath, {
        type: "child",
        familyId: f.id,
        childId: child.id
      });
    });
  });
}

function attachRelationContextMenu(el, info) {
if (!el) return;

el.addEventListener("contextmenu", e => {
  e.preventDefault();
  e.stopPropagation();

  if (info.type === "family") {
    const f = families.find(x => x.id === info.familyId);
    if (!f) return;

    const parentsText = f.parents.map(personLabel).join(" + ") || "親なし";
    const childrenText = f.children.map(personLabel).join("、") || "子なし";

    const message =
      `この夫婦・親ペア関係を削除しますか？\n\n` +
      `親・夫婦: ${parentsText}\n` +
      `子: ${childrenText}\n\n` +
      `人物ノード自体は削除されません。\n` +
      `このfamilyに含まれる親子関係も解除されます。`;

    if (!confirm(message)) return;

    pushUndo("夫婦・親ペア関係削除前");
    families = families.filter(x => x.id !== info.familyId);

    normalizeRelations();
    sync();
    return;
  }

  if (info.type === "child") {
    const f = families.find(x => x.id === info.familyId);
    if (!f) return;

    const childName = personLabel(info.childId);
    const parentsText = f.parents.map(personLabel).join(" + ") || "親なし";

    const message =
      `この親子関係を解除しますか？\n\n` +
      `親・夫婦: ${parentsText}\n` +
      `子: ${childName}\n\n` +
      `人物ノード自体は削除されません。`;

    if (!confirm(message)) return;

    pushUndo("親子関係削除前");
    f.children = f.children.filter(id => id !== info.childId);

    // 子なしの1親familyは不要なので削除する。
    // ただし、親が2人以上いるfamilyは夫婦関係として残す。
    families = families.filter(x => x.children.length || x.parents.length >= 2);

    normalizeRelations();
    sync();
  }
});
}

function drawRelationPreview() {
if (!relationMode || !relationClicks.length || !relationPreviewMouse) return;

const mouse = relationPreviewMouse;

if (relationMode === "spouse") {
  const p1 = person(relationClicks[0]);
  if (!p1) return;

  const start = nodeCenter(p1);
  drawPreviewPath(`M ${start.x} ${start.y} L ${mouse.x} ${mouse.y}`);
  drawPreviewCircle(start.x, start.y);
  return;
}

if (relationMode === "child1") {
  const parent = person(relationClicks[0]);
  if (!parent) return;

  const start = {
    x: parent.x + NODE_W / 2,
    y: parent.y + NODE_H
  };

  drawPreviewPath(`M ${start.x} ${start.y} L ${start.x} ${(start.y + mouse.y) / 2} L ${mouse.x} ${(start.y + mouse.y) / 2} L ${mouse.x} ${mouse.y}`);
  drawPreviewCircle(start.x, start.y);
  return;
}

if (relationMode === "child2") {
  if (relationClicks.length === 1) {
    const p1 = person(relationClicks[0]);
    if (!p1) return;

    const start = nodeCenter(p1);
    drawPreviewPath(`M ${start.x} ${start.y} L ${mouse.x} ${mouse.y}`);
    drawPreviewCircle(start.x, start.y);
    return;
  }

  if (relationClicks.length >= 2) {
    const tempFamily = {
      parents: [relationClicks[0], relationClicks[1]],
      children: []
    };

    const anchor = getFamilyAnchor(tempFamily);
    drawPreviewPath(`M ${anchor.x} ${anchor.y} L ${anchor.x} ${(anchor.y + mouse.y) / 2} L ${mouse.x} ${(anchor.y + mouse.y) / 2} L ${mouse.x} ${mouse.y}`);
    drawPreviewCircle(anchor.x, anchor.y);
  }
}
}

function nodeCenter(p) {
  return {
    x: p.x + NODE_W / 2,
    y: p.y + NODE_H / 2
  };
}

function getPersonAnchorPoint(p, anchorName) {
  const anchors = {
    top: {
      x: p.x + NODE_W / 2,
      y: p.y
    },
    right: {
      x: p.x + NODE_W,
      y: p.y + NODE_H / 2
    },
    bottom: {
      x: p.x + NODE_W / 2,
      y: p.y + NODE_H
    },
    left: {
      x: p.x,
      y: p.y + NODE_H / 2
    },
    center: {
      x: p.x + NODE_W / 2,
      y: p.y + NODE_H / 2
    }
  };

  return anchors[anchorName] || anchors.center;
}

function findNearestPersonAnchor(worldX, worldY, threshold = 34) {
  let best = null;

  people.forEach(p => {
    ["top", "right", "bottom", "left"].forEach(anchorName => {
      const point = getPersonAnchorPoint(p, anchorName);
      const distance = Math.hypot(
        worldX - point.x,
        worldY - point.y
      );

      if (
        distance <= threshold &&
        (!best || distance < best.distance)
      ) {
        best = {
          personId: p.id,
          anchorName,
          x: point.x,
          y: point.y,
          distance
        };
      }
    });
  });

  return best;
}

function updateAttachedArrowCoordinates(item) {
  if (!item || item.type !== "arrow") {
    return;
  }

  let startX = item.x;
  let startY = item.y;
  let endX = item.x + item.width;
  let endY = item.y + item.height;

  const startPerson = person(item.startPersonId);

  if (startPerson) {
    const point = getPersonAnchorPoint(
      startPerson,
      item.startAnchor
    );

    startX = point.x;
    startY = point.y;
  } else {
    item.startPersonId = "";
    item.startAnchor = "";
  }

  const endPerson = person(item.endPersonId);

  if (endPerson) {
    const point = getPersonAnchorPoint(
      endPerson,
      item.endAnchor
    );

    endX = point.x;
    endY = point.y;
  } else {
    item.endPersonId = "";
    item.endAnchor = "";
  }

  item.x = startX;
  item.y = startY;
  item.width = endX - startX;
  item.height = endY - startY;
}

function updateAllAttachedArrows() {
  annotations.forEach(item => {
    updateAttachedArrowCoordinates(item);
  });
}

function drawPreviewPath(d) {
const path = svgEl("path", {
  d,
  class: "preview-line"
});

viewport.appendChild(path);
}

function drawPreviewCircle(x, y) {
const c = svgEl("circle", {
  cx: x,
  cy: y,
  r: 5,
  class: "preview-anchor"
});

viewport.appendChild(c);
}

function getFamilyAnchor(f) {
const parents = f.parents.map(person).filter(Boolean);

if (!parents.length) {
  return { x: 0, y: 0 };
}

if (parents.length >= 2) {
  const avgX = parents.reduce((sum, p) => sum + p.x + NODE_W / 2, 0) / parents.length;
  const maxY = Math.max(...parents.map(p => p.y));

  return {
    x: avgX,
    y: maxY + NODE_H / 2 + 12
  };
}

const p = parents[0];

return {
  x: p.x + NODE_W / 2,
  y: p.y + NODE_H
};
}

function getSpousePairs() {
const pairs = [];
const seen = new Set();

people.forEach(p => {
  (p.spouses || []).forEach(sid => {
    const s = person(sid);
    if (!s) return;

    const key = [p.id, s.id].sort().join("-");
    if (seen.has(key)) return;

    seen.add(key);
    pairs.push([p, s]);
  });
});

return pairs;
}

function drawNodes() {
people.forEach(p => {
  const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
  g.classList.add("node");

  const selected = isSelected(p.id);

  if (selected) {
    g.classList.add("selected");

    if (selectedIds.size > 1) {
      g.classList.add("multi-selected");
    }

    if (p.id === selectedId) {
      g.classList.add("primary-selected");
    }
  }

  if (relationClicks.includes(p.id)) {
    g.classList.add("pending");
  }

  if (p.id === arrowSnapTargetId) {
    g.classList.add("arrow-snap-target");
  }

  if (p.gender === "男性") {
    g.classList.add("male");
  } else if (p.gender === "女性") {
    g.classList.add("female");
  } else {
    g.classList.add("unknown-gender");
  }

  if (p.death) g.classList.add("deceased");
  if (p.renunciation === "放棄済") g.classList.add("renounced");
  if (p.representative) g.classList.add("representative");
  if (p.taxpayer) g.classList.add("taxpayer");

  g.setAttribute("transform", `translate(${p.x}, ${p.y})`);

  const rect = svgEl("rect", {
    x: 0,
    y: 0,
    width: NODE_W,
    height: NODE_H
  });

  const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
  title.textContent = buildNodeTooltipText(p);

  const line1 = svgText(
    compactNodeText(p.name || "無名", 13),
    10,
    20,
    "name"
  );

  const relationGenderText = [
    p.relation || "",
    p.gender ? `性別:${p.gender}` : ""
  ].filter(Boolean).join(" / ");

  const line2 = svgText(
    compactNodeText(relationGenderText, 24),
    10,
    38,
    "sub"
  );

  const dateText = buildNodeDateText(p);

  const line3 = svgText(
    compactNodeText(dateText, 28),
    10,
    56,
    p.death ? "sub important" : "sub"
  );

  const addressText = buildNodeAddressText(p);

  const line4 = svgText(
    compactNodeText(addressText, 24),
    10,
    74,
    "sub"
  );

  const flags = [];

  if (p.renunciation && p.renunciation !== "なし") {
    flags.push("放棄:" + p.renunciation);
  }

  if (p.representative) {
    flags.push("代表相続人");
  }

  if (p.share) {
    flags.push("持分 " + p.share);
  }

  const line5 = svgText(
    compactNodeText(flags.join(" / "), 26),
    10,
    92,
    "sub"
  );

  const flags2 = [];

  if (p.taxpayer) {
    flags2.push("納税義務者候補");
  }

  if (p.manager) {
    flags2.push("納税管理人候補");
  }

  const line6 = svgText(
    compactNodeText(flags2.join(" / "), 26),
    10,
    110,
    "sub"
  );

  g.appendChild(title);
  g.appendChild(rect);
  g.appendChild(line1);
  g.appendChild(line2);
  g.appendChild(line3);
  g.appendChild(line4);
  g.appendChild(line5);
  g.appendChild(line6);

  bindPersonNodeEvents(g, p.id);
  viewport.appendChild(g);
});
}

function bindPersonNodeEvents(target, id) {
  target.dataset.id = id;
  target.addEventListener("pointerdown", startDrag);

  target.addEventListener("click", e => {
    e.stopPropagation();

    /*
     * 関係作成モードでは、クリックを関係登録に使う。
     * 通常の人物選択はstartDrag()のpointerdownで完了している。
     */
    if (relationMode) {
      handleRelationNodeClick(id, e);
    }
  });

  target.addEventListener("contextmenu", e => {
    e.preventDefault();
    e.stopPropagation();
    showNodeContextMenu(id, e.clientX, e.clientY);
  });
}

function drawNodeHitTargets() {
  if (!annotations.length || annotationTool) return;

  people.forEach(p => {
    const target = svgEl("rect", {
      x: p.x,
      y: p.y,
      width: NODE_W,
      height: NODE_H,
      rx: 8,
      ry: 8,
      fill: "transparent",
      class: "node-hit-target"
    });

    bindPersonNodeEvents(target, p.id);
    viewport.appendChild(target);
  });
}

function svgEl(name, attrs) {
const el = document.createElementNS("http://www.w3.org/2000/svg", name);
Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
return el;
}

function svgText(text, x, y, cls) {
const t = svgEl("text", { x, y });
t.textContent = text;
t.setAttribute("class", cls);
return t;
}

function drawLine(x1, y1, x2, y2, cls) {
const line = svgEl("line", { x1, y1, x2, y2, class: cls });
viewport.appendChild(line);
return line;
}

function drawPath(d, cls) {
const path = svgEl("path", { d, class: cls });
viewport.appendChild(path);
return path;
}

let dragging = null;

function startDrag(e) {
  if (relationMode) {
    e.stopPropagation();
    return;
  }

  if (
    e.button !== undefined &&
    e.button !== 0
  ) {
    return;
  }

  e.preventDefault();
  e.stopPropagation();

  const id = e.currentTarget.dataset.id;
  const p = person(id);

  if (!p) {
    return;
  }

  const isMultiKey =
    e.ctrlKey ||
    e.shiftKey ||
    e.metaKey;

  if (isMultiKey) {
    togglePersonSelection(id);

    /*
     * 選択済み人物を解除した場合は、
     * その人物のドラッグを開始しない。
     */
    if (!selectedIds.has(id)) {
      renderList();
      loadPersonForm();
      renderChart();
      return;
    }
  } else if (!selectedIds.has(id)) {
    selectOnly(id);
  } else {
    selectedId = id;
  }

  const point = clientToWorld(
    e.clientX,
    e.clientY
  );

  const targetIds = selectedIds.size
    ? [...selectedIds]
    : [id];

  dragging = {
    ids: targetIds,
    startWorldX: point.x,
    startWorldY: point.y,
    beforeSnapshot: makeSnapshot("ノード移動前"),
    moved: false,

    items: targetIds
      .map(personId => {
        const target = person(personId);

        if (!target) {
          return null;
        }

        return {
          id: personId,
          x: target.x,
          y: target.y
        };
      })
      .filter(Boolean)
  };

  svg.setPointerCapture(e.pointerId);
  svg.addEventListener(
    "pointermove",
    dragMove
  );
  svg.addEventListener(
    "pointerup",
    endDrag
  );

  renderList();
  loadPersonForm();
  renderChart();
}


function dragMove(e) {
if (!dragging) return;

const pt = clientToWorld(e.clientX, e.clientY);
const dx = pt.x - dragging.startWorldX;
const dy = pt.y - dragging.startWorldY;

if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
  dragging.moved = true;
}

dragging.items.forEach(item => {
  const p = person(item.id);
  if (!p) return;

  p.x = item.x + dx;
  p.y = item.y + dy;
});

renderChart();
}

function endDrag(e) {
if (dragging && dragging.moved && dragging.beforeSnapshot) {
  undoStack.push(dragging.beforeSnapshot);

  if (undoStack.length > UNDO_LIMIT) {
    undoStack.shift();
  }

  redoStack.length = 0;
}

dragging = null;

try {
  svg.releasePointerCapture(e.pointerId);
} catch {}

svg.removeEventListener("pointermove", dragMove);
svg.removeEventListener("pointerup", endDrag);

sync();
}

let panning = null;
let marqueeSelecting = null;
let suppressNextSvgClick = false;

function startPan(e) {
  /*
   * 図形追加モード中は、パンではなく図形作成を開始する。
   * テキストだけはclickイベントで作成する。
   */
  if (
    annotationTool &&
    annotationTool !== "text"
  ) {
    startAnnotationCreate(e);
    return;
  }

  /*
   * ノード・注釈上では、パンや矩形選択を開始しない。
   */
  if (
    e.target.closest &&
    (
      e.target.closest(".node") ||
      e.target.closest(".annotation")
    )
  ) {
    return;
  }

  if (annotationTool === "text") {
    return;
  }

  if (
    e.button !== undefined &&
    e.button !== 0
  ) {
    return;
  }

  /*
   * Shift + 背景ドラッグで矩形選択を開始する。
   */
  if (e.shiftKey) {
    startMarqueeSelection(e);
    return;
  }

  /*
   * 通常の背景ドラッグは従来どおりパンする。
   */
  panning = {
    startX: e.clientX,
    startY: e.clientY,
    originX: offsetX,
    originY: offsetY,
    moved: false
  };

  svg.classList.add("panning");
  svg.setPointerCapture(e.pointerId);

  svg.addEventListener(
    "pointermove",
    panMove
  );

  svg.addEventListener(
    "pointerup",
    endPan
  );
}


function panMove(e) {
if (!panning) return;

const dx = e.clientX - panning.startX;
const dy = e.clientY - panning.startY;

if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
  panning.moved = true;
}

offsetX = panning.originX + dx;
offsetY = panning.originY + dy;

renderChart();
}

function endPan(e) {
if (panning && panning.moved) {
  suppressNextSvgClick = true;
}

panning = null;

svg.classList.remove("panning");

try {
  svg.releasePointerCapture(e.pointerId);
} catch {}

svg.removeEventListener("pointermove", panMove);
svg.removeEventListener("pointerup", endPan);
}

function startMarqueeSelection(event) {
  event.preventDefault();
  event.stopPropagation();

  const point = clientToWorld(
    event.clientX,
    event.clientY
  );

  marqueeSelecting = {
    startX: point.x,
    startY: point.y,
    endX: point.x,
    endY: point.y,
    pointerId: event.pointerId,
    moved: false,

    /*
     * CtrlまたはCommand併用時は、
     * 既存選択へ追加する。
     */
    additive:
      event.ctrlKey ||
      event.metaKey,

    originalPersonIds:
      new Set(selectedIds),

    originalAnnotationIds:
      new Set(selectedAnnotationIds)
  };

  svg.classList.add("marquee-selecting");
  svg.setPointerCapture(event.pointerId);

  svg.addEventListener(
    "pointermove",
    moveMarqueeSelection
  );

  svg.addEventListener(
    "pointerup",
    endMarqueeSelection
  );

  renderChart();
}

function moveMarqueeSelection(event) {
  if (!marqueeSelecting) {
    return;
  }

  const point = clientToWorld(
    event.clientX,
    event.clientY
  );

  marqueeSelecting.endX = point.x;
  marqueeSelecting.endY = point.y;

  const distance = Math.hypot(
    marqueeSelecting.endX -
      marqueeSelecting.startX,
    marqueeSelecting.endY -
      marqueeSelecting.startY
  );

  if (distance > 3 / Math.max(scale, 0.01)) {
    marqueeSelecting.moved = true;
  }

  renderChart();
}

function endMarqueeSelection(event) {
  const state = marqueeSelecting;
  marqueeSelecting = null;

  svg.classList.remove("marquee-selecting");

  try {
    svg.releasePointerCapture(event.pointerId);
  } catch {}

  svg.removeEventListener(
    "pointermove",
    moveMarqueeSelection
  );

  svg.removeEventListener(
    "pointerup",
    endMarqueeSelection
  );

  if (!state || !state.moved) {
    renderChart();
    return;
  }

  const bounds =
    getMarqueeBounds(state);

  const foundIds =
    getPeopleInMarquee(bounds);

  if (state.additive) {
    selectedIds = new Set([
      ...state.originalPersonIds,
      ...foundIds
    ]);
  } else {
    selectedIds =
      new Set(foundIds);
  }

  selectedId = selectedIds.size
    ? [...selectedIds][0]
    : null;

  selectedAnnotationId = null;
  selectedAnnotationIds.clear();

  suppressNextSvgClick = true;

  renderList();
  loadPersonForm();
  renderChart();
}


function getMarqueeBounds(state) {
  return {
    minX: Math.min(
      state.startX,
      state.endX
    ),
    minY: Math.min(
      state.startY,
      state.endY
    ),
    maxX: Math.max(
      state.startX,
      state.endX
    ),
    maxY: Math.max(
      state.startY,
      state.endY
    )
  };
}

function boundsIntersect(a, b) {
  return !(
    a.maxX < b.minX ||
    a.minX > b.maxX ||
    a.maxY < b.minY ||
    a.minY > b.maxY
  );
}

function getPeopleInMarquee(bounds) {
  return people
    .filter(p => {
      const personBounds = {
        minX: p.x,
        minY: p.y,
        maxX: p.x + NODE_W,
        maxY: p.y + NODE_H
      };

      return boundsIntersect(
        bounds,
        personBounds
      );
    })
    .map(p => p.id);
}


function clientToWorld(clientX, clientY) {
const rect = svg.getBoundingClientRect();
return {
  x: (clientX - rect.left - offsetX) / scale,
  y: (clientY - rect.top - offsetY) / scale
};
}

function arrangeSelectedFamily() {
  const p = person(selectedId);

  if (!p) {
    alert("整列する人物を選択してください。");
    return false;
  }

  normalizeRelations();

  /*
   * 選択人物が参加しているfamilyを取得する。
   * 親・配偶者側、子側のどちらも対象。
   */
  const relatedFamilies = families.filter(f =>
    (f.parents || []).includes(p.id) ||
    (f.children || []).includes(p.id)
  );

  if (!relatedFamilies.length) {
    alert(
      `${personLabel(p.id)} には家族関係が登録されていません。\n\n` +
      "夫婦関係または親子関係を登録してから整列してください。"
    );

    return false;
  }

  /*
   * 選択人物が親・配偶者側に入っているfamilyを優先する。
   */
  const parentSideFamily =
    relatedFamilies.find(f =>
      (f.parents || []).includes(p.id)
    ) || null;

  /*
   * 選択人物が子の場合は、その親familyを使う。
   */
  const childSideFamily =
    relatedFamilies.find(f =>
      (f.children || []).includes(p.id)
    ) || null;

  const targetFamily =
    parentSideFamily ||
    childSideFamily;

  if (!targetFamily) {
    return false;
  }

  const parents = (targetFamily.parents || [])
    .map(person)
    .filter(Boolean);

  const children = (targetFamily.children || [])
    .map(person)
    .filter(Boolean);

  /*
   * 現在のfamily全体の左上位置を基準にする。
   * 原点や画面左上へ突然移動させない。
   */
  const members = unique([
    ...(targetFamily.parents || []),
    ...(targetFamily.children || [])
  ])
    .map(person)
    .filter(Boolean);

  const currentBounds =
    getPeopleBounds(members);

  const layoutReference =
    captureLayoutReference();
  const baseX = currentBounds.minX;
  const baseY = currentBounds.minY;

  /*
   * 親・配偶者を同じ行へ並べる。
   */
  parents
    .sort((a, b) => a.x - b.x)
    .forEach((parent, index) => {
      parent.x =
        baseX +
        index * (NODE_W + SPOUSE_GAP);

      parent.y = baseY;
    });

  /*
   * 子を親・配偶者の中央下へ並べる。
   */
  if (children.length) {
    const parentCenterX =
      parents.length
        ? parents.reduce(
            (sum, parent) =>
              sum + parent.x + NODE_W / 2,
            0
          ) / parents.length
        : baseX + NODE_W / 2;

    const totalChildrenWidth =
      children.length * NODE_W +
      Math.max(
        0,
        children.length - 1
      ) * CHILD_GAP;

    const childStartX =
      parentCenterX -
      totalChildrenWidth / 2;

    children
      .sort((a, b) => a.x - b.x)
      .forEach((child, index) => {
        child.x =
          childStartX +
          index * (NODE_W + CHILD_GAP);

        child.y =
          baseY + LEVEL_GAP;
      });
  }

  moveAnnotationsAfterAutoLayout(
    layoutReference
  );
  sync();
  return true;
}

function arrangeSelectedPeople() {
  const selectedPersonIds = unique([
    ...selectedIds,
    ...(selectedId ? [selectedId] : [])
  ]).filter(id => person(id));
  const selectedPeople = selectedPersonIds
    .map(person)
    .filter(Boolean);

  if (selectedPeople.length < 2) {
    alert("整列する人物を2人以上選択してください。");
    return false;
  }

  normalizeRelations();

  const selectedIdSet = new Set(
    selectedPeople.map(p => p.id)
  );
  const selectedFamilies = families
    .map(family => ({
      parents: (family.parents || []).filter(id =>
        selectedIdSet.has(id)
      ),
      children: (family.children || []).filter(id =>
        selectedIdSet.has(id)
      )
    }))
    .filter(family =>
      family.parents.length >= 2 ||
      (family.parents.length > 0 && family.children.length > 0)
    );
  const bounds = getPeopleBounds(selectedPeople);
  const layoutReference =
    captureLayoutReference();
  const positions = calculateAutoLayout(
    selectedPeople,
    selectedFamilies,
    {
      startX: bounds.minX,
      startY: bounds.minY
    }
  );

  selectedPeople.forEach(p => {
    const position = positions.get(p.id);
    if (!position) return;
    p.x = position.x;
    p.y = position.y;
  });

  moveAnnotationsAfterAutoLayout(
    layoutReference
  );

  sync();
  return true;
}




function captureLayoutReference() {
  updateAllAttachedArrows();

  return {
    people: new Map(
      people.map(p => [
        p.id,
        {
          x: p.x,
          y: p.y,
          centerX: p.x + NODE_W / 2,
          centerY: p.y + NODE_H / 2
        }
      ])
    ),

    annotations: new Map(
      annotations.map(item => [
        item.id,
        {
          x: item.x,
          y: item.y,
          width: item.width,
          height: item.height,

          centerX:
            item.x + item.width / 2,

          centerY:
            item.y + item.height / 2,

          startPersonId:
            item.startPersonId || "",

          endPersonId:
            item.endPersonId || ""
        }
      ])
    )
  };
}

function findNearestPersonIdFromReference(
  annotationReference,
  peopleReference
) {
  let nearestId = null;
  let nearestDistance = Infinity;

  peopleReference.forEach(
    (personReference, personId) => {
      const distance = Math.hypot(
        annotationReference.centerX -
          personReference.centerX,

        annotationReference.centerY -
          personReference.centerY
      );

      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestId = personId;
      }
    }
  );

  return {
    personId: nearestId,
    distance: nearestDistance
  };
}

function getPersonLayoutDelta(
  personId,
  peopleReference
) {
  const before = peopleReference.get(personId);
  const after = person(personId);

  if (!before || !after) {
    return null;
  }

  return {
    dx: after.x - before.x,
    dy: after.y - before.y
  };
}

function moveAnnotationsAfterAutoLayout(
  layoutReference
) {
  if (
    !layoutReference ||
    !layoutReference.people ||
    !layoutReference.annotations
  ) {
    return;
  }

  const peopleReference =
    layoutReference.people;

  const annotationReference =
    layoutReference.annotations;

  /*
   * 人物全体の代表移動量。
   * 人物から離れた注釈を移動するときに使用する。
   */
  const deltas = [];

  peopleReference.forEach(
    (before, personId) => {
      const after = person(personId);

      if (!after) {
        return;
      }

      deltas.push({
        dx: after.x - before.x,
        dy: after.y - before.y
      });
    }
  );

  const fallbackDelta =
    getMedianLayoutDelta(deltas);

  annotations.forEach(item => {
    const before =
      annotationReference.get(item.id);

    if (!before) {
      return;
    }

    if (item.type === "arrow") {
      moveArrowAfterAutoLayout(
        item,
        before,
        peopleReference,
        fallbackDelta
      );

      return;
    }

    const nearest =
      findNearestPersonIdFromReference(
        before,
        peopleReference
      );

    /*
     * 目安として人物から800以内なら、
     * 最も近い人物へ追従させる。
     */
    const delta =
      nearest.personId &&
      nearest.distance <= 800
        ? getPersonLayoutDelta(
            nearest.personId,
            peopleReference
          )
        : fallbackDelta;

    item.x =
      before.x + (delta?.dx || 0);

    item.y =
      before.y + (delta?.dy || 0);
  });

  updateAllAttachedArrows();
}

function moveArrowAfterAutoLayout(
  item,
  before,
  peopleReference,
  fallbackDelta
) {
  const startAttached =
    !!person(before.startPersonId);

  const endAttached =
    !!person(before.endPersonId);

  const beforeStartX = before.x;
  const beforeStartY = before.y;

  const beforeEndX =
    before.x + before.width;

  const beforeEndY =
    before.y + before.height;

  /*
   * 両端が人物に吸着している場合は、
   * 現在の人物位置から再計算する。
   */
  if (startAttached && endAttached) {
    updateAttachedArrowCoordinates(item);
    return;
  }

  /*
   * 始点だけ人物に吸着している場合。
   * 終点も同じ人物移動量だけ平行移動する。
   */
  if (startAttached) {
    const delta =
      getPersonLayoutDelta(
        before.startPersonId,
        peopleReference
      ) || fallbackDelta || {
        dx: 0,
        dy: 0
      };

    const startPerson =
      person(before.startPersonId);

    const startPoint =
      getPersonAnchorPoint(
        startPerson,
        item.startAnchor
      );

    setArrowAbsoluteEndpoints(
      item,
      startPoint.x,
      startPoint.y,
      beforeEndX + delta.dx,
      beforeEndY + delta.dy
    );

    return;
  }

  /*
   * 終点だけ人物に吸着している場合。
   * 始点も同じ人物移動量だけ平行移動する。
   */
  if (endAttached) {
    const delta =
      getPersonLayoutDelta(
        before.endPersonId,
        peopleReference
      ) || fallbackDelta || {
        dx: 0,
        dy: 0
      };

    const endPerson =
      person(before.endPersonId);

    const endPoint =
      getPersonAnchorPoint(
        endPerson,
        item.endAnchor
      );

    setArrowAbsoluteEndpoints(
      item,
      beforeStartX + delta.dx,
      beforeStartY + delta.dy,
      endPoint.x,
      endPoint.y
    );

    return;
  }

  /*
   * 吸着のない矢印は、
   * 最も近い人物または代表移動量へ追従する。
   */
  const nearest =
    findNearestPersonIdFromReference(
      before,
      peopleReference
    );

  const delta =
    nearest.personId &&
    nearest.distance <= 800
      ? getPersonLayoutDelta(
          nearest.personId,
          peopleReference
        )
      : fallbackDelta;

  const safeDelta =
    delta || {
      dx: 0,
      dy: 0
    };

  setArrowAbsoluteEndpoints(
    item,
    beforeStartX + safeDelta.dx,
    beforeStartY + safeDelta.dy,
    beforeEndX + safeDelta.dx,
    beforeEndY + safeDelta.dy
  );
}

function setArrowAbsoluteEndpoints(
  item,
  startX,
  startY,
  endX,
  endY
) {
  item.x = startX;
  item.y = startY;
  item.width = endX - startX;
  item.height = endY - startY;
}

function getMedianLayoutDelta(deltas) {
  if (!deltas.length) {
    return {
      dx: 0,
      dy: 0
    };
  }

  const dxList = deltas
    .map(item => item.dx)
    .sort((a, b) => a - b);

  const dyList = deltas
    .map(item => item.dy)
    .sort((a, b) => a - b);

  return {
    dx: getMedianNumber(dxList),
    dy: getMedianNumber(dyList)
  };
}

function getMedianNumber(values) {
  if (!values.length) {
    return 0;
  }

  const middle =
    Math.floor(values.length / 2);

  if (values.length % 2 === 1) {
    return values[middle];
  }

  return (
    values[middle - 1] +
    values[middle]
  ) / 2;
}


function arrangeAll() {
  normalizeRelations();

  if (!people.length) {
    return false;
  }

  const layoutReference =
    captureLayoutReference();
  const positions =
    calculateAutoLayout(people, families);

  people.forEach(p => {
    const position = positions.get(p.id);
    if (!position) return;
    p.x = position.x;
    p.y = position.y;
  });

  moveAnnotationsAfterAutoLayout(
    layoutReference
  );

  sync();

  /*
   * 描画領域の寸法反映後、全体を表示する。
   */
  requestAnimationFrame(() => {
    fitAll();
  });

  return true;
}
async function saveData() {
const data = {
  version: 7,
  savedAt: new Date().toISOString(),

  people,
  families,
  annotations,
  chartMemo,

  selectedId,
  selectedIds: [...selectedIds],
  selectedAnnotationId,
  selectedAnnotationIds: [...selectedAnnotationIds],

  scale,
  offsetX,
  offsetY,

  familyModelInitialized: !!familyModelInitialized
};



const json = JSON.stringify(data, null, 2);
const fileName = makeSaveFileName();

// 対応ブラウザでは「名前を付けて保存」ダイアログを使う
if (window.showSaveFilePicker) {
  try {
    const handle = await window.showSaveFilePicker({
      suggestedName: fileName,
      types: [
        {
          description: "相続関係図データ JSON",
          accept: {
            "application/json": [".json"]
          }
        }
      ]
    });

    const writable = await handle.createWritable();
    await writable.write(new Blob([json], { type: "application/json;charset=utf-8" }));
    await writable.close();

    return;
  } catch (e) {
    // 利用者がキャンセルした場合は何もしない
    if (e && e.name === "AbortError") return;

    // それ以外は通常ダウンロードにフォールバック
    console.warn("保存ダイアログが利用できなかったため、通常ダウンロードに切り替えます。", e);
  }
}

// 未対応ブラウザ向けの通常ダウンロード
downloadJsonFile(json, fileName);
}

function makeSaveFileName() {
const now = new Date();

const yyyy = now.getFullYear();
const mm = String(now.getMonth() + 1).padStart(2, "0");
const dd = String(now.getDate()).padStart(2, "0");
const hh = String(now.getHours()).padStart(2, "0");
const mi = String(now.getMinutes()).padStart(2, "0");

return `相続関係図_${yyyy}${mm}${dd}_${hh}${mi}.json`;
}

function downloadJsonFile(json, fileName) {
const blob = new Blob([json], { type: "application/json;charset=utf-8" });
const url = URL.createObjectURL(blob);

const a = document.createElement("a");
a.href = url;
a.download = fileName;
document.body.appendChild(a);
a.click();
document.body.removeChild(a);

URL.revokeObjectURL(url);
}

function restoreData() {
const input = document.getElementById("jsonFileInput");
input.value = "";
input.click();
}

function isAutoSaveEnabled() {
return localStorage.getItem(AUTO_SAVE_ENABLED_KEY) === "true";
}

function setAutoSaveEnabled(enabled) {
localStorage.setItem(AUTO_SAVE_ENABLED_KEY, enabled ? "true" : "false");
}

function initAutoSave() {
const checkbox = document.getElementById("autoSaveEnabled");

if (checkbox) {
  checkbox.checked = isAutoSaveEnabled();
}

updateAutoSaveStatus();

// 起動時の復元確認
checkAutoSaveBackupOnStartup();

// ここから先の sync() で自動保存を動かす
autoSaveReady = true;
}

function toggleAutoSave() {
const checkbox = document.getElementById("autoSaveEnabled");
if (!checkbox) return;

if (checkbox.checked) {
  const ok = confirm(
    "自動保存を有効にします。\n\n" +
    "作業中の相続関係図データが、この端末のブラウザ内に一時保存されます。\n" +
    "氏名・住所・相続関係などの個人情報を含む可能性があります。\n\n" +
    "共用端末では使用に注意してください。\n\n" +
    "自動保存を有効にしますか？"
  );

  if (!ok) {
    checkbox.checked = false;
    setAutoSaveEnabled(false);
    updateAutoSaveStatus();
    return;
  }

  setAutoSaveEnabled(true);
  updateAutoSaveStatus("自動保存を有効にしました。");

  // 有効化直後に現在状態を保存
  saveAutoSaveNow("自動保存ON直後");
  return;
}

setAutoSaveEnabled(false);

if (autoSaveTimer) {
  clearTimeout(autoSaveTimer);
  autoSaveTimer = null;
}

const hasBackup = !!getAutoSaveBackup();

if (hasBackup) {
  const deleteBackup = confirm(
    "自動保存を無効にしました。\n\n" +
    "既存の自動保存データも削除しますか？\n\n" +
    "削除しない場合、後から「自動保存から復元」で復元できます。"
  );

  if (deleteBackup) {
    localStorage.removeItem(AUTO_SAVE_DATA_KEY);
    autoSaveLastSavedAt = "";
  }
}

updateAutoSaveStatus("自動保存を無効にしました。");
}

function scheduleAutoSave() {
if (!autoSaveReady) return;
if (!isAutoSaveEnabled()) return;

if (autoSaveTimer) {
  clearTimeout(autoSaveTimer);
}

autoSaveTimer = setTimeout(() => {
  saveAutoSaveNow("変更後自動保存");
}, AUTO_SAVE_DELAY_MS);
}

function saveAutoSaveNow(reason = "") {
  if (!isAutoSaveEnabled()) return;

  try {
    const data = makeAutoSaveData(reason);
    const json = JSON.stringify(data);

    localStorage.setItem(
      AUTO_SAVE_DATA_KEY,
      json
    );

    autoSaveLastSavedAt = data.savedAt;
    updateAutoSaveStatus();
  } catch (error) {
    console.error(error);

    setAutoSaveEnabled(false);

    const checkbox =
      document.getElementById("autoSaveEnabled");

    if (checkbox) {
      checkbox.checked = false;
    }

    if (autoSaveTimer) {
      clearTimeout(autoSaveTimer);
      autoSaveTimer = null;
    }

    updateAutoSaveStatus(
      "自動保存を停止しました。手動でJSONファイルへ保存してください。",
      "error"
    );

    alert(
      "自動保存に失敗したため、自動保存を停止しました。\n\n" +
      "ブラウザの保存容量を超えている可能性があります。\n" +
      "「データを保存」からJSONファイルとして保存してください。"
    );
  }
}


function makeAutoSaveData(reason = "") {
  return {
    version: 7,
    source: "autoSave",
    reason,
    savedAt: new Date().toISOString(),

    people: JSON.parse(JSON.stringify(people || [])),
    families: JSON.parse(JSON.stringify(families || [])),
    annotations: JSON.parse(JSON.stringify(annotations || [])),

    chartMemo,

    selectedId,
    selectedIds: selectedIds ? [...selectedIds] : [],
    selectedAnnotationId,
    selectedAnnotationIds: [...selectedAnnotationIds],

    scale,
    offsetX,
    offsetY,

    familyModelInitialized: !!familyModelInitialized
  };
}


function getAutoSaveBackup() {
  const text = localStorage.getItem(AUTO_SAVE_DATA_KEY);
  if (!text) return null;

  try {
    const data = JSON.parse(text);

    if (!data || !Array.isArray(data.people)) {
      return null;
    }

    return data;
  } catch {
    return null;
  }
}

function checkAutoSaveBackupOnStartup() {
  if (!isAutoSaveEnabled()) {
    updateAutoSaveStatus();
    return;
}

const backup = getAutoSaveBackup();

if (!backup) {
  updateAutoSaveStatus();
  return;
}

const savedText = formatAutoSaveDateTime(backup.savedAt);

const ok = confirm(
  "前回の自動保存データがあります。\n\n" +
  `保存日時: ${savedText}\n` +
  `人物数: ${(backup.people || []).length}人\n` +
  `関係数: ${(backup.families || []).length}件\n\n` +
  "この自動保存データを復元しますか？"
);

if (ok) {
  restoreAutoSaveData(backup);
  updateAutoSaveStatus("自動保存データを復元しました。");
} else {
  updateAutoSaveStatus("自動保存データがあります。必要に応じて復元できます。", "warning");
}
}

function restoreAutoSaveManually() {
const backup = getAutoSaveBackup();

if (!backup) {
  alert("復元できる自動保存データがありません。");
  updateAutoSaveStatus();
  return;
}

const savedText = formatAutoSaveDateTime(backup.savedAt);

const ok = confirm(
  "自動保存データを復元します。\n\n" +
  "現在の画面上のデータは置き換えられます。\n\n" +
  `自動保存日時: ${savedText}\n` +
  `人物数: ${(backup.people || []).length}人\n` +
  `関係数: ${(backup.families || []).length}件\n\n` +
  "復元してよろしいですか？"
);

if (!ok) return;

pushUndo("自動保存復元前");

restoreAutoSaveData(backup);
updateAutoSaveStatus("自動保存データを復元しました。");
}

function restoreAutoSaveData(data) {
  if (!data || !Array.isArray(data.people)) {
    return;
  }

  people = (data.people || []).map(createPerson);

  families = Array.isArray(data.families)
    ? data.families.map(createFamily)
    : [];

  annotations = Array.isArray(data.annotations)
    ? data.annotations.map(createAnnotation)
    : [];

  chartMemo = data.chartMemo || "";

  familyModelInitialized =
    data.familyModelInitialized !== false;

  if (
    data.selectedId &&
    people.some(p => p.id === data.selectedId)
  ) {
    selectedId = data.selectedId;
  } else {
    selectedId = people[0]?.id || null;
  }

  if (Array.isArray(data.selectedIds)) {
    selectedIds = new Set(
      data.selectedIds.filter(id => person(id))
    );
  } else {
    selectedIds = selectedId
      ? new Set([selectedId])
      : new Set();
  }

  selectedAnnotationId =
    data.selectedAnnotationId &&
    annotations.some(
      item => item.id === data.selectedAnnotationId
    )
      ? data.selectedAnnotationId
      : null;

  selectedAnnotationIds = new Set(
    Array.isArray(data.selectedAnnotationIds)
      ? data.selectedAnnotationIds.filter(
          id => annotation(id)
        )
      : selectedAnnotationId
        ? [selectedAnnotationId]
        : []
  );

  if (
    selectedAnnotationId &&
    !selectedAnnotationIds.has(selectedAnnotationId)
  ) {
    selectedAnnotationIds.add(selectedAnnotationId);
  }

  /*
   * 人物と図形を同時選択状態にしない。
   * 図形の選択情報が保存されている場合は、図形を優先する。
   */
  if (selectedAnnotationId) {
    selectedId = null;
    selectedIds.clear();
  }

  scale = Number.isFinite(data.scale)
    ? clamp(data.scale, 0.2, 4)
    : 1;

  offsetX = Number.isFinite(data.offsetX)
    ? data.offsetX
    : 40;

  offsetY = Number.isFinite(data.offsetY)
    ? data.offsetY
    : 40;

  relationMode = null;
  relationClicks = [];
  relationPreviewMouse = null;

  annotationTool = null;
  annotationContextTargetId = null;
  annotationCreating = null;
  arrowEndpointDragging = null;
  annotationResizing = null;
  annotationDragging = null;
  arrowSnapTargetId = null;

  hideNodeContextMenu();
  hideAnnotationContextMenu();

  normalizeRelations();
  updateRelationModeStatus();
  updateAnnotationToolUi();
  sync();

  fitAllAfterRestore();
}


function deleteAutoSaveBackup() {
const backup = getAutoSaveBackup();

if (!backup) {
  alert("削除する自動保存データはありません。");
  updateAutoSaveStatus();
  return;
}

const savedText = formatAutoSaveDateTime(backup.savedAt);

const ok = confirm(
  "自動保存データを削除します。\n\n" +
  `保存日時: ${savedText}\n\n` +
  "削除してよろしいですか？"
);

if (!ok) return;

localStorage.removeItem(AUTO_SAVE_DATA_KEY);
autoSaveLastSavedAt = "";

updateAutoSaveStatus("自動保存データを削除しました。");
}

function updateAutoSaveStatus(message = "", level = "") {
const el = document.getElementById("autoSaveStatus");
if (!el) return;

const enabled = isAutoSaveEnabled();
const backup = getAutoSaveBackup();

let html = "";

if (enabled) {
  html += `<span class="autosave-on">自動保存: ON</span>`;
} else {
  html += `<span class="autosave-off">自動保存: OFF</span>`;
}

if (backup && backup.savedAt) {
  html += `<br>最終自動保存: ${escapeHtml(formatAutoSaveDateTime(backup.savedAt))}`;
} else {
  html += `<br>自動保存データ: なし`;
}

if (message) {
  const cls =
    level === "error"
      ? "autosave-error"
      : level === "warning"
        ? "autosave-warning"
        : enabled
          ? "autosave-on"
          : "autosave-off";

  html += `<br><span class="${cls}">${escapeHtml(message)}</span>`;
}

el.innerHTML = html;
}

function formatAutoSaveDateTime(value) {
if (!value) return "不明";

const d = new Date(value);

if (Number.isNaN(d.getTime())) {
  return String(value);
}

const yyyy = d.getFullYear();
const mm = String(d.getMonth() + 1).padStart(2, "0");
const dd = String(d.getDate()).padStart(2, "0");
const hh = String(d.getHours()).padStart(2, "0");
const mi = String(d.getMinutes()).padStart(2, "0");
const ss = String(d.getSeconds()).padStart(2, "0");

return `${yyyy}/${mm}/${dd} ${hh}:${mi}:${ss}`;
}

function moveChartNearOrigin() {
  if (!people.length && !annotations.length) {
    alert("移動する人物または図形がありません。");
    return;
  }

  const bounds = getAllChartBounds();

  const needsMove =
    bounds.minX < 0 ||
    bounds.minY < 0 ||
    bounds.minX > 1000 ||
    bounds.minY > 1000;

  if (!needsMove) {
    alert(
      "図はすでに原点付近にあります。"
    );
    return;
  }

  const ok = confirm(
    "図全体を左上の原点付近へ移動します。\n\n" +
    "人物・図形の相対的な配置は変わりません。\n" +
    "実行してよろしいですか？"
  );

  if (!ok) {
    return;
  }

  pushUndo("図全体の原点移動前");

  normalizeChartOrigin();
  sync();
  fitAll();
}


/*
 * 人物と注釈の相対配置を維持したまま、
 * 図全体を原点付近へ平行移動する。
 */
function normalizeChartOrigin() {
  if (!people.length && !annotations.length) {
    return false;
  }

  const bounds = getAllChartBounds();

  if (
    !Number.isFinite(bounds.minX) ||
    !Number.isFinite(bounds.minY)
  ) {
    return false;
  }

  const targetX = 120;
  const targetY = 120;

  const dx = targetX - bounds.minX;
  const dy = targetY - bounds.minY;

  people.forEach(p => {
    p.x += dx;
    p.y += dy;
  });

  annotations.forEach(item => {
    item.x += dx;
    item.y += dy;
  });

  updateAllAttachedArrows();

  return true;
}


/*
 * version 6以前の一部データでは、人物座標が
 * Y=25000付近へ保存されていることがある。
 */
const LEGACY_DATA_VERSION_MAX = 6;
const LEGACY_COORDINATE_Y_THRESHOLD = 5000;
const RESTORE_GROUP_GAP = 100;

/*
 * 旧座標群と正常座標群が混在している場合、
 * 旧座標群だけを正常座標群の下へ平行移動する。
 *
 * 戻り値:
 * true  = 座標を補正した
 * false = 補正対象ではなかった
 */
function repairLegacyCoordinateGroupAfterRestore() {
  if (!Array.isArray(people) || !people.length) {
    return false;
  }

  const legacyPeople = people.filter(p =>
    Number.isFinite(p.x) &&
    Number.isFinite(p.y) &&
    p.y >= LEGACY_COORDINATE_Y_THRESHOLD
  );

  const normalPeople = people.filter(p =>
    Number.isFinite(p.x) &&
    Number.isFinite(p.y) &&
    p.y < LEGACY_COORDINATE_Y_THRESHOLD
  );

  /*
   * 混在している場合だけ、この関数で補正する。
   *
   * 全員が旧座標の場合は呼び出し側で
   * normalizeChartOrigin()を実行する。
   */
  if (
    !legacyPeople.length ||
    !normalPeople.length
  ) {
    return false;
  }

  const legacyBounds =
    getPeopleBounds(legacyPeople);

  const normalBounds =
    getPeopleBounds(normalPeople);

  /*
   * 旧座標群の上端を、正常座標群の下端から
   * RESTORE_GROUP_GAPだけ離れた位置へ移動する。
   */
  const targetMinY =
    normalBounds.maxY + RESTORE_GROUP_GAP;

  const dy =
    targetMinY - legacyBounds.minY;

  if (!Number.isFinite(dy) || Math.abs(dy) < 1) {
    return false;
  }

  legacyPeople.forEach(p => {
    p.y += dy;
  });

  /*
   * 旧座標領域にある注釈も同じ距離だけ移動する。
   * 人物に吸着していない注釈も対象になる。
   */
  annotations.forEach(item => {
    const bounds = getAnnotationBounds(item);

    if (
      Number.isFinite(bounds.minY) &&
      bounds.minY >=
        LEGACY_COORDINATE_Y_THRESHOLD
    ) {
      item.y += dy;
    }
  });

  /*
   * 人物に吸着している矢印の端点を再計算する。
   */
  updateAllAttachedArrows();

  return true;
}

function areAllPeopleInLegacyCoordinateArea() {
  if (!Array.isArray(people) || !people.length) {
    return false;
  }

  return people.every(p =>
    Number.isFinite(p.y) &&
    p.y >= LEGACY_COORDINATE_Y_THRESHOLD
  );
}


function handleJsonFile(event) {
  const input = event.target;
  const file = input.files && input.files[0];

  if (!file) {
    return;
  }

  const confirmed = confirm(
    "現在の画面上のデータを、選択したファイルの内容で置き換えます。\n\n" +
    "現在の状態は「元に戻す」で復元できます。\n\n" +
    "よろしいですか？"
  );

  if (!confirmed) {
    input.value = "";
    return;
  }

  const reader = new FileReader();

  reader.onload = function() {
    let data;

    try {
      data = JSON.parse(reader.result);

      if (
        !data ||
        typeof data !== "object" ||
        !Array.isArray(data.people)
      ) {
        throw new Error(
          "相続関係図データにpeople配列がありません。"
        );
      }
    } catch (error) {
      alert(
        "データの復元に失敗しました。\n" +
        "JSONファイルの形式を確認してください。"
      );

      console.error(error);
      input.value = "";
      return;
    }

    try {
      /*
       * 実際にデータを書き換える直前に履歴を保存する。
       */
      pushUndo("JSONファイル復元前");

      people = (data.people || []).map(createPerson);

      if (Array.isArray(data.families)) {
        families = data.families.map(createFamily);
        familyModelInitialized = true;
      } else {
        /*
         * 旧データではpeople内のparents・spousesから
         * familyデータを再構築する。
         */
        families = [];
        familyModelInitialized = false;
      }

      /*
       * v7より前のデータにはannotationsがないため、
       * その場合は空配列として扱う。
       */
      annotations = Array.isArray(data.annotations)
        ? data.annotations.map(createAnnotation)
        : [];

      chartMemo = data.chartMemo || "";

      /*
       * 人物の主選択を復元する。
       */
      if (
        data.selectedId &&
        people.some(p => p.id === data.selectedId)
      ) {
        selectedId = data.selectedId;
      } else {
        selectedId = people[0]?.id || null;
      }

      /*
       * 人物の複数選択を復元する。
       * 旧データではselectedIdsがないため、主選択のみを使う。
       */
      if (Array.isArray(data.selectedIds)) {
        selectedIds = new Set(
          data.selectedIds.filter(id => person(id))
        );

        if (
          selectedId &&
          !selectedIds.has(selectedId)
        ) {
          selectedIds.add(selectedId);
        }
      } else {
        selectedIds = selectedId
          ? new Set([selectedId])
          : new Set();
      }

      /*
       * 図形の選択状態を復元する。
       */
      selectedAnnotationId =
        data.selectedAnnotationId &&
        annotations.some(
          item => item.id === data.selectedAnnotationId
        )
          ? data.selectedAnnotationId
          : null;

      selectedAnnotationIds = new Set(
        Array.isArray(data.selectedAnnotationIds)
          ? data.selectedAnnotationIds.filter(
              id => annotation(id)
            )
          : selectedAnnotationId
            ? [selectedAnnotationId]
            : []
      );

      if (
        selectedAnnotationId &&
        !selectedAnnotationIds.has(selectedAnnotationId)
      ) {
        selectedAnnotationIds.add(selectedAnnotationId);
      }

      /*
       * 人物と図形を同時選択しない。
       */
      if (selectedAnnotationId) {
        selectedId = null;
        selectedIds.clear();
      }

      /*
       * 操作途中のモードは復元しない。
       */
      relationMode = null;
      relationClicks = [];
      relationPreviewMouse = null;

      annotationTool = null;
      annotationContextTargetId = null;
      annotationCreating = null;
      arrowEndpointDragging = null;
      annotationResizing = null;
      annotationDragging = null;
      arrowSnapTargetId = null;

      /*
      * JSONのバージョンを取得する。
      * バージョンがないデータは旧形式として扱う。
      */
      const dataVersion = toFiniteNumber(
        data.version,
        0
      );

      const isLegacyVersion =
        dataVersion <= LEGACY_DATA_VERSION_MAX;

      /*
      * 保存された表示状態を取得する。
      */
      const savedScale = toFiniteNumber(
        data.scale,
        null
      );

      const savedOffsetX = toFiniteNumber(
        data.offsetX,
        null
      );

      const savedOffsetY = toFiniteNumber(
        data.offsetY,
        null
      );

      const hasSavedView =
        savedScale !== null &&
        savedOffsetX !== null &&
        savedOffsetY !== null;

      /*
      * 保存された表示状態があれば復元する。
      * 旧形式など、表示情報がなければ初期値を設定する。
      *
      * この後にfitAll()を実行するため、
      * 復元時の最終表示は全体表示になる。
      */
      scale = hasSavedView
        ? clamp(savedScale, 0.2, 4)
        : 1;

      offsetX = hasSavedView
        ? savedOffsetX
        : 40;

      offsetY = hasSavedView
        ? savedOffsetY
        : 40;

      normalizeRelations();

      let repairedMixedCoordinates = false;

      /*
      * version 6以前に限り、正常座標と旧座標が
      * 混在していないか確認する。
      *
      * 混在している場合は、旧座標群だけを移動する。
      */
      if (isLegacyVersion) {
        repairedMixedCoordinates =
          repairLegacyCoordinateGroupAfterRestore();
      }

      const allPeopleAreLegacyCoordinates =
        isLegacyVersion &&
        areAllPeopleInLegacyCoordinateArea();

      if (
        !hasSavedView &&
        !repairedMixedCoordinates &&
        allPeopleAreLegacyCoordinates
      ) {
        normalizeChartOrigin();
      }

      updateRelationModeStatus();
      updateAnnotationToolUi();
      sync();

      /*
      * 新旧を問わず、復元後は全体表示する。
      */
      fitAllAfterRestore();

      alert(
        "データを復元しました。\n\n" +
        `人物: ${people.length}人\n` +
        `関係: ${families.length}件\n` +
        `図形・注釈: ${annotations.length}件`
      );
    } catch (error) {
      alert(
        "データは読み込まれましたが、画面更新中にエラーが発生しました。\n" +
        "直前の状態へ戻す場合は「元に戻す」を実行してください。"
      );

      console.error(error);
    } finally {
      /*
       * 同じファイルを続けて選択できるようにリセットする。
       */
      input.value = "";
    }
  };

  reader.onerror = function() {
    alert("ファイルの読み込みに失敗しました。");
    input.value = "";
  };

  reader.readAsText(file, "utf-8");
}

function clearAll() {
  const targetSummary = [
    `人物: ${people.length}人`,
    `関係: ${families.length}件`,
    `図形・注釈: ${annotations.length}件`
  ].join("\n");

  const confirmed = confirm(
    "全データを消去しますか？\n\n" +
    targetSummary +
    "\n\n" +
    "人物、関係、図形・注釈、全体メモを消去します。\n" +
    "この操作は「元に戻す」で取り消せます。"
  );

  if (!confirmed) {
    return;
  }

  /*
   * clearAllはinstallUndoWrappers()の対象です。
   * そのため、ここではpushUndo()を呼びません。
   * 二重に履歴へ追加されるのを防ぎます。
   */
  people = [];
  families = [];
  annotations = [];

  chartMemo = "";

  selectedId = null;
  selectedIds.clear();

  selectedAnnotationId = null;
  selectedAnnotationIds.clear();

  familyModelInitialized = true;

  relationMode = null;
  relationClicks = [];
  relationPreviewMouse = null;

  annotationTool = null;
  annotationContextTargetId = null;
  annotationCreating = null;
  arrowEndpointDragging = null;
  annotationResizing = null;
  annotationDragging = null;

  annotationClipboard = null;
  annotationPasteCount = 0;

  hideNodeContextMenu();
  hideAnnotationContextMenu();

  updateRelationModeStatus();
  updateAnnotationToolUi();

  sync();
}


function downloadSvg() {
  updateAllAttachedArrows();
  renderChart();

  const bounds = getAllChartBounds();

  if (
    !people.length &&
    !annotations.length
  ) {
    alert("出力する人物または図形がありません。");
    return;
  }

  const padding = 30;
  const clone = svg.cloneNode(true);
  sanitizeSvgClone(clone);

  clone.setAttribute(
    "xmlns",
    "http://www.w3.org/2000/svg"
  );

  clone.querySelectorAll(
    [
      ".node-hit-target",
      ".annotation-selection-box",
      ".annotation-resize-handle",
      ".annotation-arrow-endpoint",
      ".annotation-create-preview",
      ".annotation-create-start",
      ".preview-line",
      ".preview-anchor"
    ].join(",")
  ).forEach(element => {
    element.remove();
  });

  clone.querySelectorAll(
    ".selected, .multi-selected, .pending, .arrow-snap-target"
  ).forEach(element => {
    element.classList.remove(
      "selected",
      "multi-selected",
      "pending",
      "arrow-snap-target"
    );
  });

  const x = bounds.minX - padding;
  const y = bounds.minY - padding;
  const width = Math.max(
    1,
    bounds.width + padding * 2
  );
  const height = Math.max(
    1,
    bounds.height + padding * 2
  );

  clone.setAttribute(
    "viewBox",
    `${x} ${y} ${width} ${height}`
  );

  clone.setAttribute("width", width);
  clone.setAttribute("height", height);

  /*
   * 画面のパン・ズーム変換を除去し、
   * ワールド座標をそのまま出力する。
   */
  const clonedViewport =
    clone.querySelector("#viewport");

  if (clonedViewport) {
    clonedViewport.removeAttribute("transform");
  }

  /*
   * 外部CSSがない環境でも表示できるように、
   * 出力用の必要最小限のスタイルをSVGへ埋め込む。
   */
  const styleElement = document.createElementNS(
    "http://www.w3.org/2000/svg",
    "style"
  );

  styleElement.textContent = `
    .node rect {
      fill: #ffffff;
      stroke: #333333;
      stroke-width: 1.5;
    }

    .node.male rect {
      stroke: #2563a8;
    }

    .node.female rect {
      stroke: #c33f53;
    }

    .node.unknown-gender rect {
      stroke: #333333;
    }

    .node.deceased rect {
      fill: #eeeeee;
      stroke-dasharray: 4 3;
    }

    .node.renounced rect {
      fill: #ffe3e3;
    }

    .node.representative rect {
      fill: #dff7e6;
    }

    .node.taxpayer rect {
      fill: #fff4cc;
    }

    .node.representative.taxpayer rect {
      fill: #edf4d9;
    }

    .node.renounced.representative rect,
    .node.renounced.taxpayer rect,
    .node.renounced.representative.taxpayer rect {
      fill: #ffe3e3;
    }

    .node text {
      fill: #222222;
      font-family:
        -apple-system,
        BlinkMacSystemFont,
        "Segoe UI",
        "Yu Gothic UI",
        Meiryo,
        sans-serif;
    }

    .node .name {
      fill: #17191d;
      font-size: 13px;
      font-weight: 700;
    }

    .node .sub {
      fill: #4b5058;
      font-size: 10px;
    }

    .node .sub.important {
      fill: #a03545;
      font-weight: 700;
    }

    .spouse-line {
      stroke: #222222;
      stroke-width: 1.8;
    }

    .child-line {
      fill: none;
      stroke: #222222;
      stroke-width: 1.5;
    }

    .annotation-shape {
      vector-effect: non-scaling-stroke;
    }

    .annotation-arrow .annotation-shape,
    .annotation-cross .annotation-shape {
      fill: none;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    .annotation-label {
      font-family:
        -apple-system,
        BlinkMacSystemFont,
        "Segoe UI",
        "Yu Gothic UI",
        Meiryo,
        sans-serif;
      font-weight: 600;
    }

    .shape-label {
      dominant-baseline: middle;
      text-anchor: middle;
    }
  `;

  clone.insertBefore(
    styleElement,
    clone.firstChild
  );

  const serializer = new XMLSerializer();
  const source =
    serializer.serializeToString(clone);

  const blob = new Blob(
    [source],
    {
      type: "image/svg+xml;charset=utf-8"
    }
  );

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = "相続関係図.svg";

  document.body.appendChild(link);
  link.click();
  link.remove();

  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 0);
}

function sanitizeSvgClone(root) {
  root.querySelectorAll(
    "script, foreignObject, iframe, object, embed, audio, video"
  ).forEach(element => element.remove());

  root.querySelectorAll("*").forEach(element => {
    [...element.attributes].forEach(attribute => {
      const name = attribute.name.toLowerCase();
      const value = String(attribute.value || "").trim();

      if (name.startsWith("on")) {
        element.removeAttribute(attribute.name);
        return;
      }

      if (
        name === "href" ||
        name === "xlink:href" ||
        name === "src"
      ) {
        const allowed =
          value.startsWith("#") ||
          value.startsWith("data:image/");

        if (!allowed) {
          element.removeAttribute(attribute.name);
        }
      }
    });
  });
}



let printViewState = null;
let printPreparationActive = false;
let printAutoFitApplied = false;

function printChart() {
  preparePrintLayout();

  setTimeout(() => {
    renderChart();

    if (
      document.getElementById("printAutoFit")
        ?.checked &&
      !printAutoFitApplied
    ) {
      fitAllForPrint();
      printAutoFitApplied = true;
    }

    setTimeout(() => {
      window.print();
    }, 100);
  }, 100);
}


function preparePrintLayout() {
  /*
   * printChart()とbeforeprintの両方から呼ばれても、
   * 元の表示状態を1回だけ保存する。
   */
  if (!printPreparationActive) {
    printViewState = {
      scale,
      offsetX,
      offsetY
    };

    printPreparationActive = true;
  }

  updateChartMemoFromInput();
  applyPrintSettingsToDom();
  updatePrintMemoBox();
  applyPrintPageStyle();

  document.body.classList.toggle(
    "print-no-legend",
    !document.getElementById(
      "printShowLegend"
    )?.checked
  );

  document.body.classList.toggle(
    "print-no-memo",
    !document.getElementById(
      "printShowMemo"
    )?.checked
  );
}


function restoreAfterPrint() {
  if (printViewState) {
    scale = printViewState.scale;
    offsetX = printViewState.offsetX;
    offsetY = printViewState.offsetY;
  }

  printViewState = null;
  printPreparationActive = false;
  printAutoFitApplied = false;

  document.body.classList.remove(
    "print-no-legend"
  );

  document.body.classList.remove(
    "print-no-memo"
  );

  renderChart();
}


function applyPrintSettingsToDom() {
const title = document.getElementById("printTitle")?.value || "相続関係図";
const subject = document.getElementById("printSubject")?.value || guessPrintSubject();
const paperText = getPrintPaperLabel();

const now = new Date();
const dateText =
  `${now.getFullYear()}年` +
  `${String(now.getMonth() + 1).padStart(2, "0")}月` +
  `${String(now.getDate()).padStart(2, "0")}日`;

const titleEl = document.getElementById("printHeaderTitle");
const subjectEl = document.getElementById("printHeaderSubject");
const metaEl = document.getElementById("printHeaderMeta");

if (titleEl) titleEl.textContent = title;
if (subjectEl) subjectEl.textContent = subject;
if (metaEl) {
  const targetText = getPrintTargetLabel();
  const scalePercent = document.getElementById("printScalePercent")?.value || "100";

  metaEl.innerHTML = `
    作成日: ${escapeHtml(dateText)}<br>
    用紙: ${escapeHtml(paperText)} / 対象: ${escapeHtml(targetText)} / 倍率: ${escapeHtml(scalePercent)}%<br>
  `;
}
}

function getPrintTargetLabel() {
const value = document.getElementById("printTarget")?.value || "all";

const labels = {
  all: "図全体",
  selected: "選択人物",
  current: "現在表示"
};

return labels[value] || "図全体";
}

function guessPrintSubject() {
const deceased = people.find(p =>
  (p.relation || "").includes("被相続人") ||
  (p.relation || "").includes("所有者") ||
  p.death
);

if (deceased) {
  return `対象者: ${deceased.name || deceased.id}`;
}

return "";
}

function getPrintPaperLabel() {
const value = document.getElementById("printPaper")?.value || "a4-landscape";

const labels = {
  "a4-landscape": "A4 横",
  "a4-portrait": "A4 縦",
  "a3-landscape": "A3 横",
  "a3-portrait": "A3 縦"
};

return labels[value] || "A4 横";
}

function applyPrintPageStyle() {
const paper = document.getElementById("printPaper")?.value || "a4-landscape";
const margin = Number(document.getElementById("printMarginMm")?.value || 8);

const pageSizeMap = {
  "a4-landscape": "A4 landscape",
  "a4-portrait": "A4 portrait",
  "a3-landscape": "A3 landscape",
  "a3-portrait": "A3 portrait"
};

const pageSize = pageSizeMap[paper] || "A4 landscape";
const safeMargin = clamp(margin, 0, 30);

let style = document.getElementById("dynamicPrintPageStyle");

if (!style) {
  style = document.createElement("style");
  style.id = "dynamicPrintPageStyle";
  document.head.appendChild(style);
}

style.textContent = `
  @page {
    size: ${pageSize};
    margin: ${safeMargin}mm;
  }
`;
}

function fitAllAfterRestore() {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      fitAll();
    });
  });
}

function fitAllForPrint() {
  if (!people.length && !annotations.length) {
    return;
  }

  const targetMode =
    document.getElementById("printTarget")
      ?.value || "all";

  if (targetMode === "current") {
    renderChart();
    return;
  }

  renderChart();

  const rect = svg.getBoundingClientRect();

  const rectWidth =
    rect.width >= 100
      ? rect.width
      : window.innerWidth || 1000;

  const rectHeight =
    rect.height >= 100
      ? rect.height
      : window.innerHeight || 700;

  let bounds;

  if (targetMode === "selected") {
    const selectedPeople =
      getPrintTargetPeople();

    const selectedAnnotations =
      getSelectedAnnotations();

    bounds = getCombinedBounds(
      selectedPeople,
      selectedAnnotations
    );
  } else {
    bounds = getCombinedBounds(
      people,
      annotations
    );
  }

  if (!bounds) {
    return;
  }

  const margin = 30;

  const availableWidth =
    Math.max(100, rectWidth - margin * 2);

  const availableHeight =
    Math.max(100, rectHeight - margin * 2);

  const contentWidth =
    Math.max(1, bounds.width);

  const contentHeight =
    Math.max(1, bounds.height);

  const baseScale = Math.min(
    availableWidth / contentWidth,
    availableHeight / contentHeight
  );

  const scalePercent = Number(
    document.getElementById(
      "printScalePercent"
    )?.value || 100
  );

  const userScale =
    clamp(scalePercent, 50, 250) / 100;

  scale = clamp(
    baseScale * userScale,
    0.05,
    6
  );

  const centerX =
    bounds.minX + bounds.width / 2;

  const centerY =
    bounds.minY + bounds.height / 2;

  offsetX =
    rectWidth / 2 - centerX * scale;

  offsetY =
    rectHeight / 2 - centerY * scale;

  renderChart();
}

function getCombinedBounds(
  targetPeople = [],
  targetAnnotations = []
) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  targetPeople.forEach(item => {
    minX = Math.min(minX, item.x);
    minY = Math.min(minY, item.y);
    maxX = Math.max(
      maxX,
      item.x + NODE_W
    );
    maxY = Math.max(
      maxY,
      item.y + NODE_H
    );
  });

  targetAnnotations.forEach(item => {
    const bounds = getAnnotationBounds(item);

    minX = Math.min(minX, bounds.minX);
    minY = Math.min(minY, bounds.minY);
    maxX = Math.max(maxX, bounds.maxX);
    maxY = Math.max(maxY, bounds.maxY);
  });

  if (!Number.isFinite(minX)) {
    return null;
  }

  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height: maxY - minY
  };
}


function getPrintTargetPeople() {
const targetMode = document.getElementById("printTarget")?.value || "all";

if (targetMode === "all") {
  return people;
}

if (targetMode === "selected") {
  const ids = selectedIds && selectedIds.size
    ? [...selectedIds]
    : selectedId
      ? [selectedId]
      : [];

  const selectedPeople = ids.map(person).filter(Boolean);

  // 選択人物がいなければ全体に戻す
  return selectedPeople.length ? selectedPeople : people;
}

// current の場合は自動フィットしないので、ここでは全体を返す
return people;
}

function updatePrintMemoBox() {
const contentEl = document.getElementById("printMemoContent");
const linesEl = document.getElementById("printMemoLines");

if (!contentEl || !linesEl) return;

const memo = String(chartMemo || "").trim();

if (memo) {
  contentEl.textContent = memo;
  contentEl.style.display = "block";
  linesEl.style.display = "none";
} else {
  contentEl.textContent = "";
  contentEl.style.display = "none";
  linesEl.style.display = "block";
}
}

function zoomIn() {
const center = getSvgCenterClientPoint();
zoomAt(center.x, center.y, 1.15);
}

function zoomOut() {
const center = getSvgCenterClientPoint();
zoomAt(center.x, center.y, 1 / 1.15);
}

function resetView() {
scale = 1;
offsetX = 40;
offsetY = 40;
renderChart();
}

function handleWheelZoom(e) {
e.preventDefault();

const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
zoomAt(e.clientX, e.clientY, factor);
}

function zoomAt(clientX, clientY, factor) {
const rect = svg.getBoundingClientRect();

const mouseX = clientX - rect.left;
const mouseY = clientY - rect.top;

const worldX = (mouseX - offsetX) / scale;
const worldY = (mouseY - offsetY) / scale;

const newScale = clamp(scale * factor, 0.2, 4);

offsetX = mouseX - worldX * newScale;
offsetY = mouseY - worldY * newScale;
scale = newScale;

renderChart();
}

function getSvgCenterClientPoint() {
const rect = svg.getBoundingClientRect();

return {
  x: rect.left + rect.width / 2,
  y: rect.top + rect.height / 2
};
}

function clamp(value, min, max) {
return Math.max(min, Math.min(max, value));
}

function compactNodeText(value, maxLength = 18) {
const text = String(value || "")
  .replace(/\s+/g, " ")
  .trim();

if (!text) return "";

if (text.length <= maxLength) {
  return text;
}

return text.slice(0, maxLength) + "…";
}

function buildNodeDateText(p) {
const parts = [];

if (p.birth) {
  parts.push(`生:${p.birth}`);
}

if (p.death) {
  parts.push(`死:${p.death}`);
}

return parts.join(" / ");
}

function buildNodeAddressText(p) {
if (!p.address) return "";

return `住:${compactNodeText(p.address, 15)}`;
}

function buildNodeTooltipText(p) {
  return [
    `${p.name || "無名"}`,
    p.gender ? `性別: ${p.gender}` : "",
    p.relation ? `続柄・関係: ${p.relation}` : "",
    p.address ? `住所: ${p.address}` : "",
    p.birth ? `生年月日: ${p.birth}` : "",
    p.death ? `死亡年月日: ${p.death}` : "",
    p.renunciation ? `相続放棄: ${p.renunciation}` : "",
    p.representative ? "代表相続人" : "",
    p.taxpayer ? "納税義務者候補" : "",
    p.manager ? "納税管理人候補" : "",
    p.share ? `共有持分: ${p.share}` : ""
  ].filter(Boolean).join("\n");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}

document.addEventListener("pointerdown", event => {
  if (!event.target.closest?.(".annotation.annotation-text")) {
    lastAnnotationTextPointerDown = null;
  }
}, true);
svg.addEventListener("pointerdown", startPan);
svg.addEventListener("wheel", handleWheelZoom, { passive: false });
svg.addEventListener("pointermove", e => {
if (!relationMode || !relationClicks.length) return;

relationPreviewMouse = clientToWorld(e.clientX, e.clientY);
renderChart();
});

svg.addEventListener("click", event => {
  hideNodeContextMenu();
  hideAnnotationContextMenu();

  if (handleAnnotationCanvasClick(event)) {
    return;
  }

  if (relationMode) {
    if (!event.target.closest?.(".node")) {
      cancelRelationMode();
    }

    return;
  }

  if (suppressNextSvgClick) {
    suppressNextSvgClick = false;
    return;
  }

  if (
    !event.target.closest?.(".node") &&
    !event.target.closest?.(".annotation")
  ) {
    clearSelection();
    selectedAnnotationId = null;
    selectedAnnotationIds.clear();
    sync();
  }
});


/* document全体のイベント */
document.addEventListener("click", () => {
  hideNodeContextMenu();
  hideAnnotationContextMenu();
});


document.addEventListener("keyup", e => {
  if (e.key === "Alt") {
    svg.classList.remove("annotation-hit-mode");
  }
});
window.addEventListener("blur", () => {
  svg.classList.remove("annotation-hit-mode");
});

document.addEventListener("keydown", e => {
  const activeElement = document.activeElement;
  const activeTagName = activeElement?.tagName || "";

  const isFormEditing =
    activeTagName === "INPUT" ||
    activeTagName === "TEXTAREA" ||
    activeTagName === "SELECT" ||
    activeElement?.isContentEditable;

  if (e.key === "Alt" && !isFormEditing && !relationMode && !annotationTool) {
    svg.classList.add("annotation-hit-mode");
  }

  /*
   * Escキー
   *
   * 次の状態を解除します。
   * - 人物の右クリックメニュー
   * - 図形・注釈の右クリックメニュー
   * - 関係作成モード
   * - 図形追加モード
   */
  if (e.key === "Escape") {
    hideNodeContextMenu();
    hideAnnotationContextMenu();

    closeBulkEditModal();
    closeRelationListModal();
    closeAnnotationEditModal();

    if (relationMode) {
      cancelRelationMode();
    }

    if (annotationTool) {
      cancelAnnotationTool();
    }

    return;
  }

  /*
   * Delete / Backspaceキー
   *
   * 選択中の図形・注釈を削除します。
   * 入力欄を編集しているときは、文字削除を優先します。
   */
  if (
    (e.key === "Delete" || e.key === "Backspace") &&
    selectedAnnotationId &&
    !isFormEditing
  ) {
    e.preventDefault();
    deleteSelectedAnnotation();
    return;
  }

  /*
   * Ctrl + Z / Command + Z
   *
   * 元に戻します。
   * 入力欄を編集中の場合は、ブラウザ標準の文字入力Undoを優先します。
   */
  const isCtrlOrCmd = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();

  /*
   * 図形のコピー
   */
  if (
    isCtrlOrCmd &&
    key === "c" &&
    selectedAnnotationId &&
    !isFormEditing
  ) {
    e.preventDefault();
    copySelectedAnnotation();
    return;
  }

  /*
   * 図形の貼り付け
   */
  if (
    isCtrlOrCmd &&
    key === "v" &&
    !isFormEditing
  ) {
    e.preventDefault();
    pasteAnnotation();
    return;
  }

  /*
   * 図形の複製
   */
  if (
    isCtrlOrCmd &&
    key === "d" &&
    selectedAnnotationId &&
    !isFormEditing
  ) {
    e.preventDefault();
    duplicateSelectedAnnotation();
    return;
  }

  /*
   * 1段前面・背面
   */
  if (
    selectedAnnotationId &&
    !isFormEditing &&
    !isCtrlOrCmd &&
    e.key === "]"
  ) {
    e.preventDefault();
    moveSelectedAnnotationForward();
    return;
  }

  if (
    selectedAnnotationId &&
    !isFormEditing &&
    !isCtrlOrCmd &&
    e.key === "["
  ) {
    e.preventDefault();
    moveSelectedAnnotationBackward();
    return;
  }

  if (
    isCtrlOrCmd &&
    key === "z" &&
    !e.shiftKey &&
    !isFormEditing
  ) {
    e.preventDefault();
    undo();
    return;
  }

  /*
   * Ctrl + Y
   * Ctrl + Shift + Z
   * Command + Shift + Z
   *
   * やり直します。
   */
  if (
    isCtrlOrCmd &&
    !isFormEditing &&
    (
      e.key.toLowerCase() === "y" ||
      (e.key.toLowerCase() === "z" && e.shiftKey)
    )
  ) {
    e.preventDefault();
    redo();
  }
});


window.addEventListener("beforeprint", () => {
  preparePrintLayout();

  if (
    document.getElementById("printAutoFit")
      ?.checked &&
    !printAutoFitApplied
  ) {
    fitAllForPrint();
    printAutoFitApplied = true;
  }
});


window.addEventListener("afterprint", () => {
restoreAfterPrint();
});

window.addEventListener("beforeunload", () => {
if (isAutoSaveEnabled()) {
  saveAutoSaveNow("ページ終了直前");
}
});

function snapshotKey(snapshot) {
  return JSON.stringify({
    people: snapshot.people,
    families: snapshot.families,
    annotations: snapshot.annotations,
    chartMemo: snapshot.chartMemo,

    selectedId: snapshot.selectedId,
    selectedIds: snapshot.selectedIds,

    selectedAnnotationId:
      snapshot.selectedAnnotationId,

    selectedAnnotationIds:
      snapshot.selectedAnnotationIds,

    annotationTool:
      snapshot.annotationTool,

    scale: snapshot.scale,
    offsetX: snapshot.offsetX,
    offsetY: snapshot.offsetY,

    familyModelInitialized:
      snapshot.familyModelInitialized
  });
}


function pushUndoSnapshot(snapshot) {
undoStack.push(snapshot);

if (undoStack.length > UNDO_LIMIT) {
  undoStack.shift();
}

redoStack.length = 0;
}

function installUndoWrappers() {
const targets = [
  ["newPerson", "人物追加前"],
  ["deletePerson", "人物削除前"],
  ["savePersonForm", "人物情報変更前"],
  ["applyTable", "表反映前"],
  ["addSpouse", "夫婦関係追加前"],
  ["addChild", "親子関係追加前"],
  ["removeFamily", "関係削除前"],
  ["removeChildFromFamily", "親子関係解除前"],
  ["clearAll", "全消去前"],
  ["arrangeSelectedFamily", "家族整列前"],
  ["arrangeSelectedPeople", "選択人物整列前"],
  ["arrangeAll", "全体整列前"]
];

targets.forEach(([name, label]) => {
  const original = window[name];

  if (typeof original !== "function") return;
  if (original.__undoWrapped) return;

  const wrapped = function(...args) {
    const before = makeSnapshot(label);
    const beforeKey = snapshotKey(before);

    const result = original.apply(this, args);

    const after = makeSnapshot(label + " 実行後");
    const afterKey = snapshotKey(after);

    // 実際にデータが変わった場合だけundo履歴に積む
    if (beforeKey !== afterKey) {
      pushUndoSnapshot(before);
    }

    return result;
  };

  wrapped.__undoWrapped = true;
  window[name] = wrapped;
});
}


function fitAll() {
  if (!people.length && !annotations.length) {
    resetView();
    return;
  }

  const bounds = getAllChartBounds();
  const rect = svg.getBoundingClientRect();

  const margin = 80;
  const availableWidth = Math.max(100, rect.width - margin * 2);
  const availableHeight = Math.max(100, rect.height - margin * 2);

  const contentWidth = Math.max(1, bounds.width);
  const contentHeight = Math.max(1, bounds.height);

  const scaleX = availableWidth / contentWidth;
  const scaleY = availableHeight / contentHeight;

  scale = clamp(Math.min(scaleX, scaleY), 0.2, 2.5);

  offsetX =
    (rect.width - contentWidth * scale) / 2 -
    bounds.minX * scale;

  offsetY =
    (rect.height - contentHeight * scale) / 2 -
    bounds.minY * scale;

  renderChart();
}


function getPeopleBounds(list) {
const target = list && list.length ? list : people;

let minX = Infinity;
let minY = Infinity;
let maxX = -Infinity;
let maxY = -Infinity;

target.forEach(p => {
  minX = Math.min(minX, p.x);
  minY = Math.min(minY, p.y);
  maxX = Math.max(maxX, p.x + NODE_W);
  maxY = Math.max(maxY, p.y + NODE_H);
});

if (!Number.isFinite(minX)) {
  return {
    minX: 0,
    minY: 0,
    maxX: 0,
    maxY: 0,
    width: 0,
    height: 0
  };
}

return {
  minX,
  minY,
  maxX,
  maxY,
  width: maxX - minX,
  height: maxY - minY
};
}

function focusSelected() {
  let bounds = null;

  const selectedPeople =
    selectedIds.size
      ? [...selectedIds]
          .map(person)
          .filter(Boolean)
      : selectedId
        ? [person(selectedId)].filter(Boolean)
        : [];

  if (selectedPeople.length) {
    bounds = getPeopleBounds(selectedPeople);
  } else {
    const selectedAnnotations =
      getSelectedAnnotations();

    if (selectedAnnotations.length) {
      bounds =
        getAnnotationsBounds(
          selectedAnnotations
        );
    }
  }

  if (!bounds) {
    alert("移動対象の人物または図形が選択されていません。");
    return;
  }

  const rect = svg.getBoundingClientRect();

  const centerX =
    bounds.minX + bounds.width / 2;

  const centerY =
    bounds.minY + bounds.height / 2;

  offsetX =
    rect.width / 2 - centerX * scale;

  offsetY =
    rect.height / 2 - centerY * scale;

  renderChart();
}

function getAnnotationsBounds(items) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  items.forEach(item => {
    const bounds = getAnnotationBounds(item);

    minX = Math.min(minX, bounds.minX);
    minY = Math.min(minY, bounds.minY);
    maxX = Math.max(maxX, bounds.maxX);
    maxY = Math.max(maxY, bounds.maxY);
  });

  if (!Number.isFinite(minX)) {
    return null;
  }

  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height: maxY - minY
  };
}

const LAYOUT_TOP = 80;
const LAYOUT_LEFT = 120;
const LEVEL_GAP = 250;
const PERSON_GAP = 100;
const SPOUSE_GAP = 60;
const CHILD_GAP = 100;


function calculateGenerations(
  targetIds = null
) {
  const generations = new Map();

  const allowedIds =
    targetIds instanceof Set
      ? targetIds
      : new Set(
          people.map(p => p.id)
        );

  allowedIds.forEach(id => {
    if (person(id)) {
      generations.set(id, 0);
    }
  });

  let changed = true;
  let guard = 0;

  while (changed && guard < 100) {
    changed = false;
    guard++;

    families.forEach(family => {
      const parentIds = (
        family.parents || []
      ).filter(id =>
        allowedIds.has(id) &&
        person(id)
      );

      const childIds = (
        family.children || []
      ).filter(id =>
        allowedIds.has(id) &&
        person(id)
      );

      if (
        !parentIds.length &&
        !childIds.length
      ) {
        return;
      }

      const parentGenerations =
        parentIds
          .map(id =>
            generations.get(id)
          )
          .filter(Number.isFinite);

      const parentGeneration =
        parentGenerations.length
          ? Math.max(
              ...parentGenerations
            )
          : 0;

      /*
       * 同じfamilyの親・配偶者は
       * 同じ世代へそろえる。
       */
      parentIds.forEach(id => {
        const current =
          generations.get(id) ?? 0;

        if (
          current !== parentGeneration
        ) {
          generations.set(
            id,
            parentGeneration
          );

          changed = true;
        }
      });

      /*
       * 子は親の次の世代以降とする。
       */
      childIds.forEach(id => {
        const current =
          generations.get(id) ?? 0;

        const next = Math.max(
          current,
          parentGeneration + 1
        );

        if (next !== current) {
          generations.set(id, next);
          changed = true;
        }
      });
    });
  }

  return generations;
}



function showNodeContextMenu(id, clientX, clientY) {
  nodeContextTargetId = id;

  const menu = document.getElementById("nodeContextMenu");
  const title = document.getElementById("nodeContextMenuTitle");

  if (!menu || !title) {
    return;
  }

  title.textContent = personLabel(id);

  menu.style.left = "0";
  menu.style.top = "0";
  menu.classList.add("open");

  const menuRect = menu.getBoundingClientRect();
  const margin = 10;

  const left = Math.min(
    clientX,
    window.innerWidth - menuRect.width - margin
  );

  const top = Math.min(
    clientY,
    window.innerHeight - menuRect.height - margin
  );

  menu.style.left = `${Math.max(margin, left)}px`;
  menu.style.top = `${Math.max(margin, top)}px`;
}


function hideNodeContextMenu() {
const menu = document.getElementById("nodeContextMenu");
if (!menu) return;

menu.classList.remove("open");
nodeContextTargetId = null;
}

function nodeMenuSelect() {
if (!nodeContextTargetId) return;

selectPerson(nodeContextTargetId);
hideNodeContextMenu();
}

function nodeMenuStartSpouse() {
if (!nodeContextTargetId) return;

relationMode = "spouse";
relationClicks = [nodeContextTargetId];
relationPreviewMouse = null;

updateRelationModeStatus();
renderChart();
hideNodeContextMenu();
}

function nodeMenuStartChild1() {
if (!nodeContextTargetId) return;

relationMode = "child1";
relationClicks = [nodeContextTargetId];
relationPreviewMouse = null;

updateRelationModeStatus();
renderChart();
hideNodeContextMenu();
}

function nodeMenuStartChild2() {
if (!nodeContextTargetId) return;

relationMode = "child2";
relationClicks = [nodeContextTargetId];
relationPreviewMouse = null;

updateRelationModeStatus();
renderChart();
hideNodeContextMenu();
}

function nodeMenuFocus() {
  if (!nodeContextTargetId) {
    return;
  }

  const targetId = nodeContextTargetId;

  selectOnly(targetId);
  hideNodeContextMenu();

  focusSelected();
}


function nodeMenuDeletePerson() {
if (!nodeContextTargetId) return;

const id = nodeContextTargetId;
hideNodeContextMenu();

if (typeof deletePerson === "function") {
  deletePerson(id);
}
}

function nodeMenuDetachAsChild() {
if (!nodeContextTargetId) return;

const targetId = nodeContextTargetId;
const targetName = personLabel(targetId);

const relatedFamilies = families.filter(f =>
  (f.children || []).includes(targetId)
);

hideNodeContextMenu();

if (!relatedFamilies.length) {
  alert(`${targetName} は、子として登録されている関係がありません。`);
  return;
}

const familyText = relatedFamilies.map(f => {
  const parentsText = (f.parents || []).map(personLabel).join(" + ") || "親なし";
  return `${f.id}: ${parentsText} → ${targetName}`;
}).join("\n");

const ok = confirm(
  `${targetName} を子関係から外します。\n\n` +
  `対象関係:\n${familyText}\n\n` +
  "人物ノード自体は削除されません。\n" +
  "実行してよろしいですか？"
);

if (!ok) return;

pushUndo("子関係解除前");

relatedFamilies.forEach(f => {
  f.children = (f.children || []).filter(cid => cid !== targetId);
});

// 子がいない1親familyは不要なので削除。
// 親が2人以上いるfamilyは夫婦関係として残す。
families = families.filter(f =>
  (f.children || []).length || (f.parents || []).length >= 2
);

normalizeRelations();
sync();
}

function nodeMenuDetachAsParent() {
if (!nodeContextTargetId) return;

const targetId = nodeContextTargetId;
const targetName = personLabel(targetId);

const relatedFamilies = families.filter(f =>
  (f.parents || []).includes(targetId)
);

hideNodeContextMenu();

if (!relatedFamilies.length) {
  alert(`${targetName} は、親・配偶者側として登録されている関係がありません。`);
  return;
}

const familyText = relatedFamilies.map(f => {
  const parentsText = (f.parents || []).map(personLabel).join(" + ") || "親なし";
  const childrenText = (f.children || []).map(personLabel).join("、") || "子なし";
  return `${f.id}: ${parentsText} → ${childrenText}`;
}).join("\n");

const ok = confirm(
  `${targetName} を親・配偶者関係から外します。\n\n` +
  `対象関係:\n${familyText}\n\n` +
  "子がいるfamilyでは、残った親がいる場合はその親に子が紐づきます。\n" +
  "残る親がいない場合は、その親子関係も解除されます。\n\n" +
  "人物ノード自体は削除されません。\n" +
  "実行してよろしいですか？"
);

if (!ok) return;

pushUndo("親・配偶者関係解除前");

relatedFamilies.forEach(f => {
  f.parents = (f.parents || []).filter(pid => pid !== targetId);
});

// 親がいなくなったfamilyは削除する。
// 親が残っている場合は、子関係を残す。
families = families.filter(f => {
  const parentCount = (f.parents || []).length;
  const childCount = (f.children || []).length;

  if (parentCount === 0) return false;
  if (parentCount === 1 && childCount === 0) return false;

  return true;
});

normalizeRelations();
sync();
}

function nodeMenuDetachAllRelations() {
if (!nodeContextTargetId) return;

const targetId = nodeContextTargetId;
const targetName = personLabel(targetId);

const relatedFamilies = families.filter(f =>
  (f.parents || []).includes(targetId) ||
  (f.children || []).includes(targetId)
);

hideNodeContextMenu();

if (!relatedFamilies.length) {
  alert(`${targetName} に解除できる関係はありません。`);
  return;
}

const familyText = relatedFamilies.map(f => {
  const parentsText = (f.parents || []).map(personLabel).join(" + ") || "親なし";
  const childrenText = (f.children || []).map(personLabel).join("、") || "子なし";
  return `${f.id}: ${parentsText} → ${childrenText}`;
}).join("\n");

const ok = confirm(
  `${targetName} の全関係を解除します。\n\n` +
  `対象関係:\n${familyText}\n\n` +
  "この人物を、子・親・配偶者として登録されているすべての関係から外します。\n" +
  "人物ノード自体は削除されません。\n\n" +
  "実行してよろしいですか？"
);

if (!ok) return;

pushUndo("全関係解除前");

families.forEach(f => {
  f.parents = (f.parents || []).filter(pid => pid !== targetId);
  f.children = (f.children || []).filter(cid => cid !== targetId);
});

// 不要になったfamilyを削除
families = families.filter(f => {
  const parentCount = (f.parents || []).length;
  const childCount = (f.children || []).length;

  // 親なしfamilyは削除
  if (parentCount === 0) return false;

  // 親1人・子なしは意味がないので削除
  if (parentCount === 1 && childCount === 0) return false;

  // 親2人以上なら夫婦・親ペア関係として残す
  // 親1人かつ子ありなら親子関係として残す
  return true;
});

normalizeRelations();
sync();
}


function makeSnapshot(label = "") {
  return {
    label,
    at: new Date().toISOString(),
    people: JSON.parse(JSON.stringify(people)),
    families: JSON.parse(JSON.stringify(families || [])),
    chartMemo,
    selectedId,
    selectedIds: typeof selectedIds !== "undefined" ? [...selectedIds] : [],
    scale,
    offsetX,
    offsetY,
    annotations: JSON.parse(JSON.stringify(annotations || [])),
    selectedAnnotationId,
    selectedAnnotationIds: [...selectedAnnotationIds],
    annotationTool,
    familyModelInitialized
  };
}

function restoreSnapshot(snapshot) {
  if (!snapshot) {
    return;
  }

  people =
    (snapshot.people || []).map(createPerson);

  families =
    (snapshot.families || []).map(createFamily);

  annotations =
    (snapshot.annotations || [])
      .map(createAnnotation);

  chartMemo = snapshot.chartMemo || "";

  familyModelInitialized =
    snapshot.familyModelInitialized !== false;

  selectedId =
    snapshot.selectedId &&
    person(snapshot.selectedId)
      ? snapshot.selectedId
      : null;

  selectedIds = new Set(
    (snapshot.selectedIds || [])
      .filter(id => person(id))
  );

  if (
    selectedId &&
    !selectedIds.has(selectedId)
  ) {
    selectedIds.add(selectedId);
  }

  selectedAnnotationId =
    snapshot.selectedAnnotationId &&
    annotation(snapshot.selectedAnnotationId)
      ? snapshot.selectedAnnotationId
      : null;

  selectedAnnotationIds = new Set(
    (snapshot.selectedAnnotationIds || [])
      .filter(id => annotation(id))
  );

  if (
    selectedAnnotationId &&
    !selectedAnnotationIds.has(
      selectedAnnotationId
    )
  ) {
    selectedAnnotationIds.add(
      selectedAnnotationId
    );
  }

  /*
   * 人物と図形の同時選択を避ける。
   */
  if (selectedAnnotationId) {
    selectedId = null;
    selectedIds.clear();
  }

  scale = Number.isFinite(snapshot.scale)
    ? clamp(snapshot.scale, 0.2, 4)
    : 1;

  offsetX = Number.isFinite(snapshot.offsetX)
    ? snapshot.offsetX
    : 40;

  offsetY = Number.isFinite(snapshot.offsetY)
    ? snapshot.offsetY
    : 40;

  /*
   * 操作途中の状態は復元しない。
   */
  relationMode = null;
  relationClicks = [];
  relationPreviewMouse = null;

  annotationTool = null;
  annotationContextTargetId = null;
  annotationCreating = null;
  annotationDragging = null;
  annotationResizing = null;

  arrowEndpointDragging = null;
  arrowSnapTargetId = null;

  hideNodeContextMenu();
  hideAnnotationContextMenu();

  normalizeRelations();
  updateRelationModeStatus();
  updateAnnotationToolUi();
  sync();
}


function pushUndo(label = "操作前") {
undoStack.push(makeSnapshot(label));

if (undoStack.length > UNDO_LIMIT) {
  undoStack.shift();
}

redoStack.length = 0;
}

function undo() {
if (!undoStack.length) {
  alert("元に戻せる操作がありません。");
  return;
}

const current = makeSnapshot("undo前の現在状態");
redoStack.push(current);

const previous = undoStack.pop();
restoreSnapshot(previous);
}

function redo() {
if (!redoStack.length) {
  alert("やり直せる操作がありません。");
  return;
}

const current = makeSnapshot("redo前の現在状態");
undoStack.push(current);

const next = redoStack.pop();
restoreSnapshot(next);
}

function initPaneResizer() {
const resizer = document.getElementById("paneResizer");
const app = document.querySelector(".app");

if (!resizer || !app) return;

const saved = localStorage.getItem("inheritanceChartSidebarWidth");

if (saved) {
  app.style.setProperty("--sidebar-width", saved + "px");
}

let resizing = false;

resizer.addEventListener("pointerdown", e => {
  resizing = true;
  resizer.classList.add("resizing");
  resizer.setPointerCapture(e.pointerId);
  e.preventDefault();
});

resizer.addEventListener("pointermove", e => {
  if (!resizing) return;

  const rect = app.getBoundingClientRect();
  const width = e.clientX - rect.left;

  const min = 280;
  const max = Math.min(700, rect.width - 320);

  const next = Math.max(min, Math.min(max, width));

  app.style.setProperty("--sidebar-width", next + "px");
});

resizer.addEventListener("pointerup", e => {
  if (!resizing) return;

  resizing = false;
  resizer.classList.remove("resizing");

  try {
    resizer.releasePointerCapture(e.pointerId);
  } catch {}

  const current = getComputedStyle(app).getPropertyValue("--sidebar-width").trim();
  const num = parseInt(current, 10);

  if (Number.isFinite(num)) {
    localStorage.setItem("inheritanceChartSidebarWidth", String(num));
  }
});
}

function switchSideTab(tabName) {
  document.querySelectorAll(".side-tab-button").forEach((button) => {
    const isActive = button.dataset.sideTab === tabName;

    button.classList.toggle("active", isActive);
    button.setAttribute("aria-selected", String(isActive));
  });

  document.querySelectorAll(".side-tab-panel").forEach((panel) => {
    panel.classList.remove("active");
  });

  const target = document.getElementById(`sideTab_${tabName}`);

  if (target) {
    target.classList.add("active");
  }
}


function openBulkEditModal() {
renderBulkEditTables();
document.getElementById("bulkEditModalBackdrop")?.classList.add("show");
}

function closeBulkEditModal() {
document.getElementById("bulkEditModalBackdrop")?.classList.remove("show");
}

function switchBulkEditTab(tabName) {
  document.querySelectorAll(".bulk-tab-button").forEach((button) => {
    const isActive = button.dataset.bulkTab === tabName;

    button.classList.toggle("active", isActive);
    button.setAttribute("aria-selected", String(isActive));
  });

  document.querySelectorAll(".bulk-tab-panel").forEach((panel) => {
    panel.classList.remove("active");
  });

  const target = document.getElementById(`bulkTab_${tabName}`);

  if (target) {
    target.classList.add("active");
  }
}


function openRelationListModal() {
document.getElementById("relationListModalBackdrop")?.classList.add("show");

if (typeof renderFamilyTable === "function") {
  renderFamilyTable();
}
}

function closeRelationListModal() {
document.getElementById("relationListModalBackdrop")?.classList.remove("show");
}

// 背景クリックで閉じる
document.addEventListener("click", e => {
  if (e.target?.id === "bulkEditModalBackdrop") {
    closeBulkEditModal();
  }

  if (e.target?.id === "relationListModalBackdrop") {
    closeRelationListModal();
  }

  if (e.target?.id === "annotationEditModalBackdrop") {
    closeAnnotationEditModal();
  }
});


/* =========================================================
   v2: 親族の新規追加・関係作成UI改善
   ========================================================= */

let relationCompletionTimer = null;

function getRelationModeDefinition() {
  const definitions = {
    spouse: {
      title: "夫婦関係を作成",
      total: 2,
      instructions: [
        "1人目をクリックしてください。",
        "配偶者にする人物をクリックしてください。"
      ]
    },
    child1: {
      title: "親子関係を作成（1親）",
      total: 2,
      instructions: [
        "親にする人物をクリックしてください。",
        "子にする人物をクリックしてください。"
      ]
    },
    child2: {
      title: "親子関係を作成（2親）",
      total: 3,
      instructions: [
        "親1をクリックしてください。",
        "親2をクリックしてください。",
        "子にする人物をクリックしてください。"
      ]
    }
  };

  return definitions[relationMode] || null;
}

function getRelationModeProgress() {
  const definition = getRelationModeDefinition();
  if (!definition) return null;

  const currentStep = Math.min(
    relationClicks.length + 1,
    definition.total
  );

  return {
    definition,
    currentStep,
    selectedCount: relationClicks.length,
    selectedNames: relationClicks.map(personDisplayName),
    instruction:
      definition.instructions[currentStep - 1] ||
      definition.instructions[definition.instructions.length - 1]
  };
}

function updateRelationToolUi(completionMessage = "") {
  document.querySelectorAll(".relation-tool-button").forEach(button => {
    const active =
      !!relationMode &&
      button.dataset.relationMode === relationMode;

    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });

  if (svg) {
    svg.classList.toggle("relation-mode", !!relationMode);
  }

  const banner = document.getElementById("canvasModeBanner");
  const stepElement = document.getElementById("canvasModeStep");
  const titleElement = document.getElementById("canvasModeTitle");
  const textElement = document.getElementById("canvasModeText");

  if (!banner || !stepElement || !titleElement || !textElement) {
    return;
  }

  if (completionMessage) {
    banner.hidden = false;
    banner.classList.add("complete");

    stepElement.textContent = "完了";
    titleElement.textContent = "関係を登録しました";
    textElement.textContent = completionMessage;

    if (relationCompletionTimer) {
      clearTimeout(relationCompletionTimer);
    }

    relationCompletionTimer = setTimeout(() => {
      banner.hidden = true;
      banner.classList.remove("complete");
      relationCompletionTimer = null;
    }, 3200);

    return;
  }

  if (!relationMode) {
    banner.hidden = true;
    banner.classList.remove("complete");
    return;
  }

  if (relationCompletionTimer) {
    clearTimeout(relationCompletionTimer);
    relationCompletionTimer = null;
  }

  const progress = getRelationModeProgress();

  if (!progress) {
    banner.hidden = true;
    return;
  }

  banner.hidden = false;
  banner.classList.remove("complete");

  stepElement.textContent =
    `${progress.currentStep}/${progress.definition.total}`;
  titleElement.textContent = progress.definition.title;

  const selectedCount =
    `${progress.selectedCount}/${progress.definition.total}人選択済み。`;
  const selectedNames = progress.selectedNames.length
    ? `選択中: ${progress.selectedNames.join("、")}。`
    : "";

  textElement.textContent =
    `${selectedCount}${selectedNames}${progress.instruction} ` +
    "Escまたは「中止」でキャンセルできます。";
}

function finishRelationMode(message) {
  relationMode = null;
  relationClicks = [];
  relationPreviewMouse = null;

  normalizeRelations();
  sync();

  updateRelationModeStatus(message);
  updateRelationToolUi(message);
}


function activateNewPersonForEditing(id) {
  selectOnly(id);

  switchSideTab("people");
  sync();

  const nameInput = document.getElementById("name");

  if (!nameInput) {
    return;
  }

  nameInput.focus();
  nameInput.select();
}

function createRelatedPerson(base) {
  const newPerson = createPerson(base);
  people.push(newPerson);
  return newPerson;
}

function getParentFamiliesForPerson(childId) {
  return families.filter(f =>
    Array.isArray(f.children) &&
    f.children.includes(childId)
  );
}

function getFirstSpouseOfPerson(personId) {
  const target = person(personId);

  if (!target) {
    return null;
  }

  const spouseId = (target.spouses || []).find(id => person(id));
  return spouseId ? person(spouseId) : null;
}

function nodeMenuAddNewSpouse() {
  const targetId = nodeContextTargetId;
  const target = person(targetId);

  hideNodeContextMenu();

  if (!target) {
    return;
  }

  pushUndo("配偶者新規追加前");

  const spouse = createRelatedPerson({
    name: "新規配偶者",
    relation: "配偶者",
    x: target.x + NODE_W + 60,
    y: target.y
  });

  getOrCreateFamily([target.id, spouse.id]);
  familyModelInitialized = true;

  activateNewPersonForEditing(spouse.id);
}

function nodeMenuAddNewParent() {
  const targetId = nodeContextTargetId;
  const target = person(targetId);

  hideNodeContextMenu();

  if (!target) {
    return;
  }

  normalizeRelations();

  const existingParents = unique(target.parents || [])
    .filter(id => person(id));

  if (existingParents.length >= 2) {
    const proceed = confirm(
      `${personLabel(target.id)} には既に親が2人登録されています。\n\n` +
      "新しい親を別の1親関係として追加しますか？\n" +
      "追加後は、必要に応じて関係一覧または一括編集で確認してください。"
    );

    if (!proceed) {
      return;
    }
  }

  pushUndo("親新規追加前");

  const parent = createRelatedPerson({
    name: "新規親",
    relation: "親",
    x: target.x,
    y: target.y - NODE_H - 100
  });

  let family = null;

  if (existingParents.length === 1) {
    const parentFamilies = getParentFamiliesForPerson(target.id);

    family =
      parentFamilies.find(f =>
        f.parents.includes(existingParents[0])
      ) || null;

    if (family && family.parents.length < 2) {
      family.parents = unique([
        ...family.parents,
        parent.id
      ]);
    } else {
      family = getOrCreateFamily([
        existingParents[0],
        parent.id
      ]);
    }
  } else {
    family = getOrCreateFamily([parent.id]);
  }

  if (!family.children.includes(target.id)) {
    family.children.push(target.id);
  }

  familyModelInitialized = true;
  activateNewPersonForEditing(parent.id);
}

function nodeMenuAddNewChild() {
  const targetId = nodeContextTargetId;
  const target = person(targetId);

  hideNodeContextMenu();

  if (!target) {
    return;
  }

  normalizeRelations();

  const spouse = getFirstSpouseOfPerson(target.id);
  const parentIds = [target.id];

  if (spouse) {
    const includeSpouse = confirm(
      `${personLabel(target.id)} には配偶者 ${personLabel(spouse.id)} が登録されています。\n\n` +
      "配偶者も親として登録しますか？\n\n" +
      "OK: 2人の子として追加\n" +
      "キャンセル: 選択人物だけの子として追加"
    );

    if (includeSpouse) {
      parentIds.push(spouse.id);
    }
  }

  pushUndo("子新規追加前");

  const family = getOrCreateFamily(parentIds);
  const anchor = getFamilyAnchor(family);

  const existingChildCount = (family.children || []).length;

  const child = createRelatedPerson({
    name: "新規子",
    relation: "子",
    x:
      anchor.x -
      NODE_W / 2 +
      existingChildCount * (NODE_W + 40),
    y:
      Math.max(
        target.y + NODE_H + 100,
        spouse ? spouse.y + NODE_H + 100 : 0
      )
  });

  family.children.push(child.id);
  family.children = unique(family.children);

  familyModelInitialized = true;
  activateNewPersonForEditing(child.id);
}


window.nodeMenuStartSpouse = function() {
  if (!nodeContextTargetId) {
    return;
  }

  beginRelationMode("spouse", [nodeContextTargetId]);
};

window.nodeMenuStartChild1 = function() {
  if (!nodeContextTargetId) {
    return;
  }

  beginRelationMode("child1", [nodeContextTargetId]);
};

window.nodeMenuStartChild2 = function() {
  if (!nodeContextTargetId) {
    return;
  }

  beginRelationMode("child2", [nodeContextTargetId]);
};

window.nodeMenuAddNewSpouse = nodeMenuAddNewSpouse;
window.nodeMenuAddNewParent = nodeMenuAddNewParent;
window.nodeMenuAddNewChild = nodeMenuAddNewChild;

/*
 * HTMLのonclickはwindow側を参照します。
 * 既存コード内部から呼ばれる関数宣言についても、下記イベント補助で
 * UI表示が同期するようにします。
 */

document.addEventListener("click", event => {
  const relationButton = event.target.closest?.(
    ".relation-tool-button"
  );

  if (relationButton) {
    setTimeout(() => {
      updateRelationToolUi();
    }, 0);
  }
});

svg.addEventListener("click", () => {
  setTimeout(() => {
    updateRelationToolUi();
  }, 0);
});

document.addEventListener("keydown", event => {
  if (event.key === "Escape") {
    setTimeout(() => {
      updateRelationToolUi();
    }, 0);
  }
});

/* =========================================================
   v3: 図形・注釈
   ========================================================= */

function nextAnnotationId() {
  let max = 0;

  annotations.forEach(item => {
    const match = String(item.id || "").match(/^A(\d+)$/);

    if (match) {
      max = Math.max(max, Number(match[1]));
    }
  });

  return "A" + String(max + 1).padStart(3, "0");
}

function createAnnotation(base = {}) {
  const type = [
    "text",
    "rect",
    "ellipse",
    "cross",
    "arrow"
  ].includes(base.type)
    ? base.type
    : "text";

  const defaultWidth = type === "text" ? 200 : 180;
  const defaultHeight = type === "text" ? 64 : 80;

  let width = Number.isFinite(base.width)
    ? base.width
    : defaultWidth;

  let height = Number.isFinite(base.height)
    ? base.height
    : defaultHeight;

  /*
   * 矢印のみ負方向を許可する。
   * その他の図形は左上起点・正の幅と高さで管理する。
   */
  if (type === "arrow") {
    if (Math.abs(width) < 1) {
      width = width < 0 ? -1 : 1;
    }

    if (Math.abs(height) < 1) {
      height = height < 0 ? -1 : 1;
    }
  } else {
    width = Math.max(30, Math.abs(width));
    height = Math.max(30, Math.abs(height));
  }

  return {
    id: base.id || nextAnnotationId(),
    type,
    layer: type !== "text" && base.layer === "back" ? "back" : "front",

    x: Number.isFinite(base.x)
      ? base.x
      : 120,

    y: Number.isFinite(base.y)
      ? base.y
      : 120,

    width,
    height,

    text: String(base.text || ""),

    fill:
      base.fill === "none" ||
      base.fill === "transparent"
        ? base.fill
        : base.fill || defaultAnnotationFill(type),

    stroke: base.stroke || "#7557a6",
    color: base.color || "#252930",

    fontSize: Number.isFinite(base.fontSize)
      ? clamp(base.fontSize, 8, 72)
      : 14,

    strokeWidth: Number.isFinite(base.strokeWidth)
      ? clamp(base.strokeWidth, 1, 12)
      : 2,

    startPersonId: String(base.startPersonId || ""),
    endPersonId: String(base.endPersonId || ""),
    startAnchor: String(base.startAnchor || ""),
    endAnchor: String(base.endAnchor || "")
  };
}

function defaultAnnotationFill(type) {
  if (type === "text") {
    return "#fffceb";
  }

  if (type === "rect" || type === "ellipse") {
    return "#ffffff";
  }

  return "none";
}

function annotation(id) {
  return annotations.find(item => item.id === id);
}

function isAnnotationSelected(id) {
  return (
    selectedAnnotationId === id ||
    selectedAnnotationIds.has(id)
  );
}

function selectOnlyAnnotation(id) {
  selectedAnnotationId = id || null;
  selectedAnnotationIds = id
    ? new Set([id])
    : new Set();

  selectedId = null;
  selectedIds.clear();
}

function toggleAnnotationSelection(id) {
  if (!id) {
    return;
  }

  if (selectedAnnotationIds.has(id)) {
    selectedAnnotationIds.delete(id);

    if (selectedAnnotationId === id) {
      selectedAnnotationId =
        selectedAnnotationIds.size
          ? [...selectedAnnotationIds][0]
          : null;
    }
  } else {
    selectedAnnotationIds.add(id);
    selectedAnnotationId = id;
  }

  selectedId = null;
  selectedIds.clear();
}

function getSelectedAnnotations() {
  const ids = selectedAnnotationIds.size
    ? [...selectedAnnotationIds]
    : selectedAnnotationId
      ? [selectedAnnotationId]
      : [];

  return ids
    .map(annotation)
    .filter(Boolean);
}

function clearAnnotationSelection() {
  selectedAnnotationId = null;
  selectedAnnotationIds.clear();
  renderChart();
}

function alignSelectedAnnotationsLeft() {
  const items = getSelectedAnnotations();

  if (items.length < 2) {
    alert("2つ以上の図形を選択してください。");
    return false;
  }

  pushUndo("図形左揃え前");

  const left = Math.min(
    ...items.map(item => getAnnotationBounds(item).minX)
  );

  items.forEach(item => {
    const bounds = getAnnotationBounds(item);
    item.x += left - bounds.minX;

    /*
     * 矢印を手動配置した場合は吸着を解除する。
     */
    clearArrowAttachment(item);
  });

  sync();
  return true;
}

function alignSelectedAnnotationsTop() {
  const items = getSelectedAnnotations();

  if (items.length < 2) {
    alert("2つ以上の図形を選択してください。");
    return false;
  }

  pushUndo("図形上揃え前");

  const top = Math.min(
    ...items.map(item => getAnnotationBounds(item).minY)
  );

  items.forEach(item => {
    const bounds = getAnnotationBounds(item);
    item.y += top - bounds.minY;
    clearArrowAttachment(item);
  });

  sync();
  return true;
}

function distributeSelectedAnnotationsHorizontally() {
  const items = getSelectedAnnotations();

  if (items.length < 3) {
    alert("横方向の均等配置には3つ以上の図形を選択してください。");
    return false;
  }

  pushUndo("図形横均等配置前");

  const sorted = [...items].sort(
    (a, b) =>
      getAnnotationBounds(a).minX -
      getAnnotationBounds(b).minX
  );

  const firstBounds = getAnnotationBounds(sorted[0]);
  const lastBounds = getAnnotationBounds(
    sorted[sorted.length - 1]
  );

  const firstCenter =
    (firstBounds.minX + firstBounds.maxX) / 2;

  const lastCenter =
    (lastBounds.minX + lastBounds.maxX) / 2;

  const step =
    (lastCenter - firstCenter) /
    (sorted.length - 1);

  sorted.slice(1, -1).forEach((item, index) => {
    const bounds = getAnnotationBounds(item);
    const currentCenter =
      (bounds.minX + bounds.maxX) / 2;

    const targetCenter =
      firstCenter + step * (index + 1);

    item.x += targetCenter - currentCenter;
    clearArrowAttachment(item);
  });

  sync();
  return true;
}

function distributeSelectedAnnotationsVertically() {
  const items = getSelectedAnnotations();

  if (items.length < 3) {
    alert("縦方向の均等配置には3つ以上の図形を選択してください。");
    return false;
  }

  pushUndo("図形縦均等配置前");

  const sorted = [...items].sort(
    (a, b) =>
      getAnnotationBounds(a).minY -
      getAnnotationBounds(b).minY
  );

  const firstBounds = getAnnotationBounds(sorted[0]);
  const lastBounds = getAnnotationBounds(
    sorted[sorted.length - 1]
  );

  const firstCenter =
    (firstBounds.minY + firstBounds.maxY) / 2;

  const lastCenter =
    (lastBounds.minY + lastBounds.maxY) / 2;

  const step =
    (lastCenter - firstCenter) /
    (sorted.length - 1);

  sorted.slice(1, -1).forEach((item, index) => {
    const bounds = getAnnotationBounds(item);
    const currentCenter =
      (bounds.minY + bounds.maxY) / 2;

    const targetCenter =
      firstCenter + step * (index + 1);

    item.y += targetCenter - currentCenter;
    clearArrowAttachment(item);
  });

  sync();
  return true;
}

function clearArrowAttachment(item) {
  if (!item || item.type !== "arrow") {
    return;
  }

  item.startPersonId = "";
  item.endPersonId = "";
  item.startAnchor = "";
  item.endAnchor = "";
}


function annotationTypeLabel(type) {
  const labels = {
    text: "テキスト",
    rect: "四角",
    ellipse: "丸・楕円",
    cross: "×印",
    arrow: "矢印"
  };

  return labels[type] || "図形";
}

function startAnnotationTool(type) {
  if (
    !["text", "rect", "ellipse", "cross", "arrow"]
      .includes(type)
  ) {
    return;
  }

  if (relationMode) {
    cancelRelationMode();
  }

  annotationTool = type;
  annotationCreating = null;

  selectedAnnotationId = null;
  selectedAnnotationIds.clear();

  selectedId = null;
  selectedIds.clear();

  hideNodeContextMenu();
  hideAnnotationContextMenu();

  updateAnnotationToolUi();
  renderChart();
}


function cancelAnnotationTool() {
  if (annotationCreating?.pointerId !== undefined) {
    try {
      svg.releasePointerCapture(annotationCreating.pointerId);
    } catch {}
  }

  svg.removeEventListener("pointermove", moveAnnotationCreate);
  svg.removeEventListener("pointerup", endAnnotationCreate);

  annotationTool = null;
  annotationCreating = null;
  arrowEndpointDragging = null;

  updateAnnotationToolUi();
  renderChart();
}



function updateAnnotationToolUi() {
  document.querySelectorAll(".annotation-tool-button").forEach(button => {
    const active = button.dataset.annotationTool === annotationTool;

    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });

  svg.classList.toggle("annotation-mode", !!annotationTool);

  const status = document.getElementById("annotationToolStatus");

  if (!status) {
    return;
  }

  status.classList.toggle("active", !!annotationTool);

  if (!annotationTool) {
    status.textContent = "図形追加ツールは未選択です。";
    return;
  }

  const label = annotationTypeLabel(annotationTool);

  if (annotationTool === "text") {
    status.textContent =
      `${label}追加中: 図上の配置位置をクリックして入力してください。` +
      "Escキーで中止できます。";
    return;
  }

  status.textContent =
    `${label}追加中: 図上をドラッグして作成してください。` +
    "Shiftキーで形状・方向を固定できます。Escキーで中止できます。";
}


function createAnnotationAt(type, x, y) {
  let item = null;

  if (type === "rect") {
    item = createAnnotation({
      type,
      x,
      y,
      width: 220,
      height: 120
    });
  } else if (type === "ellipse") {
    item = createAnnotation({
      type,
      x,
      y,
      width: 160,
      height: 100
    });
  } else if (type === "cross") {
    item = createAnnotation({
      type,
      x,
      y,
      width: 70,
      height: 70,
      stroke: "#a94253",
      strokeWidth: 3
    });
  } else if (type === "arrow") {
    item = createAnnotation({
      type,
      x,
      y,
      width: 180,
      height: 80,
      stroke: "#7557a6",
      strokeWidth: 2
    });
  }

  if (!item) {
    return null;
  }

  annotations.push(item);
  selectOnlyAnnotation(item.id);

  return item;
}

function startAnnotationCreate(event) {
  if (!annotationTool || annotationTool === "text") {
    return false;
  }

  if (event.button !== undefined && event.button !== 0) {
    return false;
  }

  if (
    event.target.closest?.(".node") ||
    event.target.closest?.(".annotation")
  ) {
    return false;
  }

  event.preventDefault();
  event.stopPropagation();

  const point = clientToWorld(event.clientX, event.clientY);

  annotationCreating = {
    type: annotationTool,
    startX: point.x,
    startY: point.y,
    endX: point.x,
    endY: point.y,
    shiftKey: event.shiftKey,
    pointerId: event.pointerId
  };

  svg.setPointerCapture(event.pointerId);
  svg.addEventListener("pointermove", moveAnnotationCreate);
  svg.addEventListener("pointerup", endAnnotationCreate);

  renderChart();

  return true;
}

function moveAnnotationCreate(event) {
  if (!annotationCreating) {
    return;
  }

  const point = clientToWorld(event.clientX, event.clientY);

  annotationCreating.endX = point.x;
  annotationCreating.endY = point.y;
  annotationCreating.shiftKey = event.shiftKey;

  applyAnnotationCreateConstraint(annotationCreating);
  renderChart();
}

function applyAnnotationCreateConstraint(state) {
  const rawDx = state.endX - state.startX;
  const rawDy = state.endY - state.startY;

  if (!state.shiftKey) {
    return;
  }

  if (
    state.type === "rect" ||
    state.type === "ellipse" ||
    state.type === "cross"
  ) {
    const size = Math.max(Math.abs(rawDx), Math.abs(rawDy));

    state.endX =
      state.startX + (rawDx < 0 ? -size : size);

    state.endY =
      state.startY + (rawDy < 0 ? -size : size);

    return;
  }

  if (state.type === "arrow") {
    const length = Math.hypot(rawDx, rawDy);

    if (length < 1) {
      return;
    }

    const angle = Math.atan2(rawDy, rawDx);
    const unit = Math.PI / 4;
    const snappedAngle = Math.round(angle / unit) * unit;

    state.endX =
      state.startX + Math.cos(snappedAngle) * length;

    state.endY =
      state.startY + Math.sin(snappedAngle) * length;
  }
}

function endAnnotationCreate(event) {
  const state = annotationCreating;
  annotationCreating = null;

  try {
    svg.releasePointerCapture(event.pointerId);
  } catch {}

  svg.removeEventListener(
    "pointermove",
    moveAnnotationCreate
  );

  svg.removeEventListener(
    "pointerup",
    endAnnotationCreate
  );

  if (!state) {
    renderChart();
    return;
  }

  const beforeSnapshot =
    makeSnapshot("図形・注釈追加前");

  const dx = state.endX - state.startX;
  const dy = state.endY - state.startY;
  const dragDistance = Math.hypot(dx, dy);

  const item =
    dragDistance < 8
      ? createAnnotationAt(
          state.type,
          state.startX,
          state.startY
        )
      : createAnnotationFromDrag(state);

  if (!item) {
    renderChart();
    return;
  }

  pushUndoSnapshot(beforeSnapshot);

  annotationTool = null;
  updateAnnotationToolUi();
  sync();
}


function createAnnotationFromDrag(state) {
  const dx = state.endX - state.startX;
  const dy = state.endY - state.startY;

  let item = null;

  if (state.type === "arrow") {
    item = createAnnotation({
      type: "arrow",
      x: state.startX,
      y: state.startY,
      width: dx,
      height: dy,
      stroke: "#7557a6",
      strokeWidth: 2
    });
  } else {
    const x = Math.min(state.startX, state.endX);
    const y = Math.min(state.startY, state.endY);

    item = createAnnotation({
      type: state.type,
      x,
      y,
      width: Math.max(20, Math.abs(dx)),
      height: Math.max(20, Math.abs(dy)),
      stroke:
        state.type === "cross"
          ? "#a94253"
          : "#7557a6",
      strokeWidth:
        state.type === "cross"
          ? 3
          : 2
    });
  }

  annotations.push(item);
  selectOnlyAnnotation(item.id);

  return item;
}



function drawAnnotationCreatePreview() {
  const state = annotationCreating;

  if (!state) {
    return;
  }

  const dx = state.endX - state.startX;
  const dy = state.endY - state.startY;

  if (state.type === "rect") {
    viewport.appendChild(svgEl("rect", {
      x: Math.min(state.startX, state.endX),
      y: Math.min(state.startY, state.endY),
      width: Math.abs(dx),
      height: Math.abs(dy),
      class: "annotation-create-preview"
    }));
  }

  if (state.type === "ellipse") {
    viewport.appendChild(svgEl("ellipse", {
      cx: (state.startX + state.endX) / 2,
      cy: (state.startY + state.endY) / 2,
      rx: Math.abs(dx) / 2,
      ry: Math.abs(dy) / 2,
      class: "annotation-create-preview"
    }));
  }

  if (state.type === "cross") {
    viewport.appendChild(svgEl("path", {
      d:
        `M ${state.startX} ${state.startY} ` +
        `L ${state.endX} ${state.endY} ` +
        `M ${state.endX} ${state.startY} ` +
        `L ${state.startX} ${state.endY}`,
      class: "annotation-create-preview cross"
    }));
  }

  if (state.type === "arrow") {
    viewport.appendChild(svgEl("line", {
      x1: state.startX,
      y1: state.startY,
      x2: state.endX,
      y2: state.endY,
      class: "annotation-create-preview arrow",
      "marker-end": "url(#annotationArrowHead)"
    }));
  }

  viewport.appendChild(svgEl("circle", {
    cx: state.startX,
    cy: state.startY,
    r: 4,
    class: "annotation-create-start"
  }));
}

function handleAnnotationCanvasClick(event) {
  if (annotationTool !== "text") {
    return false;
  }

  if (
    event.target.closest?.(".node") ||
    event.target.closest?.(".annotation")
  ) {
    return false;
  }

  event.preventDefault();
  event.stopPropagation();

  const point = clientToWorld(
    event.clientX,
    event.clientY
  );

  const beforeSnapshot =
    makeSnapshot("テキスト注釈追加前");

  const item = createAnnotation({
    type: "text",
    x: point.x,
    y: point.y,
    width: 200,
    height: 64,
    text: ""
  });

  annotationTool = null;
  updateAnnotationToolUi();

  beginAnnotationTextEdit(item, {
    isNew: true,
    beforeSnapshot
  });

  return true;
}

function beginAnnotationTextEdit(
  item,
  { isNew = false, beforeSnapshot = null } = {}
) {
  if (!item) {
    return;
  }

  if (annotationTextEdit) {
    finishAnnotationTextEdit(true);
  }

  annotationTextEdit = {
    id: item.id,
    item: isNew ? item : null,
    isNew,
    value: isNew ? "" : String(item.text || ""),
    beforeSnapshot:
      beforeSnapshot ||
      makeSnapshot("テキスト注釈編集前"),
    isComposing: false
  };

  if (!isNew) {
    selectOnlyAnnotation(item.id);
  }

  hideAnnotationContextMenu();
  renderChart();
  focusAnnotationTextEditor();
}

function focusAnnotationTextEditor() {
  const editor =
    document.getElementById("annotationInlineEditor");

  if (!editor) {
    return;
  }

  editor.focus({ preventScroll: true });

  const cursor = editor.value.length;
  editor.setSelectionRange(cursor, cursor);
}

function handleAnnotationTextEditorKeydown(event) {
  event.stopPropagation();

  const edit = annotationTextEdit;
  if (!edit) {
    return;
  }

  edit.value = event.currentTarget.value;

  const isComposing =
    edit.isComposing ||
    event.isComposing ||
    event.keyCode === 229;

  if (event.key === "Escape") {
    if (isComposing) {
      return;
    }

    event.preventDefault();
    finishAnnotationTextEdit(false);
    return;
  }

  if (
    event.key === "Enter" &&
    !event.shiftKey &&
    !isComposing
  ) {
    event.preventDefault();
    finishAnnotationTextEdit(true);
  }
}

function finishAnnotationTextEdit(accept) {
  const edit = annotationTextEdit;

  if (!edit || renderingChart) {
    return;
  }

  annotationTextEdit = null;

  if (!accept) {
    renderChart();
    return;
  }

  const text = String(edit.value || "");

  if (edit.isNew) {
    if (!text.trim()) {
      renderChart();
      return;
    }

    edit.item.text = text;
    pushUndoSnapshot(edit.beforeSnapshot);
    annotations.push(edit.item);
    selectOnlyAnnotation(edit.item.id);
    sync();
    return;
  }

  const item = annotation(edit.id);

  if (!item) {
    renderChart();
    return;
  }

  if (item.text !== text) {
    pushUndoSnapshot(edit.beforeSnapshot);
    item.text = text;
  }

  selectOnlyAnnotation(item.id);
  sync();
}

function drawAnnotationTextEditor() {
  const edit = annotationTextEdit;

  if (!edit) {
    return;
  }

  const item = edit.isNew
    ? edit.item
    : annotation(edit.id);

  if (!item) {
    return;
  }

  const group = svgEl("g", {
    class: "annotation-text-editor-overlay",
    transform: `translate(${item.x}, ${item.y})`
  });

  group.appendChild(svgEl("rect", {
    x: 0,
    y: 0,
    width: item.width,
    height: item.height,
    rx: 5,
    ry: 5,
    class: "annotation-shape annotation-text-editor-background",
    fill: item.fill,
    stroke: item.stroke,
    "stroke-width": item.strokeWidth
  }));

  const foreignObject = svgEl("foreignObject", {
    x: 0,
    y: 0,
    width: item.width,
    height: item.height
  });

  const editor = document.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "textarea"
  );

  editor.id = "annotationInlineEditor";
  editor.setAttribute("class", "annotation-inline-text-editor");
  editor.setAttribute("aria-label", "テキスト注釈");
  editor.placeholder = "ここにテキストを入力";
  editor.value = edit.value;

  editor.addEventListener("input", () => {
    if (annotationTextEdit === edit) {
      edit.value = editor.value;
    }
  });

  editor.addEventListener("compositionstart", () => {
    if (annotationTextEdit === edit) {
      edit.isComposing = true;
    }
  });

  editor.addEventListener("compositionend", () => {
    if (annotationTextEdit === edit) {
      edit.isComposing = false;
      edit.value = editor.value;
    }
  });

  editor.addEventListener(
    "keydown",
    handleAnnotationTextEditorKeydown
  );

  editor.addEventListener("focusout", () => {
    if (annotationTextEdit === edit && editor.isConnected) {
      edit.value = editor.value;
      finishAnnotationTextEdit(true);
    }
  });

  ["pointerdown", "pointerup", "click", "dblclick"]
    .forEach(type => {
      editor.addEventListener(type, event => {
        event.stopPropagation();
      });
    });

  foreignObject.appendChild(editor);
  group.appendChild(foreignObject);
  viewport.appendChild(group);
}


function drawAnnotations(layer) {
  if (layer === "back") ensureArrowMarker();

  annotations.forEach(item => {
    if (item.layer === layer) drawAnnotation(item);
  });
}

function ensureArrowMarker() {
  let defs = viewport.querySelector("defs");


  if (!defs) {
    defs = svgEl("defs", {});
    viewport.appendChild(defs);
  }

  const marker = svgEl("marker", {
    id: "annotationArrowHead",
    markerWidth: 10,
    markerHeight: 10,
    refX: 8,
    refY: 3,
    orient: "auto",
    markerUnits: "strokeWidth"
  });

  const markerPath = svgEl("path", {
    d: "M0,0 L0,6 L9,3 z",
    class: "annotation-arrow-marker",
    fill: "context-stroke"
  });

  marker.appendChild(markerPath);
  defs.appendChild(marker);
}

function drawAnnotationSelectionOverlays() {
  getSelectedAnnotations().forEach(item => {
    const isPrimarySelected =
      item.id === selectedAnnotationId;

    const isMultiSelected =
      selectedAnnotationIds.has(item.id) &&
      !isPrimarySelected;

    const group = svgEl("g", {
      class:
        `annotation-selection-overlay annotation-${item.type}` +
        (isPrimarySelected ? " selected" : "") +
        (isMultiSelected ? " multi-selected" : ""),
      transform: `translate(${item.x}, ${item.y})`
    });

    const bounds = getAnnotationLocalSelectionBounds(item);

    group.appendChild(svgEl("rect", {
      x: bounds.x - 5,
      y: bounds.y - 5,
      width: bounds.width + 10,
      height: bounds.height + 10,
      class: "annotation-selection-box"
    }));

    if (item.type === "arrow") {
      const startHandle = svgEl("circle", {
        cx: 0,
        cy: 0,
        r: 7,
        class: "annotation-arrow-endpoint start"
      });

      startHandle.dataset.annotationId = item.id;
      startHandle.dataset.endpoint = "start";
      startHandle.addEventListener(
        "pointerdown",
        startArrowEndpointDrag
      );
      group.appendChild(startHandle);

      const endHandle = svgEl("circle", {
        cx: item.width,
        cy: item.height,
        r: 7,
        class: "annotation-arrow-endpoint end"
      });

      endHandle.dataset.annotationId = item.id;
      endHandle.dataset.endpoint = "end";
      endHandle.addEventListener(
        "pointerdown",
        startArrowEndpointDrag
      );
      group.appendChild(endHandle);
    } else {
      const resizeHandle = svgEl("rect", {
        x: item.width - 6,
        y: item.height - 6,
        width: 12,
        height: 12,
        rx: 2,
        ry: 2,
        class: "annotation-resize-handle"
      });

      resizeHandle.dataset.annotationId = item.id;
      resizeHandle.addEventListener(
        "pointerdown",
        startAnnotationResize
      );
      group.appendChild(resizeHandle);
    }

    group.addEventListener("contextmenu", event => {
      event.preventDefault();
      event.stopPropagation();
      showAnnotationContextMenu(
        item.id,
        event.clientX,
        event.clientY
      );
    });

    viewport.appendChild(group);
  });
}


function drawAnnotation(item) {
  const isPrimarySelected =
    item.id === selectedAnnotationId;

  const isMultiSelected =
    selectedAnnotationIds.has(item.id) &&
    !isPrimarySelected;

  const group = svgEl("g", {
    class:
      `annotation annotation-${item.type}` +
      (isPrimarySelected ? " selected" : "") +
      (isMultiSelected ? " multi-selected" : ""),
    transform: `translate(${item.x}, ${item.y})`
  });

  group.dataset.annotationId = item.id;

  if (item.type === "text") {
    drawTextAnnotation(group, item);
  }

  if (item.type === "rect") {
    group.appendChild(svgEl("rect", {
      x: 0,
      y: 0,
      width: item.width,
      height: item.height,
      rx: 5,
      ry: 5,
      class: "annotation-shape",
      fill: item.fill,
      stroke: item.stroke,
      "stroke-width": item.strokeWidth
    }));

    drawShapeAnnotationText(group, item);
  }

  if (item.type === "ellipse") {
    group.appendChild(svgEl("ellipse", {
      cx: item.width / 2,
      cy: item.height / 2,
      rx: Math.abs(item.width) / 2,
      ry: Math.abs(item.height) / 2,
      class: "annotation-shape",
      fill: item.fill,
      stroke: item.stroke,
      "stroke-width": item.strokeWidth
    }));

    drawShapeAnnotationText(group, item);
  }

  if (item.type === "cross") {
    group.appendChild(svgEl("path", {
      d:
        `M 0 0 L ${item.width} ${item.height} ` +
        `M ${item.width} 0 L 0 ${item.height}`,
      class: "annotation-shape",
      stroke: item.stroke,
      "stroke-width": item.strokeWidth
    }));
  }

  if (item.type === "arrow") {
    group.appendChild(svgEl("line", {
      x1: 0,
      y1: 0,
      x2: item.width,
      y2: item.height,
      class: "annotation-shape",
      stroke: item.stroke,
      "stroke-width": item.strokeWidth,
      "marker-end": "url(#annotationArrowHead)"
    }));
  }


  group.addEventListener("pointerdown", startAnnotationDrag);
  group.addEventListener("click", event => {
    event.stopPropagation();
  });


  group.addEventListener("dblclick", event => {
    event.preventDefault();
    event.stopPropagation();

    if (item.type === "text") {
      return;
    }

    selectedAnnotationId = item.id;
    openAnnotationEditModal();
  });

  group.addEventListener("contextmenu", event => {
    event.preventDefault();
    event.stopPropagation();

    showAnnotationContextMenu(
      item.id,
      event.clientX,
      event.clientY
    );
  });

  viewport.appendChild(group);
}

let arrowEndpointDragging = null;

function startArrowEndpointDrag(event) {
  event.preventDefault();
  event.stopPropagation();

  const id = event.currentTarget.dataset.annotationId;
  const endpoint = event.currentTarget.dataset.endpoint;
  const item = annotation(id);

  if (!item || item.type !== "arrow") {
    return;
  }

  selectOnlyAnnotation(id);
  arrowSnapTargetId = null;

  arrowEndpointDragging = {
    id,
    endpoint,
    originalX: item.x,
    originalY: item.y,
    originalWidth: item.width,
    originalHeight: item.height,
    beforeSnapshot: makeSnapshot("矢印端点変更前"),
    moved: false
  };

  svg.setPointerCapture(event.pointerId);

  svg.addEventListener(
    "pointermove",
    moveArrowEndpointDrag
  );

  svg.addEventListener(
    "pointerup",
    endArrowEndpointDrag
  );
}

function moveArrowEndpointDrag(event) {
  if (!arrowEndpointDragging) {
    return;
  }

  const state = arrowEndpointDragging;
  const item = annotation(state.id);

  if (!item) {
    return;
  }

  const point = clientToWorld(
    event.clientX,
    event.clientY
  );

  const snap = findNearestPersonAnchor(
    point.x,
    point.y
  );

  arrowSnapTargetId = snap?.personId || null;

  if (state.endpoint === "end") {
    let endX = snap ? snap.x : point.x;
    let endY = snap ? snap.y : point.y;

    /*
     * 吸着中は人物位置を優先する。
     * 非吸着時だけShiftによる45度固定を適用する。
     */
    if (!snap && event.shiftKey) {
      const snapped = snapPointTo45Degrees(
        item.x,
        item.y,
        endX,
        endY
      );

      endX = snapped.x;
      endY = snapped.y;
    }

    item.width = endX - item.x;
    item.height = endY - item.y;

    item.endPersonId = snap?.personId || "";
    item.endAnchor = snap?.anchorName || "";
  } else {
    const fixedEndX =
      state.originalX + state.originalWidth;

    const fixedEndY =
      state.originalY + state.originalHeight;

    let startX = snap ? snap.x : point.x;
    let startY = snap ? snap.y : point.y;

    if (!snap && event.shiftKey) {
      const snapped = snapPointTo45Degrees(
        fixedEndX,
        fixedEndY,
        startX,
        startY
      );

      startX = snapped.x;
      startY = snapped.y;
    }

    item.x = startX;
    item.y = startY;
    item.width = fixedEndX - startX;
    item.height = fixedEndY - startY;

    item.startPersonId = snap?.personId || "";
    item.startAnchor = snap?.anchorName || "";
  }

  state.moved = true;
  renderChart();
}

function endArrowEndpointDrag(event) {
  if (
    arrowEndpointDragging?.moved &&
    arrowEndpointDragging.beforeSnapshot
  ) {
    pushUndoSnapshot(
      arrowEndpointDragging.beforeSnapshot
    );
  }

  arrowEndpointDragging = null;
  arrowSnapTargetId = null;

  try {
    svg.releasePointerCapture(event.pointerId);
  } catch {}

  svg.removeEventListener(
    "pointermove",
    moveArrowEndpointDrag
  );

  svg.removeEventListener(
    "pointerup",
    endArrowEndpointDrag
  );

  sync();
}


function snapPointTo45Degrees(
  originX,
  originY,
  targetX,
  targetY
) {
  const dx = targetX - originX;
  const dy = targetY - originY;
  const length = Math.hypot(dx, dy);

  if (length < 1) {
    return {
      x: targetX,
      y: targetY
    };
  }

  const angle = Math.atan2(dy, dx);
  const unit = Math.PI / 4;
  const snappedAngle =
    Math.round(angle / unit) * unit;

  return {
    x: originX + Math.cos(snappedAngle) * length,
    y: originY + Math.sin(snappedAngle) * length
  };
}

let annotationResizing = null;

function startAnnotationResize(event) {
  event.preventDefault();
  event.stopPropagation();

  const id = event.currentTarget.dataset.annotationId;
  const item = annotation(id);

  if (!item) {
    return;
  }

  selectOnlyAnnotation(id);

  const point = clientToWorld(
    event.clientX,
    event.clientY
  );

  annotationResizing = {
    id,
    type: item.type,
    startWorldX: point.x,
    startWorldY: point.y,
    originalWidth: item.width,
    originalHeight: item.height,
    beforeSnapshot: makeSnapshot("図形サイズ変更前"),
    moved: false
  };

  svg.setPointerCapture(event.pointerId);
  svg.addEventListener(
    "pointermove",
    moveAnnotationResize
  );
  svg.addEventListener(
    "pointerup",
    endAnnotationResize
  );
}

function moveAnnotationResize(event) {
  if (!annotationResizing) {
    return;
  }

  const item = annotation(annotationResizing.id);

  if (!item) {
    return;
  }

  const point = clientToWorld(
    event.clientX,
    event.clientY
  );

  const dx =
    point.x - annotationResizing.startWorldX;

  const dy =
    point.y - annotationResizing.startWorldY;

  if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
    annotationResizing.moved = true;
  }

  if (
    annotationResizing.type === "arrow" ||
    annotationResizing.type === "cross"
  ) {
    item.width =
      annotationResizing.originalWidth + dx;

    item.height =
      annotationResizing.originalHeight + dy;
  } else {
    item.width = Math.max(
      20,
      annotationResizing.originalWidth + dx
    );

    item.height = Math.max(
      20,
      annotationResizing.originalHeight + dy
    );
  }

  renderChart();
}

function endAnnotationResize(event) {
  if (
    annotationResizing &&
    annotationResizing.moved &&
    annotationResizing.beforeSnapshot
  ) {
    pushUndoSnapshot(
      annotationResizing.beforeSnapshot
    );
  }

  annotationResizing = null;

  try {
    svg.releasePointerCapture(event.pointerId);
  } catch {}

  svg.removeEventListener(
    "pointermove",
    moveAnnotationResize
  );

  svg.removeEventListener(
    "pointerup",
    endAnnotationResize
  );

  sync();
}

function openAnnotationEditModal() {
  const id =
    annotationContextTargetId ||
    selectedAnnotationId;

  const item = annotation(id);

  hideAnnotationContextMenu();

  if (!item) {
    alert("編集する図形・注釈を選択してください。");
    return;
  }

  selectedAnnotationId = item.id;

  document.getElementById("annotationEditId").value = item.id;
  document.getElementById("annotationEditText").value = item.text || "";
  document.getElementById("annotationEditWidth").value =
    Math.round(Math.abs(item.width));
  document.getElementById("annotationEditHeight").value =
    Math.round(Math.abs(item.height));
  document.getElementById("annotationEditStroke").value =
    normalizeColorForPicker(item.stroke, "#7557a6");
  document.getElementById("annotationEditFill").value =
    normalizeColorForPicker(item.fill, "#ffffff");
  document.getElementById("annotationEditColor").value =
    normalizeColorForPicker(item.color, "#252930");
  document.getElementById("annotationEditStrokeWidth").value =
    item.strokeWidth;
  document.getElementById("annotationEditFontSize").value =
    item.fontSize;

  document.getElementById("annotationEditNoFill").checked =
    item.fill === "none" ||
    item.fill === "transparent";

    const supportsText = [
    "text",
    "rect",
    "ellipse"
  ].includes(item.type);

  document.getElementById("annotationTextEditArea").hidden =
    !supportsText;

  document.getElementById("annotationFontSizeArea").hidden =
    !supportsText;

  document.getElementById("annotationTextColorArea").hidden =
    !supportsText;

  document
    .getElementById("annotationEditModalBackdrop")
    ?.classList.add("show");

}

function closeAnnotationEditModal() {
  document
    .getElementById("annotationEditModalBackdrop")
    ?.classList.remove("show");
}

function applyAnnotationEdit() {
  const id =
    document.getElementById("annotationEditId")?.value;

  const item = annotation(id);

  if (!item) {
    closeAnnotationEditModal();
    return;
  }

  const width = Number(
    document.getElementById("annotationEditWidth")?.value
  );

  const height = Number(
    document.getElementById("annotationEditHeight")?.value
  );

  const strokeWidth = Number(
    document.getElementById("annotationEditStrokeWidth")?.value
  );

  const fontSize = Number(
    document.getElementById("annotationEditFontSize")?.value
  );

  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < 20 ||
    height < 20
  ) {
    alert("幅と高さは20以上の数値で入力してください。");
    return;
  }

  if (
    !Number.isFinite(strokeWidth) ||
    strokeWidth < 1 ||
    strokeWidth > 12
  ) {
    alert("線の太さは1から12の範囲で入力してください。");
    return;
  }

    const supportsText = [
    "text",
    "rect",
    "ellipse"
  ].includes(item.type);

  if (
    supportsText &&
    (
      !Number.isFinite(fontSize) ||
      fontSize < 8 ||
      fontSize > 72
    )
  ) {
    alert("文字サイズは8から72の範囲で入力してください。");
    return;
  }

  pushUndo("図形・注釈編集前");


  /*
   * 矢印や×印で負方向を維持する。
   */
  item.width =
    item.width < 0 ? -width : width;

  item.height =
    item.height < 0 ? -height : height;

  item.stroke =
    document.getElementById("annotationEditStroke")?.value ||
    "#7557a6";

  item.strokeWidth = strokeWidth;

  const noFill =
    !!document.getElementById("annotationEditNoFill")?.checked;

  item.fill = noFill
    ? "none"
    : document.getElementById("annotationEditFill")?.value ||
      "#ffffff";

  if (supportsText) {
    item.text =
      document.getElementById("annotationEditText")?.value ||
      "";

    item.color =
      document.getElementById("annotationEditColor")?.value ||
      "#252930";

    item.fontSize = fontSize;
  } else {
    item.text = "";
  }

  closeAnnotationEditModal();

  sync();
}

function normalizeColorForPicker(value, fallback) {
  const color = String(value || "").trim();

  if (/^#[0-9a-f]{6}$/i.test(color)) {
    return color;
  }

  if (/^#[0-9a-f]{3}$/i.test(color)) {
    return (
      "#" +
      color
        .slice(1)
        .split("")
        .map(character => character + character)
        .join("")
    );
  }

  return fallback;
}

function moveSelectedAnnotationForward() {
  const id =
    annotationContextTargetId ||
    selectedAnnotationId;

  const index = annotations.findIndex(
    item => item.id === id
  );

  hideAnnotationContextMenu();

  if (index < 0) return false;
  let nextIndex = index + 1;
  while (
    nextIndex < annotations.length &&
    annotations[nextIndex].layer !== annotations[index].layer
  ) nextIndex++;
  if (nextIndex >= annotations.length) return false;

  pushUndo("図形を1段前面へ移動前");

  const temporary = annotations[index];
  annotations[index] = annotations[nextIndex];
  annotations[nextIndex] = temporary;

  selectedAnnotationId = id;
  sync();

  return true;
}

function moveSelectedAnnotationBackward() {
  const id =
    annotationContextTargetId ||
    selectedAnnotationId;

  const index = annotations.findIndex(
    item => item.id === id
  );

  hideAnnotationContextMenu();

  if (index <= 0) return false;
  let previousIndex = index - 1;
  while (
    previousIndex >= 0 &&
    annotations[previousIndex].layer !== annotations[index].layer
  ) previousIndex--;
  if (previousIndex < 0) return false;

  pushUndo("図形を1段背面へ移動前");

  const temporary = annotations[index];
  annotations[index] = annotations[previousIndex];
  annotations[previousIndex] = temporary;

  selectedAnnotationId = id;
  sync();

  return true;
}

function bringSelectedAnnotationToFront() {
  const id =
    annotationContextTargetId ||
    selectedAnnotationId;

  const index = annotations.findIndex(
    item => item.id === id
  );

  hideAnnotationContextMenu();

  if (index < 0) return;
  let lastInLayer = index;
  for (let i = index + 1; i < annotations.length; i++) {
    if (annotations[i].layer === annotations[index].layer) lastInLayer = i;
  }
  if (lastInLayer === index) return;

  pushUndo("図形を最前面へ移動前");

  const [item] = annotations.splice(index, 1);
  annotations.splice(lastInLayer, 0, item);

  selectedAnnotationId = item.id;
  sync();
}

function sendSelectedAnnotationToBack() {
  const id =
    annotationContextTargetId ||
    selectedAnnotationId;

  const index = annotations.findIndex(
    item => item.id === id
  );

  hideAnnotationContextMenu();

  if (index <= 0) return;
  let firstInLayer = index;
  for (let i = 0; i < index; i++) {
    if (annotations[i].layer === annotations[index].layer) {
      firstInLayer = i;
      break;
    }
  }
  if (firstInLayer === index) return;

  pushUndo("図形を最背面へ移動前");

  const [item] = annotations.splice(index, 1);
  annotations.splice(firstInLayer, 0, item);

  selectedAnnotationId = item.id;
  sync();
}

function setSelectedAnnotationPersonLayer(layer) {
  const id = annotationContextTargetId || selectedAnnotationId;
  const item = annotation(id);
  hideAnnotationContextMenu();

  if (
    !item || item.type === "text" ||
    (layer !== "front" && layer !== "back") ||
    item.layer === layer
  ) {
    return false;
  }

  pushUndo(
    layer === "back"
      ? "図形を人物の背面へ移動前"
      : "図形を人物の前面へ移動前"
  );
  item.layer = layer;
  selectedAnnotationId = id;
  sync();
  return true;
}

function detachSelectedArrowEndpoints() {
  const id =
    annotationContextTargetId ||
    selectedAnnotationId;

  const item = annotation(id);

  hideAnnotationContextMenu();

  if (!item || item.type !== "arrow") {
    alert("矢印を選択してください。");
    return false;
  }

  if (!item.startPersonId && !item.endPersonId) {
    alert("この矢印は人物へ吸着していません。");
    return false;
  }

  pushUndo("矢印吸着解除前");

  item.startPersonId = "";
  item.endPersonId = "";
  item.startAnchor = "";
  item.endAnchor = "";

  sync();

  return true;
}



function getAnnotationLocalSelectionBounds(item) {
  const minX = Math.min(0, item.width);
  const minY = Math.min(0, item.height);
  const maxX = Math.max(0, item.width);
  const maxY = Math.max(0, item.height);

  return {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY)
  };
}


function drawTextAnnotation(group, item) {
  group.appendChild(svgEl("rect", {
    x: 0,
    y: 0,
    width: item.width,
    height: item.height,
    rx: 5,
    ry: 5,
    class: "annotation-shape",
    fill: item.fill,
    stroke: item.stroke,
    "stroke-width": item.strokeWidth
  }));
  if (annotationTextEdit?.id === item.id) {
    return;
  }

  const textElement = svgEl("text", {
    x: 10,
    y: 10 + item.fontSize,
    class: "annotation-label",
    fill: item.color,
    "font-size": item.fontSize
  });

  const lines = String(item.text || "").split("\n");

  lines.forEach((line, index) => {
    const tspan = svgEl("tspan", {
      x: 10,
      dy:
        index === 0
          ? 0
          : item.fontSize * 1.35
    });

    tspan.textContent = line;
    textElement.appendChild(tspan);
  });

  group.appendChild(textElement);
}

function drawShapeAnnotationText(group, item) {
  const text = String(item.text || "").trim();

  if (!text) {
    return;
  }

  const lines = text.split("\n");
  const lineHeight = item.fontSize * 1.35;
  const totalHeight = (lines.length - 1) * lineHeight;
  const centerX = item.width / 2;
  const centerY = item.height / 2;

  const textElement = svgEl("text", {
    x: centerX,
    y: centerY - totalHeight / 2,
    class: "annotation-label shape-label",
    fill: item.color,
    "font-size": item.fontSize
  });

  lines.forEach((line, index) => {
    const tspan = svgEl("tspan", {
      x: centerX,
      dy: index === 0 ? 0 : lineHeight
    });

    tspan.textContent = line;
    textElement.appendChild(tspan);
  });

  group.appendChild(textElement);
}

let annotationDragging = null;

function startAnnotationDrag(event) {
  if (annotationTool || relationMode) {
    event.stopPropagation();
    return;
  }

  if (
    event.target.closest?.(".annotation-resize-handle") ||
    event.target.closest?.(".annotation-arrow-endpoint")
  ) {
    return;
  }

  if (
    event.button !== undefined &&
    event.button !== 0
  ) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();

  const id =
    event.currentTarget.dataset.annotationId;

  const item = annotation(id);

  if (!item) {
    return;
  }

  const multiKey =
    event.ctrlKey ||
    event.shiftKey ||
    event.metaKey;

  const now = performance.now();
  const previousTextPointerDown =
    lastAnnotationTextPointerDown;
  const isTextDoubleClick =
    item.type === "text" &&
    !multiKey &&
    previousTextPointerDown?.id === id &&
    now - previousTextPointerDown.at <= 500 &&
    Math.hypot(
      event.clientX - previousTextPointerDown.x,
      event.clientY - previousTextPointerDown.y
    ) <= 5;

  lastAnnotationTextPointerDown =
    item.type === "text" && !multiKey
      ? {
          id,
          x: event.clientX,
          y: event.clientY,
          at: now
        }
      : null;

  if (isTextDoubleClick) {
    lastAnnotationTextPointerDown = null;
    beginAnnotationTextEdit(item);
    return;
  }

  if (multiKey) {
    toggleAnnotationSelection(id);

    /*
     * 選択解除された図形ではドラッグを開始しない。
     */
    if (!isAnnotationSelected(id)) {
      renderChart();
      return;
    }
  } else if (!selectedAnnotationIds.has(id)) {
    selectOnlyAnnotation(id);
  } else {
    selectedAnnotationId = id;
  }

  const point = clientToWorld(
    event.clientX,
    event.clientY
  );

  const targetItems = getSelectedAnnotations();

  annotationDragging = {
    startX: point.x,
    startY: point.y,

    beforeSnapshot:
      makeSnapshot("図形・注釈移動前"),

    moved: false,

    items: targetItems.map(target => ({
      id: target.id,
      x: target.x,
      y: target.y
    }))
  };

  svg.setPointerCapture(event.pointerId);
  svg.addEventListener(
    "pointermove",
    moveAnnotationDrag
  );
  svg.addEventListener(
    "pointerup",
    endAnnotationDrag
  );

  renderList();
  loadPersonForm();
  renderChart();
}



function moveAnnotationDrag(event) {
  if (!annotationDragging) {
    return;
  }

  const point = clientToWorld(
    event.clientX,
    event.clientY
  );

  const dx = point.x - annotationDragging.startX;
  const dy = point.y - annotationDragging.startY;

  if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
    annotationDragging.moved = true;
  }

  annotationDragging.items.forEach(original => {
    const item = annotation(original.id);

    if (!item) {
      return;
    }

    item.x = original.x + dx;
    item.y = original.y + dy;

    /*
     * 図形を直接移動した場合、人物への矢印吸着を解除する。
     */
    clearArrowAttachment(item);
  });

  renderChart();
}


function endAnnotationDrag(event) {
  if (
    annotationDragging &&
    annotationDragging.moved &&
    annotationDragging.beforeSnapshot
  ) {
    pushUndoSnapshot(annotationDragging.beforeSnapshot);
  }

  annotationDragging = null;

  try {
    svg.releasePointerCapture(event.pointerId);
  } catch {}

  svg.removeEventListener("pointermove", moveAnnotationDrag);
  svg.removeEventListener("pointerup", endAnnotationDrag);

  sync();
}


function deleteSelectedAnnotation() {
  hideAnnotationContextMenu();

  const items = getSelectedAnnotations();

  if (!items.length) {
    return false;
  }

  const targetLabel =
    items.length === 1
      ? annotationTypeLabel(items[0].type)
      : `選択中の図形・注釈 ${items.length}件`;

  if (!confirm(`${targetLabel}を削除しますか？`)) {
    return false;
  }

  pushUndo("図形・注釈削除前");

  const deleteIds = new Set(
    items.map(item => item.id)
  );

  annotations = annotations.filter(
    item => !deleteIds.has(item.id)
  );

  selectedAnnotationId = null;
  selectedAnnotationIds.clear();

  sync();

  return true;
}


function copySelectedAnnotation() {
  const id =
    annotationContextTargetId ||
    selectedAnnotationId;

  const item = annotation(id);

  hideAnnotationContextMenu();

  if (!item) {
    return false;
  }

  /*
   * OSのクリップボードは使用しない。
   * 個人情報を外部へ渡さず、アプリ内メモリにだけ保持する。
   */
  annotationClipboard =
    JSON.parse(JSON.stringify(item));

  annotationPasteCount = 0;

  return true;
}

function pasteAnnotation() {
  hideAnnotationContextMenu();

  if (!annotationClipboard) {
    alert("コピーされている図形・注釈がありません。");
    return false;
  }

  pushUndo("図形・注釈貼り付け前");

  annotationPasteCount++;

  const offset = annotationPasteCount * 30;

  const copy = createAnnotation({
    ...JSON.parse(JSON.stringify(annotationClipboard)),
    id: nextAnnotationId(),
    x: annotationClipboard.x + offset,
    y: annotationClipboard.y + offset
  });

  annotations.push(copy);
  selectOnlyAnnotation(copy.id);

  sync();
  return true;
}


function duplicateSelectedAnnotation() {
  const id =
    annotationContextTargetId ||
    selectedAnnotationId;

  const item = annotation(id);

  hideAnnotationContextMenu();

  if (!item) {
    return false;
  }

  pushUndo("図形・注釈複製前");

  const copy = createAnnotation({
    ...JSON.parse(JSON.stringify(item)),
    id: nextAnnotationId(),
    x: item.x + 30,
    y: item.y + 30
  });

  annotations.push(copy);

  selectOnlyAnnotation(copy.id);

  sync();


  return true;
}


function showAnnotationContextMenu(id, clientX, clientY) {
  annotationContextTargetId = id;

  if (!selectedAnnotationIds.has(id)) {
    selectOnlyAnnotation(id);
  } else {
    selectedAnnotationId = id;
  }

  hideNodeContextMenu();

  const menu = document.getElementById("annotationContextMenu");
  const title = document.getElementById("annotationContextMenuTitle");
  const item = annotation(id);

  if (!menu || !title || !item) {
    return;
  }

  title.textContent =
    `${item.id} ${annotationTypeLabel(item.type)}`;
  document.getElementById("annotationBehindPeople").disabled =
    item.type === "text" || item.layer === "back";
  document.getElementById("annotationInFrontOfPeople").disabled =
    item.type === "text" || item.layer === "front";

  menu.style.left = "0";
  menu.style.top = "0";
  menu.classList.add("open");

  const menuRect = menu.getBoundingClientRect();
  const margin = 10;

  const left = Math.min(
    clientX,
    window.innerWidth - menuRect.width - margin
  );

  const top = Math.min(
    clientY,
    window.innerHeight - menuRect.height - margin
  );

  menu.style.left = `${Math.max(margin, left)}px`;
  menu.style.top = `${Math.max(margin, top)}px`;
}

function hideAnnotationContextMenu() {
  const menu = document.getElementById("annotationContextMenu");

  if (menu) {
    menu.classList.remove("open");
  }

  annotationContextTargetId = null;
}

function getAnnotationBounds(item) {
  const endX = item.x + item.width;
  const endY = item.y + item.height;

  return {
    minX: Math.min(item.x, endX),
    minY: Math.min(item.y, endY),
    maxX: Math.max(item.x, endX),
    maxY: Math.max(item.y, endY)
  };
}


function getAllChartBounds() {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  people.forEach(item => {
    minX = Math.min(minX, item.x);
    minY = Math.min(minY, item.y);
    maxX = Math.max(maxX, item.x + NODE_W);
    maxY = Math.max(maxY, item.y + NODE_H);
  });

  annotations.forEach(item => {
    const bounds = getAnnotationBounds(item);

    minX = Math.min(minX, bounds.minX);
    minY = Math.min(minY, bounds.minY);
    maxX = Math.max(maxX, bounds.maxX);
    maxY = Math.max(maxY, bounds.maxY);
  });

  if (!Number.isFinite(minX)) {
    return {
      minX: 0,
      minY: 0,
      maxX: 0,
      maxY: 0,
      width: 0,
      height: 0
    };
  }

  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height: maxY - minY
  };
}

/* 初期化 */
function initializeApp() {
  installUndoWrappers();
  initPaneResizer();

  sampleData();
  sync();

  initAutoSave();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeApp);
} else {
  initializeApp();
}
