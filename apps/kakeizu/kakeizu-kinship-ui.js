'use strict';

// This dialog owns temporary proposals only. The saved model remains people[].relation.
let kinshipSession = null;
let kinshipReturnFocus = null;
let kinshipSearchMatches = [];
let kinshipSearchIndex = -1;
let kinshipComposing = false;

function kinshipSourceKey() {
  return JSON.stringify({ people, families });
}

function kinshipDraftKey() {
  return JSON.stringify(kinshipSession?.rows.map(r => [r.personId, r.checked, r.value, r.chosen, r.manual]) || []);
}

function kinshipMayDiscard() {
  return !kinshipSession || kinshipDraftKey() === kinshipSession.initialDraft ||
    confirm('この画面の未反映の選択・編集を破棄しますか？');
}

function closeKinshipDialog(discard = true) {
  if (discard && !kinshipMayDiscard()) return false;
  const dialog = document.getElementById('kinshipDialog');
  dialog.close();
  kinshipSession = null;
  kinshipComposing = false;
  kinshipReturnFocus?.focus({ preventScroll: true });
  return true;
}

function openKinshipDialog() {
  const dialog = document.getElementById('kinshipDialog');
  if (!dialog || dialog.open || typeof KakeizuKinship === 'undefined') return;
  kinshipReturnFocus = document.activeElement;
  closeToolMenus();
  kinshipSession = { baseId: null, rows: [], sourceKey: kinshipSourceKey(), initialDraft: '[]' };
  document.getElementById('kinshipSearch').value = '';
  closeKinshipSearch();
  renderKinshipRows();
  dialog.showModal();
  const ids = selectedIds.size ? [...selectedIds] : selectedId ? [selectedId] : [];
  if (ids.length === 1) setKinshipBase(ids[0]);
  document.getElementById('kinshipSearch').focus();
}

function setKinshipBase(id, recalculate = false) {
  if (!kinshipSession || !person(id) || (!recalculate && kinshipSession.baseId === id)) return false;
  if (!kinshipMayDiscard()) return false;
  const graph = KakeizuKinship.interpretLegacy(people, families);
  const results = new Map(KakeizuKinship.infer(graph, id).map(result => [result.personId, result]));
  kinshipSession.baseId = id;
  kinshipSession.sourceKey = kinshipSourceKey();
  kinshipSession.rows = people.map(p => {
    const result = results.get(p.id) || { personId: p.id, status: 'unavailable', candidates: [], reason: '候補を算出できません。' };
    const ready = result.status === 'ready' && result.candidates.length === 1;
    return { ...result, name: p.name, existing: String(p.relation ?? ''),
      value: ready ? result.candidates[0].label : '', chosen: ready ? 0 : -1,
      checked: ready && !String(p.relation ?? '').trim(), manual: false };
  });
  kinshipSession.initialDraft = kinshipDraftKey();
  closeKinshipSearch();
  renderKinshipRows();
  return true;
}

function kinshipChanges() {
  if (!kinshipSession) return [];
  return kinshipSession.rows.filter(r => r.checked && (typeof r.value !== 'string' || r.value.trim()) && r.value !== r.existing &&
    (r.manual || ((r.status === 'ready' || r.status === 'review' || r.status === 'multiple') && r.chosen >= 0)));
}

function updateKinshipSummary() {
  const changes = kinshipChanges();
  const replacements = changes.filter(r => r.existing.trim()).length;
  document.getElementById('kinshipSummary').textContent = `変更 ${changes.length}件 / 既存値の上書き ${replacements}件`;
  document.getElementById('kinshipApply').disabled = !kinshipSession?.baseId || !changes.length || kinshipComposing;
}

function renderKinshipRows() {
  const body = document.getElementById('kinshipRows');
  body.replaceChildren();
  const base = kinshipSession && person(kinshipSession.baseId);
  document.getElementById('kinshipBase').textContent = base
    ? `基準人物: ${base.name || '（氏名未入力）'} / ${base.id}` : '基準人物を検索して選んでください。';
  const labels = { ready: '候補あり', review: '要確認', multiple: '複数候補', conflict: '矛盾', unavailable: '判定不可' };
  for (const row of kinshipSession?.rows || []) {
    const tr = document.createElement('tr');
    const cell = element => { const td = document.createElement('td'); td.appendChild(element); tr.appendChild(td); };
    const text = value => { const span = document.createElement('span'); span.textContent = value; return span; };
    const statusCell = document.createElement('div');
    statusCell.className = 'kinship-status-cell';
    const updateStatus = () => {
      statusCell.replaceChildren();
      const badge = document.createElement('span');
      badge.className = `kinship-badge kinship-badge--${row.status}`;
      badge.textContent = labels[row.status] || row.status;
      statusCell.appendChild(badge);

      const willOverwrite = Boolean(row.checked && row.value.trim() && row.existing.trim() && row.value !== row.existing);
      tr.dataset.kinshipOverwrite = String(willOverwrite);
      tr.dataset.kinshipStatus = row.status;

      if (willOverwrite) {
        const overwriteBadge = document.createElement('span');
        overwriteBadge.className = 'kinship-badge kinship-badge--overwrite';
        overwriteBadge.textContent = '上書き';
        statusCell.appendChild(overwriteBadge);
      }

      if (row.manual) {
        const manualBadge = document.createElement('span');
        manualBadge.className = 'kinship-badge kinship-badge--manual';
        manualBadge.textContent = blocked ? '手動指定' : '手動修正';
        statusCell.appendChild(manualBadge);
      }

      const reason = document.createElement('span');
      reason.className = 'kinship-reason';
      reason.textContent = ` ${row.reason}`;
      statusCell.appendChild(reason);
    };
    const check = document.createElement('input');
    check.type = 'checkbox'; check.checked = row.checked;
    check.setAttribute('aria-label', `${row.name || row.personId}の続柄を反映`);
    check.addEventListener('change', () => { row.checked = check.checked; updateStatus(); updateKinshipSummary(); });
    cell(check);
    cell(text(`${row.name || '（氏名未入力）'} / ${row.personId}`));
    cell(text(row.existing || '（空欄）'));
    const select = document.createElement('select');
    select.setAttribute('aria-label', `${row.personId}の候補`);
    const placeholder = document.createElement('option'); placeholder.value = '-1'; placeholder.textContent = '候補を選択'; select.appendChild(placeholder);
    const blocked = row.status === 'conflict' || row.status === 'unavailable';
    if (!blocked) row.candidates.forEach((candidate, index) => {
      const option = document.createElement('option'); option.value = String(index); option.textContent = candidate.label; select.appendChild(option);
    });
    select.value = String(row.chosen); select.disabled = blocked;
    cell(select);
    const input = document.createElement('input'); input.type = 'text'; input.value = row.value;
    input.maxLength = 2000;
    input.setAttribute('aria-label', `${row.personId}に反映する続柄`);
    cell(input);
    updateStatus(); cell(statusCell);
    select.addEventListener('change', () => {
      const index = Number(select.value);
      row.chosen = Number.isInteger(index) && row.candidates[index] ? index : -1;
      row.manual = false;
      row.value = row.chosen >= 0 ? row.candidates[row.chosen].label : '';
      input.value = row.value;
      updateStatus(); updateKinshipSummary();
    });
    input.addEventListener('input', () => {
      row.value = input.value; row.manual = true; row.chosen = -1; select.value = '-1';
      updateStatus(); updateKinshipSummary();
    });
    body.appendChild(tr);
  }
  updateKinshipSummary();
}

function selectKinshipReady(clear = false) {
  if (!kinshipSession) return;
  kinshipSession.rows.forEach(row => {
    row.checked = !clear && row.status === 'ready' && !row.existing.trim() && !row.manual && row.chosen >= 0;
  });
  renderKinshipRows();
}

function applyKinshipRelations() {
  if (!kinshipSession || kinshipComposing) return false;
  const stale = () => kinshipSession.sourceKey !== kinshipSourceKey();
  const reportStale = () => alert('人物・関係・続柄が変更されています。部分反映は行いません。基準人物を確認して「再計算」してください。');
  if (stale()) { reportStale(); return false; }
  const changes = kinshipChanges();
  if (changes.some(row => typeof row.value !== 'string' || row.value.length > 2000)) {
    alert('反映する続柄は文字列で2000文字以内にしてください。部分反映は行いません。');
    return false;
  }
  if (!changes.length) { updateKinshipSummary(); return false; }
  const replacements = changes.filter(row => row.existing.trim()).length;
  if (replacements && !confirm(`既存の続柄 ${replacements}件を置き換えます。変更 ${changes.length}件を反映しますか？`)) return false;
  if (stale()) { reportStale(); return false; }
  // All validation precedes the single history boundary; never normalize families here.
  pushUndo('続柄自動設定前');
  changes.forEach(row => { person(row.personId).relation = row.value; });
  sync({ preserveSnapshot: true });
  closeKinshipDialog(false);
  return true;
}

function closeKinshipSearch() {
  kinshipSearchMatches = []; kinshipSearchIndex = -1;
  const input = document.getElementById('kinshipSearch');
  input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant');
  document.getElementById('kinshipSearchResults').hidden = true;
}

function setKinshipSearchIndex(index) {
  kinshipSearchIndex = index;
  const input = document.getElementById('kinshipSearch');
  const children = document.getElementById('kinshipSearchResults').children;
  [...children].forEach((option, i) => option.setAttribute('aria-selected', String(i === index)));
  if (children[index]) {
    input.setAttribute('aria-activedescendant', children[index].id);
    children[index].scrollIntoView?.({ block: 'nearest' });
  } else input.removeAttribute('aria-activedescendant');
}

function renderKinshipSearch() {
  const input = document.getElementById('kinshipSearch');
  const previous = kinshipSearchMatches[kinshipSearchIndex]?.id;
  const list = document.getElementById('kinshipSearchResults');
  list.replaceChildren();
  if (!normalizePersonSearch(input.value)) { closeKinshipSearch(); return; }
  kinshipSearchMatches = findPeopleForSearch(input.value);
  kinshipSearchMatches.forEach((p, i) => {
    const option = document.createElement('div'); option.id = `kinshipOption-${i}`;
    option.setAttribute('role', 'option'); option.textContent = `${p.name || '（氏名未入力）'} / ${p.relation || '続柄未入力'} / ${p.id}`;
    option.addEventListener('pointerdown', e => e.preventDefault());
    option.addEventListener('click', () => { if (!kinshipComposing) setKinshipBase(p.id); });
    list.appendChild(option);
  });
  if (!kinshipSearchMatches.length) { const note = document.createElement('p'); note.textContent = '一致する人物はいません。'; list.appendChild(note); }
  list.hidden = false; input.setAttribute('aria-expanded', 'true');
  setKinshipSearchIndex(kinshipSearchMatches.findIndex(p => p.id === previous));
}

function initializeKinshipUi() {
  const dialog = document.getElementById('kinshipDialog');
  if (!dialog || typeof KakeizuKinship === 'undefined') return;
  const input = document.getElementById('kinshipSearch');
  document.getElementById('kinshipClose').addEventListener('click', () => closeKinshipDialog());
  document.getElementById('kinshipApply').addEventListener('click', applyKinshipRelations);
  document.getElementById('kinshipSelectReady').addEventListener('click', () => selectKinshipReady());
  document.getElementById('kinshipClear').addEventListener('click', () => selectKinshipReady(true));
  document.getElementById('kinshipRecalculate').addEventListener('click', () => setKinshipBase(kinshipSession?.baseId, true));
  dialog.addEventListener('cancel', event => { event.preventDefault(); if (!kinshipComposing && !event.isComposing) closeKinshipDialog(); });
  // Keep editor shortcuts and canvas Enter/Escape handling outside this modal.
  dialog.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.key === 'Enter' && (kinshipComposing || event.isComposing || event.keyCode === 229)) event.preventDefault();
  });
  dialog.addEventListener('compositionstart', () => { kinshipComposing = true; updateKinshipSummary(); });
  dialog.addEventListener('compositionend', () => { kinshipComposing = false; updateKinshipSummary(); });
  input.addEventListener('compositionstart', () => { kinshipComposing = true; updateKinshipSummary(); });
  input.addEventListener('compositionend', () => { kinshipComposing = false; renderKinshipSearch(); updateKinshipSummary(); });
  input.addEventListener('input', event => { if (!kinshipComposing && !event.isComposing) renderKinshipSearch(); });
  input.addEventListener('keydown', event => {
    if (kinshipComposing || event.isComposing || event.keyCode === 229) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (document.getElementById('kinshipSearchResults').hidden) renderKinshipSearch();
      const n = kinshipSearchMatches.length;
      if (n) setKinshipSearchIndex(kinshipSearchIndex < 0 ? (event.key === 'ArrowDown' ? 0 : n - 1) : (kinshipSearchIndex + (event.key === 'ArrowDown' ? 1 : -1) + n) % n);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const match = kinshipSearchMatches[kinshipSearchIndex < 0 ? 0 : kinshipSearchIndex];
      if (match) setKinshipBase(match.id);
    }
  });
}
