// UI of the memory plugin:
// - page /memory: "What the team knows about you", grouped by meaning, with search, the review queue first, a fact's
//   detail inline (where it came from, what it replaced, its history), editing in place, forget with Undo;
// - a quiet line under an agent's message when it remembers something ("Remembered: … · Undo");
// - on the page, the team's rules for work (the hub's work rules: where work of some kind goes and how it thinks),
//   when there are any: they are remembered too, and dropped here like a fact.
// No dialogs: everything happens in place.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { definePluginUI, Markdown, native, Spinner, type PiomioUI, type ToolResultProps } from "@piomio/ui";
import { plainText, withBreaks } from "./plain.ts";

type Kind = "self" | "preference" | "person" | "place" | "project" | "event" | "howto" | "note";
const KINDS: Kind[] = ["self", "preference", "person", "place", "project", "event", "howto", "note"];

interface Source {
  agentId: string;
  conversationId: string;
  sessionId: string;
  at: string;
  quote: string;
}

interface FactView {
  path: string;
  title: string;
  text: string;
  kind: Kind;
  about: string[];
  slot: string;
  tags: string[];
  importance: number;
  confidence: number;
  validFrom: string;
  validUntil: string;
  supersededBy: string;
  supersedes: string[];
  scope: string;
  sensitive: boolean;
  status: "active" | "review" | "archived";
  created: string;
  updated: string;
  source: Source | null;
  trashedAt?: string;
}

interface FactsResponse {
  facts: FactView[];
  review: number;
  counts: Record<Kind, number>;
  archived: number;
}

interface Detail {
  fact: FactView & { sources: Source[] };
  before: FactView[];
  history: Array<{ rev: string; at: string; action: string; message: string }>;
}

interface ReviewItem extends FactView {
  current?: FactView;
}

let UI: PiomioUI;
let t: PiomioUI["i18n"]["t"] = (key) => key;
const http = <T,>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown) => UI.plugin.http<T>(method, path, body);
const enc = encodeURIComponent;

/** Backend errors arrive in the reader's language (`error`); older ones carry a code from the catalogs. */
function errText(e: any): string {
  const body = e?.body ?? e;
  if (typeof body?.error === "string") return body.error;
  if (typeof body?.code === "string") {
    const key = `ui.error.${body.code}`;
    const text = t(key, body.params ?? {});
    if (text !== key) return text;
  }
  return e?.message ?? String(e);
}

// ---------- formatting ----------

function when(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  const days = Math.round((Date.now() - d.getTime()) / 86_400_000);
  if (iso.length > 10 && Math.abs(days) < 1) return UI.i18n.formatDate(d, { hour: "2-digit", minute: "2-digit" });
  if (Math.abs(days) < 7 && iso.length > 10) return new Intl.RelativeTimeFormat(UI.i18n.locale, { numeric: "auto" }).format(-days, "day");
  return UI.i18n.formatDate(d, d.getFullYear() === new Date().getFullYear() ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" });
}

let agentNames: Record<string, string> = {};
async function loadAgents(): Promise<void> {
  try {
    const list = await UI.api.get<Array<{ id: string; name: string }>>("/api/agents");
    agentNames = Object.fromEntries(list.map((a) => [a.id, a.name]));
  } catch {
    /* names fall back to ids */
  }
}
const agentName = (id: string) => (id === "user" ? t("ui.you") : (agentNames[id] ?? id));

const factText = (f: FactView) => f.text?.trim() || f.title;
/** One- or two-line previews: the words without Markdown's marks. */
const factPreview = (f: FactView) => plainText(factText(f));

// ---------- styles (theme tokens of the host) ----------

const CSS = `
.owm{max-width:760px;margin:0 auto;padding:28px 20px 80px;box-sizing:border-box;color:var(--fg);font-size:15px;line-height:1.5}
.owm *{box-sizing:border-box}
.owm-head{display:flex;align-items:flex-end;gap:12px;margin-bottom:18px}
.owm-h1{font-size:26px;font-weight:650;letter-spacing:-.01em;margin:0}
.owm-sub{color:var(--muted);font-size:14px;margin-top:2px}
.owm-tools{margin-left:auto;display:flex;gap:4px}
.owm-link{border:0;background:transparent;color:var(--muted);font:inherit;font-size:13px;padding:4px 8px;border-radius:8px;cursor:pointer}
.owm-link:hover{color:var(--fg);background:var(--surface-2)}
.owm-link.strong{color:var(--fg);font-weight:550}
.owm-search{width:100%;padding:11px 14px 11px 38px;border-radius:12px;border:1px solid var(--border);background:var(--surface) no-repeat 13px 50%/16px;color:var(--fg);font:inherit;outline:none;box-shadow:var(--shadow)}
.owm-search:focus{border-color:var(--muted)}
.owm-searchwrap{position:relative;margin-bottom:22px}
.owm-searchwrap svg{position:absolute;left:13px;top:50%;transform:translateY(-50%);color:var(--muted)}
.owm-chips{display:flex;flex-wrap:wrap;gap:6px;margin:-8px 0 20px}
.owm-chip{border:1px solid var(--border);background:var(--surface);color:var(--fg);border-radius:999px;padding:3px 11px;font:inherit;font-size:13px;cursor:pointer}
.owm-chip span{color:var(--muted);margin-left:5px}
.owm-chip.on{background:var(--accent);color:var(--accent-fg);border-color:var(--accent)}
.owm-chip.on span{color:inherit;opacity:.7}
.owm-review{border:1px solid color-mix(in srgb,var(--warning) 35%,transparent);background:var(--warning-soft);border-radius:16px;padding:14px 16px;margin-bottom:26px}
.owm-review h3{margin:0 0 8px;font-size:14px;font-weight:600;color:var(--warning)}
.owm-ritem{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:flex-start;padding:8px 0;border-top:1px solid color-mix(in srgb,var(--warning) 20%,transparent)}
.owm-ritem:first-of-type{border-top:0}
.owm-ritem .txt{flex:1 1 260px;min-width:0}
.owm-btn{border:1px solid var(--border);background:var(--surface);color:var(--fg);font:inherit;font-size:13px;font-weight:550;padding:5px 12px;border-radius:999px;cursor:pointer;white-space:nowrap}
.owm-btn:hover{background:var(--surface-2)}
.owm-btn.primary{background:var(--accent);color:var(--accent-fg);border-color:var(--accent)}
.owm-btn.primary:hover{opacity:.9}
.owm-btn:disabled{opacity:.5;cursor:default}
.owm-sec{margin-bottom:26px}
.owm-sech{display:flex;align-items:baseline;gap:8px;margin:0 0 6px;padding:0 4px}
.owm-sech h2{font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:0}
.owm-sech span{font-size:12px;color:var(--muted)}
.owm-card{background:var(--surface);border:1px solid var(--border);border-radius:16px;overflow:hidden;box-shadow:var(--shadow)}
.owm-row{position:relative;padding:11px 16px;border-top:1px solid var(--border);cursor:pointer;transition:background .12s}
.owm-row:first-child{border-top:0}
.owm-row:hover{background:var(--surface-2)}
.owm-row.open{background:var(--surface-2);cursor:default}
.owm-text{white-space:pre-wrap;word-break:break-word}
.owm-row:not(.open) .owm-text{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.owm-md{word-break:break-word}
.owm-md .md{font-size:15px;line-height:1.55}
.owm-md .md h1,.owm-md .md h2,.owm-md .md h3,.owm-md .md h4{font-size:15px}
.owm-meta{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:4px;font-size:12.5px;color:var(--muted)}
.owm-tag{background:var(--surface-3);color:var(--fg);border-radius:6px;padding:0 6px;font-size:12px}
.owm-own{color:var(--info)}
.owm-dots{display:inline-flex;gap:3px;vertical-align:middle}
.owm-dot{width:6px;height:6px;border-radius:50%;background:var(--surface-3);border:0;padding:0}
.owm-dot.on{background:var(--fg)}
button.owm-dot{cursor:pointer;width:9px;height:9px}
.owm-acts{position:absolute;right:10px;top:9px;display:none;gap:2px}
.owm-row:hover .owm-acts{display:flex}
.owm-row.open .owm-acts{display:none}
.owm-detail{margin-top:12px;display:flex;flex-direction:column;gap:10px;font-size:13.5px}
.owm-from{color:var(--muted)}
.owm-from a{color:var(--fg);text-decoration:underline;text-decoration-color:var(--border);text-underline-offset:3px;cursor:pointer}
.owm-quote{border-left:2px solid var(--border);padding-left:10px;color:var(--muted);font-style:italic}
.owm-lbl{font-size:12px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:3px}
.owm-old{color:var(--muted);text-decoration:line-through;text-decoration-color:color-mix(in srgb,var(--muted) 50%,transparent)}
.owm-hist{display:flex;gap:10px;color:var(--muted);font-size:12.5px}
.owm-hist b{font-weight:500;color:var(--fg)}
.owm-hist button{margin-left:auto}
.owm-bar{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.owm-edit{width:100%;min-height:84px;padding:9px 11px;border-radius:10px;border:1px solid var(--border);background:var(--surface);color:var(--fg);font:inherit;resize:vertical;outline:none}
.owm-edit:focus{border-color:var(--muted)}
.owm-gone{padding:10px 16px;border-top:1px solid var(--border);color:var(--muted);font-size:13.5px;display:flex;gap:8px;align-items:center}
.owm-gone:first-child{border-top:0}
.owm-empty{text-align:center;padding:60px 20px;color:var(--muted)}
.owm-empty .owl{font-size:34px;letter-spacing:-.05em;color:var(--fg);font-weight:700;margin-bottom:10px}
.owm-more{display:block;width:100%;text-align:left;padding:9px 16px;border:0;border-top:1px solid var(--border);background:transparent;color:var(--muted);font:inherit;font-size:13px;cursor:pointer}
.owm-more:hover{color:var(--fg);background:var(--surface-2)}
.owm-quiet{display:flex;gap:4px;justify-content:center;margin-top:8px}
.owm-err{color:var(--danger);font-size:13px;margin:6px 0}
.owm-done{color:var(--success);font-size:13px}
.owm-line{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:6px 0 2px;font-size:13px;color:var(--muted)}
.owm-line svg{flex-shrink:0}
.owm-line .what{color:var(--fg);cursor:pointer;max-width:520px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.owm-line .what:hover{text-decoration:underline;text-underline-offset:3px}
.owm-line .sep{opacity:.5}
.owm-line button.l{border:0;background:transparent;padding:0;font:inherit;color:var(--muted);text-decoration:underline;text-underline-offset:3px;cursor:pointer}
.owm-line button.l:hover{color:var(--fg)}
.owm-line.ask{background:var(--warning-soft);color:var(--fg);border-radius:12px;padding:8px 12px;display:inline-flex}
@media (max-width:640px){.owm{padding:18px 14px 80px}.owm-h1{font-size:22px}.owm-head{flex-wrap:wrap}.owm-tools{margin-left:0;width:100%}.owm-acts{display:none!important}}
`;

function ensureStyles(): void {
  if (document.getElementById("owm-styles")) return;
  const el = document.createElement("style");
  el.id = "owm-styles";
  el.textContent = CSS;
  document.head.appendChild(el);
}

const Icon = {
  search: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>,
  brain: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" /><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" /><path d="M12 5v13" /></svg>,
  edit: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>,
  x: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>,
};

function Dots({ value, onSet }: { value: number; onSet?: (n: number) => void }) {
  return (
    <span className="owm-dots" title={t("ui.importance", { n: value })}>
      {[1, 2, 3, 4, 5].map((n) =>
        onSet ? (
          <button key={n} className={`owm-dot${n <= value ? " on" : ""}`} aria-label={t("ui.importance", { n })} onClick={() => onSet(n)} />
        ) : (
          <span key={n} className={`owm-dot${n <= value ? " on" : ""}`} />
        ),
      )}
    </span>
  );
}

function Meta({ f }: { f: FactView }) {
  const bits: ReactNode[] = [];
  for (const a of f.about.slice(0, 4)) bits.push(<span key={`a-${a}`} className="owm-tag">{a}</span>);
  if (f.scope.startsWith("agent:")) bits.push(<span key="own" className="owm-own">{t("ui.onlyAgent", { name: agentName(f.scope.slice(6)) })}</span>);
  // An event shows its own date; other facts when they were last learned.
  if (f.kind === "event" && f.validFrom) bits.push(<span key="date">{when(f.validFrom)}</span>);
  else {
    if (f.validUntil && f.status === "active") bits.push(<span key="until">{t("ui.until", { date: when(f.validUntil) })}</span>);
    bits.push(<span key="upd">{when(f.updated || f.created)}</span>);
  }
  return <div className="owm-meta">{bits}</div>;
}

// ---------- one fact ----------

function FactDetail({ path, onChanged, onForget }: { path: string; onChanged(): void; onForget(f: FactView): void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const load = useCallback(() => {
    http<Detail>("GET", `/fact?path=${enc(path)}`)
      .then((x) => (setD(x), setError("")))
      .catch((e) => setError(errText(e)));
  }, [path]);
  useEffect(load, [load]);
  if (error) return <div className="owm-err">{error}</div>;
  if (!d) return <div style={{ padding: 8 }}><Spinner size={16} /></div>;
  const f = d.fact;
  const src = f.source;

  const patch = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      await http("PATCH", "/fact", { path: f.path, ...body });
      setEditing(false);
      load();
      onChanged();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const revert = async (rev: string) => {
    setBusy(true);
    try {
      await http("POST", "/revert", { path: f.path, rev });
      load();
      onChanged();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="owm-detail" onClick={(e) => e.stopPropagation()}>
      {editing ? (
        <>
          <textarea className="owm-edit" value={draft} autoFocus onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void patch({ text: draft });
            if (e.key === "Escape") setEditing(false);
          }} />
          <div className="owm-bar">
            <button className="owm-btn primary" disabled={busy || !draft.trim()} onClick={() => void patch({ text: draft })}>{t("ui.save")}</button>
            <button className="owm-btn" onClick={() => setEditing(false)}>{t("ui.cancel")}</button>
          </div>
        </>
      ) : null}
      {src && (
        <div className="owm-from">
          {src.agentId === "user" ? (
            t("ui.from.you", { date: when(src.at) })
          ) : (
            <>
              {t("ui.from.agent", { name: agentName(src.agentId), date: when(src.at) })}
              {src.conversationId && (
                <>
                  {" · "}
                  <a onClick={() => UI.navigate(`/chat/${enc(src.conversationId)}`)}>{t("ui.from.open")}</a>
                </>
              )}
            </>
          )}
          {f.sources.length > 1 && <> · {t("ui.from.times", { count: f.sources.length })}</>}
        </div>
      )}
      {src?.quote && <div className="owm-quote">“{src.quote}”</div>}
      {(f.validFrom || f.validUntil) && (
        <div className="owm-from">
          {f.validFrom && t("ui.since", { date: when(f.validFrom) })}
          {f.validFrom && f.validUntil && " · "}
          {f.validUntil && t("ui.until", { date: when(f.validUntil) })}
        </div>
      )}
      <div className="owm-bar" style={{ color: "var(--muted)", fontSize: 12.5 }}>
        {t("ui.kind." + f.kind)} · {t("ui.importanceLabel")} <Dots value={f.importance} onSet={(n) => void patch({ importance: n })} />
        {f.confidence < 1 && <> · {t("ui.confidence", { n: Math.round(f.confidence * 100) })}</>}
      </div>
      {d.before.length > 0 && (
        <div>
          <div className="owm-lbl">{t("ui.before")}</div>
          {d.before.map((b) => (
            <div key={b.path} className="owm-from">
              <span className="owm-old">{factPreview(b)}</span> {b.validUntil && <>· {t("ui.until", { date: when(b.validUntil) })}</>}
            </div>
          ))}
        </div>
      )}
      {d.history.length > 1 && (
        <div>
          <button className="owm-link" style={{ padding: "2px 0" }} onClick={() => setShowHistory((v) => !v)}>
            {t("ui.history", { count: d.history.length })}
          </button>
          {showHistory &&
            d.history.map((h, i) => (
              <div key={h.rev} className="owm-hist">
                <span>{when(h.at)}</span>
                <b>{h.message}</b>
                {i > 0 && (
                  <button className="owm-link" disabled={busy} onClick={() => void revert(h.rev)}>
                    {t("ui.restoreVersion")}
                  </button>
                )}
              </div>
            ))}
        </div>
      )}
      {!editing && (
        <div className="owm-bar">
          <button className="owm-btn" onClick={() => (setDraft(f.text || f.title), setEditing(true))}>{t("ui.edit")}</button>
          <button className="owm-btn" onClick={() => onForget(f)}>{t("ui.forget")}</button>
        </div>
      )}
    </div>
  );
}

function FactRow(props: { f: FactView; open: boolean; onToggle(): void; onChanged(): void; onForget(f: FactView): void; onEdit(f: FactView): void }) {
  const { f } = props;
  return (
    <div className={`owm-row${props.open ? " open" : ""}`} id={`owm-${f.path}`} onClick={props.onToggle}>
      {props.open ? (
        <div className="owm-md">
          <Markdown text={withBreaks(factText(f))} />
        </div>
      ) : (
        <div className="owm-text">{factPreview(f)}</div>
      )}
      <Meta f={f} />
      <div className="owm-acts">
        <button className="owm-link" title={t("ui.edit")} onClick={(e) => (e.stopPropagation(), props.onEdit(f))}>{Icon.edit}</button>
        <button className="owm-link" title={t("ui.forget")} onClick={(e) => (e.stopPropagation(), props.onForget(f))}>{Icon.x}</button>
      </div>
      {props.open && <FactDetail path={f.path} onChanged={props.onChanged} onForget={props.onForget} />}
    </div>
  );
}

// ---------- the team's rules for work (the hub's, GET /api/work-rules) ----------

interface RuleView {
  id: string;
  when: string;
  machineName?: string;
  agentName?: string;
  brainLabel?: string;
  modelName?: string;
  effort?: string;
}

/** "MacBook · Claude Code · Opus · high effort". */
function ruleWhere(r: RuleView): string {
  const name = r.effort ? t(`ui.rules.effortName.${r.effort}`) : "";
  const effort = r.effort ? t("ui.rules.effort", { effort: name === `ui.rules.effortName.${r.effort}` ? r.effort : name }) : "";
  return [r.machineName, r.agentName, r.brainLabel, r.modelName, effort].filter(Boolean).join(" · ");
}

/** Nothing while there are none (or on a hub that has no such list): a rule is said to an agent in a chat. */
function Rules() {
  const [rules, setRules] = useState<RuleView[]>([]);
  const load = useCallback(() => {
    UI.api.get<RuleView[]>("/api/work-rules").then(
      (r) => setRules(Array.isArray(r) ? r : []),
      () => setRules([]),
    );
  }, []);
  useEffect(() => {
    load();
    // An agent saved or dropped one in the chat next to this page.
    return UI.events.on((e) => {
      if (e.type === "settings.updated") load();
    });
  }, [load]);
  const drop = (r: RuleView) =>
    void UI.api.del(`/api/work-rules/${enc(r.id)}`).then(
      () => setRules((list) => list.filter((x) => x.id !== r.id)),
      (e) => UI.toast(errText(e), "error"),
    );
  if (!rules.length) return null;
  return (
    <div className="owm-sec">
      <div className="owm-sech"><h2>{t("ui.rules.title")}</h2><span>{rules.length}</span></div>
      <div className="owm-card">
        {rules.map((r) => (
          <div key={r.id} className="owm-row" style={{ cursor: "default" }}>
            <div className="owm-text">{r.when}</div>
            <div className="owm-meta"><span>{ruleWhere(r)}</span></div>
            <div className="owm-acts">
              <button className="owm-link" title={t("ui.forget")} onClick={() => drop(r)}>{Icon.x}</button>
            </div>
          </div>
        ))}
      </div>
      <div className="owm-sub" style={{ padding: "6px 4px 0" }}>{t("ui.rules.hint")}</div>
    </div>
  );
}

// ---------- the page ----------

function Review({ items, reload }: { items: ReviewItem[]; reload(): void }) {
  const [busy, setBusy] = useState("");
  if (!items.length) return null;
  const act = async (it: ReviewItem, action: "approve" | "reject") => {
    setBusy(it.path);
    try {
      await http("POST", `/review/${action}`, { path: it.path });
      UI.toast(action === "approve" ? t("ui.review.approved") : t("ui.review.rejected"), action === "approve" ? "success" : "info");
      reload();
    } catch (e) {
      UI.toast(errText(e), "error");
    } finally {
      setBusy("");
    }
  };
  return (
    <div className="owm-review">
      <h3>{t("ui.review.title", { count: items.length })}</h3>
      {items.map((it) => (
        <div key={it.path} className="owm-ritem">
          <div className="txt">
            <div className="owm-md">
              <Markdown text={withBreaks(factText(it))} />
            </div>
            <div className="owm-meta">
              {it.source && <span>{t("ui.review.from", { name: agentName(it.source.agentId), date: when(it.source.at) })}</span>}
              {it.current && <span>· {t("ui.review.replaces", { text: factPreview(it.current) })}</span>}
            </div>
          </div>
          <button className="owm-btn primary" disabled={busy === it.path} onClick={() => void act(it, "approve")}>{t("ui.review.approve")}</button>
          <button className="owm-btn" disabled={busy === it.path} onClick={() => void act(it, "reject")}>{t("ui.review.reject")}</button>
        </div>
      ))}
    </div>
  );
}

const SHOWN = 6;

function MemoryPage() {
  const [data, setData] = useState<FactsResponse | null>(null);
  const [review, setReview] = useState<ReviewItem[]>([]);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<FactView[] | null>(null);
  const [kind, setKind] = useState<Kind | "">("");
  const [open, setOpen] = useState<string>(() => new URLSearchParams(location.search).get("fact") ?? "");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [forgotten, setForgotten] = useState<FactView[]>([]);
  const [extra, setExtra] = useState<"" | "archived" | "trash">("");
  const [extraFacts, setExtraFacts] = useState<FactView[] | null>(null);
  const [tidying, setTidying] = useState(false);
  const scrolled = useRef(false);

  const load = useCallback(() => {
    Promise.all([http<FactsResponse>("GET", "/facts?status=active"), http<{ items: ReviewItem[] }>("GET", "/review")])
      .then(([f, r]) => (setData(f), setReview(r.items), setError("")))
      .catch((e) => setError(errText(e)));
  }, []);

  useEffect(() => {
    ensureStyles();
    void loadAgents().then(load);
    return UI.plugin.on("changed", () => load());
  }, [load]);

  // Search as you type (a short pause).
  useEffect(() => {
    const q = query.trim();
    if (!q) return setFound(null);
    const id = setTimeout(() => {
      http<FactsResponse>("GET", `/facts?q=${enc(q)}`)
        .then((r) => setFound(r.facts))
        .catch((e) => setError(errText(e)));
    }, 250);
    return () => clearTimeout(id);
  }, [query, data]);

  useEffect(() => {
    if (!extra) return setExtraFacts(null);
    setExtraFacts(null);
    (extra === "trash" ? http<{ facts: FactView[] }>("GET", "/trash") : http<FactsResponse>("GET", "/facts?status=archived"))
      .then((r) => setExtraFacts(r.facts))
      .catch((e) => setError(errText(e)));
  }, [extra, data]);

  // Opened from a chat line: scroll to the fact once it is there.
  useEffect(() => {
    if (!open || scrolled.current || !data) return;
    scrolled.current = true;
    requestAnimationFrame(() => document.getElementById(`owm-${open}`)?.scrollIntoView({ block: "center", behavior: "smooth" }));
  }, [open, data]);

  const forget = async (f: FactView) => {
    try {
      await http("POST", "/forget", { path: f.path });
      setForgotten((x) => [f, ...x.filter((y) => y.path !== f.path)]);
      if (open === f.path) setOpen("");
      load();
    } catch (e) {
      UI.toast(errText(e), "error");
    }
  };
  const restore = async (f: FactView) => {
    try {
      await http("POST", "/restore", { path: f.path });
      setForgotten((x) => x.filter((y) => y.path !== f.path));
      load();
    } catch (e) {
      UI.toast(errText(e), "error");
    }
  };
  const tidy = async () => {
    setTidying(true);
    try {
      const r = await http<{ expired: number; merged: number; archived: number; reflection: boolean }>("POST", "/tidy");
      UI.toast(r.expired + r.merged + r.archived ? t("ui.tidy.done", { merged: r.merged, archived: r.archived + r.expired }) : t("ui.tidy.clean"), "success");
      load();
    } catch (e) {
      UI.toast(errText(e), "error");
    } finally {
      setTidying(false);
    }
  };
  const exportAll = async () => {
    try {
      const body = await http<unknown>("GET", "/export");
      const blob = new Blob([JSON.stringify(body, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `piomio-memory-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (e) {
      UI.toast(errText(e), "error");
    }
  };

  const groups = useMemo(() => {
    const by = new Map<Kind, FactView[]>();
    for (const f of data?.facts ?? []) by.set(f.kind, [...(by.get(f.kind) ?? []), f]);
    const ev = by.get("event");
    if (ev) ev.sort((a, b) => (b.validFrom || b.updated).localeCompare(a.validFrom || a.updated));
    return KINDS.filter((k) => by.get(k)?.length).map((k) => ({ kind: k, facts: by.get(k)! }));
  }, [data]);

  const row = (f: FactView) => (
    <FactRow
      key={f.path}
      f={f}
      open={open === f.path}
      onToggle={() => setOpen((o) => (o === f.path ? "" : f.path))}
      onChanged={load}
      onForget={(x) => void forget(x)}
      onEdit={(x) => setOpen(x.path)}
    />
  );
  const gone = (f: FactView) => (
    <div key={`gone-${f.path}`} className="owm-gone">
      <span style={{ flex: 1, minWidth: 0 }} className="owm-old">{factPreview(f)}</span>
      <button className="owm-link strong" onClick={() => void restore(f)}>{t("ui.undo")}</button>
    </div>
  );

  if (error && !data) return <div className="owm"><div className="owm-err">{error}</div></div>;
  if (!data) return <div className="owm" style={{ display: "flex", justifyContent: "center", paddingTop: 80 }}><Spinner /></div>;

  const total = Object.values(data.counts).reduce((a, b) => a + b, 0);
  const shownGroups = kind ? groups.filter((g) => g.kind === kind) : groups;
  const forgottenHere = forgotten.filter((f) => !data.facts.some((x) => x.path === f.path));

  return (
    <div className="owm">
      <div className="owm-head">
        <div>
          <h1 className="owm-h1">{t("ui.title")}</h1>
          <div className="owm-sub">{total ? t("ui.subtitle", { count: total }) : t("ui.subtitleEmpty")}</div>
        </div>
        <div className="owm-tools">
          <button className="owm-link" disabled={tidying} onClick={() => void tidy()} title={t("ui.tidy.hint")}>{tidying ? t("ui.tidy.running") : t("ui.tidy.button")}</button>
          <button className="owm-link" onClick={() => void exportAll()}>{t("ui.export")}</button>
        </div>
      </div>

      <div className="owm-searchwrap">
        {Icon.search}
        <input className="owm-search" type="search" placeholder={t("ui.search.placeholder")} value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>

      {error && <div className="owm-err">{error}</div>}

      {found ? (
        <div className="owm-sec">
          <div className="owm-sech"><h2>{t("ui.search.results")}</h2><span>{found.length}</span></div>
          {found.length ? <div className="owm-card">{found.map(row)}</div> : <div className="owm-empty" style={{ padding: 30 }}>{t("ui.search.none", { query: query.trim() })}</div>}
        </div>
      ) : (
        <>
          <Review items={review} reload={load} />
          {!kind && <Rules />}
          {total > 0 && groups.length > 1 && (
            <div className="owm-chips">
              <button className={`owm-chip${kind === "" ? " on" : ""}`} onClick={() => setKind("")}>{t("ui.all")}<span>{total}</span></button>
              {groups.map((g) => (
                <button key={g.kind} className={`owm-chip${kind === g.kind ? " on" : ""}`} onClick={() => setKind(kind === g.kind ? "" : g.kind)}>
                  {t("ui.group." + g.kind)}<span>{g.facts.length}</span>
                </button>
              ))}
            </div>
          )}
          {forgottenHere.length > 0 && (
            <div className="owm-sec">
              <div className="owm-card">{forgottenHere.map(gone)}</div>
            </div>
          )}
          {!total && !review.length ? (
            <div className="owm-empty">
              <div className="owl">0_0</div>
              <div style={{ color: "var(--fg)", fontWeight: 550, marginBottom: 4 }}>{t("ui.empty.title")}</div>
              <div>{t("ui.empty.hint")}</div>
            </div>
          ) : (
            shownGroups.map((g) => {
              const all = expanded[g.kind] || kind === g.kind || g.facts.length <= SHOWN + 1;
              const list = all ? g.facts : g.facts.slice(0, SHOWN);
              const withOpen = !all && open && g.facts.some((f) => f.path === open) && !list.some((f) => f.path === open) ? [...list, g.facts.find((f) => f.path === open)!] : list;
              return (
                <div key={g.kind} className="owm-sec">
                  <div className="owm-sech"><h2>{t("ui.group." + g.kind)}</h2><span>{g.facts.length}</span></div>
                  <div className="owm-card">
                    {withOpen.map(row)}
                    {!all && (
                      <button className="owm-more" onClick={() => setExpanded((x) => ({ ...x, [g.kind]: true }))}>
                        {t("ui.showAll", { count: g.facts.length })}
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}
          <div className="owm-quiet">
            {data.archived > 0 && (
              <button className={`owm-link${extra === "archived" ? " strong" : ""}`} onClick={() => setExtra(extra === "archived" ? "" : "archived")}>
                {t("ui.archived", { count: data.archived })}
              </button>
            )}
            <button className={`owm-link${extra === "trash" ? " strong" : ""}`} onClick={() => setExtra(extra === "trash" ? "" : "trash")}>{t("ui.trash")}</button>
          </div>
          {extra && (
            <div className="owm-sec" style={{ marginTop: 10 }}>
              {!extraFacts ? (
                <Spinner size={16} />
              ) : !extraFacts.length ? (
                <div className="owm-empty" style={{ padding: 20 }}>{extra === "trash" ? t("ui.trashEmpty") : t("ui.archivedEmpty")}</div>
              ) : (
                <div className="owm-card">
                  {extra === "trash"
                    ? extraFacts.map(gone)
                    : extraFacts.map((f) => (
                        <div key={f.path} className="owm-gone">
                          <span style={{ flex: 1, minWidth: 0 }}>
                            <span className="owm-old">{factPreview(f)}</span>
                            {f.validUntil && <span> · {t("ui.until", { date: when(f.validUntil) })}</span>}
                          </span>
                        </div>
                      ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---------- the line under an agent's message ----------

/** What a memory tool did, from its result's first line: "Remembered [path]: title." and the like. */
export function outcome(name: string, output: string | undefined, isError?: boolean): { state: "remembered" | "known" | "review" | "forgot" | "noted" | "secret" | "running" | "none"; path: string; title: string } {
  if (output === undefined) return { state: "running", path: "", title: "" };
  const first = output.split("\n")[0] ?? "";
  if (isError) return { state: /looks like a secret/.test(first) ? "secret" : "none", path: "", title: "" };
  const m = /^(Remembered|Already known|Waiting for the user's OK|Forgot) \[([^\]]+)\]: (.*?)\.?(?: (?:Its|Sensitive) .*)?$/.exec(first);
  if (m) {
    const state = m[1] === "Remembered" ? "remembered" : m[1] === "Already known" ? "known" : m[1] === "Forgot" ? "forgot" : "review";
    return { state, path: m[2], title: m[3] };
  }
  const w = /^(Created|Updated) (.+\.md)\.$/.exec(first);
  if (w && /memory_write$/.test(name)) return { state: "noted", path: w[2], title: "" };
  return { state: "none", path: "", title: "" };
}

function MemoryLine({ call, result }: ToolResultProps) {
  const o = outcome(call.name, result?.output, result?.isError);
  const [done, setDone] = useState<"" | "undone" | "approved" | "rejected" | "restored" | "settled">("");
  const [busy, setBusy] = useState(false);
  useEffect(ensureStyles, []);
  // The line is drawn again later (a reload, another device): it says what is true now, not what was clicked here.
  useEffect(() => {
    if (!o.path || (o.state !== "remembered" && o.state !== "review")) return;
    let alive = true;
    http<Detail>("GET", `/fact?path=${enc(o.path)}`)
      .then((d) => {
        if (!alive) return;
        if (o.state === "review" && d.fact.status !== "review") setDone("approved");
        // Replaced since by a newer fact, or put away: nothing to undo here any more.
        else if (o.state === "remembered" && (d.fact.status !== "active" || d.fact.supersededBy)) setDone("settled");
      })
      .catch(() => alive && setDone(o.state === "review" ? "rejected" : "undone"));
    return () => {
      alive = false;
    };
  }, [o.path, o.state]);
  const input = (call.input ?? {}) as Record<string, unknown>;
  const title = o.title || String(input.title ?? input.fact ?? "");
  const go = async (path: string, body: unknown, next: typeof done) => {
    setBusy(true);
    try {
      await http("POST", path, body);
      setDone(next);
      void native?.haptic("light");
    } catch (e) {
      UI.toast(errText(e), "error");
    } finally {
      setBusy(false);
    }
  };
  const open = () => o.path && UI.navigate(`/memory?fact=${enc(o.path)}`);
  const what = <span className="what" title={title} onClick={open}>{title}</span>;
  switch (o.state) {
    case "running":
      return <div className="owm-line">{Icon.brain}<span>{t("chat.remembering")}</span></div>;
    case "remembered":
      if (done === "undone")
        return (
          <div className="owm-line">{Icon.brain}<span>{t("chat.undone")}</span><span className="sep">·</span>
            <button className="l" disabled={busy} onClick={() => void go("/restore", { path: o.path }, "restored")}>{t("chat.rememberAgain")}</button>
          </div>
        );
      if (done === "settled") return <div className="owm-line">{Icon.brain}<span>{t("chat.remembered")}</span>{what}</div>;
      return (
        <div className="owm-line">{Icon.brain}<span>{t("chat.remembered")}</span>{what}<span className="sep">·</span>
          <button className="l" disabled={busy} onClick={() => void go("/undo", { path: o.path }, "undone")}>{t("ui.undo")}</button>
        </div>
      );
    case "known":
      return <div className="owm-line">{Icon.brain}<span>{t("chat.known")}</span>{what}</div>;
    case "review":
      if (done === "approved") return <div className="owm-line">{Icon.brain}<span>{t("chat.remembered")}</span>{what}</div>;
      if (done === "rejected") return <div className="owm-line">{Icon.brain}<span>{t("chat.notRemembered")}</span></div>;
      return (
        <div className="owm-line ask">{Icon.brain}<span>{t("chat.ask")}</span>{what}
          <button className="owm-btn primary" disabled={busy} onClick={() => void go("/review/approve", { path: o.path }, "approved")}>{t("ui.review.approve")}</button>
          <button className="owm-btn" disabled={busy} onClick={() => void go("/review/reject", { path: o.path }, "rejected")}>{t("ui.review.reject")}</button>
        </div>
      );
    case "forgot":
      if (done === "restored") return <div className="owm-line">{Icon.brain}<span>{t("chat.restored")}</span>{what}</div>;
      return (
        <div className="owm-line">{Icon.brain}<span>{t("chat.forgot")}</span><span className="what">{title}</span><span className="sep">·</span>
          <button className="l" disabled={busy} onClick={() => void go("/restore", { path: o.path }, "restored")}>{t("ui.undo")}</button>
        </div>
      );
    case "noted":
      return <div className="owm-line">{Icon.brain}<span>{t("chat.noted")}</span>{what}</div>;
    case "secret":
      return <div className="owm-line">{Icon.brain}<span>{t("chat.secret")}</span></div>;
    default:
      return null;
  }
}

export default definePluginUI((ui) => {
  UI = ui;
  t = ui.i18n.t;
  const offRoute = ui.routes.add({ path: "/memory", title: t("ui.title"), icon: "brain", component: MemoryPage, nav: true });
  const offLine = ui.slots.register<ToolResultProps>("chat.toolResult", {
    id: "memory-line",
    component: MemoryLine,
    match: { tool: ["memory_remember", "memory_forget", "memory_write", "*__memory_remember", "*__memory_forget", "*__memory_write"] },
    inline: true,
  });
  return () => {
    offRoute();
    offLine();
  };
});
