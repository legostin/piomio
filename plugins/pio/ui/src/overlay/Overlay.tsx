// Pio's window in the desktop app (/pio/overlay, a bare page over a see-through window, always on top): the face, its
// card with the three switches, Pio's lines, and what Pio does on this computer — watching which window is active,
// listening, speaking, and the mouse and keyboard when the person handed them over.

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { Message, PiomioUI, UiEvent } from "@piomio/ui";
import { desk, desktopOf, onDesktop, toScreen, type Capture } from "../desktop.ts";
import { HttpError, SpeechApi, type SpeechStatus } from "../hub.ts";
import { FOLLOW_MS, forPio, type ListenMode } from "../voice/gate.ts";
import { Mic } from "../voice/mic.ts";
import { Speaker } from "../voice/speaker.ts";
import { speakable } from "../voice/speakable.ts";
import { brief, langOf, personLang, voiceFor } from "../voice/lang.ts";
import { CSS } from "./styles.ts";

const AGENT = "pio";
const SIZES = { bubble: { width: 72, height: 72 }, line: { width: 380, height: 150 }, card: { width: 380, height: 560 } } as const;
type Mode = keyof typeof SIZES;
type Face = "idle" | "watching" | "listening" | "hearing" | "thinking" | "speaking" | "driving";
const HEARTBEAT_MS = 15_000;
const WATCH_MS = 2_000;
/** How long a line of Pio's stays beside the face. */
const LINE_MS = 12_000;
/** What of a reply is said out loud: its first sentences (the rest is in the card and the chat). */
const SPEAK_MAX = 320;
const SWITCHES = "pio.switches";
/** What the engine weighs (sherpa-onnx and the phonemizer), shown before the download with the voice and the model. */
const RUNTIME_BYTES = 20e6;

interface Line {
  id: string;
  me: boolean;
  text: string;
}

function textOf(m: Message): string {
  return m.parts
    .flatMap((p) => (p.type === "text" ? [p.text] : []))
    .join("")
    .trim();
}

function lineOf(m: Message): Line | undefined {
  if (m.quiet) return undefined;
  const text = textOf(m);
  if (!text) return undefined;
  if (m.role === "user" && !m.agentId) return { id: m.id, me: true, text };
  if (m.role === "assistant" && m.agentId === AGENT) return { id: m.id, me: false, text };
  return undefined;
}

function upsert(lines: Line[], l: Line): Line[] {
  const i = lines.findIndex((x) => x.id === l.id);
  if (i < 0) return [...lines, l].slice(-8);
  const next = lines.slice();
  next[i] = l;
  return next;
}

function savedSwitches(): { watching: boolean; voice: boolean } {
  try {
    const v = JSON.parse(localStorage.getItem(SWITCHES) ?? "{}");
    return { watching: v?.watching === true, voice: v?.voice === true };
  } catch {
    return { watching: false, voice: false };
  }
}

/** Which corner of the screen the window sits in: the face stays there and the card opens toward the middle. */
function sideOf(): { x: "left" | "right"; y: "top" | "bottom" } {
  const cx = screenX + innerWidth / 2;
  const cy = screenY + innerHeight / 2;
  return { x: cx < screen.width / 2 ? "left" : "right", y: cy < screen.height / 2 ? "top" : "bottom" };
}

function megabytes(bytes: number): string {
  return `${Math.round(bytes / 1e6)} MB`;
}

export function Overlay({ ui }: { ui: PiomioUI }) {
  const t = ui.i18n.t;
  const body = useRef(crypto.randomUUID()).current;
  const [conv, setConv] = useState<string>();
  const [mode, setMode] = useState<Mode>("bubble");
  const [sw, setSw] = useState(() => ({ ...savedSwitches(), control: false }));
  const [hearing, setHearing] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const [popup, setPopup] = useState<string>();
  const [draft, setDraft] = useState("");
  const [perms, setPerms] = useState<{ screen: boolean; accessibility: boolean }>();
  const [speech, setSpeech] = useState<SpeechStatus>();
  const [note, setNote] = useState<{ text: string; open?: "screen" | "accessibility" | "microphone" }>();
  const [listen, setListen] = useState<ListenMode>("name");
  /** Speech-to-text answered that it has no engine: the local one is offered with the voice. */
  const [sttMissing, setSttMissing] = useState(false);
  const [side, setSide] = useState(sideOf);
  const api = useMemo(() => new SpeechApi(ui), [ui]);
  // What the event handlers read now (they are set up once).
  const live = useRef({ conv, sw, listen, speech, followUntil: 0, keyHeld: false, lastCap: undefined as Capture | undefined, spoken: new Set<string>() });
  Object.assign(live.current, { conv, sw, listen, speech });

  const speaker = useMemo(
    () =>
      new Speaker((on) => {
        setSpeaking(on);
        mic.mute(on);
        if (!on) live.current.followUntil = Date.now() + FOLLOW_MS;
      }),
    [],
  );
  const mic = useMemo(() => new Mic((wav, held) => void heard(wav, held), setHearing), []);

  /** Something the person said or typed for Pio: into its chat. */
  const ask = async (text: string) => {
    const c = live.current.conv;
    if (!c) return setNote({ text: t("overlay.noChat") });
    speaker.stop();
    setThinking(true);
    try {
      await ui.api.post(`/api/conversations/${encodeURIComponent(c)}/messages`, { text });
    } catch (e) {
      setThinking(false);
      setNote({ text: t("overlay.error", { error: e instanceof Error ? e.message : String(e) }) });
    }
  };

  /** A phrase from the mic: its words, if they are for Pio. */
  const heard = async (wav: Uint8Array, held: boolean) => {
    try {
      const text = await api.transcribe(wav);
      const words = forPio(text, live.current.listen, { keyHeld: held, now: Date.now(), followUntil: live.current.followUntil });
      if (words) await ask(words);
    } catch (e) {
      if (e instanceof HttpError && (e.status === 503 || e.status === 409)) setSttMissing(true);
    }
  };

  /** Pio said something (asked or on its own): beside the face, and out loud with the voice on. */
  const said = (text: string) => {
    live.current.followUntil = Date.now() + FOLLOW_MS;
    setPopup(text);
    if (!live.current.sw.voice) return;
    const words = speakable(text, SPEAK_MAX);
    if (!words) return;
    // The voice of the reply's own language (the hub may be set to another one).
    const lang = langOf(words);
    void (async () => {
      const s = live.current.speech;
      const voice = s?.runtime === "ready" ? voiceFor(lang, s.voices, s.voice, true) : undefined;
      if (voice) {
        try {
          return await speaker.play(await api.say(words, voice.id));
        } catch {
          /* the system's voice below */
        }
      }
      speaker.system(words, lang);
    })();
  };

  /** What the hub asks this window to do on the computer (Pio's tools). */
  const perform = async (action: string, a: Record<string, unknown>): Promise<unknown> => {
    if (action === "look") {
      const cap = await desk.capture(a.target === "screen" ? "screen" : "window");
      live.current.lastCap = cap;
      const f = await desk.frontmost().catch(() => null);
      return { jpeg: cap.jpeg, width: cap.width, height: cap.height, ...(f ? { app: f.app, title: f.title } : {}) };
    }
    const cap = live.current.lastCap;
    const at = (x: unknown, y: unknown) => {
      if (!cap) throw new Error("look first (pio_look): there is no picture to aim at");
      return toScreen(Number(x), Number(y), cap);
    };
    switch (action) {
      case "click":
      case "double_click":
      case "right_click":
      case "move": {
        const p = at(a.x, a.y);
        return desk.act({ action, x: p.x, y: p.y });
      }
      case "drag": {
        const p = at(a.x, a.y);
        const q = at(a.toX, a.toY);
        return desk.act({ action, x: p.x, y: p.y, toX: q.x, toY: q.y });
      }
      case "scroll": {
        const p = a.x !== undefined && a.y !== undefined ? at(a.x, a.y) : undefined;
        return desk.act({ action, ...(p ?? {}), dx: Number(a.dx ?? 0), dy: Number(a.dy ?? 0) });
      }
      case "type":
        return desk.act({ action, text: String(a.text ?? "") });
      case "key":
        return desk.act({ action, keys: String(a.keys ?? "") });
      case "open":
        return desk.act({ action, target: String(a.target ?? "") });
    }
    throw new Error(`unknown action ${action}`);
  };

  // Start: the look, Pio's chat and its last lines, the permissions; goodbye when the window goes.
  useEffect(() => {
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);
    let alive = true;
    void (async () => {
      const team = await ui.api.get<Array<{ agentId: string; conversationId: string; running: boolean }>>("/api/team");
      const me = team.find((m) => m.agentId === AGENT);
      if (!alive) return;
      if (!me) return setNote({ text: t("overlay.noChat") });
      setConv(me.conversationId);
      setThinking(me.running);
      ui.plugin.send({ type: "hello", body, conversationId: me.conversationId });
      const msgs = await ui.api.get<Message[]>(`/api/conversations/${encodeURIComponent(me.conversationId)}/messages?limit=12`);
      if (!alive) return;
      const ls = msgs.flatMap((m) => lineOf(m) ?? []);
      for (const l of ls) live.current.spoken.add(l.id);
      setLines(ls.slice(-6));
    })().catch(() => alive && setNote({ text: t("overlay.noChat") }));
    void desk.permissions().then(setPerms, () => {});
    const bye = () => ui.plugin.send({ type: "bye", body });
    addEventListener("pagehide", bye);
    return () => {
      alive = false;
      style.remove();
      removeEventListener("pagehide", bye);
      bye();
    };
  }, []);

  // The switches and what Pio does now, to the hub (and a heartbeat: a window that stops talking is gone).
  useEffect(() => {
    const send = () => ui.plugin.send({ type: "state", body, ...sw, hearing, speaking });
    send();
    const timer = setInterval(send, HEARTBEAT_MS);
    try {
      localStorage.setItem(SWITCHES, JSON.stringify({ watching: sw.watching, voice: sw.voice }));
    } catch {
      /* private storage */
    }
    return () => clearInterval(timer);
  }, [sw.watching, sw.voice, sw.control, hearing, speaking]);

  // Work together: which window is active, every two seconds, sent when it changes.
  useEffect(() => {
    if (!sw.watching) return;
    let last = "";
    const look = async () => {
      try {
        const f = await desk.frontmost();
        if (!f?.app) return;
        const key = `${f.app}\n${f.title ?? ""}`;
        if (key === last) return;
        last = key;
        ui.plugin.send({ type: "window", body, app: f.app, ...(f.title ? { title: f.title } : {}) });
      } catch {
        /* the app is busy; next time */
      }
    };
    void look();
    void desk.permissions().then(setPerms, () => {});
    const timer = setInterval(() => void look(), WATCH_MS);
    return () => clearInterval(timer);
  }, [sw.watching]);

  // Voice: the mic, push to talk, and whether the hub's local voice is there.
  useEffect(() => {
    if (!sw.voice) return;
    void api.status().then(setSpeech, () => {});
    mic.start().catch((e: unknown) => {
      const insecure = e instanceof Error && e.message === "insecure";
      setNote(insecure ? { text: t("overlay.voice.insecure") } : { text: t("overlay.voice.noMic"), open: "microphone" });
      setSw((s) => ({ ...s, voice: false }));
    });
    void desk.hotkey(true).catch(() => {});
    return () => {
      mic.stop();
      speaker.stop();
      void desk.hotkey(false).catch(() => {});
    };
  }, [sw.voice]);

  // The hub: Pio's chat, whether it is thinking, the voice's download.
  useEffect(
    () =>
      ui.events.on((e: UiEvent) => {
        const c = live.current.conv;
        if ((e.type === "message.created" || e.type === "message.updated") && e.data.conversationId === c) {
          const l = lineOf(e.data);
          if (!l) return;
          setLines((ls) => upsert(ls, l));
          if (!l.me && e.data.status === "complete" && !live.current.spoken.has(l.id)) {
            live.current.spoken.add(l.id);
            said(l.text);
          }
        } else if (e.type === "message.deleted" && e.data.conversationId === c) {
          setLines((ls) => ls.filter((l) => l.id !== e.data.id));
        } else if (e.type === "team.updated" && e.data.agentId === AGENT) {
          setThinking(e.data.running);
        } else if ((e as { type: string }).type === "speech.status") {
          const d = (e as { data?: unknown; status?: unknown }).data ?? (e as { status?: unknown }).status;
          if (d && typeof d === "object" && "voices" in d) setSpeech(d as SpeechStatus);
        }
      }),
    [],
  );

  // Pio's tools reaching this computer, and how it listens.
  useEffect(() => {
    const offAct = ui.plugin.on("act", (p: { id: string; body: string; action: string; args?: Record<string, unknown> }) => {
      if (p?.body !== body) return;
      void perform(p.action, p.args ?? {}).then(
        (data) => ui.plugin.send({ type: "result", id: p.id, ok: true, data: data ?? null }),
        (e: unknown) => ui.plugin.send({ type: "result", id: p.id, ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
    });
    const offPrefs = ui.plugin.on("prefs", (p: { listen?: ListenMode }) => p?.listen && setListen(p.listen));
    return () => {
      offAct();
      offPrefs();
    };
  }, []);

  // The app: control ended (Esc, the mouse, time), push to talk.
  useEffect(
    () =>
      onDesktop((e) => {
        if (e.type === "pio-control-ended") setSw((s) => ({ ...s, control: false }));
        if (e.type === "pio-hotkey") {
          const on = e.state === "pressed";
          live.current.keyHeld = on;
          if (on) speaker.stop();
          mic.hold(on);
        }
      }),
    [],
  );

  // The window's size follows what it shows.
  useEffect(() => {
    void desk.frame(SIZES[mode]).then(
      () => setSide(sideOf()),
      () => {},
    );
  }, [mode]);

  // Pio's line beside the face for a while.
  useEffect(() => {
    if (!popup) return;
    setMode((m) => (m === "bubble" ? "line" : m));
    const timer = setTimeout(() => {
      setPopup(undefined);
      setMode((m) => (m === "line" ? "bubble" : m));
    }, LINE_MS);
    return () => clearTimeout(timer);
  }, [popup]);

  const hover = useRef<ReturnType<typeof setTimeout>>(undefined);
  const enter = () => {
    clearTimeout(hover.current);
    setSide(sideOf());
    hover.current = setTimeout(() => setMode("card"), mode === "card" ? 0 : 220);
  };
  const leave = () => {
    clearTimeout(hover.current);
    hover.current = setTimeout(() => {
      if (document.activeElement instanceof HTMLInputElement && document.activeElement.value) return;
      setMode(popup ? "line" : "bubble");
    }, 700);
  };

  const toggleControl = async () => {
    if (sw.control) {
      await desk.controlEnd().catch(() => {});
      return setSw((s) => ({ ...s, control: false }));
    }
    const p = await desk.permissions().catch(() => undefined);
    if (p) setPerms(p);
    if (p && !p.accessibility) return setNote({ text: t("overlay.perm.accessibility"), open: "accessibility" });
    const asked = [...lines].reverse().find((l) => l.me)?.text;
    const ok = await desk.controlBegin(asked ?? t("overlay.controlHint")).catch((e: unknown) => {
      // The app refuses without the Accessibility permission (macOS).
      if (/accessibility/i.test(String(e))) setNote({ text: t("overlay.perm.accessibility"), open: "accessibility" });
      return false;
    });
    if (ok) setSw((s) => ({ ...s, control: true }));
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    void ask(text);
  };

  const openChat = () => {
    ui.plugin.send({ type: "open", body });
    const d = desktopOf();
    if (d) location.href = `${d.scheme}://open`;
  };

  const face: Face = sw.control ? "driving" : speaking ? "speaking" : hearing ? "hearing" : thinking ? "thinking" : sw.voice ? "listening" : sw.watching ? "watching" : "idle";
  // What to download: the voice and the speech-to-text model of the person's language, not the hub's.
  const lang = personLang(
    lines.filter((l) => l.me).map((l) => l.text),
    ui.i18n.locale,
  );
  const voice = speech ? voiceFor(lang, speech.voices, speech.voice, false) : undefined;
  const hears = speech?.stt.models?.find((m) => m.langs.length === 1 && m.langs[0] === lang) ?? speech?.stt.models?.find((m) => m.langs.includes(lang));
  const sttNeeded = sttMissing && !!hears && !hears.installed;
  const needsVoice = sw.voice && speech && (speech.runtime !== "ready" || (voice && !voice.installed) || sttNeeded);
  const voiceBytes = (speech?.runtime === "ready" ? 0 : RUNTIME_BYTES) + (voice && !voice.installed ? voice.size : 0) + (hears && !hears.installed ? hears.size : 0);
  const install = () => void api.install({ ...(voice ? { voice: voice.id } : {}), stt: hears?.id ?? true }).then(setSpeech, () => {});
  const progress = speech?.downloading && speech.downloading.total > 0 ? Math.round((speech.downloading.received / speech.downloading.total) * 100) : undefined;

  return (
    <div className="pio-root" data-x={side.x} data-y={side.y} onMouseEnter={enter} onMouseLeave={leave}>
      <div className="pio-stack">
        <div className="pio-face" data-state={face} data-tauri-drag-region title={t(`overlay.state.${face}`)} onClick={() => setMode((m) => (m === "card" ? "bubble" : "card"))}>
          <i className="pio-eye l" data-tauri-drag-region />
          <i className="pio-eye r" data-tauri-drag-region />
        </div>
        {mode === "line" && popup && (
          <div className="pio-line" onClick={() => setMode("card")}>
            {brief(speakable(popup, 600) || popup)}
          </div>
        )}
        {mode === "card" && (
          <div className="pio-card">
            <div className="pio-head">
              <span className="pio-name">{ui.i18n.locale === "ru" ? "Пио" : "Pio"}</span>
              <span className="pio-state">{t(`overlay.state.${face}`)}</span>
              <button type="button" className="pio-x" onClick={openChat}>
                {t("overlay.openChat")}
              </button>
              <button type="button" className="pio-x" title={t("overlay.hide")} aria-label={t("overlay.hide")} onClick={() => void desk.hide().catch(() => {})}>
                ✕
              </button>
            </div>
            <Switch label={t("overlay.workTogether")} hint={t("overlay.workTogetherHint")} on={sw.watching} onToggle={() => setSw((s) => ({ ...s, watching: !s.watching }))} />
            <Switch label={t("overlay.voice")} hint={t("overlay.voiceHint")} on={sw.voice} onToggle={() => setSw((s) => ({ ...s, voice: !s.voice }))} />
            <Switch
              label={sw.control ? t("overlay.controlOn") : t("overlay.control")}
              hint={t("overlay.controlHint")}
              on={sw.control}
              red
              onToggle={() => void toggleControl()}
            />
            {sw.watching && perms && !perms.screen && <Note text={t("overlay.perm.screen")} action={t("overlay.perm.open")} onAction={() => void desk.openSettings("screen")} />}
            {sttNeeded && !needsVoice && <Note text={t("overlay.voice.noStt")} />}
            {needsVoice &&
              (speech.runtime === "failed" ? (
                <Note text={t("overlay.voice.failed", { error: speech.error ?? "" })} action={t("overlay.voice.installButton")} onAction={install} />
              ) : progress !== undefined || speech.runtime === "downloading" ? (
                <Note text={t("overlay.voice.installing", { percent: progress ?? 0 })} />
              ) : (
                <Note text={t("overlay.voice.install", { size: megabytes(voiceBytes) })} action={t("overlay.voice.installButton")} onAction={install} />
              ))}
            {note && <Note text={note.text} action={note.open ? t("overlay.perm.open") : undefined} onAction={note.open ? () => void desk.openSettings(note.open!) : undefined} onClose={() => setNote(undefined)} />}
            <div className="pio-lines">
              {lines.map((l) => (
                <div key={l.id} className={l.me ? "pio-msg me" : "pio-msg"}>
                  {l.me ? l.text : speakable(l.text, 1200) || l.text}
                </div>
              ))}
              {hearing && <div className="pio-hearing">{t("overlay.state.hearing")}</div>}
            </div>
            <form className="pio-form" onSubmit={submit}>
              <input className="pio-input" value={draft} placeholder={t("overlay.placeholder")} onChange={(e) => setDraft(e.target.value)} />
              <button type="submit" className="pio-send" disabled={!draft.trim()}>
                {t("overlay.send")}
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}

function Switch({ label, hint, on, red, onToggle }: { label: string; hint: string; on: boolean; red?: boolean; onToggle: () => void }) {
  return (
    <div className="pio-switch" role="switch" aria-checked={on} tabIndex={0} onClick={onToggle} onKeyDown={(e) => (e.key === " " || e.key === "Enter") && onToggle()}>
      <span>
        <b>{label}</b>
        <small>{hint}</small>
      </span>
      <i className={red ? "pio-toggle red" : "pio-toggle"} data-on={on} />
    </div>
  );
}

function Note({ text, action, onAction, onClose }: { text: string; action?: string; onAction?: () => void; onClose?: () => void }) {
  return (
    <div className="pio-note">
      <span>{text}</span>
      {action && onAction && (
        <button type="button" onClick={onAction}>
          {action}
        </button>
      )}
      {onClose && (
        <button type="button" className="pio-x" onClick={onClose} aria-label="×">
          ✕
        </button>
      )}
    </div>
  );
}
