(function () {
  "use strict";

  var state = {
    seq: 0,
    loading: false
  };

  var sessionPrefix = "";
  var fallbackNoticeTimer = null;

  /*
   * サンプルを読み込むたびに、要素IDの接頭辞を新しくします。
   */
  function resetIds() {
    state.seq = 0;

    sessionPrefix =
      window.crypto &&
      typeof window.crypto.randomUUID === "function"
        ? window.crypto.randomUUID()
        : Date.now().toString(36) +
          "-" +
          Math.random().toString(36).slice(2, 10);
  }

  function id(prefix) {
    state.seq += 1;
    return sessionPrefix + "-" + prefix + "-" + state.seq;
  }

  /*
   * Excalidraw要素の共通データを生成します。
   */
  function base(type, x, y, width, height, stroke, background) {
    var number = state.seq + 1;

    return {
      id: id(type),
      type: type,
      x: x,
      y: y,
      width: width,
      height: height,
      angle: 0,
      strokeColor: stroke || "#667085",
      backgroundColor: background || "transparent",
      fillStyle: "solid",
      strokeWidth: 2,
      strokeStyle: "solid",
      roughness: 0,
      opacity: 100,
      groupIds: [],
      frameId: null,
      roundness: null,
      seed: 1000 + number * 37,
      version: 1,
      versionNonce: 2000 + number * 53,
      index: "a" + String(number).padStart(4, "0"),
      isDeleted: false,
      boundElements: null,
      updated: Date.now(),
      link: null,
      locked: false
    };
  }

  /*
   * 四角形とラベルを生成します。
   */
  function rect(x, y, width, height, label, background, stroke) {
    var box = base(
      "rectangle",
      x,
      y,
      width,
      height,
      stroke,
      background
    );

    var labelElement = text(
      x + width / 2,
      y + height / 2,
      label,
      18,
      stroke || "#344054",
      "center"
    );

    labelElement.x = x + (width - labelElement.width) / 2;
    labelElement.y = y + (height - labelElement.height) / 2;

    return [box, labelElement];
  }

  /*
   * ひし形とラベルを生成します。
   */
  function diamond(
    x,
    y,
    width,
    height,
    label,
    background,
    stroke
  ) {
    var box = base(
      "diamond",
      x,
      y,
      width,
      height,
      stroke,
      background
    );

    var labelElement = text(
      x + width / 2,
      y + height / 2,
      label,
      17,
      stroke || "#7a5418",
      "center"
    );

    labelElement.x = x + (width - labelElement.width) / 2;
    labelElement.y = y + (height - labelElement.height) / 2;

    return [box, labelElement];
  }

  /*
   * テキスト要素を生成します。
   *
   * 文字幅は概算です。サンプル読込み後は、利用者が自由に
   * 文字や図形の大きさを調整できることを前提としています。
   */
  function text(x, y, value, size, color, align) {
    var stringValue = String(value);
    var lines = stringValue.split("\n");
    var maxLength = 1;
    var i;

    for (i = 0; i < lines.length; i += 1) {
      if (lines[i].length > maxLength) {
        maxLength = lines[i].length;
      }
    }

    var fontSize = size || 18;
    var width = Math.max(
      72,
      Math.round(maxLength * fontSize * 0.92)
    );

    var height = Math.max(
      26,
      Math.round(lines.length * fontSize * 1.35)
    );

    var element = base(
      "text",
      x,
      y,
      width,
      height,
      color || "#344054",
      "transparent"
    );

    element.strokeWidth = 1;
    element.text = stringValue;
    element.fontSize = fontSize;
    element.fontFamily = 6;
    element.textAlign = align || "left";
    element.verticalAlign = "middle";
    element.containerId = null;
    element.originalText = stringValue;
    element.autoResize = true;
    element.lineHeight = 1.25;
    element.baseline = Math.round(height - fontSize * 0.25);

    return element;
  }

  /*
   * 矢印要素を生成します。
   *
   * サンプル内の矢印は位置指定によるもので、接続先図形との
   * バインディングは行っていません。
   */
  function arrow(x, y, deltaX, deltaY, color) {
    var element = base(
      "arrow",
      x,
      y,
      deltaX,
      deltaY,
      color || "#667085",
      "transparent"
    );

    element.points = [
      [0, 0],
      [deltaX, deltaY]
    ];

    element.lastCommittedPoint = null;
    element.startBinding = null;
    element.endBinding = null;
    element.startArrowhead = null;
    element.endArrowhead = "arrow";
    element.elbowed = false;

    return element;
  }

  /*
   * 大きな背景パネルと見出しを生成します。
   */
  function panel(
    x,
    y,
    width,
    height,
    title,
    background,
    stroke
  ) {
    var panelElement = base(
      "rectangle",
      x,
      y,
      width,
      height,
      stroke,
      background
    );

    panelElement.strokeWidth = 1;

    var titleElement = text(
      x + 18,
      y + 14,
      title,
      19,
      stroke || "#475467",
      "left"
    );

    return [panelElement, titleElement];
  }

  function add(target, elements) {
    var i;

    for (i = 0; i < elements.length; i += 1) {
      target.push(elements[i]);
    }
  }

  /*
   * サンプル読込み時に適用する共通のアプリ状態です。
   */
  function commonState(background) {
    return {
      viewBackgroundColor: background,
      currentItemStrokeColor: "#1f2937",
      currentItemBackgroundColor: "transparent",
      currentItemFontFamily: 6,
      currentItemRoughness: 0,
      currentItemStrokeStyle: "solid",
      currentItemFillStyle: "solid",
      currentItemRoundness: "sharp",
      currentItemArrowType: "sharp"
    };
  }

  /*
   * 業務フローのサンプルです。
   */
  function flowSample() {
    resetIds();

    var elements = [];

    elements.push(
      text(
        40,
        25,
        "申請受付業務フロー（例）",
        28,
        "#4f3d69",
        "left"
      )
    );

    add(
      elements,
      panel(
        40,
        85,
        980,
        390,
        "申請から通知まで",
        "#fff9ef",
        "#c9a86a"
      )
    );

    add(
      elements,
      rect(
        85,
        195,
        145,
        72,
        "申請受付",
        "#e9f2ff",
        "#5f7fa8"
      )
    );

    add(
      elements,
      rect(
        290,
        195,
        145,
        72,
        "内容確認",
        "#eaf7ed",
        "#5f916e"
      )
    );

    add(
      elements,
      diamond(
        500,
        185,
        150,
        92,
        "不備あり？",
        "#fff0c9",
        "#b9852f"
      )
    );

    add(
      elements,
      rect(
        710,
        195,
        135,
        72,
        "決裁",
        "#f1eaff",
        "#72569f"
      )
    );

    add(
      elements,
      rect(
        900,
        195,
        145,
        72,
        "通知・完了",
        "#fde9ee",
        "#b95f75"
      )
    );

    add(
      elements,
      rect(
        505,
        340,
        140,
        70,
        "補正依頼",
        "#fff2e4",
        "#b97835"
      )
    );

    elements.push(
      arrow(230, 231, 60, 0),
      arrow(435, 231, 65, 0),
      arrow(650, 231, 60, 0),
      arrow(845, 231, 55, 0),
      arrow(575, 277, 0, 63),
      arrow(505, 375, -70, 0),
      arrow(435, 375, 0, -108)
    );

    elements.push(
      text(665, 198, "No", 14, "#72569f", "center"),
      text(585, 300, "Yes", 14, "#9a6a23", "center")
    );

    return {
      elements: elements,
      appState: commonState("#fffdf8")
    };
  }

  /*
   * システム構成図のサンプルです。
   */
  function systemSample() {
    resetIds();

    var elements = [];

    elements.push(
      text(
        35,
        20,
        "システム構成図（例）",
        28,
        "#4f3d69",
        "left"
      )
    );

    add(
      elements,
      panel(
        35,
        78,
        1040,
        520,
        "庁内ネットワーク",
        "#f3f8ff",
        "#83a6cf"
      )
    );

    add(
      elements,
      panel(
        70,
        140,
        245,
        380,
        "職員端末",
        "#f4efff",
        "#9c83bf"
      )
    );

    add(
      elements,
      panel(
        350,
        140,
        315,
        380,
        "サーバ群",
        "#eff8f1",
        "#82a98c"
      )
    );

    add(
      elements,
      panel(
        700,
        140,
        170,
        165,
        "共有資源",
        "#fff7e9",
        "#c69b58"
      )
    );

    add(
      elements,
      panel(
        700,
        350,
        170,
        130,
        "出力",
        "#fff0f3",
        "#c98295"
      )
    );

    add(
      elements,
      panel(
        905,
        140,
        135,
        340,
        "ポータル",
        "#f3effc",
        "#9175b5"
      )
    );

    add(
      elements,
      rect(
        105,
        235,
        170,
        65,
        "職員PC",
        "#e9f2ff",
        "#5f7fa8"
      )
    );

    add(
      elements,
      rect(
        400,
        190,
        210,
        64,
        "認証サーバ",
        "#eaf7ed",
        "#5f916e"
      )
    );

    add(
      elements,
      rect(
        400,
        305,
        210,
        64,
        "業務アプリサーバ",
        "#eaf7ed",
        "#5f916e"
      )
    );

    add(
      elements,
      rect(
        400,
        420,
        210,
        64,
        "ファイルサーバ",
        "#eaf7ed",
        "#5f916e"
      )
    );

    add(
      elements,
      rect(
        725,
        205,
        120,
        56,
        "共有フォルダ",
        "#fff2e4",
        "#b97835"
      )
    );

    add(
      elements,
      rect(
        725,
        390,
        120,
        56,
        "PDF・印刷",
        "#fde9ee",
        "#b95f75"
      )
    );

    add(
      elements,
      rect(
        925,
        270,
        95,
        66,
        "お役立ちBOX",
        "#efe8fb",
        "#72569f"
      )
    );

    elements.push(
      arrow(275, 267, 125, 0),
      arrow(610, 222, 115, 0),
      arrow(610, 337, 315, -34),
      arrow(610, 452, 115, -34),
      arrow(845, 418, 80, -115)
    );

    return {
      elements: elements,
      appState: commonState("#fbfdff")
    };
  }

  /*
   * 申請手続きのサンプルです。
   */
  function procedureSample() {
    resetIds();

    var elements = [];

    elements.push(
      text(
        35,
        20,
        "申請手続きフロー（例）",
        28,
        "#4f3d69",
        "left"
      )
    );

    add(
      elements,
      panel(
        35,
        85,
        290,
        520,
        "市民",
        "#edf5ff",
        "#88a9cf"
      )
    );

    add(
      elements,
      panel(
        360,
        85,
        655,
        520,
        "担当課",
        "#f8f1ff",
        "#a28abd"
      )
    );

    add(
      elements,
      rect(
        105,
        180,
        150,
        62,
        "来庁",
        "#e9f2ff",
        "#5f7fa8"
      )
    );

    add(
      elements,
      rect(
        90,
        300,
        180,
        62,
        "申請書提出",
        "#e9f2ff",
        "#5f7fa8"
      )
    );

    add(
      elements,
      rect(
        82,
        450,
        195,
        62,
        "不足資料提出",
        "#e9f2ff",
        "#5f7fa8"
      )
    );

    add(
      elements,
      rect(
        425,
        180,
        125,
        62,
        "受付",
        "#eaf7ed",
        "#5f916e"
      )
    );

    add(
      elements,
      rect(
        610,
        180,
        145,
        62,
        "内容確認",
        "#eaf7ed",
        "#5f916e"
      )
    );

    add(
      elements,
      diamond(
        815,
        170,
        145,
        82,
        "不足あり？",
        "#fff0c9",
        "#b9852f"
      )
    );

    add(
      elements,
      rect(
        615,
        450,
        145,
        62,
        "補正依頼",
        "#fff2e4",
        "#b97835"
      )
    );

    add(
      elements,
      rect(
        825,
        305,
        125,
        62,
        "審査",
        "#efe8fb",
        "#72569f"
      )
    );

    add(
      elements,
      rect(
        810,
        450,
        155,
        62,
        "交付・通知",
        "#fde9ee",
        "#b95f75"
      )
    );

    elements.push(
      arrow(255, 211, 170, 0),
      arrow(550, 211, 60, 0),
      arrow(755, 211, 60, 0),
      arrow(180, 242, 0, 58),
      arrow(180, 362, 0, 88),
      arrow(888, 252, 0, 53),
      arrow(815, 390, -55, 91),
      arrow(615, 481, -338, 0),
      arrow(277, 481, 148, -270),
      arrow(950, 336, 0, 114)
    );

    elements.push(
      text(785, 400, "Yes", 14, "#9a6a23", "center"),
      text(962, 170, "No", 14, "#72569f", "center")
    );

    return {
      elements: elements,
      appState: commonState("#fffdf9")
    };
  }

  function getApi() {
    return window.__oyakudachiExcalidrawAPI || null;
  }

  /*
   * 通知は、共通通知関数があればそちらを使います。
   * notice.jsがない場合も、最低限の通知を行います。
   */
  function show(message, duration) {
    var displayDuration = duration || 2600;

    if (
      typeof window.oyakudachiShowNotice === "function"
    ) {
      window.oyakudachiShowNotice(
        message,
        displayDuration
      );
      return;
    }

    var element = document.querySelector(".notice");

    if (!element) {
      return;
    }

    element.setAttribute("role", "status");
    element.setAttribute("aria-live", "polite");
    element.setAttribute("aria-atomic", "true");
    element.textContent = message;
    element.classList.add("show");

    window.clearTimeout(fallbackNoticeTimer);

    fallbackNoticeTimer = window.setTimeout(function () {
      element.classList.remove("show");
    }, displayDuration);
  }

  /*
   * サンプル読込み中は、全サンプルボタンを一時的に無効化します。
   */
  function setButtonsDisabled(disabled) {
    var buttons = document.querySelectorAll(
      ".oyakudachi-sample-btn"
    );

    var i;

    for (i = 0; i < buttons.length; i += 1) {
      buttons[i].disabled = disabled;

      if (disabled) {
        buttons[i].setAttribute("aria-busy", "true");
      } else {
        buttons[i].removeAttribute("aria-busy");
      }
    }
  }

  function getSampleData(kind) {
    if (kind === "flow") {
      return flowSample();
    }

    if (kind === "system") {
      return systemSample();
    }

    if (kind === "procedure") {
      return procedureSample();
    }

    return null;
  }

  /*
   * 指定されたサンプルを読み込みます。
   */
  function load(kind) {
    if (state.loading) {
      return;
    }

    var api = getApi();

    if (!api) {
      show(
        "Excalidrawの読み込み中です。少し待ってから再度お試しください。"
      );
      return;
    }

    var data = getSampleData(kind);

    if (!data) {
      show(
        "指定されたサンプルを確認できませんでした。（E-SAMPLE-02）"
      );
      return;
    }

    var current =
      typeof api.getSceneElements === "function"
        ? api.getSceneElements()
        : [];

    var hasVisibleElements = current.some(function (element) {
      return element && !element.isDeleted;
    });

    if (
      hasVisibleElements &&
      !window.confirm(
        "現在の図をサンプルで置き換えます。よろしいですか？"
      )
    ) {
      return;
    }

    state.loading = true;
    setButtonsDisabled(true);

    try {
      api.updateScene({
        elements: data.elements,
        appState: data.appState
      });

      window.setTimeout(function () {
        try {
          var sceneElements =
            typeof api.getSceneElements === "function"
              ? api.getSceneElements()
              : data.elements;

          if (
            typeof api.scrollToContent === "function"
          ) {
            api.scrollToContent(sceneElements, {
              fitToContent: true
            });
          }
        } catch (error) {
          /*
           * 表示位置の調整失敗は、サンプル本体の
           * 読込み失敗としては扱いません。
           */
          console.warn(
            "sample scroll failed",
            error
          );
        } finally {
          state.loading = false;
          setButtonsDisabled(false);
        }
      }, 150);

      show(
        "サンプルを読み込みました。図形・色・文字は自由に編集できます。"
      );
    } catch (error) {
      state.loading = false;
      setButtonsDisabled(false);

      console.error("sample load failed", error);

      show(
        "サンプルの読み込みに失敗しました。（E-SAMPLE-01）"
      );
    }
  }

  /*
   * サンプル操作グループのアイコンを生成します。
   * innerHTMLを使わずDOM APIで生成し、CSPとの整合を保ちます。
   */
  function createSampleIcon() {
    var namespace = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(namespace, "svg");
    var folderPath = document.createElementNS(
      namespace,
      "path"
    );
    var linePath = document.createElementNS(
      namespace,
      "path"
    );
    var arrowPath = document.createElementNS(
      namespace,
      "path"
    );

    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");

    folderPath.setAttribute(
      "d",
      "M4 5h6l2 2h8v12H4z"
    );

    linePath.setAttribute("d", "M9 13h6");
    arrowPath.setAttribute("d", "m13 10 3 3-3 3");

    svg.appendChild(folderPath);
    svg.appendChild(linePath);
    svg.appendChild(arrowPath);

    return svg;
  }

  function createSampleButton(label, kind, modifierClass) {
    var button = document.createElement("button");

    button.type = "button";
    button.className =
      "oyakudachi-sample-btn " + modifierClass;
    button.setAttribute("data-sample", kind);
    button.textContent = label;

    return button;
  }

  /*
   * ヘッダーへサンプル操作グループを追加します。
   */
  function mount() {
    var header = document.querySelector(".flow-header");

    if (!header) {
      return false;
    }

    if (document.querySelector(".oyakudachi-samples")) {
      return true;
    }

    /*
    * サンプル図グループは.header-right内ではなく、
    * .flow-headerの直接の子要素として追加します。
    */
    var target = header;

    var wrapper = document.createElement("div");
    var label = document.createElement("span");
    var labelText = document.createElement("span");
    var buttons = document.createElement("div");

    var labelId = "oyakudachi-samples-title";

    wrapper.className = "oyakudachi-samples";
    wrapper.setAttribute("role", "group");
    wrapper.setAttribute("aria-labelledby", labelId);

    label.id = labelId;
    label.className = "oyakudachi-samples__label";
    labelText.textContent = "サンプル図:";

    label.appendChild(createSampleIcon());
    label.appendChild(labelText);

    buttons.className = "oyakudachi-samples__buttons";

    buttons.appendChild(
      createSampleButton(
        "業務フロー",
        "flow",
        "oyakudachi-sample-btn--flow"
      )
    );

    buttons.appendChild(
      createSampleButton(
        "システム構成図",
        "system",
        "oyakudachi-sample-btn--system"
      )
    );

    buttons.appendChild(
      createSampleButton(
        "申請手続き",
        "procedure",
        "oyakudachi-sample-btn--procedure"
      )
    );

    wrapper.appendChild(label);
    wrapper.appendChild(buttons);

    target.appendChild(wrapper);

    wrapper.addEventListener("click", function (event) {
      var eventTarget =
        event.target instanceof Element
          ? event.target
          : event.target.parentElement;

      var button = eventTarget
        ? eventTarget.closest("button[data-sample]")
        : null;

      if (!button || !wrapper.contains(button)) {
        return;
      }

      load(button.getAttribute("data-sample"));
    });

    return true;
  }


  /*
   * ヘッダーがJavaScriptで生成されるため、最大15秒待ちます。
   */
  function start() {
    var mounting = false;

    function ensureMounted() {
      if (mounting) {
        return;
      }

      if (
        document.querySelector(
          ".flow-header > .oyakudachi-samples"
        )
      ) {
        return;
      }

      mounting = true;

      try {
        mount();
      } finally {
        mounting = false;
      }
    }

    ensureMounted();

    var observer = new MutationObserver(function () {
      ensureMounted();
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }


  if (document.readyState === "loading") {
    document.addEventListener(
      "DOMContentLoaded",
      start,
      { once: true }
    );
  } else {
    start();
  }
})();
