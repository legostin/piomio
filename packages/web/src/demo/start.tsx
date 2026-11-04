// Brings the demo up: the world for the chapter, the demo hub behind fetch and the socket, the real app on a memory
// location, and the director, steered by the page around the frame.

import * as React from "react";
import * as ReactDOM from "react-dom";
import * as ReactDOMClient from "react-dom/client";
import * as JsxRuntime from "react/jsx-runtime";
import { Router } from "wouter";
import { uiRuntime } from "../plugins/runtime";
import { agentPath } from "../lib/team";
import { App } from "../App";
import "../index.css";
import "./demo.css";
import { contentFor } from "./content";
import { Agents } from "./director/agents";
import { Clock } from "./director/clock";
import { Director } from "./director/director";
import { composer } from "./director/dom";
import { guardComposer } from "./guard";
import { DemoHub } from "./hub/hub";
import { registerRoutes } from "./hub/routes";
import { demoLocation } from "./location";
import type { DemoParams, FromDemo, ToDemo } from "./protocol";
import { chapterById } from "./scenarios";
import { installShims } from "./shims";
import { makeWorld } from "./world";

export async function start(params: DemoParams, report: (m: FromDemo) => void): Promise<void> {
  const content = contentFor(params.lang);
  const chapter = chapterById(params.chapter);
  const hub = new DemoHub(makeWorld(content));
  registerRoutes(hub, content.ui.notInDemo);
  // What happened before the chapter: in the world before the app first asks for it.
  chapter.setup?.({ h: new Agents(hub, new Clock(new AbortController().signal)), c: content });
  installShims(hub, hub);

  // Shared instances for the UI plugins, as main.tsx sets them up.
  window.__PIOMIO_SHARED__ = { react: React, reactDom: ReactDOM, reactDomClient: ReactDOMClient, jsxRuntime: JsxRuntime, ui: uiRuntime };

  const loc = demoLocation(agentPath(chapter.agent, hub.world.defaultAgent));
  ReactDOMClient.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <Router hook={loc.hook} searchHook={loc.searchHook}>
        <App />
      </Router>
    </React.StrictMode>,
  );

  const director = new Director(hub, content, { path: loc.path, go: loc.navigate }, report);
  window.addEventListener("message", (e: MessageEvent<ToDemo>) => {
    if (e.origin !== location.origin || e.data?.source !== "piomio-site") return;
    if (e.data.type === "play" && !director.playing) void director.play(chapter, params.speed);
    if (e.data.type === "pause") director.pause();
    if (e.data.type === "resume") director.resume();
  });

  // Ready once the dialog is on screen.
  while (!composer()) await new Promise((r) => setTimeout(r, 50));
  guardComposer(content.ui.demoNote);
  report({ source: "piomio-demo", type: "ready", chapter: chapter.id });
  if (params.autoplay) void director.play(chapter, params.speed);
}
