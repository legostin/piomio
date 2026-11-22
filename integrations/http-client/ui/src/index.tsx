// The HTTP page, and a response as a card in the chat.

import { definePluginUI } from "@piomio/ui";
import { HttpPage } from "./HttpPage.tsx";
import { Icon, setUI, t, UI } from "./shared.tsx";
import { addStyles } from "./styles.ts";
import { ResponseWidget } from "./widgets.tsx";

function SidebarLink() {
  return (
    <button type="button" className="hc-nav" onClick={() => UI.navigate("/http")}>
      <Icon name="send" size={16} />
      {t("ui.title")}
    </button>
  );
}

export default definePluginUI((ui) => {
  setUI(ui);
  addStyles();
  const offs = [
    // Not a page of the settings panel (nav): a request and its response need the width of the whole view.
    ui.routes.add({ path: "/http", title: ui.i18n.t("ui.title"), icon: "send", nav: false, component: HttpPage }),
    ui.slots.register("layout.sidebar", { id: "http-client", title: ui.i18n.t("ui.title"), icon: "send", component: SidebarLink }),
    ui.widgets.add("response", ResponseWidget),
  ];
  return () => offs.forEach((off) => off());
});
