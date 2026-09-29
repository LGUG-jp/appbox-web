(() => {
  "use strict";

  window.EXCALIDRAW_ASSET_PATH = new URL(
    "./assets/",
    window.location.href
  ).href;

  window.EXCALIDRAW_EXPORT_SOURCE =
    window.location.origin + window.location.pathname;

  const isExternal = (url) => {
    try {
      const parsed = new URL(
        String(url),
        window.location.href
      );

      return (
        /^https?:$/.test(parsed.protocol) &&
        parsed.origin !== window.location.origin
      );
    } catch {
      return false;
    }
  };

  const notifyExternalBlocked = () => {
    window.dispatchEvent(
      new CustomEvent("oyakudachi:external-blocked")
    );
  };

  // 同梱フォントの画像出力などに必要な読込みだけを許可する。
  // GitHub Pagesでも、外部画像の取得やライブラリ投稿を送信前に止める。
  const originalFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    try {
      const isRequest = input instanceof Request;
      const url = new URL(isRequest ? input.url : String(input), window.location.href);
      const method = String(init?.method || (isRequest ? input.method : "GET")).toUpperCase();
      const localHttp = /^https?:$/.test(url.protocol) && url.origin === window.location.origin;
      const localData = url.protocol === "data:" ||
        (url.protocol === "blob:" && url.origin === window.location.origin);
      if (!(["GET", "HEAD"].includes(method) && (localHttp || localData))) {
        notifyExternalBlocked();
        return Promise.reject(new TypeError("このアプリでは外部通信・データ送信を使用できません。"));
      }
      // 同一オリジンURLから外部へのHTTPリダイレクトも追わない。
      return originalFetch(input, { ...init, redirect: "error" });
    } catch (error) {
      return Promise.reject(error);
    }
  };

  document.addEventListener(
    "click",
    (event) => {
      const target =
        event.target instanceof Element
          ? event.target
          : event.target?.parentElement;

      const anchor = target?.closest?.("a[href]");
      if (!anchor) {
        return;
      }

      const href = anchor.getAttribute("href");

      if (href && isExternal(href)) {
        event.preventDefault();
        event.stopPropagation();
        notifyExternalBlocked();
      }
    },
    true
  );

  const originalOpen = window.open.bind(window);

  window.open = (url, ...args) => {
    const targetUrl = url == null ? "" : String(url);

    if (targetUrl && isExternal(targetUrl)) {
      notifyExternalBlocked();
      return null;
    }

    return originalOpen(url, ...args);
  };

  window.addEventListener(
    "oyakudachi:external-blocked",
    () => {
      const message =
        "このアプリでは外部サイトへのリンク・通信やデータ送信を利用できません。";

      if (typeof window.oyakudachiShowNotice === "function") {
        window.oyakudachiShowNotice(message, 3000);
        return;
      }

      const notice = document.querySelector(".notice");
      if (!notice) {
        return;
      }

      notice.textContent = message;
      notice.classList.add("show");
    }
  );
})();
