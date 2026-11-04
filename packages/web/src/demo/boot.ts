// The demo's entry (demo.html). Before any of the app's modules load: the interface language of the page that embeds
// the demo, and the service worker that serves pictures and tiles. Then start.tsx brings up the demo hub and the app.

import { readParams, type FromDemo } from "./protocol";
import { disableCache } from "../lib/cache";

const params = readParams(location.search);

/** What the checks read when the demo runs on its own page: the last report, and every one in order. */
declare global {
  interface Window {
    __demo?: { last?: FromDemo; log: FromDemo[] };
  }
}
window.__demo = { log: [] };

function report(m: FromDemo): void {
  window.__demo!.last = m;
  window.__demo!.log.push(m);
  if (window.parent !== window) window.parent.postMessage(m, location.origin);
}

async function serviceWorker(): Promise<boolean> {
  if (!("serviceWorker" in navigator)) return false;
  try {
    await navigator.serviceWorker.register(new URL("demo-sw.js", document.baseURI), { scope: "./" });
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller)
      await new Promise<void>((resolve) => {
        navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true });
        setTimeout(resolve, 3000);
      });
    return !!navigator.serviceWorker.controller;
  } catch (e) {
    console.warn("[demo] no service worker", e);
    return false;
  }
}

try {
  // Every chapter starts as the app would on a first visit: the views a previous chapter left (the sidebar's tab, the
  // live view's corner, drafts) go. The app's keys are "ob.*"; the page around the demo keeps its own.
  for (const store of [localStorage, sessionStorage])
    for (const key of Object.keys(store)) if (key.startsWith("ob.")) store.removeItem(key);
  // The app reads this before anything else: the demo speaks the page's language, whatever the browser's.
  localStorage.setItem("piomio.locale", params.lang);
} catch {
  /* storage blocked: the hub language (the same) still applies */
}

// Every chapter is a first visit for the device's copy of the hub too (lib/cache.ts): none is kept or read.
disableCache();

const sw = await serviceWorker();
if (!sw) report({ source: "piomio-demo", type: "failed", chapter: params.chapter, message: "no service worker" });
const { start } = await import("./start");
await start(params, report);
