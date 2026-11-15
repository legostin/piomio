// Small pieces the Triggers section's parts share: a titled box, code in a line, a quiet note, the outside-content mark.

import type { ReactNode } from "react";
import { ShieldAlert } from "lucide-react";
import { t } from "../../i18n";
import { Badge, Button } from "../../components/ui";

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-border bg-surface p-3.5">
      <h4 className="mb-2.5 text-[11px] font-semibold tracking-wide text-muted uppercase">{title}</h4>
      {children}
    </section>
  );
}

export const Mono = ({ children }: { children: ReactNode }) => <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs break-all">{children}</code>;
export const Muted = ({ children }: { children: ReactNode }) => <p className="text-xs leading-relaxed break-words text-muted">{children}</p>;

/** A short line for a load that failed (lib/triggers.ts loadNote), with Retry. */
export function LoadNote({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-danger">
      <span className="min-w-0 break-words">{text}</span>
      <Button size="sm" variant="ghost" onClick={onRetry}>
        {t("common.retry")}
      </Button>
    </div>
  );
}

/**
 * "Outside content": a run read a page, a webhook or a letter, so its words (an error too) may carry that content. `hint`
 * says it in full on hover. `compact` (a journal row): only the icon in a container under 32rem (a phone, the 540px
 * panel), so the row's reason keeps its room; the words stay for screen readers, in `title` and in the opened run.
 */
export function ExternalMark({ hint, compact }: { hint: string; compact?: boolean }) {
  return (
    <span title={hint} className="inline-flex shrink-0">
      <Badge tone="warning">
        <ShieldAlert className="size-3" aria-hidden />
        <span className={compact ? "sr-only @lg:not-sr-only" : undefined}>{t("triggers.run.external")}</span>
      </Badge>
    </span>
  );
}
