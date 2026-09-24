/*
  お役立ちアプリBOX 共通ユーティリティ v1.4.0

  window.AppBox.utilities から利用します。外部通信、Cookie、Web Storageは
  使用しません。同じスクリプトを複数回読み込んでも初期化は一度だけです。
*/

(function (window, document) {
  "use strict";

  var namespace = window.AppBox || (window.AppBox = {});

  if (namespace.utilities) {
    return;
  }

  var fieldStates = new WeakMap();
  var dirtyKeys = new Set();
  var generatedId = 0;

  function fallbackCopy(text) {
    var textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    textarea.style.pointerEvents = "none";
    document.body.appendChild(textarea);
    textarea.select();

    var copied = false;

    try {
      copied = document.execCommand("copy");
    } catch (error) {
      copied = false;
    } finally {
      textarea.remove();
    }

    return copied;
  }

  /**
   * 文字列をクリップボードへコピーします。
   * @param {unknown} value コピーする値。String(value)で文字列化します。
   * @returns {Promise<boolean>} コピー成功時true。権限拒否などはfalse。
   */
  function copyText(value) {
    var text = String(value);

    if (
      window.isSecureContext &&
      navigator.clipboard &&
      typeof navigator.clipboard.writeText === "function"
    ) {
      return navigator.clipboard.writeText(text).then(
        function () { return true; },
        function () { return fallbackCopy(text); }
      );
    }

    return Promise.resolve(fallbackCopy(text));
  }

  /**
   * ボタンなどを処理中にします。
   * @param {HTMLElement} target aria-busyを付ける要素。
   * @param {{statusElement?: HTMLElement, message?: string}=} options 状態表示。
   * @returns {Function|null} 元の状態へ戻す関数。既に処理中ならnull。
   */
  function beginBusy(target, options) {
    if (!(target instanceof HTMLElement)) {
      throw new TypeError("beginBusy: target must be an HTMLElement");
    }

    if (target.getAttribute("data-appbox-busy") === "true") {
      return null;
    }

    var settings = options || {};
    var original = {
      ariaBusy: target.getAttribute("aria-busy"),
      ariaDisabled: target.getAttribute("aria-disabled"),
      disabled: "disabled" in target ? target.disabled : undefined,
      statusText: settings.statusElement ? settings.statusElement.textContent : null,
    };

    target.setAttribute("data-appbox-busy", "true");
    target.setAttribute("aria-busy", "true");
    target.setAttribute("aria-disabled", "true");

    if ("disabled" in target) {
      target.disabled = true;
    }

    if (settings.statusElement && settings.message !== undefined) {
      settings.statusElement.textContent = String(settings.message);
    }

    var released = false;

    return function endBusy() {
      if (released) {
        return;
      }

      released = true;
      target.removeAttribute("data-appbox-busy");
      restoreAttribute(target, "aria-busy", original.ariaBusy);
      restoreAttribute(target, "aria-disabled", original.ariaDisabled);

      if (original.disabled !== undefined) {
        target.disabled = original.disabled;
      }

      if (settings.statusElement) {
        settings.statusElement.textContent = original.statusText;
      }
    };
  }

  function restoreAttribute(element, name, value) {
    if (value === null) {
      element.removeAttribute(name);
    } else {
      element.setAttribute(name, value);
    }
  }

  /**
   * 入力欄へエラー状態と説明文の関連付けを設定します。
   * @param {HTMLElement} field 入力要素。
   * @param {HTMLElement} messageElement エラー文を表示する要素。
   * @param {unknown} message 表示する内容。
   */
  function setFieldError(field, messageElement, message) {
    if (!(field instanceof HTMLElement) || !(messageElement instanceof HTMLElement)) {
      throw new TypeError("setFieldError: field and messageElement must be HTMLElements");
    }

    if (!fieldStates.has(field)) {
      fieldStates.set(field, {
        ariaInvalid: field.getAttribute("aria-invalid"),
        ariaDescribedby: field.getAttribute("aria-describedby"),
      });
    }

    if (!messageElement.id) {
      generatedId += 1;
      messageElement.id = "appbox-field-error-" + generatedId;
    }

    var describedby = (field.getAttribute("aria-describedby") || "")
      .split(/\s+/)
      .filter(Boolean);

    if (describedby.indexOf(messageElement.id) === -1) {
      describedby.push(messageElement.id);
    }

    field.setAttribute("aria-invalid", "true");
    field.setAttribute("aria-describedby", describedby.join(" "));
    messageElement.textContent = String(message);
    messageElement.hidden = false;
  }

  /**
   * setFieldErrorで設定した状態を元へ戻します。
   * @param {HTMLElement} field 入力要素。
   * @param {HTMLElement=} messageElement エラー表示要素。
   */
  function clearFieldError(field, messageElement) {
    if (!(field instanceof HTMLElement)) {
      throw new TypeError("clearFieldError: field must be an HTMLElement");
    }

    var original = fieldStates.get(field);

    if (original) {
      restoreAttribute(field, "aria-invalid", original.ariaInvalid);
      restoreAttribute(field, "aria-describedby", original.ariaDescribedby);
      fieldStates.delete(field);
    } else {
      field.removeAttribute("aria-invalid");
    }

    if (messageElement instanceof HTMLElement) {
      messageElement.textContent = "";
      messageElement.hidden = true;
    }
  }

  /**
   * エラー状態の最初の入力欄へフォーカスを移します。
   * @param {ParentNode=} root 検索範囲。既定はdocument。
   * @returns {HTMLElement|null} フォーカスした要素。対象なしはnull。
   */
  function focusFirstError(root) {
    var scope = root || document;
    var field = scope.querySelector('[aria-invalid="true"]');

    if (field instanceof HTMLElement) {
      field.focus();
      return field;
    }

    return null;
  }

  /**
   * Blobを生成し、ブラウザのダウンロードを開始します。
   * @param {unknown} content 保存内容。
   * @param {string} filename ダウンロード名。
   * @param {string=} mimeType MIME型。既定はtext/plain UTF-8。
   */
  function downloadText(content, filename, mimeType) {
    if (!filename) {
      throw new TypeError("downloadText: filename is required");
    }

    var blob = new Blob([String(content)], {
      type: mimeType || "text/plain;charset=utf-8",
    });
    var url = URL.createObjectURL(blob);
    var anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.hidden = true;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(function () { URL.revokeObjectURL(url); }, 0);
  }

  /**
   * 値をJSONとしてダウンロードします。循環参照時はJSON.stringifyの例外を返します。
   * @param {unknown} value 保存する値。
   * @param {string} filename ダウンロード名。
   * @param {number=} spacing インデント幅。既定は2。
   */
  function downloadJson(value, filename, spacing) {
    downloadText(
      JSON.stringify(value, null, spacing === undefined ? 2 : spacing),
      filename,
      "application/json;charset=utf-8"
    );
  }

  /**
   * 呼出し側で生成したCSV文字列をダウンロードします。
   * @param {unknown} csv CSV文字列。行や値の整形は呼出し側の責務です。
   * @param {string} filename ダウンロード名。
   */
  function downloadCsv(csv, filename) {
    downloadText(csv, filename, "text/csv;charset=utf-8");
  }

  /** 画面単位の未保存状態を登録します。 */
  function markDirty(key) {
    dirtyKeys.add(key === undefined ? "default" : String(key));
  }

  /** 画面単位の未保存状態を解除します。 */
  function markClean(key) {
    dirtyKeys.delete(key === undefined ? "default" : String(key));
  }

  /** @returns {boolean} 未保存状態が1件以上あればtrue。 */
  function isDirty() {
    return dirtyKeys.size > 0;
  }

  function handleBeforeUnload(event) {
    if (!isDirty()) {
      return;
    }

    event.preventDefault();
    event.returnValue = "";
  }

  /** ブラウザの印刷画面を開きます。 */
  function printPage() {
    window.print();
  }

  window.addEventListener("beforeunload", handleBeforeUnload);

  namespace.utilities = Object.freeze({
    copyText: copyText,
    beginBusy: beginBusy,
    setFieldError: setFieldError,
    clearFieldError: clearFieldError,
    focusFirstError: focusFirstError,
    downloadText: downloadText,
    downloadJson: downloadJson,
    downloadCsv: downloadCsv,
    markDirty: markDirty,
    markClean: markClean,
    isDirty: isDirty,
    print: printPage,
  });
})(window, document);
