(() => {
  "use strict";

  const MAX_COLUMNS = 300;
  const MAX_ROWS = 200000;
  const MAX_CELLS = 2000000;
  const MAX_FILE_SIZE = 20 * 1024 * 1024;

  const $ = id => document.getElementById(id);

  const state = {
    newRaw:null,
    oldRaw:null,
    newData:null,
    oldData:null,
    results:[],
    selectedColumns:[],
    key:"",
    page:1,
    pageSize:50
  };

  const loadVersion = {new:0, old:0};
  const sideLoading = {new:false, old:false};

  let loadingCount = 0;
  let loadingGeneration = 0;
  let operationVersion = 0;

  const els = {
    main:$("mainContent"),
    newFile:$("newFile"),
    oldFile:$("oldFile"),
    newDrop:$("newDrop"),
    oldDrop:$("oldDrop"),
    newMeta:$("newMeta"),
    oldMeta:$("oldMeta"),
    newDropTitle:$("newDropTitle"),
    oldDropTitle:$("oldDropTitle"),
    newDropHint:$("newDropHint"),
    oldDropHint:$("oldDropHint"),
    keySelect:$("keySelect"),
    encoding:$("encodingSelect"),
    delimiter:$("delimiterSelect"),
    compare:$("compareBtn"),
    clear:$("clearBtn"),
    sample:$("sampleBtn"),
    checks:$("columnChecks"),
    summary:$("columnSummary"),
    normalizeSummary:$("normalizeSummary"),
    results:$("results"),
    table:$("tableWrap"),
    scrollHint:$("tableScrollHint"),
    error:$("errorBox"),
    warn:$("warnBox"),
    search:$("searchBox"),
    filter:$("statusFilter"),
    columnFilter:$("columnFilter"),
    sort:$("sortSelect"),
    changedOnlyCols:$("changedOnlyCols"),
    pageSize:$("pageSize"),
    prev:$("prevBtn"),
    next:$("nextBtn"),
    range:$("rangeLabel"),
    pageLabel:$("pageLabel"),
    export:$("exportBtn"),
    loading:$("loading"),
    columnStatList:$("columnStatList"),
    norms:[
      $("normTrim"),
      $("normSpaces"),
      $("normCase"),
      $("normWidth"),
      $("normNewline"),
      $("normDate"),
      $("normNumber")
    ]
  };

  const escapeHtml = value =>
    String(value ?? "").replace(/[&<>"']/g, ch => ({
      "&":"&amp;",
      "<":"&lt;",
      ">":"&gt;",
      '"':"&quot;",
      "'":"&#39;"
    }[ch]));

  function unique(arr){
    return [...new Set(arr)];
  }

  function showError(msg=""){
    els.error.textContent = msg;
    els.error.classList.toggle("show", !!msg);
  }

  function showWarn(msg=""){
    els.warn.textContent = msg;
    els.warn.classList.toggle("show", !!msg);
  }

  /*
   * ローディングには世代番号を持たせる。
   * クリア等で強制終了した古い処理が、後から新しい処理の
   * ローディング表示を閉じないようにする。
   */
  function beginLoading(){
    const generation = loadingGeneration;

    loadingCount++;
    els.loading.classList.add("show");
    els.loading.setAttribute("aria-hidden", "false");
    els.main.setAttribute("aria-busy", "true");

    return generation;
  }

  function endLoading(generation){
    if(generation !== loadingGeneration){
      return;
    }

    loadingCount = Math.max(0, loadingCount - 1);

    if(loadingCount === 0){
      els.loading.classList.remove("show");
      els.loading.setAttribute("aria-hidden", "true");
      els.main.setAttribute("aria-busy", "false");
    }
  }

  function forceEndLoading(){
    loadingGeneration++;
    loadingCount = 0;
    els.loading.classList.remove("show");
    els.loading.setAttribute("aria-hidden", "true");
    els.main.setAttribute("aria-busy", "false");
  }

  function invalidateAllOperations(){
    operationVersion++;
    loadVersion.new++;
    loadVersion.old++;
    sideLoading.new = false;
    sideLoading.old = false;
  }

  function selectedDelimiter(){
    const value = els.delimiter.value;

    if(value === "auto"){
      return null;
    }

    return value === "tab" ? "\t" : value;
  }

  function delimiterName(delimiter){
    if(delimiter === "\t"){
      return "タブ";
    }

    if(delimiter === ";"){
      return "セミコロン";
    }

    return "カンマ";
  }

  function detectDelimiter(text){
    const candidates = [",", "\t", ";"];
    const counts = {",":0, "\t":0, ";":0};
    let inQuotes = false;
    const max = Math.min(text.length, 30000);

    for(let i = 0; i < max; i++){
      const c = text[i];

      if(c === '"'){
        if(inQuotes && text[i + 1] === '"'){
          i++;
          continue;
        }

        inQuotes = !inQuotes;
      }else if(!inQuotes){
        if(candidates.includes(c)){
          counts[c]++;
        }

        if(
          (c === "\r" || c === "\n") &&
          (counts[","] || counts["\t"] || counts[";"])
        ){
          break;
        }
      }
    }

    return [...candidates]
      .sort((a, b) => counts[b] - counts[a])[0] || ",";
  }

  /*
   * CSV解析
   *
   * 引用符に関する主な規則:
   * - 引用符はフィールド先頭でのみ開始できる
   * - 引用フィールド内の "" は1文字の " として扱う
   * - 閉じ引用符の後は区切り、改行、ファイル終端のみ許可する
   */
  function parseCSV(text, filename="CSV", forcedDelimiter=null){
    text = text.replace(/^\uFEFF/, "");

    const delimiter = forcedDelimiter || detectDelimiter(text);
    const rows = [];

    let row = [];
    let field = "";
    let inQuotes = false;
    let justClosedQuote = false;
    let recordNumber = 1;

    const checkColumnLimit = () => {
      if(row.length > MAX_COLUMNS){
        throw new Error(
          `【${filename}】${recordNumber}行目の列数が` +
          `上限の${MAX_COLUMNS}列を超えています。`
        );
      }
    };

    const pushField = () => {
      row.push(field);
      field = "";
      justClosedQuote = false;
      checkColumnLimit();
    };

    const pushRow = () => {
      /*
       * 完全な空行は従来仕様どおり読み飛ばす。
       * 行番号はCSV上の論理レコード位置として扱う。
       */
      if(row.length > 1 || (row.length === 1 && row[0] !== "")){
        rows.push(row);

        if(rows.length > MAX_ROWS + 1){
          throw new Error(
            `【${filename}】行数が上限の` +
            `${MAX_ROWS.toLocaleString()}行を超えています。`
          );
        }
      }

      row = [];
      recordNumber++;
    };

    for(let i = 0; i < text.length; i++){
      const c = text[i];

      if(inQuotes){
        if(c === '"'){
          if(text[i + 1] === '"'){
            field += '"';
            i++;
          }else{
            inQuotes = false;
            justClosedQuote = true;
          }
        }else{
          field += c;
        }

        continue;
      }

      if(justClosedQuote){
        if(c === delimiter){
          pushField();
        }else if(c === "\r" || c === "\n"){
          if(c === "\r" && text[i + 1] === "\n"){
            i++;
          }

          pushField();
          pushRow();
        }else{
          throw new Error(
            `【${filename}】${recordNumber}行目で、` +
            "閉じ引用符の後に不正な文字があります。"
          );
        }

        continue;
      }

      if(c === '"'){
        if(field !== ""){
          throw new Error(
            `【${filename}】${recordNumber}行目で、` +
            "引用符の位置が不正です。"
          );
        }

        inQuotes = true;
      }else if(c === delimiter){
        pushField();
      }else if(c === "\r" || c === "\n"){
        if(c === "\r" && text[i + 1] === "\n"){
          i++;
        }

        pushField();
        pushRow();
      }else{
        field += c;
      }
    }

    if(inQuotes){
      throw new Error(
        `【${filename}】CSV内に閉じられていない引用符（"）があります。`
      );
    }

    /*
     * 末尾が閉じ引用符の場合も、空文字の引用セル "" を
     * 正しく1フィールドとして確定する。
     */
    if(field !== "" || row.length || justClosedQuote){
      pushField();
      pushRow();
    }

    if(!rows.length){
      throw new Error(`【${filename}】データが存在しません。`);
    }

    const rawHeaders = rows.shift();

    if(rawHeaders.length > MAX_COLUMNS){
      throw new Error(
        `【${filename}】列数が上限の${MAX_COLUMNS}列を超えています。`
      );
    }

    const emptyCols = [];

    rawHeaders.forEach((header, index) => {
      if(String(header).trim() === ""){
        emptyCols.push(index + 1);
      }
    });

    if(emptyCols.length){
      throw new Error(
        `【${filename}】見出しが空の列があります` +
        `（${emptyCols.join("、")}列目）。`
      );
    }

    const headers = rawHeaders.map(header => String(header).trim());
    const seen = new Set();
    const duplicates = [];

    headers.forEach(header => {
      if(seen.has(header)){
        duplicates.push(header);
      }else{
        seen.add(header);
      }
    });

    if(duplicates.length){
      throw new Error(
        `【${filename}】見出し列名が重複しています: ` +
        unique(duplicates).join("、")
      );
    }

    for(let i = 0; i < rows.length; i++){
      if(rows[i].length !== headers.length){
        throw new Error(
          `【${filename}】${i + 2}行目の列数が不正です` +
          `（見出し: ${headers.length}列 / ` +
          `データ: ${rows[i].length}列）。`
        );
      }
    }

    if(rows.length * headers.length > MAX_CELLS){
      throw new Error(
        `【${filename}】総セル数が上限の` +
        `${MAX_CELLS.toLocaleString()}を超えています。`
      );
    }

    const records = rows.map((cells, index) => {
      const values = Object.create(null);

      headers.forEach((header, i) => {
        values[header] = cells[i] ?? "";
      });

      return {
        values,
        rowNumber:index + 2
      };
    });

    return {
      headers,
      records,
      delimiter
    };
  }

  function decodeBuffer(buffer, mode){
    if(mode === "utf-8"){
      return {
        text:new TextDecoder("utf-8", {fatal:true}).decode(buffer),
        encoding:"UTF-8"
      };
    }

    if(mode === "shift_jis"){
      return {
        text:new TextDecoder("shift_jis", {fatal:true}).decode(buffer),
        encoding:"Shift_JIS"
      };
    }

    try{
      return {
        text:new TextDecoder("utf-8", {fatal:true}).decode(buffer),
        encoding:"UTF-8 (自動判別)"
      };
    }catch(e){
      try{
        return {
          text:new TextDecoder("shift_jis", {fatal:true}).decode(buffer),
          encoding:"Shift_JIS (自動判別)"
        };
      }catch(e2){
        throw new Error(
          "文字コードを自動判定できません。" +
          "UTF-8またはShift_JISを手動選択してください。"
        );
      }
    }
  }

  function processParsedData(
    buffer,
    filename,
    encodingMode,
    forcedDelimiter
  ){
    const decoded = decodeBuffer(buffer, encodingMode);
    const parsed = parseCSV(
      decoded.text,
      filename,
      forcedDelimiter
    );

    return {
      ...parsed,
      name:filename,
      size:buffer.byteLength,
      encoding:decoded.encoding
    };
  }

  function metaDetailsText(data){
    return (
      `${data.records.length.toLocaleString()}行 ／ ` +
      `${data.encoding} ／ ` +
      `${delimiterName(data.delimiter)}区切り`
    );
  }

  function dropUi(side){
    const isNew = side === "new";

    return {
      label:isNew ? "新" : "旧",
      input:isNew ? els.newFile : els.oldFile,
      drop:isNew ? els.newDrop : els.oldDrop,
      meta:isNew ? els.newMeta : els.oldMeta,
      title:isNew ? els.newDropTitle : els.oldDropTitle,
      hint:isNew ? els.newDropHint : els.oldDropHint
    };
  }

  function setDropLoaded(side, data){
    const ui = dropUi(side);

    ui.title.textContent = data.name;
    ui.hint.textContent =
      "別のファイルを選択（クリック または ドラッグ＆ドロップ）";
    ui.meta.textContent = metaDetailsText(data);
    ui.input.setAttribute(
      "aria-label",
      `${ui.label}CSVを別のファイルに変更`
    );
    ui.drop.classList.add("has-file");
  }

  function setDropEmpty(side, message=""){
    const ui = dropUi(side);

    ui.title.textContent = `${ui.label}CSVを選択`;
    ui.hint.textContent =
      "クリック または ドラッグ＆ドロップ";
    ui.meta.textContent = message;
    ui.input.setAttribute(
      "aria-label",
      `${ui.label}CSVを選択`
    );
    ui.drop.classList.remove("has-file");
  }

  function setDropError(side, name, message){
    const ui = dropUi(side);

    ui.title.textContent =
      name || `${ui.label}CSVを選択`;
    ui.hint.textContent = name
      ? "別のファイルを選択（クリック または ドラッグ＆ドロップ）"
      : "クリック または ドラッグ＆ドロップ";
    ui.meta.textContent = message;
    ui.input.setAttribute(
      "aria-label",
      name
        ? `${ui.label}CSVを別のファイルに変更`
        : `${ui.label}CSVを選択`
    );
    ui.drop.classList.remove("has-file");
  }

  function updateTableScrollHint(){
    const hasTable = !!els.table.querySelector("table");

    els.scrollHint.hidden = !(
      hasTable &&
      els.table.scrollWidth > els.table.clientWidth + 1
    );
  }

  function bindDrop(input, drop, side){
    ["dragenter", "dragover"].forEach(type => {
      drop.addEventListener(type, event => {
        event.preventDefault();
        drop.classList.add("drag");
      });
    });

    ["dragleave", "drop"].forEach(type => {
      drop.addEventListener(type, event => {
        event.preventDefault();
        drop.classList.remove("drag");
      });
    });

    drop.addEventListener("drop", async event => {
      const file = event.dataTransfer.files?.[0];

      if(file){
        await executeLoad(side, file);
      }
    });

    input.addEventListener("change", async () => {
      if(input.files?.[0]){
        await executeLoad(side, input.files[0]);
      }
    });
  }

  function resetResults(){
    state.results = [];
    state.page = 1;

    els.results.classList.remove("show");
    els.table.innerHTML = "";
    els.scrollHint.hidden = true;
    els.columnStatList.innerHTML = "";
  }

  async function executeLoad(side, file){
    const currentVersion = ++loadVersion[side];

    operationVersion++;
    sideLoading[side] = true;

    let succeeded = false;
    const loadingToken = beginLoading();

    showError("");
    showWarn("");
    resetResults();

    try{
      if(!file){
        return;
      }

      if(!/\.csv$/i.test(file.name)){
        throw new Error(
          "CSVファイル（.csv）を選択してください。"
        );
      }

      if(file.size > MAX_FILE_SIZE){
        throw new Error(
          "20MBを超えるCSVは読み込めません。"
        );
      }

      state[side + "Raw"] = null;
      state[side + "Data"] = null;

      const buffer = await file.arrayBuffer();

      if(currentVersion !== loadVersion[side]){
        return;
      }

      const data = processParsedData(
        buffer,
        file.name,
        els.encoding.value,
        selectedDelimiter()
      );

      if(currentVersion !== loadVersion[side]){
        return;
      }

      state[side + "Raw"] = {
        buffer,
        name:file.name
      };

      state[side + "Data"] = data;

      setDropLoaded(side, data);
      succeeded = true;
    }catch(e){
      if(currentVersion !== loadVersion[side]){
        return;
      }

      state[side + "Raw"] = null;
      state[side + "Data"] = null;

      const input = side === "new"
        ? els.newFile
        : els.oldFile;

      input.value = "";
      setDropError(
        side,
        file?.name || "",
        "読み込みエラー"
      );
      els.compare.disabled = true;

      showError(
        e.message || "CSVの読み込みに失敗しました。"
      );
    }finally{
      if(currentVersion === loadVersion[side]){
        sideLoading[side] = false;

        if(
          succeeded &&
          !sideLoading.new &&
          !sideLoading.old
        ){
          prepareSetup();
        }
      }

      endLoading(loadingToken);
    }
  }

  function prepareSetup(){
    if(sideLoading.new || sideLoading.old){
      els.compare.disabled = true;
      return;
    }

    const newData = state.newData;
    const oldData = state.oldData;

    if(!newData || !oldData){
      els.compare.disabled = true;
      return;
    }

    const common = newData.headers.filter(header =>
      oldData.headers.includes(header)
    );

    els.keySelect.innerHTML = "";

    if(!common.length){
      els.keySelect.innerHTML =
        '<option value="">共通する列名がありません</option>';

      els.keySelect.disabled = true;
      els.compare.disabled = true;

      showError(
        "新CSVと旧CSVに共通する列名がありません。" +
        "見出しを確認してください。"
      );

      renderColumnChecks([]);
      return;
    }

    common.forEach(header => {
      const option = document.createElement("option");
      option.value = header;
      option.textContent = header;
      els.keySelect.appendChild(option);
    });

    els.keySelect.disabled = false;
    state.key = common[0];

    const all = unique([
      ...newData.headers,
      ...oldData.headers
    ]);

    state.selectedColumns = all.filter(
      header => header !== state.key
    );

    renderColumnChecks(all);
    updateCompareButton();
  }

  function renderColumnChecks(headers){
    els.checks.innerHTML = "";

    headers.forEach(header => {
      const label = document.createElement("label");
      label.className = "check";

      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = header;
      input.checked = header !== state.key;
      input.disabled = header === state.key;
      input.addEventListener(
        "change",
        updateSelectedColumns
      );

      const span = document.createElement("span");
      span.textContent =
        header +
        (header === state.key ? "（キー列）" : "");

      label.append(input, span);
      els.checks.appendChild(label);
    });

    updateSelectedColumns();
  }

  function updateSelectedColumns(){
    state.selectedColumns = [
      ...els.checks.querySelectorAll(
        'input[type="checkbox"]:checked'
      )
    ].map(input => input.value);

    els.summary.textContent = els.checks.children.length
      ? `（${state.selectedColumns.length}列を比較）`
      : "（CSVを読み込むと選択できます）";

    updateCompareButton();
  }

  function updateCompareButton(){
    els.compare.disabled = !(
      state.newData &&
      state.oldData &&
      els.keySelect.value &&
      state.selectedColumns.length > 0 &&
      !sideLoading.new &&
      !sideLoading.old
    );
  }

  function normalizationOptions(){
    return {
      trim:$("normTrim").checked,
      spaces:$("normSpaces").checked,
      ignoreCase:$("normCase").checked,
      width:$("normWidth").checked,
      newline:$("normNewline").checked,
      date:$("normDate").checked,
      number:$("normNumber").checked
    };
  }

  function updateNormalizationSummary(){
    const labels = [];

    if($("normTrim").checked){
      labels.push("前後空白");
    }

    if($("normSpaces").checked){
      labels.push("連続空白");
    }

    if($("normCase").checked){
      labels.push("大小文字");
    }

    if($("normWidth").checked){
      labels.push("全角半角");
    }

    if($("normNewline").checked){
      labels.push("改行");
    }

    if($("normDate").checked){
      labels.push("日付");
    }

    if($("normNumber").checked){
      labels.push("数値");
    }

    els.normalizeSummary.textContent = labels.length
      ? `（${labels.join("・")}）`
      : "";
  }

  function convertWidth(value){
    return value
      .replace(/\u3000/g, " ")
      .replace(/[！-～]/g, character =>
        String.fromCharCode(
          character.charCodeAt(0) - 0xFEE0
        )
      );
  }

  function canonicalDate(value){
    const text = String(value).trim();

    const match = text.match(
      /^(\d{4})[\/.\-年](\d{1,2})[\/.\-月](\d{1,2})日?$/
    );

    if(!match){
      return null;
    }

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(year, month - 1, day);

    if(
      date.getFullYear() !== year ||
      date.getMonth() !== month - 1 ||
      date.getDate() !== day
    ){
      return null;
    }

    return [
      String(year).padStart(4, "0"),
      String(month).padStart(2, "0"),
      String(day).padStart(2, "0")
    ].join("-");
  }

  function canonicalNumber(value){
    let text = String(value).trim();

    if(!text){
      return null;
    }

    text = text.replace(/,/g, "");

    if(
      !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)
    ){
      return null;
    }

    const number = Number(text);

    if(!Number.isFinite(number)){
      return null;
    }

    if(Object.is(number, -0)){
      return "0";
    }

    return String(number);
  }

  function normalizeValue(value, options){
    let text = String(value ?? "");

    if(options.newline){
      text = text.replace(/\r\n?/g, "\n");
    }

    if(options.width){
      text = convertWidth(text);
    }

    if(options.trim){
      text = text.trim();
    }

    if(options.spaces){
      text = text.replace(/[ \t\u3000]+/g, " ");
    }

    if(options.ignoreCase){
      text = text.toLocaleLowerCase("ja");
    }

    if(options.date){
      const date = canonicalDate(text);

      if(date !== null){
        text = date;
      }
    }

    if(options.number){
      const number = canonicalNumber(text);

      if(number !== null){
        text = number;
      }
    }

    return text;
  }

  function findEmptyKeyRows(data, key, options){
    return data.records
      .filter(record =>
        normalizeValue(
          record.values[key],
          options
        ) === ""
      )
      .map(record => record.rowNumber);
  }

  function findDuplicateKeys(data, key, options){
    const seen = new Map();
    const duplicates = new Map();

    for(const record of data.records){
      const normalized = normalizeValue(
        record.values[key],
        options
      );

      if(seen.has(normalized)){
        if(!duplicates.has(normalized)){
          duplicates.set(normalized, {
            displayValues:[seen.get(normalized).value],
            rows:[seen.get(normalized).row]
          });
        }

        duplicates
          .get(normalized)
          .displayValues
          .push(String(record.values[key] ?? ""));

        duplicates
          .get(normalized)
          .rows
          .push(record.rowNumber);
      }else{
        seen.set(normalized, {
          value:String(record.values[key] ?? ""),
          row:record.rowNumber
        });
      }
    }

    return [...duplicates.entries()].map(
      ([normalized, info]) => ({
        normalized,
        value:unique(info.displayValues).join(" / "),
        rows:info.rows
      })
    );
  }

  function buildMap(data, key, options){
    const map = new Map();

    data.records.forEach((record, index) => {
      const normalizedKey = normalizeValue(
        record.values[key],
        options
      );

      map.set(normalizedKey, {
        ...record,
        index,
        originalKey:String(record.values[key] ?? "")
      });
    });

    return map;
  }

  function compareNow(){
    showError("");
    showWarn("");

    const key = els.keySelect.value;

    if(!key){
      return;
    }

    state.key = key;
    updateSelectedColumns();

    const newData = state.newData;
    const oldData = state.oldData;
    const options = normalizationOptions();

    const newEmpty = findEmptyKeyRows(
      newData,
      key,
      options
    );

    const oldEmpty = findEmptyKeyRows(
      oldData,
      key,
      options
    );

    if(newEmpty.length || oldEmpty.length){
      const parts = [];

      if(newEmpty.length){
        parts.push(
          `新CSV: ${newEmpty.slice(0, 10).join("、")}行目` +
          `${newEmpty.length > 10 ? " ほか" : ""}`
        );
      }

      if(oldEmpty.length){
        parts.push(
          `旧CSV: ${oldEmpty.slice(0, 10).join("、")}行目` +
          `${oldEmpty.length > 10 ? " ほか" : ""}`
        );
      }

      showError(
        `キー列「${key}」に、正規化後に空欄となる値があります` +
        `（${parts.join(" / ")}）。`
      );

      els.results.classList.remove("show");
      return;
    }

    const newDuplicates = findDuplicateKeys(
      newData,
      key,
      options
    );

    const oldDuplicates = findDuplicateKeys(
      oldData,
      key,
      options
    );

    if(newDuplicates.length || oldDuplicates.length){
      const parts = [];

      if(newDuplicates.length){
        const description = newDuplicates
          .slice(0, 3)
          .map(item =>
            `「${item.value}」` +
            `(${item.rows.join("・")}行目)`
          )
          .join("、");

        parts.push(
          `新CSV: ${description}` +
          `${newDuplicates.length > 3 ? " ほか" : ""}`
        );
      }

      if(oldDuplicates.length){
        const description = oldDuplicates
          .slice(0, 3)
          .map(item =>
            `「${item.value}」` +
            `(${item.rows.join("・")}行目)`
          )
          .join("、");

        parts.push(
          `旧CSV: ${description}` +
          `${oldDuplicates.length > 3 ? " ほか" : ""}`
        );
      }

      showError(
        `キー列「${key}」に、正規化後に重複する値があります` +
        `（${parts.join(" / ")}）。`
      );

      els.results.classList.remove("show");
      return;
    }

    const myVersion = ++operationVersion;
    const loadingToken = beginLoading();

    requestAnimationFrame(() => {
      setTimeout(() => {
        try{
          if(myVersion !== operationVersion){
            return;
          }

          const newMap = buildMap(
            newData,
            key,
            options
          );

          const oldMap = buildMap(
            oldData,
            key,
            options
          );

          const order = [];

          oldData.records.forEach(record => {
            order.push(
              normalizeValue(
                record.values[key],
                options
              )
            );
          });

          newData.records.forEach(record => {
            const normalizedKey = normalizeValue(
              record.values[key],
              options
            );

            if(!oldMap.has(normalizedKey)){
              order.push(normalizedKey);
            }
          });

          const columns = state.selectedColumns;

          state.results = order.map(
            (normalizedKey, orderIndex) => {
              const newRecord = newMap.get(normalizedKey);
              const oldRecord = oldMap.get(normalizedKey);

              const displayKey =
                newRecord?.originalKey ??
                oldRecord?.originalKey ??
                "";

              if(newRecord && !oldRecord){
                return {
                  key:displayKey,
                  normalizedKey,
                  status:"added",
                  newRow:newRecord.values,
                  oldRow:null,
                  newRowNumber:newRecord.rowNumber,
                  oldRowNumber:null,
                  changed:columns.slice(),
                  orderIndex
                };
              }

              if(!newRecord && oldRecord){
                return {
                  key:displayKey,
                  normalizedKey,
                  status:"removed",
                  newRow:null,
                  oldRow:oldRecord.values,
                  newRowNumber:null,
                  oldRowNumber:oldRecord.rowNumber,
                  changed:columns.slice(),
                  orderIndex
                };
              }

              const changed = columns.filter(column => {
                const newValue = normalizeValue(
                  newRecord.values[column] ?? "",
                  options
                );

                const oldValue = normalizeValue(
                  oldRecord.values[column] ?? "",
                  options
                );

                return newValue !== oldValue;
              });

              return {
                key:displayKey,
                normalizedKey,
                status:changed.length
                  ? "modified"
                  : "unchanged",
                newRow:newRecord.values,
                oldRow:oldRecord.values,
                newRowNumber:newRecord.rowNumber,
                oldRowNumber:oldRecord.rowNumber,
                changed,
                orderIndex
              };
            }
          );

          if(myVersion !== operationVersion){
            return;
          }

          const missingNew = columns.filter(
            column => !newData.headers.includes(column)
          );

          const missingOld = columns.filter(
            column => !oldData.headers.includes(column)
          );

          const warnings = [];

          if(missingNew.length){
            warnings.push(
              `新CSVにない列: ${missingNew.join("、")}`
            );
          }

          if(missingOld.length){
            warnings.push(
              `旧CSVにない列: ${missingOld.join("、")}`
            );
          }

          if(warnings.length){
            showWarn(warnings.join(" / "));
          }

          state.page = 1;

          updateSummary();
          updateColumnStatistics();
          updateColumnFilter();

          els.results.classList.add("show");
          render();

          els.results.focus();
          els.results.scrollIntoView({
            behavior:"smooth",
            block:"start"
          });
        }catch(e){
          if(myVersion !== operationVersion){
            return;
          }

          showError(
            e.message ||
            "比較処理中にエラーが発生しました。"
          );
        }finally{
          endLoading(loadingToken);
        }
      }, 30);
    });
  }

  function updateSummary(){
    const counts = {
      added:0,
      removed:0,
      modified:0,
      unchanged:0
    };

    state.results.forEach(result => {
      counts[result.status]++;
    });

    $("totalCount").textContent =
      state.results.length.toLocaleString();

    $("addedCount").textContent =
      counts.added.toLocaleString();

    $("removedCount").textContent =
      counts.removed.toLocaleString();

    $("modifiedCount").textContent =
      counts.modified.toLocaleString();

    $("unchangedCount").textContent =
      counts.unchanged.toLocaleString();
  }

  function columnDifferenceCounts(){
    const counts = Object.fromEntries(
      state.selectedColumns.map(
        column => [column, 0]
      )
    );

    state.results.forEach(result => {
      if(result.status !== "modified"){
        return;
      }

      result.changed.forEach(column => {
        if(
          Object.prototype.hasOwnProperty.call(
            counts,
            column
          )
        ){
          counts[column]++;
        }
      });
    });

    return counts;
  }

  function updateColumnStatistics(){
    const counts = columnDifferenceCounts();
    els.columnStatList.innerHTML = "";

    state.selectedColumns.forEach(column => {
      const item = document.createElement("span");

      item.className =
        "column-stat" +
        (counts[column] ? "" : " zero");

      const name = document.createElement("span");
      name.textContent = column;

      const count = document.createElement("strong");
      count.textContent =
        `${counts[column].toLocaleString()}件`;

      item.append(name, count);
      els.columnStatList.appendChild(item);
    });

    if(!state.selectedColumns.length){
      els.columnStatList.textContent =
        "比較対象列がありません。";
    }
  }

  function updateColumnFilter(){
    const previous = els.columnFilter.value;

    els.columnFilter.innerHTML =
      '<option value="">すべての列</option>';

    state.selectedColumns.forEach(column => {
      const option = document.createElement("option");
      option.value = column;
      option.textContent = column;
      els.columnFilter.appendChild(option);
    });

    if(state.selectedColumns.includes(previous)){
      els.columnFilter.value = previous;
    }
  }

  function currentRows(){
    const query = els.search.value
      .trim()
      .toLocaleLowerCase("ja");

    const status = els.filter.value;
    const changedColumn = els.columnFilter.value;

    let rows = state.results.filter(result => {
      if(
        status === "diff" &&
        result.status === "unchanged"
      ){
        return false;
      }

      if(
        !["all", "diff"].includes(status) &&
        result.status !== status
      ){
        return false;
      }

      if(
        changedColumn &&
        !result.changed.includes(changedColumn)
      ){
        return false;
      }

      if(!query){
        return true;
      }

      const bag = [
        result.key,
        result.newRowNumber ?? "",
        result.oldRowNumber ?? "",
        ...Object.values(result.newRow || {}),
        ...Object.values(result.oldRow || {})
      ]
        .join("\u0001")
        .toLocaleLowerCase("ja");

      return bag.includes(query);
    });

    const sort = els.sort.value;

    if(sort === "diff"){
      const rank = {
        modified:0,
        added:1,
        removed:2,
        unchanged:3
      };

      rows = [...rows].sort((a, b) =>
        rank[a.status] -
        rank[b.status] ||
        a.orderIndex -
        b.orderIndex
      );
    }else if(
      sort === "keyAsc" ||
      sort === "keyDesc"
    ){
      const direction =
        sort === "keyAsc" ? 1 : -1;

      rows = [...rows].sort((a, b) =>
        String(a.key).localeCompare(
          String(b.key),
          "ja",
          {
            numeric:true,
            sensitivity:"base"
          }
        ) * direction
      );
    }else{
      rows = [...rows].sort(
        (a, b) => a.orderIndex - b.orderIndex
      );
    }

    return rows;
  }

  function displayedColumns(rows){
    if(!els.changedOnlyCols.checked){
      return state.selectedColumns;
    }

    const used = new Set();

    rows.forEach(result => {
      if(result.status === "modified"){
        result.changed.forEach(column => {
          used.add(column);
        });
      }else if(
        result.status === "added" ||
        result.status === "removed"
      ){
        result.changed.forEach(column => {
          used.add(column);
        });
      }
    });

    return state.selectedColumns.filter(
      column => used.has(column)
    );
  }

  function statusText(status){
    return {
      added:"追加",
      removed:"削除",
      modified:"変更",
      unchanged:"一致"
    }[status];
  }

  function cell(
    value,
    kind,
    changed,
    exists=true
  ){
    if(!exists){
      return (
        `<td class="${kind} ${changed ? "changed" : ""}">` +
        '<span class="missing">（列なし）</span>' +
        "</td>"
      );
    }

    if(value === null || value === undefined){
      return (
        `<td class="${kind} ${changed ? "changed" : ""}">` +
        '<span class="missing">—</span>' +
        "</td>"
      );
    }

    return (
      `<td class="${kind} ${changed ? "changed" : ""}">` +
      `${escapeHtml(value)}</td>`
    );
  }

  function render(){
    const rows = currentRows();
    const columns = displayedColumns(rows);

    state.pageSize = Number(els.pageSize.value) || 50;

    const pages = Math.max(
      1,
      Math.ceil(rows.length / state.pageSize)
    );

    state.page = Math.min(
      Math.max(1, state.page),
      pages
    );

    const start = (state.page - 1) * state.pageSize;
    const shown = rows.slice(
      start,
      start + state.pageSize
    );

    if(!shown.length){
      els.table.innerHTML =
        '<div class="empty">表示する差分がありません。</div>';
    }else if(!columns.length){
      els.table.innerHTML =
        '<div class="empty">現在の表示条件では、表示対象となる変更列がありません。</div>';
    }else{
      let html = `<table><thead><tr>
        <th class="key" rowspan="2">${escapeHtml(state.key)}</th>
        <th class="status" rowspan="2">状態</th>
        <th colspan="2">元CSV行番号</th>`;

      columns.forEach(column => {
        html += `<th colspan="2">${escapeHtml(column)}</th>`;
      });

        html += `</tr><tr class="sub">
          <th class="row-no"><span class="source-head"><span class="side-dot old-dot"></span>旧</span></th>
          <th class="row-no"><span class="source-head"><span class="side-dot new-dot"></span>新</span></th>`;

      columns.forEach(() => {
        html +=
          `<th><span class="source-head"><span class="side-dot old-dot"></span>旧</span></th>` +
          `<th><span class="source-head"><span class="side-dot new-dot"></span>新</span></th>`;
      });

      html += `</tr></thead><tbody>`;

      shown.forEach(result => {
        html +=
          `<tr class="${result.status}">` +
          `<td class="key">${escapeHtml(result.key || "(空欄)")}</td>` +
          `<td class="status"><span class="status-pill p-${result.status}">${statusText(result.status)}</span></td>` +
          `<td class="row-no">${result.oldRowNumber ?? "—"}</td>` +
          `<td class="row-no">${result.newRowNumber ?? "—"}</td>`;

        columns.forEach(column => {
          const changed = result.changed.includes(column);
          const newExists =
            state.newData.headers.includes(column);
          const oldExists =
            state.oldData.headers.includes(column);

          html += cell(
            result.oldRow
              ? result.oldRow[column]
              : null,
            "old",
            changed,
            oldExists
          );

          html += cell(
            result.newRow
              ? result.newRow[column]
              : null,
            "new",
            changed,
            newExists
          );
        });

        html += "</tr>";
      });

      html += "</tbody></table>";
      els.table.innerHTML = html;
    }

    updateTableScrollHint();

    const end = Math.min(
      start + state.pageSize,
      rows.length
    );

    els.range.textContent = rows.length
      ? `${rows.length.toLocaleString()}件中 ${start + 1}〜${end}件`
      : "0件";

    els.pageLabel.textContent =
      `${state.page} / ${pages}`;

    els.prev.disabled = state.page <= 1;
    els.next.disabled = state.page >= pages;
  }


  function sanitizeCsvCell(value){
    let text = String(value ?? "");

    if(/^[\s\u0000-\u001f]*[=+\-@]/.test(text)){
      text = "'" + text;
    }

    return /[",\r\n]/.test(text)
      ? `"${text.replace(/"/g, '""')}"`
      : text;
  }

  function getLocalDateString(){
    const date = new Date();

    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0")
    ].join("-");
  }

  function exportDiff(){
    const rows = state.results.filter(
      result => result.status !== "unchanged"
    );

    if(!rows.length){
      showWarn("保存できる差分がありません。");
      return;
    }

    const columns = state.selectedColumns;

    const header = [
      "状態",
      state.key,
      "旧CSV行番号",
      "新CSV行番号",
      ...columns.flatMap(column => [
        `旧:${column}`,
        `新:${column}`
      ])
    ];

    const lines = [
      header.map(sanitizeCsvCell).join(",")
    ];

    rows.forEach(result => {
      const line = [
        statusText(result.status),
        result.key,
        result.oldRowNumber ?? "",
        result.newRowNumber ?? ""
      ];

      columns.forEach(column => {
        line.push(result.oldRow?.[column] ?? "");
        line.push(result.newRow?.[column] ?? "");
      });

      lines.push(
        line.map(sanitizeCsvCell).join(",")
      );
    });

    const blob = new Blob(
      ["\uFEFF" + lines.join("\r\n")],
      {
        type:"text/csv;charset=utf-8"
      }
    );

    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");

    anchor.href = url;
    anchor.download =
      `csv差分_${getLocalDateString()}.csv`;

    anchor.click();

    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 1000);
  }

  function clearAll(){
    invalidateAllOperations();
    forceEndLoading();

    state.newRaw = null;
    state.oldRaw = null;
    state.newData = null;
    state.oldData = null;
    state.results = [];
    state.selectedColumns = [];
    state.key = "";
    state.page = 1;

    els.newFile.value = "";
    els.oldFile.value = "";

    els.encoding.value = "auto";
    els.delimiter.value = "auto";
    els.norms.forEach(input => {
      input.checked = false;
    });
    updateNormalizationSummary();

    els.pageSize.value = "50";
    state.pageSize = 50;

    $("columnsDetails").open = false;
    $("normalizeDetails").open = false;

    setDropEmpty("new");
    setDropEmpty("old");

    els.newDrop.classList.remove("drag");
    els.oldDrop.classList.remove("drag");

    els.keySelect.innerHTML =
      '<option value="">' +
      "CSVを2つ選択してください" +
      "</option>";

    els.keySelect.disabled = true;

    els.checks.innerHTML = "";

    els.summary.textContent =
      "（CSVを読み込むと選択できます）";

    els.search.value = "";
    els.filter.value = "diff";

    els.columnFilter.innerHTML =
      '<option value="">すべての列</option>';

    els.sort.value = "source";
    els.changedOnlyCols.checked = false;

    els.columnStatList.innerHTML = "";
    els.results.classList.remove("show");
    els.table.innerHTML = "";
    els.scrollHint.hidden = true;
    els.compare.disabled = true;

    showError("");
    showWarn("");
  }

  function loadSample(){
    clearAll();

    const encoder = new TextEncoder();

    const oldText =
      "職員番号,氏名,所属,内線,更新日\n" +
      "001,山田 太郎,総務課,1234,2025/04/01\n" +
      "002,佐藤 花子,市民課,2345,2025/04/01\n" +
      "003,伊藤 一郎,税務課,3456,2025/04/01\n" +
      '004,"鈴木, 次郎",福祉課,4567,2025/04/01';

    const newText =
      "職員番号,氏名,所属,内線,更新日\n" +
      "001,山田 太郎,総務課,1234,2025-04-01\n" +
      "002,佐藤 花子,住民課,2345,2025/04/01\n" +
      "003,伊藤 一郎,税務課,9999,2025/04/02\n" +
      "005,高橋 三郎,DX推進課,5678,2025/04/03";

    state.newRaw = {
      buffer:encoder.encode(newText).buffer,
      name:"新_サンプル.csv"
    };

    state.oldRaw = {
      buffer:encoder.encode(oldText).buffer,
      name:"旧_サンプル.csv"
    };

    try{
      state.newData = processParsedData(
        state.newRaw.buffer,
        state.newRaw.name,
        "utf-8",
        selectedDelimiter()
      );

      state.oldData = processParsedData(
        state.oldRaw.buffer,
        state.oldRaw.name,
        "utf-8",
        selectedDelimiter()
      );

      setDropLoaded("new", state.newData);
      setDropLoaded("old", state.oldData);

      prepareSetup();
    }catch(e){
      state.newRaw = null;
      state.oldRaw = null;
      state.newData = null;
      state.oldData = null;

      setDropError(
        "new",
        "新_サンプル.csv",
        "サンプルの読み込みエラー"
      );

      setDropError(
        "old",
        "旧_サンプル.csv",
        "サンプルの読み込みエラー"
      );

      showError(
        e.message ||
        "サンプルの読み込みに失敗しました。"
      );
    }
  }

  function reparseLoadedFiles(message){
    invalidateAllOperations();

    if(!state.newRaw && !state.oldRaw){
      return;
    }

    const myVersion = operationVersion;
    const encoding = els.encoding.value;
    const delimiter = selectedDelimiter();
    const loadingToken = beginLoading();

    showError("");
    showWarn("");
    resetResults();

    setTimeout(() => {
      try{
        if(myVersion !== operationVersion){
          return;
        }

        const rawNew = state.newRaw;
        const rawOld = state.oldRaw;

        const nextNew = rawNew
          ? processParsedData(
              rawNew.buffer,
              rawNew.name,
              encoding,
              delimiter
            )
          : null;

        if(myVersion !== operationVersion){
          return;
        }

        const nextOld = rawOld
          ? processParsedData(
              rawOld.buffer,
              rawOld.name,
              encoding,
              delimiter
            )
          : null;

        if(myVersion !== operationVersion){
          return;
        }

        state.newData = nextNew;
        state.oldData = nextOld;

        if(nextNew){
          setDropLoaded("new", nextNew);
        }

        if(nextOld){
          setDropLoaded("old", nextOld);
        }

        prepareSetup();
        showWarn(message);
      }catch(e){
        if(myVersion !== operationVersion){
          return;
        }

        state.newData = null;
        state.oldData = null;
        state.results = [];
        state.selectedColumns = [];
        state.key = "";

        els.keySelect.innerHTML =
          '<option value="">' +
          "CSVの再解析に失敗しました" +
          "</option>";

        els.keySelect.disabled = true;
        els.checks.innerHTML = "";

        els.summary.textContent =
          "（再解析に失敗しました）";

        if(state.newRaw){
          setDropError(
            "new",
            state.newRaw.name,
            "再解析エラー"
          );
        }else{
          setDropEmpty("new");
        }

        if(state.oldRaw){
          setDropError(
            "old",
            state.oldRaw.name,
            "再解析エラー"
          );
        }else{
          setDropEmpty("old");
        }

        els.compare.disabled = true;
        els.results.classList.remove("show");

        showError(
          "CSVの再解析に失敗しました: " +
          (e.message || "解析エラー")
        );
      }finally{
        endLoading(loadingToken);
      }
    }, 10);
  }

  bindDrop(
    els.newFile,
    els.newDrop,
    "new"
  );

  bindDrop(
    els.oldFile,
    els.oldDrop,
    "old"
  );

  els.keySelect.addEventListener("change", () => {
    state.key = els.keySelect.value;

    const all = unique([
      ...(state.newData?.headers || []),
      ...(state.oldData?.headers || [])
    ]);

    state.selectedColumns = all.filter(
      header => header !== state.key
    );

    renderColumnChecks(all);
    resetResults();
    updateCompareButton();
  });

  els.encoding.addEventListener("change", () => {
    reparseLoadedFiles(
      "文字コードを変更しました。" +
      "設定を確認し、再度比較してください。"
    );
  });

  els.delimiter.addEventListener("change", () => {
    reparseLoadedFiles(
      "区切り文字を変更しました。" +
      "設定を確認し、再度比較してください。"
    );
  });

  els.norms.forEach(input => {
    input.addEventListener("change", () => {
      updateNormalizationSummary();

      if(state.results.length){
        resetResults();

        showWarn(
          "比較条件を変更したため、以前の比較結果を" +
          "破棄しました。再度比較してください。"
        );
      }
    });
  });

  $("allCols").addEventListener("click", () => {
    els.checks
      .querySelectorAll("input:not(:disabled)")
      .forEach(input => {
        input.checked = true;
      });

    updateSelectedColumns();
    resetResults();
  });

  $("noCols").addEventListener("click", () => {
    els.checks
      .querySelectorAll("input:not(:disabled)")
      .forEach(input => {
        input.checked = false;
      });

    updateSelectedColumns();
    resetResults();
  });

  els.compare.addEventListener(
    "click",
    compareNow
  );

  els.clear.addEventListener(
    "click",
    clearAll
  );

  els.sample.addEventListener(
    "click",
    loadSample
  );

  els.export.addEventListener(
    "click",
    exportDiff
  );

  window.addEventListener(
    "resize",
    updateTableScrollHint
  );

  let searchTimer;

  els.search.addEventListener("input", () => {
    clearTimeout(searchTimer);

    searchTimer = setTimeout(() => {
      state.page = 1;
      render();
    }, 250);
  });

  [
    els.filter,
    els.columnFilter,
    els.sort,
    els.changedOnlyCols
  ].forEach(control => {
    control.addEventListener("change", () => {
      state.page = 1;
      render();
    });
  });

  els.pageSize.addEventListener("change", () => {
    state.page = 1;
    render();
  });

  els.prev.addEventListener("click", () => {
    state.page--;
    render();
  });

  els.next.addEventListener("click", () => {
    state.page++;
    render();
  });

  updateNormalizationSummary();
})();
