import React from "react";
import { createRoot } from "react-dom/client";
import { MobileApp } from "./mobile";
import "./mobile.css";

const container = document.getElementById("root");
if (!container) throw new Error("missing #root container");
createRoot(container).render(
  <React.StrictMode>
    <MobileApp />
  </React.StrictMode>,
);

// Register the service worker so the console installs as a home-screen app and
// reopens offline with the last screen. Same-origin and relative to the shell,
// so it works behind the relay's /m/ path and any reverse-proxy prefix. The
// worker never caches the live API, so a reopened app is not showing stale
// task state. Guarded: a plain http LAN link is not a secure context, and
// registration there is simply skipped rather than throwing.
if ("serviceWorker" in navigator && window.isSecureContext) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch(() => {
      // Offline-capability is a bonus; the console works without the worker.
    });
  });
}
