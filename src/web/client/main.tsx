import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import { DesktopApp } from "./desktop";
import "./styles.css";
import "./desktop.css";

const container = document.getElementById("root");
if (!container) throw new Error("missing #root container");
createRoot(container).render(
  <React.StrictMode>
    {new URLSearchParams(window.location.search).has("desktop") ? <DesktopApp /> : <App />}
  </React.StrictMode>,
);
