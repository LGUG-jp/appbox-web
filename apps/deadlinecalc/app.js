/**
 * 期限・日数かんたん計算 アプリケーション制御
 * カレンダー主役型インタラクティブUI
 */
(function (window, document) {
  "use strict";

  var core = window.DeadlineCalcCore || window.AppBoxDeadlineCore;
  var utilities = (window.AppBox && window.AppBox.utilities) || window.AppBoxUtilities || null;
  if (!core) return;

  var customClosedDays = window.AppBoxCustomClosedDays || null;

  // ==========================================
  // 状態管理 (State)
  // ==========================================
  var todayObj = core.getToday();
  var todayIso = core.toIsoDate(todayObj);

  var state = {
    currentYear: todayObj.year,
    currentMonth: todayObj.month,
    mode: "deadline", // "deadline" | "duration"
    
    // 期限計算モード用
    selectedBaseDate: todayIso,
    deadlineDays: 14,
    deadlineDirection: "after", // "after" | "before"
    includeFirstDay: false,
    countMode: "calendar", // "calendar" | "business"
    closedAdjustment: "next", // "next" | "prev" | "none"
    lastDeadlineResult: null,

    // 期間計算モード用
    durationStart: todayIso,
    durationEnd: core.toIsoDate(core.addDays(todayObj, 14)),
    durationIncludeFirst: false,
    durationPickTarget: "end", // "start" | "end"
    lastDurationResult: null,

    // 選択中の日付情報
    clickedDate: todayIso
  };

  // ==========================================
  // DOM要素の参照取得
  // ==========================================
  // タブ切り替え
  var tabCalculator = document.getElementById("tab-calculator");
  var tabDuration = document.getElementById("tab-duration");
  var tabYearly = document.getElementById("tab-yearly");
  var panelCalculator = document.getElementById("panel-calculator");
  var panelYearly = document.getElementById("panel-yearly");
  var btnPrintYearly = document.getElementById("btn-print-yearly");

  // モード選択
  var modeRadios = document.querySelectorAll('input[name="calc-main-mode"]');
  var modeTip = document.getElementById("mode-tip");
  var panelDeadlineCtrl = document.getElementById("panel-deadline-ctrl");
  var panelDurationCtrl = document.getElementById("panel-duration-ctrl");

  // カレンダー操作部
  var btnPrevMonth = document.getElementById("btn-prev-month");
  var btnNextMonth = document.getElementById("btn-next-month");
  var selectCalYear = document.getElementById("select-cal-year");
  var selectCalMonth = document.getElementById("select-cal-month");
  var btnCalToday = document.getElementById("btn-cal-today");
  var calendarGrid = document.getElementById("calendar-grid");

  // 月間サマリ
  var summaryMonthLabel = document.getElementById("summary-month-label");
  var summaryBusinessDays = document.getElementById("summary-business-days");
  var summaryClosedDays = document.getElementById("summary-closed-days");
  var summarySubNote = document.getElementById("summary-sub-note");

  // 期限計算コントローラー
  var deadlineBaseDisplay = document.getElementById("deadline-base-display");
  var btnSetToday = document.getElementById("btn-set-today");
  var dirRadios = document.querySelectorAll('input[name="deadline-direction"]');
  var stepButtons = document.querySelectorAll(".calc-btn-step");
  var inputDaysValue = document.getElementById("input-days-value");
  var quickChips = document.querySelectorAll(".calc-chip");

  // 期限詳細設定
  var advIncludeFirstRadios = document.querySelectorAll('input[name="adv-include-first"]');
  var advCountModeRadios = document.querySelectorAll('input[name="adv-count-mode"]');
  var advClosedAdjustRadios = document.querySelectorAll('input[name="adv-closed-adjust"]');
  var advAdjustGroup = document.getElementById("adv-adjust-group");

  // 期限結果カード
  var deadlineFinalDate = document.getElementById("deadline-final-date");
  var deadlineFinalSub = document.getElementById("deadline-final-sub");
  var deadlineAdjustBadge = document.getElementById("deadline-adjust-badge");
  var metricRealDays = document.getElementById("metric-real-days");
  var metricBusinessDays = document.getElementById("metric-business-days");
  var metricExcludedDays = document.getElementById("metric-excluded-days");
  var deadlineAdjustMsg = document.getElementById("deadline-adjust-msg");
  var deadlineWarnings = document.getElementById("deadline-warnings");
  var btnCopyDeadlineSimple = document.getElementById("btn-copy-deadline-simple");
  var btnCopyDeadlineFull = document.getElementById("btn-copy-deadline-full");

  // 期間計算コントローラー
  var durationStartDisplay = document.getElementById("duration-start-display");
  var durationEndDisplay = document.getElementById("duration-end-display");
  var btnDurationPickStart = document.getElementById("btn-duration-pick-start");
  var btnDurationPickEnd = document.getElementById("btn-duration-pick-end");
  var durationIncludeFirstRadios = document.querySelectorAll('input[name="duration-include-first"]');

  // 期間結果カード
  var durationRangeTag = document.getElementById("duration-range-tag");
  var durationMetricTotal = document.getElementById("duration-metric-total");
  var durationMetricInclusive = document.getElementById("duration-metric-inclusive");
  var durationMetricBusiness = document.getElementById("duration-metric-business");
  var durationMetricApprox = document.getElementById("duration-metric-approx");
  var durationBreakdownText = document.getElementById("duration-breakdown-text");
  var durationWarnings = document.getElementById("duration-warnings");
  var btnCopyDurationSimple = document.getElementById("btn-copy-duration-simple");
  var btnCopyDurationFull = document.getElementById("btn-copy-duration-full");

  // 年間早見表
  var yearlySelectYear = document.getElementById("yearly-select-year");
  var btnYearlyPrev = document.getElementById("btn-yearly-prev");
  var btnYearlyNext = document.getElementById("btn-yearly-next");
  var yearlySummaryBox = document.getElementById("yearly-summary-box");
  var yearlyCalendarTitle = document.getElementById("yearly-calendar-title");
  var yearlyCalendarGrid = document.getElementById("yearly-calendar-grid");
  var yearlyTbody = document.getElementById("yearly-tbody");
  var calHolidayMetaText = document.getElementById("cal-holiday-meta-text");
  var yearlyHolidayMetaText = document.getElementById("yearly-holiday-meta-text");

  // トースト
  var copyToast = document.getElementById("copy-toast");

  // ==========================================
  // 初期化
  // ==========================================
  function initYearMonthSelects() {
    selectCalYear.innerHTML = "";
    yearlySelectYear.innerHTML = "";
    for (var y = 1955; y <= 2050; y++) {
      var opt = document.createElement("option");
      opt.value = y;
      opt.textContent = y + "年（" + getEraShortName(y) + "）";
      if (y === state.currentYear) opt.selected = true;
      selectCalYear.appendChild(opt);

      var optY = opt.cloneNode(true);
      if (y === state.currentYear) optY.selected = true;
      yearlySelectYear.appendChild(optY);
    }

    selectCalMonth.innerHTML = "";
    for (var m = 1; m <= 12; m++) {
      var optM = document.createElement("option");
      optM.value = m;
      optM.textContent = m + "月";
      if (m === state.currentMonth) optM.selected = true;
      selectCalMonth.appendChild(optM);
    }

    updateYearlyNavButtons();
  }

  function getEraShortName(year) {
    if (year >= 2019) return "令和" + (year === 2019 ? "元" : year - 2018) + "年";
    if (year >= 1989) return "平成" + (year === 1989 ? "元" : year - 1988) + "年";
    if (year >= 1926) return "昭和" + (year === 1926 ? "元" : year - 1925) + "年";
    return "";
  }

  // ==========================================
  // カレンダー描画
  // ==========================================
  function renderCalendar() {
    selectCalYear.value = state.currentYear;
    selectCalMonth.value = state.currentMonth;

    var calData = core.getMonthCalendar(state.currentYear, state.currentMonth, customClosedDays);

    summaryMonthLabel.textContent = state.currentYear + "年" + state.currentMonth + "月";
    summaryBusinessDays.textContent = calData.businessDays;
    summaryClosedDays.textContent = calData.closedDays;
    summarySubNote.textContent = "（土日: " + calData.weekendDays + "日 / 祝日等: " + calData.holidayDays + "日）";

    // 既存の日付セルを削除（曜日ヘッダー7個は残す）
    var cells = calendarGrid.querySelectorAll(".calc-day-cell");
    cells.forEach(function (c) { c.remove(); });

    // ハイライト判定用の範囲を計算
    var rangeStart = null;
    var rangeEnd = null;
    var targetDate = null;
    var baseDate = null;

    if (state.mode === "deadline") {
      baseDate = state.selectedBaseDate;
      if (state.lastDeadlineResult) {
        targetDate = state.lastDeadlineResult.finalTargetDate;
        if (state.deadlineDirection === "after") {
          rangeStart = baseDate;
          rangeEnd = targetDate;
        } else {
          rangeStart = targetDate;
          rangeEnd = baseDate;
        }
      }
    } else {
      baseDate = state.durationStart;
      targetDate = state.durationEnd;
      if (core.compareDates(state.durationEnd, state.durationStart) >= 0) {
        rangeStart = state.durationStart;
        rangeEnd = state.durationEnd;
      } else {
        rangeStart = state.durationEnd;
        rangeEnd = state.durationStart;
      }
    }

    calData.days.forEach(function (d) {
      var cell = document.createElement("div");
      cell.className = "calc-day-cell";
      cell.setAttribute("role", "gridcell");
      cell.setAttribute("tabindex", "0");
      cell.dataset.date = d.date;

      if (!d.isCurrentMonth) cell.classList.add("is-other-month");
      if (d.dayOfWeek === 6) cell.classList.add("is-saturday");
      if (d.dayOfWeek === 0) cell.classList.add("is-sunday");
      if (d.isClosed) cell.classList.add("is-holiday");
      if (d.isCustomClosed) cell.classList.add("is-custom");
      if (d.isToday) cell.classList.add("is-today");

      // 基準日・期限日・範囲判定
      if (d.date === baseDate) {
        cell.classList.add("is-base");
      }
      if (d.date === targetDate) {
        cell.classList.add("is-target");
      }
      if (rangeStart && rangeEnd && d.date >= rangeStart && d.date <= rangeEnd && d.date !== baseDate && d.date !== targetDate) {
        cell.classList.add("is-in-range");
      }

      var numSpan = document.createElement("span");
      numSpan.className = "calc-day-number";
      numSpan.textContent = d.day;
      cell.appendChild(numSpan);

      // 祝日名または閉庁理由バッジ
      if (d.holidayName) {
        var hBadge = document.createElement("span");
        hBadge.className = "cal-cell-badge badge-holiday";
        hBadge.textContent = d.holidayName;
        cell.appendChild(hBadge);
      } else if (d.isCustomClosed) {
        var cBadge = document.createElement("span");
        cBadge.className = "cal-cell-badge badge-custom-closed";
        cBadge.textContent = d.closedReason;
        cell.appendChild(cBadge);
      } else if (d.closedReason && d.closedReason.includes("年末年始")) {
        var yBadge = document.createElement("span");
        yBadge.className = "cal-cell-badge badge-year-end";
        yBadge.textContent = "年末年始";
        cell.appendChild(yBadge);
      }

      // 期間計算モードで終了日選択中の場合、開始日より前のセルを無効化スタイルに
      if (state.mode === "duration" && state.durationPickTarget === "end") {
        if (core.compareDates(d.date, state.durationStart) < 0) {
          cell.classList.add("is-disabled-target");
          cell.setAttribute("aria-disabled", "true");
        }
      }

      // クリックイベント
      cell.addEventListener("click", function () {
        handleDateClick(d.date);
      });
      cell.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleDateClick(d.date);
        }
      });

      calendarGrid.appendChild(cell);
    });
  }

  // ==========================================
  // 日付クリック操作のハンドリング
  // ==========================================
  function handleDateClick(isoDate) {
    state.clickedDate = isoDate;

    if (state.mode === "deadline") {
      // 期限計算モード: クリックした日を基準日にセット
      state.selectedBaseDate = isoDate;
      // 必要に応じてカレンダーの年月も移動
      var p = core.parseDate(isoDate);
      if (p.year !== state.currentYear || p.month !== state.currentMonth) {
        state.currentYear = p.year;
        state.currentMonth = p.month;
      }
      recalculateDeadline();
    } else {
      // 期間計算モード: 開始日または終了日にセット
      if (state.durationPickTarget === "start") {
        state.durationStart = isoDate;
        // 開始日が現在の終了日より後になった場合、終了日も開始日と同じ日に揃える
        if (core.compareDates(isoDate, state.durationEnd) > 0) {
          state.durationEnd = isoDate;
        }
        state.durationPickTarget = "end"; // 次は終了日選択へ
      } else {
        // 終了日（期限日）選択時: 開始日より前の日付は選択不可
        if (core.compareDates(isoDate, state.durationStart) < 0) {
          var startParsed = core.parseDate(state.durationStart);
          var startJp = startParsed ? core.toJapaneseEra(startParsed) : state.durationStart;
          showToast("終了日（期限日）は、開始日（" + startJp + "）以降の日付を選択してください。");
          return;
        }
        state.durationEnd = isoDate;
        state.durationPickTarget = "start"; // 次は開始日選択へ
      }
      recalculateDuration();
    }
  }

  // ==========================================
  // 期限計算 (Deadline Calculation)
  // ==========================================
  function recalculateDeadline() {
    var baseDate = state.selectedBaseDate;
    var days = state.deadlineDays;
    var dir = state.deadlineDirection;

    deadlineBaseDisplay.textContent = core.formatFullDate(baseDate);
    inputDaysValue.value = days;

    // クイックチップのアクティブ状態更新
    quickChips.forEach(function (chip) {
      chip.classList.toggle("active", Number(chip.dataset.quickDays) === days);
    });

    try {
      var result = core.calculateDeadline(baseDate, days, {
        direction: dir,
        includeFirstDay: state.includeFirstDay,
        countMode: state.countMode,
        closedAdjustment: state.closedAdjustment,
        customClosedDays: customClosedDays
      });

      state.lastDeadlineResult = result;

      deadlineFinalDate.textContent = result.finalTargetJapanese + "（" + result.finalTargetWeekday + "）";
      deadlineFinalSub.textContent = result.finalTargetDate;

      metricRealDays.textContent = days;
      // 開庁日数のカウント（ステップ内）
      var bCount = 0;
      result.steps.forEach(function (s) {
        if (s.stepType === "count" && !s.isClosed) bCount++;
      });
      metricBusinessDays.textContent = result.countMode === "business" ? days : bCount;
      metricExcludedDays.textContent = result.excludedDays.length;

      // 繰越／繰上バッジとメッセージ
      if (result.adjustmentApplied === "next") {
        deadlineAdjustBadge.textContent = "翌開庁日へ繰越";
        deadlineAdjustBadge.hidden = false;
        deadlineAdjustMsg.textContent = "本来の期日（" + result.rawTargetDate + "）が閉庁日（" + result.rawTargetClosedReason + "）のため、翌開庁日へ繰り越されました。";
        deadlineAdjustMsg.hidden = false;
      } else if (result.adjustmentApplied === "prev") {
        deadlineAdjustBadge.textContent = "前開庁日へ繰上";
        deadlineAdjustBadge.hidden = false;
        deadlineAdjustMsg.textContent = "本来の期日（" + result.rawTargetDate + "）が閉庁日（" + result.rawTargetClosedReason + "）のため、前開庁日へ繰り上げられました。";
        deadlineAdjustMsg.hidden = false;
      } else {
        deadlineAdjustBadge.hidden = true;
        deadlineAdjustMsg.hidden = true;
      }

      // 祝日範囲外警告
      if (result.warnings && result.warnings.length > 0) {
        deadlineWarnings.textContent = result.warnings.join("\n");
        deadlineWarnings.hidden = false;
      } else {
        deadlineWarnings.textContent = "";
        deadlineWarnings.hidden = true;
      }

      // カレンダー再描画（ハイライト更新）
      renderCalendar();
    } catch (err) {
      if (deadlineWarnings) {
        deadlineWarnings.textContent = "計算エラー: " + err.message;
        deadlineWarnings.hidden = false;
      }
    }
  }

  // ==========================================
  // 期間計算 (Duration Calculation)
  // ==========================================
  function recalculateDuration() {
    var start = state.durationStart;
    var end = state.durationEnd;

    durationStartDisplay.textContent = core.formatFullDate(start);
    durationEndDisplay.textContent = core.formatFullDate(end);

    if (state.durationPickTarget === "start") {
      btnDurationPickStart.classList.add("is-active");
      btnDurationPickStart.textContent = "● 選択中";
      btnDurationPickEnd.classList.remove("is-active");
      btnDurationPickEnd.textContent = "カレンダーで選択";
    } else {
      btnDurationPickStart.classList.remove("is-active");
      btnDurationPickStart.textContent = "カレンダーで選択";
      btnDurationPickEnd.classList.add("is-active");
      btnDurationPickEnd.textContent = "● 選択中";
    }

    try {
      var result = core.calculateRemainingDays(start, end, {
        includeFirstDay: state.durationIncludeFirst,
        customClosedDays: customClosedDays
      });

      state.lastDurationResult = result;

      durationRangeTag.textContent = result.isPast ? "（期限超過）" : (result.isToday ? "（当日）" : "（" + result.totalDays + "日後）");
      durationMetricTotal.textContent = result.totalDays;
      durationMetricInclusive.textContent = "（両端含む: " + result.inclusiveDays + "日）";
      durationMetricBusiness.textContent = result.businessDays;

      // 期間の目安（年・月・日）
      var dur = core.calculateDuration(start <= end ? start : end, start <= end ? end : start, customClosedDays);
      durationMetricApprox.textContent = dur.approximate.years + "年" + dur.approximate.months + "か月" + dur.approximate.days + "日";

      durationBreakdownText.textContent = "土日 " + result.weekendDays + "日 / 祝日・休庁日 " + result.holidayDays + "日（計 " + result.closedDays + "日）";

      if (result.warnings && result.warnings.length > 0) {
        durationWarnings.textContent = result.warnings.join("\n");
        durationWarnings.hidden = false;
      } else {
        durationWarnings.textContent = "";
        durationWarnings.hidden = true;
      }

      renderCalendar();
    } catch (err) {
      if (durationWarnings) {
        durationWarnings.textContent = "期間計算エラー: " + err.message;
        durationWarnings.hidden = false;
      }
    }
  }

  // ==========================================
  // イベントリスナーの登録
  // ==========================================

  // モード切り替え
  modeRadios.forEach(function (radio) {
    radio.addEventListener("change", function () {
      state.mode = this.value;
      if (state.mode === "deadline") {
        panelDeadlineCtrl.hidden = false;
        panelDurationCtrl.hidden = true;
        modeTip.textContent = "カレンダーの日付をクリックして基準日を選択し、日数をボタンでカチカチ変更できます。";
        recalculateDeadline();
      } else {
        panelDeadlineCtrl.hidden = true;
        panelDurationCtrl.hidden = false;
        modeTip.textContent = "カレンダーの日付を2回クリックして、開始日と終了日（期限日）を自由に指定できます。";
        recalculateDuration();
      }
    });
  });

  // カレンダー前月・次月・今月・セレクト
  btnPrevMonth.addEventListener("click", function () {
    var prev = core.addMonths({ year: state.currentYear, month: state.currentMonth, day: 1 }, -1);
    state.currentYear = prev.year;
    state.currentMonth = prev.month;
    renderCalendar();
  });

  btnNextMonth.addEventListener("click", function () {
    var next = core.addMonths({ year: state.currentYear, month: state.currentMonth, day: 1 }, 1);
    state.currentYear = next.year;
    state.currentMonth = next.month;
    renderCalendar();
  });

  btnCalToday.addEventListener("click", function () {
    state.currentYear = todayObj.year;
    state.currentMonth = todayObj.month;
    renderCalendar();
  });

  selectCalYear.addEventListener("change", function () {
    state.currentYear = Number(this.value);
    renderCalendar();
  });

  selectCalMonth.addEventListener("change", function () {
    state.currentMonth = Number(this.value);
    renderCalendar();
  });

  // 「今日にする」ボタン
  btnSetToday.addEventListener("click", function () {
    handleDateClick(todayIso);
  });

  // 方向ラジオ（○日後 / ○日前）
  dirRadios.forEach(function (r) {
    r.addEventListener("change", function () {
      state.deadlineDirection = this.value;
      recalculateDeadline();
    });
  });

  // ステッパーボタン（-10, -1, +1, +10）
  stepButtons.forEach(function (btn) {
    btn.addEventListener("click", function () {
      var step = Number(this.dataset.step);
      var current = state.deadlineDays;
      var next = Math.max(0, Math.min(36525, current + step));
      state.deadlineDays = next;
      recalculateDeadline();
    });
  });

  // クイック日数チップ（7, 10, 14, 20, 30, 60, 90）
  quickChips.forEach(function (chip) {
    chip.addEventListener("click", function () {
      state.deadlineDays = Number(this.dataset.quickDays);
      recalculateDeadline();
    });
  });

  // 日数直接入力
  inputDaysValue.addEventListener("change", function () {
    var val = parseInt(this.value, 10);
    if (isNaN(val) || val < 0) val = 0;
    if (val > 36525) val = 36525;
    state.deadlineDays = val;
    recalculateDeadline();
  });

  // 詳細設定ラジオ連動
  advIncludeFirstRadios.forEach(function (r) {
    r.addEventListener("change", function () {
      state.includeFirstDay = this.value === "true";
      recalculateDeadline();
    });
  });

  advCountModeRadios.forEach(function (r) {
    r.addEventListener("change", function () {
      state.countMode = this.value;
      advAdjustGroup.hidden = (this.value === "business");
      recalculateDeadline();
    });
  });

  advClosedAdjustRadios.forEach(function (r) {
    r.addEventListener("change", function () {
      state.closedAdjustment = this.value;
      recalculateDeadline();
    });
  });

  // 期間計算ピッカー切替ボタン
  btnDurationPickStart.addEventListener("click", function () {
    state.durationPickTarget = "start";
    recalculateDuration();
  });
  btnDurationPickEnd.addEventListener("click", function () {
    state.durationPickTarget = "end";
    recalculateDuration();
  });

  durationIncludeFirstRadios.forEach(function (r) {
    r.addEventListener("change", function () {
      state.durationIncludeFirst = this.value === "true";
      recalculateDuration();
    });
  });

  // コピー処理
  function showToast(msg) {
    copyToast.textContent = msg;
    copyToast.hidden = false;
    setTimeout(function () { copyToast.hidden = true; }, 2500);
  }

  function copyToClipboard(text) {
    if (utilities && typeof utilities.copyText === "function") {
      return utilities.copyText(text);
    }
    if (window.isSecureContext && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      return navigator.clipboard.writeText(text);
    }
    var textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    textarea.style.pointerEvents = "none";
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand("copy");
    } catch (e) {}
    textarea.remove();
    return Promise.resolve(true);
  }

  btnCopyDeadlineSimple.addEventListener("click", function () {
    if (!state.lastDeadlineResult) return;
    var r = state.lastDeadlineResult;
    var text = "期限日: " + r.finalTargetJapanese + "（" + r.finalTargetWeekday + "） / " + r.finalTargetDate;
    copyToClipboard(text);
    showToast("期限日をコピーしました。");
  });

  btnCopyDeadlineFull.addEventListener("click", function () {
    if (!state.lastDeadlineResult) return;
    var r = state.lastDeadlineResult;
    var lines = [
      "【期限の計算結果】",
      "基準日: " + r.baseDate + "（" + (r.includeFirstDay ? "初日算入" : "初日不算入") + "）",
      "指定日数: " + r.days + "日" + (r.direction === "before" ? "前" : "後") + "（" + (r.countMode === "business" ? "開庁日のみ" : "暦日") + "）",
      "期限日: " + r.finalTargetJapanese + "（" + r.finalTargetWeekday + "） / " + r.finalTargetDate,
      "補正: " + (r.adjustmentApplied === "next" ? "翌開庁日繰越" : (r.adjustmentApplied === "prev" ? "前開庁日繰上" : "補正なし"))
    ];
    copyToClipboard(lines.join("\n"));
    showToast("詳細条件を含めてコピーしました。");
  });

  btnCopyDurationSimple.addEventListener("click", function () {
    if (!state.lastDurationResult) return;
    var r = state.lastDurationResult;
    var text = "期間日数: " + r.totalDays + "日間（実働開庁日: " + r.businessDays + "開庁日）";
    copyToClipboard(text);
    showToast("期間日数をコピーしました。");
  });

  btnCopyDurationFull.addEventListener("click", function () {
    if (!state.lastDurationResult) return;
    var r = state.lastDurationResult;
    var lines = [
      "【期間の計算結果】",
      "期間: " + r.baseDate + " 〜 " + r.deadlineDate + "（" + (r.includeFirstDay ? "両端含む" : "片端・初日不算入") + "）",
      "実日数: " + r.totalDays + "日間（両端含む: " + r.inclusiveDays + "日）",
      "開庁日数: " + r.businessDays + "開庁日",
      "閉庁日数: " + r.closedDays + "日（土日: " + r.weekendDays + "日 / 祝日等: " + r.holidayDays + "日）"
    ];
    copyToClipboard(lines.join("\n"));
    showToast("詳細を含めてコピーしました。");
  });

  // ==========================================
  // タブ切り替え制御
  // ==========================================
  function switchTab(targetTabId) {
    var isDeadline = targetTabId === "tab-calculator";
    var isDuration = targetTabId === "tab-duration";
    var isYearly = targetTabId === "tab-yearly";

    if (tabCalculator) {
      tabCalculator.classList.toggle("is-active", isDeadline);
      tabCalculator.setAttribute("aria-selected", String(isDeadline));
      tabCalculator.setAttribute("tabindex", isDeadline ? "0" : "-1");
    }
    if (tabDuration) {
      tabDuration.classList.toggle("is-active", isDuration);
      tabDuration.setAttribute("aria-selected", String(isDuration));
      tabDuration.setAttribute("tabindex", isDuration ? "0" : "-1");
    }
    if (tabYearly) {
      tabYearly.classList.toggle("is-active", isYearly);
      tabYearly.setAttribute("aria-selected", String(isYearly));
      tabYearly.setAttribute("tabindex", isYearly ? "0" : "-1");
    }

    if (isYearly) {
      if (panelCalculator) panelCalculator.hidden = true;
      if (panelYearly) {
        panelYearly.hidden = false;
        updateYearlyNavButtons();
        renderYearlyView(Number(yearlySelectYear.value || state.currentYear));
      }
    } else {
      if (panelYearly) panelYearly.hidden = true;
      if (panelCalculator) {
        panelCalculator.hidden = false;
        // アクティブなタブに合わせて aria-labelledby を同期（スクリーンリーダー対応）
        panelCalculator.setAttribute("aria-labelledby", isDuration ? "tab-duration" : "tab-calculator");
      }

      var newMode = isDeadline ? "deadline" : "duration";
      state.mode = newMode;
      modeRadios.forEach(function (radio) {
        radio.checked = radio.value === newMode;
      });

      if (newMode === "deadline") {
        if (panelDeadlineCtrl) panelDeadlineCtrl.hidden = false;
        if (panelDurationCtrl) panelDurationCtrl.hidden = true;
        if (modeTip) modeTip.textContent = "カレンダーの日付をクリックして基準日を選択し、日数をボタンでカチカチ変更できます。";
        recalculateDeadline();
      } else {
        if (panelDeadlineCtrl) panelDeadlineCtrl.hidden = true;
        if (panelDurationCtrl) panelDurationCtrl.hidden = false;
        if (modeTip) modeTip.textContent = "カレンダーの日付を2回クリックして、開始日と終了日（期限日）を自由に指定できます。";
        recalculateDuration();
      }
      renderCalendar();
    }
  }

  if (tabCalculator) {
    tabCalculator.addEventListener("click", function () {
      switchTab("tab-calculator");
    });
  }
  if (tabDuration) {
    tabDuration.addEventListener("click", function () {
      switchTab("tab-duration");
    });
  }
  if (tabYearly) {
    tabYearly.addEventListener("click", function () {
      switchTab("tab-yearly");
    });
  }

  var allCalcTabs = [tabCalculator, tabDuration, tabYearly].filter(Boolean);
  allCalcTabs.forEach(function (tabEl, idx) {
    tabEl.addEventListener("keydown", function (e) {
      var nextIdx;
      if (e.key === "Home") {
        nextIdx = 0;
      } else if (e.key === "End") {
        nextIdx = allCalcTabs.length - 1;
      } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        var delta = e.key === "ArrowRight" ? 1 : -1;
        nextIdx = (idx + delta + allCalcTabs.length) % allCalcTabs.length;
      } else {
        return;
      }
      e.preventDefault();
      var nextTab = allCalcTabs[nextIdx];
      if (nextTab) {
        nextTab.focus();
        switchTab(nextTab.id);
      }
    });
  });

  // 年間早見表
  function updateYearlyNavButtons() {
    if (!yearlySelectYear) return;
    var cur = Number(yearlySelectYear.value || state.currentYear);
    if (btnYearlyPrev) btnYearlyPrev.disabled = (cur <= 1955);
    if (btnYearlyNext) btnYearlyNext.disabled = (cur >= 2050);
  }

  function changeYearlyYear(diff) {
    if (!yearlySelectYear) return;
    var cur = Number(yearlySelectYear.value || state.currentYear);
    var target = cur + diff;
    if (target < 1955) target = 1955;
    if (target > 2050) target = 2050;
    if (target === cur) return;
    yearlySelectYear.value = String(target);
    updateYearlyNavButtons();
    renderYearlyView(target);
  }

  yearlySelectYear.addEventListener("change", function () {
    updateYearlyNavButtons();
    renderYearlyView(Number(this.value));
  });

  if (btnYearlyPrev) {
    btnYearlyPrev.addEventListener("click", function () {
      changeYearlyYear(-1);
    });
  }

  if (btnYearlyNext) {
    btnYearlyNext.addEventListener("click", function () {
      changeYearlyYear(1);
    });
  }

  function renderYearlyView(year) {
    if (yearlyCalendarTitle) {
      yearlyCalendarTitle.textContent = year + "年（" + getEraShortName(year) + "）年間カレンダー";
    }

    if (yearlyCalendarGrid) {
      yearlyCalendarGrid.innerHTML = "";
      var dows = ["日", "月", "火", "水", "木", "金", "土"];

      for (var m = 1; m <= 12; m++) {
        var calData = core.getMonthCalendar(year, m, customClosedDays);

        var card = document.createElement("div");
        card.className = "mini-cal-card";

        var title = document.createElement("div");
        title.className = "mini-cal-title";
        title.textContent = m + "月";
        card.appendChild(title);

        var dowRow = document.createElement("div");
        dowRow.className = "mini-cal-dows";
        dows.forEach(function (dow, idx) {
          var s = document.createElement("span");
          s.textContent = dow;
          if (idx === 0) s.className = "mini-dow-sun";
          if (idx === 6) s.className = "mini-dow-sat";
          dowRow.appendChild(s);
        });
        card.appendChild(dowRow);

        var daysGrid = document.createElement("div");
        daysGrid.className = "mini-cal-days";

        calData.days.forEach(function (d) {
          var cell = document.createElement("div");
          cell.className = "mini-day-cell";

          if (!d.isCurrentMonth) {
            cell.classList.add("is-blank");
          } else {
            cell.textContent = d.day;

            if (d.dayOfWeek === 6) {
              cell.classList.add("is-sat");
            }
            if (d.dayOfWeek === 0) {
              cell.classList.add("is-sun");
            }

            if (d.holidayName || (d.closedReason && d.closedReason.indexOf("年末年始") !== -1)) {
              cell.classList.add("is-holiday");
              cell.title = d.holidayName || d.closedReason;
            } else if (d.isCustomClosed) {
              cell.classList.add("is-custom");
              cell.title = d.closedReason || "組織独自閉庁日";
            }
          }
          daysGrid.appendChild(cell);
        });

        card.appendChild(daysGrid);
        yearlyCalendarGrid.appendChild(card);
      }
    }

    var data = core.getYearClosedDays(year, customClosedDays);
    yearlySummaryBox.innerHTML = "<strong>" + year + "年（" + getEraShortName(year) + "）年間集計:</strong>" +
      "<span>年間日数: " + data.totalDays + "日</span> | " +
      "<span>開庁日数: " + data.businessDays + "日</span> | " +
      "<span>特別閉庁日数（祝日・年末年始・独自休庁）: " + data.specialClosedDays.length + "日</span>";

    yearlyTbody.innerHTML = "";
    data.specialClosedDays.forEach(function (d) {
      var tr = document.createElement("tr");
      var td1 = document.createElement("td");
      td1.textContent = d.date;
      var td2 = document.createElement("td");
      td2.textContent = d.weekday;
      var td3 = document.createElement("td");
      td3.textContent = d.japanese;
      var td4 = document.createElement("td");
      td4.textContent = d.reason;
      var td5 = document.createElement("td");
      td5.textContent = d.isWeekend ? "土日と重複" : (d.isCustom ? "組織独自閉庁日" : "国民の祝日等");

      tr.appendChild(td1);
      tr.appendChild(td2);
      tr.appendChild(td3);
      tr.appendChild(td4);
      tr.appendChild(td5);
      yearlyTbody.appendChild(tr);
    });
  }

  // 印刷
  if (btnPrintYearly) {
    btnPrintYearly.addEventListener("click", function () {
      window.print();
    });
  }

  // ==========================================
  // 初回起動
  // ==========================================
  function initHolidayMetaDisplay() {
    var holidayData = window.DeadlineCalcHolidays || window.AppBoxHolidays || null;
    if (!holidayData || !holidayData.meta) return;
    var meta = holidayData.meta;
    var metaText = "祝日データ収録期間: " + meta.startDate + "〜" + meta.endDate + "（データ取得日: " + meta.updated + "）";
    if (calHolidayMetaText) {
      calHolidayMetaText.textContent = metaText;
    }
    if (yearlyHolidayMetaText) {
      yearlyHolidayMetaText.textContent = metaText;
    }
  }

  initYearMonthSelects();
  initHolidayMetaDisplay();
  recalculateDeadline();

})(window, document);
