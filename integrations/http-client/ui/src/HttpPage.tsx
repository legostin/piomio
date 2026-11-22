// The HTTP page: the history and the saved requests on the left, the request being written and its response on the
// right. Everything here can also be done in the chat (the http_* tools), and what agents send lands in the same list.

import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent } from "react";
import { Button, Spinner } from "@piomio/ui";
import { BODY_TYPES, METHODS, type BodyType, type ClientState, type Entry, type EntrySummary, type Method, type Pair, type RequestSpec, type SavedRequest } from "../../server/types.ts";
import { EnvironmentsPanel } from "./Environments.tsx";
import { PairEditor } from "./PairEditor.tsx";
import { askInChat, copy, duration, enc, fail, http, Icon, MethodMark, nameOf, pretty, shortUrl, size, statusTone, t, UI, when } from "./shared.tsx";

const EMPTY: RequestSpec = { method: "GET", url: "" };
const FILTERS = ["", "2xx", "4xx", "5xx", "error"] as const;
const on = (list: Pair[] | undefined): number => (list ?? []).filter((p) => !p.off && p.name).length;

export function HttpPage() {
  const params = useMemo(() => new URLSearchParams(location.search), []);
  const [state, setState] = useState<ClientState | null>(null);
  const [entries, setEntries] = useState<EntrySummary[]>([]);
  const [more, setMore] = useState(false);
  const [side, setSide] = useState<"history" | "saved">(params.get("request") ? "saved" : "history");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("");
  const [draft, setDraft] = useState<RequestSpec>(EMPTY);
  const [savedId, setSavedId] = useState<string | undefined>(params.get("request") ?? undefined);
  const [entry, setEntry] = useState<Entry | null>(null);
  const [tab, setTab] = useState<"params" | "headers" | "body">("params");
  const [view, setView] = useState<"body" | "headers">("body");
  const [sending, setSending] = useState(false);
  const [saving, setSaving] = useState<{ name: string; folder: string } | null>(null);
  const [environments, setEnvironments] = useState(false);
  const [detail, setDetail] = useState(!!params.get("entry") || !!params.get("request"));
  const reload = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const search = useRef({ query, filter });
  search.current = { query, filter };

  const loadState = useCallback(() => http<ClientState>("GET", "state").then(setState, fail), []);

  const loadHistory = useCallback(async (before?: EntrySummary) => {
    const { query: q, filter: status } = search.current;
    const qs = new URLSearchParams();
    if (q.trim()) qs.set("q", q.trim());
    if (status) qs.set("status", status);
    if (before) qs.set("before", before.id);
    try {
      const page = await http<{ entries: EntrySummary[]; more: boolean }>("GET", `history?${qs}`);
      setEntries((old) => (before ? [...old, ...page.entries] : page.entries));
      setMore(page.more);
    } catch (e) {
      fail(e);
    }
  }, []);

  const openEntry = useCallback(async (id: string) => {
    try {
      const e = await http<Entry>("GET", `history/${enc(id)}`);
      setEntry(e);
      setDraft(e.request);
      setSavedId(undefined);
      setSaving(null);
      setDetail(true);
    } catch (e) {
      fail(e);
    }
  }, []);

  const openSaved = (r: SavedRequest) => {
    setDraft(r.request);
    setSavedId(r.id);
    setEntry(null);
    setSaving(null);
    setDetail(true);
  };

  useEffect(() => {
    void loadState().then(() => undefined);
    void loadHistory();
    const first = params.get("entry");
    if (first) void openEntry(first);
    const off = UI.plugin.on("changed", () => {
      clearTimeout(reload.current);
      reload.current = setTimeout(() => {
        void loadState();
        void loadHistory();
      }, 150);
    });
    return () => {
      off();
      clearTimeout(reload.current);
    };
  }, [loadState, loadHistory, openEntry, params]);

  // A link from the chat or a reload lands on the saved request it names.
  const linked = useRef(params.get("request"));
  useEffect(() => {
    if (!linked.current || !state) return;
    const r = state.requests.find((x) => x.id === linked.current);
    linked.current = null;
    if (r) setDraft(r.request);
  }, [state]);

  // The search runs as the person types, a moment after they stop.
  useEffect(() => {
    const timer = setTimeout(() => void loadHistory(), 200);
    return () => clearTimeout(timer);
  }, [query, filter, loadHistory]);

  // The address says what is open.
  useEffect(() => {
    const q = new URLSearchParams();
    if (entry) q.set("entry", entry.id);
    else if (savedId) q.set("request", savedId);
    history.replaceState(history.state, "", `${location.pathname}${q.size ? `?${q}` : ""}`);
  }, [entry, savedId]);

  const patch = (p: Partial<RequestSpec>) => setDraft((d) => ({ ...d, ...p }));
  const noBody = draft.method === "GET" || draft.method === "HEAD";
  const current = savedId ? state?.requests.find((r) => r.id === savedId) : undefined;

  const send = async () => {
    if (sending || !draft.url.trim()) return;
    setSending(true);
    try {
      const e = await http<Entry>("POST", "send", { request: draft });
      setEntry(e);
      setView("body");
    } catch (e) {
      fail(e);
    } finally {
      setSending(false);
    }
  };

  const pasted = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData("text");
    if (!/^\s*curl(\.exe)?\s/i.test(text)) return;
    e.preventDefault();
    http<{ request: RequestSpec }>("POST", "curl/parse", { text }).then(({ request }) => {
      setDraft(request);
      setSavedId(undefined);
      setEntry(null);
      setTab(request.body ? "body" : request.headers?.length ? "headers" : "params");
    }, fail);
  };

  const save = async () => {
    if (!saving) return;
    try {
      const body = { name: saving.name, folder: saving.folder, request: draft };
      const r = current ? await http<SavedRequest>("PUT", `requests/${enc(current.id)}`, body) : await http<SavedRequest>("POST", "requests", body);
      setSavedId(r.id);
      setSaving(null);
      UI.toast(t("ui.saved.changed"), "success");
      void loadState();
    } catch (e) {
      fail(e);
    }
  };

  const removeSaved = async (r: SavedRequest) => {
    if (!confirm(t("ui.saved.removeConfirm", { name: r.name }))) return;
    try {
      await http("DELETE", `requests/${enc(r.id)}`);
      if (savedId === r.id) setSavedId(undefined);
      void loadState();
    } catch (e) {
      fail(e);
    }
  };

  const removeEntry = async (id: string) => {
    try {
      await http("DELETE", `history/${enc(id)}`);
      if (entry?.id === id) setEntry(null);
      setEntries((list) => list.filter((e) => e.id !== id));
    } catch (e) {
      fail(e);
    }
  };

  const clear = async () => {
    if (!confirm(t("ui.clear.confirm"))) return;
    try {
      await http("DELETE", "history");
      setEntry(null);
    } catch (e) {
      fail(e);
    }
  };

  const fresh = () => {
    setDraft(EMPTY);
    setSavedId(undefined);
    setEntry(null);
    setSaving(null);
    setTab("params");
    setDetail(true);
  };

  const ask = () =>
    void askInChat(
      state?.defaultAgent,
      entry && entry.request === draft ? t("ui.ask.entry", { method: entry.method, url: entry.url, id: entry.id }) : t("ui.ask.draft", { method: draft.method, url: draft.url }),
    );

  const shownSaved = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = state?.requests ?? [];
    return q ? list.filter((r) => `${r.name} ${r.folder ?? ""} ${r.request.method} ${r.request.url}`.toLowerCase().includes(q)) : list;
  }, [state, query]);

  const response = entry?.response;
  const body = response?.body ? pretty(response.body, response.contentType) : "";

  return (
    <div className={`hc-page${detail ? " is-detail" : ""}`}>
      <aside className="hc-side">
        <div className="hc-side-head">
          <input className="hc-input" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("ui.search")} aria-label={t("ui.search")} />
          <button type="button" className="hc-icon" onClick={fresh} title={t("ui.new")} aria-label={t("ui.new")}>
            <Icon name="plus" size={16} />
          </button>
        </div>
        <div className="hc-tabs" role="tablist">
          {(["history", "saved"] as const).map((s) => (
            <button key={s} type="button" role="tab" aria-selected={side === s} className={`hc-tab${side === s ? " is-on" : ""}`} onClick={() => setSide(s)}>
              {t(`ui.${s}`)}
              {s === "saved" && !!state?.requests.length && <span className="hc-count">{state.requests.length}</span>}
            </button>
          ))}
        </div>
        {side === "history" ? (
          <>
            <div className="hc-chips">
              {FILTERS.map((f) => (
                <button key={f} type="button" className={`hc-chip${filter === f ? " is-on" : ""}`} onClick={() => setFilter(f)}>
                  {f === "" ? t("ui.filter.all") : f === "error" ? t("ui.filter.error") : f}
                </button>
              ))}
            </div>
            <div className="hc-list">
              {entries.length === 0 ? (
                <div className="hc-empty">
                  <b>{query.trim() || filter ? t("ui.empty.search") : t("ui.empty.history")}</b>
                  {!query.trim() && !filter && <span className="hc-muted">{t("ui.empty.history.hint")}</span>}
                </div>
              ) : (
                <>
                  {entries.map((e) => (
                    <div key={e.id} role="button" tabIndex={0} className={`hc-item${entry?.id === e.id ? " is-on" : ""}`} onClick={() => void openEntry(e.id)} onKeyDown={(k) => k.key === "Enter" && void openEntry(e.id)}>
                      <div className="hc-item-top">
                        <MethodMark method={e.method} />
                        <span className="hc-item-url" title={e.url}>
                          {shortUrl(e.url)}
                        </span>
                        <span className={`hc-status hc-tone-${statusTone(e.status)}`}>{e.status ?? "✕"}</span>
                      </div>
                      <div className="hc-item-meta">
                        <span>{when(e.at)}</span>
                        <span>{nameOf(e.by)}</span>
                        {!e.error && <span>{duration(e.ms)}</span>}
                        {e.saved && <span>{e.saved}</span>}
                      </div>
                      <button
                        type="button"
                        className="hc-icon hc-item-x"
                        title={t("ui.entry.remove")}
                        aria-label={t("ui.entry.remove")}
                        onClick={(x) => {
                          x.stopPropagation();
                          void removeEntry(e.id);
                        }}
                      >
                        <Icon name="close" size={12} />
                      </button>
                    </div>
                  ))}
                  <div className="hc-row" style={{ padding: "8px 4px" }}>
                    {more && (
                      <button type="button" className="hc-text-button" onClick={() => void loadHistory(entries.at(-1))}>
                        {t("ui.more")}
                      </button>
                    )}
                    <span className="hc-grow" />
                    <button type="button" className="hc-text-button" onClick={() => void clear()}>
                      {t("ui.clear")}
                    </button>
                  </div>
                </>
              )}
            </div>
          </>
        ) : (
          <div className="hc-list">
            {shownSaved.length === 0 ? (
              <div className="hc-empty">
                <b>{query.trim() ? t("ui.empty.search") : t("ui.empty.saved")}</b>
                {!query.trim() && <span className="hc-muted">{t("ui.empty.saved.hint")}</span>}
              </div>
            ) : (
              shownSaved.map((r, i) => (
                <div key={r.id} style={{ display: "contents" }}>
                  {r.folder && r.folder !== shownSaved[i - 1]?.folder && <div className="hc-folder">{r.folder}</div>}
                  <div role="button" tabIndex={0} className={`hc-item${savedId === r.id ? " is-on" : ""}`} onClick={() => openSaved(r)} onKeyDown={(k) => k.key === "Enter" && openSaved(r)}>
                    <div className="hc-item-top">
                      <MethodMark method={r.request.method} />
                      <span className="hc-item-url">{r.name}</span>
                    </div>
                    <div className="hc-item-meta">
                      <span className="hc-item-url" title={r.request.url}>
                        {shortUrl(r.request.url)}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="hc-icon hc-item-x"
                      title={t("ui.remove")}
                      aria-label={t("ui.remove")}
                      onClick={(x) => {
                        x.stopPropagation();
                        void removeSaved(r);
                      }}
                    >
                      <Icon name="trash" size={12} />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </aside>

      <main className="hc-main">
        <form
          className="hc-bar"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <button type="button" className="hc-icon hc-back" onClick={() => setDetail(false)} title={t("ui.back")} aria-label={t("ui.back")}>
            <Icon name="back" size={16} />
          </button>
          <select className="hc-input" value={draft.method} onChange={(e) => patch({ method: e.target.value as Method })} aria-label={t("ui.method")}>
            {METHODS.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
          <input className="hc-input hc-url" value={draft.url} onChange={(e) => patch({ url: e.target.value })} onPaste={pasted} placeholder={t("ui.url")} aria-label={t("ui.url")} spellCheck={false} autoCapitalize="off" autoCorrect="off" />
          <Button type="submit" disabled={sending || !draft.url.trim()}>
            {sending ? t("ui.sending") : t("ui.send")}
          </Button>
        </form>

        <div className="hc-sub">
          {(["params", "headers", "body"] as const).map((x) => (
            <button key={x} type="button" className={`hc-tab${tab === x ? " is-on" : ""}`} onClick={() => setTab(x)}>
              {t(`ui.tab.${x}`)}
              {x === "params" && on(draft.query) > 0 && <span className="hc-count">{on(draft.query)}</span>}
              {x === "headers" && on(draft.headers) > 0 && <span className="hc-count">{on(draft.headers)}</span>}
              {x === "body" && !!draft.body && !noBody && <span className="hc-count">•</span>}
            </button>
          ))}
          <span className="hc-grow" />
          <select
            className="hc-input"
            value={state?.activeEnvironment ?? ""}
            aria-label={t("ui.env")}
            title={t("ui.env")}
            onChange={(e) => {
              if (e.target.value === "…") setEnvironments(true);
              else http<ClientState>("PUT", "active-environment", { id: e.target.value || null }).then(setState, fail);
            }}
          >
            <option value="">{t("ui.env.none")}</option>
            {state?.environments.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
            <option value="…">{t("ui.env.manage")}</option>
          </select>
          <button type="button" className="hc-text-button" title={t("ui.save")} disabled={!draft.url.trim()} onClick={() => setSaving(saving ? null : { name: current?.name ?? "", folder: current?.folder ?? "" })}>
            <Icon name="save" /> <span className="hc-label">{t("ui.save")}</span>
          </button>
          <button type="button" className="hc-text-button" title={t("ui.copyCurl")} disabled={!draft.url.trim()} onClick={() => http<{ text: string }>("POST", "curl/format", { request: draft }).then((r) => copy(r.text), fail)}>
            <Icon name="copy" /> <span className="hc-label">{t("ui.copyCurl")}</span>
          </button>
          {state?.defaultAgent && (
            <button type="button" className="hc-text-button" title={t("ui.ask")} disabled={!draft.url.trim()} onClick={ask}>
              <Icon name="chat" /> <span className="hc-label">{t("ui.ask")}</span>
            </button>
          )}
        </div>

        {saving && (
          <form
            className="hc-form"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <input className="hc-input" autoFocus value={saving.name} onChange={(e) => setSaving({ ...saving, name: e.target.value })} placeholder={t("ui.save.name")} aria-label={t("ui.save.name")} />
            <input className="hc-input" value={saving.folder} onChange={(e) => setSaving({ ...saving, folder: e.target.value })} placeholder={t("ui.save.folder")} aria-label={t("ui.save.folder")} />
            <Button type="submit" size="sm" disabled={!saving.name.trim()}>
              {t("ui.save")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSaving(null)}>
              {t("ui.cancel")}
            </Button>
          </form>
        )}

        <div className="hc-editor">
          {tab === "params" && <PairEditor pairs={draft.query ?? []} onChange={(query) => patch({ query })} />}
          {tab === "headers" && <PairEditor pairs={draft.headers ?? []} onChange={(headers) => patch({ headers })} />}
          {tab === "body" &&
            (noBody ? (
              <span className="hc-muted">{t("ui.body.none", { method: draft.method })}</span>
            ) : (
              <>
                <select className="hc-input" value={draft.bodyType ?? "json"} onChange={(e) => patch({ bodyType: e.target.value as BodyType })} aria-label={t("ui.body.type")}>
                  {BODY_TYPES.map((b) => (
                    <option key={b} value={b}>
                      {t(`ui.body.${b}`)}
                    </option>
                  ))}
                </select>
                <textarea className="hc-input hc-body" value={draft.body ?? ""} onChange={(e) => patch({ body: e.target.value, bodyType: draft.bodyType ?? "json" })} placeholder={t("ui.body.placeholder")} aria-label={t("ui.tab.body")} spellCheck={false} />
              </>
            ))}
        </div>

        <section className="hc-response" aria-label={t("ui.response")}>
          {sending ? (
            <div className="hc-empty">
              <Spinner size={18} />
            </div>
          ) : !entry ? (
            <div className="hc-empty hc-muted">{t("ui.response.none")}</div>
          ) : entry.error ? (
            <>
              <div className="hc-response-head">
                <span className="hc-big-status hc-tone-danger">{t(`failure.${entry.error.code}`)}</span>
                <span className="hc-muted">{[duration(entry.ms), when(entry.at), nameOf(entry.by)].join(" · ")}</span>
              </div>
              <div className="hc-note hc-note-danger">{entry.error.code === "local" || entry.error.code === "lan" ? t(`failure.${entry.error.code}.hint`) : entry.error.message}</div>
            </>
          ) : (
            response && (
              <>
                <div className="hc-response-head">
                  <span className={`hc-big-status hc-tone-${statusTone(response.status)}`}>
                    {response.status} {response.statusText}
                  </span>
                  <span className="hc-muted">{[duration(entry.ms), size(response.bytes), when(entry.at), nameOf(entry.by)].join(" · ")}</span>
                  <span className="hc-grow" />
                  {(["body", "headers"] as const).map((x) => (
                    <button key={x} type="button" className={`hc-tab${view === x ? " is-on" : ""}`} onClick={() => setView(x)}>
                      {t(`ui.response.${x}`)}
                      {x === "headers" && <span className="hc-count">{response.headers.length}</span>}
                    </button>
                  ))}
                  {!!body && (
                    <button type="button" className="hc-icon" onClick={() => void copy(body)} title={t("ui.response.copy")} aria-label={t("ui.response.copy")}>
                      <Icon name="copy" />
                    </button>
                  )}
                </div>
                {!!response.redirects?.length && <div className="hc-note">{t("ui.response.redirected", { url: response.url })}</div>}
                {response.truncated && !response.binary && <div className="hc-note">{t("ui.response.truncated")}</div>}
                {view === "headers" ? (
                  <dl className="hc-headers">
                    {response.headers.map((h, i) => (
                      <div key={i} style={{ display: "contents" }}>
                        <dt>{h.name}</dt>
                        <dd>{h.value}</dd>
                      </div>
                    ))}
                  </dl>
                ) : response.binary ? (
                  <div className="hc-empty hc-muted">{t("ui.response.binary", { size: size(response.bytes) })}</div>
                ) : !body ? (
                  <div className="hc-empty hc-muted">{t("ui.response.empty")}</div>
                ) : (
                  <pre className="hc-pre">{body}</pre>
                )}
              </>
            )
          )}
        </section>
      </main>

      {environments && state && (
        <EnvironmentsPanel
          state={state}
          onClose={() => {
            setEnvironments(false);
            void loadState();
          }}
        />
      )}
    </div>
  );
}
