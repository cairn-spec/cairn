(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root && root.document) api.install(root);
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";

  function viewportSize(win) {
    var viewport = win.visualViewport;
    var width = viewport && Number.isFinite(viewport.width)
      ? viewport.width
      : win.innerWidth;
    var height = viewport && Number.isFinite(viewport.height)
      ? viewport.height
      : win.innerHeight;
    return {
      width: Math.max(1, Math.round(width || 1)),
      height: Math.max(1, Math.round(height || 1))
    };
  }

  function install(win) {
    var doc = win.document;
    var container = doc.getElementById("canvas-container");
    if (!container) return null;

    var lastWidth = 0;
    var lastHeight = 0;
    var notifyPending = false;

    function notifyRenderer() {
      if (notifyPending) return;
      notifyPending = true;
      win.requestAnimationFrame(function () {
        notifyPending = false;
        win.dispatchEvent(new win.Event("resize"));
      });
    }

    function sync(force) {
      var size = viewportSize(win);
      var changed = Math.abs(size.width - lastWidth) > 1 ||
        Math.abs(size.height - lastHeight) > 1;
      if (!force && !changed) return false;

      lastWidth = size.width;
      lastHeight = size.height;
      doc.documentElement.style.setProperty(
        "--asm-visual-viewport-height",
        size.height + "px"
      );
      container.style.height = "var(--asm-visual-viewport-height)";
      notifyRenderer();
      return true;
    }

    var viewport = win.visualViewport;
    if (viewport) {
      viewport.addEventListener("resize", function () { sync(false); });
      viewport.addEventListener("scroll", function () { sync(false); });
    }
    win.addEventListener("orientationchange", function () { sync(true); });
    win.addEventListener("pageshow", function () { sync(true); });
    doc.addEventListener("visibilitychange", function () {
      if (!doc.hidden) sync(true);
    });

    // Some iOS browser chrome changes do not emit a page resize event. This
    // inexpensive check catches those transitions and then wakes PlayCanvas.
    win.setInterval(function () { sync(false); }, 500);
    sync(true);

    return { sync: sync, viewportSize: function () { return viewportSize(win); } };
  }

  return { install: install, viewportSize: viewportSize };
});
