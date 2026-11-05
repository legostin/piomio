// A page an agent made (a `page` part): its card in the chat (picture, title, a line or two) opens the page full
// screen inside the app, in a sandboxed frame at its own link (core/src/server/pages.ts). The page talks to the chat through
// postMessage: "ask" sends the person's words to the agent and closes the page, "open" opens a link outside it.
// A change to the page (page_update) reloads it where it is open.

import { useEffect, useRef, useState } from "react";
import { ChevronRight, LayoutTemplate, X } from "lucide-react";
import type { PageView } from "@piomio/shared";
import { useStore } from "../../lib/store";
import { mediaSrc } from "../../lib/media";
import { FullscreenPanel } from "../../components/WindowTitlebar";
import { QuietImg } from "../../components/picture";
import { native } from "../../lib/native";
import { sendMessage } from "../../state/app";
import { ensurePages, pages } from "../../state/pages";
import { toast } from "../../state/toast";
import { errorText } from "../../lib/api";
import { t } from "../../i18n";

const LINK = /^(https?:|mailto:|tel:)/i;

export function PageCard({ pageId, conversationId }: { pageId: string; conversationId: string }) {
  const list = useStore(pages);
  const [open, setOpen] = useState(false);
  const [noCover, setNoCover] = useState(false);
  useEffect(() => ensurePages(), []);
  const page = list?.find((p) => p.id === pageId);
  if (!list) return <div className="my-2 h-48 max-w-md animate-pulse rounded-2xl bg-surface-2" />;
  if (!page) return <div className="my-2 max-w-md rounded-2xl border border-dashed border-border px-3 py-2.5 text-sm text-muted">{t("page.gone")}</div>;
  const cover = page.cover ? mediaSrc(page.cover) : undefined;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="group my-2 block w-full max-w-full overflow-hidden rounded-2xl border border-border bg-surface text-left shadow-card transition hover:border-fg/20 sm:max-w-md"
      >
        {cover && !noCover ? (
          <QuietImg src={cover} alt="" loading="lazy" onFail={() => setNoCover(true)} className="aspect-[16/9] w-full object-cover transition duration-500 group-hover:scale-[1.02]" />
        ) : (
          <span className="flex aspect-[16/7] w-full items-center justify-center bg-gradient-to-br from-accent-soft via-surface-2 to-surface text-accent-text">
            <LayoutTemplate className="size-8" strokeWidth={1.5} />
          </span>
        )}
        <span className="flex items-center gap-3 p-3">
          <span className="min-w-0 flex-1">
            <span className="block truncate font-semibold">{page.title}</span>
            {page.summary && <span className="line-clamp-2 text-[13px] text-muted">{page.summary}</span>}
          </span>
          <span className="inline-flex shrink-0 items-center gap-0.5 text-[13px] font-medium text-muted transition group-hover:text-fg">
            {t("page.open")}
            <ChevronRight className="size-4" />
          </span>
        </span>
      </button>
      {open && <PageViewer page={page} conversationId={conversationId} onClose={() => setOpen(false)} />}
    </>
  );
}

export function PageViewer({ page, conversationId, onClose }: { page: PageView; conversationId: string; onClose: () => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  // Nothing over the page: the composer steps aside (index.css), the phone app hides its header, Escape closes.
  useEffect(() => {
    document.documentElement.classList.add("owl-map-full");
    native?.call("fullscreen", { on: true }).catch(() => {});
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const esc = (e: KeyboardEvent) => e.key === "Escape" && close.current();
    document.addEventListener("keydown", esc);
    return () => {
      document.documentElement.classList.remove("owl-map-full");
      native?.call("fullscreen", { on: false }).catch(() => {});
      document.body.style.overflow = overflow;
      document.removeEventListener("keydown", esc);
    };
  }, []);

  // What the page asks of the chat; only this frame's messages count.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow) return;
      const d = e.data as { piomio?: boolean; type?: string; text?: unknown; url?: unknown } | null;
      if (!d?.piomio) return;
      if (d.type === "ask" && typeof d.text === "string" && d.text.trim()) {
        close.current();
        sendMessage(conversationId, d.text.trim().slice(0, 4000)).catch((err) => toast(errorText(err), "error"));
      } else if (d.type === "open" && typeof d.url === "string" && LINK.test(d.url)) {
        if (native) native.openURL(d.url).catch(() => {});
        else window.open(d.url, "_blank", "noopener,noreferrer");
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [conversationId]);

  return (
    <FullscreenPanel className="z-50" role="dialog" aria-label={page.title}>
      <header className="flex items-center gap-1 border-b border-border px-2 pt-[env(safe-area-inset-top)]">
        <button type="button" onClick={onClose} aria-label={t("page.close")} title={t("page.close")} className="flex size-11 items-center justify-center rounded-xl text-muted transition hover:bg-surface-2 hover:text-fg">
          <X className="size-5" />
        </button>
        <span className="min-w-0 flex-1 truncate pr-3 text-[15px] font-semibold">{page.title}</span>
      </header>
      <iframe
        key={page.version}
        ref={frame}
        src={page.url}
        title={page.title}
        sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms"
        referrerPolicy="no-referrer"
        className="min-h-0 w-full flex-1 border-0"
      />
    </FullscreenPanel>
  );
}
