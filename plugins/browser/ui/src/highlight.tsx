// Highlight: the person draws a frame over the live picture to point at what matters ("look here"). While the mode is
// on, a layer over the picture takes the drag, so nothing reaches the page or the zoom; on release the frame goes to
// the hub in the picture's 0..1 coordinates (as input does, the zoom included) and the mode ends. Once the hub has
// taken it, the frame stays with a card next to it for a comment and for what the place means (note.tsx); a hub that
// names no step for the frame gets the old flash.

import { useEffect, useRef, useState } from "react";
import type { MutableRefObject, PointerEvent as ReactPointerEvent, SyntheticEvent } from "react";
import { SquareDashedMousePointer } from "lucide-react";
import { IconButton } from "./chrome.tsx";
import { host, send, t, touchScreen } from "./host.ts";
import { FrameNote, type NoteLink } from "./note.tsx";
import type { Box } from "./note-place.ts";

export interface Frame {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

type Point = { x: number; y: number };

/** Narrower or lower than this share of the picture, it was a slip, not a frame. */
const MIN_SIDE = 0.01;
const FLASH_MS = 700;
/** No answer from the hub in this time: the frame goes without a flash. */
const WAIT_MS = 6000;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** A point on the screen in the picture's box (0..1, the zoom included), exactly as Screen's pos() sends input. */
function toPicture(img: HTMLImageElement | null, p: { clientX: number; clientY: number }): Point {
  const r = img?.getBoundingClientRect();
  if (!r || !r.width || !r.height) return { x: 0, y: 0 };
  return { x: clamp01((p.clientX - r.left) / r.width), y: clamp01((p.clientY - r.top) / r.height) };
}

/** Two corners as a frame: ordered, inside the picture. */
export function frameOf(a: Point, b: Point): Frame {
  return { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) };
}

export const bigEnough = (f: Frame) => f.x1 - f.x0 >= MIN_SIDE && f.y1 - f.y0 >= MIN_SIDE;

export interface Highlight {
  /** Highlighting makes sense now (the person is in control of the large view, a page is open). */
  allowed: boolean;
  /** The next drag draws a frame. */
  on: boolean;
  toggle(): void;
  off(): void;
  /** The frame sent last, until it has flashed (ok) or the hub said nothing for a while. */
  sent: (Frame & { ok: boolean }) | null;
  submit(f: Frame): void;
  /** The frame the hub has taken, while its note is open: `step` names it there, `since` is when it was drawn. */
  note: { step: number; frame: Frame; since: number } | null;
  closeNote(): void;
}

/** The highlight mode of one view; `onError` shows a line in the view. */
export function useHighlight(allowed: boolean, onError: (text: string) => void): Highlight {
  const [on, setOn] = useState(false);
  const [sent, setSent] = useState<(Frame & { ok: boolean }) | null>(null);
  const [note, setNote] = useState<Highlight["note"]>(null);
  const pending = useRef(false);
  /** The frame sent last and when it was drawn. */
  const last = useRef<{ frame: Frame; at: number } | null>(null);
  const errorRef = useRef(onError);
  errorRef.current = onError;

  useEffect(() => {
    if (allowed) return;
    setOn(false);
    setNote(null);
  }, [allowed]);

  // The hub's answer to the frame this view sent (another open view of the browser ignores it).
  useEffect(
    () =>
      host.plugin.on("highlight", (r: { ok?: boolean; text?: string; step?: number }) => {
        if (!pending.current) return;
        pending.current = false;
        const drawn = last.current;
        if (r?.ok && typeof r.step === "number" && r.step > 0 && drawn) {
          setSent(null);
          setNote({ step: r.step, frame: drawn.frame, since: drawn.at });
        } else if (r?.ok) setSent((s) => (s ? { ...s, ok: true } : s));
        else {
          setSent(null);
          errorRef.current(t("ui.highlight.failed"));
        }
      }),
    [],
  );

  useEffect(() => {
    if (!sent) return;
    const timer = setTimeout(
      () => {
        pending.current = false;
        setSent(null);
      },
      sent.ok ? FLASH_MS : WAIT_MS,
    );
    return () => clearTimeout(timer);
  }, [sent]);

  return {
    allowed,
    on: on && allowed,
    toggle: () => setOn((v) => !v),
    off: () => setOn(false),
    sent,
    submit: (f) => {
      send({ type: "highlight", ...f });
      pending.current = true;
      last.current = { frame: f, at: Date.now() };
      setNote(null);
      setSent({ ...f, ok: false });
      setOn(false);
    },
    note: allowed ? note : null,
    closeNote: () => setNote(null),
  };
}

/** The Highlight toggle (the toolbar, the phone's bar, the teach bar); nothing while highlighting makes no sense. */
export function HighlightButton({ hl }: { hl: Highlight }) {
  if (!hl.allowed) return null;
  return (
    <IconButton label={hl.on ? t("ui.highlight.stop") : t("ui.highlight.label")} pressed={hl.on} className="obb-hl-btn" onClick={hl.toggle}>
      <SquareDashedMousePointer />
    </IconButton>
  );
}

const stop = (e: SyntheticEvent) => e.stopPropagation();

/** Over the picture area: takes the drag while the mode is on, shows the frame while it flashes or has its note open. */
export function HighlightLayer(props: {
  hl: Highlight;
  imgRef: MutableRefObject<HTMLImageElement | null>;
  /** The notes' link to the lesson (its voice, its Done). */
  link: MutableRefObject<NoteLink>;
  /** The lesson's microphone is on. */
  voice: boolean;
  onError(text: string): void;
}) {
  const { hl, imgRef } = props;
  const layerRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<{ id: number; a: Point; b: Point } | null>(null);
  const dragRef = useRef(drag);
  dragRef.current = drag;
  const [, redraw] = useState(0);
  const noteStep = hl.note?.step ?? null;

  // The note stays for a while: its frame follows the picture (the view resized, the zoom, the phone's keyboard).
  useEffect(() => {
    if (noteStep === null) return;
    let seen = "";
    const look = () => {
      const img = imgRef.current?.getBoundingClientRect();
      const layer = layerRef.current?.getBoundingClientRect();
      const now = img && layer ? [img.left, img.top, img.width, img.height, layer.left, layer.top, layer.width, layer.height].map(Math.round).join() : "";
      if (now === seen) return;
      seen = now;
      redraw((n) => n + 1);
    };
    look();
    const timer = setInterval(look, 200);
    return () => clearInterval(timer);
  }, [noteStep]);

  const closeNote = (keys: boolean) => {
    hl.closeNote();
    // Closed from the keyboard or a button: the keys are the page's again (a press elsewhere takes them itself).
    if (keys && !touchScreen()) imgRef.current?.closest<HTMLElement>(".obb-screen")?.focus();
  };

  useEffect(() => {
    if (!hl.on) setDrag(null);
  }, [hl.on]);

  // Fingers and the wheel stop here: the area's own listeners (keyboard on a tap, zoom) never see them.
  useEffect(() => {
    const el = layerRef.current;
    if (!el) return;
    const block = (e: Event) => {
      e.stopPropagation();
      if (e.cancelable) e.preventDefault();
    };
    const names = ["touchstart", "touchmove", "touchend", "touchcancel", "wheel"];
    names.forEach((n) => el.addEventListener(n, block, { passive: false }));
    return () => names.forEach((n) => el.removeEventListener(n, block));
  }, [hl.on]);

  // Escape leaves the mode (not the live view, not the page).
  useEffect(() => {
    if (!hl.on) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      hl.off();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [hl.on]);

  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    e.preventDefault();
    if (!hl.on || dragRef.current || (e.pointerType === "mouse" && e.button !== 0)) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* the pointer is already gone */
    }
    const p = toPicture(imgRef.current, e);
    setDrag({ id: e.pointerId, a: p, b: p });
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    const d = dragRef.current;
    if (!d || d.id !== e.pointerId) return;
    e.preventDefault();
    setDrag({ ...d, b: toPicture(imgRef.current, e) });
  };
  const onUp = (cancel: boolean) => (e: ReactPointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    const d = dragRef.current;
    if (!d || d.id !== e.pointerId) return;
    e.preventDefault();
    setDrag(null);
    if (cancel) return;
    const f = frameOf(d.a, toPicture(imgRef.current, e));
    // A tap or a slip: the mode stays on for a real frame.
    if (bigEnough(f)) hl.submit(f);
  };

  // The frame in the layer's own pixels, from the picture's box as it is now.
  const shown: (Frame & { cls: string }) | null = drag
    ? { ...frameOf(drag.a, drag.b), cls: "" }
    : hl.sent
      ? { ...hl.sent, cls: hl.sent.ok ? " is-ok" : " is-sent" }
      : hl.note
        ? { ...hl.note.frame, cls: " is-note" }
        : null;
  let box: Box | null = null;
  const img = imgRef.current?.getBoundingClientRect();
  const layer = layerRef.current?.getBoundingClientRect();
  if (shown && img && layer && img.width && img.height) {
    box = {
      left: img.left - layer.left + shown.x0 * img.width,
      top: img.top - layer.top + shown.y0 * img.height,
      width: (shown.x1 - shown.x0) * img.width,
      height: (shown.y1 - shown.y0) * img.height,
    };
  }

  return (
    <div
      ref={layerRef}
      className={`obb-hl${hl.on ? " is-on" : ""}`}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp(false)}
      onPointerCancel={onUp(true)}
      onMouseDown={stop}
      onMouseUp={stop}
      onMouseMove={stop}
      onClick={stop}
      onDoubleClick={stop}
      onContextMenu={(e) => {
        e.stopPropagation();
        if (hl.on) e.preventDefault();
      }}
    >
      {hl.on && !drag && <div className="obb-hl-hint">{t("ui.highlight.hint")}</div>}
      {shown && box && <div className={`obb-hl-frame${shown.cls}`} style={box} />}
      {hl.note && !drag && !hl.sent && (
        <FrameNote
          key={hl.note.step}
          step={hl.note.step}
          since={hl.note.since}
          voice={props.voice}
          link={props.link}
          frame={box}
          layer={layer ? { width: layer.width, height: layer.height } : null}
          onClose={closeNote}
          onError={props.onError}
        />
      )}
    </div>
  );
}
