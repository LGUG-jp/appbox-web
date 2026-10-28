(() => {
  "use strict";

  const input = document.getElementById("appSearch");
  const grid = document.getElementById("appsGrid");
  const empty = document.getElementById("emptySearch");
  const notice = document.getElementById("configNotice");
  const qrTrademark = document.getElementById("qrTrademark");
  const standardCards = new Map(
    Array.from(grid.querySelectorAll(".app-card[data-app-id]"))
      .map((card) => [card.dataset.appId, card])
  );
  const allowedStatuses = new Set(["available", "maintenance", "hidden"]);
  const additionalColors = ["cyan", "orange", "blue", "purple", "green", "red"];
  const defaultMaintenanceMessage = "現在、メンテナンス中のため利用できません。";

  class ConfigError extends Error {}

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function optionalString(value, fieldName) {
    if (value === undefined) return "";
    if (typeof value !== "string") {
      throw new ConfigError(`${fieldName} must be a string`);
    }
    return value.trim();
  }

  function requiredString(value, fieldName) {
    const result = optionalString(value, fieldName);
    if (!result) throw new ConfigError(`${fieldName} is required`);
    return result;
  }

  function validateStatus(value) {
    const status = value === undefined ? "available" : value;
    if (typeof status !== "string" || !allowedStatuses.has(status)) {
      throw new ConfigError(`unsupported status: ${String(status)}`);
    }
    return status;
  }

  function validatePath(value) {
    const path = requiredString(value, "path");
    if (
      /[\\\u0000-\u001f\u007f]/.test(path) ||
      /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(path) ||
      path.startsWith("//")
    ) {
      throw new ConfigError("path must be a same-site relative path");
    }

    let resolved;
    try {
      resolved = new URL(path, document.baseURI);
    } catch {
      throw new ConfigError("path is not a valid URL path");
    }
    if (resolved.origin !== window.location.origin) {
      throw new ConfigError("path must not point to another origin");
    }
    return path;
  }

  function validateConfig(rawConfig) {
    if (!isPlainObject(rawConfig)) {
      throw new ConfigError("config root must be an object");
    }
    if (rawConfig.schemaVersion !== 1) {
      throw new ConfigError("schemaVersion must be 1");
    }
    if (rawConfig.apps !== undefined && !isPlainObject(rawConfig.apps)) {
      throw new ConfigError("apps must be an object");
    }
    if (rawConfig.additionalApps !== undefined && !Array.isArray(rawConfig.additionalApps)) {
      throw new ConfigError("additionalApps must be an array");
    }
    return {
      apps: rawConfig.apps || {},
      additionalApps: rawConfig.additionalApps || []
    };
  }

  function setNotice(message) {
    notice.textContent = message;
    notice.hidden = false;
  }

  function markMaintenance(card, message) {
    const title = card.querySelector(".app-title")?.textContent?.trim() || "このアプリ";
    card.removeAttribute("href");
    card.classList.add("is-maintenance");
    card.setAttribute("aria-disabled", "true");
    card.setAttribute("aria-label", `${title}はメンテナンス中です`);

    const description = card.querySelector(".app-desc");
    if (description && !description.closest(".maintenance-description")) {
      const descriptionLayer = document.createElement("div");
      descriptionLayer.className = "maintenance-description";
      description.before(descriptionLayer);
      descriptionLayer.appendChild(description);

      const label = document.createElement("span");
      label.className = "maintenance-label";
      label.setAttribute("aria-hidden", "true");
      label.textContent = "メンテナンス中";
      descriptionLayer.appendChild(label);
    }

    let messageElement = card.querySelector(".maintenance-message");
    if (!messageElement) {
      messageElement = document.createElement("p");
      messageElement.className = "maintenance-message";
      card.querySelector(".app-content")?.appendChild(messageElement);
    }
    messageElement.textContent = message || defaultMaintenanceMessage;
  }

  function applyStatus(card, status, message) {
    if (status === "hidden") {
      card.hidden = true;
    } else if (status === "maintenance") {
      markMaintenance(card, message);
    }
  }

  function createAdditionalCard(app, index) {
    const card = document.createElement("a");
    card.className = "app-card";
    card.href = app.path;
    card.dataset.appId = app.id;
    card.dataset.color = additionalColors[index % additionalColors.length];
    card.dataset.keywords = app.category;
    card.setAttribute("aria-label", `${app.name}を開く`);

    const inner = document.createElement("div");
    inner.className = "card-inner";
    const head = document.createElement("div");
    head.className = "card-head";
    const icon = document.createElement("div");
    icon.className = "app-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M12 7v10M7 12h10"/></svg>';
    const title = document.createElement("h2");
    title.className = "app-title";
    title.textContent = app.name;
    head.append(icon, title);

    const content = document.createElement("div");
    content.className = "app-content";
    const description = document.createElement("p");
    description.className = "app-desc";
    description.textContent = app.description || "追加アプリです。";
    content.append(description);

    if (app.category) {
      const category = document.createElement("span");
      category.className = "app-category";
      category.textContent = app.category;
      content.appendChild(category);
    }
    inner.append(head, content);
    card.appendChild(inner);
    applyStatus(card, app.status, app.message);
    return card;
  }

  function applyConfig(rawConfig) {
    const config = validateConfig(rawConfig);
    const usedIds = new Set(standardCards.keys());
    const additionalApps = [];
    let hasItemErrors = false;

    Object.entries(config.apps).forEach(([id, appConfig]) => {
      try {
        if (!standardCards.has(id)) throw new ConfigError("unknown standard app id");
        if (!isPlainObject(appConfig)) throw new ConfigError("app setting must be an object");
        applyStatus(
          standardCards.get(id),
          validateStatus(appConfig.status),
          optionalString(appConfig.message, "message")
        );
      } catch (error) {
        hasItemErrors = true;
        console.warn(`[portal-config] apps.${id}: ${error.message}`);
      }
    });

    config.additionalApps.forEach((item, configIndex) => {
      try {
        if (!isPlainObject(item)) throw new ConfigError("app definition must be an object");
        const app = {
          id: requiredString(item.id, "id"),
          name: requiredString(item.name, "name"),
          path: validatePath(item.path),
          description: optionalString(item.description, "description"),
          status: validateStatus(item.status),
          message: optionalString(item.message, "message"),
          category: optionalString(item.category, "category"),
          order: item.order,
          configIndex
        };
        if (usedIds.has(app.id)) throw new ConfigError("duplicate app id");
        if (app.order !== undefined && !Number.isFinite(app.order)) {
          throw new ConfigError("order must be a finite number");
        }
        usedIds.add(app.id);
        additionalApps.push(app);
      } catch (error) {
        hasItemErrors = true;
        console.warn(`[portal-config] additionalApps[${configIndex}]: ${error.message}`);
      }
    });

    additionalApps.sort((left, right) => {
      const leftOrder = left.order === undefined ? Number.POSITIVE_INFINITY : left.order;
      const rightOrder = right.order === undefined ? Number.POSITIVE_INFINITY : right.order;
      return leftOrder - rightOrder || left.configIndex - right.configIndex;
    });
    additionalApps.forEach((app, index) => grid.appendChild(createAdditionalCard(app, index)));

    if (hasItemErrors) {
      setNotice("一部の設定を適用できなかったため、有効な設定だけを反映しています。");
    }
  }

  function normalizeText(value) {
    return String(value || "")
      .toLowerCase()
      .normalize("NFKC")
      .replace(/\s+/g, "");
  }

  function filterApps() {
    const keyword = normalizeText(input.value);
    let visibleCount = 0;

    grid.querySelectorAll(".app-card").forEach((card) => {
      const searchableText = normalizeText(
        card.textContent + " " + (card.dataset.keywords || "")
      );

      const matches = !keyword || searchableText.includes(keyword);

      card.classList.toggle("search-hidden", !matches);

      if (!card.hidden && matches) {
        visibleCount++;
      }
    });

    empty.classList.toggle("active", visibleCount === 0);
  }

  input.addEventListener("input", filterApps);

  async function loadConfig() {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 3000);
    try {
      const response = await fetch("./portal-config.json", {
        cache: "no-cache",
        headers: { Accept: "application/json" },
        signal: controller.signal
      });
      if (response.status === 404) return;
      if (!response.ok) throw new ConfigError(`HTTP ${response.status}`);
      applyConfig(await response.json());
    } catch (error) {
      console.error("[portal-config] 設定を読み込めませんでした。", error);
      setNotice("設定を読み込めなかったため、同梱構成で表示しています。");
    } finally {
      window.clearTimeout(timeout);
      window.clearTimeout(window.__appboxConfigFallbackTimer);
      // 設定によるhiddenだけに連動し、検索によるsearch-hiddenとは切り離す。
      const qrCard = standardCards.get("qrcode");
      qrTrademark.hidden = !qrCard || qrCard.hidden;
      document.documentElement.classList.remove("portal-config-loading");
      filterApps();
    }
  }

  loadConfig();
})();
