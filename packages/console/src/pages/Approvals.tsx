import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, Bell, BellOff, Check, ChevronDown, Code2, Inbox, Repeat, ShieldCheck, Volume2, VolumeX, X } from "lucide-react";
import { api, errorText } from "../api.ts";
import type { ApprovalStatus, ApprovalView, ToolResult } from "../types.ts";
import { flattenInput, formatDate, relativeTime, splitUrls, type InputRow } from "../lib/format.ts";
import { navigate } from "../router.ts";
import { useSession, useLiveEvents } from "../session.tsx";
import { useAsync, useNow, useTools } from "../hooks.ts";
import { setPrefs, usePrefs } from "../prefs.ts";
import { chime, notificationPermission, notificationsSupported } from "../alerts.ts";
import { Badge, Button, Callout, Card, cx, ErrorText, IconButton, PageHeader, Segmented, Spinner, EmptyState } from "../ui/kit.tsx";
import { Dialog, useToast } from "../ui/overlay.tsx";
import { t, useLocale, type MessageKey } from "../i18n/index.ts";
import { effectLabel, emptyRuleForm, formFromRule, RuleForm, ruleFromForm, type RuleFormValue } from "./RuleForm.tsx";

const HISTORY_STATUSES = "approved,denied,expired,executed,failed";

export function ApprovalsPage({ focusId }: { focusId?: string }) {
  const { pending, pendingError, refreshPending } = useSession();
  const [tab, setTab] = useState<"pending" | "history">("pending");
  const now = useNow();

  // A deep link to something that is no longer pending: show it in the history.
  const focusPending = !!focusId && !!pending?.some((a) => a.id === focusId);
  useEffect(() => {
    if (focusId && pending && !focusPending) setTab("history");
    if (focusId && focusPending) setTab("pending");
  }, [focusId, pending, focusPending]);

  return (
    <div>
      <PageHeader
        title={t("approvals.title")}
        description={t("approvals.description")}
        actions={<AlertControls />}
      />

      <div className="mb-4 flex items-center justify-between gap-3">
        <Segmented
          value={tab}
          onChange={(next) => {
            setTab(next);
            if (focusId) navigate("#/approvals");
          }}
          options={[
            {
              value: "pending",
              label: (
                <span className="inline-flex items-center gap-1.5">
                  {t("approvals.tab.pending")}
                  {pending && pending.length > 0 && <span className="rounded-full bg-amber-500 px-1.5 text-[11px] font-semibold leading-4 text-amber-950">{pending.length}</span>}
                </span>
              ),
            },
            { value: "history", label: t("approvals.tab.history") },
          ]}
        />
      </div>

      {tab === "pending" ? (
        <PendingList pending={pending} error={pendingError} reload={refreshPending} focusId={focusId} now={now} />
      ) : (
        <HistoryList focusId={focusId} now={now} />
      )}
    </div>
  );
}

function PendingList({ pending, error, reload, focusId, now }: { pending?: ApprovalView[]; error?: string; reload: () => Promise<void>; focusId?: string; now: number }) {
  if (!pending) {
    return error ? <LoadError error={error} retry={reload} /> : <Loading />;
  }
  if (pending.length === 0) {
    return (
      <EmptyState icon={<ShieldCheck className="size-8" />} title={t("approvals.empty.title")}>
        {t("approvals.empty.body")}
      </EmptyState>
    );
  }
  return (
    <div className="space-y-4">
      {pending.map((a) => (
        <ApprovalCard key={a.id} a={a} highlighted={a.id === focusId} now={now} />
      ))}
    </div>
  );
}

function Loading() {
  return (
    <div className="flex justify-center py-16">
      <Spinner />
    </div>
  );
}

export function LoadError({ error, retry }: { error: string; retry: () => void | Promise<void> }) {
  return (
    <Card className="flex flex-col items-center gap-3 px-6 py-10 text-center">
      <ErrorText>{error}</ErrorText>
      <Button onClick={() => void retry()}>{t("common.retry")}</Button>
    </Card>
  );
}

// ---------- alert controls ----------

function AlertControls() {
  const prefs = usePrefs();
  const toast = useToast();
  const [perm, setPerm] = useState(notificationPermission());
  const supported = notificationsSupported();

  const toggleNotify = async () => {
    if (!supported) return;
    if (perm === "default") {
      const p = await Notification.requestPermission();
      setPerm(p);
      if (p === "granted") {
        setPrefs({ notify: true });
        toast(t("approvals.notify.enabled"));
      } else if (p === "denied") {
        toast(t("approvals.notify.denied"), "info");
      }
      return;
    }
    if (perm === "denied") {
      toast(t("approvals.notify.blocked"), "info");
      return;
    }
    setPrefs({ notify: !prefs.notify });
  };

  const notifyOn = perm === "granted" && prefs.notify;
  return (
    <>
      <IconButton
        label={prefs.sound ? t("approvals.sound.on") : t("approvals.sound.off")}
        onClick={() => {
          setPrefs({ sound: !prefs.sound });
          if (!prefs.sound) setTimeout(chime, 0);
        }}
        className="size-10 border border-line bg-surface"
      >
        {prefs.sound ? <Volume2 className="size-4.5" /> : <VolumeX className="size-4.5" />}
      </IconButton>
      {supported && (
        <Button onClick={() => void toggleNotify()} icon={notifyOn ? <Bell className="size-4" /> : <BellOff className="size-4" />} title={t("approvals.notify.hint")}>
          {perm === "default" ? t("approvals.notify.enable") : notifyOn ? t("approvals.notify.on") : t("approvals.notify.off")}
        </Button>
      )}
    </>
  );
}

// ---------- pending card ----------

function ApprovalCard({ a, highlighted, now }: { a: ApprovalView; highlighted: boolean; now: number }) {
  const { dropPending, refreshPending } = useSession();
  const toast = useToast();
  const ref = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState<"approve" | "deny">();
  const [remember, setRemember] = useState(false);

  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [highlighted]);

  const resolve = async (decision: "approve" | "deny", permanent = false) => {
    setBusy(decision);
    try {
      await api.resolveApproval(a.id, { decision, remember: permanent });
      dropPending(a.id);
      toast(decision === "approve" ? t(permanent ? "approvals.rememberedToast" : "approvals.approvedOnce") : t("approvals.denied"));
      if (highlighted) navigate("#/approvals");
    } catch (e) {
      toast(errorText(e), "error");
      void refreshPending();
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <Card ref={ref} className={cx("scroll-mt-24 overflow-hidden", highlighted && "owl-flash ring-2 ring-accent-500")} data-approval={a.id}>
      <div className="space-y-4 p-4 sm:p-5">
        <CardHead a={a} now={now} />
        <p className="text-[15px] leading-relaxed font-medium whitespace-pre-wrap text-fg [overflow-wrap:anywhere] sm:text-base">{a.summary}</p>

        {a.tainted && (
          <Callout tone="warn" title={t("approvals.tainted.title")}>
            {t("approvals.tainted.body")}
          </Callout>
        )}

        {a.ask?.kind === "network" && <Callout tone="warn" title={t("approvals.network.scope")}>
          {t(a.ask.ipLiteral ? "approvals.network.ip" : "approvals.network.always")}
        </Callout>}
        <ToolLine tool={a.tool} description={a.toolDescription} />
        <InputView input={a.input} />
        <Meta a={a} />
      </div>

      <div className="flex flex-col gap-2 border-t border-line bg-inset/50 p-3 sm:flex-row sm:items-center sm:px-5">
        <Button variant="primary" size="lg" className="sm:h-10 sm:text-sm" icon={<Check className="size-4.5" />} loading={busy === "approve"} disabled={!!busy} onClick={() => void resolve("approve")}>
          {t("approvals.approveOnce")}
        </Button>
        <div className="grid grid-cols-2 gap-2 sm:contents">
          <Button icon={<Repeat className="size-4" />} disabled={!!busy} onClick={() => a.ask?.kind === "network" ? void resolve("approve", true) : setRemember(true)}>
            <span className="sm:hidden">{t("approvals.always.short")}</span>
            <span className="hidden sm:inline">{t("approvals.always.long")}</span>
          </Button>
          <Button variant="danger" className="sm:ml-auto" icon={<X className="size-4" />} loading={busy === "deny"} disabled={!!busy} onClick={() => void resolve("deny")}>
            {t("approvals.deny")}
          </Button>
        </div>
      </div>

      <RememberDialog
        open={remember}
        a={a}
        onClose={() => setRemember(false)}
        onDone={() => {
          setRemember(false);
          dropPending(a.id);
          toast(t("approvals.rememberedToast"));
          if (highlighted) navigate("#/approvals");
        }}
      />
    </Card>
  );
}

function CardHead({ a, now, status }: { a: ApprovalView; now: number; status?: ReactNode }) {
  const name = a.agentName ?? a.agentId;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-brand-soft text-sm font-semibold text-brand-fg ring-1 ring-brand-line" aria-hidden>
          {name.slice(0, 1).toUpperCase()}
        </span>
        <div className="min-w-0 leading-tight">
          <div className="truncate text-sm font-semibold text-fg">{name}</div>
          <div className="text-xs text-muted" title={formatDate(a.createdAt, true)}>
            {relativeTime(a.createdAt, now)}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {status}
        <Badge tone={a.effect === "external" ? "warn" : a.effect === "local-write" ? "brand" : "neutral"}>{effectLabel(a.effect)}</Badge>
      </div>
    </div>
  );
}

function ToolLine({ tool, description }: { tool: string; description?: string }) {
  const [open, setOpen] = useState(false);
  const long = !!description && description.length > 140;
  return (
    <div className="text-sm">
      <span className="text-muted">{t("approvals.tool")} </span>
      <span className="rounded bg-inset px-1.5 py-0.5 font-mono text-[13px] text-fg ring-1 ring-line">{tool}</span>
      {description && (
        <p className={cx("mt-1.5 text-[13px] leading-relaxed text-muted", long && !open && "line-clamp-2")}>
          {description}
          {long && (
            <button type="button" className="ml-1 text-brand-fg hover:underline" onClick={() => setOpen((o) => !o)}>
              {open ? t("approvals.collapse") : t("approvals.more")}
            </button>
          )}
        </p>
      )}
    </div>
  );
}

function Meta({ a }: { a: ApprovalView }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-faint">
      <span>
        {t("approvals.created")} <span className="text-muted">{formatDate(a.createdAt, true)}</span>
      </span>
      {a.taskId && (
        <span>
          {t("approvals.task")} <span className="font-mono text-muted">{a.taskId}</span>
        </span>
      )}
      <span>
        id: <span className="font-mono text-muted">{a.id}</span>
      </span>
    </div>
  );
}

// ---------- exact input ----------

export function InputView({ input }: { input: unknown }) {
  const [raw, setRaw] = useState(false);
  const locale = useLocale();
  // Placeholder texts ("(empty string)" etc.) are localized, so recompute on a language switch.
  const rows = useMemo(() => flattenInput(input), [input, locale]);
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-xs font-semibold tracking-wide text-muted uppercase">{t("approvals.exactInput")}</span>
        <button type="button" onClick={() => setRaw((r) => !r)} className="inline-flex items-center gap-1 text-xs font-medium text-brand-fg hover:underline" aria-expanded={raw}>
          <Code2 className="size-3.5" />
          {raw ? t("approvals.hideJson") : t("approvals.showJson")}
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="rounded-lg border border-line bg-inset px-3 py-2 text-sm text-muted">{t("approvals.noParams")}</p>
      ) : (
        <dl className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-inset">
          {rows.map((r) => (
            <div key={r.key} className="grid gap-0.5 px-3 py-2 sm:grid-cols-[minmax(7rem,11rem)_1fr] sm:gap-3">
              <dt className="pt-px font-mono text-xs break-all text-muted sm:text-[13px]">{r.key}</dt>
              <dd className="min-w-0">
                <Value row={r} />
              </dd>
            </div>
          ))}
        </dl>
      )}
      {raw && (
        <pre className="mt-2 max-h-96 overflow-auto rounded-lg border border-line bg-inset p-3 font-mono text-xs leading-relaxed text-fg">{JSON.stringify(input, null, 2)}</pre>
      )}
    </div>
  );
}

function Value({ row }: { row: InputRow }) {
  const [full, setFull] = useState(false);
  if (row.kind === "empty") return <span className="text-sm text-faint italic">{row.text}</span>;
  if (row.kind === "boolean" || row.kind === "number") return <span className="font-mono text-sm text-fg">{row.text}</span>;
  if (row.kind === "list") {
    return (
      <ul className="space-y-0.5">
        {row.items!.map((it, i) => (
          <li key={i} className="font-mono text-sm break-words text-fg">
            <Linkified text={it} />
          </li>
        ))}
      </ul>
    );
  }
  if (row.kind === "json") {
    return <pre className="max-h-64 overflow-auto font-mono text-xs leading-relaxed text-fg">{row.text}</pre>;
  }
  const long = row.text.length > 700 || row.text.split("\n").length > 14;
  return (
    <div>
      <div className={cx("font-mono text-sm leading-relaxed whitespace-pre-wrap text-fg [overflow-wrap:anywhere]", long && !full && "max-h-72 overflow-hidden [mask-image:linear-gradient(to_bottom,black_80%,transparent)]")}>
        <Linkified text={row.text} />
      </div>
      {long && (
        <button type="button" className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-brand-fg hover:underline" onClick={() => setFull((f) => !f)}>
          <ChevronDown className={cx("size-3.5 transition-transform", full && "rotate-180")} />
          {full ? t("approvals.collapseFull") : t("approvals.showFull", { count: row.text.length })}
        </button>
      )}
    </div>
  );
}

/** Plain text with URL hosts emphasised, so a look-alike domain stands out. Never rendered as clickable links. */
function Linkified({ text }: { text: string }) {
  const parts = splitUrls(text);
  return (
    <>
      {parts.map((p, i) =>
        p.url ? (
          <span key={i} className="rounded-sm bg-warn-soft/70 px-0.5">
            <span className="text-muted">{p.url.before}</span>
            <span className="font-semibold text-fg underline decoration-warn decoration-2 underline-offset-2">{p.url.host}</span>
            <span className="text-muted">{p.url.after}</span>
          </span>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

// ---------- "always allow" ----------

function RememberDialog({ open, a, onClose, onDone }: { open: boolean; a: ApprovalView; onClose: () => void; onDone: () => void }) {
  const tools = useTools();
  const [form, setForm] = useState<RuleFormValue>(emptyRuleForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open) return;
    const base = a.suggestedRule ?? { tool: a.tool, agentId: a.agentId, conditions: [], decision: "allow" as const };
    setForm({ ...formFromRule(base), decision: "allow" });
    setError(undefined);
  }, [open, a]);

  const save = async () => {
    const r = ruleFromForm(form);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await api.resolveApproval(a.id, { decision: "approve", remember: true, rule: { ...r.rule, decision: "allow" } });
      onDone();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={t("approvals.remember.title")}
      description={t("approvals.remember.description")}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" onClick={() => void save()} loading={busy} icon={<Check className="size-4" />}>
            {t("approvals.remember.submit")}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="rounded-lg border border-line bg-inset px-3 py-2.5 text-sm">
          <div className="text-xs text-muted">{t("approvals.remember.request")}</div>
          <div className="mt-0.5 font-medium text-fg [overflow-wrap:anywhere]">{a.summary}</div>
        </div>
        {a.tainted && (
          <Callout tone="warn" title={t("approvals.tainted.title")}>
            {t("approvals.remember.taintedBody")}
          </Callout>
        )}
        <RuleForm value={form} onChange={setForm} tools={tools} sample={{ tool: a.tool, agentId: a.agentId, agentName: a.agentName, input: a.input }} />
        <ErrorText>{error}</ErrorText>
      </div>
    </Dialog>
  );
}

// ---------- history ----------

const STATUS_TONE: Record<Exclude<ApprovalStatus, "pending">, "ok" | "danger" | "neutral"> = {
  approved: "ok",
  executed: "ok",
  failed: "danger",
  denied: "danger",
  expired: "neutral",
  blocked: "neutral",
};

const VIA = new Set(["console", "telegram", "rule", "timeout", "request", "auto"]);
const viaLabel = (via: string | undefined): string => (via && VIA.has(via) ? t(`approvals.via.${via}` as MessageKey) : (via ?? ""));

function HistoryList({ focusId, now }: { focusId?: string; now: number }) {
  const { data, error, reload, loading } = useAsync(() => api.approvals(HISTORY_STATUSES), []);
  useLiveEvents((e) => {
    if (e.type === "approval.resolved") void reload();
  });

  if (!data) return error ? <LoadError error={error} retry={reload} /> : <Loading />;
  const focusMissing = focusId && !loading && !data.some((a) => a.id === focusId);
  return (
    <div className="space-y-3">
      {focusMissing && (
        <Callout tone="warn" title={t("approvals.notFound.title")}>
          {t("approvals.notFound.body", { id: focusId })}
        </Callout>
      )}
      {data.length === 0 ? (
        <EmptyState icon={<Inbox className="size-8" />} title={t("approvals.history.empty.title")}>
          {t("approvals.history.empty.body")}
        </EmptyState>
      ) : (
        data.map((a) => <HistoryCard key={a.id} a={a} now={now} highlighted={a.id === focusId} />)
      )}
    </div>
  );
}

function HistoryCard({ a, now, highlighted }: { a: ApprovalView; now: number; highlighted: boolean }) {
  const [open, setOpen] = useState(highlighted);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (highlighted) {
      setOpen(true);
      ref.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [highlighted]);
  const tone = STATUS_TONE[a.status as Exclude<ApprovalStatus, "pending">];
  const st = tone ? { label: t(`approvals.status.${a.status}` as MessageKey), tone } : { label: a.status, tone: "neutral" as const };
  return (
    <Card ref={ref} className={cx("scroll-mt-24", highlighted && "owl-flash ring-2 ring-accent-500")}>
      <div
        role="button"
        tabIndex={0}
        className="block w-full cursor-pointer p-4 text-left sm:px-5"
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen((o) => !o);
          }
        }}
        aria-expanded={open}
      >
        <CardHead a={a} now={now} status={<Badge tone={st.tone}>{st.label}</Badge>} />
        <p className="mt-3 text-sm leading-relaxed text-fg [overflow-wrap:anywhere]">{a.summary}</p>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          <span className="font-mono">{a.tool}</span>
          {a.resolvedAt && (
            <span>
              {t("approvals.resolved", { via: viaLabel(a.resolvedVia), date: formatDate(a.resolvedAt) })}
            </span>
          )}
          {a.tainted && (
            <span className="inline-flex items-center gap-1 text-warn">
              <AlertTriangle className="size-3.5" /> {t("approvals.externalContent")}
            </span>
          )}
          <ChevronDown className={cx("ml-auto size-4 transition-transform", open && "rotate-180")} />
        </div>
      </div>
      {open && (
        <div className="space-y-4 border-t border-line p-4 sm:px-5">
          {highlighted && (
            <Callout tone="brand" title={t("approvals.alreadyResolved")}>
              {t("approvals.statusLine", { status: st.label, via: a.resolvedVia ? `, ${viaLabel(a.resolvedVia)}` : "" })}
            </Callout>
          )}
          <ToolLine tool={a.tool} description={a.toolDescription} />
          <InputView input={a.input} />
          {a.result && <ResultView result={a.result} />}
          <Meta a={a} />
        </div>
      )}
    </Card>
  );
}

function ResultView({ result }: { result: ToolResult }) {
  const text = result.content
    .map((p) => (p.type === "text" ? p.text : t("approvals.image", { type: p.mimeType })))
    .join("\n\n")
    .trim();
  return (
    <div>
      <div className="mb-1.5 text-xs font-semibold tracking-wide text-muted uppercase">{t("approvals.result")}</div>
      <pre
        className={cx(
          "max-h-80 overflow-auto rounded-lg border p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]",
          result.isError ? "border-danger-line bg-danger-soft text-danger" : "border-line bg-inset text-fg",
        )}
      >
        {text || t("approvals.resultEmpty")}
      </pre>
    </div>
  );
}
