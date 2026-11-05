// Marking a picture up before sending it: the marks drawn live over the picture (SVG in its own pixels, so they zoom
// with it), the words being typed, the tools, and baking it all into a new picture (lib/markup.ts).

import { useMemo, useRef } from "react";
import { Check, Circle, Highlighter, Loader2, MoveUpRight, Pen, Redo2, Square, Type, Undo2, type LucideIcon } from "lucide-react";
import type { Store } from "../../lib/store";
import { useStore } from "../../lib/store";
import {
  addPoint,
  arrowGeometry,
  bakeSize,
  boxOf,
  COLORS,
  constrain,
  contrastOf,
  cornerRadius,
  FONT,
  isMeaningful,
  MARKER_OPACITY,
  markedFile,
  renderMarkup,
  strokePath,
  strokeWidth,
  TEXT_LINE,
  textBaseline,
  textLines,
  textOutline,
  textSize,
  TOOLS,
  type Point,
  type Shape,
  type SizeIndex,
  type Tool,
} from "../../lib/markup";
import type { Size } from "../../lib/zoom";
import { cx } from "../ui";
import { t, type MessageKey } from "../../i18n";

export interface Ink {
  shapes: Shape[];
  /** What undo took back, for redo. */
  redo: Shape[];
  /** The mark being drawn. */
  draft?: Shape;
  /** Words being typed: where they start, in the picture's pixels. */
  text?: { id: number; at: Point; value: string; color: string; size: number };
  /** Anything changed since marking up started. */
  changed: boolean;
}

export interface InkSettings {
  tool: Tool;
  color: string;
  size: SizeIndex;
}

export const newInk = (shapes: Shape[]): Ink => ({ shapes, redo: [], changed: false });

export type Drawing = ReturnType<typeof useInkDrawing>;

let textSeq = 0;

/**
 * Drawing on `store` with the current settings: the stage calls start/move/end with the picture's pixels. The
 * getters give the picture's size and how big it is on screen now (a stroke keeps points ~1 screen pixel apart).
 */
export function useInkDrawing(store: Store<Ink>, settings: InkSettings, natural: () => Size, scale: () => number, boxWidth: () => number) {
  const live = useRef({ settings, natural, scale, boxWidth, shift: false });
  live.current = { ...live.current, settings, natural, scale, boxWidth };
  return useMemo(() => {
    const minStep = () => (1.2 * live.current.natural().w) / Math.max(1, live.current.boxWidth() * live.current.scale());
    const commitText = () => {
      const ink = store.get();
      const tx = ink.text;
      if (!tx) return;
      const shape: Shape = { kind: "text", color: tx.color, size: tx.size, at: tx.at, text: tx.value.replace(/\s+$/, "") };
      store.set(isMeaningful(shape) ? { ...ink, text: undefined, shapes: [...ink.shapes, shape], redo: [], changed: true } : { ...ink, text: undefined });
    };
    return {
      start(x: number, y: number) {
        const { tool, color, size } = live.current.settings;
        const n = live.current.natural();
        commitText();
        const ink = store.get();
        if (tool === "text") {
          const fs = textSize(size, n);
          focusProxy();
          store.set({ ...ink, text: { id: ++textSeq, at: [x, y - fs * 0.6], value: "", color, size: fs } });
          return;
        }
        const width = strokeWidth(tool, size, n);
        const draft: Shape = tool === "pen" || tool === "marker" ? { kind: tool, color, width, points: [x, y] } : { kind: tool, color, width, from: [x, y], to: [x, y] };
        store.set({ ...ink, draft });
      },
      move(x: number, y: number) {
        const ink = store.get();
        const d = ink.draft;
        if (!d || d.kind === "text") return;
        if ("points" in d) {
          const points = addPoint(d.points, x, y, minStep());
          if (points !== d.points) store.set({ ...ink, draft: { ...d, points } });
        } else store.set({ ...ink, draft: { ...d, to: live.current.shift ? constrain(d.kind, d.from, [x, y]) : [x, y] } });
      },
      end() {
        const ink = store.get();
        const d = ink.draft;
        if (!d) return;
        store.set(isMeaningful(d) ? { ...ink, draft: undefined, shapes: [...ink.shapes, d], redo: [], changed: true } : { ...ink, draft: undefined });
      },
      cancel() {
        const ink = store.get();
        if (ink.draft) store.set({ ...ink, draft: undefined });
      },
      undo() {
        commitText();
        const ink = store.get();
        const last = ink.shapes[ink.shapes.length - 1];
        if (last) store.set({ ...ink, shapes: ink.shapes.slice(0, -1), redo: [...ink.redo, last], changed: true });
      },
      redo() {
        const ink = store.get();
        const next = ink.redo[ink.redo.length - 1];
        if (next) store.set({ ...ink, shapes: [...ink.shapes, next], redo: ink.redo.slice(0, -1), changed: true });
      },
      commitText,
      cancelText() {
        const ink = store.get();
        if (ink.text) store.set({ ...ink, text: undefined });
      },
      typeText(id: number, value: string) {
        const ink = store.get();
        if (ink.text?.id === id) store.set({ ...ink, text: { ...ink.text, value } });
      },
      setShift(on: boolean) {
        live.current.shift = on;
      },
    };
  }, [store]);
}

/**
 * iOS shows the keyboard only for a field focused during the tap itself: a hidden field takes the focus at once and
 * hands it to the words' field when that appears.
 */
function focusProxy(): void {
  let el = document.getElementById("owl-focus-proxy") as HTMLTextAreaElement | null;
  if (!el) {
    el = document.createElement("textarea");
    el.id = "owl-focus-proxy";
    el.setAttribute("aria-hidden", "true");
    el.tabIndex = -1;
    el.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:16px;border:0;padding:0;pointer-events:none";
    document.body.append(el);
  }
  el.focus({ preventScroll: true });
}

// ---------- drawing them ----------

function ShapeView({ s }: { s: Shape }) {
  if (s.kind === "text") {
    return (
      <text
        x={s.at[0]}
        fontSize={s.size}
        fontWeight={700}
        fontFamily={FONT}
        fill={s.color}
        stroke={contrastOf(s.color)}
        strokeWidth={textOutline(s.size)}
        strokeLinejoin="round"
        paintOrder="stroke"
        style={{ whiteSpace: "pre" }}
      >
        {textLines(s.text).map((line, i) => (
          <tspan key={i} x={s.at[0]} y={s.at[1] + textBaseline(s.size, i)}>
            {line || " "}
          </tspan>
        ))}
      </text>
    );
  }
  const common = { stroke: s.color, strokeWidth: s.width, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, fill: "none" };
  if ("points" in s) {
    const opacity = s.kind === "marker" ? MARKER_OPACITY : undefined;
    if (s.points.length === 2) return <circle cx={s.points[0]} cy={s.points[1]} r={s.width / 2} fill={s.color} opacity={opacity} />;
    return <path d={strokePath(s.points)} {...common} opacity={opacity} />;
  }
  if (s.kind === "arrow") {
    const a = arrowGeometry(s.from, s.to, s.width);
    return (
      <g>
        <line x1={s.from[0]} y1={s.from[1]} x2={a.shaftEnd[0]} y2={a.shaftEnd[1]} {...common} />
        <polygon points={a.head.map((p) => p.join(",")).join(" ")} fill={s.color} stroke={s.color} strokeWidth={s.width * 0.5} strokeLinejoin="round" />
      </g>
    );
  }
  const b = boxOf(s.from, s.to);
  if (s.kind === "rect") return <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={cornerRadius(b, s.width)} {...common} />;
  return <ellipse cx={b.x + b.w / 2} cy={b.y + b.h / 2} rx={b.w / 2} ry={b.h / 2} {...common} />;
}

/** The marks over the picture, in its own pixels. */
export function InkLayer({ store, natural }: { store: Store<Ink>; natural: Size }) {
  const ink = useStore(store);
  return (
    <svg viewBox={`0 0 ${natural.w} ${natural.h}`} className="pointer-events-none absolute inset-0 size-full overflow-visible" aria-hidden>
      {ink.shapes.map((s, i) => (
        <ShapeView key={i} s={s} />
      ))}
      {ink.draft && <ShapeView s={ink.draft} />}
    </svg>
  );
}

/** The words being typed, where they will stand on the picture (it zooms with it). */
export function TextField({ store, drawing, natural, box }: { store: Store<Ink>; drawing: Drawing; natural: Size; box: { w: number } }) {
  const tx = useStore(store).text;
  if (!tx) return null;
  const k = box.w / natural.w;
  const fs = tx.size * k;
  // Below 16px iOS zooms the whole page into a focused field: the field is 16px, scaled down.
  const shrink = fs < 16 ? fs / 16 : 1;
  const lines = tx.value.split("\n");
  const cols = Math.max(3, ...lines.map((l) => l.length + 1));
  const outline = contrastOf(tx.color);
  return (
    <textarea
      key={tx.id}
      data-viewer-ui
      autoFocus
      value={tx.value}
      rows={lines.length}
      spellCheck={false}
      aria-label={t("markup.text")}
      onChange={(e) => drawing.typeText(tx.id, e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          drawing.commitText();
        }
      }}
      onBlur={() => {
        if (store.get().text?.id === tx.id) drawing.commitText();
      }}
      className="absolute m-0 resize-none overflow-hidden rounded-sm border-0 bg-black/10 p-0 font-bold outline-1 outline-white/70 outline-dashed"
      style={{
        left: tx.at[0] * k,
        top: tx.at[1] * k,
        fontSize: fs / shrink,
        transform: shrink < 1 ? `scale(${shrink})` : undefined,
        transformOrigin: "0 0",
        lineHeight: TEXT_LINE,
        fontFamily: FONT,
        color: tx.color,
        caretColor: tx.color,
        width: `${cols}ch`,
        whiteSpace: "pre",
        textShadow: `0 0 2px ${outline}, 0 0 2px ${outline}, 0 0 1px ${outline}`,
      }}
    />
  );
}

/** The picture with the marks baked in: the marked copy that replaces the file. */
export async function bakeMarkup(sourceUrl: string, shapes: Shape[], name: string, type: string): Promise<{ blob: Blob; name: string; type: string }> {
  const img = new Image();
  img.src = sourceUrl;
  await img.decode();
  const { w, h, k } = bakeSize({ w: img.naturalWidth, h: img.naturalHeight });
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas");
  const out = markedFile(name, type);
  // A JPEG has no transparency: what was clear becomes white rather than black.
  if (out.type === "image/jpeg") {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
  }
  ctx.drawImage(img, 0, 0, w, h);
  renderMarkup(ctx, shapes, k);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, out.type, 0.92));
  if (!blob) throw new Error("toBlob");
  return { blob, name: out.name, type: out.type };
}

// ---------- the tools ----------

const TOOL_ICON: Record<Tool, LucideIcon> = { pen: Pen, marker: Highlighter, arrow: MoveUpRight, rect: Square, ellipse: Circle, text: Type };
const TOOL_LABEL: Record<Tool, MessageKey> = {
  pen: "markup.pen",
  marker: "markup.marker",
  arrow: "markup.arrow",
  rect: "markup.rect",
  ellipse: "markup.ellipse",
  text: "markup.text",
};
const COLOR_LABEL: Record<(typeof COLORS)[number]["id"], MessageKey> = {
  red: "markup.color.red",
  yellow: "markup.color.yellow",
  green: "markup.color.green",
  blue: "markup.color.blue",
  white: "markup.color.white",
  black: "markup.color.black",
};
const SIZE_LABEL: MessageKey[] = ["markup.size.thin", "markup.size.medium", "markup.size.thick"];

const iconButton = "inline-flex size-9 shrink-0 items-center justify-center rounded-full transition active:scale-90 disabled:opacity-35 disabled:active:scale-100";

export function EditTop({ saving, onCancel, onDone }: { saving: boolean; onCancel: () => void; onDone: () => void }) {
  return (
    <div className="absolute inset-x-0 top-0 flex items-center justify-between bg-gradient-to-b from-black/55 to-transparent px-3 pt-[max(0.75rem,var(--owl-safe-top))] pb-8 sm:px-4">
      <button
        type="button"
        onClick={onCancel}
        className="pointer-events-auto h-10 rounded-full bg-black/45 px-4 text-sm font-medium text-white ring-1 ring-white/12 backdrop-blur-xl transition hover:bg-black/65 active:scale-95"
      >
        {t("markup.cancel")}
      </button>
      <button
        type="button"
        onClick={onDone}
        disabled={saving}
        className="pointer-events-auto inline-flex h-10 items-center gap-1.5 rounded-full bg-accent px-5 text-sm font-semibold text-accent-fg shadow-lg transition hover:brightness-105 active:scale-95 disabled:opacity-80"
      >
        {saving ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
        {t(saving ? "markup.saving" : "markup.done")}
      </button>
    </div>
  );
}

export function EditBar({
  store,
  settings,
  onSettings,
  onUndo,
  onRedo,
}: {
  store: Store<Ink>;
  settings: InkSettings;
  onSettings: (s: InkSettings) => void;
  onUndo: () => void;
  onRedo: () => void;
}) {
  const ink = useStore(store);
  const set = (p: Partial<InkSettings>) => onSettings({ ...settings, ...p });
  const divider = <span className="mx-1 h-6 w-px shrink-0 bg-white/15" aria-hidden />;
  return (
    <div className="absolute inset-x-0 bottom-0 flex justify-center px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      <div className="pointer-events-auto flex max-w-full flex-col items-center gap-1.5 rounded-[24px] bg-black/60 p-1.5 text-white shadow-2xl ring-1 ring-white/12 backdrop-blur-xl sm:flex-row sm:gap-0">
        <div className="flex items-center" role="radiogroup" aria-label={t("markup.tools")}>
          {TOOLS.map((tool) => {
            const Icon = TOOL_ICON[tool];
            const on = settings.tool === tool;
            return (
              <button
                key={tool}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => set({ tool })}
                className={cx(iconButton, on ? "bg-white text-black" : "hover:bg-white/15")}
                aria-label={t(TOOL_LABEL[tool])}
                title={t(TOOL_LABEL[tool])}
              >
                <Icon className="size-[18px]" />
              </button>
            );
          })}
          {divider}
          <button type="button" onClick={onUndo} disabled={!ink.shapes.length && !ink.text} className={cx(iconButton, "hover:bg-white/15")} aria-label={t("markup.undo")} title={t("markup.undo")}>
            <Undo2 className="size-[18px]" />
          </button>
          <button type="button" onClick={onRedo} disabled={!ink.redo.length} className={cx(iconButton, "hover:bg-white/15")} aria-label={t("markup.redo")} title={t("markup.redo")}>
            <Redo2 className="size-[18px]" />
          </button>
        </div>
        <span className="hidden sm:block">{divider}</span>
        <div className="flex items-center">
          <div className="flex items-center gap-0.5" role="radiogroup" aria-label={t("markup.colors")}>
            {COLORS.map((c) => {
              const on = settings.color === c.value;
              return (
                <button
                  key={c.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => set({ color: c.value })}
                  className={cx("inline-flex size-8 shrink-0 items-center justify-center rounded-full transition active:scale-90", on ? "ring-2 ring-white" : "hover:bg-white/10")}
                  aria-label={t(COLOR_LABEL[c.id])}
                  title={t(COLOR_LABEL[c.id])}
                >
                  <span className="size-5 rounded-full ring-1 ring-white/30" style={{ background: c.value }} />
                </button>
              );
            })}
          </div>
          {divider}
          <div className="flex items-center" role="radiogroup" aria-label={t("markup.thickness")}>
            {([0, 1, 2] as const).map((size) => {
              const on = settings.size === size;
              return (
                <button
                  key={size}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => set({ size })}
                  className={cx("inline-flex size-8 shrink-0 items-center justify-center rounded-full transition active:scale-90", on ? "bg-white/20" : "hover:bg-white/10")}
                  aria-label={t(SIZE_LABEL[size])}
                  title={t(SIZE_LABEL[size])}
                >
                  <span className="rounded-full" style={{ width: [5, 8, 12][size], height: [5, 8, 12][size], background: settings.color }} />
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
