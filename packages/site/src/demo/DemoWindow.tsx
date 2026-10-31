// The live window: the real app (the demo build, same origin) in an iframe dressed as a Mac window. It plays the chapter
// it is given; a new chapter reloads the frame (a fresh world) under a short fade. Out of view or in a hidden tab the
// script pauses. On a wide window the app is drawn at desktop size and scaled down, so its sidebar shows; on a phone it
// gets the real width and its phone layout. `idle` shows the still picture without a frame (another window plays),
// `passive` lets touches through to the page (a card in the phone's feed), `bare` drops the window's title bar (the
// full-screen story).

import { useEffect, useRef, useState } from "react";
import { data } from "../data";
import { useI18n } from "../i18n";
import { Replay } from "../components/icons";
import { Poster } from "./Poster";
import { demoSrc, type ChapterId, type FromDemo, type ToDemo } from "./protocol";

type Status = "loading" | "ready" | "playing" | "ended" | "failed" | "noworker";

/** The app is laid out at least this wide (its sidebar shows) and scaled down to fit. */
const DESKTOP_WIDTH = 860;
/** A frame that has not said "ready" by then is given up on (the still picture stays). */
const STALL_MS = 15_000;
/** Narrower than this, the app gets the window's own width (its phone layout). */
const PHONE_BELOW = 640;

declare global {
  interface Window {
    __demo?: { last?: FromDemo; log: FromDemo[] };
  }
}

interface Props {
  chapter: ChapterId;
  className?: string;
  idle?: boolean;
  passive?: boolean;
  bare?: boolean;
  /** The chapter played to its end. */
  onEnded?: () => void;
}

export function DemoWindow({ chapter, className = "", idle = false, passive = false, bare = false, onEnded }: Props) {
  const { lang, t } = useI18n();
  const frame = useRef<HTMLIFrameElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState<ChapterId>(chapter);
  const [nonce, setNonce] = useState(0);
  const [status, setStatus] = useState<Status>("loading");
  const [first, setFirst] = useState(true);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const src = demoSrc(data.base, lang, loaded) + (nonce ? `&r=${nonce}` : "");
  const ended = useRef(onEnded);
  ended.current = onEnded;

  // Follow the chapter in view, once the reader settles on it.
  useEffect(() => {
    if (chapter === loaded) return;
    const id = setTimeout(() => {
      setStatus((s) => (s === "noworker" ? s : "loading"));
      setLoaded(chapter);
    }, 260);
    return () => clearTimeout(id);
  }, [chapter, loaded]);

  // A window that comes alive loads its frame afresh.
  useEffect(() => {
    if (!idle) setStatus((s) => (s === "noworker" ? s : "loading"));
  }, [idle]);

  // What the frame says.
  useEffect(() => {
    const take = (d: FromDemo) => {
      if (d.type === "ready" || d.type === "playing") setFirst(false);
      // A chapter that failed counts as over: the story moves on, a card rests on its picture.
      if (d.type === "ended" || d.type === "failed") ended.current?.();
      setStatus((s) => {
        if (s === "noworker") return s;
        if (d.type === "failed") return d.message === "no service worker" ? "noworker" : "failed";
        return d.type;
      });
    };
    const on = (e: MessageEvent<FromDemo>) => {
      if (e.origin !== location.origin || e.source !== frame.current?.contentWindow || e.data?.source !== "piomio-demo") return;
      take(e.data);
    };
    window.addEventListener("message", on);
    // A frame that came up before the page did: read what it already said.
    try {
      for (const m of frame.current?.contentWindow?.__demo?.log ?? []) take(m);
    } catch {
      /* not there yet */
    }
    return () => window.removeEventListener("message", on);
  }, [idle]);

  // Pause off screen and in a hidden tab.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let seen = true;
    const post = (type: ToDemo["type"]) => frame.current?.contentWindow?.postMessage({ source: "piomio-site", type } satisfies ToDemo, location.origin);
    const sync = () => post(seen && document.visibilityState === "visible" ? "resume" : "pause");
    const io = new IntersectionObserver(([e]) => {
      seen = e.isIntersecting;
      sync();
    }, { threshold: 0.15 });
    io.observe(el);
    document.addEventListener("visibilitychange", sync);
    return () => {
      io.disconnect();
      document.removeEventListener("visibilitychange", sync);
    };
  }, [idle]);

  // The window's size, for the scale.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const phone = !!size && size.w < PHONE_BELOW;
  const scale = size && !phone ? Math.min(1, size.w / DESKTOP_WIDTH) : 1;
  const frameStyle = size ? { width: size.w / scale, height: size.h / scale, transform: `scale(${scale})`, transformOrigin: "0 0" } : { width: "100%", height: "100%" };
  // A frame that never came up (a slow or odd browser) rests like a failed one instead of showing a half-made app.
  useEffect(() => {
    if (idle || status !== "loading") return;
    const timer = setTimeout(() => setStatus((s) => (s === "loading" ? "failed" : s)), STALL_MS);
    return () => clearTimeout(timer);
  }, [idle, status, src]);

  // Anything not playing well shows the still picture: never an error inside the app.
  const covered = idle || status === "loading" || status === "noworker" || status === "failed";

  return (
    <div className={`flex flex-col overflow-hidden rounded-[18px] bg-canvas shadow-[var(--shadow-window)] ${className}`}>
      {!bare && (
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-hairline px-4">
          <span className="size-3 rounded-full bg-[#ff5f57]" />
          <span className="size-3 rounded-full bg-[#febc2e]" />
          <span className="size-3 rounded-full bg-[#28c840]" />
          <span className="ml-3 truncate text-[13px] font-medium text-muted">{t("demo.windowTitle")}</span>
          <span
            className="ml-auto inline-flex items-center gap-2 rounded-full bg-accent-soft px-2.5 py-1 text-[11.5px] font-semibold text-accent-text"
            title={t("demo.liveHint")}
          >
            <span className="live-dot size-1.5 rounded-full" />
            {t("demo.live")}
          </span>
        </div>
      )}
      <div ref={box} className="@container relative min-h-0 flex-1 overflow-hidden">
        {!idle && (
          <iframe
            ref={frame}
            key={lang}
            src={src}
            title={t("demo.liveHint")}
            tabIndex={passive ? -1 : undefined}
            className={`absolute left-0 top-0 block border-0 transition-opacity duration-500 ${covered ? "opacity-0" : "opacity-100"}`}
            style={{
              ...frameStyle,
              ...(passive ? { pointerEvents: "none" as const } : {}),
            }}
          />
        )}
        <div className={`pointer-events-none absolute inset-0 transition-opacity duration-500 ${covered ? "opacity-100" : "opacity-0"}`}>
          {idle || first || status === "noworker" || status === "failed" ? <Poster /> : <div className="absolute inset-0 bg-bg" />}
          {!idle && status === "loading" && (
            <div className="absolute inset-x-0 bottom-6 flex justify-center">
              <span className="rounded-full bg-surface px-3.5 py-1.5 text-[13px] font-medium text-muted shadow-[var(--shadow)]">{t("demo.loading")}</span>
            </div>
          )}
          {status === "noworker" && (
            <div className="absolute inset-x-4 bottom-4 rounded-2xl bg-surface/95 px-4 py-3 text-[14px] text-fg-2 shadow-[var(--shadow)]">
              {t("demo.noWorker")}
            </div>
          )}
        </div>
        {!idle && !passive && (status === "ended" || status === "failed") && (
          <button
            type="button"
            onClick={() => {
              setStatus("loading");
              setNonce((n) => n + 1);
            }}
            className="candy absolute bottom-[88px] left-1/2 inline-flex -translate-x-1/2 items-center gap-2 rounded-full px-4 py-2 text-[14px] font-semibold whitespace-nowrap"
          >
            <Replay size={16} />
            {t("demo.replay")}
          </button>
        )}
      </div>
    </div>
  );
}
