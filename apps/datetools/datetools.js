/* 画面の制御。入力値をURL・ログ・ブラウザ保存領域へ書き込まない。 */
(() => {
  "use strict";
  const C = window.AppBoxDateTools;
  const utilities = window.AppBox && window.AppBox.utilities;
  const byId = id => document.getElementById(id);
  const status = byId("copy-status");
  const made = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };

  function createEraCell(era, isPrint = false) {
    const td = made("td");
    if (!era) return td;
    if (era.isCombined && era.eras && era.eras.length > 1) {
      td.classList.add("era-combined-cell");
      const wrap = made("span", undefined, "era-combined");
      const prev = made("span", era.eras[0].label, "era-part");
      const sep = made("span", "／", "era-sep");
      const curr = made("span", era.eras[1].label, "era-part");
      wrap.append(prev, sep, curr);
      td.append(wrap);
    } else {
      td.append(isPrint ? era.label : made("span", era.label, "era-label"));
    }
    return td;
  }

  let allReferenceRows = [], referenceDate = "", midnightTimer;
  let referenceFollowsToday = true;
  function renderReference() {
    const rows = allReferenceRows;
    const includePrevious = Boolean(byId("reference-previous-era")?.checked);
    const fragment = document.createDocumentFragment();
    // 印刷版と同じ共通年齢帯で分け、各組を上から下、左から右へ読む。
    for (const [first, last] of C.REFERENCE_GROUPS) {
      const group = rows.filter(row => row.age >= first && row.age <= last);
      if (!group.length) continue;
      const table = made("table", undefined, "reference-table");
      table.setAttribute("aria-describedby", "reference-note reference-range");
      const ages = `${first}〜${last}歳`;
      const caption = made("caption", ages), head = made("thead"), headings = made("tr"), body = made("tbody");
      for (const [label, detail] of [["西暦", "西暦（生年）"], ["和暦", "和暦（生年）"], ["年齢", "今年の誕生日に迎える年齢"]]) {
        const th = made("th", label); th.scope = "col"; th.setAttribute("aria-label", detail); headings.append(th);
      }
      head.append(headings);
      for (const row of group) {
        const tr = made("tr");
        if (row.age % 10 === 0) tr.classList.add("is-decade");
        const western = made("th", `${row.year}年`); western.scope = "row";
        const era = C.referenceEra(row, includePrevious);
        const eraCell = createEraCell(era, false);
        tr.append(western, eraCell, made("td", `${row.age}歳`, "reference-age"));
        body.append(tr);
      }
      table.append(caption, head, body); fragment.append(table);
    }
    byId("reference-rows").replaceChildren(fragment);
  }
  function refreshReference() {
    try {
      const now = C.today(), stamp = C.iso(now);
      if (stamp === referenceDate) return;
      allReferenceRows = C.referenceRows(now);
      referenceDate = stamp;
      byId("reference-title").textContent = `${now.year}年版`;
      byId("reference-today").textContent = C.western(now);
      byId("reference-today").dateTime = stamp;
      byId("reference-caption").textContent = `${now.year}年版 西暦・和暦・年齢早見表。各表を上から下へ、左の表から右の表へ読みます。`;
      byId("reference-range").textContent = `${allReferenceRows.at(-1).year}年〜${now.year}年生まれを表示。改元した年は新元号の「元年」を表示します。「改元年の旧元号も表示」で併記できます。生年月日から年齢を調べる場合は「生年月日から年齢計算」をご利用ください。`;
      byId("error-reference").textContent = "";
      renderReference();
    } catch (error) {
      referenceDate = ""; allReferenceRows = []; renderReference();
      byId("reference-title").textContent = "早見表";
      byId("reference-today").textContent = "取得できません";
      byId("reference-today").removeAttribute("datetime");
      byId("error-reference").textContent = "端末の日付を確認してください。" + error.message;
    }
  }
  function scheduleDateRefresh() {
    window.clearTimeout(midnightTimer);
    const now = new Date(), next = new Date(now);
    next.setHours(24, 0, 1, 0);
    midnightTimer = window.setTimeout(() => { refreshReference(); refreshTodayReference(); scheduleDateRefresh(); }, next - now);
  }
  const views = ["reference", "age"];
  function selectView(view) {
    for (const item of views) {
      const active = item === view, tab = byId("view-" + item);
      tab.setAttribute("aria-selected", String(active)); tab.tabIndex = active ? 0 : -1;
      tab.classList.toggle("is-active", active);
      byId("panel-" + item).hidden = !active;
    }
    if (view === "reference") refreshReference();
    status.textContent = "";
  }

  function fillDate(prefix, value) {
    byId(prefix + "-calendar").value = "western";
    for (const part of ["year", "month", "day"]) byId(prefix + "-" + part).value = value ? value[part] : "";
    if (prefix === "birth") {
      byId("birth-format-western").checked = true;
      byId("birth-format-japanese").checked = false;
      updateBirthFormat();
    } else byId("reference-date").value = value ? C.iso(value) : "";
  }
  function readParts(prefix) {
    return C.fromParts(...["calendar", "year", "month", "day"].map(part => byId(prefix + "-" + part).value));
  }
  function readPicker() {
    const parts = byId("reference-date").value.split("-");
    if (parts.length !== 3) throw new Error("基準日を入力してください。");
    return C.date(...parts);
  }
  function readDate(prefix) {
    try {
      if (prefix === "reference" && !byId("reference-manual").open) return readPicker();
      return readParts(prefix);
    } catch (error) {
      const inputs = prefix === "reference" && !byId("reference-manual").open
        ? [byId("reference-date")]
        : document.querySelectorAll(`[data-date-field="${prefix}"] .date-inputs input`);
      inputs.forEach(input => input.setAttribute("aria-invalid", "true"));
      throw new Error((prefix === "birth" ? "生年月日" : "基準日") + "：" + error.message);
    }
  }
  function updateBirthFormat() {
    const japanese = byId("birth-format-japanese").checked;
    byId("birth-calendar").parentElement.hidden = !japanese;
    byId("birth-calendar").parentElement.parentElement.classList.toggle("date-inputs--western", !japanese);
    byId("birth-year").inputMode = japanese ? "text" : "numeric";
  }
  function switchBirthFormat() {
    const calendar = byId("birth-calendar"), oldJapanese = calendar.value !== "western";
    const japanese = byId("birth-format-japanese").checked;
    if (oldJapanese === japanese) return;
    const values = ["year", "month", "day"].map(part => byId("birth-" + part).value.trim());
    if (values.some(Boolean)) {
      try {
        const value = readParts("birth");
        const era = C.ERAS.find(item => C.compare(value, C.date(...item.start)) >= 0 && C.compare(value, C.date(...item.end)) <= 0);
        calendar.value = japanese ? era.id : "western";
        byId("birth-year").value = japanese ? value.year - era.base : value.year;
      } catch (_) {
        byId("birth-format-japanese").checked = oldJapanese;
        byId("birth-format-western").checked = !oldJapanese;
        byId("error-age").textContent = "西暦・和暦を切り替えるには、生年月日を正しく入力するか、入力をクリアしてください。";
        byId("birth-year").focus();
        return;
      }
    } else calendar.value = japanese ? C.ERAS.at(-1).id : "western";
    updateBirthFormat();
  }
  function refreshTodayReference() {
    if (!referenceFollowsToday) return;
    try {
      const now = C.today();
      if (byId("reference-date").value !== C.iso(now)) {
        fillDate("reference", now);
        clearResult("age", "今日の日付が変わりました。もう一度計算してください。");
      }
    } catch (_) { /* 入力時に対応範囲のエラーを表示する。 */ }
  }
  function fullDate(d) { return `${C.western(d)}（${C.japanese(d)}）`; }
  function clearResult(mode, message = "入力が変更されました。もう一度計算してください。") {
    byId("result-" + mode).replaceChildren(made("p", message, "empty-result"));
    byId("error-" + mode).textContent = "";
    status.textContent = "";
    byId("form-" + mode).querySelectorAll("[aria-invalid]").forEach(input => input.removeAttribute("aria-invalid"));
  }
  async function copyText(text, container, trigger) {
    status.textContent = "";
    const copied = utilities && await utilities.copyText(text);
    if (!trigger.isConnected) return;
    if (copied) {
      status.textContent = "結果と計算条件をコピーしました。";
      return;
    }
    let area = container.querySelector("textarea");
    if (!area) {
      area = made("textarea", undefined, "copy-manual");
      area.readOnly = true;
      area.setAttribute("aria-label", "手動コピー用の結果と計算条件");
      container.append(area);
    }
    area.value = text;
    area.focus(); area.select();
    status.textContent = "結果を選択しました。Ctrl＋C（Macは⌘＋C）、スマートフォンは選択メニューでコピーしてください。";
  }
  function calculateAge() {
    const birth = readDate("birth"), reference = readDate("reference");
    const a = C.ageInfo(birth, reference), container = byId("result-age");
    const rows = [
      ["生年月日（西暦）", C.western(birth)], ["生年月日（和暦）", C.japanese(birth)],
      ["年度末年齢", a.fiscal ? `${a.fiscalAge}歳\n${a.fiscal.label}末：${fullDate(a.fiscal.end)}` : "年度の対応範囲外のため表示できません。"],
      ["次回の誕生日", a.next ? fullDate(a.next) : "次回は2100年となり、対応範囲外です。"],
      ["基準日からの日数", a.daysUntil === null ? "対応範囲外" : a.daysUntil === 0 ? "0日（基準日が誕生日です）" : `あと${a.daysUntil}日`]
    ];
    const condition = "誕生日当日に1歳加算。2月29日生まれの平年の加算日・誕生日相当日は3月1日です。法令上の年齢到達時刻・資格判定には対応していません。";
    const main = made("div", undefined, "age-highlight");
    const age = made("p", undefined, "result-main");
    age.append(made("span", String(a.age)), made("span", "歳", "age-unit"));
    main.append(made("h3", "基準日時点の満年齢"), age);
    const list = made("dl", undefined, "age-result-list");
    for (const [label, value] of rows) {
      const row = made("div"); row.append(made("dt", label), made("dd", value)); list.append(row);
    }
    const button = made("button", "結果と条件をコピー", "appbox-button appbox-button--secondary copy-result"); button.type = "button";
    const text = ["基準日時点の満年齢", `${a.age}歳`, `基準日：${fullDate(reference)}`,
      ...rows.map(([label, value]) => `${label}：${value}`), condition].join("\n");
    button.addEventListener("click", () => { void copyText(text, container, button); });
    container.replaceChildren(made("p", `${fullDate(reference)}時点`, "result-date"), main, list, button);
  }

  document.querySelectorAll("[data-date-field]").forEach(fieldset => {
    const prefix = fieldset.dataset.dateField;
    const row = made("div", undefined, "date-inputs");
    for (const [part, label] of [["calendar", "暦"], ["year", "年"], ["month", "月"], ["day", "日"]]) {
      const wrapper = made("div"), title = made("label", prefix === "birth" && part === "calendar" ? "元号" : label);
      const input = made(part === "calendar" ? "select" : "input", undefined, part === "calendar" ? "appbox-select" : "appbox-input");
      input.id = prefix + "-" + part; title.htmlFor = input.id;
      if (part === "calendar") {
        for (const [id, name] of [["western", "西暦"], ...C.ERAS.slice().reverse().map(era => [era.id, era.name])]) {
          const option = made("option", name); option.value = id; if (prefix === "birth" && id === "western") option.hidden = true; input.append(option);
        }
      } else {
        input.type = "text"; input.inputMode = "numeric"; input.maxLength = part === "year" ? 4 : 2;
        input.required = true;
        input.setAttribute("aria-describedby", "error-" + fieldset.closest("form").id.replace("form-", ""));
      }
      wrapper.append(title, input); row.append(wrapper);
    }
    fieldset.append(row);
  });
  updateBirthFormat();

  const formAge = byId("form-age");
  formAge.addEventListener("input", event => {
    clearResult("age");
    if (event.target.id === "reference-date") {
      referenceFollowsToday = false;
      let value = null;
      try { value = readPicker(); } catch (_) { /* 未完成の入力は隠れた直接入力欄へ残さない。 */ }
      byId("reference-calendar").value = "western";
      for (const part of ["year", "month", "day"]) byId("reference-" + part).value = value ? value[part] : "";
    } else if (event.target.closest('[data-date-field="reference"]')) {
      referenceFollowsToday = false;
    }
  });
  formAge.addEventListener("change", event => {
    clearResult("age");
    if (event.target.name === "birth-format") switchBirthFormat();
  });
  byId("reference-manual").addEventListener("toggle", () => {
    if (byId("reference-manual").open) {
      try { fillDate("reference", readPicker()); } catch (_) { /* 未入力時は直接入力できる。 */ }
    } else {
      try { byId("reference-date").value = C.iso(readParts("reference")); }
      catch (_) { byId("reference-date").value = ""; }
    }
    byId("reference-picker-wrap").hidden = byId("reference-manual").open;
    clearResult("age");
  });
  formAge.addEventListener("submit", event => {
    event.preventDefault(); clearResult("age", "入力を確認してください。");
    try { calculateAge(); }
    catch (error) {
      byId("error-age").textContent = error.message;
      const first = formAge.querySelector('[aria-invalid="true"]') || byId("birth-year");
      if (first) first.focus();
    }
  });

  for (const view of views) {
    const tab = byId("view-" + view);
    tab.addEventListener("click", () => selectView(view));
    tab.addEventListener("keydown", event => {
      const offsets = { ArrowRight: 1, ArrowLeft: -1, Home: -views.indexOf(view), End: views.length - 1 - views.indexOf(view) };
      if (!(event.key in offsets)) return;
      event.preventDefault();
      const next = views[(views.indexOf(view) + offsets[event.key] + views.length) % views.length];
      selectView(next); byId("view-" + next).focus();
    });
  }
  byId("reference-previous-era").addEventListener("change", renderReference);

  const printDialog = byId("print-dialog"), printSheet = byId("print-sheet");
  let restorePrintDialog = false;

  function applyPrintOrientation(orientation) {
    const actual = orientation === "landscape" ? "landscape" : "portrait";
    printSheet.dataset.printOrientation = actual;
    document.body.dataset.printOrientation = actual;
    document.querySelectorAll("button[data-print-orientation]").forEach(button => {
      button.setAttribute("aria-pressed", String(button.dataset.printOrientation === actual));
    });
    // CSP style-src 'self' を遵守し、外部スタイルシートの @page ルールを安全に更新する
    try {
      for (const sheet of document.styleSheets) {
        if (!sheet.href || !sheet.href.includes("datetools-print.css")) continue;
        for (const rule of sheet.cssRules) {
          if (rule.type === CSSRule.PAGE_RULE || (typeof CSSPageRule !== "undefined" && rule instanceof CSSPageRule)) {
            if (!rule.name) {
              rule.style.setProperty("size", actual === "landscape" ? "A4 landscape" : "A4 portrait");
              rule.style.setProperty("margin", actual === "landscape" ? "7mm" : "5mm");
            }
          }
        }
      }
    } catch (_) {}
  }

  function renderPrintSheet() {
    refreshReference();
    if (!allReferenceRows.length) return false;
    const current = C.today();
    const includePrevious = Boolean(byId("reference-previous-era")?.checked);
    byId("print-year").textContent = `${current.year}年版`;
    byId("print-date").textContent = "作成日：" + C.western(current);
    const fragment = document.createDocumentFragment();
    for (const [first, last] of C.REFERENCE_GROUPS) {
      const group = allReferenceRows.filter(row => row.age >= first && row.age <= last);
      if (!group.length) continue;
      const block = made("section", undefined, "print-block");
      const heading = made("h3", `${group[0].age}〜${group.at(-1).age}歳`);
      const table = made("table", undefined, "print-table"), head = made("thead"), tr = made("tr"), body = made("tbody");
      table.setAttribute("aria-label", `${current.year}年版・${heading.textContent}の早見表`);
      table.setAttribute("aria-describedby", "print-sheet-note");
      for (const [label, detail] of [["西暦", "西暦（生年）"], ["和暦", "和暦（生年）"], ["年齢", "今年の誕生日に迎える年齢"]]) {
        const th = made("th", label); th.scope = "col"; th.setAttribute("aria-label", detail); tr.append(th);
      }
      head.append(tr);
      for (const row of group) {
        const entry = made("tr");
        if (row.age % 10 === 0) entry.classList.add("print-decade");
        const year = made("th", `${row.year}年`); year.scope = "row";
        const era = C.referenceEra(row, includePrevious);
        const eraCell = createEraCell(era, true);
        entry.append(year, eraCell, made("td", `${row.age}歳`, "print-age"));
        body.append(entry);
      }
      table.append(head, body); block.append(heading, table); fragment.append(block);
    }
    byId("print-rows").replaceChildren(fragment);
    return true;
  }
  function fitPrintPreview() {
    if (!printDialog.open) return;
    const width = byId("print-preview-area").clientWidth - 24;
    // プレビューのみ縮小する。印刷時はCSSで原寸へ戻す。
    printSheet.style.setProperty("--appbox-print-preview-zoom", String(Math.min(1, Math.max(0.1, width / printSheet.offsetWidth))));
  }
  byId("print-reference").addEventListener("click", () => {
    if (!renderPrintSheet()) return;
    printDialog.showModal(); fitPrintPreview();
  });
  byId("close-print").addEventListener("click", () => printDialog.close());
  document.querySelectorAll("button[data-print-style]").forEach(button => button.addEventListener("click", () => {
    printSheet.dataset.printStyle = button.dataset.printStyle;
    document.querySelectorAll("button[data-print-style]").forEach(option => option.setAttribute("aria-pressed", String(option === button)));
  }));
  document.querySelectorAll("button[data-print-orientation]").forEach(button => button.addEventListener("click", () => {
    applyPrintOrientation(button.dataset.printOrientation);
    fitPrintPreview();
  }));
  byId("confirm-print").addEventListener("click", () => { if (renderPrintSheet()) window.print(); });
  window.addEventListener("resize", fitPrintPreview);
  window.addEventListener("beforeprint", () => {
    if (printDialog.open || !byId("panel-reference").hidden) {
      if (renderPrintSheet()) {
        restorePrintDialog = restorePrintDialog || printDialog.open;
        // 用紙は通常の文書として印刷し、モーダルの表示領域には制限しない。
        if (printDialog.open) printDialog.close();
        document.body.dataset.printReference = "true";
        document.body.dataset.printOrientation = printSheet.dataset.printOrientation || "portrait";
      }
    }
  });
  window.addEventListener("afterprint", () => {
    delete document.body.dataset.printReference;
    delete document.body.dataset.printOrientation;
    if (restorePrintDialog && !printDialog.open) {
      printDialog.showModal();
      byId("confirm-print").focus();
    }
    restorePrintDialog = false;
    fitPrintPreview();
  });

  byId("clear-age").addEventListener("click", () => {
    byId("form-age").reset();
    fillDate("birth", null);
    referenceFollowsToday = true;
    byId("reference-manual").open = false;
    byId("reference-picker-wrap").hidden = false;
    try { fillDate("reference", C.today()); }
    catch (error) { byId("reference-date").value = ""; byId("error-age").textContent = error.message; }
    clearResult("age", "生年月日を入力して「年齢を計算する」を押してください。");
    byId("birth-year").focus();
  });
  function initializeCalculators() {
    try {
      const now = C.today();
      referenceFollowsToday = true;
      byId("reference-manual").open = false;
      byId("reference-picker-wrap").hidden = false;
      fillDate("reference", now);
      updateBirthFormat();
    } catch (error) { status.textContent = "端末の日付を確認してください。" + error.message; }
  }
  initializeCalculators();
  applyPrintOrientation("portrait");
  // 再読込みは必ず早見表。計算の状態を端末へ保存しない。
  byId("reference-previous-era").checked = false;
  refreshReference();
  scheduleDateRefresh();
  window.addEventListener("focus", () => { refreshReference(); refreshTodayReference(); scheduleDateRefresh(); });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) { refreshReference(); refreshTodayReference(); scheduleDateRefresh(); }
  });
  // 戻る・進むのページキャッシュから個人情報を再表示しない。
  window.addEventListener("pagehide", () => {
    restorePrintDialog = false;
    if (printDialog.open) printDialog.close();
    delete document.body.dataset.printReference;
    delete document.body.dataset.printOrientation;
    window.clearTimeout(midnightTimer);
    byId("form-age").reset();
    fillDate("birth", null); fillDate("reference", null);
    referenceFollowsToday = true;
    byId("reference-manual").open = false;
    byId("reference-picker-wrap").hidden = false;
    clearResult("age", "生年月日と基準日を入力してください。");
    byId("reference-previous-era").checked = false;
    applyPrintOrientation("portrait");
    renderReference();
    selectView("reference");
  });
  window.addEventListener("pageshow", event => {
    if (event.persisted) initializeCalculators();
    refreshReference(); refreshTodayReference(); scheduleDateRefresh();
  });
})();
