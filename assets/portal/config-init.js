document.documentElement.classList.add("portal-config-loading");
window.__appboxConfigFallbackTimer = window.setTimeout(() => {
  document.documentElement.classList.remove("portal-config-loading");
}, 4000);
