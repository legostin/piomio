// Everything that is not the conversation itself lives in the settings panel next to the chat.
// Old page URLs (/brains, /plugins, …) still work: they open the matching panel section over the chat.

import type { ComponentType } from "react";
import { Bot, Brain, Inbox, Laptop, ListChecks, Puzzle, Server, SlidersHorizontal, Smartphone, Sparkles, type LucideProps } from "lucide-react";
import type { MessageKey } from "../i18n";

export type CoreSection = "settings" | "agents" | "brains" | "plugins" | "machines" | "devices" | "mcp" | "skills" | "tasks" | "notifications";
/** A core section, or "plugin:<route key>" for a page a UI plugin added to the navigation. */
export type PanelSection = CoreSection | `plugin:${string}`;

export interface SectionDef {
  id: CoreSection;
  /** Legacy page URL that opens this section. */
  path: string;
  label: MessageKey;
  hint: MessageKey;
  icon: ComponentType<LucideProps>;
  group: "assistant" | "activity" | "connections" | "general";
}

export const SECTIONS: SectionDef[] = [
  { id: "agents", path: "/agents", label: "nav.agents", hint: "panel.hint.agents", icon: Bot, group: "assistant" },
  { id: "skills", path: "/skills", label: "nav.skills", hint: "panel.hint.skills", icon: Sparkles, group: "assistant" },
  { id: "tasks", path: "/tasks", label: "nav.tasks", hint: "panel.hint.tasks", icon: ListChecks, group: "activity" },
  { id: "notifications", path: "/inbox", label: "nav.notifications", hint: "panel.hint.notifications", icon: Inbox, group: "activity" },
  { id: "plugins", path: "/plugins", label: "nav.plugins", hint: "panel.hint.plugins", icon: Puzzle, group: "connections" },
  { id: "brains", path: "/brains", label: "nav.brains", hint: "panel.hint.brains", icon: Brain, group: "connections" },
  { id: "machines", path: "/machines", label: "nav.machines", hint: "panel.hint.machines", icon: Laptop, group: "connections" },
  { id: "devices", path: "/devices", label: "nav.devices", hint: "panel.hint.devices", icon: Smartphone, group: "connections" },
  { id: "mcp", path: "/mcp-servers", label: "nav.mcp", hint: "panel.hint.mcp", icon: Server, group: "connections" },
  { id: "settings", path: "/settings", label: "nav.general", hint: "panel.hint.settings", icon: SlidersHorizontal, group: "general" },
];

export const GROUPS: Array<{ id: SectionDef["group"]; label: MessageKey }> = [
  { id: "assistant", label: "panel.group.assistant" },
  { id: "activity", label: "panel.group.activity" },
  { id: "connections", label: "panel.group.connections" },
  { id: "general", label: "panel.group.general" },
];

/** Page URLs of sections that became part of another: the integrations catalog is the Plugins catalog now. */
const MERGED: Record<string, CoreSection> = { "/integrations": "plugins", "/notifications": "notifications" };

/** The panel section a legacy page URL stands for, if any. */
export function sectionForPath(path: string): CoreSection | undefined {
  const p = path.replace(/\/+$/, "") || "/";
  return SECTIONS.find((s) => s.path === p)?.id ?? MERGED[p];
}

export function sectionDef(id: PanelSection): SectionDef | undefined {
  return SECTIONS.find((s) => s.id === id);
}
