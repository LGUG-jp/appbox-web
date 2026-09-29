(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    var holidays = require("./holidays.js");
    module.exports = factory(holidays);
  } else {
    var holidays = root.DeadlineCalcHolidays || root.AppBoxHolidays || null;
    var core = factory(holidays);
    root.DeadlineCalcCore = core;
    root.AppBoxDeadlineCore = core;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (holidaysData) {
  "use strict";

  var WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

  var ERAS = [
    { id: "reiwa", name: "令和", letter: "R", base: 2018, start: [2019, 5, 1], end: [9999, 12, 31] },
    { id: "heisei", name: "平成", letter: "H", base: 1988, start: [1989, 1, 8], end: [2019, 4, 30] },
    { id: "showa", name: "昭和", letter: "S", base: 1925, start: [1926, 12, 25], end: [1989, 1, 7] },
    { id: "taisho", name: "大正", letter: "T", base: 1911, start: [1912, 7, 30], end: [1926, 12, 24] },
    { id: "meiji", name: "明治", letter: "M", base: 1867, start: [1873, 1, 1], end: [1912, 7, 29] }
  ];

  function isLeapYear(year) {
    return (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
  }

  function daysInMonth(year, month) {
    if (month === 2) return isLeapYear(year) ? 29 : 28;
    if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
    return 31;
  }

  function padZero(num) {
    return String(num).padStart(2, "0");
  }

  function parseDate(input) {
    if (!input) return null;
    if (typeof input === "object" && input !== null && "year" in input && "month" in input && "day" in input) {
      return { year: Number(input.year), month: Number(input.month), day: Number(input.day) };
    }
    var str = String(input).trim();
    var match = str.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
    if (!match) return null;
    var y = parseInt(match[1], 10);
    var m = parseInt(match[2], 10);
    var d = parseInt(match[3], 10);
    if (m < 1 || m > 12) return null;
    var maxD = daysInMonth(y, m);
    if (d < 1 || d > maxD) return null;
    return { year: y, month: m, day: d };
  }

  function toIsoDate(d) {
    var parsed = parseDate(d);
    if (!parsed) return "";
    return parsed.year + "-" + padZero(parsed.month) + "-" + padZero(parsed.day);
  }

  function toDateObject(d) {
    var parsed = parseDate(d);
    if (!parsed) return null;
    return new Date(parsed.year, parsed.month - 1, parsed.day);
  }

  function getDayOfWeek(d) {
    var obj = toDateObject(d);
    return obj ? obj.getDay() : 0;
  }

  function getWeekdayName(d) {
    return WEEKDAYS[getDayOfWeek(d)];
  }

  function toJapaneseEra(d) {
    var parsed = parseDate(d);
    if (!parsed) return "";
    for (var i = 0; i < ERAS.length; i++) {
      var era = ERAS[i];
      var s = era.start;
      var e = era.end;
      var startVal = s[0] * 10000 + s[1] * 100 + s[2];
      var endVal = e[0] * 10000 + e[1] * 100 + e[2];
      var currentVal = parsed.year * 10000 + parsed.month * 100 + parsed.day;
      if (currentVal >= startVal && currentVal <= endVal) {
        var eraYear = parsed.year - era.base;
        var yearStr = eraYear === 1 ? "元" : String(eraYear);
        return era.name + yearStr + "年" + parsed.month + "月" + parsed.day + "日";
      }
    }
    return parsed.year + "年" + parsed.month + "月" + parsed.day + "日";
  }

  function formatFullDate(d) {
    var parsed = parseDate(d);
    if (!parsed) return "";
    var iso = toIsoDate(parsed);
    var jp = toJapaneseEra(parsed);
    var w = getWeekdayName(parsed);
    return jp + "（" + w + "） / " + iso;
  }

  function compareDates(a, b) {
    var pA = parseDate(a);
    var pB = parseDate(b);
    if (!pA || !pB) throw new Error("不正な日付です。");
    var tA = Date.UTC(pA.year, pA.month - 1, pA.day);
    var tB = Date.UTC(pB.year, pB.month - 1, pB.day);
    return Math.round((tA - tB) / 86400000);
  }

  function addDays(d, n) {
    var parsed = parseDate(d);
    if (!parsed) throw new Error("不正な日付です。");
    var dt = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day + n));
    return {
      year: dt.getUTCFullYear(),
      month: dt.getUTCMonth() + 1,
      day: dt.getUTCDate()
    };
  }

  function addMonths(value, count) {
    var d = parseDate(value);
    if (!d) throw new Error("不正な日付です。");
    if (!Number.isInteger(count)) throw new Error("月数が不正です。");
    var total = d.year * 12 + (d.month - 1) + count;
    var year = Math.floor(total / 12);
    var month = ((total % 12) + 12) % 12 + 1;
    var day = Math.min(d.day, daysInMonth(year, month));
    return { year: year, month: month, day: day };
  }

  function isYearEndNewYear(parsed) {
    var m = parsed.month;
    var d = parsed.day;
    if (m === 12 && d >= 29) return true;
    if (m === 1 && d <= 3) return true;
    return false;
  }

  function getClosedReason(d, customClosedDays) {
    var parsed = parseDate(d);
    if (!parsed) return null;
    var iso = toIsoDate(parsed);

    if (customClosedDays && typeof customClosedDays === "object") {
      var mmdd = padZero(parsed.month) + "-" + padZero(parsed.day);
      if (customClosedDays[iso]) return customClosedDays[iso];
      if (customClosedDays[mmdd]) return customClosedDays[mmdd];
    }

    var hName = holidaysData && holidaysData.isHoliday && holidaysData.isHoliday(iso) ? holidaysData.getHolidayName(iso) : null;

    if (isYearEndNewYear(parsed)) {
      return hName ? (hName + "（年末年始）") : "年末年始の休日（12月29日〜1月3日）";
    }

    if (hName) {
      return hName;
    }

    var dow = getDayOfWeek(parsed);
    if (dow === 0) return "日曜日";
    if (dow === 6) return "土曜日";

    return null;
  }

  function isClosedDay(d, customClosedDays) {
    return getClosedReason(d, customClosedDays) !== null;
  }

  function isOpenDay(d, customClosedDays) {
    return !isClosedDay(d, customClosedDays);
  }

  function getNextOpenDay(d, customClosedDays) {
    var curr = parseDate(d);
    while (true) {
      curr = addDays(curr, 1);
      if (isOpenDay(curr, customClosedDays)) {
        return curr;
      }
    }
  }

  function getPrevOpenDay(d, customClosedDays) {
    var curr = parseDate(d);
    while (true) {
      curr = addDays(curr, -1);
      if (isOpenDay(curr, customClosedDays)) {
        return curr;
      }
    }
  }

  function checkHolidayDataCoverage(d) {
    var parsed = parseDate(d);
    if (!parsed || !holidaysData || !holidaysData.meta) return null;
    var iso = toIsoDate(parsed);
    var start = holidaysData.meta.startDate;
    var end = holidaysData.meta.endDate;
    if (iso < start || iso > end) {
      return "指定日（" + iso + "）は内閣府祝日データの収録範囲外（" + start + "〜" + end + "）のため、祝日判定が正しく行われない可能性があります。";
    }
    return null;
  }

  var MAX_DAYS = 36525; // 約100年

  function validateDayCount(daysInput, maxDays) {
    var limit = maxDays !== undefined ? maxDays : MAX_DAYS;
    var num;
    if (typeof daysInput === "number") {
      num = daysInput;
    } else if (typeof daysInput === "string") {
      var str = daysInput.trim();
      if (!/^\d+$/.test(str)) {
        throw new Error("日数は0以上の整数を入力してください。");
      }
      num = Number(str);
    } else {
      throw new Error("日数は0以上の整数を入力してください。");
    }

    if (!Number.isSafeInteger(num) || num < 0) {
      throw new Error("日数は0以上の整数を入力してください。");
    }
    if (num > limit) {
      throw new Error("日数は0以上" + limit.toLocaleString() + "以下の整数を入力してください。");
    }
    return num;
  }

  function calculateDeadline(baseDateInput, daysInput, options) {
    var base = parseDate(baseDateInput);
    if (!base) throw new Error("有効な基準日を入力してください。");
    var days = validateDayCount(daysInput);

    var opt = options || {};
    var direction = opt.direction === "before" ? "before" : "after";
    var stepDelta = direction === "before" ? -1 : 1;
    var includeFirstDay = Boolean(opt.includeFirstDay);
    var countMode = opt.countMode === "business" ? "business" : "calendar";
    var closedAdjustment = opt.closedAdjustment || "none";
    var customClosedDays = opt.customClosedDays || null;

    var warnings = [];
    var coverageWarn = checkHolidayDataCoverage(base);
    if (coverageWarn) warnings.push(coverageWarn);

    var steps = [];
    var excludedDays = [];
    var current = base;

    var baseReason = getClosedReason(base, customClosedDays);
    steps.push({
      stepType: "base",
      dayNumber: null,
      date: toIsoDate(base),
      weekday: getWeekdayName(base),
      japanese: toJapaneseEra(base),
      isClosed: baseReason !== null,
      closedReason: baseReason,
      note: "基準日" + (includeFirstDay ? "（1日目として算入）" : "（数えない・初日不算入）")
    });

    if (days === 0) {
      var zeroTarget = base;
      var zeroReason = getClosedReason(zeroTarget, customClosedDays);
      var zeroFinal = zeroTarget;
      var zeroShift = 0;
      var zeroApplied = "none";

      if (countMode === "calendar" && zeroReason) {
        if (closedAdjustment === "next") {
          var nDay = getNextOpenDay(zeroTarget, customClosedDays);
          zeroShift = compareDates(nDay, zeroTarget);
          zeroFinal = nDay;
          zeroApplied = "next";
        } else if (closedAdjustment === "prev") {
          var pDay = getPrevOpenDay(zeroTarget, customClosedDays);
          zeroShift = compareDates(pDay, zeroTarget);
          zeroFinal = pDay;
          zeroApplied = "prev";
        }
      }

      return {
        baseDate: toIsoDate(base),
        days: 0,
        direction: direction,
        includeFirstDay: includeFirstDay,
        countMode: countMode,
        closedAdjustment: closedAdjustment,
        rawTargetDate: toIsoDate(zeroTarget),
        rawTargetIsClosed: zeroReason !== null,
        rawTargetClosedReason: zeroReason,
        finalTargetDate: toIsoDate(zeroFinal),
        finalTargetWeekday: getWeekdayName(zeroFinal),
        finalTargetJapanese: toJapaneseEra(zeroFinal),
        adjustmentApplied: zeroApplied,
        adjustmentShiftDays: zeroShift,
        steps: steps,
        excludedDays: excludedDays,
        warnings: warnings
      };
    }

    if (countMode === "calendar") {
      var countedDays = 0;
      if (includeFirstDay) {
        countedDays = 1;
        steps[0].dayNumber = 1;
      }

      while (countedDays < days) {
        current = addDays(current, stepDelta);
        if (current.year > 2099 || current.year < 1900) {
          throw new Error("計算結果が対応範囲（西暦1900年〜西暦2099年）を超えるため計算できません。日数を減らしてください。");
        }
        countedDays++;
        var reason = getClosedReason(current, customClosedDays);
        steps.push({
          stepType: "count",
          dayNumber: countedDays,
          date: toIsoDate(current),
          weekday: getWeekdayName(current),
          japanese: toJapaneseEra(current),
          isClosed: reason !== null,
          closedReason: reason,
          note: direction === "before" ? (countedDays + "日前") : (countedDays + "日目")
        });
      }

      var rawTarget = current;
      var rawReason = getClosedReason(rawTarget, customClosedDays);
      var finalTarget = rawTarget;
      var shiftDays = 0;
      var applied = "none";

      if (rawReason) {
        if (closedAdjustment === "next") {
          applied = "next";
          var walker = rawTarget;
          while (isClosedDay(walker, customClosedDays)) {
            var exReason = getClosedReason(walker, customClosedDays);
            excludedDays.push({
              date: toIsoDate(walker),
              weekday: getWeekdayName(walker),
              reason: exReason,
              action: "翌開庁日へ繰越"
            });
            walker = addDays(walker, 1);
          }
          finalTarget = walker;
          shiftDays = compareDates(finalTarget, rawTarget);
        } else if (closedAdjustment === "prev") {
          applied = "prev";
          var walkerP = rawTarget;
          while (isClosedDay(walkerP, customClosedDays)) {
            var exReasonP = getClosedReason(walkerP, customClosedDays);
            excludedDays.push({
              date: toIsoDate(walkerP),
              weekday: getWeekdayName(walkerP),
              reason: exReasonP,
              action: "前開庁日へ繰上"
            });
            walkerP = addDays(walkerP, -1);
          }
          finalTarget = walkerP;
          shiftDays = compareDates(finalTarget, rawTarget);
        }
      }

      var finalWarn = checkHolidayDataCoverage(finalTarget);
      if (finalWarn && warnings.indexOf(finalWarn) === -1) warnings.push(finalWarn);

      return {
        baseDate: toIsoDate(base),
        days: days,
        direction: direction,
        includeFirstDay: includeFirstDay,
        countMode: countMode,
        closedAdjustment: closedAdjustment,
        rawTargetDate: toIsoDate(rawTarget),
        rawTargetIsClosed: rawReason !== null,
        rawTargetClosedReason: rawReason,
        finalTargetDate: toIsoDate(finalTarget),
        finalTargetWeekday: getWeekdayName(finalTarget),
        finalTargetJapanese: toJapaneseEra(finalTarget),
        adjustmentApplied: applied,
        adjustmentShiftDays: shiftDays,
        steps: steps,
        excludedDays: excludedDays,
        warnings: warnings
      };

    } else {
      var countedBusinessDays = 0;
      var currentStepDate = base;

      if (includeFirstDay) {
        if (isOpenDay(base, customClosedDays)) {
          countedBusinessDays = 1;
          steps[0].dayNumber = 1;
        } else {
          steps[0].note += "（閉庁日のため開庁日数には含みません）";
          excludedDays.push({
            date: toIsoDate(base),
            weekday: getWeekdayName(base),
            reason: baseReason,
            action: "開庁日カウント対象外"
          });
        }
      }

      while (countedBusinessDays < days) {
        currentStepDate = addDays(currentStepDate, stepDelta);
        if (currentStepDate.year > 2099 || currentStepDate.year < 1900) {
          throw new Error("計算結果が対応範囲（西暦1900年〜西暦2099年）を超えるため計算できません。日数を減らしてください。");
        }
        var reasonB = getClosedReason(currentStepDate, customClosedDays);
        if (reasonB === null) {
          countedBusinessDays++;
          steps.push({
            stepType: "count",
            dayNumber: countedBusinessDays,
            date: toIsoDate(currentStepDate),
            weekday: getWeekdayName(currentStepDate),
            japanese: toJapaneseEra(currentStepDate),
            isClosed: false,
            closedReason: null,
            note: direction === "before" ? ("開庁日 " + countedBusinessDays + "日前") : ("開庁日 " + countedBusinessDays + "日目")
          });
        } else {
          excludedDays.push({
            date: toIsoDate(currentStepDate),
            weekday: getWeekdayName(currentStepDate),
            reason: reasonB,
            action: "閉庁日のためスキップ"
          });
          steps.push({
            stepType: "skip",
            dayNumber: null,
            date: toIsoDate(currentStepDate),
            weekday: getWeekdayName(currentStepDate),
            japanese: toJapaneseEra(currentStepDate),
            isClosed: true,
            closedReason: reasonB,
            note: "閉庁日のためスキップ（" + reasonB + "）"
          });
        }
      }

      var bTarget = currentStepDate;
      var bWarn = checkHolidayDataCoverage(bTarget);
      if (bWarn && warnings.indexOf(bWarn) === -1) warnings.push(bWarn);

      return {
        baseDate: toIsoDate(base),
        days: days,
        direction: direction,
        includeFirstDay: includeFirstDay,
        countMode: countMode,
        closedAdjustment: "none",
        rawTargetDate: toIsoDate(bTarget),
        rawTargetIsClosed: false,
        rawTargetClosedReason: null,
        finalTargetDate: toIsoDate(bTarget),
        finalTargetWeekday: getWeekdayName(bTarget),
        finalTargetJapanese: toJapaneseEra(bTarget),
        adjustmentApplied: "none",
        adjustmentShiftDays: 0,
        steps: steps,
        excludedDays: excludedDays,
        warnings: warnings
      };
    }
  }

  function calculateRemainingDays(baseDateInput, deadlineDateInput, options) {
    var base = parseDate(baseDateInput);
    var deadline = parseDate(deadlineDateInput);
    if (!base) throw new Error("有効な基準日を入力してください。");
    if (!deadline) throw new Error("有効な期限日を入力してください。");

    var opt = options || {};
    var includeFirstDay = Boolean(opt.includeFirstDay);
    var customClosedDays = opt.customClosedDays || null;

    var warnings = [];
    var warn1 = checkHolidayDataCoverage(base);
    if (warn1) warnings.push(warn1);
    var warn2 = checkHolidayDataCoverage(deadline);
    if (warn2 && warnings.indexOf(warn2) === -1) warnings.push(warn2);

    var cmp = compareDates(deadline, base);
    var isPast = cmp < 0; // 基準日の方が期限日より未来（期限超過）
    var isToday = cmp === 0;

    var start = isPast ? deadline : base;
    var end = isPast ? base : deadline;
    var rawDiff = Math.abs(cmp); // 片端日数

    var inclusiveDays = rawDiff + 1;
    var effectiveDays = includeFirstDay ? inclusiveDays : rawDiff;

    var businessDays = 0;
    var closedDays = 0;
    var weekendDays = 0;
    var holidayDays = 0;
    var closedList = [];

    if (effectiveDays > 0) {
      var scanStart = includeFirstDay ? start : addDays(start, 1);
      var curr = scanStart;
      while (compareDates(end, curr) >= 0) {
        var reason = getClosedReason(curr, customClosedDays);
        if (reason === null) {
          businessDays++;
        } else {
          closedDays++;
          var dow = getDayOfWeek(curr);
          if (dow === 0 || dow === 6) weekendDays++;
          else holidayDays++;

          closedList.push({
            date: toIsoDate(curr),
            weekday: getWeekdayName(curr),
            japanese: toJapaneseEra(curr),
            reason: reason
          });
        }
        curr = addDays(curr, 1);
      }
    }

    var deadlineReason = getClosedReason(deadline, customClosedDays);
    var isDeadlineClosed = deadlineReason !== null;
    var nextOpen = null;
    var daysToNextOpen = null;
    var businessDaysToNextOpen = null;

    if (isDeadlineClosed && !isPast) {
      var nDay = getNextOpenDay(deadline, customClosedDays);
      nextOpen = {
        date: toIsoDate(nDay),
        weekday: getWeekdayName(nDay),
        japanese: toJapaneseEra(nDay)
      };
      var diffToNext = compareDates(nDay, base);
      daysToNextOpen = includeFirstDay ? diffToNext + 1 : diffToNext;
      businessDaysToNextOpen = businessDays + 1;
    }

    return {
      baseDate: toIsoDate(base),
      baseWeekday: getWeekdayName(base),
      baseJapanese: toJapaneseEra(base),
      deadlineDate: toIsoDate(deadline),
      deadlineWeekday: getWeekdayName(deadline),
      deadlineJapanese: toJapaneseEra(deadline),
      isPast: isPast,
      isToday: isToday,
      totalDays: effectiveDays,
      inclusiveDays: inclusiveDays,
      exclusiveDays: rawDiff,
      businessDays: businessDays,
      closedDays: closedDays,
      weekendDays: weekendDays,
      holidayDays: holidayDays,
      closedList: closedList,
      includeFirstDay: includeFirstDay,
      deadlineIsClosed: isDeadlineClosed,
      deadlineClosedReason: deadlineReason,
      nextOpenDay: nextOpen,
      daysToNextOpen: daysToNextOpen,
      businessDaysToNextOpen: businessDaysToNextOpen,
      warnings: warnings
    };
  }

  function getMonthCalendar(yearInput, monthInput, customClosedDays) {
    var year = Number(yearInput);
    var month = Number(monthInput);
    if (!Number.isInteger(year) || year < 1900 || year > 2099) {
      throw new Error("西暦年は1900年から2099年までの範囲で指定してください。");
    }
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      throw new Error("月は1から12までの範囲で指定してください。");
    }

    var firstDay = { year: year, month: month, day: 1 };
    var totalDaysInMonth = daysInMonth(year, month);
    var startDow = getDayOfWeek(firstDay); // 0=日..6=土
    var days = [];
    var businessDaysCount = 0;
    var closedDaysCount = 0;
    var weekendDaysCount = 0;
    var holidayDaysCount = 0;

    var today = getToday();
    var todayIso = toIsoDate(today);

    // 前月パディング
    if (startDow > 0) {
      var prevMonthDate = addMonths(firstDay, -1);
      var prevMonthDays = daysInMonth(prevMonthDate.year, prevMonthDate.month);
      for (var p = startDow - 1; p >= 0; p--) {
        var pDay = prevMonthDays - p;
        var pObj = { year: prevMonthDate.year, month: prevMonthDate.month, day: pDay };
        var pReason = getClosedReason(pObj, customClosedDays);
        var pIso = toIsoDate(pObj);
        days.push({
          date: pIso,
          year: pObj.year,
          month: pObj.month,
          day: pObj.day,
          dayOfWeek: getDayOfWeek(pObj),
          weekday: getWeekdayName(pObj),
          japanese: toJapaneseEra(pObj),
          isCurrentMonth: false,
          isToday: pIso === todayIso,
          isClosed: pReason !== null,
          closedReason: pReason,
          holidayName: holidaysData && holidaysData.isHoliday && holidaysData.isHoliday(pIso) ? holidaysData.getHolidayName(pIso) : null,
          isCustomClosed: customClosedDays && Boolean(customClosedDays[pIso])
        });
      }
    }

    // 当月の日付
    for (var d = 1; d <= totalDaysInMonth; d++) {
      var dObj = { year: year, month: month, day: d };
      var dIso = toIsoDate(dObj);
      var dReason = getClosedReason(dObj, customClosedDays);
      var dDow = getDayOfWeek(dObj);
      var isClosed = dReason !== null;
      var hName = holidaysData && holidaysData.isHoliday && holidaysData.isHoliday(dIso) ? holidaysData.getHolidayName(dIso) : null;
      var isCustom = customClosedDays && Boolean(customClosedDays[dIso]);

      if (isClosed) {
        closedDaysCount++;
        if (dDow === 0 || dDow === 6) {
          weekendDaysCount++;
        } else {
          holidayDaysCount++;
        }
      } else {
        businessDaysCount++;
      }

      days.push({
        date: dIso,
        year: year,
        month: month,
        day: d,
        dayOfWeek: dDow,
        weekday: getWeekdayName(dObj),
        japanese: toJapaneseEra(dObj),
        isCurrentMonth: true,
        isToday: dIso === todayIso,
        isClosed: isClosed,
        closedReason: dReason,
        holidayName: hName,
        isCustomClosed: isCustom
      });
    }

    // 翌月パディング（7の倍数になるまで）
    var remaining = (7 - (days.length % 7)) % 7;
    if (remaining > 0) {
      var nextMonthDate = addMonths(firstDay, 1);
      for (var n = 1; n <= remaining; n++) {
        var nObj = { year: nextMonthDate.year, month: nextMonthDate.month, day: n };
        var nIso = toIsoDate(nObj);
        var nReason = getClosedReason(nObj, customClosedDays);
        days.push({
          date: nIso,
          year: nObj.year,
          month: nObj.month,
          day: n,
          dayOfWeek: getDayOfWeek(nObj),
          weekday: getWeekdayName(nObj),
          japanese: toJapaneseEra(nObj),
          isCurrentMonth: false,
          isToday: nIso === todayIso,
          isClosed: nReason !== null,
          closedReason: nReason,
          holidayName: holidaysData && holidaysData.isHoliday && holidaysData.isHoliday(nIso) ? holidaysData.getHolidayName(nIso) : null,
          isCustomClosed: customClosedDays && Boolean(customClosedDays[nIso])
        });
      }
    }

    var warnings = [];
    var warnMonth = checkHolidayDataCoverage(firstDay);
    if (warnMonth) warnings.push(warnMonth);

    return {
      year: year,
      month: month,
      totalDays: totalDaysInMonth,
      businessDays: businessDaysCount,
      closedDays: closedDaysCount,
      weekendDays: weekendDaysCount,
      holidayDays: holidayDaysCount,
      days: days,
      warnings: warnings
    };
  }

  function getYearClosedDays(yearInput, customClosedDays) {
    var year = Number(yearInput);
    if (!Number.isInteger(year) || year < 1900 || year > 2099) {
      throw new Error("西暦年は1900年から2099年までの範囲で指定してください。");
    }

    var isLeap = isLeapYear(year);
    var totalYearDays = isLeap ? 366 : 365;
    var specialDays = [];
    var businessDaysCount = 0;
    var weekendDaysCount = 0;

    for (var m = 1; m <= 12; m++) {
      var dim = daysInMonth(year, m);
      for (var d = 1; d <= dim; d++) {
        var dObj = { year: year, month: m, day: d };
        var dIso = toIsoDate(dObj);
        var dow = getDayOfWeek(dObj);
        var reason = getClosedReason(dObj, customClosedDays);

        if (reason === null) {
          businessDaysCount++;
        } else {
          if (dow === 0 || dow === 6) {
            weekendDaysCount++;
            if (isYearEndNewYear(dObj) || (holidaysData && holidaysData.isHoliday && holidaysData.isHoliday(dIso)) || (customClosedDays && customClosedDays[dIso])) {
              specialDays.push({
                date: dIso,
                weekday: getWeekdayName(dObj),
                japanese: toJapaneseEra(dObj),
                reason: reason,
                isWeekend: true,
                isHoliday: Boolean(holidaysData && holidaysData.isHoliday && holidaysData.isHoliday(dIso)),
                isCustom: Boolean(customClosedDays && customClosedDays[dIso])
              });
            }
          } else {
            specialDays.push({
              date: dIso,
              weekday: getWeekdayName(dObj),
              japanese: toJapaneseEra(dObj),
              reason: reason,
              isWeekend: false,
              isHoliday: Boolean(holidaysData && holidaysData.isHoliday && holidaysData.isHoliday(dIso)),
              isCustom: Boolean(customClosedDays && customClosedDays[dIso])
            });
          }
        }
      }
    }

    var warnings = [];
    var warnYear = checkHolidayDataCoverage({ year: year, month: 1, day: 1 });
    if (warnYear) warnings.push(warnYear);

    return {
      year: year,
      totalDays: totalYearDays,
      businessDays: businessDaysCount,
      closedDays: totalYearDays - businessDaysCount,
      weekendDays: weekendDaysCount,
      specialClosedDays: specialDays,
      warnings: warnings
    };
  }

  function calculateOffset(baseDateInput, daysInput, direction) {
    var base = parseDate(baseDateInput);
    if (!base) throw new Error("有効な基準日を入力してください。");
    var days = validateDayCount(daysInput);

    var dir = direction === "before" ? -1 : 1;
    var target = addDays(base, days * dir);
    var reason = getClosedReason(target);

    var warnings = [];
    var warn1 = checkHolidayDataCoverage(base);
    if (warn1) warnings.push(warn1);
    var warn2 = checkHolidayDataCoverage(target);
    if (warn2 && warnings.indexOf(warn2) === -1) warnings.push(warn2);

    return {
      baseDate: toIsoDate(base),
      days: days,
      direction: direction === "before" ? "before" : "after",
      targetDate: toIsoDate(target),
      targetWeekday: getWeekdayName(target),
      targetJapanese: toJapaneseEra(target),
      isClosed: reason !== null,
      closedReason: reason,
      warnings: warnings
    };
  }

  function calculateDuration(startDateInput, endDateInput, customClosedDays) {
    var start = parseDate(startDateInput);
    var end = parseDate(endDateInput);
    if (!start) throw new Error("有効な開始日を入力してください。");
    if (!end) throw new Error("有効な終了日を入力してください。");

    var totalDays = compareDates(end, start);
    if (totalDays < 0) throw new Error("終了日は開始日以降の日付を指定してください。");

    var warnings = [];
    var warn1 = checkHolidayDataCoverage(start);
    if (warn1) warnings.push(warn1);
    var warn2 = checkHolidayDataCoverage(end);
    if (warn2 && warnings.indexOf(warn2) === -1) warnings.push(warn2);

    var businessDaysExclusive = 0;
    var businessDaysInclusive = 0;
    var excludedDays = [];

    var curr = start;
    for (var i = 0; i <= totalDays; i++) {
      var isClosed = isClosedDay(curr, customClosedDays);
      var reason = getClosedReason(curr, customClosedDays);

      if (!isClosed) {
        businessDaysInclusive++;
        if (i > 0) businessDaysExclusive++;
      } else {
        excludedDays.push({
          date: toIsoDate(curr),
          weekday: getWeekdayName(curr),
          reason: reason
        });
      }
      if (i < totalDays) {
        curr = addDays(curr, 1);
      }
    }

    var months = (end.year - start.year) * 12 + end.month - start.month;
    if (compareDates(addMonths(start, months), end) > 0) months--;
    var anchor = addMonths(start, months);
    var remainingDays = compareDates(end, anchor);
    var approximateYears = Math.floor(months / 12);
    var approximateMonths = months % 12;

    return {
      startDate: toIsoDate(start),
      endDate: toIsoDate(end),
      totalDays: totalDays,
      inclusiveDays: totalDays + 1,
      businessDaysExclusive: businessDaysExclusive,
      businessDaysInclusive: businessDaysInclusive,
      excludedDaysCount: excludedDays.length,
      excludedDays: excludedDays,
      approximate: {
        years: approximateYears,
        months: approximateMonths,
        days: remainingDays
      },
      warnings: warnings
    };
  }

  function checkOpenDay(targetDateInput, customClosedDays) {
    var target = parseDate(targetDateInput);
    if (!target) throw new Error("有効な日付を入力してください。");

    var reason = getClosedReason(target, customClosedDays);
    var isClosed = reason !== null;

    var prevOpen = null;
    var nextOpen = null;

    if (isClosed) {
      var p = getPrevOpenDay(target, customClosedDays);
      var n = getNextOpenDay(target, customClosedDays);
      prevOpen = {
        date: toIsoDate(p),
        weekday: getWeekdayName(p),
        japanese: toJapaneseEra(p),
        diffDays: compareDates(target, p)
      };
      nextOpen = {
        date: toIsoDate(n),
        weekday: getWeekdayName(n),
        japanese: toJapaneseEra(n),
        diffDays: compareDates(n, target)
      };
    }

    var warnings = [];
    var warn = checkHolidayDataCoverage(target);
    if (warn) warnings.push(warn);

    return {
      targetDate: toIsoDate(target),
      weekday: getWeekdayName(target),
      japanese: toJapaneseEra(target),
      isClosed: isClosed,
      closedReason: reason,
      prevOpenDay: prevOpen,
      nextOpenDay: nextOpen,
      warnings: warnings
    };
  }

  function getToday() {
    var now = new Date();
    return {
      year: now.getFullYear(),
      month: now.getMonth() + 1,
      day: now.getDate()
    };
  }

  function getMonthEnd(d) {
    var parsed = parseDate(d) || getToday();
    return {
      year: parsed.year,
      month: parsed.month,
      day: daysInMonth(parsed.year, parsed.month)
    };
  }

  function getYearEnd(d) {
    var parsed = parseDate(d) || getToday();
    return {
      year: parsed.year,
      month: 12,
      day: 31
    };
  }

  function getFiscalYearEnd(d) {
    var parsed = parseDate(d) || getToday();
    var fyEndYear = parsed.month < 4 ? parsed.year : parsed.year + 1;
    return {
      year: fyEndYear,
      month: 3,
      day: 31
    };
  }

  return Object.freeze({
    parseDate: parseDate,
    toIsoDate: toIsoDate,
    formatFullDate: formatFullDate,
    toJapaneseEra: toJapaneseEra,
    getWeekdayName: getWeekdayName,
    compareDates: compareDates,
    addDays: addDays,
    addMonths: addMonths,
    isLeapYear: isLeapYear,
    daysInMonth: daysInMonth,
    getClosedReason: getClosedReason,
    isClosedDay: isClosedDay,
    isOpenDay: isOpenDay,
    getNextOpenDay: getNextOpenDay,
    getPrevOpenDay: getPrevOpenDay,
    calculateDeadline: calculateDeadline,
    calculateRemainingDays: calculateRemainingDays,
    calculateOffset: calculateOffset,
    calculateDuration: calculateDuration,
    checkOpenDay: checkOpenDay,
    getMonthCalendar: getMonthCalendar,
    getYearClosedDays: getYearClosedDays,
    getToday: getToday,
    getMonthEnd: getMonthEnd,
    getYearEnd: getYearEnd,
    getFiscalYearEnd: getFiscalYearEnd
  });
});
