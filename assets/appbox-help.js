/**
 * お役立ちアプリBOX 共通ヘルプスクリプト (appbox-help.js)
 *
 * - 目次（スリムナビゲーション）のスクロール連動ハイライト (Scrollspy)
 * - 外部依存なし、コンテンツ量や画面高に左右されない安定した追従
 */
(function () {
  "use strict";

  function initHelpScrollspy() {
    var navLinks = document.querySelectorAll(".appbox-help-nav-link");
    if (!navLinks || navLinks.length === 0) {
      return;
    }

    var targets = [];
    navLinks.forEach(function (link) {
      var href = link.getAttribute("href");
      if (href && href.charAt(0) === "#") {
        var id = href.slice(1);
        var element = document.getElementById(id);
        if (element) {
          targets.push({ link: link, element: element, id: id });
        }
      }
    });

    if (targets.length === 0) {
      return;
    }

    function setActive(activeId) {
      targets.forEach(function (target) {
        if (target.id === activeId) {
          target.link.classList.add("is-active");
          target.link.setAttribute("aria-current", "true");
        } else {
          target.link.classList.remove("is-active");
          target.link.removeAttribute("aria-current");
        }
      });
    }

    var isClickScrolling = false;
    var clickTimeout = null;

    // 目次クリック時の即時反映とスムーズスクロール中の誤判定防止
    targets.forEach(function (target) {
      target.link.addEventListener("click", function () {
        setActive(target.id);
        isClickScrolling = true;
        if (clickTimeout) {
          clearTimeout(clickTimeout);
        }
        clickTimeout = setTimeout(function () {
          isClickScrolling = false;
          updateScrollspy();
        }, 600);
      });
    });

    var ticking = false;
    function updateScrollspy() {
      if (isClickScrolling) {
        return;
      }

      var scrollY = window.pageYOffset || document.documentElement.scrollTop;
      var viewportHeight = window.innerHeight;
      var scrollHeight = document.documentElement.scrollHeight;
      var isAtBottom = (viewportHeight + scrollY) >= (scrollHeight - 15);

      // 読書判定ライン（画面上部から120px）
      var readingLine = 120;
      var activeId = targets[0].id;

      for (var i = 0; i < targets.length; i++) {
        var rect = targets[i].element.getBoundingClientRect();
        if (rect.top <= readingLine) {
          activeId = targets[i].id;
        }
      }

      // 最下端に到達しており、かつ最後のセクションが画面内に十分（画面上部65%以内）に入っている場合
      if (isAtBottom && targets.length > 1) {
        var lastTarget = targets[targets.length - 1];
        var lastRect = lastTarget.element.getBoundingClientRect();
        if (lastRect.top <= viewportHeight * 0.65) {
          activeId = lastTarget.id;
        }
      }

      setActive(activeId);
    }

    function onScroll() {
      if (!ticking) {
        window.requestAnimationFrame(function () {
          updateScrollspy();
          ticking = false;
        });
        ticking = true;
      }
    }

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });

    // 初期状態の判定
    var hash = window.location.hash;
    if (hash && hash.length > 1) {
      var initialId = hash.slice(1);
      var matched = targets.some(function (t) { return t.id === initialId; });
      if (matched) {
        setActive(initialId);
        return;
      }
    }
    updateScrollspy();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initHelpScrollspy);
  } else {
    initHelpScrollspy();
  }
})();
