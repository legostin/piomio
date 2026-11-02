// A command to copy: the code on the dark block with a Copy button (the install section and the server guide).

import { useState } from "react";
import { useI18n } from "../i18n";
import { Check, Copy } from "./icons";

export function CopyBlock({ code }: { code: string }) {
  const { t } = useI18n();
  const [done, setDone] = useState(false);
  return (
    <div className="relative">
      {/* Long commands wrap rather than scroll under the button (above the code on a phone); copying takes the code as it is. */}
      <pre className="rounded-2xl bg-[var(--code-bg)] pt-14 pr-5 pb-4 pl-5 font-mono sm:pt-4 sm:pr-32 text-[13px] leading-relaxed whitespace-pre-wrap text-[var(--code-fg)] [overflow-wrap:anywhere]">{code}</pre>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(code).then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1600);
          });
        }}
        className="absolute top-3 right-3 inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-[12px] font-semibold text-[var(--code-fg)] transition-colors hover:bg-white/20"
      >
        {done ? <Check size={13} /> : <Copy size={13} />}
        {done ? t("install.copied") : t("install.copy")}
      </button>
    </div>
  );
}
