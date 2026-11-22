import * as React from "react";
import * as ReactDOM from "react-dom";
import * as ReactDOMClient from "react-dom/client";
import * as JsxRuntime from "react/jsx-runtime";
import { uiRuntime } from "./plugins/runtime";
import { applyMobileDocument, mobileMode } from "./lib/mobile";
import { applyDesktopDocument, guardFileDrops } from "./lib/desktop";
import { App } from "./App";
import "./index.css";

// The iOS app's chat page (/m/*): its viewport and look, before anything renders.
if (mobileMode) applyMobileDocument();
// The desktop app's window without a title bar: room for its buttons.
applyDesktopDocument();
// Files dropped beside the chat are not opened in place of the hub.
guardFileDrops();

// Shared instances for UI plugins: the import map points "react", "react-dom", "@piomio/ui", ... at
// /shared/*.js shims that read from here. Must be set before any UI plugin module is imported.
window.__PIOMIO_SHARED__ = {
  react: React,
  reactDom: ReactDOM,
  reactDomClient: ReactDOMClient,
  jsxRuntime: JsxRuntime,
  ui: uiRuntime,
};

ReactDOMClient.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
