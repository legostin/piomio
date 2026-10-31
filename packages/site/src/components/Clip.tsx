// A clip of the real app, recorded from the demo (assets/clips/<lang>-<chapter>.mp4 and its still), looping like a
// GIF at a fraction of a GIF's weight. It loads and plays only while on screen; where it cannot play, its still stays.

import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import type { ChapterId } from "../demo/protocol";

const FILES = import.meta.glob("../assets/clips/*.{mp4,jpg}", { eager: true, query: "?url", import: "default" }) as Record<string, string>;

function file(name: string): string | undefined {
  return FILES[`../assets/clips/${name}`];
}

export function Clip({ chapter, label }: { chapter: ChapterId; label: string }) {
  const { lang, t } = useI18n();
  const video = useRef<HTMLVideoElement>(null);
  const [broken, setBroken] = useState(false);
  const src = file(`${lang}-${chapter}.mp4`);
  const still = file(`${lang}-${chapter}.jpg`);

  useEffect(() => {
    const v = video.current;
    if (!v) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) void v.play().catch(() => {});
        else v.pause();
      },
      { threshold: 0.25 },
    );
    io.observe(v);
    return () => io.disconnect();
  }, [src]);

  return (
    <div className="overflow-hidden rounded-[18px] bg-canvas shadow-[var(--shadow-window)]">
      <div className="flex h-9 items-center gap-1.5 border-b border-hairline px-3.5">
        <span className="size-2.5 rounded-full bg-[#ff5f57]" />
        <span className="size-2.5 rounded-full bg-[#febc2e]" />
        <span className="size-2.5 rounded-full bg-[#28c840]" />
        <span className="ml-2.5 truncate text-[12px] font-medium text-muted">{t("demo.windowTitle")}</span>
      </div>
      <div className="relative aspect-[1120/700] bg-bg">
        {src && !broken ? (
          <video
            ref={video}
            src={src}
            poster={still}
            muted
            loop
            playsInline
            preload="none"
            aria-label={label}
            onError={() => setBroken(true)}
            className="absolute inset-0 block size-full object-cover"
          />
        ) : (
          still && <img src={still} alt={label} loading="lazy" onError={(e) => (e.currentTarget.style.visibility = "hidden")} className="absolute inset-0 size-full object-cover" />
        )}
      </div>
    </div>
  );
}
