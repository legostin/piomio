// The media viewer: a chat's pictures and videos full screen, over everything (on the phone the app hides its own
// header too). Pinch, the wheel or a double tap zooms, a drag moves a zoomed picture, a swipe goes to the next item,
// a drag down closes; the picture grows out of its thumbnail and goes back into it. Pictures waiting in the composer
// can be marked up here before they are sent. Motion lives in stage.ts; this file lays out and draws the controls.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, Download, ExternalLink, ImageOff, Loader2, PenLine, RotateCcw, X, ZoomIn, ZoomOut } from "lucide-react";
import { createStore, useStore, type Store } from "../../lib/store";
import { fitSize, type Size } from "../../lib/zoom";
import type { MediaItem } from "../../lib/gallery";
import { native, openOutside } from "../../lib/native";
import { markupOf, replaceWithMarked } from "../../state/attachments";
import { closeViewer, indexOfKey, saveMedia, useGallery, viewer as viewerStore, type ViewerState } from "../../state/viewer";
import { toast } from "../../state/toast";
import { errorText } from "../../lib/api";
import { cx } from "../ui";
import { t } from "../../i18n";
import { GAP, Stage, type Current, type StageHost } from "./stage";
import { bakeMarkup, EditBar, EditTop, InkLayer, newInk, TextField, useInkDrawing, type Ink, type InkSettings } from "./Markup";

type Box = Current["box"];

/** A picture being marked up: the file, and the picture the marks are drawn over (its own object URL, or the preview). */
interface EditSession {
  fileId: string;
  sourceUrl: string;
  ownUrl: boolean;
  name: string;
  type: string;
}

/** Picture sizes the page already knows, by source (a thumbnail in the chat decoded it). */
const known = new Map<string, Size>();
const probed = new Set<string>();

/** The size of a picture the browser already holds, without loading it again. */
function knownSize(src: string): Size | undefined {
  const hit = known.get(src);
  if (hit || probed.has(src) || typeof Image === "undefined") return hit;
  probed.add(src);
  const img = new Image();
  img.src = src;
  if (img.complete && img.naturalWidth > 0) {
    const s = { w: img.naturalWidth, h: img.naturalHeight };
    known.set(src, s);
    return s;
  }
  // Not in memory: the slide loads it, with progress.
  img.src = "";
  return undefined;
}

const coarse = () => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

/** The thumbnail an item opened from, in the chat or the composer. */
function thumbnail(key: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-media-key="${CSS.escape(key)}"]`);
}

/** Sizes guessed from a chat preview (its proportions, the hub's preview side), until the picture itself loads. */
const guessed = new Map<string, Size>();
/** The longest side of the hub's previews (preview-image.ts): a preview this big stands for a larger picture. */
const PREVIEW_SIDE = 720;

const sameUrl = (a: string, b: string) => {
  try {
    return new URL(a, location.href).href === new URL(b, location.href).href;
  } catch {
    return false;
  }
};

/**
 * The thumbnail's own picture, already decoded: the item itself, or its preview (`data-full` names the item). Hub
 * files come with `no-cache`, so a new <img> waits for the hub to say "not modified"; meanwhile the viewer draws this
 * one, and knows the picture's size (or, from a preview, its proportions) at once, so it can grow out of the thumbnail.
 */
function posterOf(key: string, src: string): HTMLImageElement | undefined {
  const el = thumbnail(key);
  const img = el instanceof HTMLImageElement ? el : el?.querySelector("img");
  if (!img || !img.complete || !img.naturalWidth) return undefined;
  const size = { w: img.naturalWidth, h: img.naturalHeight };
  if (sameUrl(img.currentSrc || img.src, src)) {
    if (!known.has(src)) known.set(src, size);
    return img;
  }
  if (!img.dataset.full || !sameUrl(img.dataset.full, src)) return undefined;
  // A smaller preview is the picture itself, at its own size; a full-size one may stand for a picture of any size.
  const k = Math.max(size.w, size.h) >= PREVIEW_SIDE ? 4 : 1;
  if (!known.has(src)) guessed.set(src, { w: size.w * k, h: size.h * k });
  return img;
}

export function MediaViewer() {
  const state = useStore(viewerStore);
  return state ? <Viewer key={state.id} state={state} /> : null;
}

function Viewer({ state }: { state: ViewerState }) {
  const items = useGallery(state.source);
  const [key, setKey] = useState(state.key);
  const index = indexOfKey(items, key);
  const item: MediaItem | undefined = items[index];
  const conversationId = state.source.kind === "list" ? undefined : state.source.conversationId;

  const root = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLDivElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const stage = useRef<Stage | null>(null);
  const frames = useRef(new Map<string, HTMLDivElement>());
  const [size, setSize] = useState<Size>({ w: innerWidth, h: innerHeight });
  const [fitArea, setFitArea] = useState<Box>({ cx: innerWidth / 2, cy: innerHeight / 2, w: innerWidth, h: innerHeight });
  const [measured, setMeasured] = useState(false);
  const [naturals, setNaturals] = useState<Record<string, Size>>({});
  const posters = useRef(new Map<string, HTMLImageElement | null>());
  const posterFor = (it: MediaItem): HTMLImageElement | undefined => {
    if (it.kind !== "image") return undefined;
    if (!posters.current.has(it.key)) posters.current.set(it.key, posterOf(it.key, it.src) ?? null);
    return posters.current.get(it.key) ?? undefined;
  };
  // The opened item's thumbnail, before anything measures it.
  if (item) posterFor(item);
  const [chrome, setChrome] = useState(true);
  const [dragging, setDragging] = useState(false);
  // The picture's scale changes every frame of a gesture: only the zoom read-out listens to it.
  const zoom = useMemo(() => createStore(1), []);
  const [zoomedIn, setZoomedIn] = useState(false);
  const [closing, setClosing] = useState(false);
  const touch = useMemo(coarse, []);

  // ---------- marking up ----------
  const ink = useMemo(() => createStore<Ink>(newInk([])), []);
  /** Marking `it` up: its marks so far go into the ink, the session names the picture they are drawn over. */
  const beginEdit = (it: MediaItem): EditSession | null => {
    const m = it.fileId ? markupOf(it.fileId) : undefined;
    if (!m || !it.fileId) return null;
    ink.set(newInk(m.shapes));
    // Marks are drawn over the picture as picked: a file not marked yet is that picture already on screen.
    return { fileId: it.fileId, sourceUrl: m.marked ? URL.createObjectURL(m.source) : it.src, ownUrl: m.marked, name: it.name ?? "", type: m.source.type };
  };
  // Opened from a chip's pencil: marking up from the first frame.
  const [editing, setEditing] = useState<EditSession | null>(() => (state.edit && item ? beginEdit(item) : null));
  const [saving, setSaving] = useState(false);
  const [settings, setSettings] = useState<InkSettings>(() => lastSettings);
  const editRef = useRef(editing);
  editRef.current = editing;

  const natural = (it: MediaItem | undefined, src?: string): Size | undefined =>
    it ? (naturals[it.key] ?? known.get(src ?? it.src) ?? (it.kind === "image" ? (knownSize(src ?? it.src) ?? guessed.get(src ?? it.src)) : undefined)) : undefined;
  const srcOf = (it: MediaItem) => (editing && it.fileId === editing.fileId ? editing.sourceUrl : it.src);
  const boxOf = (it: MediaItem | undefined): Box => {
    const n = it ? natural(it, srcOf(it)) : undefined;
    const f = n ? fitSize(n, fitArea) : { w: Math.min(fitArea.w, 360), h: Math.min(fitArea.h, 240) };
    return { cx: fitArea.cx, cy: fitArea.cy, w: f.w, h: f.h };
  };

  const requestClose = useCallback(() => {
    setClosing(true);
    stage.current?.close();
  }, []);

  const drawing = useInkDrawing(ink, settings, () => (item ? (natural(item, srcOf(item)) ?? { w: 1, h: 1 }) : { w: 1, h: 1 }), () => stage.current?.scale() ?? 1, () => {
    const it = item;
    return it ? boxOf(it).w : 1;
  });

  // The stage asks through `host`; it always sees the latest render's values.
  const hostRef = useRef<StageHost>(null!);
  hostRef.current = {
    canStep: (dir) => !editRef.current && index + dir >= 0 && index + dir < items.length,
    step: (dir) => {
      const next = items[index + dir];
      if (next) setKey(next.key);
    },
    closed: () => closeViewer(),
    origin: () => {
      const el = item ? thumbnail(item.key) : null;
      if (!el) return undefined;
      return { rect: el.getBoundingClientRect(), radius: parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0 };
    },
    tap: () => setChrome((v) => !v),
    zoomed: (s) => {
      zoom.set(s);
      setZoomedIn(s > 1.01);
    },
    dragging: (on) => setDragging(on),
    draw: editing ? drawing : undefined,
  };

  // The stage, once the overlay is in the DOM.
  useLayoutEffect(() => {
    const host: StageHost = {
      canStep: (d) => hostRef.current.canStep(d),
      step: (d) => hostRef.current.step(d),
      closed: () => hostRef.current.closed(),
      origin: () => hostRef.current.origin(),
      tap: () => hostRef.current.tap(),
      zoomed: (s) => hostRef.current.zoomed(s),
      dragging: (on) => hostRef.current.dragging(on),
      get draw() {
        return hostRef.current.draw;
      },
    };
    const s = new Stage(root.current!, track.current!, host);
    stage.current = s;
    return () => {
      s.destroy();
      stage.current = null;
    };
  }, []);

  // The screen and the room the picture fits in (smaller while marking up: the tools need space).
  useLayoutEffect(() => {
    const measure = () => {
      const r = root.current?.getBoundingClientRect();
      const a = area.current?.getBoundingClientRect();
      if (!r || !a) return;
      setSize({ w: r.width, h: r.height });
      setFitArea({ cx: a.left - r.left + a.width / 2, cy: a.top - r.top + a.height / 2, w: a.width, h: a.height });
      setMeasured(true);
      stage.current?.resize({ w: r.width, h: r.height });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(root.current!);
    ro.observe(area.current!);
    return () => ro.disconnect();
  }, []);

  // The current item's frame, wherever React put it. Marking up moves it smoothly into its new room.
  const box = boxOf(item);
  const n = natural(item, item ? srcOf(item) : undefined);
  const lastMode = useRef(!!editing);
  const lastKey = useRef(key);
  useLayoutEffect(() => {
    const s = stage.current;
    if (!s) return;
    const el = item ? frames.current.get(item.key) : undefined;
    const modeChanged = lastMode.current !== !!editing;
    lastMode.current = !!editing;
    s.edit = !!editing;
    s.setCurrent(el ? { el, box, natural: n ?? { w: box.w, h: box.h }, zoomable: item!.kind === "image" && !!n } : undefined, modeChanged);
    if (lastKey.current !== key) {
      lastKey.current = key;
      s.stepped();
    }
  }, [item?.key, key, box.cx, box.cy, box.w, box.h, n?.w, n?.h, !!editing]);

  // Opening, once the room is measured (still before the first paint): out of the thumbnail when the picture is
  // ready to show, otherwise a quick fade.
  const opened = useRef(false);
  useLayoutEffect(() => {
    const s = stage.current;
    if (!s || !measured || opened.current) return;
    opened.current = true;
    const el = item ? thumbnail(item.key) : null;
    const ready = !!item && item.kind === "image" && !!n;
    s.open(ready && el ? { rect: el.getBoundingClientRect(), radius: parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0 } : undefined);
  }, [measured]);

  // The thumbnail of what is shown steps aside while the viewer is open (the picture is "lifted" out of the chat).
  useEffect(() => {
    const el = item ? thumbnail(item.key) : null;
    if (!el) return;
    el.style.visibility = "hidden";
    return () => {
      el.style.visibility = "";
    };
  }, [item?.key]);

  // Full screen: the page under it holds still, the composer steps aside, the phone app hides its header.
  useEffect(() => {
    const restore = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.classList.add("owl-map-full");
    native?.call("fullscreen", { on: true }).catch(() => {});
    closeBtn.current?.focus({ preventScroll: true });
    return () => {
      document.body.style.overflow = overflow;
      document.documentElement.classList.remove("owl-map-full");
      native?.call("fullscreen", { on: false }).catch(() => {});
      restore?.focus?.({ preventScroll: true });
    };
  }, []);

  // The item went away (a file taken out of the composer, a message deleted): the viewer closes.
  useEffect(() => {
    if (!item && !closing) closeViewer();
  }, [item, closing]);

  // ---------- marking up: start, finish ----------

  function startEdit(it: MediaItem) {
    const session = beginEdit(it);
    if (!session) return;
    setEditing(session);
    setChrome(true);
    stage.current?.fit();
  }

  const endEdit = useCallback(() => {
    const e = editRef.current;
    if (e?.ownUrl) URL.revokeObjectURL(e.sourceUrl);
    setEditing(null);
    setSaving(false);
    ink.set(newInk([]));
  }, [ink]);

  useEffect(
    () => () => {
      const e = editRef.current;
      if (e?.ownUrl) URL.revokeObjectURL(e.sourceUrl);
    },
    [],
  );

  const cancelEdit = () => {
    if (state.edit) return requestClose();
    endEdit();
  };

  const finishEdit = async () => {
    const e = editRef.current;
    if (!e || !conversationId || saving) return;
    drawing.commitText();
    const { shapes, changed } = ink.get();
    if (!changed) {
      if (state.edit) requestClose();
      return endEdit();
    }
    setSaving(true);
    try {
      const baked = shapes.length ? await bakeMarkup(e.sourceUrl, shapes, e.name, e.type) : undefined;
      replaceWithMarked(conversationId, e.fileId, baked, shapes);
      // Back to the composer, the marks still drawn over the picture while it flies home: it looks just like the
      // marked copy now in the chip.
      requestClose();
    } catch (err) {
      setSaving(false);
      toast(t("markup.failed", { error: errorText(err) }), "error");
    }
  };

  useEffect(() => {
    lastSettings = settings;
  }, [settings]);

  // ---------- keys ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = stage.current;
      if (!s) return;
      const typing = e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement;
      const mod = e.metaKey || e.ctrlKey;
      let handled = true;
      if (e.key === "Shift") drawing.setShift(e.type === "keydown");
      if (e.type === "keyup") {
        if (e.key === " ") s.space = false;
        return;
      }
      if (typing) {
        if (e.key === "Escape") drawing.cancelText();
        else handled = false;
      } else if (e.key === "Escape") {
        if (editRef.current) cancelEdit();
        else requestClose();
      } else if (editRef.current) {
        if (mod && e.key.toLowerCase() === "z") drawing[e.shiftKey ? "redo" : "undo"]();
        else if (mod && e.key.toLowerCase() === "y") drawing.redo();
        else if (e.key === " ") s.space = true;
        else if (e.key === "Enter" && mod) void finishEdit();
        else handled = false;
      } else if (e.key === "ArrowRight") s.go(1);
      else if (e.key === "ArrowLeft") s.go(-1);
      else if (e.key === "+" || e.key === "=") s.zoomBy(1.6);
      else if (e.key === "-" || e.key === "_") s.zoomBy(1 / 1.6);
      else if (e.key === "0") s.fit();
      else if (e.key === "1") s.actualSize();
      else if (e.key === "Tab") trapFocus(e, root.current);
      else handled = false;
      if (handled && e.key !== "Tab") {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
    };
  });

  if (!item) return null;
  const many = items.length > 1;
  const showChrome = chrome && !dragging && !closing;
  const zoomable = item.kind === "image" && !!n && !editing;

  const glass = "pointer-events-auto inline-flex items-center justify-center rounded-full bg-black/45 text-white ring-1 ring-white/12 backdrop-blur-xl transition hover:bg-black/65 active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/70";

  const slides: ReactNode[] = [];
  for (let offset = -1; offset <= 1; offset++) {
    const it = items[index + offset];
    if (!it) continue;
    const src = srcOf(it);
    slides.push(
      <div key={it.key} className="absolute inset-0" style={{ transform: `translate3d(${offset * (size.w + GAP)}px, 0, 0)` }} aria-hidden={offset !== 0}>
        <Slide
          item={it}
          src={src}
          poster={src === it.src ? posterFor(it) : undefined}
          box={offset === 0 ? box : boxOf(it)}
          current={offset === 0}
          frameRef={(el) => {
            if (el) frames.current.set(it.key, el);
            else frames.current.delete(it.key);
          }}
          onNatural={(s) => {
            known.set(src, s);
            setNaturals((m) => (m[it.key]?.w === s.w && m[it.key]?.h === s.h ? m : { ...m, [it.key]: s }));
          }}
          overlay={
            editing && offset === 0 && n ? (
              <>
                <InkLayer store={ink} natural={n} />
                <TextField store={ink} drawing={drawing} natural={n} box={box} />
              </>
            ) : undefined
          }
        />
      </div>,
    );
  }

  return createPortal(
    <div
      ref={root}
      role="dialog"
      aria-modal="true"
      aria-label={item.caption || item.name || t("viewer.label")}
      className={cx("fixed inset-0 z-[55] touch-none overflow-hidden select-none", editing ? "cursor-crosshair" : zoomedIn ? "cursor-grab active:cursor-grabbing" : "")}
      style={{ ["--viewer-bg" as string]: "0" }}
    >
      <div className="absolute inset-0 bg-black" style={{ opacity: "var(--viewer-bg)" }} />
      {/* The room a picture fits in; measured, never seen. */}
      <div
        ref={area}
        aria-hidden
        className={cx(
          "pointer-events-none invisible absolute",
          editing
            ? "inset-x-3 top-[calc(env(safe-area-inset-top)+64px)] bottom-[calc(env(safe-area-inset-bottom)+150px)] sm:inset-x-20 sm:bottom-[calc(env(safe-area-inset-bottom)+96px)]"
            : "inset-0 sm:inset-x-20 sm:top-16 sm:bottom-20",
        )}
      />
      <div ref={track} className="absolute inset-0">
        {slides}
      </div>

      {/* The controls float over the picture; they fade with the backdrop while it is dragged away. */}
      <div data-viewer-ui className="pointer-events-none absolute inset-0" style={{ opacity: "var(--viewer-bg)" }}>
        <div className={cx("absolute inset-0 transition-opacity duration-200", showChrome ? "opacity-100" : "opacity-0 [&_*]:!pointer-events-none")}>
          {editing ? (
            <>
              <EditTop saving={saving} onCancel={cancelEdit} onDone={() => void finishEdit()} />
              <EditBar store={ink} settings={settings} onSettings={setSettings} onUndo={drawing.undo} onRedo={drawing.redo} />
            </>
          ) : (
            <>
              <div className="absolute inset-x-0 top-0 flex items-start gap-3 bg-gradient-to-b from-black/55 to-transparent px-3 pt-[max(0.75rem,env(safe-area-inset-top))] pb-10 sm:px-4">
                <div className="min-w-0 flex-1 pt-2 pl-1 text-white">
                  {many && <div className="text-[13px] font-semibold tabular-nums">{t("viewer.counter", { n: index + 1, total: items.length })}</div>}
                  {item.name && <div className="truncate text-xs text-white/70">{item.name}</div>}
                </div>
                {item.download && (
                  <button type="button" onClick={() => saveMedia(item)} className={cx(glass, "size-10")} aria-label={t("viewer.download")} title={t("viewer.download")}>
                    <Download className="size-[18px]" />
                  </button>
                )}
                {item.original && (
                  <a
                    href={item.original}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    onClick={(e) => openOutside(e, item.original)}
                    className={cx(glass, "size-10")}
                    aria-label={t("viewer.original")}
                    title={t("viewer.original")}
                  >
                    <ExternalLink className="size-[18px]" />
                  </a>
                )}
                <button ref={closeBtn} type="button" onClick={requestClose} className={cx(glass, "size-10")} aria-label={t("viewer.close")} title={t("viewer.close")}>
                  <X className="size-5" />
                </button>
              </div>

              {many && !touch && (
                <>
                  {index > 0 && (
                    <button type="button" onClick={() => stage.current?.go(-1)} className={cx(glass, "absolute top-1/2 left-4 size-11 -translate-y-1/2")} aria-label={t("viewer.prev")} title={t("viewer.prev")}>
                      <ChevronLeft className="size-5" />
                    </button>
                  )}
                  {index < items.length - 1 && (
                    <button type="button" onClick={() => stage.current?.go(1)} className={cx(glass, "absolute top-1/2 right-4 size-11 -translate-y-1/2")} aria-label={t("viewer.next")} title={t("viewer.next")}>
                      <ChevronRight className="size-5" />
                    </button>
                  )}
                </>
              )}

              <div className="absolute inset-x-0 bottom-0 flex flex-col items-center gap-3 bg-gradient-to-t from-black/55 to-transparent px-4 pt-10 pb-[max(1rem,env(safe-area-inset-bottom))]">
                {item.caption && <p className="max-w-2xl text-center text-sm leading-snug text-white/90">{item.caption}</p>}
                {(item.fileId || (zoomable && !touch)) && (
                  <div className="flex items-center gap-2">
                    {zoomable && !touch && n && <ZoomPill store={zoom} stage={stage} fitted={box.w} natural={n.w} />}
                    {item.fileId && item.kind === "image" && (
                      <button type="button" onClick={() => startEdit(item)} className="pointer-events-auto inline-flex h-10 items-center gap-2 rounded-full bg-accent px-4 text-sm font-semibold text-accent-fg shadow-lg transition hover:brightness-105 active:scale-95">
                        <PenLine className="size-4" />
                        {t("viewer.markup")}
                      </button>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

let lastSettings: InkSettings = { tool: "pen", color: "#ff3b30", size: 1 };

/** −, the scale in the picture's own pixels (a tap fits it or shows it 1:1), +. */
function ZoomPill({ store, stage, fitted, natural }: { store: Store<number>; stage: RefObject<Stage | null>; fitted: number; natural: number }) {
  const scale = useStore(store);
  const zoomed = scale > 1.01;
  const button = "inline-flex size-8 items-center justify-center rounded-full transition hover:bg-white/15 disabled:opacity-40";
  return (
    <div className="pointer-events-auto flex items-center rounded-full bg-black/45 p-1 text-white ring-1 ring-white/12 backdrop-blur-xl">
      <button type="button" onClick={() => stage.current?.zoomBy(1 / 1.6)} className={button} disabled={!zoomed} aria-label={t("viewer.zoomOut")} title={t("viewer.zoomOut")}>
        <ZoomOut className="size-4" />
      </button>
      <button type="button" onClick={() => (zoomed ? stage.current?.fit() : stage.current?.actualSize())} className="min-w-14 rounded-full px-1.5 text-center text-xs font-semibold tabular-nums transition hover:bg-white/15" title={t(zoomed ? "viewer.fit" : "viewer.actualSize")}>
        {Math.round((scale * fitted * 100) / Math.max(1, natural))}%
      </button>
      <button type="button" onClick={() => stage.current?.zoomBy(1.6)} className={button} aria-label={t("viewer.zoomIn")} title={t("viewer.zoomIn")}>
        <ZoomIn className="size-4" />
      </button>
    </div>
  );
}

/** Tab stays inside the viewer. */
function trapFocus(e: KeyboardEvent, root: HTMLElement | null): void {
  if (!root) return;
  const focusable = [...root.querySelectorAll<HTMLElement>("button:not([disabled]), a[href], textarea, video[controls]")].filter((el) => el.offsetParent !== null);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  } else if (!root.contains(document.activeElement)) {
    e.preventDefault();
    first.focus();
  }
}

// ---------- one item ----------

type Load = { status: "loading" | "ready" | "error"; progress?: number; url: string; fresh?: boolean };

/**
 * A picture, from memory when the page already has it, otherwise fetched with its progress and decoded before it is
 * shown (no half-drawn picture). `fresh`: it arrived after the viewer opened, so it fades in.
 */
function usePicture(src: string, enabled: boolean): Load & { retry: () => void } {
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<Load>(() => (knownSize(src) ? { status: "ready", url: src } : { status: "loading", url: "" }));
  useEffect(() => {
    if (!enabled) return;
    if (knownSize(src)) return setLoad({ status: "ready", url: src });
    let gone = false;
    let objectUrl = "";
    const controller = new AbortController();
    const local = /^(blob|data):/.test(src);
    // A picture already on screen stays there until the next one is ready (a marked copy replacing it, say).
    setLoad((l) => (l.status === "ready" ? l : { status: "loading", url: "" }));
    const show = async (url: string) => {
      const img = new Image();
      img.src = url;
      await img.decode();
      if (!gone) {
        known.set(src, { w: img.naturalWidth, h: img.naturalHeight });
        setLoad({ status: "ready", url, fresh: !local });
      }
    };
    (async () => {
      if (local) return show(src);
      const res = await fetch(src, { credentials: "same-origin", signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const total = Number(res.headers.get("content-length")) || 0;
      const reader = res.body?.getReader();
      let blob: Blob;
      if (!reader || !total) blob = await res.blob();
      else {
        const chunks: BlobPart[] = [];
        let got = 0;
        let shown = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          got += value.length;
          const p = got / total;
          if (p - shown >= 0.01 && !gone) {
            shown = p;
            setLoad((l) => (l.status === "ready" ? l : { status: "loading", url: "", progress: Math.min(1, p) }));
          }
        }
        blob = new Blob(chunks, { type: res.headers.get("content-type") ?? "" });
      }
      objectUrl = URL.createObjectURL(blob);
      await show(objectUrl);
    })().catch(() => {
      if (!gone && !controller.signal.aborted) setLoad({ status: "error", url: "" });
    });
    return () => {
      gone = true;
      controller.abort();
      if (objectUrl) setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    };
  }, [src, attempt, enabled]);
  return { ...load, retry: () => setAttempt((a) => a + 1) };
}

function Slide({
  item,
  src,
  poster,
  box,
  current,
  frameRef,
  onNatural,
  overlay,
}: {
  item: MediaItem;
  src: string;
  poster?: HTMLImageElement;
  box: Box;
  current: boolean;
  frameRef: (el: HTMLDivElement | null) => void;
  onNatural: (s: Size) => void;
  overlay?: ReactNode;
}) {
  const image = usePicture(src, item.kind === "image");
  // The thumbnail's picture stays under the viewer's own until that one has loaded.
  const [loaded, setLoaded] = useState<string>();
  const video = useRef<HTMLVideoElement>(null);
  const [late, setLate] = useState(false);
  const [videoState, setVideoState] = useState<"loading" | "ready" | "error">("loading");

  // A loader only for what takes a moment: a quick picture never flashes one.
  useEffect(() => {
    const id = setTimeout(() => setLate(true), 150);
    return () => clearTimeout(id);
  }, [src]);

  useEffect(() => {
    if (!current) video.current?.pause();
  }, [current]);

  const frameStyle = { left: box.cx - box.w / 2, top: box.cy - box.h / 2, width: box.w, height: box.h };
  const loading = item.kind === "image" ? image.status === "loading" : videoState === "loading";
  const failed = item.kind === "image" ? image.status === "error" : videoState === "error";

  return (
    <>
      <div ref={frameRef} className="absolute origin-center" style={frameStyle}>
        {poster && loaded !== image.url && <Poster img={poster} w={box.w} h={box.h} />}
        {item.kind === "image" && image.status === "ready" && (
          <img
            src={image.url}
            alt={item.caption ?? item.name ?? ""}
            draggable={false}
            decoding="async"
            onLoad={(e) => {
              setLoaded(image.url);
              onNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight });
            }}
            className={cx("relative block size-full select-none", image.fresh && "animate-fade")}
          />
        )}
        {item.kind === "video" && (
          <video
            ref={video}
            data-viewer-ui
            src={src}
            controls
            playsInline
            autoPlay={current}
            preload="metadata"
            onLoadedMetadata={(e) => {
              setVideoState("ready");
              const v = e.currentTarget;
              if (v.videoWidth > 0) onNatural({ w: v.videoWidth, h: v.videoHeight });
            }}
            onError={() => setVideoState("error")}
            className="block size-full bg-black"
          />
        )}
        {overlay}
      </div>
      {loading && late && (
        <div className="pointer-events-none absolute flex items-center justify-center" style={{ left: box.cx - 40, top: box.cy - 40, width: 80, height: 80 }} role="status" aria-label={t("viewer.loading")}>
          <Progress value={item.kind === "image" ? image.progress : undefined} />
        </div>
      )}
      {failed && (
        <div data-viewer-ui className="absolute flex flex-col items-center gap-3 text-center text-sm text-white/80" style={{ left: box.cx - 140, top: box.cy - 60, width: 280 }}>
          <ImageOff className="size-8 text-white/50" />
          {t("viewer.failed")}
          {item.kind === "image" && (
            <button type="button" onClick={image.retry} className="inline-flex h-9 items-center gap-1.5 rounded-full bg-white/15 px-4 font-medium text-white transition hover:bg-white/25">
              <RotateCcw className="size-4" />
              {t("viewer.retry")}
            </button>
          )}
        </div>
      )}
    </>
  );
}

/** A decoded picture drawn at the frame's size (sharp on a Retina screen, at most 2×). */
function Poster({ img, w, h }: { img: HTMLImageElement; w: number; h: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const k = Math.min(2, devicePixelRatio || 1);
    c.width = Math.max(1, Math.round(w * k));
    c.height = Math.max(1, Math.round(h * k));
    c.getContext("2d")?.drawImage(img, 0, 0, c.width, c.height);
  }, [img, w, h]);
  return <canvas ref={canvas} aria-hidden className="absolute inset-0 size-full" />;
}

/** A ring that fills as the picture arrives (a spinner while its size is unknown). */
function Progress({ value }: { value?: number }) {
  if (value === undefined)
    return (
      <span className="flex size-14 items-center justify-center rounded-full bg-black/40 text-white backdrop-blur">
        <Loader2 className="size-6 animate-spin" />
      </span>
    );
  const r = 22;
  const c = 2 * Math.PI * r;
  return (
    <span className="relative flex size-14 items-center justify-center rounded-full bg-black/40 text-white backdrop-blur">
      <svg viewBox="0 0 56 56" className="absolute inset-0 size-full -rotate-90">
        <circle cx="28" cy="28" r={r} fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
        <circle cx="28" cy="28" r={r} fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - value)} className="transition-[stroke-dashoffset] duration-200 ease-out" />
      </svg>
      <span className="text-[11px] font-semibold tabular-nums">{Math.round(value * 100)}%</span>
    </span>
  );
}
