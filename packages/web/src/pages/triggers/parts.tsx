// Small pieces the Triggers section's parts share: a titled box, code in a line, a quiet note, the outside-content mark.

import type { ReactNode } from "react";
import { ShieldAlert } from "lucide-react";
import { t } from "../../i18n";
import { Badge } from "../../components/ui";

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

/**
 * "Outside content": a run read a page, a webhook or a letter, so its words (an error too) may carry that content. `hint`
 * says it in full on hover.
 */
export function ExternalMark({ hint }: { hint: string }) {
  return (
    <span title={hint} className="inline-flex shrink-0">
      <Badge tone="warning">
        <ShieldAlert className="size-3" aria-hidden />
        {t("triggers.run.external")}
      </Badge>
    </span>
  );
}
