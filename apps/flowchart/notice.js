(() => {
  "use strict";

  let noticeTimer = null;

  window.oyakudachiShowNotice = (message, duration = 3000) => {
    const notice = document.querySelector(".notice");
    if (!notice) {
      return false;
    }

    notice.setAttribute("role", "status");
    notice.setAttribute("aria-live", "polite");
    notice.setAttribute("aria-atomic", "true");

    notice.textContent = String(message);
    notice.classList.add("show");

    window.clearTimeout(noticeTimer);
    noticeTimer = window.setTimeout(() => {
      notice.classList.remove("show");
    }, duration);

    return true;
  };

  const setMenuItemLabel = (item, label) => {
    if (item.getAttribute("aria-label") !== label) {
      item.setAttribute("aria-label", label);
    }
    const text = item.querySelector(".dropdown-menu-item__text");
    if (text && text.textContent !== label) {
      text.textContent = label;
    }
  };

  const getEditingFile = () => {
    const api = window.__oyakudachiExcalidrawAPI;
    if (!api) {
      throw new Error("Excalidraw API is not ready");
    }

    const currentState = api.getAppState();
    const { collaborators, fileHandle, ...appState } = currentState;
    const scene = {
      type: "excalidraw",
      version: 2,
      source: "appbox-flowchart",
      elements: api.getSceneElements(),
      appState,
      files: api.getFiles()
    };
    const baseName = String(currentState.name || "フロー図")
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
      .trim() || "フロー図";

    return {
      blob: new Blob([JSON.stringify(scene, null, 2)], {
        type: "application/json"
      }),
      filename: `${baseName}.excalidraw`
    };
  };

  const downloadEditingFile = (blob, filename) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.hidden = true;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const saveEditingFile = async () => {
    const { blob, filename } = getEditingFile();

    if (typeof window.showSaveFilePicker === "function") {
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{
          description: "Excalidraw編集ファイル",
          accept: { "application/json": [".excalidraw"] }
        }]
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
    } else {
      downloadEditingFile(blob, filename);
    }

    window.oyakudachiShowNotice("編集ファイルを保存しました。");
  };

  const createSaveItem = (referenceItem) => {
    const saveItem = document.createElement(referenceItem.tagName.toLowerCase());
    saveItem.className = referenceItem.className;
    saveItem.setAttribute("data-appbox-save-file", "true");
    saveItem.setAttribute("role", "menuitem");
    saveItem.setAttribute("tabindex", "0");
    saveItem.setAttribute("aria-label", "編集ファイルを保存");
    saveItem.innerHTML = `
      <div class="dropdown-menu-item__icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M5 3h12l2 2v16H5z"></path>
          <path d="M8 3v6h8V3M8 21v-7h8v7"></path>
        </svg>
      </div>
      <div class="dropdown-menu-item__text">編集ファイルを保存</div>
    `;
    saveItem.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      try {
        await saveEditingFile();
      } catch (error) {
        if (error?.name !== "AbortError") {
          console.error("[flowchart] 編集ファイルを保存できませんでした。", error);
          window.oyakudachiShowNotice("編集ファイルを保存できませんでした。");
        }
      }
    });
    saveItem.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        saveItem.click();
      }
    });
    return saveItem;
  };

  const customizeExcalidrawUI = () => {
    const saveHint = document.querySelector(".flow-header .help-text");
    const hintText = "保存・読込／画像出力は、作図画面左上のハンバーガーメニュー。";
    if (saveHint && saveHint.textContent !== hintText) {
      saveHint.textContent = hintText;
    }
    const subtitle = document.querySelector(".flow-header .flow-subtitle");
    const fullDesc = "フロー図・ネットワーク構成図・説明図を直感的に作成。保存・読込／画像出力は、作図画面左上のハンバーガーメニュー。";
    if (subtitle && subtitle.textContent !== fullDesc) {
      subtitle.textContent = fullDesc;
    }
    const helpItem = document.querySelector('[data-testid="help-menu-item"]');
    if (helpItem) {
      setMenuItemLabel(helpItem, "キーボードショートカット");
    }

    const imageExportItem = document.querySelector('[data-testid="image-export-button"]');
    if (!imageExportItem || document.querySelector('[data-appbox-save-file="true"]')) {
      return;
    }

    const saveItem = createSaveItem(imageExportItem);
    imageExportItem.before(saveItem);
  };

  const menuObserver = new MutationObserver(customizeExcalidrawUI);
  menuObserver.observe(document.documentElement, {
    childList: true,
    subtree: true
  });
})();
