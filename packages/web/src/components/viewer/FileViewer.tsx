// The document viewer: a file an agent sent (or the person attached) that is not a picture or a video, inside the app
// over everything: Markdown drawn, other text as it is, a PDF in the browser's own viewer. Download saves it (the
// desktop app's Downloads folder, the phone's share sheet).

import { useEffect, useState } from "react";
import { Download, Loader2, X } from "lucide-react";
import { FullscreenPanel } from "../WindowTitlebar";
import { Markdown } from "../markdown";
import { useStore } from "../../lib/store";
import { docKind } from "../../lib/gallery";
import { fileSize } from "../../lib/format";
import { closeFile, fileViewer, saveMedia, type OpenFile } from "../../state/viewer";
import { t } from "../../i18n";

/** Text bigger than this is not drawn in the app: it is offered for saving instead. */
const MAX_TEXT_BYTES = 4 * 1024 * 1024;

export function FileViewer() {
  const file = useStore(fileViewer);
  return file ? <Doc key={file.id} file={file} /> : null;
}

type Load = { status: "loading" } | { status: "ready"; text: string } | { status: "large" } | { status: "error" };

function Doc({ file }: { file: OpenFile }) {
  const kind = docKind(file.mimeType, file.name);
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const save = () => saveMedia({ key: file.src, kind: "image", src: file.src, name: file.name, download: file.download });

  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      closeFile();
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, []);

  useEffect(() => {
    if (kind === "pdf") return;
    if (file.size !== undefined && file.size > MAX_TEXT_BYTES) return setLoad({ status: "large" });
    const controller = new AbortController();
    setLoad({ status: "loading" });
    fetch(file.src, { credentials: "same-origin", signal: controller.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        if (Number(r.headers.get("content-length")) > MAX_TEXT_BYTES) return setLoad({ status: "large" });
        setLoad({ status: "ready", text: await r.text() });
      })
      .catch(() => !controller.signal.aborted && setLoad({ status: "error" }));
    return () => controller.abort();
  }, [file.src, kind, attempt]);

  const meta = file.size !== undefined ? fileSize(file.size) : undefined;
  return (
    <FullscreenPanel className="z-[56]" role="dialog" aria-label={file.name}>
      <header className="flex items-center gap-1 border-b border-border px-2 pt-[env(safe-area-inset-top)]">
        <button type="button" onClick={closeFile} aria-label={t("viewer.close")} title={t("viewer.close")} className="flex size-11 shrink-0 items-center justify-center rounded-xl text-muted transition hover:bg-surface-2 hover:text-fg">
          <X className="size-5" />
        </button>
        <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">{file.name}</span>
        {meta && <span className="hidden shrink-0 text-xs text-muted sm:inline">{meta}</span>}
        <button type="button" onClick={save} aria-label={t("viewer.download")} title={t("viewer.download")} className="flex size-11 shrink-0 items-center justify-center rounded-xl text-muted transition hover:bg-surface-2 hover:text-fg">
          <Download className="size-5" />
        </button>
      </header>
      {kind === "pdf" ? (
        <iframe src={file.src} title={file.name} className="min-h-0 w-full flex-1 border-0 bg-surface" />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {load.status === "loading" && (
            <div className="flex h-full items-center justify-center text-muted">
              <Loader2 className="size-6 animate-spin" aria-label={t("viewer.loading")} />
            </div>
          )}
          {(load.status === "error" || load.status === "large") && (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-muted">
              <p>{load.status === "large" ? t("fileViewer.tooLarge") : t("viewer.failed")}</p>
              <div className="flex gap-2">
                {load.status === "error" && (
                  <button type="button" onClick={() => setAttempt((n) => n + 1)} className="press rounded-full border border-border px-3.5 py-1.5 text-fg hover:bg-surface-2">
                    {t("viewer.retry")}
                  </button>
                )}
                <button type="button" onClick={save} className="press rounded-full bg-accent px-3.5 py-1.5 font-medium text-white">
                  {t("viewer.download")}
                </button>
              </div>
            </div>
          )}
          {load.status === "ready" &&
            (kind === "markdown" ? (
              <div className="mx-auto w-full max-w-3xl px-5 py-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))]">
                <Markdown text={load.text} />
              </div>
            ) : (
              <pre className="mx-auto w-full max-w-5xl px-5 py-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] font-mono text-[13px] leading-relaxed break-words whitespace-pre-wrap text-fg">{load.text}</pre>
            ))}
        </div>
      )}
    </FullscreenPanel>
  );
}
