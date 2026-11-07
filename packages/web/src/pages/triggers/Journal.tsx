// A trigger's journal: its last runs, each open to how many times in a row, whether it read outside content, its
// task, why it started nothing, its signals and its stages through the pipeline.

import { useCallback, useEffect, useState } from "react";
import { Link } from "wouter";
import { ChevronRight, ShieldAlert } from "lucide-react";
import { api, errorText } from "../../lib/api";
import { taskStatus } from "../../lib/format";
import {
  afterLoad,
  changedTrigger,
  errorMessage,
  formatAt,
  loadNote,
  reasonText,
  runBadge,
  sourceLabel,
  stageLines,
  triggerUrl,
  type Loaded,
  type TriggerRun,
  type TriggerView,
} from "../../lib/triggers";
import { hubEvents } from "../../state/app";
import { t } from "../../i18n";
import { Badge, Button, cx, Loading } from "../../components/ui";
import { LoadNote, Muted, Section } from "./parts";

export function Journal({ tr, tz }: { tr: TriggerView; tz: string }) {
  const [loaded, setLoaded] = useState<Loaded<TriggerRun[]>>({ value: null });
  const [limit, setLimit] = useState(20);
  const [open, setOpen] = useState<string>();
  const load = useCallback(() => {
    // A failed request keeps the runs already shown (or none) and says so; it never reads as "no runs yet".
    api.get<{ runs: TriggerRun[] }>(`${triggerUrl(tr.id, "runs")}?limit=${limit}`).then(
      (r) => setLoaded((l) => afterLoad(l, { value: r.runs ?? [] })),
      (e) => setLoaded((l) => afterLoad(l, { error: errorText(e) })),
    );
  }, [tr.id, limit]);
  useEffect(() => {
    load();
    return hubEvents.on((e) => {
      const id = changedTrigger(e);
      if (id === tr.id || id === "") load();
    });
  }, [load, tr.id]);
  const runs = loaded.value;
  const note = loadNote("journal", loaded);

  return (
    <Section title={t("triggers.journal.title")}>
      {note && <LoadNote text={note} onRetry={load} />}
      {!runs ? (
        !note && <Loading />
      ) : runs.length === 0 ? (
        <Muted>{t("triggers.journal.empty")}</Muted>
      ) : (
        <div className="-mx-3.5 -mb-3.5 border-t border-border">
          {runs.map((r) => (
            <RunRow key={r.id} run={r} tz={tz} open={open === r.id} onToggle={() => setOpen(open === r.id ? undefined : r.id)} />
          ))}
          {runs.length >= limit && limit < 200 && (
            <div className="border-t border-border px-3.5 py-2">
              <Button size="sm" variant="ghost" onClick={() => setLimit(200)}>
                {t("triggers.journal.more")}
              </Button>
            </div>
          )}
        </div>
      )}
    </Section>
  );
}

function RunRow({ run, tz, open, onToggle }: { run: TriggerRun; tz: string; open: boolean; onToggle: () => void }) {
  const badge = runBadge(run);
  return (
    <div className="border-b border-border last:border-b-0">
      <button type="button" aria-expanded={open} onClick={onToggle} className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left text-sm transition-colors hover:bg-surface-2/60">
        <ChevronRight className={cx("size-3.5 shrink-0 text-muted/70 transition-transform", open && "rotate-90")} />
        <span className="shrink-0 text-xs text-muted tabular-nums">{formatAt(run.at, tz)}</span>
        <span className="min-w-0 flex-1 truncate">{reasonText(run.reason)}</span>
        {(run.count ?? 1) > 1 && <span className="shrink-0 text-xs text-muted tabular-nums">{t("triggers.run.times", { n: run.count! })}</span>}
        {run.external && (
          <span title={t("triggers.run.externalHint")} className="shrink-0">
            <Badge tone="warning">
              <ShieldAlert className="size-3" />
              {t("triggers.run.external")}
            </Badge>
          </span>
        )}
        <Badge tone={badge.tone}>{badge.label}</Badge>
      </button>
      {open && <RunDetail run={run} tz={tz} />}
    </div>
  );
}

function RunDetail({ run, tz }: { run: TriggerRun; tz: string }) {
  const stages = stageLines(run.stages);
  // Why it started nothing; a script's error is shown once, on its stage.
  const why = run.taskId || (!run.code && stages.some((s) => s.error === run.detail)) ? "" : errorMessage(run.code, run.params, run.detail);
  return (
    <div className="flex flex-col gap-3 bg-surface-2/30 px-3.5 pt-1 pb-3.5 pl-9 text-sm">
      {(run.count ?? 1) > 1 && <Muted>{t("triggers.run.repeated", { n: run.count!, time: formatAt(run.lastAt ?? run.at, tz) })}</Muted>}
      {run.external && (
        <p className="flex items-start gap-1.5 text-xs leading-relaxed text-warning">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0" />
          {t("triggers.run.externalHint")}
        </p>
      )}
      {run.taskId && (
        <Link href={`/tasks/${encodeURIComponent(run.taskId)}`} className="inline-flex items-center gap-1 self-start text-sm font-medium text-accent-text hover:underline">
          {t("triggers.run.openTask")}
          {run.taskStatus ? <span className="font-normal text-muted">· {taskStatus(run.taskStatus).label}</span> : null}
          <ChevronRight className="size-3.5" />
        </Link>
      )}
      {why && <p className={cx("text-xs leading-relaxed break-words", run.status === "error" ? "text-danger" : "text-muted")}>{why}</p>}
      {run.outcome === "note" && run.noteId && <Muted>{t("triggers.run.noteKept")}</Muted>}
      {run.signals && run.signals.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium">{t("triggers.run.signals")}</span>
          <ul className="flex flex-col gap-1">
            {run.signals.map((s) => (
              <li key={s.id} className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs">
                <span>{sourceLabel(s.type) ?? s.type}</span>
                {s.subject && <span className="min-w-0 truncate text-muted">{s.subject}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {stages.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium">{t("triggers.run.stages")}</span>
          <ol className="flex flex-col gap-1.5">
            {stages.map((s, i) => (
              <li key={i} className="rounded-xl border border-border bg-surface px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] font-medium">{s.label}</span>
                  {s.verdict && <Badge tone={s.verdict.tone}>{s.verdict.label}</Badge>}
                  {s.cost && <span className="ml-auto text-xs text-muted tabular-nums">{s.cost}</span>}
                </div>
                {s.why && <p className="mt-1 text-xs leading-relaxed break-words text-muted">{s.why}</p>}
                {s.error && <p className="mt-1 text-xs leading-relaxed break-words text-danger">{s.error}</p>}
                {s.logs.length > 0 && (
                  <details className="group mt-1">
                    <summary className="flex cursor-pointer list-none items-center gap-1 text-xs text-muted select-none hover:text-fg [&::-webkit-details-marker]:hidden">
                      <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />
                      {t("triggers.run.logs")}
                    </summary>
                    <pre className="mt-1 max-h-60 overflow-auto rounded-lg bg-code-bg p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">{s.logs.join("\n")}</pre>
                  </details>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

