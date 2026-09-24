(() => {
  "use strict";

  const utilities = window.AppBox && window.AppBox.utilities;

  const MAX_LOGO_BYTES = 5 * 1024 * 1024;
  const MAX_LOGO_DIM = 4096;
  const MAX_LOGO_PIXELS = 16000000;
  const LOGO_OUTPUT_MAX_SIDE = 320;
  const QUIET_MODULES = 4;
  const MIN_RECOMMENDED_MODULE_PIXELS = 3;
  const CONTRAST_WARNING_RATIO = 4.5;

  const $ = id => document.getElementById(id);

  const contentType = $("contentType");
  const contentTypeHelp = $("contentTypeHelp");
  const qrText = $("qrText");
  const qrSize = $("qrSize");
  const ecLevel = $("ecLevel");
  const ecLevelSummary = $("ecLevelSummary");
  const ecLevelNote = $("ecLevelNote");
  const qrColor = $("qrColor");
  const bgColor = $("bgColor");
  const qrColorText = $("qrColorText");
  const bgColorText = $("bgColorText");
  const resetColorsBtn = $("resetColorsBtn");
  const saveFileName = $("saveFileName");
  const charCount = $("charCount");
  const byteCount = $("byteCount");
  const inputWarning = $("inputWarning");
  const generateBtn = $("generateBtn");
  const clearBtn = $("clearBtn");
  const status = $("status");
  const qrStage = $("qrStage");
  const stageProcessing = $("stageProcessing");
  const qrcodeEl = $("qrcode");
  const emptyState = $("emptyState");
  const useLogo = $("useLogo");
  const decoOptions = $("decoOptions");
  const logoFile = $("logoFile");
  const logoProcessing = $("logoProcessing");
  const logoPreviewImg = $("logoPreviewImg");
  const logoEmpty = $("logoEmpty");
  const logoSizeRange = $("logoSizeRange");
  const logoSizeValue = $("logoSizeValue");
  const logoZoomRange = $("logoZoomRange");
  const logoZoomValue = $("logoZoomValue");
  const resultSummary = $("resultSummary");
  const resultVersion = $("resultVersion");
  const resultModules = $("resultModules");
  const resultPngSize = $("resultPngSize");
  const resultModulePixels = $("resultModulePixels");
  const resultBytes = $("resultBytes");
  const resultEcLevel = $("resultEcLevel");
  const encodedDetails = $("encodedDetails");
  const encodedContent = $("encodedContent");
  const copyContentBtn = $("copyContentBtn");
  const downloadPngBtn = $("downloadPngBtn");
  const downloadSvgBtn = $("downloadSvgBtn");

  const requiredElements = {
    contentType,
    contentTypeHelp,
    qrText,
    qrSize,
    ecLevel,
    ecLevelSummary,
    ecLevelNote,
    qrColor,
    bgColor,
    qrColorText,
    bgColorText,
    resetColorsBtn,
    saveFileName,
    charCount,
    byteCount,
    inputWarning,
    generateBtn,
    clearBtn,
    status,
    qrStage,
    stageProcessing,
    qrcodeEl,
    emptyState,
    useLogo,
    decoOptions,
    logoFile,
    logoProcessing,
    logoPreviewImg,
    logoEmpty,
    logoSizeRange,
    logoSizeValue,
    logoZoomRange,
    logoZoomValue,
    resultSummary,
    resultVersion,
    resultModules,
    resultPngSize,
    resultModulePixels,
    resultBytes,
    resultEcLevel,
    encodedDetails,
    encodedContent,
    copyContentBtn,
    downloadPngBtn,
    downloadSvgBtn
  };

  let currentQrMatrix = null;
  let generatedState = null;
  let safeLogoPngUrl = "";
  let safeLogoImage = null;
  let logoLoadVersion = 0;
  let isLogoProcessing = false;
  let isGenerating = false;
  let isSavingPng = false;
  let isSavingSvg = false;
  let generateVersion = 0;

  function assertRequiredElements() {
    const missing = Object.entries(requiredElements)
      .filter(([, element]) => !element)
      .map(([name]) => name);

    if (missing.length > 0) {
      throw new Error(
        "必要な画面要素が見つかりません: " +
        missing.join(", ")
      );
    }
  }

  function setStatus(message = "", type = "") {
    status.textContent = message;
    status.className =
      "status" + (type ? ` ${type}` : "");
  }

  function setGenerateProcessing(processing) {
    isGenerating = processing;
    qrStage.setAttribute(
      "aria-busy",
      String(processing)
    );
    stageProcessing.hidden = !processing;
    generateBtn.disabled = processing;
    generateBtn.textContent = processing
      ? "作成しています..."
      : "QRコードを作成";
    clearBtn.disabled = processing;

    updateDownloadState();
  }

  function setLogoProcessing(processing) {
    isLogoProcessing = processing;
    logoProcessing.hidden = !processing;
    logoFile.setAttribute(
      "aria-busy",
      String(processing)
    );

    updateDownloadState();
  }

  function getUtf8Bytes(value) {
    const text = String(value ?? "");

    if (
      window.LocalQRCode &&
      typeof window.LocalQRCode.toUtf8Bytes ===
        "function"
    ) {
      return window.LocalQRCode.toUtf8Bytes(text);
    }

    if (typeof TextEncoder === "function") {
      return Array.from(
        new TextEncoder().encode(text)
      );
    }

    const bytes = [];

    for (const character of text) {
      const codePoint = character.codePointAt(0);

      if (codePoint < 0x80) {
        bytes.push(codePoint);
      } else if (codePoint < 0x800) {
        bytes.push(
          0xc0 | (codePoint >> 6),
          0x80 | (codePoint & 0x3f)
        );
      } else if (codePoint < 0x10000) {
        bytes.push(
          0xe0 | (codePoint >> 12),
          0x80 | ((codePoint >> 6) & 0x3f),
          0x80 | (codePoint & 0x3f)
        );
      } else {
        bytes.push(
          0xf0 | (codePoint >> 18),
          0x80 | ((codePoint >> 12) & 0x3f),
          0x80 | ((codePoint >> 6) & 0x3f),
          0x80 | (codePoint & 0x3f)
        );
      }
    }

    return bytes;
  }

  function getUtf8ByteLength(value) {
    return getUtf8Bytes(value).length;
  }

  function updateInputMetrics() {
    charCount.textContent =
      qrText.value.length.toLocaleString("ja-JP");

    byteCount.textContent =
      getUtf8ByteLength(qrText.value).toLocaleString(
        "ja-JP"
      );
  }

  function updateEcLevelUi() {
    const labels = {
      H: "H（推奨）",
      Q: "Q",
      M: "M"
    };

    ecLevelSummary.textContent =
      labels[ecLevel.value] || ecLevel.value;

    ecLevel.disabled = useLogo.checked;

    if (useLogo.checked) {
      ecLevelNote.textContent =
        "中央画像を使用しているため、誤り訂正レベルはHに固定されています。";
      return;
    }

    if (ecLevel.value === "H") {
      ecLevelNote.textContent =
        "通常はHのままで利用してください。内容が長く、Hで作成できない場合のみQまたはMを検討してください。";
    } else {
      ecLevelNote.textContent =
        "誤り訂正レベルを下げると格納できる量は増えますが、汚れや欠損への耐性は下がります。保存後は実機と印刷物で確認してください。";
    }
  }


  function updateColorLabels() {
    qrColorText.textContent =
      qrColor.value.toUpperCase();

    bgColorText.textContent =
      bgColor.value.toUpperCase();
  }

  function updateRangeLabels() {
    logoSizeValue.textContent =
      logoSizeRange.value;

    logoZoomValue.textContent =
      logoZoomRange.value;
  }

  function updateContentTypeHelp() {
    const settings = {
      text: {
        help:
          "入力内容を変更せず、そのままQRコード化します。",
        placeholder:
          "例: 会議は9月10日 午後2時からです。"
      },
      url: {
        help:
          "URLを入力してください。全角記号、空白、改行などを確認します。",
        placeholder:
          "例: https://www.example.jp/"
      },
      email: {
        help:
          "メールアドレスを入力すると、mailto:形式でQRコード化します。",
        placeholder:
          "例: example@example.jp"
      },
      phone: {
        help:
          "電話番号を入力すると、tel:形式でQRコード化します。",
        placeholder:
          "例: 0237-00-0000"
      },
      sms: {
        help:
          "電話番号を入力すると、SMS起動用のsms:形式でQRコード化します。",
        placeholder:
          "例: 090-0000-0000"
      }
    };

    const selected =
      settings[contentType.value] ||
      settings.text;

    contentTypeHelp.textContent =
      selected.help;

    qrText.placeholder =
      selected.placeholder;

    updateInputWarnings();
  }


  function hasControlCharacters(value) {
    return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(
      value
    );
  }

  function hasUnpairedSurrogate(value) {
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index);

      if (code >= 0xd800 && code <= 0xdbff) {
        if (index + 1 >= value.length) {
          return true;
        }

        const next = value.charCodeAt(index + 1);

        if (next < 0xdc00 || next > 0xdfff) {
          return true;
        }

        index++;
      } else if (
        code >= 0xdc00 &&
        code <= 0xdfff
      ) {
        return true;
      }
    }

    return false;
  }

  function isLikelyEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
      value
    );
  }

  function isLikelyPhone(value) {
    /*
    * 改行、タブ等を許可しない。
    * 数字、先頭のプラス、括弧、ハイフン、
    * 半角スペースだけを許可する。
    */
    return /^[+＋]?[0-9０-９()（）\-‐‑‒–—―ー ]+$/.test(
      value
    );
  }


  function updateInputWarnings() {
    const value = qrText.value;
    const trimmed = value.trim();
    const warnings = [];

    if (!value) {
      inputWarning.hidden = true;
      inputWarning.textContent = "";
      return;
    }

    if (value !== trimmed) {
      warnings.push(
        "入力内容の先頭または末尾に空白・改行があります。そのままQRコードへ含めます。"
      );
    }

    if (hasControlCharacters(value)) {
      warnings.push(
        "通常は使用しない制御文字が含まれています。入力内容を確認してください。"
      );
    }

    if (hasUnpairedSurrogate(value)) {
      warnings.push(
        "正しく組み合わされていないUnicode文字が含まれています。該当文字は置換文字として処理されます。"
      );
    }

    if (contentType.value === "url") {
      if (/[\r\n\t]/.test(value)) {
        warnings.push(
          "URLに改行またはタブが含まれています。"
        );
      }

      if (/[\u3000]/.test(value)) {
        warnings.push(
          "URLに全角スペースが含まれています。"
        );
      }

      if (/[：／．？＃＆＝％]/.test(value)) {
        warnings.push(
          "URLに全角のURL記号が含まれています。半角記号か確認してください。"
        );
      }

      if (/\s/.test(trimmed)) {
        warnings.push(
          "URLの途中に空白が含まれています。"
        );
      }

      if (
        trimmed &&
        !/^https?:\/\//i.test(trimmed)
      ) {
        warnings.push(
          "URLが http:// または https:// で始まっていません。"
        );
      }

      if (
        /^http:\/\//i.test(trimmed)
      ) {
        warnings.push(
          "暗号化されていない http:// のURLです。利用先が正しいか確認してください。"
        );
      }
    }

    if (
      contentType.value === "email" &&
      trimmed &&
      !isLikelyEmail(trimmed.replace(/^mailto:/i, ""))
    ) {
      warnings.push(
        "メールアドレスの形式を確認してください。"
      );
    }

    if (
      (
        contentType.value === "phone" ||
        contentType.value === "sms"
      ) &&
      /[\r\n\t]/.test(value)
    ) {
      warnings.push(
        "電話番号に改行またはタブが含まれています。"
      );
    }

    if (
      (contentType.value === "phone" ||
        contentType.value === "sms") &&
      trimmed &&
      !isLikelyPhone(
        trimmed.replace(/^(tel|sms):/i, "")
      )
    ) {
      warnings.push(
        "電話番号に通常使用しない文字が含まれています。"
      );
    }

    inputWarning.textContent =
      warnings.join("\n");

    inputWarning.hidden =
      warnings.length === 0;
  }

  function getEncodedText() {
    const original =
      qrText.value;

    switch (contentType.value) {
      case "email":
        return /^mailto:/i.test(original)
          ? original
          : "mailto:" + original;

      case "phone":
        return /^tel:/i.test(original)
          ? original
          : "tel:" + original;

      case "sms":
        return /^sms:/i.test(original)
          ? original
          : "sms:" + original;

      default:
        return original;
    }
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();

      image.onload = () => resolve(image);
      image.onerror = () => {
        reject(
          new Error("IMAGE_DECODE_FAILED")
        );
      };

      image.src = src;
    });
  }

  function getLuminance(hex) {
    const rgb = Number.parseInt(
      hex.slice(1),
      16
    );

    const channels = [
      (rgb >> 16) & 255,
      (rgb >> 8) & 255,
      rgb & 255
    ].map(value => {
      const normalized = value / 255;

      return normalized <= 0.03928
        ? normalized / 12.92
        : Math.pow(
            (normalized + 0.055) / 1.055,
            2.4
          );
    });

    return (
      channels[0] * 0.2126 +
      channels[1] * 0.7152 +
      channels[2] * 0.0722
    );
  }

  function checkContrast(darkHex, lightHex) {
    const dark = getLuminance(darkHex);
    const light = getLuminance(lightHex);

    return {
      ratio:
        (Math.max(dark, light) + 0.05) /
        (Math.min(dark, light) + 0.05),
      isDarkOnLight: dark < light
    };
  }

  function sanitizeFileBase(value) {
    let name = String(value || "qrcode")
      .replace(/\.[^.]+$/, "")
      .replace(
        /[\\/:*?"<>|\u0000-\u001f]/g,
        "_"
      )
      .replace(/\.{2,}/g, "_")
      .replace(/[. ]+$/g, "")
      .trim();

    if (
      /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:[. ]|$)/i.test(
        name
      )
    ) {
      name = "_" + name;
    }

    return (
      Array.from(name)
        .slice(0, 80)
        .join("") || "qrcode"
    );
  }

  function getSafeFileName(extension) {
    return (
      sanitizeFileBase(saveFileName.value) +
      "." +
      extension
    );
  }

  function clearResultInformation() {
    resultSummary.hidden = true;
    encodedDetails.hidden = true;
    encodedDetails.open = false;
    encodedContent.textContent = "";

    resultVersion.textContent = "-";
    resultModules.textContent = "-";
    resultPngSize.textContent = "-";
    resultModulePixels.textContent = "-";
    resultBytes.textContent = "-";
    resultEcLevel.textContent = "-";
  }

  function clearRenderedQr() {
    currentQrMatrix = null;
    generatedState = null;
    qrcodeEl.replaceChildren();
    qrcodeEl.hidden = true;
    emptyState.hidden = false;

    clearResultInformation();
    updateDownloadState();
  }

  function updateDecoVisibility() {
    const expanded = useLogo.checked;

    useLogo.setAttribute(
      "aria-expanded",
      String(expanded)
    );

    decoOptions.hidden = !expanded;
    decoOptions.classList.toggle(
      "active",
      expanded
    );

    decoOptions
      .querySelectorAll(
        "input, select, button, textarea"
      )
      .forEach(element => {
        element.disabled =
          !expanded || isLogoProcessing;
      });
  }

  function roundedRectPath(
    context,
    x,
    y,
    width,
    height,
    radius
  ) {
    const r = Math.min(
      radius,
      width / 2,
      height / 2
    );

    context.beginPath();
    context.moveTo(x + r, y);
    context.arcTo(
      x + width,
      y,
      x + width,
      y + height,
      r
    );
    context.arcTo(
      x + width,
      y + height,
      x,
      y + height,
      r
    );
    context.arcTo(
      x,
      y + height,
      x,
      y,
      r
    );
    context.arcTo(
      x,
      y,
      x + width,
      y,
      r
    );
    context.closePath();
  }

  function getCanvasMetrics(matrix, targetSize) {
    const moduleCount =
      matrix.getModuleCount();

    const totalModules =
      moduleCount + QUIET_MODULES * 2;

    const modulePixel = Math.max(
      1,
      Math.floor(
        Number(targetSize) / totalModules
      )
    );

    const finalSize =
      modulePixel * totalModules;

    return {
      moduleCount,
      totalModules,
      modulePixel,
      finalSize
    };
  }

  function getLogoAreaMetrics(
    moduleCount,
    moduleUnit,
    totalSize,
    logoAreaPercent
  ) {
    const requestedModules = Math.max(
      1,
      Math.round(
        moduleCount *
        (Number(logoAreaPercent) / 100)
      )
    );

    /*
    * QR本体と中央画像領域の偶奇を合わせる。
    * これにより、領域の両端をモジュール境界へ
    * 合わせながら中央配置できる。
    */
    let areaModules =
      requestedModules;

    if (
      areaModules % 2 !==
      moduleCount % 2
    ) {
      areaModules++;
    }

    /*
    * 設定上限を超える異常値を防止する。
    */
    areaModules = Math.min(
      moduleCount,
      Math.max(1, areaModules)
    );

    const areaSize =
      areaModules * moduleUnit;

    const qrBodySize =
      moduleCount * moduleUnit;

    const qrBodyStart =
      (totalSize - qrBodySize) / 2;

    const areaStartModule =
      Math.floor(
        (moduleCount - areaModules) / 2
      );

    const areaX =
      qrBodyStart +
      areaStartModule * moduleUnit;

    const areaY = areaX;

    return {
      areaModules,
      areaSize,
      areaX,
      areaY
    };
  }

  async function processLogo(file) {
    const version =
      ++logoLoadVersion;

    if (!file) {
      setLogoProcessing(false);

      safeLogoPngUrl = "";
      safeLogoImage = null;

      logoPreviewImg.hidden = true;
      logoPreviewImg.removeAttribute(
        "src"
      );

      logoEmpty.hidden = false;

      updateDecoVisibility();
      updateEcLevelUi();
      renderPreview();
      updateReadabilityStatus();
      return;
    }

    if (
      file.size >
      MAX_LOGO_BYTES
    ) {
      setLogoProcessing(false);

      logoFile.value = "";

      updateDecoVisibility();

      setStatus(
        "中央画像は5MB以下にしてください。",
        "error"
      );

      return;
    }

    if (
      ![
        "image/png",
        "image/jpeg",
        "image/webp"
      ].includes(file.type)
    ) {
      setLogoProcessing(false);

      logoFile.value = "";

      updateDecoVisibility();

      setStatus(
        "中央画像はPNG、JPEG、WebPを選択してください。",
        "error"
      );

      return;
    }

    const previousPngUrl =
      safeLogoPngUrl;

    const previousImage =
      safeLogoImage;

    const objectUrl =
      URL.createObjectURL(file);

    setLogoProcessing(true);
    updateDecoVisibility();

    setStatus(
      "中央画像を処理しています。",
      ""
    );

    try {
      const sourceImage =
        await loadImage(objectUrl);

      if (
        version !==
        logoLoadVersion
      ) {
        return;
      }

      const width =
        sourceImage.naturalWidth;

      const height =
        sourceImage.naturalHeight;

      if (
        !Number.isInteger(width) ||
        !Number.isInteger(height) ||
        width < 1 ||
        height < 1
      ) {
        throw new Error(
          "IMAGE_DIMENSION_INVALID"
        );
      }

      if (
        width > MAX_LOGO_DIM ||
        height > MAX_LOGO_DIM ||
        width * height >
          MAX_LOGO_PIXELS
      ) {
        throw new Error(
          "IMAGE_DIMENSION_TOO_LARGE"
        );
      }

      const scale = Math.min(
        1,
        LOGO_OUTPUT_MAX_SIDE /
          Math.max(width, height)
      );

      const outputWidth = Math.max(
        1,
        Math.round(width * scale)
      );

      const outputHeight = Math.max(
        1,
        Math.round(height * scale)
      );

      const canvas =
        document.createElement(
          "canvas"
        );

      canvas.width = outputWidth;
      canvas.height = outputHeight;

      const context =
        canvas.getContext("2d");

      if (!context) {
        throw new Error(
          "CANVAS_NOT_AVAILABLE"
        );
      }

      context.imageSmoothingEnabled =
        true;

      context.imageSmoothingQuality =
        "high";

      context.drawImage(
        sourceImage,
        0,
        0,
        outputWidth,
        outputHeight
      );

      const pngUrl =
        canvas.toDataURL(
          "image/png"
        );

      const pngImage =
        await loadImage(pngUrl);

      if (
        version !==
        logoLoadVersion
      ) {
        return;
      }

      safeLogoPngUrl = pngUrl;
      safeLogoImage = pngImage;

      logoPreviewImg.src =
        safeLogoPngUrl;

      logoPreviewImg.hidden = false;
      logoEmpty.hidden = true;

      renderPreview();
    } catch (error) {
      if (
        version !==
        logoLoadVersion
      ) {
        return;
      }

      safeLogoPngUrl =
        previousPngUrl;

      safeLogoImage =
        previousImage;

      logoFile.value = "";

      if (safeLogoPngUrl) {
        logoPreviewImg.src =
          safeLogoPngUrl;

        logoPreviewImg.hidden =
          false;

        logoEmpty.hidden = true;
      } else {
        logoPreviewImg.hidden =
          true;

        logoPreviewImg.removeAttribute(
          "src"
        );

        logoEmpty.hidden = false;
      }

      const message =
        String(
          error &&
          error.message
        ).includes("TOO_LARGE")
          ? "中央画像の縦横または総画素数が上限を超えています。"
          : "中央画像を読み込めませんでした。PNG、JPEG、WebPの正常な画像か確認してください。";

      setStatus(
        message,
        "error"
      );

      renderPreview();
    } finally {
      URL.revokeObjectURL(
        objectUrl
      );

      if (
        version ===
        logoLoadVersion
      ) {
        setLogoProcessing(false);
        updateDecoVisibility();
        updateDownloadState();

        if (
          currentQrMatrix &&
          status.classList.contains(
            "status"
          ) &&
          !status.classList.contains(
            "error"
          )
        ) {
          updateReadabilityStatus();
        }
      }
    }
  }

  function drawQrToCanvas(
    matrix,
    targetSize,
    darkColor,
    lightColor,
    logoImage,
    logoAreaPercent,
    logoZoomPercent
  ) {
    const metrics =
      getCanvasMetrics(matrix, targetSize);

    const {
      moduleCount,
      modulePixel,
      finalSize
    } = metrics;

    const canvas =
      document.createElement("canvas");

    canvas.width = finalSize;
    canvas.height = finalSize;

    const context =
      canvas.getContext("2d");

    if (!context) {
      throw new Error(
        "CANVAS_NOT_AVAILABLE"
      );
    }

    context.imageSmoothingEnabled = false;
    context.fillStyle = lightColor;
    context.fillRect(
      0,
      0,
      finalSize,
      finalSize
    );

    const offset =
      QUIET_MODULES * modulePixel;

    context.fillStyle = darkColor;

    for (
      let row = 0;
      row < moduleCount;
      row++
    ) {
      for (
        let column = 0;
        column < moduleCount;
        column++
      ) {
        if (!matrix.isDark(row, column)) {
          continue;
        }

        context.fillRect(
          offset + column * modulePixel,
          offset + row * modulePixel,
          modulePixel,
          modulePixel
        );
      }
    }

    if (useLogo.checked && logoImage) {
      const logoMetrics =
        getLogoAreaMetrics(
          moduleCount,
          modulePixel,
          finalSize,
          logoAreaPercent
        );

      const {
        areaSize,
        areaX,
        areaY
      } = logoMetrics;

      const radius = Math.round(
        areaSize * 0.22
      );

      roundedRectPath(
        context,
        areaX,
        areaY,
        areaSize,
        areaSize,
        radius
      );

      context.fillStyle = "#ffffff";
      context.fill();

      context.strokeStyle =
        "rgba(0,0,0,0.08)";

      context.lineWidth = Math.max(
        1,
        Math.round(modulePixel * 0.75)
      );

      context.stroke();

      const naturalWidth =
        logoImage.naturalWidth ||
        logoImage.width;

      const naturalHeight =
        logoImage.naturalHeight ||
        logoImage.height;

      const baseBox = areaSize * 0.75;

      const fitScale = Math.min(
        baseBox / naturalWidth,
        baseBox / naturalHeight
      );

      const zoom =
        logoZoomPercent / 100;

      const drawWidth =
        naturalWidth *
        fitScale *
        zoom;

      const drawHeight =
        naturalHeight *
        fitScale *
        zoom;

      const drawX =
        areaX +
        (areaSize - drawWidth) / 2;

      const drawY =
        areaY +
        (areaSize - drawHeight) / 2;

      context.save();

      roundedRectPath(
        context,
        areaX,
        areaY,
        areaSize,
        areaSize,
        radius
      );

      context.clip();
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";

      context.drawImage(
        logoImage,
        drawX,
        drawY,
        drawWidth,
        drawHeight
      );

      context.restore();
    }

    return {
      canvas,
      metrics
    };
  }

  function getCurrentCanvasResult() {
    if (!currentQrMatrix) {
      return null;
    }

    return drawQrToCanvas(
      currentQrMatrix,
      Number(qrSize.value),
      qrColor.value,
      bgColor.value,
      safeLogoImage,
      Number(logoSizeRange.value),
      Number(logoZoomRange.value)
    );
  }

  function renderPreview() {
    if (!currentQrMatrix) {
      return;
    }

    try {
      const result =
        getCurrentCanvasResult();

      qrcodeEl.replaceChildren(
        result.canvas
      );

      qrcodeEl.hidden = false;
      emptyState.hidden = true;

      updateResultInformation(
        result.metrics
      );
    } catch (error) {
      clearRenderedQr();

      setStatus(
        "QRコードの描画に失敗しました。",
        "error"
      );
    }
  }

  function isMatrixStale() {
    if (
      !currentQrMatrix ||
      !generatedState
    ) {
      return false;
    }

    return (
      getEncodedText() !==
        generatedState.text ||
      ecLevel.value !==
        generatedState.ecLevel ||
      contentType.value !==
        generatedState.contentType
    );
  }

  function updateDownloadState() {
    const disabled =
      !currentQrMatrix ||
      isMatrixStale() ||
      isLogoProcessing ||
      isGenerating ||
      isSavingPng ||
      isSavingSvg;

    downloadPngBtn.disabled =
      disabled;

    downloadSvgBtn.disabled =
      disabled;

    copyContentBtn.disabled =
      !generatedState ||
      isMatrixStale();
  }

  function markMatrixStale() {
    updateDownloadState();

    if (
      currentQrMatrix &&
      isMatrixStale()
    ) {
      setStatus(
        "入力内容、用途または誤り訂正レベルが変更されています。QRコードを再作成してください。",
        "warn"
      );
    }
  }

  function getReadabilityMessage() {
    if (!currentQrMatrix) {
      return null;
    }

    if (isMatrixStale()) {
      return {
        type: "warn",
        message:
          "入力内容、用途または誤り訂正レベルが変更されています。QRコードを再作成してください。"
      };
    }

    if (isLogoProcessing) {
      return {
        type: "",
        message:
          "中央画像を処理しています。完了するまでお待ちください。"
      };
    }

    const contrast = checkContrast(
      qrColor.value,
      bgColor.value
    );

    if (!contrast.isDarkOnLight) {
      return {
        type: "warn",
        message:
          "背景がQRコードより暗いため、読み取れない可能性があります。濃いQRコードと明るい背景を使用してください。"
      };
    }

    if (
      contrast.ratio <
      CONTRAST_WARNING_RATIO
    ) {
      return {
        type: "warn",
        message:
          `QRコードと背景のコントラスト比は約${contrast.ratio.toFixed(1)}:1です。4.5:1以上を推奨します。`
      };
    }

    if (
      useLogo.checked &&
      !safeLogoImage
    ) {
      return {
        type: "warn",
        message:
          "中央画像が未選択のため、通常のQRコードとして表示しています。"
      };
    }

    const metrics =
      getCanvasMetrics(
        currentQrMatrix,
        Number(qrSize.value)
      );

    if (
      metrics.modulePixel <
      MIN_RECOMMENDED_MODULE_PIXELS
    ) {
      return {
        type: "warn",
        message:
          `1セルが${metrics.modulePixel}pxの高密度なQRコードです。PNG最大画像サイズを大きくし、実機と印刷物で十分に確認してください。`
      };
    }

    // 作成後の読み取り確認はプレビュー見出しの注意表示へ一本化する。
    return {
      type: "",
      message: ""
    };
  }

  function updateReadabilityStatus() {
    updateDownloadState();

    const result =
      getReadabilityMessage();

    if (!result) {
      return;
    }

    setStatus(
      result.message,
      result.type
    );
  }

  function updateResultInformation(metrics) {
    if (
      !currentQrMatrix ||
      !generatedState ||
      !metrics
    ) {
      clearResultInformation();
      return;
    }

    const version =
      typeof currentQrMatrix.getTypeNumber ===
      "function"
        ? currentQrMatrix.getTypeNumber()
        : Math.floor(
            (metrics.moduleCount - 17) / 4
          );

    resultVersion.textContent =
      String(version);

    resultModules.textContent =
      `${metrics.moduleCount} × ${metrics.moduleCount}`;

    resultPngSize.textContent =
      `${metrics.finalSize} × ${metrics.finalSize}px`;

    resultModulePixels.textContent =
      `${metrics.modulePixel}px`;

    resultBytes.textContent =
      `${generatedState.byteLength.toLocaleString(
        "ja-JP"
      )}バイト`;

    resultEcLevel.textContent =
      generatedState.ecLevel;

    encodedContent.textContent =
      generatedState.text;

    resultSummary.hidden = false;
    encodedDetails.hidden = false;

    updateDownloadState();
  }

  function validateBeforeGenerate() {
    const value =
      qrText.value;

    const trimmed =
      value.trim();

    if (!trimmed) {
      setStatus(
        "QRコードにしたい内容を入力してください。",
        "error"
      );

      qrText.focus();
      return false;
    }

    if (
      contentType.value !==
        "text" &&
      value !== trimmed
    ) {
      setStatus(
        "この用途では、先頭または末尾の空白・改行を削除してから作成してください。",
        "error"
      );

      qrText.focus();
      return false;
    }

    if (
      contentType.value ===
      "url"
    ) {
      if (
        /[\r\n\t]/.test(value)
      ) {
        setStatus(
          "URLに改行またはタブが含まれています。削除してから作成してください。",
          "error"
        );

        qrText.focus();
        return false;
      }

      if (
        /[\u3000]/.test(value)
      ) {
        setStatus(
          "URLに全角スペースが含まれています。削除してから作成してください。",
          "error"
        );

        qrText.focus();
        return false;
      }

      if (
        /\s/.test(value)
      ) {
        setStatus(
          "URLの途中に空白が含まれています。削除してから作成してください。",
          "error"
        );

        qrText.focus();
        return false;
      }

      if (
        /[：／．？＃＆＝％]/.test(
          value
        )
      ) {
        setStatus(
          "URLに全角のURL記号が含まれています。半角記号へ直してから作成してください。",
          "error"
        );

        qrText.focus();
        return false;
      }

      if (
        !/^https?:\/\//i.test(
          value
        )
      ) {
        setStatus(
          "URLは http:// または https:// から入力してください。",
          "error"
        );

        qrText.focus();
        return false;
      }
    }

    if (
      contentType.value ===
        "email" &&
      !isLikelyEmail(
        value.replace(
          /^mailto:/i,
          ""
        )
      )
    ) {
      setStatus(
        "メールアドレスの形式を確認してください。",
        "error"
      );

      qrText.focus();
      return false;
    }

    if (
      (
        contentType.value ===
          "phone" ||
        contentType.value ===
          "sms"
      ) &&
      /[\r\n\t]/.test(value)
    ) {
      setStatus(
        "電話番号に改行またはタブを含めることはできません。",
        "error"
      );

      qrText.focus();
      return false;
    }

    if (
      (
        contentType.value ===
          "phone" ||
        contentType.value ===
          "sms"
      ) &&
      !isLikelyPhone(
        value.replace(
          /^(tel|sms):/i,
          ""
        )
      )
    ) {
      setStatus(
        "電話番号の形式を確認してください。",
        "error"
      );

      qrText.focus();
      return false;
    }

    return true;
  }


  function findLowerCompatibleLevel(text, currentLevel) {
    const order = ["H", "Q", "M"];
    const currentIndex = order.indexOf(currentLevel);

    if (currentIndex < 0) {
      return null;
    }

    for (let index = currentIndex + 1; index < order.length; index++) {
      const levelName = order[index];
      const levelValue =
        window.LocalQRCode.CorrectLevel[levelName];

      try {
        const testQr =
          new window.LocalQRCode.QRCode(
            0,
            levelValue
          );

        testQr.addData(text);
        testQr.make();
        return levelName;
      } catch (error) {
        const message = String(
          error && error.message
        ).toLowerCase();

        if (!message.includes("overflow")) {
          return null;
        }
      }
    }

    return null;
  }


  function getCapacityErrorMessage(text) {
    if (useLogo.checked) {
      return "中央画像を使用しているため、誤り訂正レベルはHに固定されています。この内容はHでは格納できません。内容を短くしてください。長い文章を案内する場合は、掲載ページのURLをQRコードにすることをおすすめします。";
    }

    const compatibleLevel =
      findLowerCompatibleLevel(
        text,
        ecLevel.value
      );

    if (compatibleLevel) {
      return `現在の誤り訂正レベル${ecLevel.value}ではこの内容を格納できません。詳細設定から「${compatibleLevel}」へ変更すると作成できます。または、内容を短くしてください。`;
    }

    return "この内容はMでもQRコードに格納できません。内容を短くしてください。長い文章を案内する場合は、文章そのものではなく掲載ページのURLをQRコードにすることをおすすめします。";
  }


  function generateQr() {
    if (
      isGenerating ||
      isLogoProcessing
    ) {
      return;
    }

    const version =
      ++generateVersion;

    updateInputWarnings();

    if (!validateBeforeGenerate()) {
      return;
    }

    setGenerateProcessing(true);
    setStatus(
      "QRコードを作成しています。",
      ""
    );

    /*
     * 描画更新をブラウザへ反映してから、
     * QR生成の同期処理を開始する。
     */
    window.setTimeout(() => {
      const text = getEncodedText();

      try {
        if (
          version !== generateVersion
        ) {
          return;
        }
        if (
          !window.LocalQRCode ||
          typeof window.LocalQRCode.QRCode !==
            "function"
        ) {
          throw new Error(
            "QR_LIBRARY_NOT_AVAILABLE"
          );
        }

        const level =
          window.LocalQRCode
            .CorrectLevel[ecLevel.value];

        if (
          typeof level !== "number"
        ) {
          throw new Error(
            "QR_LEVEL_INVALID"
          );
        }

        const qr =
          new window.LocalQRCode.QRCode(
            0,
            level
          );

        qr.addData(text);
        qr.make();

        if (
          version !== generateVersion
        ) {
          return;
        }

        currentQrMatrix = qr;

        generatedState = {
          text,
          inputText: qrText.value,
          contentType: contentType.value,
          ecLevel: ecLevel.value,
          byteLength:
            getUtf8ByteLength(text),
          eciAssignment:
            typeof qr.getEciAssignment ===
              "function"
              ? qr.getEciAssignment()
              : null
        };

        renderPreview();
        updateReadabilityStatus();
      } catch (error) {
        clearRenderedQr();

        const message = String(
          error && error.message
        ).toLowerCase();

        if (
          message.includes("overflow")
        ) {
          setStatus(
            getCapacityErrorMessage(text),
            "error"
          );
        } else if (
          message.includes(
            "library_not_available"
          )
        ) {
          setStatus(
            "QRコード生成機能を読み込めませんでした。qr-core.jsの配置を確認してください。",
            "error"
          );
        } else {
          setStatus(
            "QRコードを作成できませんでした。",
            "error"
          );
        }
      } finally {
        if (
          version === generateVersion
        ) {
          setGenerateProcessing(false);

          if (currentQrMatrix) {
            updateReadabilityStatus();
          }
        }
      }
    }, 0);
  }

  function downloadBlob(blob, fileName) {
    const url =
      URL.createObjectURL(blob);

    const link =
      document.createElement("a");

    link.href = url;
    link.download = fileName;
    link.rel = "noopener";

    document.body.appendChild(link);
    link.click();
    link.remove();

    window.setTimeout(
      () => URL.revokeObjectURL(url),
      3000
    );
  }

  async function downloadPng() {
    if (
      !currentQrMatrix ||
      isMatrixStale() ||
      isLogoProcessing ||
      isGenerating ||
      isSavingPng
    ) {
      markMatrixStale();
      return;
    }

    isSavingPng = true;
    downloadPngBtn.textContent =
      "PNGを作成中...";

    updateDownloadState();

    try {
      const result =
        getCurrentCanvasResult();

      if (!result) {
        throw new Error(
          "CANVAS_NOT_AVAILABLE"
        );
      }

      const blob =
        await new Promise(
          (resolve, reject) => {
            result.canvas.toBlob(
              value => {
                if (value) {
                  resolve(value);
                } else {
                  reject(
                    new Error("PNG_FAILED")
                  );
                }
              },
              "image/png"
            );
          }
        );

      downloadBlob(
        blob,
        getSafeFileName("png")
      );

      setStatus(
        "PNG画像の保存処理を開始しました。保存後に実機で読み取れることを確認してください。",
        "ok"
      );
    } catch (error) {
      setStatus(
        "PNG画像を保存できませんでした。",
        "error"
      );
    } finally {
      isSavingPng = false;
      downloadPngBtn.textContent =
        "PNGで保存";

      updateDownloadState();
    }
  }

  function buildSvgText() {
    if (
      !currentQrMatrix ||
      isMatrixStale() ||
      isLogoProcessing
    ) {
      return "";
    }

    const moduleCount =
      currentQrMatrix.getModuleCount();

    const totalModules =
      moduleCount + QUIET_MODULES * 2;

    /*
     * SVGはベクター形式のため、1モジュールを
     * 10座標単位として出力する。
     */
    const moduleUnit = 10;
    const finalSize =
      totalModules * moduleUnit;

    const offset =
      QUIET_MODULES * moduleUnit;

    let pathData = "";

    for (
      let row = 0;
      row < moduleCount;
      row++
    ) {
      for (
        let column = 0;
        column < moduleCount;
        column++
      ) {
        if (
          !currentQrMatrix.isDark(
            row,
            column
          )
        ) {
          continue;
        }

        const x =
          offset + column * moduleUnit;

        const y =
          offset + row * moduleUnit;

        pathData +=
          `M${x},${y}` +
          `h${moduleUnit}` +
          `v${moduleUnit}` +
          `h-${moduleUnit}z`;
      }
    }

    let svgText =
      '<?xml version="1.0" encoding="UTF-8"?>\n';

    svgText +=
      '<svg ' +
      'xmlns="http://www.w3.org/2000/svg" ' +
      `width="${finalSize}" ` +
      `height="${finalSize}" ` +
      `viewBox="0 0 ${finalSize} ${finalSize}" ` +
      'shape-rendering="crispEdges">\n';

    svgText +=
      `<rect width="${finalSize}" ` +
      `height="${finalSize}" ` +
      `fill="${bgColor.value}"/>\n`;

    svgText +=
      `<path d="${pathData}" ` +
      `fill="${qrColor.value}"/>\n`;

    if (
      useLogo.checked &&
      safeLogoPngUrl &&
      safeLogoImage
    ) {
      const logoMetrics =
        getLogoAreaMetrics(
          moduleCount,
          moduleUnit,
          finalSize,
          Number(logoSizeRange.value)
        );

      const {
        areaSize,
        areaX,
        areaY
      } = logoMetrics;

      const radius = Math.round(
        areaSize * 0.22
      );

      const naturalWidth =
        safeLogoImage.naturalWidth || 1;

      const naturalHeight =
        safeLogoImage.naturalHeight || 1;

      const baseBox = areaSize * 0.75;

      const fitScale = Math.min(
        baseBox / naturalWidth,
        baseBox / naturalHeight
      );

      const zoom =
        Number(logoZoomRange.value) /
        100;

      const drawWidth =
        naturalWidth *
        fitScale *
        zoom;

      const drawHeight =
        naturalHeight *
        fitScale *
        zoom;

      const drawX =
        areaX +
        (areaSize - drawWidth) / 2;

      const drawY =
        areaY +
        (areaSize - drawHeight) / 2;

      const strokeWidth = Math.max(
        1,
        Math.round(moduleUnit * 0.75)
      );

      svgText +=
        "<defs>" +
        '<clipPath id="logoClip">' +
        `<rect x="${areaX}" ` +
        `y="${areaY}" ` +
        `width="${areaSize}" ` +
        `height="${areaSize}" ` +
        `rx="${radius}" ` +
        `ry="${radius}"/>` +
        "</clipPath>" +
        "</defs>\n";

      svgText +=
        `<rect x="${areaX}" ` +
        `y="${areaY}" ` +
        `width="${areaSize}" ` +
        `height="${areaSize}" ` +
        `rx="${radius}" ` +
        `ry="${radius}" ` +
        'fill="#ffffff" ' +
        'stroke="#000000" ' +
        'stroke-opacity="0.08" ' +
        `stroke-width="${strokeWidth}"/>\n`;

      svgText +=
        `<image href="${safeLogoPngUrl}" ` +
        `x="${drawX}" ` +
        `y="${drawY}" ` +
        `width="${drawWidth}" ` +
        `height="${drawHeight}" ` +
        'preserveAspectRatio="xMidYMid meet" ' +
        'clip-path="url(#logoClip)" ' +
        'shape-rendering="auto"/>\n';
    }

    svgText += "</svg>";

    return svgText;
  }

  function downloadSvg() {
    if (
      isSavingSvg ||
      isGenerating ||
      isLogoProcessing
    ) {
      return;
    }

    if (
      !currentQrMatrix ||
      isMatrixStale()
    ) {
      markMatrixStale();
      return;
    }

    isSavingSvg = true;
    downloadSvgBtn.textContent =
      "SVGを作成中...";

    updateDownloadState();

    try {
      const svgText =
        buildSvgText();

      if (!svgText) {
        throw new Error(
          "SVG_FAILED"
        );
      }

      downloadBlob(
        new Blob([svgText], {
          type:
            "image/svg+xml;charset=utf-8"
        }),
        getSafeFileName("svg")
      );

      setStatus(
        "SVGファイルの保存処理を開始しました。保存後に実機で読み取れることを確認してください。",
        "ok"
      );
    } catch (error) {
      setStatus(
        "SVGファイルを保存できませんでした。",
        "error"
      );
    } finally {
      isSavingSvg = false;
      downloadSvgBtn.textContent =
        "SVGで保存";

      updateDownloadState();
    }
  }

  async function copyEncodedContent() {
    if (
      !generatedState ||
      isMatrixStale()
    ) {
      markMatrixStale();
      return;
    }

    try {
      if (
        !utilities ||
        !await utilities.copyText(
          generatedState.text
        )
      ) {
        throw new Error("COPY_FAILED");
      }

      setStatus(
        "QRコード化した内容をクリップボードへコピーしました。",
        "ok"
      );
    } catch (error) {
      setStatus(
        "内容をコピーできませんでした。必要に応じて表示内容を選択してコピーしてください。",
        "error"
      );
    }
  }

  function clearAll() {
    generateVersion++;
    logoLoadVersion++;
    isLogoProcessing = false;
    isGenerating = false;
    isSavingPng = false;
    isSavingSvg = false;

    qrStage.setAttribute(
      "aria-busy",
      "false"
    );

    stageProcessing.hidden = true;
    logoProcessing.hidden = true;

    generateBtn.disabled = false;
    generateBtn.textContent =
      "QRコードを作成";

    clearBtn.disabled = false;

    downloadPngBtn.textContent =
      "PNGで保存";

    downloadSvgBtn.textContent =
      "SVGで保存";

    contentType.value = "text";
    qrText.value = "";
    qrSize.value = "768";
    ecLevel.value = "H";
    qrColor.value = "#202020";
    bgColor.value = "#ffffff";
    saveFileName.value = "qrcode";
    useLogo.checked = false;
    logoFile.value = "";
    logoSizeRange.value = "15";
    logoZoomRange.value = "100";

    safeLogoPngUrl = "";
    safeLogoImage = null;

    logoPreviewImg.hidden = true;
    logoPreviewImg.removeAttribute(
      "src"
    );

    logoEmpty.hidden = false;

    inputWarning.hidden = true;
    inputWarning.textContent = "";

    updateInputMetrics();
    updateColorLabels();
    updateRangeLabels();
    updateContentTypeHelp();
    updateDecoVisibility();
    updateEcLevelUi();
    clearRenderedQr();

    setStatus("");
    qrText.focus();
  }

  contentType.addEventListener(
    "change",
    () => {
      updateContentTypeHelp();
      markMatrixStale();
    }
  );

  qrText.addEventListener(
    "input",
    () => {
      updateInputMetrics();
      updateInputWarnings();
      markMatrixStale();
    }
  );

  qrText.addEventListener(
    "keydown",
    event => {
      if (
        (event.ctrlKey ||
          event.metaKey) &&
        event.key === "Enter"
      ) {
        event.preventDefault();
        generateQr();
      }
    }
  );

  ecLevel.addEventListener(
    "change",
    () => {
      updateEcLevelUi();
      markMatrixStale();
    }
  );

  qrSize.addEventListener(
    "change",
    () => {
      renderPreview();
      updateReadabilityStatus();
    }
  );

  [qrColor, bgColor].forEach(input => {
    input.addEventListener(
      "input",
      () => {
        updateColorLabels();
        renderPreview();
        updateReadabilityStatus();
      }
    );
  });

  resetColorsBtn.addEventListener(
    "click",
    () => {
      qrColor.value = "#202020";
      bgColor.value = "#ffffff";

      updateColorLabels();
      renderPreview();
      updateReadabilityStatus();
    }
  );

  useLogo.addEventListener(
    "change",
    () => {
      let levelChanged = false;

      if (
        useLogo.checked &&
        ecLevel.value !== "H"
      ) {
        ecLevel.value = "H";
        levelChanged = true;
        markMatrixStale();
      }

      updateDecoVisibility();
      updateEcLevelUi();
      renderPreview();

      if (levelChanged) {
        setStatus(
          "中央画像を使用するため、誤り訂正レベルをHに変更して固定しました。QRコードを再作成してください。",
          "warn"
        );

        return;
      }

      updateReadabilityStatus();
    }
  );

  logoSizeRange.addEventListener(
    "input",
    () => {
      updateRangeLabels();
      renderPreview();
      updateReadabilityStatus();
    }
  );

  logoZoomRange.addEventListener(
    "input",
    () => {
      updateRangeLabels();
      renderPreview();
      updateReadabilityStatus();
    }
  );

  logoFile.addEventListener(
    "change",
    () => {
      const file =
        logoFile.files &&
        logoFile.files[0];

      processLogo(file);
    }
  );

  generateBtn.addEventListener(
    "click",
    generateQr
  );

  clearBtn.addEventListener(
    "click",
    clearAll
  );

  downloadPngBtn.addEventListener(
    "click",
    downloadPng
  );

  downloadSvgBtn.addEventListener(
    "click",
    downloadSvg
  );

  copyContentBtn.addEventListener(
    "click",
    copyEncodedContent
  );

  try {
    assertRequiredElements();

    updateInputMetrics();
    updateColorLabels();
    updateRangeLabels();
    updateContentTypeHelp();
    updateDecoVisibility();
    updateEcLevelUi();
    clearRenderedQr();
  } catch (error) {
    console.error(error);

    if (status) {
      setStatus(
        "画面の初期化に失敗しました。配置したファイルの組合せを確認してください。",
        "error"
      );
    }
  }
})();
