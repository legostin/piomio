// The Telegram account's cards. "account" is the whole of it: connecting by QR code, who is connected, the mode
// (read only, or sending too), which chats the agents may see, and disconnecting. It is the plugin's section in
// Settings → Plugins, its setup card, and the card an agent shows in the chat. "request" is an agent's question
// ("open this chat?", "may I send?"), answered by the person's tap. Everything here changes only through the
// plugin's own HTTP routes, which only the person's app can reach.

import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { Badge, Button, Card, Spinner, definePluginUI } from "@piomio/ui";
import type { PiomioUI } from "@piomio/ui";
import type { AccountStatus, ChatKind, ChatRow, RequestView } from "../../server/index.ts";

let ui!: PiomioUI;
let t: PiomioUI["i18n"]["t"] = (k) => k;

const KINDS: ChatKind[] = ["private", "group", "channel", "bot"];

const muted: CSSProperties = { color: "var(--muted)", fontSize: 13, lineHeight: 1.45 };
const row: CSSProperties = { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" };
const block: CSSProperties = { marginTop: 14 };
const label: CSSProperties = { fontSize: 12.5, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--muted)", marginBottom: 6 };
const field: CSSProperties = { flex: 1, minWidth: 160, padding: "7px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--surface-2)", color: "inherit", font: "inherit" };
const line: CSSProperties = { display: "flex", gap: 8, alignItems: "center", padding: "6px 0", borderTop: "1px solid var(--border)" };

const errorText = (e: any) => String(e?.message ?? e);

/** The live status: asked once, then pushed by the plugin on every change. */
function useStatus(): [AccountStatus | null, (s: AccountStatus) => void, string | null] {
  const [status, setStatus] = useState<AccountStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    ui.plugin.http<AccountStatus>("GET", "/status").then(
      (s) => alive && setStatus(s),
      (e) => alive && setError(errorText(e)),
    );
    const off = ui.plugin.on("status", (s: AccountStatus) => alive && setStatus(s));
    return () => {
      alive = false;
      off();
    };
  }, []);
  return [status, setStatus, error];
}

function stateBadge(s: AccountStatus): ReactNode {
  const tone = s.state === "connected" ? "success" : s.state === "error" || s.state === "revoked" || s.state === "no-app" ? "danger" : s.state === "signed-out" ? "neutral" : "warning";
  return <Badge tone={tone}>{t(s.state === "locked" && s.vault === "uninitialized" ? "state.noVault" : `state.${s.state}`)}</Badge>;
}

function Segment({ value, onChange, disabled }: { value: "read" | "write"; onChange: (m: "read" | "write") => void; disabled: boolean }) {
  const item = (m: "read" | "write"): CSSProperties => ({
    flex: 1,
    padding: "7px 10px",
    borderRadius: 8,
    border: `1px solid ${value === m ? "var(--accent)" : "var(--border)"}`,
    background: value === m ? "var(--surface-2)" : "transparent",
    color: "inherit",
    font: "inherit",
    fontWeight: value === m ? 600 : 400,
    cursor: disabled ? "default" : "pointer",
    textAlign: "left",
  });
  return (
    <div role="radiogroup" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {(["read", "write"] as const).map((m) => (
        <button key={m} type="button" role="radio" aria-checked={value === m} disabled={disabled} style={item(m)} onClick={() => value !== m && onChange(m)}>
          {t(`mode.${m}`)}
          <div style={{ ...muted, fontWeight: 400 }}>{t(`mode.${m}.note`)}</div>
        </button>
      ))}
    </div>
  );
}

/** Finding a chat to make an exception for: the person sees every chat of theirs here, agents never do. */
function ChatFinder({ onPick, busy }: { onPick: (chatId: string, to: "open" | "closed" | "default") => void; busy: boolean }) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<ChatRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const search = useCallback((text: string) => {
    const mine = ++seq.current;
    if (!text.trim()) return setRows(null);
    setLoading(true);
    ui.plugin.http<{ chats: ChatRow[] }>("GET", `/chats?q=${encodeURIComponent(text.trim())}`).then(
      (r) => {
        if (mine !== seq.current) return;
        setRows(r.chats.slice(0, 12));
        setLoading(false);
      },
      (e) => {
        if (mine !== seq.current) return;
        setLoading(false);
        ui.toast(errorText(e), "error");
      },
    );
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => search(q), 300);
    return () => clearTimeout(timer);
  }, [q, search]);
  return (
    <div>
      <input style={{ ...field, width: "100%", boxSizing: "border-box" }} value={q} placeholder={t("chats.find")} aria-label={t("chats.find")} onChange={(e) => setQ(e.target.value)} />
      {loading && !rows && <Spinner />}
      {rows && rows.length === 0 && <p style={muted}>{t("chats.none")}</p>}
      {rows?.map((c) => (
        <div key={c.id} style={line}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.title}</div>
            <div style={muted}>
              {t(`kind.${c.kind}.one`)} · {t(`chat.${c.state}.${c.reason}`)}
            </div>
          </div>
          {c.canOpen && c.state === "closed" && (
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => onPick(c.id, "open")}>
              {t("action.open")}
            </Button>
          )}
          {c.state === "open" && (
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => onPick(c.id, "closed")}>
              {t("action.close")}
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * The session's key lives in the hub's vault, so the vault comes first: creating it on a new hub, or unlocking it.
 * The passphrase goes to the hub's own vault routes, as from its own form; the plugin's backend never sees it. Once
 * the vault opens, the plugin hears it and the card moves on by itself.
 */
function VaultForm({ creating }: { creating: boolean }) {
  const [pass, setPass] = useState("");
  const [repeat, setRepeat] = useState("");
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (creating && pass !== repeat) return setError(t("vault.mismatch"));
    setBusy(true);
    setError(null);
    try {
      await ui.api.post(creating ? "/api/vault/init" : "/api/vault/unlock", { passphrase: pass, remember });
      setPass("");
      setRepeat("");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      style={{ marginTop: 10 }}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div style={{ fontWeight: 600 }}>{t(creating ? "vault.createTitle" : "vault.unlockTitle")}</div>
      <p style={{ ...muted, margin: "4px 0 8px" }}>{t(creating ? "vault.createHint" : "locked")}</p>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <input style={field} type="password" autoComplete={creating ? "new-password" : "current-password"} value={pass} aria-label={t("vault.passphrase")} placeholder={t("vault.passphrase")} onChange={(e) => setPass(e.target.value)} />
        {creating && <input style={field} type="password" autoComplete="new-password" value={repeat} aria-label={t("vault.repeat")} placeholder={t("vault.repeat")} onChange={(e) => setRepeat(e.target.value)} />}
        <label style={{ ...muted, display: "flex", gap: 8, alignItems: "center", cursor: "pointer" }}>
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          {t("vault.remember")}
        </label>
        {error && <p style={{ ...muted, color: "var(--danger, #c0392b)", margin: 0 }}>{error}</p>}
        <div style={row}>
          <Button variant="primary" type="submit" disabled={busy || !pass || (creating && !repeat)}>
            {t(creating ? "vault.create" : "vault.unlock")}
          </Button>
        </div>
      </div>
    </form>
  );
}

function AccountPanel() {
  const [status, setStatus, loadError] = useStatus();
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState("");
  const [finder, setFinder] = useState(0);

  const act = async (path: string, body?: unknown) => {
    setBusy(true);
    try {
      setStatus(await ui.plugin.http<AccountStatus>("POST", path, body));
      return true;
    } catch (e) {
      ui.toast(errorText(e), "error");
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (!status) return loadError ? <p style={muted}>{t("status.failed", { error: loadError })}</p> : <Spinner />;
  const s = status;
  const exceptions = [...Object.entries(s.access.open).map(([id, c]) => ({ id, ...c, state: "open" as const })), ...Object.entries(s.access.closed).map(([id, c]) => ({ id, ...c, state: "closed" as const }))];

  return (
    <div>
      <div style={{ ...row, justifyContent: "space-between" }}>
        <div style={{ minWidth: 0 }}>
          {s.state === "connected" && s.account ? (
            <b>
              {s.account.name}
              {s.account.username ? <span style={{ ...muted, fontWeight: 400 }}> @{s.account.username}</span> : null}
            </b>
          ) : (
            <b>{t("title")}</b>
          )}
        </div>
        {stateBadge(s)}
      </div>

      {s.state === "no-app" && <p style={muted}>{t("noApp")}</p>}
      {s.state === "locked" && <VaultForm creating={s.vault === "uninitialized"} />}

      {(s.state === "signed-out" || s.state === "revoked" || s.state === "error") && (
        <div>
          <p style={muted}>{s.state === "revoked" ? t("revoked") : s.state === "error" ? t("error", { detail: s.detail ?? "" }) : t("intro")}</p>
          <div style={{ ...row, marginTop: 10 }}>
            <Button variant="primary" disabled={busy} onClick={() => void act("/signin")}>
              {t("connect")}
            </Button>
          </div>
        </div>
      )}

      {s.state === "connecting" && (
        <div style={{ ...row, marginTop: 10 }}>
          <Spinner />
          <span style={muted}>{t("connecting")}</span>
        </div>
      )}

      {s.state === "qr" && s.qr && (
        <div style={{ ...row, alignItems: "flex-start", marginTop: 10 }}>
          <div aria-label={t("qr.label")} role="img" style={{ width: 176, height: 176, padding: 8, borderRadius: 12, background: "#fff", flexShrink: 0 }} dangerouslySetInnerHTML={{ __html: s.qr.svg }} />
          <div style={{ flex: 1, minWidth: 180 }}>
            {/* The numbers are written out: the app's styles take a list's own markers away. */}
            <ol style={{ margin: 0, padding: 0, listStyle: "none", lineHeight: 1.6 }}>
              {[1, 2, 3].map((n) => (
                <li key={n} style={{ display: "flex", gap: 8 }}>
                  <span style={{ color: "var(--muted)", fontVariantNumeric: "tabular-nums" }}>{n}.</span>
                  <span>{t(`qr.step${n}`)}</span>
                </li>
              ))}
            </ol>
            <p style={muted}>{t("qr.note")}</p>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void act("/signin/cancel")}>
              {t("cancel")}
            </Button>
          </div>
        </div>
      )}

      {s.state === "password" && (
        <form
          style={{ marginTop: 10 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (!password) return;
            const value = password;
            setPassword("");
            void act("/password", { password: value });
          }}
        >
          <p style={{ margin: "0 0 6px" }}>{t("password.title")}</p>
          <div style={row}>
            <input style={field} type="password" autoComplete="off" autoFocus value={password} aria-label={t("password.title")} placeholder={t("password.placeholder")} onChange={(e) => setPassword(e.target.value)} />
            <Button variant="primary" type="submit" disabled={busy || !password}>
              {t("password.continue")}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => void act("/signin/cancel")}>
              {t("cancel")}
            </Button>
          </div>
          <p style={{ ...muted, color: s.passwordWrong ? "var(--danger, #c0392b)" : "var(--muted)" }}>{s.passwordWrong ? t("password.wrong") : t("password.note")}</p>
        </form>
      )}

      {s.state === "connected" && (
        <div>
          <p style={muted}>{t("connected.note")}</p>

          <div style={block}>
            <div style={label}>{t("mode.title")}</div>
            <Segment value={s.mode} disabled={busy} onChange={(mode) => void act("/mode", { mode })} />
          </div>

          <div style={block}>
            <div style={label}>{t("chats.title")}</div>
            <p style={{ ...muted, margin: "0 0 6px" }}>{t("chats.note")}</p>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 6 }}>
              {KINDS.map((k) => (
                <label key={k} style={{ display: "flex", gap: 8, alignItems: "center", padding: "6px 8px", borderRadius: 8, background: "var(--surface-2)", cursor: "pointer" }}>
                  <input type="checkbox" checked={s.access.kinds[k]} disabled={busy} onChange={(e) => void act("/kinds", { kind: k, open: e.target.checked })} />
                  {t(`kind.${k}`)}
                </label>
              ))}
            </div>
          </div>

          <div style={block}>
            <div style={label}>{t("exceptions.title")}</div>
            {exceptions.length === 0 && <p style={{ ...muted, margin: "0 0 6px" }}>{t("exceptions.none")}</p>}
            {exceptions.map((c) => (
              <div key={c.id} style={line}>
                <div style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.title || c.id}</div>
                <Badge tone={c.state === "open" ? "success" : "neutral"}>{t(`exceptions.${c.state}`)}</Badge>
                <Button size="sm" variant="ghost" disabled={busy} title={t("exceptions.remove")} onClick={() => void act("/exception", { chatId: c.id, to: "default" })}>
                  ×
                </Button>
              </div>
            ))}
            <div style={{ marginTop: 8 }}>
              <ChatFinder
                key={finder}
                busy={busy}
                onPick={(chatId, to) =>
                  void act("/exception", { chatId, to }).then((done) => {
                    if (done) setFinder((n) => n + 1);
                  })
                }
              />
            </div>
            <p style={muted}>{t("exceptions.note")}</p>
          </div>

          <div style={{ ...row, ...block }}>
            <Button variant="danger" disabled={busy} onClick={() => window.confirm(t("disconnect.confirm")) && void act("/disconnect")}>
              {t("disconnect")}
            </Button>
            <span style={muted}>{t("disconnect.note")}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function RequestCard({ id }: { id: string }) {
  const [view, setView] = useState<RequestView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    ui.plugin.http<RequestView>("GET", `/requests/${encodeURIComponent(id)}`).then(setView, (e) => setError(errorText(e)));
  }, [id]);
  useEffect(() => {
    load();
    // The account connecting or the access changing elsewhere changes what this card can offer.
    return ui.plugin.on("status", load);
  }, [load]);

  const answer = async (allow: boolean, chatId?: string) => {
    setBusy(true);
    try {
      setView(await ui.plugin.http<RequestView>("POST", `/requests/${encodeURIComponent(id)}`, { allow, ...(chatId ? { chatId } : {}) }));
    } catch (e) {
      ui.toast(errorText(e), "error");
      load();
    } finally {
      setBusy(false);
    }
  };

  if (error) return <p style={{ ...muted, padding: "10px 14px" }}>{t("request.gone")}</p>;
  if (!view) return <Spinner />;
  const v = view;
  const what = v.query ? t(v.sending ? "request.chatAndSend" : "request.chat", { name: v.query }) : t("request.send");

  return (
    <div style={{ padding: "12px 14px 14px" }}>
      <div style={{ fontWeight: 600 }}>{what}</div>
      {v.reason && <p style={{ ...muted, margin: "4px 0 0" }}>{v.reason}</p>}

      {v.status === "allowed" && <p style={{ margin: "8px 0 0" }}>{v.chat ? t(v.sending ? "request.done.chatAndSend" : "request.done.chat", { name: v.chat.title }) : t("request.done.send")}</p>}
      {v.status === "denied" && <p style={{ ...muted, margin: "8px 0 0" }}>{t("request.denied")}</p>}

      {v.status === "pending" && (
        <div style={{ marginTop: 8 }}>
          {v.offline && <p style={muted}>{t("request.offline")}</p>}
          {!v.offline && v.query && v.candidates.length === 0 && <p style={muted}>{t("request.noChat", { name: v.query })}</p>}
          {!v.offline &&
            v.candidates.map((c) => (
              <div key={c.id} style={line}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.title}</div>
                  <div style={muted}>
                    {t(`kind.${c.kind}.one`)}
                    {c.username ? ` · @${c.username}` : ""}
                    {c.state === "open" ? ` · ${t("request.alreadyOpen")}` : ""}
                  </div>
                </div>
                <Button size="sm" variant="primary" disabled={busy} onClick={() => void answer(true, c.id)}>
                  {t("request.allow")}
                </Button>
              </div>
            ))}
          {!v.query && <p style={{ ...muted, margin: "0 0 8px" }}>{t("request.send.note")}</p>}
          <div style={{ ...row, marginTop: 8 }}>
            {!v.query && !v.offline && (
              <Button variant="primary" disabled={busy} onClick={() => void answer(true)}>
                {t("request.allow")}
              </Button>
            )}
            <Button variant="ghost" disabled={busy} onClick={() => void answer(false)}>
              {t("request.deny")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export default definePluginUI((host) => {
  ui = host;
  t = host.i18n.t;
  const offs = [
    host.settings.section({
      id: "telegram-account",
      title: t("title"),
      component: () => (
        <Card>
          <AccountPanel />
        </Card>
      ),
    }),
    host.widgets.add("account", () => (
      <div style={{ padding: "12px 14px 14px" }}>
        <AccountPanel />
      </div>
    )),
    host.widgets.add<{ id: string }>("request", ({ data }) => <RequestCard id={String(data?.id ?? "")} />),
  ];
  return () => offs.forEach((off) => off());
});
