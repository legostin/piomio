// An agent's library over the app: everything the person and the agent sent each other (photos, videos, voice notes,
// documents, the pictures it showed) and the pages it made, from all its chats, newest first. "All" shows a shelf of
// each kind; a kind shows all of it, page by page. Pictures and videos open in the media viewer, pages full screen,
// files in the browser (the phone app: its share sheet). The same library on every device: it comes from the hub.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronRight, FileText, LayoutTemplate, LibraryBig, Mic, Play, Search, X } from "lucide-react";
import type { LibraryItem, LibraryKind } from "@piomio/shared";
import { useStore } from "../lib/store";
import { api, errorText } from "../lib/api";
import { native } from "../lib/native";
import { fileSize, formatDuration, shortTime } from "../lib/format";
import { itemHref, itemMediaKind, libraryMedia, libraryQuery, shelves, SHELF_PREVIEW, thumbSrc, type LibraryFilter, type LibraryPageData } from "../lib/library";
import { agents, team } from "../state/app";
import { closeLibrary, libraryStamp, libraryView, openLibrary } from "../state/library";
import { ensurePages, pages } from "../state/pages";
import { openFile as openInApp, openViewer, viewer } from "../state/viewer";
import { FullscreenPanel } from "./WindowTitlebar";
import { PageViewer } from "../pages/chat/PageCard";
import { QuietImg } from "./picture";
import { Button, cx, EmptyState, Spinner } from "./ui";
import { t, type MessageKey } from "../i18n";

const ALL_LIMIT = 200;
const KIND_LIMIT = 60;

const KIND_LABEL: Record<LibraryKind, MessageKey> = {
  page: "library.kind.page",
  media: "library.kind.media",
  file: "library.kind.file",
  audio: "library.kind.audio",
};

interface Loaded {
  items: LibraryItem[];
  more: boolean;
  loading: boolean;
  error?: string;
}

/** One kind (or all) of the library for a query, reloaded when something new comes; `more` loads older items. */
function useLibrary(agentId: string, kind: LibraryFilter, q: string): Loaded & { loadMore: () => void; retry: () => void } {
  const stamp = useStore(libraryStamp);
  const [state, setState] = useState<Loaded>({ items: [], more: false, loading: true });
  const [attempt, setAttempt] = useState(0);
  const seq = useRef(0);
  useEffect(() => {
    const n = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: undefined }));
    // Typing waits a moment; a new file or a retry loads at once.
    const timer = setTimeout(
      () => {
        api.get<LibraryPageData>(libraryQuery(agentId, { kind, q, limit: kind === "all" ? ALL_LIMIT : KIND_LIMIT })).then(
          (r) => n === seq.current && setState({ items: r.items, more: r.more, loading: false }),
          (e) => n === seq.current && setState((s) => ({ ...s, loading: false, error: errorText(e) })),
        );
      },
      q ? 250 : 0,
    );
    return () => clearTimeout(timer);
  }, [agentId, kind, q, stamp, attempt]);
  const loadMore = () => {
    const last = state.items[state.items.length - 1];
    if (!last || state.loading) return;
    const n = seq.current;
    setState((s) => ({ ...s, loading: true }));
    api.get<LibraryPageData>(libraryQuery(agentId, { kind, q, before: last.at, limit: KIND_LIMIT })).then(
      (r) => n === seq.current && setState((s) => ({ items: [...s.items, ...r.items.filter((it) => !s.items.some((x) => x.id === it.id))], more: r.more, loading: false })),
      (e) => n === seq.current && setState((s) => ({ ...s, loading: false, error: errorText(e) })),
    );
  };
  return { ...state, loadMore, retry: () => setAttempt((a) => a + 1) };
}

export function LibrarySheet() {
  const view = useStore(libraryView);
  if (!view) return null;
  return <Library key={view.agentId} agentId={view.agentId} />;
}

function Library({ agentId }: { agentId: string }) {
  const agentList = useStore(agents);
  const members = useStore(team);
  const pageList = useStore(pages);
  const agent = agentList?.find((a) => a.id === agentId);
  const dialog = members?.find((m) => m.agentId === agentId)?.conversationId;
  const [kind, setKind] = useState<LibraryFilter>("all");
  const [q, setQ] = useState("");
  const [page, setPage] = useState<string>();
  const pageOpen = useRef(false);
  pageOpen.current = !!page;
  const lib = useLibrary(agentId, kind, q);
  // The kinds there are, from the whole library: the chips stay while one kind is shown.
  const [present, setPresent] = useState<LibraryKind[]>([]);
  useEffect(() => {
    if (kind === "all" && !q && !lib.loading && !lib.error) setPresent(shelves(lib.items).map((s) => s.kind));
  }, [kind, q, lib.loading, lib.error, lib.items]);
  useEffect(() => ensurePages(), []);

  // Over everything: the phone app hides its header, the page does not scroll beneath, Escape closes.
  const fullscreen = () => native?.call("fullscreen", { on: true }).catch(() => {});
  useEffect(() => {
    fullscreen();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // Seen before the viewer's and the page's own Escape (capture): what is on top closes first.
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !viewer.get() && !pageOpen.current) closeLibrary();
    };
    window.addEventListener("keydown", esc, true);
    return () => {
      native?.call("fullscreen", { on: false }).catch(() => {});
      document.body.style.overflow = overflow;
      window.removeEventListener("keydown", esc, true);
    };
  }, []);

  const media = useMemo(() => libraryMedia(lib.items), [lib.items]);
  const openMedia = (it: LibraryItem) => openViewer({ kind: "list", items: media }, `library:${it.id}`);
  const openFile = (it: LibraryItem) => {
    const href = itemHref(it);
    if (!href) return;
    openInApp({ src: href, download: itemHref(it, true) ?? href, name: it.name, mimeType: it.mimeType, ...(it.size !== undefined ? { size: it.size } : {}) });
  };
  const fromLabel = (it: LibraryItem) => (it.from === "person" ? t("library.fromYou") : (agentList?.find((a) => a.id === it.agentId)?.name ?? agent?.name ?? ""));
  const openPage = page ? pageList?.find((p) => p.id === page) : undefined;

  const pick = (k: LibraryFilter) => {
    setKind(k);
    document.getElementById("library-scroll")?.scrollTo({ top: 0 });
  };

  const body = (): ReactNode => {
    if (lib.error && !lib.items.length)
      return (
        <div className="flex flex-col items-center gap-3 py-14 text-center">
          <p className="text-sm text-muted">{t("library.failed", { error: lib.error })}</p>
          <Button onClick={lib.retry}>{t("common.retry")}</Button>
        </div>
      );
    if (lib.loading && !lib.items.length)
      return (
        <div className="flex justify-center py-14">
          <Spinner />
        </div>
      );
    if (!lib.items.length)
      return q ? (
        <EmptyState icon="search" title={t("library.nothingFound")} hint={t("library.nothingFoundHint")} />
      ) : (
        <EmptyState art={<Tile><LibraryBig className="size-6" /></Tile>} title={t("library.empty")} hint={t("library.emptyHint", { name: agent?.name ?? "" })} />
      );
    const shelf = (k: LibraryKind, items: LibraryItem[]) => {
      switch (k) {
        case "page":
          return <PageGrid items={items} onOpen={(it) => setPage(it.pageId)} />;
        case "media":
          return <MediaGrid items={items} onOpen={openMedia} />;
        case "audio":
          return <AudioList items={items} from={fromLabel} />;
        case "file":
          return <FileList items={items} from={fromLabel} onOpen={openFile} />;
      }
    };
    if (kind !== "all")
      return (
        <>
          {shelf(kind, lib.items)}
          {lib.more && (
            <div className="flex justify-center py-4">
              <Button onClick={lib.loadMore} disabled={lib.loading}>
                {lib.loading ? <Spinner size={14} /> : t("library.more")}
              </Button>
            </div>
          )}
        </>
      );
    return shelves(lib.items).map((s) => (
      <section key={s.kind} className="mb-7">
        <div className="mb-2.5 flex items-baseline gap-2">
          <h2 className="font-display text-[15px] font-semibold">{t(KIND_LABEL[s.kind])}</h2>
          {(s.items.length > SHELF_PREVIEW[s.kind] || lib.more) && (
            <button type="button" onClick={() => pick(s.kind)} className="ml-auto inline-flex items-center text-[13px] font-medium text-muted transition hover:text-fg">
              {t("library.showAll")}
              <ChevronRight className="size-4" />
            </button>
          )}
        </div>
        {shelf(s.kind, s.items.slice(0, SHELF_PREVIEW[s.kind]))}
      </section>
    ));
  };

  return (
    <FullscreenPanel className="animate-fade z-50" role="dialog" aria-label={t("library.title")}>
      <header className="border-b border-hairline pt-[env(safe-area-inset-top)]">
        <div className="mx-auto flex w-full max-w-3xl items-center gap-1 px-2">
          <button type="button" onClick={closeLibrary} aria-label={t("page.close")} title={t("page.close")} className="flex size-11 shrink-0 items-center justify-center rounded-xl text-muted transition hover:bg-surface-2 hover:text-fg">
            <X className="size-5" />
          </button>
          <div className="min-w-0 flex-1 pr-2">
            <div className="truncate text-[15px] leading-tight font-semibold">{t("library.title")}</div>
            {agent && <div className="truncate text-[12px] leading-tight text-muted">{agent.name}</div>}
          </div>
          {lib.loading && lib.items.length > 0 && <Spinner size={14} className="mr-3" />}
        </div>
        <div className="mx-auto w-full max-w-3xl px-4 pb-2.5">
          <label className="flex h-10 items-center gap-2 rounded-full border border-hairline bg-surface px-3.5 text-muted focus-within:border-fg/25">
            <Search className="size-4 shrink-0" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t("library.search")}
              aria-label={t("library.search")}
              enterKeyHint="search"
              className="min-w-0 flex-1 bg-transparent text-[15px] text-fg outline-none placeholder:text-muted"
            />
            {q && (
              <button type="button" onClick={() => setQ("")} aria-label={t("library.clear")} className="-mr-1 flex size-6 items-center justify-center rounded-full hover:bg-surface-2">
                <X className="size-3.5" />
              </button>
            )}
          </label>
          {present.length > 1 && (
            <div className="-mx-4 mt-2.5 flex gap-1.5 overflow-x-auto px-4 [scrollbar-width:none]">
              {(["all", ...present] as LibraryFilter[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => pick(k)}
                  aria-pressed={kind === k}
                  className={cx(
                    "press shrink-0 rounded-full border px-3 py-1 text-[13px] font-medium transition",
                    kind === k ? "border-transparent bg-fg text-bg" : "border-hairline bg-surface text-muted hover:text-fg",
                  )}
                >
                  {k === "all" ? t("library.all") : t(KIND_LABEL[k])}
                </button>
              ))}
            </div>
          )}
        </div>
      </header>
      <div id="library-scroll" className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto w-full max-w-3xl px-4 pt-4 pb-[calc(env(safe-area-inset-bottom)+24px)]">{body()}</div>
      </div>
      {openPage && (
        <PageViewer
          page={openPage}
          conversationId={(pageList?.find((p) => p.id === page)?.conversationId ?? dialog) || ""}
          onClose={() => {
            setPage(undefined);
            // The page gave the header back as it closed; the library is still over the chat.
            fullscreen();
          }}
        />
      )}
    </FullscreenPanel>
  );
}

function Tile({ children }: { children: ReactNode }) {
  return <div className="flex size-14 items-center justify-center rounded-[18px] border border-hairline bg-surface text-accent-text shadow-card">{children}</div>;
}

function MediaGrid({ items, onOpen }: { items: LibraryItem[]; onOpen: (it: LibraryItem) => void }) {
  return (
    <div className="grid grid-cols-3 gap-1 sm:grid-cols-4 sm:gap-1.5">
      {items.map((it) => (
        <MediaTile key={it.id} item={it} onOpen={() => onOpen(it)} />
      ))}
    </div>
  );
}

function MediaTile({ item, onOpen }: { item: LibraryItem; onOpen: () => void }) {
  const [failed, setFailed] = useState(false);
  const video = itemMediaKind(item) === "video";
  const src = video ? itemHref(item) : thumbSrc(item);
  return (
    <button
      type="button"
      data-media-key={`library:${item.id}`}
      onClick={onOpen}
      title={item.name}
      aria-label={t("viewer.open", { name: item.name })}
      className="group relative aspect-square cursor-zoom-in overflow-hidden rounded-xl bg-surface-2 outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      {src && !failed ? (
        video ? (
          <video src={`${src}#t=0.1`} preload="metadata" muted playsInline className="pointer-events-none size-full object-cover" />
        ) : (
          <QuietImg src={src} alt={item.caption ?? item.name} loading="lazy" decoding="async" onFail={() => setFailed(true)} className="size-full object-cover transition duration-500 group-hover:scale-[1.03]" />
        )
      ) : (
        <span className="flex size-full items-center justify-center p-2 text-center text-[11px] break-all text-muted">{item.name}</span>
      )}
      {video && (
        <span className="absolute inset-0 flex items-center justify-center">
          <span className="flex size-9 items-center justify-center rounded-full bg-black/50 text-white ring-1 ring-white/20 backdrop-blur">
            <Play className="size-4 translate-x-px fill-current" />
          </span>
        </span>
      )}
      {video && item.durationSec !== undefined && (
        <span className="absolute right-1.5 bottom-1.5 rounded-full bg-black/55 px-1.5 py-0.5 text-[10.5px] font-medium text-white tabular-nums">{formatDuration(item.durationSec)}</span>
      )}
    </button>
  );
}

function PageGrid({ items, onOpen }: { items: LibraryItem[]; onOpen: (it: LibraryItem) => void }) {
  return (
    <div className="grid grid-cols-2 gap-2.5">
      {items.map((it) => (
        <PageTile key={it.id} item={it} onOpen={() => onOpen(it)} />
      ))}
    </div>
  );
}

function PageTile({ item, onOpen }: { item: LibraryItem; onOpen: () => void }) {
  const [noCover, setNoCover] = useState(false);
  const cover = thumbSrc(item);
  return (
    <button type="button" onClick={onOpen} className="group overflow-hidden rounded-2xl border border-hairline bg-surface text-left shadow-card transition hover:border-fg/20">
      {cover && !noCover ? (
        <QuietImg src={cover} alt="" loading="lazy" onFail={() => setNoCover(true)} className="aspect-[16/10] w-full object-cover" />
      ) : (
        <span className="flex aspect-[16/10] w-full items-center justify-center bg-gradient-to-br from-accent-soft via-surface-2 to-surface text-accent-text">
          <LayoutTemplate className="size-6" strokeWidth={1.5} />
        </span>
      )}
      <span className="block p-2.5">
        <span className="block truncate text-[14px] font-semibold">{item.name}</span>
        <span className="block truncate text-[12px] text-muted">{item.caption ?? shortTime(item.at)}</span>
      </span>
    </button>
  );
}

function Row({ icon, title, meta, onClick, children }: { icon: ReactNode; title: string; meta: string; onClick?: () => void; children?: ReactNode }) {
  return (
    <li className="border-b border-hairline last:border-0">
      <button type="button" onClick={onClick} className="flex w-full items-center gap-3 py-2.5 text-left transition hover:opacity-80">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent-text">{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14.5px] font-medium">{title}</span>
          <span className="block truncate text-[12.5px] text-muted">{meta}</span>
        </span>
      </button>
      {children}
    </li>
  );
}

const metaOf = (...bits: Array<string | undefined>) => bits.filter(Boolean).join(" · ");

function FileList({ items, from, onOpen }: { items: LibraryItem[]; from: (it: LibraryItem) => string; onOpen: (it: LibraryItem) => void }) {
  return (
    <ul className="rounded-2xl border border-hairline bg-surface px-3">
      {items.map((it) => (
        <Row key={it.id} icon={<FileText className="size-[18px]" />} title={it.name} meta={metaOf(it.size !== undefined ? fileSize(it.size) : undefined, from(it), shortTime(it.at))} onClick={() => onOpen(it)} />
      ))}
    </ul>
  );
}

function AudioList({ items, from }: { items: LibraryItem[]; from: (it: LibraryItem) => string }) {
  const [playing, setPlaying] = useState<string>();
  return (
    <ul className="rounded-2xl border border-hairline bg-surface px-3">
      {items.map((it) => {
        const title = it.transcript ? it.transcript : it.voice ? t("message.voice") : it.name;
        return (
          <Row
            key={it.id}
            icon={<Mic className="size-[18px]" />}
            title={title}
            meta={metaOf(it.durationSec !== undefined ? formatDuration(it.durationSec) : undefined, from(it), shortTime(it.at))}
            onClick={() => setPlaying((p) => (p === it.id ? undefined : it.id))}
          >
            {playing === it.id && itemHref(it) && <audio controls autoPlay preload="none" src={itemHref(it)} className="mb-2.5 h-10 w-full" />}
          </Row>
        );
      })}
    </ul>
  );
}

/** The library button in a chat's header. */
export function LibraryButton({ agentId, className }: { agentId: string; className?: string }) {
  return (
    <button
      type="button"
      onClick={() => openLibrary(agentId)}
      aria-label={t("library.title")}
      title={t("library.title")}
      className={cx("press inline-flex size-8 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-fg", className)}
    >
      <LibraryBig className="size-[18px]" />
    </button>
  );
}
