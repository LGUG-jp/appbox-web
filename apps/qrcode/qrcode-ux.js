(() => {
  "use strict";

  const $ = id => document.getElementById(id);

  const contentType = $("contentType");
  const typeRadios = Array.from(
    document.querySelectorAll('input[name="contentTypeChoice"]')
  );
  const qrText = $("qrText");
  const inputWarning = $("inputWarning");
  const clearBtn = $("clearBtn");
  const status = $("status");
  const qrcodeEl = $("qrcode");
  const qrStage = $("qrStage");
  const readCheckNotice = $("readCheckNotice");
  const bgColor = $("bgColor");
  const qrColor = $("qrColor");
  const bgColorControl = $("bgColorControl");
  const transparentBgBtn = $("transparentBgBtn");
  const resetColorsBtn = $("resetColorsBtn");
  const useLogo = $("useLogo");
  const logoPreviewImg = $("logoPreviewImg");
  const logoSizeRange = $("logoSizeRange");
  const saveFileName = $("saveFileName");
  const downloadPngBtn = $("downloadPngBtn");
  const downloadSvgBtn = $("downloadSvgBtn");

  if (
    !contentType ||
    typeRadios.length === 0 ||
    !qrText ||
    !inputWarning ||
    !clearBtn ||
    !status ||
    !qrcodeEl ||
    !qrStage ||
    !readCheckNotice ||
    !bgColor ||
    !qrColor ||
    !transparentBgBtn ||
    !saveFileName ||
    !downloadPngBtn ||
    !downloadSvgBtn
  ) {
    return;
  }

  let transparentBackground = false;
  let savedBackgroundColor = bgColor.value || "#ffffff";
  let refreshTimer = 0;

  function dispatchChange(element) {
    element.dispatchEvent(
      new Event("change", { bubbles: true })
    );
  }

  function dispatchInput(element) {
    element.dispatchEvent(
      new Event("input", { bubbles: true })
    );
  }

  function syncRadiosFromSelect() {
    typeRadios.forEach(radio => {
      radio.checked = radio.value === contentType.value;
    });
  }

  function selectContentType(value) {
    if (contentType.value === value) {
      syncRadiosFromSelect();
      return;
    }

    contentType.value = value;
    syncRadiosFromSelect();
    dispatchChange(contentType);
  }

  typeRadios.forEach(radio => {
    radio.addEventListener("change", () => {
      if (radio.checked) {
        selectContentType(radio.value);
      }
    });
  });

  const compatibilityWarningMessages = {
    emailCharacters:
      "メールアドレスに全角文字または日本語が含まれています。一般的なメールアプリで正しく扱えない場合があるため、半角英数字・半角記号か確認してください。",
    phoneCharacters:
      "電話番号に全角の数字や記号が含まれています。半角の数字・+・()・-へ修正してください。",
    domesticLength:
      "国内電話番号として12桁以上の数字が含まれています。桁数を確認してください。",
    internationalLength:
      "国際電話番号（E.164）は最大15桁です。桁数を確認してください。"
  };

  const compatibilityWarningSet = new Set(
    Object.values(compatibilityWarningMessages)
  );

  function normalizeFullWidthDigits(value) {
    return String(value || "").replace(
      /[０-９]/g,
      character => String.fromCharCode(
        character.charCodeAt(0) - 0xfee0
      )
    );
  }

  function getCompatibilityWarnings() {
    const value = qrText.value.trim();
    const warnings = [];

    if (!value) {
      return warnings;
    }

    if (contentType.value === "email") {
      const emailValue = value.replace(/^mailto:/i, "");

      if (/[^\x00-\x7f]/.test(emailValue)) {
        warnings.push(
          compatibilityWarningMessages.emailCharacters
        );
      }
    }

    if (
      contentType.value === "phone" ||
      contentType.value === "sms"
    ) {
      const phoneValue = value
        .replace(/^(tel|sms):/i, "")
        .trim();

      if (/[０-９＋（）－ー]/.test(phoneValue)) {
        warnings.push(
          compatibilityWarningMessages.phoneCharacters
        );
      }

      const normalized = normalizeFullWidthDigits(phoneValue)
        .replace(/＋/g, "+");
      const digits = normalized.replace(/\D/g, "");
      const isInternational = normalized.startsWith("+");

      if (
        !isInternational &&
        digits.startsWith("0") &&
        digits.length >= 12
      ) {
        warnings.push(
          compatibilityWarningMessages.domesticLength
        );
      }

      if (
        isInternational &&
        digits.length > 15
      ) {
        warnings.push(
          compatibilityWarningMessages.internationalLength
        );
      }
    }

    return warnings;
  }

  function updateCompatibilityWarnings() {
    const existing = inputWarning.textContent
      .split("\n")
      .map(line => line.trim())
      .filter(Boolean)
      .filter(line => !compatibilityWarningSet.has(line));
    const warnings = [
      ...existing,
      ...getCompatibilityWarnings()
    ];

    inputWarning.textContent = warnings.join("\n");
    inputWarning.hidden = warnings.length === 0;
  }

  qrText.addEventListener(
    "input",
    updateCompatibilityWarnings
  );

  contentType.addEventListener(
    "change",
    updateCompatibilityWarnings
  );

  function hexToRgb(hex) {
    const normalized = String(hex || "")
      .replace(/^#/, "")
      .trim();

    if (!/^[0-9a-f]{6}$/i.test(normalized)) {
      return null;
    }

    const value = Number.parseInt(normalized, 16);

    return {
      r: (value >> 16) & 255,
      g: (value >> 8) & 255,
      b: value & 255
    };
  }

  function matchesRgb(data, index, rgb, tolerance = 2) {
    return (
      Math.abs(data[index] - rgb.r) <= tolerance &&
      Math.abs(data[index + 1] - rgb.g) <= tolerance &&
      Math.abs(data[index + 2] - rgb.b) <= tolerance
    );
  }

  function isQrColorPixel(data, index, qrRgb) {
    return (
      data[index + 3] > 0 &&
      matchesRgb(data, index, qrRgb, 2)
    );
  }

  function getTransparentSourceColor() {
    return qrColor.value.toLowerCase() === "#ffffff"
      ? "#000000"
      : "#ffffff";
  }

  function ensureTransparentSourceColor(rerender = true) {
    if (!transparentBackground) {
      return;
    }

    const sourceColor = getTransparentSourceColor();

    if (bgColor.value.toLowerCase() === sourceColor) {
      return;
    }

    bgColor.value = sourceColor;

    if (rerender) {
      dispatchInput(bgColor);
    }
  }

  function detectQrGeometry(canvas, imageData) {
    const width = canvas.width;
    const height = canvas.height;
    const qrRgb = hexToRgb(qrColor.value);

    if (!qrRgb || width < 1 || height < 1 || width !== height) {
      return null;
    }

    const data = imageData.data;

    for (let moduleCount = 21; moduleCount <= 177; moduleCount += 4) {
      const totalModules = moduleCount + 8;

      if (width % totalModules !== 0) {
        continue;
      }

      const modulePixel = width / totalModules;
      const offset = 4 * modulePixel;

      if (modulePixel < 1) {
        continue;
      }

      const sample = (row, column) => {
        const x = Math.min(
          width - 1,
          Math.max(
            0,
            Math.floor(
              offset + column * modulePixel + modulePixel / 2
            )
          )
        );
        const y = Math.min(
          height - 1,
          Math.max(
            0,
            Math.floor(
              offset + row * modulePixel + modulePixel / 2
            )
          )
        );

        return (y * width + x) * 4;
      };

      let finderTopMatches = true;

      for (let column = 0; column < 7; column++) {
        if (!isQrColorPixel(data, sample(0, column), qrRgb)) {
          finderTopMatches = false;
          break;
        }
      }

      if (
        !finderTopMatches ||
        isQrColorPixel(data, sample(0, 7), qrRgb)
      ) {
        continue;
      }

      return {
        moduleCount,
        modulePixel,
        offset
      };
    }

    return null;
  }

  function getLogoArea(geometry) {
    if (
      !geometry ||
      !useLogo ||
      !useLogo.checked ||
      !logoPreviewImg ||
      logoPreviewImg.hidden ||
      !logoPreviewImg.getAttribute("src") ||
      !logoSizeRange
    ) {
      return null;
    }

    const requestedModules = Math.max(
      1,
      Math.round(
        geometry.moduleCount *
        (Number(logoSizeRange.value) / 100)
      )
    );

    let areaModules = requestedModules;

    if (areaModules % 2 !== geometry.moduleCount % 2) {
      areaModules++;
    }

    areaModules = Math.min(
      geometry.moduleCount,
      Math.max(1, areaModules)
    );

    const size = areaModules * geometry.modulePixel;
    const startModule = Math.floor(
      (geometry.moduleCount - areaModules) / 2
    );
    const x = geometry.offset + startModule * geometry.modulePixel;

    return {
      x,
      y: x,
      size,
      radius: Math.round(size * 0.22)
    };
  }

  function roundedRectPath(context, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);

    context.beginPath();
    context.moveTo(x + r, y);
    context.arcTo(x + width, y, x + width, y + height, r);
    context.arcTo(x + width, y + height, x, y + height, r);
    context.arcTo(x, y + height, x, y, r);
    context.arcTo(x, y, x + width, y, r);
    context.closePath();
  }

  function applyTransparentPreview() {
    if (!transparentBackground) {
      qrStage.classList.remove("is-transparent-preview");
      return null;
    }

    ensureTransparentSourceColor(false);

    const canvas = qrcodeEl.querySelector("canvas");

    if (!canvas || canvas.width < 1 || canvas.height < 1) {
      qrStage.classList.add("is-transparent-preview");
      return null;
    }

    const context = canvas.getContext("2d", {
      willReadFrequently: true
    });

    if (!context) {
      return null;
    }

    const sourceRgb = hexToRgb(bgColor.value);

    if (!sourceRgb) {
      return null;
    }

    const imageData = context.getImageData(
      0,
      0,
      canvas.width,
      canvas.height
    );
    const geometry = detectQrGeometry(canvas, imageData);
    const logoArea = getLogoArea(geometry);
    let logoSnapshot = null;

    if (logoArea) {
      logoSnapshot = document.createElement("canvas");
      logoSnapshot.width = Math.max(1, Math.round(logoArea.size));
      logoSnapshot.height = Math.max(1, Math.round(logoArea.size));

      const logoContext = logoSnapshot.getContext("2d");

      if (logoContext) {
        logoContext.drawImage(
          canvas,
          logoArea.x,
          logoArea.y,
          logoArea.size,
          logoArea.size,
          0,
          0,
          logoSnapshot.width,
          logoSnapshot.height
        );
      } else {
        logoSnapshot = null;
      }
    }

    const data = imageData.data;

    for (let index = 0; index < data.length; index += 4) {
      if (matchesRgb(data, index, sourceRgb, 2)) {
        data[index + 3] = 0;
      }
    }

    context.putImageData(imageData, 0, 0);

    if (logoArea && logoSnapshot) {
      context.save();
      roundedRectPath(
        context,
        logoArea.x,
        logoArea.y,
        logoArea.size,
        logoArea.size,
        logoArea.radius
      );
      context.clip();
      context.drawImage(
        logoSnapshot,
        logoArea.x,
        logoArea.y,
        logoArea.size,
        logoArea.size
      );
      context.restore();
    }

    qrStage.classList.add("is-transparent-preview");

    return {
      canvas,
      geometry,
      logoArea
    };
  }

  function updatePreviewState() {
    const hasQr =
      !qrcodeEl.hidden &&
      Boolean(qrcodeEl.querySelector("canvas"));

    readCheckNotice.hidden = !hasQr;

    if (!hasQr) {
      qrStage.classList.remove("is-transparent-preview");
      return;
    }

    if (transparentBackground) {
      applyTransparentPreview();
    }
  }

  function schedulePreviewRefresh() {
    window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(updatePreviewState, 0);
  }

  const qrObserver = new MutationObserver(schedulePreviewRefresh);

  qrObserver.observe(qrcodeEl, {
    childList: true,
    attributes: true,
    attributeFilter: ["hidden"]
  });

  const statusObserver = new MutationObserver(() => {
    const message = status.textContent.trim();

    if (
      transparentBackground &&
      status.classList.contains("warn") &&
      (
        message.startsWith("背景がQRコードより暗いため") ||
        message.startsWith("QRコードと背景のコントラスト比")
      )
    ) {
      status.textContent =
        "背景透明を使用しています。配置先の背景色によって読み取りやすさが変わるため、完成物で確認してください。";
      status.className = "status primary-status warn";
    }
  });

  statusObserver.observe(status, {
    childList: true,
    characterData: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class"]
  });

  function setTransparentUi(enabled) {
    transparentBgBtn.setAttribute(
      "aria-pressed",
      String(enabled)
    );
    transparentBgBtn.textContent = "背景透明";
    bgColor.disabled = enabled;

    if (bgColorControl) {
      bgColorControl.classList.toggle("is-disabled", enabled);
    }
  }

  function setTransparentBackground(enabled, rerender = true) {
    const next = Boolean(enabled);

    if (next === transparentBackground) {
      setTransparentUi(next);
      return;
    }

    if (next) {
      savedBackgroundColor = bgColor.value || "#ffffff";
      transparentBackground = true;
      setTransparentUi(true);
      ensureTransparentSourceColor(rerender);
      applyTransparentPreview();
      return;
    }

    transparentBackground = false;
    setTransparentUi(false);
    qrStage.classList.remove("is-transparent-preview");
    bgColor.value = savedBackgroundColor || "#ffffff";

    if (rerender) {
      dispatchInput(bgColor);
    }
  }

  transparentBgBtn.addEventListener("click", () => {
    setTransparentBackground(!transparentBackground);
  });

  qrColor.addEventListener("input", () => {
    if (!transparentBackground) {
      return;
    }

    window.setTimeout(() => {
      const expected = getTransparentSourceColor();

      if (bgColor.value.toLowerCase() !== expected) {
        bgColor.value = expected;
        dispatchInput(bgColor);
      } else {
        applyTransparentPreview();
      }
    }, 0);
  });

  if (resetColorsBtn) {
    resetColorsBtn.addEventListener("click", () => {
      savedBackgroundColor = "#ffffff";

      if (transparentBackground) {
        window.setTimeout(() => {
          ensureTransparentSourceColor(true);
          applyTransparentPreview();
        }, 0);
      }
    });
  }

  clearBtn.addEventListener("click", () => {
    window.setTimeout(() => {
      transparentBackground = false;
      savedBackgroundColor = "#ffffff";
      setTransparentUi(false);
      qrStage.classList.remove("is-transparent-preview");
      selectContentType("url");
      readCheckNotice.hidden = true;
    }, 0);
  });

  function sanitizeFileBase(value) {
    let name = String(value || "qrcode")
      .replace(/\.[^.]+$/, "")
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
      .replace(/\.{2,}/g, "_")
      .replace(/[. ]+$/g, "")
      .trim();

    if (
      /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:[. ]|$)/i.test(name)
    ) {
      name = "_" + name;
    }

    return Array.from(name).slice(0, 80).join("") || "qrcode";
  }

  function getFileName(extension) {
    return `${sanitizeFileBase(saveFileName.value)}.${extension}`;
  }

  function downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = fileName;
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();

    window.setTimeout(() => URL.revokeObjectURL(url), 3000);
  }

  function setTransparentSaveState(button, label) {
    const original = button.textContent;

    downloadPngBtn.disabled = true;
    downloadSvgBtn.disabled = true;
    button.textContent = label;

    return () => {
      button.textContent = original;
      /*
       * qrcode-app.js 側の stale / 処理中判定を再利用して、
       * 保存後のボタン状態を正しく再計算する。
       */
      dispatchInput(qrText);
    };
  }

  async function downloadTransparentPng() {
    const preview = applyTransparentPreview();

    if (!preview || !preview.canvas) {
      throw new Error("TRANSPARENT_CANVAS_NOT_AVAILABLE");
    }

    const blob = await new Promise((resolve, reject) => {
      preview.canvas.toBlob(value => {
        if (value) {
          resolve(value);
        } else {
          reject(new Error("PNG_FAILED"));
        }
      }, "image/png");
    });

    downloadBlob(blob, getFileName("png"));
  }

  function escapeXml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function isInsideLogoArea(x, y, area) {
    return Boolean(
      area &&
      x >= area.x &&
      x < area.x + area.size &&
      y >= area.y &&
      y < area.y + area.size
    );
  }

  function buildTransparentSvg() {
    const preview = applyTransparentPreview();

    if (!preview || !preview.canvas || !preview.geometry) {
      return "";
    }

    const canvas = preview.canvas;
    const context = canvas.getContext("2d", {
      willReadFrequently: true
    });

    if (!context) {
      return "";
    }

    const imageData = context.getImageData(
      0,
      0,
      canvas.width,
      canvas.height
    );
    const data = imageData.data;
    const qrRgb = hexToRgb(qrColor.value);
    const geometry = preview.geometry;

    if (!qrRgb) {
      return "";
    }

    const moduleUnit = 10;
    const svgOffset = 4 * moduleUnit;
    const svgSize =
      (geometry.moduleCount + 8) * moduleUnit;
    let pathData = "";

    for (let row = 0; row < geometry.moduleCount; row++) {
      for (let column = 0; column < geometry.moduleCount; column++) {
        const x = Math.floor(
          geometry.offset + column * geometry.modulePixel + geometry.modulePixel / 2
        );
        const y = Math.floor(
          geometry.offset + row * geometry.modulePixel + geometry.modulePixel / 2
        );

        if (isInsideLogoArea(x, y, preview.logoArea)) {
          continue;
        }

        const index = (y * canvas.width + x) * 4;

        if (!isQrColorPixel(data, index, qrRgb)) {
          continue;
        }

        const svgX = svgOffset + column * moduleUnit;
        const svgY = svgOffset + row * moduleUnit;

        pathData +=
          `M${svgX},${svgY}` +
          `h${moduleUnit}` +
          `v${moduleUnit}` +
          `h-${moduleUnit}z`;
      }
    }

    let svgText =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      `<svg xmlns="http://www.w3.org/2000/svg" ` +
      `width="${svgSize}" height="${svgSize}" ` +
      `viewBox="0 0 ${svgSize} ${svgSize}" ` +
      'shape-rendering="crispEdges">\n' +
      `<path d="${pathData}" fill="${escapeXml(qrColor.value)}"/>\n`;

    if (preview.logoArea) {
      const area = preview.logoArea;
      const crop = document.createElement("canvas");
      crop.width = Math.max(1, Math.round(area.size));
      crop.height = Math.max(1, Math.round(area.size));
      const cropContext = crop.getContext("2d");

      if (cropContext) {
        cropContext.drawImage(
          canvas,
          area.x,
          area.y,
          area.size,
          area.size,
          0,
          0,
          crop.width,
          crop.height
        );

        const scale = moduleUnit / geometry.modulePixel;
        const x = area.x * scale;
        const y = area.y * scale;
        const size = area.size * scale;

        svgText +=
          `<image href="${escapeXml(crop.toDataURL("image/png"))}" ` +
          `x="${x}" y="${y}" width="${size}" height="${size}" ` +
          'shape-rendering="auto"/>\n';
      }
    }

    svgText += "</svg>";
    return svgText;
  }

  downloadPngBtn.addEventListener(
    "click",
    async event => {
      if (!transparentBackground) {
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation();

      const restore = setTransparentSaveState(
        downloadPngBtn,
        "PNGを作成中..."
      );

      try {
        await downloadTransparentPng();
        status.textContent =
          "PNG画像の保存処理を開始しました。保存後に実機で読み取れることを確認してください。";
        status.className = "status primary-status ok";
      } catch (error) {
        status.textContent =
          "透明背景のPNG画像を保存できませんでした。";
        status.className = "status primary-status error";
      } finally {
        restore();
      }
    },
    true
  );

  downloadSvgBtn.addEventListener(
    "click",
    event => {
      if (!transparentBackground) {
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation();

      const restore = setTransparentSaveState(
        downloadSvgBtn,
        "SVGを作成中..."
      );

      try {
        const svgText = buildTransparentSvg();

        if (!svgText) {
          throw new Error("SVG_FAILED");
        }

        downloadBlob(
          new Blob([svgText], {
            type: "image/svg+xml;charset=utf-8"
          }),
          getFileName("svg")
        );

        status.textContent =
          "SVGファイルの保存処理を開始しました。保存後に実機で読み取れることを確認してください。";
        status.className = "status primary-status ok";
      } catch (error) {
        status.textContent =
          "透明背景のSVGファイルを保存できませんでした。";
        status.className = "status primary-status error";
      } finally {
        restore();
      }
    },
    true
  );

  syncRadiosFromSelect();
  setTransparentUi(false);
  updateCompatibilityWarnings();
  updatePreviewState();
})();