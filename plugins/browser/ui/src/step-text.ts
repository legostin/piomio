// A recorded step in the person's words, for the list of steps in the teach bar. The hub sends the steps as they are
// (server/recorder.ts); what the agent reads is the hub's own English (stepText there). Pure.

import type { LessonStep } from "./host.ts";

type Translate = (key: string, params?: Record<string, string | number>) => string;

const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const quoted = (s: string) => `«${s}»`;

function hostAndPath(url: string): string {
  try {
    const u = new URL(url);
    return u.host.replace(/^www\./, "") + (u.pathname === "/" ? "" : u.pathname);
  } catch {
    return url;
  }
}

/** The control a step acted on: its name, or what stands in for one. */
function what(s: LessonStep, t: Translate): string {
  const target = s.target;
  if (target?.frame) return t("ui.step.inFrame", { site: target.frame });
  return target?.name ? quoted(cut(target.name, 60)) : t("ui.step.unnamed");
}

export function stepLine(s: LessonStep, t: Translate): string {
  switch (s.kind) {
    case "page":
      return t("ui.step.page", { page: s.title ? cut(s.title, 70) : hostAndPath(s.url ?? "") });
    case "click": {
      const count = s.count ?? 1;
      if (s.button === "right") return t("ui.step.clickRight", { what: what(s, t) });
      if (count === 2) return t("ui.step.clickDouble", { what: what(s, t) });
      if (count > 2) return t("ui.step.clickTimes", { what: what(s, t), count });
      return t("ui.step.click", { what: what(s, t) });
    }
    case "type":
      return s.secret ? t("ui.step.typeSecret", { what: what(s, t) }) : t("ui.step.type", { value: cut(s.value ?? "", 60), what: what(s, t) });
    case "key":
      return t("ui.step.key", { key: (s.count ?? 1) > 1 ? `${s.key} ×${s.count}` : (s.key ?? "") });
    case "tab":
      return t(s.action === "new" ? "ui.step.tabNew" : s.action === "close" ? "ui.step.tabClose" : "ui.step.tabSwitch");
    case "scroll":
      return t("ui.step.scroll");
    case "file":
      return t("ui.step.file", { names: (s.names ?? []).map((n) => cut(n, 40)).join(", ") });
    case "highlight":
      return s.text ? t("ui.step.highlight", { text: cut(s.text, 90) }) : t("ui.step.highlightEmpty");
    case "say":
      return t("ui.step.say", { text: s.text ?? "" });
  }
}

/** What the person may change on a step: its words (a `say`), a note (anything but a page), taking it out. */
export const canRemove = (s: LessonStep) => s.kind !== "page";
export const canNote = (s: LessonStep) => s.kind !== "page" && s.kind !== "say";
