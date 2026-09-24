(() => {
  "use strict";

  const $ = id => document.getElementById(id);

  const oldText = $("oldText");
  const newText = $("newText");
  const oldCount = $("oldCount");
  const newCount = $("newCount");
  const mode = $("diffMode");
  const modeInputs = Array.from(
    document.querySelectorAll(
      'input[name="diffMode"]'
    )
  );
  const modeNote = $("modeNote");

  const optNormalizeSpace = $("optNormalizeSpace");
  const optNormalizeWidth = $("optNormalizeWidth");
  const optNormalizeBlankLines = $("optNormalizeBlankLines");
  const optShowInvisible = $("optShowInvisible");
  const optSyncScroll = $("optSyncScroll");

  const compareBtn = $("compareBtn");
  const swapBtn = $("swapBtn");
  const clearBtn = $("clearBtn");
  const sampleBtn = $("sampleBtn");
  const copyBtn = $("copyBtn");
  const printBtn = $("printBtn");
  const wordCopyBtn = $("wordCopyBtn");
  const wordCopyPreviewBtn = $("wordCopyPreviewBtn");
  const wordCopyStatus = $("wordCopyStatus");
  const wordCopyDialog = $("wordCopyDialog");
  const wordCopyPreview = $("wordCopyPreview");
  const wordCopyDialogNote = $("wordCopyDialogNote");
  const wordCopySelectBtn = $("wordCopySelectBtn");
  const wordCopyCloseBtn = $("wordCopyCloseBtn");

  const status = $("status");
  const resultsPanel = $("resultsPanel");
  const resultsTitle = $("resultsTitle");
  const resultNote = $("resultNote");
  const resultCondition = $("resultCondition");

  const statAdded = $("statAdded");
  const statDeleted = $("statDeleted");
  const statEqual = $("statEqual");
  const statChanges = $("statChanges");
  const statSimilarity = $("statSimilarity");
  const unitAdded = $("unitAdded");
  const unitDeleted = $("unitDeleted");
  const unitEqual = $("unitEqual");

  const invisibleLegend = $("invisibleLegend");
  const noDiff = $("noDiff");
  const diffArea = $("diffArea");

  const oldResult = $("oldResult");
  const newResult = $("newResult");
  const unifiedResult = $("unifiedResult");

  const diffNavigation = $("diffNavigation");
  const previousDiffBtn = $("previousDiffBtn");
  const nextDiffBtn = $("nextDiffBtn");
  const diffPosition = $("diffPosition");

  const MAX_CHAR_TOTAL = 30000;
  const MAX_LINE_TOTAL = 10000;
  const MAX_MYERS_D = 1200;
  const MAX_DIFF_MILLISECONDS = 1500;
  const MAX_RENDER_SEGMENTS = 20000;
  const TIME_CHECK_INTERVAL_MASK = 4095;

  /*
   * 行対応処理の安全上限です。
   * 大きな変更ブロックは、誤対応と処理時間増大を避けるため、
   * 行内文字比較を行わず行全体の削除・追加として扱います。
   */
  const MAX_PAIRING_BLOCK_LINES = 80;
  const MAX_PAIRING_MATRIX_CELLS = 1600;

  /*
   * 行ペアとして採用する最低類似度です。
   * 1対1の変更は、空行でない限り少し低い基準を使用します。
   */
  const MIN_LINE_SIMILARITY = 0.38;
  const MIN_SINGLE_PAIR_SIMILARITY = 0.18;

  let lastDiff = [];
  let lastMode = "line-char";
  let lastOptions = null;
  let lastUnitName = "文字";
  let hasComparisonResult = false;
  // 再比較の失敗後も設定変更で復帰できるよう、同じ入力の比較履歴を保持します。
  let hasComparedCurrentInput = false;

  let compareVersion = 0;
  let isComparing = false;
  let isSyncingScroll = false;
  let isCopyingWord = false;

  let changeGroups = [];
  let currentChangeIndex = -1;

  class DiffLimitError extends Error {
    constructor(code) {
      super(code);
      this.name = "DiffLimitError";
      this.code = code;
    }
  }

  function normalizeNewlines(value) {
    return String(value)
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n");
  }

  function normalizeText(value, options) {
    let normalized = normalizeNewlines(value);

    if (options.normalizeWidth) {
      normalized = normalized.replace(
        /[！-～]/g,
        character =>
          String.fromCharCode(
            character.charCodeAt(0) - 0xfee0
          )
      );
    }

    if (options.normalizeSpace) {
      normalized = normalized.replace(
        /[ \t\u3000]+/g,
        " "
      );
    }

    if (options.normalizeBlankLines) {
      normalized = normalized.replace(
        /\n{2,}/g,
        "\n"
      );
    }

    return normalized;
  }

  function getOptions() {
    return {
      normalizeSpace: optNormalizeSpace.checked,
      normalizeWidth: optNormalizeWidth.checked,
      normalizeBlankLines:
        optNormalizeBlankLines.checked,
      showInvisible: optShowInvisible.checked
    };
  }

  function getSelectedMode() {
    const selected = modeInputs.find(
      input => input.checked
    );

    return selected
      ? selected.value
      : "line-char";
  }

  function setSelectedMode(value) {
    modeInputs.forEach(input => {
      input.checked =
        input.value === value;
    });
  }

  function isNormalizationEnabled(options) {
    return Boolean(
      options.normalizeSpace ||
      options.normalizeWidth ||
      options.normalizeBlankLines
    );
  }

  function toCodePoints(value) {
    return Array.from(value);
  }

  /*
   * 行末の改行を行トークンに含めます。
   * これにより、末尾改行の有無も差分として保持できます。
   */
  function splitLinesKeepEnds(value) {
    if (value === "") {
      return [];
    }

    const lines = [];
    let start = 0;

    for (let index = 0; index < value.length; index++) {
      if (value[index] === "\n") {
        lines.push(value.slice(start, index + 1));
        start = index + 1;
      }
    }

    if (start < value.length) {
      lines.push(value.slice(start));
    }

    return lines;
  }

  function tokenizeNormalized(normalized, selectedMode) {
    return selectedMode === "line"
      ? splitLinesKeepEnds(normalized)
      : toCodePoints(normalized);
  }

  function updateCounts() {
    oldCount.textContent =
      toCodePoints(
        normalizeNewlines(oldText.value)
      ).length.toLocaleString("ja-JP") +
      "文字";

    newCount.textContent =
      toCodePoints(
        normalizeNewlines(newText.value)
      ).length.toLocaleString("ja-JP") +
      "文字";
  }

  function setStatus(message, type = "") {
    status.textContent = message;
    status.className = "status";

    if (type) {
      status.classList.add(type);
    }
  }

  function setComparingState(comparing) {
    isComparing = comparing;
    compareBtn.disabled = comparing;
    swapBtn.disabled = comparing;
    clearBtn.disabled = comparing;
    sampleBtn.disabled = comparing;
    mode.disabled = comparing;

    optNormalizeSpace.disabled = comparing;
    optNormalizeWidth.disabled = comparing;
    optNormalizeBlankLines.disabled = comparing;

    copyBtn.disabled = comparing || !hasComparisonResult;
    printBtn.disabled = comparing || !hasComparisonResult;
    setWordCopyEnabled(!comparing && hasComparisonResult);

    if (comparing) {
      clearWordCopyPreview();
    }

    resultsPanel.setAttribute(
      "aria-busy",
      comparing ? "true" : "false"
    );
  }

  function clearRenderedResults() {
    oldResult.replaceChildren();
    newResult.replaceChildren();
    unifiedResult.replaceChildren();
    clearWordCopyPreview();

    statAdded.textContent = "0";
    statDeleted.textContent = "0";
    statEqual.textContent = "0";
    statChanges.textContent = "0";
    statSimilarity.textContent = "100%";

    changeGroups = [];
    currentChangeIndex = -1;

    diffNavigation.hidden = true;
    diffPosition.textContent = "差分 0 / 0";
    noDiff.hidden = true;
    diffArea.hidden = false;
  }

  function invalidateResults() {
    compareVersion++;
    hasComparisonResult = false;
    hasComparedCurrentInput = false;
    lastDiff = [];
    lastOptions = null;

    copyBtn.disabled = true;
    setWordCopyEnabled(false);
    printBtn.disabled = true;
    resultsPanel.hidden = true;

    clearRenderedResults();

    if (isComparing) {
      setComparingState(false);
    }

    if (!isComparing) {
      setStatus(
        "入力または比較条件が変更されました。差分を再比較してください。"
      );
    }
  }

  function updateModeNote() {
    const selectedMode =
      getSelectedMode();

    if (selectedMode === "line-char") {
      modeNote.textContent =
        "「行内文字単位」は、まず行を対応付け、対応した行の内部だけを文字単位で比較します。同じ文字列が複数行にある場合の行をまたいだ差分位置のずれを抑えます。";
      return;
    }

    if (selectedMode === "char") {
      modeNote.textContent =
        "「全文文字単位」は、改行を含む文章全体を1つの文字列として比較します。繰り返し文字や同一行がある場合、差分位置が別の行へ移ることがあります。";
      return;
    }

    modeNote.textContent =
      "「行単位」は、行全体の追加・削除を確認するための比較です。行内の細かな文字変更は表示しません。";
  }

  function ensureWithinTime(startedAt, operationCount) {
    if (
      (
        operationCount &
        TIME_CHECK_INTERVAL_MASK
      ) === 0 &&
      performance.now() - startedAt >
        MAX_DIFF_MILLISECONDS
    ) {
      throw new DiffLimitError("TIME_LIMIT");
    }
  }

  function makeEdit(type, value, count = 1) {
    return {
      type,
      value,
      count
    };
  }

  /*
   * 共通する先頭・末尾を固定してからMyers法を適用します。
   */
  function diffTokens(oldTokens, newTokens, context) {
    let prefixLength = 0;

    while (
      prefixLength < oldTokens.length &&
      prefixLength < newTokens.length &&
      oldTokens[prefixLength] === newTokens[prefixLength]
    ) {
      prefixLength++;
      context.operations++;
      ensureWithinTime(
        context.startedAt,
        context.operations
      );
    }

    let suffixLength = 0;

    while (
      suffixLength <
        oldTokens.length - prefixLength &&
      suffixLength <
        newTokens.length - prefixLength &&
      oldTokens[
        oldTokens.length - 1 - suffixLength
      ] ===
        newTokens[
          newTokens.length - 1 - suffixLength
        ]
    ) {
      suffixLength++;
      context.operations++;
      ensureWithinTime(
        context.startedAt,
        context.operations
      );
    }

    const result = [];

    for (
      let index = 0;
      index < prefixLength;
      index++
    ) {
      result.push(
        makeEdit(
          "equal",
          oldTokens[index]
        )
      );
    }

    const oldMiddle = oldTokens.slice(
      prefixLength,
      oldTokens.length - suffixLength
    );

    const newMiddle = newTokens.slice(
      prefixLength,
      newTokens.length - suffixLength
    );

    if (
      oldMiddle.length > 0 ||
      newMiddle.length > 0
    ) {
      result.push(
        ...myersDiff(
          oldMiddle,
          newMiddle,
          context
        )
      );
    }

    for (
      let index =
        oldTokens.length - suffixLength;
      index < oldTokens.length;
      index++
    ) {
      result.push(
        makeEdit(
          "equal",
          oldTokens[index]
        )
      );
    }

    return result;
  }

  function myersDiff(a, b, context) {
    const oldLength = a.length;
    const newLength = b.length;

    if (oldLength === 0) {
      return b.map(value =>
        makeEdit("insert", value)
      );
    }

    if (newLength === 0) {
      return a.map(value =>
        makeEdit("delete", value)
      );
    }

    const maximumDistance =
      oldLength + newLength;

    if (maximumDistance > MAX_MYERS_D * 2) {
      /*
       * 探索深度が上限以内なら処理可能なので、
       * 長さだけでは直ちに中止しません。
       */
    }

    const size = maximumDistance * 2 + 5;
    const offset = maximumDistance + 2;
    const v = new Int32Array(size);
    const trace = [];

    v.fill(-1);
    v[offset + 1] = 0;

    const distanceLimit = Math.min(
      maximumDistance,
      MAX_MYERS_D
    );

    for (
      let distance = 0;
      distance <= distanceLimit;
      distance++
    ) {
      const snapshot = new Int32Array(v);
      trace.push(snapshot);

      for (
        let diagonal = -distance;
        diagonal <= distance;
        diagonal += 2
      ) {
        context.operations++;
        ensureWithinTime(
          context.startedAt,
          context.operations
        );

        const diagonalIndex =
          offset + diagonal;

        let x;

        if (
          diagonal === -distance ||
          (
            diagonal !== distance &&
            v[diagonalIndex - 1] <
              v[diagonalIndex + 1]
          )
        ) {
          x = v[diagonalIndex + 1];
        } else {
          x = v[diagonalIndex - 1] + 1;
        }

        if (x < 0) {
          x = 0;
        }

        let y = x - diagonal;

        while (
          x < oldLength &&
          y < newLength &&
          y >= 0 &&
          a[x] === b[y]
        ) {
          x++;
          y++;

          context.operations++;
          ensureWithinTime(
            context.startedAt,
            context.operations
          );
        }

        v[diagonalIndex] = x;

        if (
          x >= oldLength &&
          y >= newLength
        ) {
          return backtrack(
            trace,
            a,
            b,
            distance,
            offset
          );
        }
      }
    }

    throw new DiffLimitError("DISTANCE_LIMIT");
  }

  function backtrack(
    trace,
    oldTokens,
    newTokens,
    maximumDistance,
    offset
  ) {
    let x = oldTokens.length;
    let y = newTokens.length;
    const edits = [];

    for (
      let distance = maximumDistance;
      distance > 0;
      distance--
    ) {
      const previousV = trace[distance];
      const diagonal = x - y;

      let previousDiagonal;

      if (
        diagonal === -distance ||
        (
          diagonal !== distance &&
          previousV[
            offset + diagonal - 1
          ] <
            previousV[
              offset + diagonal + 1
            ]
        )
      ) {
        previousDiagonal = diagonal + 1;
      } else {
        previousDiagonal = diagonal - 1;
      }

      let previousX =
        previousV[
          offset + previousDiagonal
        ];

      if (previousX < 0) {
        previousX = 0;
      }

      const previousY =
        previousX - previousDiagonal;

      while (
        x > previousX &&
        y > previousY
      ) {
        edits.push(
          makeEdit(
            "equal",
            oldTokens[x - 1]
          )
        );
        x--;
        y--;
      }

      if (x === previousX) {
        edits.push(
          makeEdit(
            "insert",
            newTokens[y - 1]
          )
        );
        y--;
      } else {
        edits.push(
          makeEdit(
            "delete",
            oldTokens[x - 1]
          )
        );
        x--;
      }
    }

    while (x > 0 && y > 0) {
      edits.push(
        makeEdit(
          "equal",
          oldTokens[x - 1]
        )
      );
      x--;
      y--;
    }

    while (x > 0) {
      edits.push(
        makeEdit(
          "delete",
          oldTokens[x - 1]
        )
      );
      x--;
    }

    while (y > 0) {
      edits.push(
        makeEdit(
          "insert",
          newTokens[y - 1]
        )
      );
      y--;
    }

    edits.reverse();
    return edits;
  }



  function compactDiff(edits) {
    const compacted = [];

    for (const edit of edits) {
      if (
        edit.value === "" ||
        edit.value === undefined
      ) {
        continue;
      }

      const previous =
        compacted[compacted.length - 1];

      if (
        previous &&
        previous.type === edit.type &&
        previous.group === edit.group
      ) {
        previous.value += edit.value;
        previous.count +=
          edit.count === undefined
            ? 1
            : edit.count;
      } else {
        compacted.push({
          type: edit.type,
          value: edit.value,
          count:
            edit.count === undefined
              ? 1
              : edit.count,
          group: edit.group
        });
      }

      if (
        compacted.length >
        MAX_RENDER_SEGMENTS
      ) {
        throw new DiffLimitError(
          "RENDER_LIMIT"
        );
      }
    }

    return compacted;
  }

  function assignChangeGroups(compacted) {
    let groupIndex = -1;
    let insideChange = false;

    for (const segment of compacted) {
      if (segment.type === "equal") {
        segment.group = null;
        insideChange = false;
        continue;
      }

      if (!insideChange) {
        groupIndex++;
        insideChange = true;
      }

      segment.group = groupIndex;
    }

    return compacted;
  }

  function stripLineEnding(value) {
    return value.endsWith("\n")
      ? value.slice(0, -1)
      : value;
  }

  function hasLineEnding(value) {
    return value.endsWith("\n");
  }

  function commonPrefixLength(a, b) {
    const oldCharacters = toCodePoints(a);
    const newCharacters = toCodePoints(b);
    const length = Math.min(
      oldCharacters.length,
      newCharacters.length
    );

    let count = 0;

    while (
      count < length &&
      oldCharacters[count] ===
        newCharacters[count]
    ) {
      count++;
    }

    return count;
  }

  function commonSuffixLength(a, b) {
    const oldCharacters = toCodePoints(a);
    const newCharacters = toCodePoints(b);
    const length = Math.min(
      oldCharacters.length,
      newCharacters.length
    );

    let count = 0;

    while (
      count < length &&
      oldCharacters[
        oldCharacters.length - 1 - count
      ] ===
        newCharacters[
          newCharacters.length - 1 - count
        ]
    ) {
      count++;
    }

    return count;
  }

  function characterHistogram(value) {
    const histogram = new Map();

    for (const character of toCodePoints(value)) {
      histogram.set(
        character,
        (histogram.get(character) || 0) + 1
      );
    }

    return histogram;
  }

  /*
   * 文字順序だけに依存すると繰り返し文字で偏るため、
   * 文字頻度、共通接頭辞、共通接尾辞、長さを組み合わせます。
   */
  function lineSimilarity(oldLine, newLine) {
    const oldBody = stripLineEnding(oldLine);
    const newBody = stripLineEnding(newLine);

    if (oldBody === newBody) {
      return 1;
    }

    const oldCharacters = toCodePoints(oldBody);
    const newCharacters = toCodePoints(newBody);
    const maximumLength = Math.max(
      oldCharacters.length,
      newCharacters.length
    );

    if (maximumLength === 0) {
      return 1;
    }

    if (
      oldCharacters.length === 0 ||
      newCharacters.length === 0
    ) {
      return 0;
    }

    const oldHistogram =
      characterHistogram(oldBody);
    const newHistogram =
      characterHistogram(newBody);

    let overlap = 0;

    for (
      const [character, count]
      of oldHistogram
    ) {
      overlap += Math.min(
        count,
        newHistogram.get(character) || 0
      );
    }

    const bagScore =
      overlap / maximumLength;

    const prefixScore =
      commonPrefixLength(
        oldBody,
        newBody
      ) / maximumLength;

    const suffixScore =
      commonSuffixLength(
        oldBody,
        newBody
      ) / maximumLength;

    const lengthScore =
      Math.min(
        oldCharacters.length,
        newCharacters.length
      ) / maximumLength;

    return (
      bagScore * 0.55 +
      prefixScore * 0.2 +
      suffixScore * 0.15 +
      lengthScore * 0.1
    );
  }

  function extractChangedBlocks(lineDiff) {
    const blocks = [];
    let block = null;

    for (const edit of lineDiff) {
      if (edit.type === "equal") {
        if (block) {
          blocks.push(block);
          block = null;
        }

        blocks.push({
          equal: true,
          value: edit.value
        });

        continue;
      }

      if (!block) {
        block = {
          equal: false,
          oldLines: [],
          newLines: []
        };
      }

      if (edit.type === "delete") {
        block.oldLines.push(edit.value);
      } else {
        block.newLines.push(edit.value);
      }
    }

    if (block) {
      blocks.push(block);
    }

    return blocks;
  }

  /*
   * 順序を保つ動的計画法で行を対応付けます。
   * 類似度が低い行を無理にペア化しないよう、
   * ペア化しない選択にも小さなスコアを与えます。
   */
  function pairChangedLines(
    oldLines,
    newLines,
    context
  ) {
    const oldLength = oldLines.length;
    const newLength = newLines.length;

    if (
      oldLength === 0 ||
      newLength === 0
    ) {
      return [];
    }

    /*
    * 削除行数と追加行数が同じ変更ブロックは、
    * 行順を最優先して同じ位置同士を対応させます。
    *
    * これにより、旧側に同一行が連続している場合でも、
    * 12345 → 12335
    * 12345 → 12445
    * のような変更を別の行へ吸着させません。
    */
    if (oldLength === newLength) {
      const pairs = [];

      for (
        let index = 0;
        index < oldLength;
        index++
      ) {
        context.operations++;
        ensureWithinTime(
          context.startedAt,
          context.operations
        );

        pairs.push({
          oldIndex: index,
          newIndex: index,
          similarity: lineSimilarity(
            oldLines[index],
            newLines[index]
          )
        });
      }

      return pairs;
    }

    /*
    * 大きな変更ブロックは、誤対応や長時間処理を避けるため、
    * 行内対応を行いません。
    */
    if (
      oldLength > MAX_PAIRING_BLOCK_LINES ||
      newLength > MAX_PAIRING_BLOCK_LINES ||
      oldLength * newLength >
        MAX_PAIRING_MATRIX_CELLS
    ) {
      return [];
    }

    if (
      oldLength === 1 &&
      newLength === 1
    ) {
      const similarity = lineSimilarity(
        oldLines[0],
        newLines[0]
      );

      const oldBody =
        stripLineEnding(oldLines[0]);
      const newBody =
        stripLineEnding(newLines[0]);

      if (
        (
          oldBody.length === 0 ||
          newBody.length === 0
        ) &&
        oldBody !== newBody
      ) {
        return [];
      }

      return similarity >=
        MIN_SINGLE_PAIR_SIMILARITY
        ? [{
            oldIndex: 0,
            newIndex: 0,
            similarity
          }]
        : [];
    }

    /*
    * 行数が異なる変更ブロックでは、
    * 順序を保つ動的計画法で対応行を決定します。
    */
    const columns = newLength + 1;

    const scores = new Float64Array(
      (oldLength + 1) * columns
    );

    const decisions = new Uint8Array(
      (oldLength + 1) * columns
    );

    const skipPenalty = 0.06;

    for (
      let oldIndex = 1;
      oldIndex <= oldLength;
      oldIndex++
    ) {
      const matrixIndex =
        oldIndex * columns;

      scores[matrixIndex] =
        scores[
          (oldIndex - 1) * columns
        ] - skipPenalty;

      decisions[matrixIndex] = 1;
    }

    for (
      let newIndex = 1;
      newIndex <= newLength;
      newIndex++
    ) {
      scores[newIndex] =
        scores[newIndex - 1] -
        skipPenalty;

      decisions[newIndex] = 2;
    }

    for (
      let oldIndex = 1;
      oldIndex <= oldLength;
      oldIndex++
    ) {
      for (
        let newIndex = 1;
        newIndex <= newLength;
        newIndex++
      ) {
        context.operations++;
        ensureWithinTime(
          context.startedAt,
          context.operations
        );

        const matrixIndex =
          oldIndex * columns +
          newIndex;

        const similarity = lineSimilarity(
          oldLines[oldIndex - 1],
          newLines[newIndex - 1]
        );

        const oldPosition =
          (oldIndex - 1) /
          Math.max(1, oldLength - 1);

        const newPosition =
          (newIndex - 1) /
          Math.max(1, newLength - 1);

        const positionDistance =
          Math.abs(
            oldPosition - newPosition
          );

        const positionBonus =
          (1 - positionDistance) * 0.12;

        const pairScore =
          similarity >= MIN_LINE_SIMILARITY
            ? scores[
                (oldIndex - 1) *
                  columns +
                newIndex - 1
              ] +
              similarity +
              positionBonus
            : Number.NEGATIVE_INFINITY;

        const skipOldScore =
          scores[
            (oldIndex - 1) *
              columns +
            newIndex
          ] - skipPenalty;

        const skipNewScore =
          scores[
            oldIndex * columns +
            newIndex - 1
          ] - skipPenalty;

        if (
          pairScore >= skipOldScore &&
          pairScore >= skipNewScore
        ) {
          scores[matrixIndex] =
            pairScore;
          decisions[matrixIndex] = 3;
        } else if (
          skipOldScore >= skipNewScore
        ) {
          scores[matrixIndex] =
            skipOldScore;
          decisions[matrixIndex] = 1;
        } else {
          scores[matrixIndex] =
            skipNewScore;
          decisions[matrixIndex] = 2;
        }
      }
    }

    const pairs = [];
    let oldIndex = oldLength;
    let newIndex = newLength;

    while (
      oldIndex > 0 ||
      newIndex > 0
    ) {
      const decision =
        decisions[
          oldIndex * columns +
          newIndex
        ];

      if (
        decision === 3 &&
        oldIndex > 0 &&
        newIndex > 0
      ) {
        pairs.push({
          oldIndex: oldIndex - 1,
          newIndex: newIndex - 1,
          similarity: lineSimilarity(
            oldLines[oldIndex - 1],
            newLines[newIndex - 1]
          )
        });

        oldIndex--;
        newIndex--;
      } else if (
        decision === 1 &&
        oldIndex > 0
      ) {
        oldIndex--;
      } else if (
        newIndex > 0
      ) {
        newIndex--;
      } else {
        oldIndex--;
      }
    }

    pairs.reverse();
    return pairs;
  }


  function diffLinePair(
    oldLine,
    newLine,
    context
  ) {
    if (oldLine === newLine) {
      return [
        makeEdit(
          "equal",
          oldLine,
          toCodePoints(oldLine).length
        )
      ];
    }

    const oldHasNewline =
      hasLineEnding(oldLine);

    const newHasNewline =
      hasLineEnding(newLine);

    const oldBody =
      stripLineEnding(oldLine);

    const newBody =
      stripLineEnding(newLine);

    /*
    * 行本文は常にMyers法で比較します。
    * 同じ長さであっても位置ごとの単純置換にはしません。
    */
    const result = diffTokens(
      toCodePoints(oldBody),
      toCodePoints(newBody),
      context
    );

    /*
    * 両方に改行がある場合、その改行は一致です。
    * 一方だけにある場合は、改行自体を追加・削除として扱います。
    */
    if (
      oldHasNewline &&
      newHasNewline
    ) {
      result.push(
        makeEdit("equal", "\n")
      );
    } else if (oldHasNewline) {
      result.push(
        makeEdit("delete", "\n")
      );
    } else if (newHasNewline) {
      result.push(
        makeEdit("insert", "\n")
      );
    }

    return result;
  }


  function buildLineCharacterDiff(
    oldNormalized,
    newNormalized,
    context
  ) {
    const oldLines =
      splitLinesKeepEnds(oldNormalized);

    const newLines =
      splitLinesKeepEnds(newNormalized);

    const lineDiff = diffTokens(
      oldLines,
      newLines,
      context
    );

    const blocks =
      extractChangedBlocks(lineDiff);

    const result = [];

    for (const block of blocks) {
      if (block.equal) {
        result.push(
          makeEdit(
            "equal",
            block.value,
            toCodePoints(
              block.value
            ).length
          )
        );
        continue;
      }

      const pairs = pairChangedLines(
        block.oldLines,
        block.newLines,
        context
      );

      /*
      * 対応行が1つもない場合は、ブロック全体を
      * 旧行の削除、新行の追加として扱います。
      */
      if (pairs.length === 0) {
        for (const oldLine of block.oldLines) {
          result.push(
            makeEdit(
              "delete",
              oldLine,
              toCodePoints(oldLine).length
            )
          );
        }

        for (const newLine of block.newLines) {
          result.push(
            makeEdit(
              "insert",
              newLine,
              toCodePoints(newLine).length
            )
          );
        }

        continue;
      }

      let oldCursor = 0;
      let newCursor = 0;

      for (const pair of pairs) {
        /*
        * 次の対応行より前にある未対応旧行・新行を、
        * 同じ配置スロットの変更として出力します。
        *
        * 削除を先、追加を後にすることで、
        * 統合表示の順序を安定させます。
        */
        while (
          oldCursor < pair.oldIndex
        ) {
          const oldLine =
            block.oldLines[oldCursor];

          result.push(
            makeEdit(
              "delete",
              oldLine,
              toCodePoints(oldLine).length
            )
          );

          oldCursor++;
        }

        while (
          newCursor < pair.newIndex
        ) {
          const newLine =
            block.newLines[newCursor];

          result.push(
            makeEdit(
              "insert",
              newLine,
              toCodePoints(newLine).length
            )
          );

          newCursor++;
        }

        /*
        * 対応した旧行・新行の内部だけを文字単位で比較します。
        */
        result.push(
          ...diffLinePair(
            block.oldLines[pair.oldIndex],
            block.newLines[pair.newIndex],
            context
          )
        );

        oldCursor =
          pair.oldIndex + 1;

        newCursor =
          pair.newIndex + 1;
      }

      /*
      * 最後の対応行より後ろに残った未対応行を出力します。
      */
      while (
        oldCursor < block.oldLines.length
      ) {
        const oldLine =
          block.oldLines[oldCursor];

        result.push(
          makeEdit(
            "delete",
            oldLine,
            toCodePoints(oldLine).length
          )
        );

        oldCursor++;
      }

      while (
        newCursor < block.newLines.length
      ) {
        const newLine =
          block.newLines[newCursor];

        result.push(
          makeEdit(
            "insert",
            newLine,
            toCodePoints(newLine).length
          )
        );

        newCursor++;
      }
    }

    return result;
  }


  function countSegmentUnits(
    segment,
    selectedMode
  ) {
    if (selectedMode === "line") {
      return splitLinesKeepEnds(
        segment.value
      ).length;
    }

    return toCodePoints(
      segment.value
    ).length;
  }

  function appendInvisibleText(
    parent,
    value
  ) {
    const fragment =
      document.createDocumentFragment();
    let buffer = "";

    const flushBuffer = () => {
      if (!buffer) {
        return;
      }

      fragment.appendChild(
        document.createTextNode(buffer)
      );
      buffer = "";
    };

    for (const character of toCodePoints(value)) {
      let mark = "";
      let label = "";
      let extraClass = "";

      if (character === " ") {
        mark = "·";
        label = "半角空白";
      } else if (character === "\u3000") {
        mark = "□";
        label = "全角空白";
        extraClass = "fullwidth-space";
      } else if (character === "\t") {
        mark = "→";
        label = "タブ";
      } else if (character === "\n") {
        mark = "↵\n";
        label = "改行";
        extraClass = "newline";
      } else if (character === "\u00a0") {
        mark = "⍽";
        label = "改行しない空白";
      } else if (character === "\u200b") {
        mark = "¦";
        label = "ゼロ幅空白";
      }

      if (!mark) {
        buffer += character;
        continue;
      }

      flushBuffer();

      const span =
        document.createElement("span");
      span.className =
        "invisible-char" +
        (
          extraClass
            ? ` ${extraClass}`
            : ""
        );
      span.textContent = mark;
      span.setAttribute(
        "aria-label",
        label
      );

      fragment.appendChild(span);
    }

    flushBuffer();
    parent.appendChild(fragment);
  }

  function appendSegment(
    fragment,
    segment,
    displayType,
    showInvisible
  ) {
    const isChange =
      displayType === "delete" ||
      displayType === "insert";

    const element = isChange
      ? document.createElement("span")
      : document.createElement("span");

    element.classList.add(
      "diff-segment"
    );

    if (displayType === "delete") {
      element.classList.add("deleted");
      element.setAttribute(
        "aria-label",
        "削除箇所"
      );
    } else if (
      displayType === "insert"
    ) {
      element.classList.add("inserted");
      element.setAttribute(
        "aria-label",
        "追加箇所"
      );
    }

    if (
      isChange &&
      segment.group !== null &&
      segment.group !== undefined
    ) {
      element.dataset.changeGroup =
        String(segment.group);
    }

    if (showInvisible) {
      appendInvisibleText(
        element,
        segment.value
      );
    } else {
      element.textContent =
        segment.value;
    }

    fragment.appendChild(element);
  }

  function buildConditionText(
    selectedMode,
    options
  ) {
    const conditions = [];

    if (selectedMode === "line-char") {
      conditions.push(
        "行内文字単位（推奨）"
      );
    } else if (
      selectedMode === "line"
    ) {
      conditions.push("行単位");
    } else {
      conditions.push("全文文字単位");
    }

    if (options.normalizeSpace) {
      conditions.push(
        "空白・タブを統一"
      );
    }

    if (options.normalizeWidth) {
      conditions.push(
        "全角英数字を半角化"
      );
    }

    if (
      options.normalizeBlankLines
    ) {
      conditions.push(
        "連続改行を統一"
      );
    }

    if (options.showInvisible) {
      conditions.push(
        "不可視文字を表示"
      );
    }

    return (
      "比較条件: " +
      conditions.join(" / ")
    );
  }

  function renderDiff(
    compacted,
    oldLength,
    newLength,
    selectedMode,
    options
  ) {
    oldResult.replaceChildren();
    newResult.replaceChildren();
    unifiedResult.replaceChildren();

    const oldFragment =
      document.createDocumentFragment();
    const newFragment =
      document.createDocumentFragment();
    const unifiedFragment =
      document.createDocumentFragment();

    let addedCount = 0;
    let deletedCount = 0;
    let equalCount = 0;

    for (const segment of compacted) {
      const count = countSegmentUnits(
        segment,
        selectedMode
      );

      if (segment.type === "equal") {
        equalCount += count;

        appendSegment(
          oldFragment,
          segment,
          "equal",
          options.showInvisible
        );

        appendSegment(
          newFragment,
          segment,
          "equal",
          options.showInvisible
        );

        appendSegment(
          unifiedFragment,
          segment,
          "equal",
          options.showInvisible
        );
      } else if (
        segment.type === "delete"
      ) {
        deletedCount += count;

        appendSegment(
          oldFragment,
          segment,
          "delete",
          options.showInvisible
        );

        appendSegment(
          unifiedFragment,
          segment,
          "delete",
          options.showInvisible
        );
      } else {
        addedCount += count;

        appendSegment(
          newFragment,
          segment,
          "insert",
          options.showInvisible
        );

        appendSegment(
          unifiedFragment,
          segment,
          "insert",
          options.showInvisible
        );
      }
    }

    oldResult.appendChild(oldFragment);
    newResult.appendChild(newFragment);
    unifiedResult.appendChild(
      unifiedFragment
    );

    const groupIds = new Set();

    for (const segment of compacted) {
      if (
        segment.type !== "equal" &&
        segment.group !== null &&
        segment.group !== undefined
      ) {
        groupIds.add(segment.group);
      }
    }

    const changeCount =
      groupIds.size;

    const denominator = Math.max(
      oldLength,
      newLength
    );

    const similarity =
      denominator === 0
        ? 100
        : Math.max(
            0,
            Math.min(
              100,
              (
                equalCount /
                denominator
              ) * 100
            )
          );

    statAdded.textContent =
      addedCount.toLocaleString("ja-JP");

    statDeleted.textContent =
      deletedCount.toLocaleString("ja-JP");

    statEqual.textContent =
      equalCount.toLocaleString("ja-JP");

    statChanges.textContent =
      changeCount.toLocaleString("ja-JP");

    statSimilarity.textContent =
      `${similarity.toFixed(
        similarity === 100 ? 0 : 1
      )}%`;

    const unit =
      selectedMode === "line"
        ? "行"
        : "文字";

    unitAdded.textContent = unit;
    unitDeleted.textContent = unit;
    unitEqual.textContent = unit;

    const hasDifference =
      addedCount > 0 ||
      deletedCount > 0;

    noDiff.hidden = hasDifference;
    diffArea.hidden = !hasDifference;

    resultNote.hidden =
      !isNormalizationEnabled(options);

    resultNote.textContent =
      isNormalizationEnabled(options)
        ? "正規化後の文章を表示しています。原文そのものではありません。"
        : "";

    resultCondition.textContent =
      buildConditionText(
        selectedMode,
        options
      );

    invisibleLegend.hidden =
      !options.showInvisible;

    copyBtn.disabled = false;
    printBtn.disabled = false;
    setWordCopyEnabled(!isComparing && hasComparisonResult);
    resultsPanel.hidden = false;

    oldResult.scrollTop = 0;
    newResult.scrollTop = 0;
    unifiedResult.scrollTop = 0;

    buildChangeGroups(changeCount);

    if (hasDifference) {
      focusChange(0, false);
    }
  }

  function buildChangeGroups(changeCount) {
    changeGroups = [];

    for (
      let group = 0;
      group < changeCount;
      group++
    ) {
      const selector =
        `[data-change-group="${group}"]`;

      changeGroups.push({
        oldElement:
          oldResult.querySelector(selector),
        newElement:
          newResult.querySelector(selector),
        unifiedElement:
          unifiedResult.querySelector(selector)
      });
    }

    currentChangeIndex = -1;
    diffNavigation.hidden =
      changeGroups.length === 0;

    previousDiffBtn.disabled =
      changeGroups.length === 0;
    nextDiffBtn.disabled =
      changeGroups.length === 0;

    diffPosition.textContent =
      changeGroups.length === 0
        ? "差分 0 / 0"
        : `差分 1 / ${changeGroups.length}`;
  }

  function clearCurrentHighlight() {
    document
      .querySelectorAll(
        ".current-diff"
      )
      .forEach(element => {
        element.classList.remove(
          "current-diff"
        );
      });
  }

  function focusChange(
    requestedIndex,
    scroll = true
  ) {
    if (changeGroups.length === 0) {
      return;
    }

    const length = changeGroups.length;
    const normalizedIndex =
      (
        requestedIndex % length +
        length
      ) % length;

    clearCurrentHighlight();

    currentChangeIndex =
      normalizedIndex;

    const group =
      changeGroups[normalizedIndex];

    for (
      const element of [
        group.oldElement,
        group.newElement,
        group.unifiedElement
      ]
    ) {
      if (element) {
        element.classList.add(
          "current-diff"
        );
      }
    }

    diffPosition.textContent =
      `差分 ${normalizedIndex + 1} / ${length}`;

    if (!scroll) {
      return;
    }

    const target =
      group.oldElement ||
      group.newElement ||
      group.unifiedElement;

    if (target) {
      target.scrollIntoView({
        behavior: "smooth",
        block: "center",
        inline: "nearest"
      });
    }
  }

  function buildCopyText() {
    const lines = [
      resultCondition.textContent,
      "",
      `追加: ${statAdded.textContent}${lastUnitName}`,
      `削除: ${statDeleted.textContent}${lastUnitName}`,
      `一致: ${statEqual.textContent}${lastUnitName}`,
      `差分箇所: ${statChanges.textContent}か所`,
      `一致率: ${statSimilarity.textContent}`,
      ""
    ];

    if (
      lastMode === "line"
    ) {
      const oldLines = [];
      const newLines = [];
      const unifiedLines = [];

      for (const segment of lastDiff) {
        const values =
          splitLinesKeepEnds(
            segment.value
          );

        for (const value of values) {
          const text =
            value.endsWith("\n")
              ? value.slice(0, -1)
              : value;

          if (segment.type === "equal") {
            oldLines.push(`  ${text}`);
            newLines.push(`  ${text}`);
            unifiedLines.push(`  ${text}`);
          } else if (
            segment.type === "delete"
          ) {
            oldLines.push(`- ${text}`);
            unifiedLines.push(`- ${text}`);
          } else {
            newLines.push(`+ ${text}`);
            unifiedLines.push(`+ ${text}`);
          }
        }
      }

      lines.push(
        "旧",
        oldLines.join("\n"),
        "",
        "新",
        newLines.join("\n"),
        "",
        "統合表示",
        unifiedLines.join("\n")
      );

      return lines.join("\n");
    }

    let oldValue = "";
    let newValue = "";
    let unifiedValue = "";

    for (const segment of lastDiff) {
      if (segment.type === "equal") {
        oldValue += segment.value;
        newValue += segment.value;
        unifiedValue += segment.value;
      } else if (
        segment.type === "delete"
      ) {
        oldValue +=
          `【削除:${segment.value}】`;
        unifiedValue +=
          `【削除:${segment.value}】`;
      } else {
        newValue +=
          `【追加:${segment.value}】`;
        unifiedValue +=
          `【追加:${segment.value}】`;
      }
    }

    lines.push(
      "旧",
      oldValue,
      "",
      "新",
      newValue,
      "",
      "統合表示",
      unifiedValue
    );

    return lines.join("\n");
  }

  function setWordCopyEnabled(enabled) {
    wordCopyBtn.disabled = !enabled || isCopyingWord;
    wordCopyPreviewBtn.disabled = !enabled;
  }

  function clearWordCopyPreview() {
    if (wordCopyDialog.open) {
      wordCopyDialog.close();
    }

    wordCopyPreview.replaceChildren();
    wordCopyStatus.textContent = "";
    wordCopyDialogNote.textContent = "";
  }

  /*
   * 表示用DOMをコピーせず、比較済みの本文から書式付き出力を作ります。
   * 入力は必ずテキストノードにし、タグや読み上げ用ラベルを混入させません。
   * 改行はWordでも保持されやすいbr要素に変換します。
   */
  function buildWordCopyContent() {
    const content = document.createElement("div");
    content.style.cssText =
      'color:#000000;font-family:"Yu Gothic",Meiryo,sans-serif;' +
      "font-size:11pt;line-height:1.75;white-space:pre-wrap;";

    const values = [];

    for (const segment of lastDiff) {
      values.push(segment.value);

      const span = document.createElement(
        segment.type === "delete" ? "s" : "span"
      );
      const color = segment.type === "delete"
        ? "#8f3f4d"
        : segment.type === "insert" ? "#285d97" : "#000000";
      span.setAttribute("style",
        `color:${color};white-space:pre-wrap;mso-spacerun:yes;` +
        (segment.type === "delete" ? "text-decoration:line-through;" : "")
      );

      const lines = segment.value.split("\n");
      lines.forEach((line, index) => {
        if (index > 0) {
          span.appendChild(document.createElement("br"));
        }
        span.appendChild(document.createTextNode(line));
      });

      content.appendChild(span);
    }

    return {
      element: content,
      html: content.outerHTML,
      text: values.join("")
    };
  }

  function selectCopyContent(element) {
    element.focus({ preventScroll: true });
    const selection = window.getSelection();

    if (!selection) {
      return;
    }

    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  /* HTTP配置でも、copyイベントが利用できればHTMLと本文を同時に渡します。 */
  function copyWordWithLegacyApi(payload) {
    const activeElement = document.activeElement;
    const selection = window.getSelection();
    const savedRanges = [];

    if (selection) {
      for (let index = 0; index < selection.rangeCount; index++) {
        savedRanges.push(selection.getRangeAt(index).cloneRange());
      }
    }

    const buffer = document.createElement("div");
    buffer.className = "word-copy-buffer";
    buffer.tabIndex = -1;
    buffer.appendChild(payload.element.cloneNode(true));
    let wroteFormats = false;

    const onCopy = event => {
      if (!event.clipboardData) {
        return;
      }

      try {
        event.clipboardData.setData("text/html", payload.html);
        event.clipboardData.setData("text/plain", payload.text);
        event.preventDefault();
        wroteFormats = true;
      } catch (error) {
        /* 書式を渡せなければ成功扱いにせず、手動コピーを案内します。 */
      }
    };

    document.body.appendChild(buffer);
    document.addEventListener("copy", onCopy, true);

    try {
      selectCopyContent(buffer);
      return document.execCommand("copy") && wroteFormats;
    } catch (error) {
      return false;
    } finally {
      document.removeEventListener("copy", onCopy, true);
      buffer.remove();
      activeElement?.focus({ preventScroll: true });

      if (selection) {
        selection.removeAllRanges();
        savedRanges.forEach(range => selection.addRange(range));
      }
    }
  }

  function showWordCopyPreview(payload, automaticCopyFailed = false) {
    if (!hasComparisonResult || isComparing) {
      return;
    }

    if (!payload.text) {
      wordCopyStatus.textContent = "コピーする本文がありません。";
      return;
    }

    wordCopyPreview.replaceChildren(payload.element);
    wordCopyDialogNote.textContent =
      (automaticCopyFailed
        ? "自動コピーできませんでした。下の本文を手動でコピーしてください。"
        : "") +
      (isNormalizationEnabled(lastOptions)
        ? " 正規化後の文章です。原文そのものではありません。"
        : "");

    if (!wordCopyDialog.open) {
      wordCopyDialog.showModal();
    }
    selectCopyContent(wordCopyPreview);
  }

  async function copyWordResult() {
    if (wordCopyBtn.disabled || !hasComparisonResult || isComparing) {
      return;
    }

    const payload = buildWordCopyContent();
    if (!payload.text) {
      wordCopyStatus.textContent = "コピーする本文がありません。";
      return;
    }

    const currentVersion = compareVersion;
    isCopyingWord = true;
    setWordCopyEnabled(true);
    wordCopyStatus.textContent = "コピーしています。";
    let succeeded = false;

    try {
      if (
        window.isSecureContext &&
        navigator.clipboard?.write &&
        typeof ClipboardItem !== "undefined"
      ) {
        try {
          await navigator.clipboard.write([
            new ClipboardItem({
              "text/html": new Blob([payload.html], { type: "text/html" }),
              "text/plain": new Blob([payload.text], { type: "text/plain" })
            })
          ]);
          succeeded = true;
        } catch (error) {
          /* 権限拒否や非対応時は従来方式を試します。 */
        }
      }

      if (currentVersion !== compareVersion || !hasComparisonResult) {
        return;
      }

      if (!succeeded) {
        succeeded = copyWordWithLegacyApi(payload);
      }

      wordCopyStatus.textContent = succeeded
        ? "書式付きでコピーしました。Wordで「元の書式を保持」を選んで貼り付けてください。"
        : "自動コピーできませんでした。コピー用表示から手動でコピーしてください。";

      if (!succeeded) {
        showWordCopyPreview(payload, true);
      }
    } finally {
      isCopyingWord = false;
      setWordCopyEnabled(hasComparisonResult && !isComparing);
    }
  }

  async function copyText(value) {
    if (
      navigator.clipboard &&
      window.isSecureContext
    ) {
      try {
        await navigator.clipboard.writeText(
          value
        );
        return true;
      } catch (error) {
        /*
         * フォールバックを試します。
         */
      }
    }

    const textarea =
      document.createElement("textarea");

    textarea.value = value;
    textarea.setAttribute(
      "readonly",
      ""
    );

    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.top = "0";

    document.body.appendChild(textarea);
    textarea.select();

    let succeeded = false;

    try {
      succeeded =
        document.execCommand("copy");
    } catch (error) {
      succeeded = false;
    }

    textarea.remove();
    return succeeded;
  }

  function syncScroll(source, target) {
    if (
      isSyncingScroll ||
      !optSyncScroll.checked
    ) {
      return;
    }

    const sourceMaximum =
      source.scrollHeight -
      source.clientHeight;

    const targetMaximum =
      target.scrollHeight -
      target.clientHeight;

    if (
      sourceMaximum <= 0 ||
      targetMaximum <= 0
    ) {
      return;
    }

    isSyncingScroll = true;

    const ratio =
      source.scrollTop /
      sourceMaximum;

    target.scrollTop =
      ratio * targetMaximum;

    requestAnimationFrame(() => {
      isSyncingScroll = false;
    });
  }

  function getLimitMessage(
    error,
    selectedMode
  ) {
    if (
      error &&
      error.code === "TIME_LIMIT"
    ) {
      return selectedMode === "line"
        ? "比較処理が時間上限に達したため中止しました。文章を分割して比較してください。"
        : "比較処理が時間上限に達したため中止しました。文章を短くするか、行単位比較をお試しください。";
    }

    if (
      error &&
      error.code ===
        "DISTANCE_LIMIT"
    ) {
      return "差分量が探索深度の上限を超えたため中止しました。文章を分割するか、行単位比較をお試しください。";
    }

    if (
      error &&
      error.code ===
        "RENDER_LIMIT"
    ) {
      return "差分区間が描画上限を超えたため中止しました。文章を分割して比較してください。";
    }

    return "比較中にエラーが発生しました。入力内容を短くして再度お試しください。";
  }

  function rerenderDisplayOnly() {
    if (
      !hasComparisonResult ||
      !lastOptions ||
      isComparing
    ) {
      return;
    }

    const options = {
      ...lastOptions,
      showInvisible:
        optShowInvisible.checked
    };

    lastOptions = options;

    const oldNormalized = normalizeText(
      oldText.value,
      options
    );

    const newNormalized = normalizeText(
      newText.value,
      options
    );

    const oldLength =
      lastMode === "line"
        ? splitLinesKeepEnds(
            oldNormalized
          ).length
        : toCodePoints(
            oldNormalized
          ).length;

    const newLength =
      lastMode === "line"
        ? splitLinesKeepEnds(
            newNormalized
          ).length
        : toCodePoints(
            newNormalized
          ).length;

    renderDiff(
      lastDiff,
      oldLength,
      newLength,
      lastMode,
      options
    );

    setStatus(
      options.showInvisible
        ? "不可視文字を表示しました。"
        : "不可視文字の表示を解除しました。",
      "ok"
    );
  }

  function updateComparisonRule(event) {
    if (hasComparedCurrentInput) {
      compare({
        focusResults: false,
        restoreFocus:
          event.currentTarget
      });
      return;
    }

    invalidateResults();
  }

  function validateLength(
    selectedMode,
    oldNormalized,
    newNormalized
  ) {
    if (selectedMode === "line") {
      const lineTotal =
        splitLinesKeepEnds(
          oldNormalized
        ).length +
        splitLinesKeepEnds(
          newNormalized
        ).length;

      if (lineTotal > MAX_LINE_TOTAL) {
        throw new DiffLimitError(
          "LINE_LENGTH_LIMIT"
        );
      }

      return;
    }

    const characterTotal =
      toCodePoints(
        oldNormalized
      ).length +
      toCodePoints(
        newNormalized
      ).length;

    if (
      characterTotal >
      MAX_CHAR_TOTAL
    ) {
      throw new DiffLimitError(
        "CHAR_LENGTH_LIMIT"
      );
    }
  }

  function compare(settings = {}) {
    if (isComparing) {
      return;
    }

    const focusResults =
      settings.focusResults !== false;

    const restoreFocus =
      settings.restoreFocus || null;

    const currentVersion =
      ++compareVersion;

    const selectedMode =
      getSelectedMode();

    const options =
      getOptions();

    setComparingState(true);
    setStatus(
      "比較しています。しばらくお待ちください。"
    );

    requestAnimationFrame(() => {
      try {
        if (currentVersion !== compareVersion) {
          return;
        }

        const oldNormalized =
          normalizeText(
            oldText.value,
            options
          );

        const newNormalized =
          normalizeText(
            newText.value,
            options
          );

        validateLength(
          selectedMode,
          oldNormalized,
          newNormalized
        );

        const context = {
          startedAt: performance.now(),
          operations: 0
        };

        let edits;
        let oldLength;
        let newLength;

        if (
          selectedMode === "line-char"
        ) {
          edits =
            buildLineCharacterDiff(
              oldNormalized,
              newNormalized,
              context
            );

          oldLength =
            toCodePoints(
              oldNormalized
            ).length;

          newLength =
            toCodePoints(
              newNormalized
            ).length;
        } else {
          const oldTokens =
            tokenizeNormalized(
              oldNormalized,
              selectedMode
            );

          const newTokens =
            tokenizeNormalized(
              newNormalized,
              selectedMode
            );

          edits = diffTokens(
            oldTokens,
            newTokens,
            context
          );

          oldLength =
            oldTokens.length;
          newLength =
            newTokens.length;
        }

        if (
          currentVersion !==
          compareVersion
        ) {
          return;
        }

        const compacted =
          compactDiff(edits);

        lastDiff =
          assignChangeGroups(
            compacted
          );

        lastMode = selectedMode;
        lastOptions = {
          ...options
        };

        lastUnitName =
          selectedMode === "line"
            ? "行"
            : "文字";

        hasComparisonResult = true;

        renderDiff(
          lastDiff,
          oldLength,
          newLength,
          selectedMode,
          options
        );

        hasComparedCurrentInput = true;

        setStatus(
          "比較が完了しました。比較結果が下に表示されています。",
          "ok"
        );

        if (focusResults) {
          resultsTitle.focus({
            preventScroll: true
          });
        }
      } catch (error) {
        if (
          currentVersion !==
          compareVersion
        ) {
          return;
        }

        hasComparisonResult = false;
        copyBtn.disabled = true;
        printBtn.disabled = true;
        resultsPanel.hidden = true;

        let message;

        if (
          error &&
          error.code ===
            "CHAR_LENGTH_LIMIT"
        ) {
          message =
            "文字数が上限を超えています。左右合計30,000文字以内にするか、文章を分割してください。";
        } else if (
          error &&
          error.code ===
            "LINE_LENGTH_LIMIT"
        ) {
          message =
            "行数が上限を超えています。左右合計10,000行以内にするか、文章を分割してください。";
        } else {
          message =
            getLimitMessage(
              error,
              selectedMode
            );
        }

        setStatus(message, "error");

        /*
         * 詳細な入力内容は出力しません。
         */
        if (
          window.console &&
          console.error
        ) {
          console.error(
            "文章差分チェッカー:",
            error
          );
        }
      } finally {
        if (
          currentVersion ===
          compareVersion
        ) {
          setComparingState(false);

          if (restoreFocus) {
            restoreFocus.focus({
              preventScroll: true
            });
          }
        }
      }
    });
  }

  function swapTexts() {
    const temporary =
      oldText.value;

    oldText.value =
      newText.value;

    newText.value =
      temporary;

    updateCounts();
    invalidateResults();
    oldText.focus();
  }

  function clearAll() {
    if (
      oldText.value ||
      newText.value
    ) {
      const confirmed =
        window.confirm(
          "入力した文章と比較結果をすべて消去します。よろしいですか。"
        );

      if (!confirmed) {
        return;
      }
    }

    compareVersion++;
    isComparing = false;

    oldText.value = "";
    newText.value = "";

    optNormalizeSpace.checked = false;
    optNormalizeWidth.checked = false;
    optNormalizeBlankLines.checked = false;
    optShowInvisible.checked = false;
    optSyncScroll.checked = true;

    setSelectedMode("line-char");

    updateModeNote();
    updateCounts();
    clearRenderedResults();

    hasComparisonResult = false;
    hasComparedCurrentInput = false;
    lastDiff = [];
    lastOptions = null;

    copyBtn.disabled = true;
    printBtn.disabled = true;
    resultsPanel.hidden = true;

    setComparingState(false);
    setStatus("");

    oldText.focus();
  }

  function fillSample() {
    oldText.value = [
      "第1条　この規則は、必要な事項を定める。",
      "第2条　申請者は、市長に届け出る。",
      "第3条　申請書を提出する。"
    ].join("\n");

    newText.value = [
      "第1条　この規則は、必要な事項を定める。",
      "第2条　申請者は、市長へ届け出る。",
      "第3条　申請書及び添付書類を提出する。"
    ].join("\n");

    setSelectedMode("line-char");

    updateModeNote();
    updateCounts();
    invalidateResults();

    setStatus(
      "サンプルを入力しました。「差分を比較」を押してください。",
      "ok"
    );
  }

  oldText.addEventListener(
    "input",
    () => {
      updateCounts();
      invalidateResults();
    }
  );

  newText.addEventListener(
    "input",
    () => {
      updateCounts();
      invalidateResults();
    }
  );

  mode.addEventListener(
    "change",
    () => {
      updateModeNote();
      invalidateResults();
    }
  );

  optNormalizeSpace.addEventListener(
    "change",
    updateComparisonRule
  );

  optNormalizeWidth.addEventListener(
    "change",
    updateComparisonRule
  );

  optNormalizeBlankLines.addEventListener(
    "change",
    updateComparisonRule
  );

  optShowInvisible.addEventListener(
    "change",
    () => {
      if (hasComparisonResult) {
        rerenderDisplayOnly();
      }
    }
  );

  optSyncScroll.addEventListener(
    "change",
    () => {
      if (!hasComparisonResult) {
        return;
      }

      setStatus(
        optSyncScroll.checked
          ? "比較結果の連動スクロールを有効にしました。"
          : "比較結果の連動スクロールを解除しました。",
        "ok"
      );
    }
  );

  newResult.addEventListener(
    "scroll",
    () => {
      syncScroll(
        newResult,
        oldResult
      );
    }
  );

  oldResult.addEventListener(
    "scroll",
    () => {
      syncScroll(
        oldResult,
        newResult
      );
    }
  );

  compareBtn.addEventListener(
    "click",
    compare
  );

  swapBtn.addEventListener(
    "click",
    swapTexts
  );

  clearBtn.addEventListener(
    "click",
    clearAll
  );

  sampleBtn.addEventListener(
    "click",
    fillSample
  );

  previousDiffBtn.addEventListener(
    "click",
    () => {
      focusChange(
        currentChangeIndex - 1
      );
    }
  );

  nextDiffBtn.addEventListener(
    "click",
    () => {
      focusChange(
        currentChangeIndex + 1
      );
    }
  );

  printBtn.addEventListener(
    "click",
    () => {
      if (
        printBtn.disabled ||
        !hasComparisonResult
      ) {
        return;
      }

      window.print();
    }
  );

  copyBtn.addEventListener(
    "click",
    async () => {
      if (
        copyBtn.disabled ||
        !hasComparisonResult
      ) {
        return;
      }

      const value =
        buildCopyText();

      const succeeded =
        await copyText(value);

      setStatus(
        succeeded
          ? "比較レポートをテキスト形式でコピーしました。"
          : "コピーできませんでした。結果を範囲選択してコピーしてください。",
        succeeded
          ? "ok"
          : "error"
      );
    }
  );

  wordCopyBtn.addEventListener("click", copyWordResult);
  wordCopyPreviewBtn.addEventListener("click", () => {
    if (!wordCopyPreviewBtn.disabled && hasComparisonResult) {
      showWordCopyPreview(buildWordCopyContent());
    }
  });
  wordCopySelectBtn.addEventListener("click", () => {
    selectCopyContent(wordCopyPreview);
  });
  wordCopyCloseBtn.addEventListener("click", () => {
    wordCopyDialog.close();
  });
  wordCopyDialog.addEventListener("close", () => {
    wordCopyPreview.replaceChildren();
  });

  [oldText, newText].forEach(
    element => {
      element.addEventListener(
        "keydown",
        event => {
          if (
            (
              event.ctrlKey ||
              event.metaKey
            ) &&
            event.key === "Enter"
          ) {
            event.preventDefault();
            compare();
          }
        }
      );
    }
  );

  document.addEventListener(
    "keydown",
    event => {
      if (
        !event.altKey ||
        changeGroups.length === 0
      ) {
        return;
      }

      if (event.key === "ArrowLeft") {
        event.preventDefault();
        focusChange(
          currentChangeIndex - 1
        );
      } else if (
        event.key === "ArrowRight"
      ) {
        event.preventDefault();
        focusChange(
          currentChangeIndex + 1
        );
      }
    }
  );

  updateModeNote();
  updateCounts();
  clearRenderedResults();

  copyBtn.disabled = true;
  printBtn.disabled = true;
  resultsPanel.hidden = true;
})();
