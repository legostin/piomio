// The note on a frame: once the hub has taken a frame, a small card opens next to it where the person says what the
// place means (one chip at most) and why (typed, or dictated: while the card is open the lesson's voice goes into it).
// The frame is already in the recording; the card adds to that step (POST teach/step), so closing it never loses the
// frame. Enter, the tick, Escape or a press anywhere else close it and save; the bin takes the frame out.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MutableRefObject, SyntheticEvent } from "react";
import { Check, Trash2 } from "lucide-react";
import { IconButton } from "./chrome.tsx";
import { host, MARKS, t, touchScreen, type Mark } from "./host.ts";
import { placeNote, type Box } from "./note-place.ts";

/** Where the lesson's voice goes while a note is open: words that began in [since, until) are the note's. */
export interface Dictation {
  since: number;
  /** When the card closed (null: still open). Words that began before it still belong to the note. */
  until: number | null;
  put(words: string): void;
}

/** What the notes and the lesson share: the note taking dictation, and the saves still on their way (Done waits). */
export interface NoteLink {
  target: Dictation | null;
  saves: Set<Promise<unknown>>;
}

export const newNoteLink = (): NoteLink => ({ target: null, saves: new Set() });

/** POST teach/step; true when the hub took the change. Tracked in `link`, so Done can wait for it. */
export function postStep(link: NoteLink | null, body: Record<string, unknown>): Promise<boolean> {
  const p = host.plugin
    .http<{ ok?: boolean; error?: string }>("POST", "teach/step", body)
    .then((r) => !!r?.ok)
    .catch(() => false);
  if (link) {
    link.saves.add(p);
    void p.finally(() => link.saves.delete(p));
  }
  return p;
}

/** One chip per meaning; a tap on the chosen one takes it back. */
export function MarkChips({ value, onChange }: { value: Mark | null; onChange(mark: Mark | null): void }) {
  return (
    <div className="obb-chips" role="group" aria-label={t("ui.mark.label")}>
      {MARKS.map((m) => (
        <button key={m} type="button" className="obb-chip" aria-pressed={value === m} title={t(`ui.markHint.${m}`)} onClick={() => onChange(value === m ? null : m)}>
          {t(`ui.mark.${m}`)}
        </button>
      ))}
    </div>
  );
}

const stop = (e: SyntheticEvent) => e.stopPropagation();

export function FrameNote(props: {
  /** The frame's step (POST teach/step). */
  step: number;
  /** When the frame was drawn: words said since then are the note's. */
  since: number;
  /** The lesson's microphone is on: the field says so. */
  voice: boolean;
  link: MutableRefObject<NoteLink>;
  /** The frame and the layer in the layer's pixels (null until they are known). */
  frame: Box | null;
  layer: { width: number; height: number } | null;
  /** Close the card (it saves on its way out). `keys`: by the keyboard or a button, so the keys go back to the page. */
  onClose(keys: boolean): void;
  onError(text: string): void;
}) {
  const { step, link } = props;
  const [text, setText] = useState("");
  const [mark, setMark] = useState<Mark | null>(null);
  const [size, setSize] = useState({ width: 392, height: 104 });
  const textRef = useRef("");
  const markRef = useRef<Mark | null>(null);
  const saved = useRef<{ note: string; mark: Mark | null }>({ note: "", mark: null });
  const open = useRef(true);
  const removed = useRef(false);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const live = useRef(props);
  live.current = props;

  /** What changed since the last save goes to the hub. */
  const save = () => {
    if (removed.current) return;
    const note = textRef.current.trim();
    const m = markRef.current;
    const body: Record<string, unknown> = { id: step };
    if (note !== saved.current.note) body.note = note;
    if (m !== saved.current.mark) body.mark = m;
    if (Object.keys(body).length === 1) return;
    saved.current = { note, mark: m };
    void postStep(link.current, body).then((ok) => {
      if (!ok) live.current.onError(t("ui.note.failed"));
    });
  };

  // The lesson's voice goes here while the card is open; words that began before it closed still arrive after.
  useEffect(() => {
    open.current = true;
    const d: Dictation = {
      since: props.since,
      until: null,
      put: (words) => {
        if (removed.current || !words.trim()) return;
        const next = [textRef.current.trim(), words.trim()].filter(Boolean).join(" ");
        textRef.current = next;
        if (open.current) setText(next);
        else save();
      },
    };
    link.current.target = d;
    return () => {
      open.current = false;
      d.until = Date.now();
      save();
    };
  }, [step]);

  // A keyboard: the field is ready to type into. A phone shows its keyboard only when the person taps the field.
  useEffect(() => {
    if (!touchScreen()) inputRef.current?.focus();
  }, [step]);

  // Fingers and the wheel stay in the card: the page's zoom, scroll and keyboard never see them.
  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const keep = (e: Event) => e.stopPropagation();
    const names = ["touchstart", "touchmove", "touchend", "touchcancel", "wheel"];
    names.forEach((n) => el.addEventListener(n, keep));
    return () => names.forEach((n) => el.removeEventListener(n, keep));
  }, []);

  // A press anywhere else closes the card (and goes on to what was pressed); Escape closes it, not the live view.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (cardRef.current?.contains(e.target as Node)) return;
      live.current.onClose(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      live.current.onClose(true);
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, []);

  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const next = { width: el.offsetWidth, height: el.offsetHeight };
    if (next.width && next.height && (next.width !== size.width || next.height !== size.height)) setSize(next);
  });

  const choose = (m: Mark | null) => {
    markRef.current = m;
    setMark(m);
    save();
  };
  const remove = () => {
    removed.current = true;
    void postStep(link.current, { id: step, remove: true }).then((ok) => {
      if (!ok) live.current.onError(t("ui.note.failed"));
    });
    props.onClose(true);
  };

  const place = props.frame && props.layer ? placeNote(props.frame, props.layer, size) : null;

  return (
    <div
      ref={cardRef}
      className="obb-note"
      role="group"
      aria-label={t("ui.note.label")}
      style={place ? { left: place.left, top: place.top } : { visibility: "hidden" }}
      onPointerDown={stop}
      onPointerMove={stop}
      onPointerUp={stop}
      onMouseDown={stop}
      onMouseUp={stop}
      onMouseMove={stop}
      onClick={stop}
      onDoubleClick={stop}
      onKeyDown={stop}
      onKeyUp={stop}
      onPaste={stop}
    >
      <MarkChips value={mark} onChange={choose} />
      <div className="obb-note-row">
        <textarea
          ref={inputRef}
          className="obb-note-field"
          rows={2}
          value={text}
          placeholder={t(props.voice ? "ui.note.placeholderVoice" : "ui.note.placeholder")}
          aria-label={t("ui.note.label")}
          maxLength={500}
          onChange={(e) => {
            textRef.current = e.target.value;
            setText(e.target.value);
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
            e.preventDefault();
            props.onClose(true);
          }}
        />
        <div className="obb-note-buttons">
          <IconButton label={t("ui.note.done")} className="obb-note-done" onClick={() => props.onClose(true)}>
            <Check />
          </IconButton>
          <IconButton label={t("ui.note.remove")} onClick={remove}>
            <Trash2 />
          </IconButton>
        </div>
      </div>
    </div>
  );
}
