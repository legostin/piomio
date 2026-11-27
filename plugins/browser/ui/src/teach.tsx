// Teach mode in the live view: while the person shows an agent a task, a thin bar says so (a red dot, what is being
// shown, the steps so far) and holds the microphone, Highlight, Done and Cancel. The voice goes to the hub in short
// recordings (voice.ts) and is written down there; Done waits for the last words before it ends the demonstration.
// While the note of a frame is open (note.tsx) the words go into that note instead. The count of steps opens the list
// of them (steps.tsx).

import { useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import { ChevronRight, Mic, MicOff, X } from "lucide-react";
import { Button, Spinner } from "@piomio/ui";
import { IconButton } from "./chrome.tsx";
import { HighlightButton, type Highlight } from "./highlight.tsx";
import { host, send, t, type TeachState } from "./host.ts";
import { dictationFor, type NoteLink } from "./note-link.ts";
import { blobToBase64, startVoice, VoiceError, type Segment, type Voice } from "./voice.ts";

/** How long a hint (no voice, the mic not allowed) stays in the bar. */
const HINT_MS = 8000;
/** Done waits at most this long for the words still being written down. */
const UPLOAD_WAIT_MS = 8000;
/** Done pressed and the hub did not end the demonstration: the button works again. */
const DONE_RETRY_MS = 15_000;
/** "Discard?" waits this long for the second press. */
const CONFIRM_MS = 3000;

export interface Lesson {
  mic: "off" | "starting" | "on";
  /** A line about the voice for a while (no speech-to-text, the mic not allowed, a failed recording). */
  hint: string | null;
  /** Done was pressed: the last words are going out. */
  finishing: boolean;
  /** The mic button: its ring follows the level (--lvl, 0…1). */
  ringRef: MutableRefObject<HTMLButtonElement | null>;
  toggleMic(): void;
  done(): void;
  cancel(): void;
}

function problemText(e: unknown): string {
  const problem = e instanceof VoiceError ? e.problem : "failed";
  if (problem === "denied") return t("ui.teach.micDenied");
  if (problem === "missing") return t("ui.teach.micMissing");
  if (problem === "unavailable") return t("ui.teach.micUnavailable");
  return t("ui.teach.voiceFailed", { detail: (e as Error)?.message || t("ui.error.generic") });
}

/**
 * A demonstration's voice and its Done / Cancel; runs while the view is open (the bar shows in the large view).
 * `link`: the notes of frames that take the words said into them, and the changes to steps still being saved.
 */
export function useLesson(teach: TeachState | null, link: MutableRefObject<NoteLink>): Lesson {
  const id = teach?.id ?? null;
  const speech = !!teach?.speech;
  const [want, setWant] = useState(false);
  const wantRef = useRef(want);
  wantRef.current = want;
  const [mic, setMic] = useState<Lesson["mic"]>("off");
  const [hint, setHint] = useState<string | null>(null);
  const [finishing, setFinishing] = useState(false);
  const ringRef = useRef<HTMLButtonElement | null>(null);
  const voice = useRef<Voice | null>(null);
  const uploads = useRef(new Set<Promise<void>>());

  // A new demonstration: the mic is on from the start when the hub can write speech down.
  useEffect(() => {
    setFinishing(false);
    setWant(!!id && speech);
    setHint(id && !speech ? t("ui.teach.noSpeech") : null);
  }, [id]);
  useEffect(() => {
    if (!speech) setWant(false);
  }, [speech]);

  useEffect(() => {
    if (!hint) return;
    const timer = setTimeout(() => setHint(null), HINT_MS);
    return () => clearTimeout(timer);
  }, [hint]);

  useEffect(() => {
    if (!finishing) return;
    const timer = setTimeout(() => setFinishing(false), DONE_RETRY_MS);
    return () => clearTimeout(timer);
  }, [finishing]);

  useEffect(() => {
    if (!id || !speech || !want) {
      setMic("off");
      return;
    }
    let live = true;
    let handle: Voice | null = null;
    setMic("starting");
    // The first failure says why and turns the mic off; answers still on their way say nothing more.
    const fail = (text: string) => {
      if (!live || !wantRef.current) return;
      setWant(false);
      setHint(text);
    };
    const post = async (seg: Segment) => {
      try {
        const data = await blobToBase64(seg.blob);
        // Words that began while a frame's note was open are that note's (also when it has closed and another has
        // opened since): the hub only writes them down.
        const note = dictationFor(link.current, seg.wordsAt);
        // durationMs: how long ago the words began; the hub places them at now - durationMs.
        const r = await host.plugin.http<{ text?: string; error?: string }>("POST", "teach/speech", {
          data,
          mimeType: seg.mimeType,
          durationMs: Math.max(0, Date.now() - seg.wordsAt),
          ...(note ? { only: true } : {}),
        });
        if (r && typeof r === "object" && r.error) fail(t("ui.teach.voiceFailed", { detail: r.error }));
        else if (note && r?.text) note.put(r.text);
      } catch (e) {
        fail(t("ui.teach.voiceFailed", { detail: (e as Error)?.message || t("ui.error.generic") }));
      }
    };
    const upload = (seg: Segment) => {
      const p = post(seg);
      uploads.current.add(p);
      void p.finally(() => uploads.current.delete(p));
      return p;
    };
    startVoice({ onLevel: (level) => ringRef.current?.style.setProperty("--lvl", level.toFixed(2)), upload }).then(
      (v) => {
        if (!live) return v.stop();
        handle = v;
        voice.current = v;
        setMic("on");
      },
      (e) => {
        if (!live) return;
        setWant(false);
        setHint(problemText(e));
      },
    );
    return () => {
      live = false;
      if (voice.current === handle) voice.current = null;
      // Turned off mid-sentence: the words said so far still go.
      void handle?.finish();
    };
  }, [id, speech, want]);

  return {
    mic,
    hint,
    finishing,
    ringRef,
    toggleMic: () => {
      setHint(null);
      setWant((w) => !w);
    },
    done: () => {
      if (finishing) return;
      setFinishing(true);
      void (async () => {
        await voice.current?.finish();
        // The words still being written down land before the demonstration ends.
        const left = [...uploads.current];
        if (left.length) await Promise.race([Promise.allSettled(left), new Promise((r) => setTimeout(r, UPLOAD_WAIT_MS))]);
        // A note still open (Done by the keyboard, or the last words went into it) saves what it holds; then the
        // changes to steps still on their way land too, from the notes and from the list of steps.
        link.current.flush?.();
        const notes = [...link.current.saves];
        if (notes.length) await Promise.race([Promise.allSettled(notes), new Promise((r) => setTimeout(r, UPLOAD_WAIT_MS))]);
        setWant(false);
        send({ type: "teach", action: "done" });
      })();
    },
    cancel: () => {
      voice.current?.stop();
      voice.current = null;
      setWant(false);
      send({ type: "teach", action: "cancel" });
    },
  };
}

function MicButton({ lesson }: { lesson: Lesson }) {
  const label = lesson.mic === "on" ? t("ui.teach.micMute") : lesson.mic === "starting" ? t("ui.teach.micStarting") : t("ui.teach.micOn");
  return (
    <button
      ref={lesson.ringRef}
      type="button"
      className={`obb-ib obb-mic is-${lesson.mic}`}
      aria-label={label}
      title={label}
      aria-pressed={lesson.mic !== "off"}
      onClick={lesson.toggleMic}
    >
      {lesson.mic === "off" ? <MicOff /> : <Mic />}
    </button>
  );
}

/** The bar on top of the page while the person is showing (desktop: under the toolbar; phone: under the address). */
export function TeachBar(props: { teach: TeachState; lesson: Lesson; hl: Highlight; phone: boolean; stepsOpen: boolean; onSteps(): void }) {
  const { teach, lesson, hl, phone } = props;
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (!confirm) return;
    const timer = setTimeout(() => setConfirm(false), CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [confirm]);

  const goal = teach.goal.trim();
  const title = goal ? t("ui.teach.showing", { goal }) : t("ui.teach.showingAgent");
  const tip = lesson.hint ?? (lesson.mic === "on" ? t("ui.teach.say") : null);
  // Nothing shown yet: nothing to lose. Otherwise the first press asks.
  const cancel = () => (teach.steps > 0 && !confirm ? setConfirm(true) : lesson.cancel());

  return (
    <div className={`obb-teach${phone ? " is-phone" : ""}`} role="region" aria-label={title}>
      <span className="obb-rec" aria-hidden />
      <div className="obb-teach-text" title={goal || undefined}>
        <span className="obb-teach-goal obb-trunc">{title}</span>
        <span className="obb-teach-sub obb-trunc">
          <button type="button" className="obb-teach-steps" aria-expanded={props.stepsOpen} title={t("ui.steps.open")} onClick={props.onSteps}>
            {t("ui.teach.steps", { count: teach.steps })}
            <ChevronRight aria-hidden />
          </button>
          {tip && <span> · {tip}</span>}
        </span>
      </div>
      {teach.speech && <MicButton lesson={lesson} />}
      <HighlightButton hl={hl} />
      <Button variant="primary" size="sm" disabled={lesson.finishing} onClick={lesson.done}>
        {lesson.finishing && <Spinner size={12} />}
        {t("ui.teach.done")}
      </Button>
      {confirm ? (
        <Button variant="danger" size="sm" onClick={cancel}>
          {t("ui.teach.discard")}
        </Button>
      ) : phone ? (
        <IconButton label={t("ui.teach.cancel")} onClick={cancel}>
          <X />
        </IconButton>
      ) : (
        <Button variant="ghost" size="sm" onClick={cancel}>
          {t("ui.teach.cancel")}
        </Button>
      )}
    </div>
  );
}
