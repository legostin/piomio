// How an agent thinks in its dialog, right in the header: one control for the brain and the depth; its menu
// (ThinkingMenu.tsx) is the same one the /brain and /effort cards show in the chat.

import { useEffect, useRef, useState } from "react";
import { Brain, ChevronDown } from "lucide-react";
import type { AgentDef } from "@piomio/shared";
import { cx } from "../../components/ui";
import { t } from "../../i18n";
import { PRESET_ICONS, ThinkingMenu, useThinkingMenu } from "./ThinkingMenu";

export function BrainPicker({ agent }: { agent: AgentDef }) {
  const m = useThinkingMenu(agent);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  if (!m.list) return null;
  const { active, ready, chat, isExact, how, short, none } = m;
  const TriggerIcon = ready && chat?.preset && !isExact ? PRESET_ICONS[chat.preset] : Brain;

  return (
    <div ref={box} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`${t("thinking.label", { agent: agent.name })}: ${active ? [active.label, chat?.preset ? t(`thinking.preset.${chat.preset}`) : undefined, how].filter(Boolean).join(" · ") : none}`}
        className={cx(
          "press flex max-w-[12rem] items-center gap-1 rounded-full px-2 py-1 text-xs font-medium transition",
          ready ? "text-muted hover:bg-surface-2 hover:text-fg" : "border border-warning/40 bg-warning-soft/60 text-warning",
        )}
      >
        <TriggerIcon className="size-3.5 shrink-0" />
        {/* Quiet: the preset in a word (the brain only when none answers); a narrow bar keeps the icon. */}
        <span className="hidden truncate @lg/top:inline">{ready ? (short ?? active?.label) : (active?.label ?? none)}</span>
        <ChevronDown className={cx("size-3 shrink-0 opacity-60 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div role="menu" className="animate-in absolute top-full left-0 z-30 mt-1.5 max-h-[min(80vh,40rem)] w-80 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border border-border bg-surface p-1.5 shadow-card">
          <ThinkingMenu agent={agent} onClose={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}
