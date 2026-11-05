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
import "../src/index.css";

if (desktopApp()?.overlayTitleBar) document.documentElement.classList.add("owl-titlebar");
const params = new URLSearchParams(location.search);
const page = { id: "test", title: "Piomio: backlog", agentId: "assistant", createdAt: "2026-11-05T00:00:00Z", updatedAt: "2026-11-05T00:00:00Z", url: "about:blank", version: 1 };
pages.set([]);
if (params.get("panel") === "library") openLibrary("assistant");
if (params.get("panel") === "settings") openPanel();

function Fixture() {
  const [open, setOpen] = useState(true);
  return <>
    <div style={{ position: "fixed", inset: 0, background: "#ff00ff" }}>Underlying chat must stay covered</div>
    {params.get("panel") === "library" && <LibrarySheet />}
    {params.get("panel") === "page" && open && <PageViewer page={page} conversationId="fixture" onClose={() => setOpen(false)} />}
    {params.get("panel") === "settings" && <SettingsPanel />}
    {params.get("panel") === "modal" && <Modal open={open} title="Connection card" onClose={() => setOpen(false)}><div style={{ height: "150vh" }}>Tall card</div></Modal>}
  </>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
