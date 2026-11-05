// Actual production panels with local fixture data. No hub, authentication or native commands.
import { desktopApp } from "../src/lib/desktop";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { LibrarySheet } from "../src/components/LibrarySheet";
import { PageViewer } from "../src/pages/chat/PageCard";
import { SettingsPanel } from "../src/components/SettingsPanel";
import { Modal } from "../src/components/ui";
import { openLibrary } from "../src/state/library";
import { openPanel } from "../src/state/panel";
import { pages } from "../src/state/pages";
import { agents, groups } from "../src/state/app";
import { CommandPalette, openPalette } from "../src/components/CommandPalette";
import { LiveViewWindow } from "../src/components/LiveViewWindow";
import { MediaViewer } from "../src/components/viewer/MediaViewer";
import { MapCard } from "../src/pages/chat/MapCard";
import { addContribution, addLiveView, registry } from "../src/plugins/registry";
import { liveWindowActions } from "../src/plugins/liveview";
import { RightPane } from "../src/plugins/slots";
import { addFiles, pendingFiles } from "../src/state/attachments";
import { openViewer } from "../src/state/viewer";
import "../src/index.css";

const params = new URLSearchParams(location.search);
if (params.get("platform") === "phone") {
  Reflect.deleteProperty(window, "piomioDesktop");
  document.documentElement.classList.add("owl-mobile");
} else if (desktopApp()?.overlayTitleBar) document.documentElement.classList.add("owl-titlebar");
const page = { id: "test", title: "Piomio: backlog", agentId: "assistant", createdAt: "2026-11-05T00:00:00Z", updatedAt: "2026-11-05T00:00:00Z", url: "about:blank", version: 1 };
pages.set([]);
agents.set([]);
groups.set([]);
if (params.get("panel") === "library") openLibrary("assistant");
if (params.get("panel") === "settings") openPanel();
if (params.get("panel") === "palette") openPalette();
if (params.get("panel") === "plugin") addContribution("fixture", "pane.right", { id: "fixture", title: "Plugin pane", component: () => <p>Plugin content</p> });
if (params.get("panel") === "live") {
  addLiveView("fixture", { id: "fixture", title: "Live view", component: () => <p>Live content</p> }).update({ active: true });
  liveWindowActions.expand(registry.get().liveViews[0].key);
}
if (["media", "edit"].includes(params.get("panel") ?? "")) {
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 400;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "#256d70";
  context.fillRect(0, 0, 640, 400);
  const blob = await new Promise<Blob>(resolve => canvas.toBlob(blob => resolve(blob!), "image/png"));
  addFiles("fixture", [new File([blob], "fixture.png", { type: "image/png" })]);
  openViewer({ kind: "pending", conversationId: "fixture" }, `pending:${pendingFiles("fixture")[0].id}`, { edit: params.get("panel") === "edit" });
}

function Fixture() {
  const [open, setOpen] = useState(true);
  return <>
    <div style={{ position: "fixed", inset: 0, background: "#ff00ff" }}>Underlying chat must stay covered</div>
    {params.get("panel") === "library" && <LibrarySheet />}
    {params.get("panel") === "page" && open && <PageViewer page={page} conversationId="fixture" onClose={() => setOpen(false)} />}
    {params.get("panel") === "settings" && <SettingsPanel />}
    {params.get("panel") === "modal" && <Modal open={open} title="Connection card" onClose={() => setOpen(false)}><div style={{ height: "150vh" }}>Tall card</div></Modal>}
    {params.get("panel") === "plugin" && <div style={{ position: "relative", display: "flex", height: "100dvh", justifyContent: "flex-end" }}><RightPane open={open} onClose={() => setOpen(false)} /></div>}
    {params.get("panel") === "live" && <LiveViewWindow />}
    {params.get("panel") === "palette" && <CommandPalette />}
    {["media", "edit"].includes(params.get("panel") ?? "") && <MediaViewer />}
    {params.get("panel") === "map" && <div style={{ position: "relative", paddingTop: 100 }}><MapCard part={{ type: "map", lat: 43.2, lon: 76.9, title: "Fixture map" }} /></div>}
  </>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
