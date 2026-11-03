// UI of the Pio plugin: Pio's window (a bare page the desktop app shows over every app, /pio/overlay), and in the
// desktop app's main window the link that shows that window while the plugin is on.

import { definePluginUI } from "@piomio/ui";
import { desktopOf } from "./desktop.ts";
import { Overlay } from "./overlay/Overlay.tsx";

export default definePluginUI((ui) => {
  const offRoute = ui.routes.add({ path: "/pio/overlay", title: "Pio", bare: true, component: () => <Overlay ui={ui} /> });
  const d = desktopOf();
  const main = d && !d.pio ? d : undefined;
  if (main) location.href = `${main.scheme}://pio?show=1`;
  // "Open chat" in Pio's window: its chat here. Pio asked to come back (pio_show): its window shows again.
  const offOpen = main ? ui.plugin.on("open-chat", () => ui.navigate("/agent/pio")) : () => {};
  const offShow = main ? ui.plugin.on("show", () => (location.href = `${main.scheme}://pio?show=1`)) : () => {};
  return () => {
    offRoute();
    offOpen();
    offShow();
    if (main) location.href = `${main.scheme}://pio?show=0`;
  };
});
