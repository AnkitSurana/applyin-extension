// ──────────────────────────────────────────────────────────────────────────
// Applyin - central configuration (single source of truth)
//
// Change a value HERE and it takes effect everywhere: the popup, the in-page
// sidebar (content script), and the background service worker.
//
// This file is a PLAIN script (no ES export) so it can be loaded directly as a
// content script. Each context reads it as follows:
//   • inject.js (content) : config.js is listed BEFORE inject.js in the manifest
//                           content_scripts, exposing globalThis.APPLYIN_CONFIG.
//   • worker.js (module)  : import is done via a tiny re-export shim
//                           (config.module.js) so the worker stays a module.
//   • popup.js  (module)  : same shim.
//
// VERSION is NOT stored here. It is read live from
// chrome.runtime.getManifest().version, so manifest.json is the ONLY place a
// version number is set; every "vX.Y.Z" badge updates automatically on bump.
// ──────────────────────────────────────────────────────────────────────────

(function () {
  var SITE = "https://applyin.co.in";
  var CONFIG = {
    API_BASE: "https://applyin-backend.onrender.com",
    SITE: SITE,
    URLS: {
      privacy: SITE + "/privacy",
      terms:   SITE + "/terms",
      help:    SITE + "/help",
    },
    // Version accessor - the NUMBER itself lives only in manifest.json (Chrome
    // requires it there and treats it as the real version). Every screen reads it
    // through THIS one helper, so the displayed version is identical everywhere and
    // can never drift between manifest and a second copy. Returns "vX.Y.Z".
    getVersion: function () {
      try {
        return "v" + chrome.runtime.getManifest().version;
      } catch (e) {
        return "";
      }
    },
  };
  // Expose globally for every context (content script, worker importScripts, etc.)
  globalThis.APPLYIN_CONFIG = CONFIG;
  if (typeof window !== "undefined") window.APPLYIN_CONFIG = CONFIG;
})();
