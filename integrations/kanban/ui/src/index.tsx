// The kanban page, and its cards in the chat.

import { definePluginUI } from "@piomio/ui";
import { BoardPage } from "./BoardPage.tsx";
import { Icon, setUI, t, UI } from "./shared.tsx";
import { addStyles } from "./styles.ts";
import { BoardWidget, CardWidget } from "./widgets.tsx";

function SidebarLink() {
  return (
    <button type="button" className="kb-nav" onClick={() => UI.navigate("/kanban")}>
      <Icon name="board" size={16} />
      {t("ui.title")}
    </button>
  );
}

export default definePluginUI((ui) => {
  setUI(ui);
  addStyles();
  const offs = [
    // Not a page of the settings panel (nav): a board needs the width of the whole view, so it has a place in the sidebar.
    ui.routes.add({ path: "/kanban", title: ui.i18n.t("ui.title"), icon: "square-kanban", nav: false, component: BoardPage }),
    ui.slots.register("layout.sidebar", { id: "kanban", title: ui.i18n.t("ui.title"), icon: "square-kanban", component: SidebarLink }),
    ui.widgets.add("card", CardWidget),
    ui.widgets.add("board", BoardWidget),
  ];
  return () => offs.forEach((off) => off());
});
