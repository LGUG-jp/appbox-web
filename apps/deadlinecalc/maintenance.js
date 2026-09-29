/**
 * 期限・日数かんたん計算 管理者用メンテナンススクリプト
 */
(function (window, document) {
  "use strict";

  // ==========================================
  // 1. 組織独自閉庁日管理
  // ==========================================
  var customClosedMap = {};

  var customFileInput = document.getElementById("custom-file-input");
  var customTable = document.getElementById("custom-table");
  var customTbody = document.getElementById("custom-tbody");
  var customEmptyMsg = document.getElementById("custom-empty-msg");
  var customAddForm = document.getElementById("custom-add-form");
  var newCustomDate = document.getElementById("new-custom-date");
  var newCustomReason = document.getElementById("new-custom-reason");
  var btnDownloadCustom = document.getElementById("btn-download-custom");
  var customStatus = document.getElementById("custom-status");

  function renderCustomTable() {
    customTbody.innerHTML = "";
    var keys = Object.keys(customClosedMap).sort();
    if (keys.length === 0) {
      customTable.hidden = true;
      customEmptyMsg.hidden = false;
      return;
    }

    customTable.hidden = false;
    customEmptyMsg.hidden = true;

    keys.forEach(function (date) {
      var tr = document.createElement("tr");
      var tdDate = document.createElement("td");
      tdDate.textContent = date;

      var tdReason = document.createElement("td");
      tdReason.textContent = customClosedMap[date];

      var tdAction = document.createElement("td");
      var delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "appbox-button appbox-button--secondary";
      delBtn.textContent = "削除";
      delBtn.style.padding = "2px 8px";
      delBtn.style.minHeight = "28px";
      delBtn.style.fontSize = "12px";
      delBtn.addEventListener("click", function () {
        delete customClosedMap[date];
        renderCustomTable();
        showStatus(customStatus, date + " を削除しました。", "success");
      });
      tdAction.appendChild(delBtn);

      tr.appendChild(tdDate);
      tr.appendChild(tdReason);
      tr.appendChild(tdAction);
      customTbody.appendChild(tr);
    });
  }

  function showStatus(elem, msg, type) {
    if (!elem) return;
    elem.textContent = msg;
    elem.className = "maint-status maint-status--" + type;
    elem.hidden = false;
  }

  if (customFileInput) {
    customFileInput.addEventListener("change", function (e) {
      var file = e.target.files && e.target.files[0];
      if (!file) return;

      var reader = new FileReader();
      reader.onload = function (evt) {
        var text = evt.target.result;
        try {
          var regex = /["'](\d{4}-\d{2}-\d{2})["']\s*:\s*["']([^"']+)["']/g;
          var match;
          var count = 0;
          while ((match = regex.exec(text)) !== null) {
            customClosedMap[match[1]] = match[2];
            count++;
          }
          renderCustomTable();
          showStatus(customStatus, count + " 件の設定を読み込みました。", "success");
        } catch (err) {
          showStatus(customStatus, "読み込みに失敗しました: " + err.message, "error");
        }
      };
      reader.readAsText(file, "utf-8");
    });
  }

  if (customAddForm) {
    customAddForm.addEventListener("submit", function (e) {
      e.preventDefault();
      var date = newCustomDate.value.trim();
      var reason = newCustomReason.value.trim();
      if (!date || !reason) return;

      customClosedMap[date] = reason;
      newCustomDate.value = "";
      newCustomReason.value = "";
      renderCustomTable();
      showStatus(customStatus, date + "（" + reason + "）を追加しました。", "success");
    });
  }

  if (btnDownloadCustom) {
    btnDownloadCustom.addEventListener("click", function () {
      var lines = [
        "/**",
        " * 組織独自閉庁日の設定",
        " *",
        " * 自治体・組織独自の休庁日（開庁しない日）を定義します。",
        " * キー: \"YYYY-MM-DD\" 形式の日付文字列",
        " * 値: 休庁理由（例: \"創立記念日\", \"夏季一斉休庁日\"）",
        " * 生成日時: " + new Date().toISOString(),
        " */",
        "(function (root) {",
        "  \"use strict\";",
        "",
        "  var customClosedDays = {"
      ];

      var keys = Object.keys(customClosedMap).sort();
      keys.forEach(function (k, idx) {
        var comma = idx < keys.length - 1 ? "," : "";
        lines.push('    "' + k + '": ' + JSON.stringify(customClosedMap[k]) + comma);
      });

      lines.push("  };");
      lines.push("");
      lines.push("  if (typeof module !== \"undefined\" && module.exports) {");
      lines.push("    module.exports = customClosedDays;");
      lines.push("  }");
      lines.push("  if (root) {");
      lines.push("    root.AppBoxCustomClosedDays = customClosedDays;");
      lines.push("  }");
      lines.push("})(typeof globalThis !== \"undefined\" ? globalThis : this);");
      lines.push("");

      var content = lines.join("\n");
      downloadFile("custom-closed-days.js", content, "application/javascript");
      showStatus(customStatus, "custom-closed-days.js をダウンロードしました。フォルダーへ配置してください。", "success");
    });
  }

  // ==========================================
  // 2. 内閣府祝日データ更新
  // ==========================================
  var csvDropZone = document.getElementById("csv-drop-zone");
  var csvFileInput = document.getElementById("csv-file-input");
  var csvPreviewBox = document.getElementById("csv-preview-box");
  var previewCount = document.getElementById("preview-count");
  var previewRange = document.getElementById("preview-range");
  var previewUpdated = document.getElementById("preview-updated");
  var previewTbody = document.getElementById("preview-tbody");
  var btnDownloadHolidays = document.getElementById("btn-download-holidays");
  var holidayStatus = document.getElementById("holiday-status");

  var parsedHolidays = null;

  function handleCsvFile(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function (e) {
      var buffer = e.target.result;
      var text = "";

      // 内閣府CSVは通常Shift_JISなので、まずはShift_JISでデコード試行
      try {
        var decoderSjis = new TextDecoder("shift-jis");
        text = decoderSjis.decode(buffer);
        if (!text.includes("国民の祝日") && !text.includes("元日")) {
          // UTF-8 でリトライ
          var decoderUtf8 = new TextDecoder("utf-8");
          text = decoderUtf8.decode(buffer);
        }
      } catch (err) {
        var decoder = new TextDecoder("utf-8");
        text = decoder.decode(buffer);
      }

      parseSyukujitsuCsv(text);
    };
    reader.readAsArrayBuffer(file);
  }

  function parseSyukujitsuCsv(csvText) {
    try {
      var lines = csvText.split(/\r?\n/);
      var holidays = {};
      var dates = [];

      lines.forEach(function (line) {
        var parts = line.split(",");
        if (parts.length < 2) return;
        var dateRaw = parts[0].trim();
        var name = parts[1].trim();

        // 日付形式 YYYY/M/D または YYYY-MM-DD を判定
        var m = dateRaw.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})$/);
        if (!m) return; // ヘッダー行等をスキップ

        var y = m[1];
        var mo = m[2].length === 1 ? "0" + m[2] : m[2];
        var d = m[3].length === 1 ? "0" + m[3] : m[3];
        var iso = y + "-" + mo + "-" + d;

        holidays[iso] = name;
        dates.push(iso);
      });

      dates.sort();
      if (dates.length === 0) {
        throw new Error("有効な祝日データが見つかりませんでした。内閣府の syukujitsu.csv であることをご確認ください。");
      }

      var startDate = dates[0];
      var lastDate = dates[dates.length - 1];
      var lastYear = lastDate.slice(0, 4);
      var endDate = lastYear + "-12-31";
      var today = new Date().toISOString().slice(0, 10);

      parsedHolidays = {
        meta: {
          updated: today,
          source: "内閣府 国民の祝日について（syukujitsu.csv）",
          startDate: startDate,
          endDate: endDate,
          count: dates.length
        },
        data: holidays,
        dates: dates
      };

      previewCount.textContent = dates.length.toLocaleString();
      previewRange.textContent = startDate + " 〜 " + endDate + "（" + lastYear + "年対応）";
      previewUpdated.textContent = today;

      previewTbody.innerHTML = "";
      var recentDates = dates.slice(-5);
      recentDates.forEach(function (iso) {
        var tr = document.createElement("tr");
        var td1 = document.createElement("td");
        td1.textContent = iso;
        var td2 = document.createElement("td");
        td2.textContent = holidays[iso];
        tr.appendChild(td1);
        tr.appendChild(td2);
        previewTbody.appendChild(tr);
      });

      csvPreviewBox.hidden = false;
      showStatus(holidayStatus, "CSVを正常に解析しました（" + dates.length + "件）。下のボタンから holidays.js をダウンロードしてください。", "success");
    } catch (err) {
      csvPreviewBox.hidden = true;
      showStatus(holidayStatus, "解析に失敗しました: " + err.message, "error");
    }
  }

  if (csvFileInput) {
    csvFileInput.addEventListener("change", function (e) {
      handleCsvFile(e.target.files && e.target.files[0]);
    });
  }

  if (csvDropZone) {
    csvDropZone.addEventListener("dragover", function (e) {
      e.preventDefault();
      csvDropZone.classList.add("dragover");
    });
    csvDropZone.addEventListener("dragleave", function () {
      csvDropZone.classList.remove("dragover");
    });
    csvDropZone.addEventListener("drop", function (e) {
      e.preventDefault();
      csvDropZone.classList.remove("dragover");
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        handleCsvFile(e.dataTransfer.files[0]);
      }
    });
  }

  if (btnDownloadHolidays) {
    btnDownloadHolidays.addEventListener("click", function () {
      if (!parsedHolidays) return;

      var metaObj = {
        updated: parsedHolidays.meta.updated,
        startDate: parsedHolidays.meta.startDate,
        endDate: parsedHolidays.meta.endDate,
        count: parsedHolidays.meta.count
      };

      var lines = [
        "(function (root, factory) {",
        "  var holidays = factory();",
        "  if (typeof module === \"object\" && module.exports) {",
        "    module.exports = holidays;",
        "  }",
        "  if (root) {",
        "    root.DeadlineCalcHolidays = holidays;",
        "    root.AppBoxHolidays = holidays;",
        "  }",
        "})(typeof globalThis !== \"undefined\" ? globalThis : this, function () {",
        "  \"use strict\";",
        "",
        "  // 内閣府「国民の祝日」データ",
        "  // 出典: https://www8.cao.go.jp/chosei/shukujitsu/gaiyou.html",
        "  // 利用条件: 公共データ利用規約 第1.0版",
        "  // https://www.digital.go.jp/resources/open_data/public_data_license_v1.0",
        "  // 加工: LGUGが本アプリ用のJavaScript形式へ変換・整形",
        "  // データ取得日: " + metaObj.updated,
        "  // 対象期間: " + metaObj.startDate + " 〜 " + metaObj.endDate + " (" + metaObj.count + "件)",
        "  var HOLIDAY_META = " + JSON.stringify(metaObj, null, 2).replace(/\n/g, "\n  ") + ";",
        "",
        "  var HOLIDAYS = " + JSON.stringify(parsedHolidays.data, null, 2).replace(/\n/g, "\n  ") + ";",
        "",
        "  return Object.freeze({",
        "    meta: Object.freeze(HOLIDAY_META),",
        "    items: Object.freeze(HOLIDAYS),",
        "    isHoliday: function (isoDate) {",
        "      return Object.prototype.hasOwnProperty.call(HOLIDAYS, isoDate);",
        "    },",
        "    getHolidayName: function (isoDate) {",
        "      return HOLIDAYS[isoDate] || null;",
        "    }",
        "  });",
        "});",
        ""
      ];

      var content = lines.join("\n");
      downloadFile("holidays.js", content, "application/javascript");
      showStatus(holidayStatus, "holidays.js をダウンロードしました。フォルダーへ配置してください。", "success");
    });
  }

  function downloadFile(filename, content, mimeType) {
    var blob = new Blob([content], { type: mimeType });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
  }

})(window, document);
