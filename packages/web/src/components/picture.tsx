// Web pictures the hub held (policy/pictures.ts on the hub): an agent's picture whose address could carry data from the
// chat to its site loads only when the person taps Show. Until then a quiet line names the site; no card, no review.

import { useEffect, useState, type ImgHTMLAttributes, type ReactNode } from "react";
import { ImageOff } from "lucide-react";
import { api } from "../lib/api";
import { proxiedUrl } from "../lib/media";
import { t } from "../i18n";
import { cx } from "./ui";

/** After a picture failed to load: its web address when the hub held it (the person may show it), else undefined. */
async function heldUrl(shown: string): Promise<string | undefined> {
  const url = proxiedUrl(shown);
  if (!url) return undefined;
  try {
    return (await api.get<{ held: boolean }>(`/api/media/state?url=${encodeURIComponent(url)}`)).held ? url : undefined;
  } catch {
    return undefined;
  }
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

/** "Picture from example.com · Show". */
export function HeldPicture({ url, onShow, className }: { url: string; onShow: () => void; className?: string }) {
  const host = hostOf(url);
  return (
    <span className={cx("my-1 inline-flex max-w-full items-center gap-2 rounded-xl border border-dashed border-border px-3 py-2 text-[13px] text-muted", className)} title={t("message.images.heldHint", { host })}>
      <ImageOff className="size-4 shrink-0" />
      <span className="min-w-0 truncate">{t("message.images.held", { host })}</span>
      <button type="button" onClick={onShow} className="shrink-0 font-medium text-accent-text hover:underline">
        {t("message.images.show")}
      </button>
    </span>
  );
}

/**
 * A picture through `children(src, failed)` until it turns out held, then the Show line instead. `failed` is for the
 * image's error: it resolves true when the picture was held (the gate takes over), false when it is just unavailable.
 * After Show the picture loads again; failing then, it is unavailable.
 */
export function PictureGate({ src, className, children }: { src: string; className?: string; children: (src: string, failed: () => Promise<boolean>) => ReactNode }) {
  const [held, setHeld] = useState<string>();
  const [shown, setShown] = useState(false);
  useEffect(() => {
    setHeld(undefined);
    setShown(false);
  }, [src]);
  const failed = async () => {
    const url = shown ? undefined : await heldUrl(src);
    if (url) setHeld(url);
    return !!url;
  };
  const show = async () => {
    if (!held) return;
    try {
      await api.post("/api/media/show", { url: held });
      setShown(true);
      setHeld(undefined);
    } catch {
      // The hub did not take it: the line stays.
    }
  };
  if (held) return <HeldPicture url={held} onShow={() => void show()} className={className} />;
  // After Show: a new address, so the browser asks again instead of reusing the refusal.
  return <>{children(shown ? `${src}&shown=1` : src, failed)}</>;
}

/** A small picture (a news thumbnail, a cover) that stays out when it cannot load: held or unavailable. */
export function QuietImg({ onFail, ...props }: ImgHTMLAttributes<HTMLImageElement> & { onFail?: () => void }) {
  const [gone, setGone] = useState(false);
  useEffect(() => setGone(false), [props.src]);
  if (gone) return null;
  const fail = () => {
    setGone(true);
    onFail?.();
  };
  return <img {...props} onError={fail} />;
}
