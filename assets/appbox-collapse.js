/*
  お役立ちアプリBOX 共通の折りたたみ処理

  作業領域を広く使うために、ヘッダーや注意喚起などを開閉できるように
  します。ビューポートを固定して残りを作業領域に割り当てているツール
  （PDFかんたん編集、相続関係図作成ツール）で使用します。

  状態は保存しません。localStorage、sessionStorage、Cookieを
  一切使用しないため、ページを開き直すと必ず開いた状態に戻ります。
  安全上の注意喚起を閉じたままにしないための仕様です。

  使い方（HTML側で宣言するだけです）:

    <button
      type="button"
      class="appbox-collapse-toggle"
      aria-expanded="true"
      aria-controls="pdfBrand pdfNotice"
      data-appbox-collapse="pdfBrand pdfNotice"
      data-appbox-collapse-flag="chrome"
      data-appbox-collapse-label-expanded="ヘッダーと注意を閉じてプレビューを広くする"
      data-appbox-collapse-label-collapsed="ヘッダーと注意を表示する"
      data-appbox-collapse-text-expanded="表示を狭める"
      data-appbox-collapse-text-collapsed="表示を戻す"
    >
      <svg ...></svg>
      <span data-appbox-collapse-text>表示を狭める</span>
    </button>

  data-appbox-collapse
    開閉する要素のid。半角空白区切りで複数指定できます。
    対象には data-appbox-collapsed="true" / "false" が付きます。
    実際に隠すCSSは各ツールのCSSへ書きます。ツールごとに
    display の値（flex、grid など）が異なり、共通CSSからは
    確実に打ち消せないためです。

  data-appbox-collapse-flag
    省略可。指定すると <html> へ
    data-appbox-collapsed-<flag>="true" / "false" が付きます。
    「折りたたんだらヘッダーの高さ予約を縮める」など、
    対象要素の外側を調整したい場合に使用します。

  data-appbox-collapse-label-expanded / -collapsed
    省略可。ボタンのaria-labelとtitleを差し替えます。
    目的が伝わる長めの文を書いてください。

  data-appbox-collapse-text-expanded / -collapsed
    省略可。data-appbox-collapse-text を持つ要素の文字を差し替えます。
    ボタンが長くなりすぎないよう短い語を書いてください。

  初期状態はHTMLのaria-expandedの値をそのまま採用します。
  既定を開いた状態にするため aria-expanded="true" を書いてください。
*/

(function () {
  "use strict";

  var ATTR = "data-appbox-collapse";
  var ATTR_FLAG = "data-appbox-collapse-flag";
  var ATTR_LABEL_EXPANDED = "data-appbox-collapse-label-expanded";
  var ATTR_LABEL_COLLAPSED = "data-appbox-collapse-label-collapsed";
  var ATTR_TEXT_EXPANDED = "data-appbox-collapse-text-expanded";
  var ATTR_TEXT_COLLAPSED = "data-appbox-collapse-text-collapsed";
  var ATTR_STATE = "data-appbox-collapsed";
  var ATTR_BOUND = "data-appbox-collapse-bound";

  function collectTargets(button) {
    var ids = (button.getAttribute(ATTR) || "").split(/\s+/);
    var targets = [];

    for (var i = 0; i < ids.length; i += 1) {
      if (ids[i] === "") {
        continue;
      }

      var element = document.getElementById(ids[i]);

      if (element !== null) {
        targets.push(element);
      }
    }

    return targets;
  }

  function apply(button, collapsed) {
    var state = collapsed ? "true" : "false";
    var targets = collectTargets(button);

    for (var i = 0; i < targets.length; i += 1) {
      targets[i].setAttribute(ATTR_STATE, state);
    }

    button.setAttribute("aria-expanded", collapsed ? "false" : "true");

    /*
     * aria-labelとtitleには目的が伝わる長めの文を、
     * 画面に見えるボタンの文字には短い語を使います。
     * 同じ文字列を両方へ入れるとボタンが長くなりすぎるため分けています。
     */
    var label = button.getAttribute(
      collapsed ? ATTR_LABEL_COLLAPSED : ATTR_LABEL_EXPANDED
    );

    if (label !== null && label !== "") {
      button.setAttribute("aria-label", label);
      button.setAttribute("title", label);
    }

    var caption = button.getAttribute(
      collapsed ? ATTR_TEXT_COLLAPSED : ATTR_TEXT_EXPANDED
    );

    if (caption !== null && caption !== "") {
      var text = button.querySelector("[data-appbox-collapse-text]");

      if (text !== null) {
        text.textContent = caption;
      }
    }

    var flag = button.getAttribute(ATTR_FLAG);

    if (flag !== null && flag !== "") {
      document.documentElement.setAttribute(
        "data-appbox-collapsed-" + flag,
        state
      );
    }
  }

  function bind(button) {
    if (button.getAttribute(ATTR_BOUND) === "true") {
      return;
    }

    button.setAttribute(ATTR_BOUND, "true");
    apply(button, button.getAttribute("aria-expanded") === "false");

    button.addEventListener("click", function () {
      apply(button, button.getAttribute("aria-expanded") !== "false");
    });
  }

  function init() {
    var buttons = document.querySelectorAll("[" + ATTR + "]");

    for (var i = 0; i < buttons.length; i += 1) {
      bind(buttons[i]);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
