// A card, opened: what it says, where it stands, its files, comments and runs, and what can be done with it now.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Badge, Button, Markdown, Spinner } from "@piomio/ui";
import { ME, PRIORITIES, type BoardState, type CardAttachment, type CardView } from "../../server/types.ts";
import { enc, fail, http, Icon, isOpenRun, nameOf, runTone, t, UI } from "./shared.tsx";

/** The hub takes at most 20 MB in a request, and a file travels in base64. */
const MAX_UPLOAD = 15 * 1024 * 1024;

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

async function download(card: CardView, a: CardAttachment): Promise<void> {
  try {
    const f = await http<{ name: string; mimeType: string; data: string }>("GET", `cards/${enc(card.id)}/attachments/${enc(a.id)}`);
    const bytes = Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: f.mimeType }));
    const link = document.createElement("a");
    link.href = url;
    link.download = f.name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  } catch (e) {
    fail(e);
  }
}

const size = (bytes: number): string => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`);
const when = (iso: string): string => UI.i18n.formatDate(iso, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** A field that saves when it loses focus. */
function Draft({ value, onSave, className, placeholder, ariaLabel }: { value: string; onSave: (v: string) => void; className?: string; placeholder?: string; ariaLabel?: string }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const save = () => {
    if (text.trim() !== value) onSave(text.trim());
  };
  return (
    <input
      className={className ?? "kb-input"}
      value={text}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onChange={(e) => setText(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") setText(value);
      }}
    />
  );
}

export function CardPanel({ id, state, onClose }: { id: string; state: BoardState; onClose: () => void }) {
  const [card, setCard] = useState<CardView | null>(null);
  const [gone, setGone] = useState(false);
  const [editing, setEditing] = useState(false);
  const [description, setDescription] = useState("");
  const [comment, setComment] = useState("");
  const [returning, setReturning] = useState(false);
  const [back, setBack] = useState("");
  const [agent, setAgent] = useState("");
  const [sure, setSure] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const url = `cards/${enc(id)}`;

  const load = useCallback(() => {
    http<CardView>("GET", url).then(setCard, () => setGone(true));
  }, [url]);

  useEffect(() => {
    load();
    return UI.plugin.on("changed", load);
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !(e.target as HTMLElement).closest?.("input,textarea,select")) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const act = async (method: "POST" | "PATCH" | "DELETE", path: string, body?: unknown) => {
    try {
      const next = await http<CardView>(method, path, body);
      setCard(next);
      return true;
    } catch (e) {
      fail(e);
      return false;
    }
  };

  const frame = (children: ReactNode) => (
    <div className="kb-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="kb-sheet kb-sheet-card" role="dialog" aria-label={card?.title ?? t("ui.card.title")}>
        {children}
      </aside>
    </div>
  );

  if (gone) {
    return frame(
      <div className="kb-center">
        <p className="kb-muted">{t("ui.card.gone")}</p>
        <Button variant="secondary" onClick={onClose}>
          {t("ui.close")}
        </Button>
      </div>,
    );
  }
  if (!card) return frame(<div className="kb-center"><Spinner /></div>);

  const lastRun = card.runs.at(-1);
  const open = isOpenRun(lastRun?.status);
  const agents = state.agents;
  const chosen = agent || (card.assignee && card.assignee !== ME ? card.assignee : "") || state.defaultAgent || agents[0]?.id || "";
  const held = card.outside && !card.allowed;

  const upload = async (files: FileList | null) => {
    for (const file of Array.from(files ?? [])) {
      if (file.size > MAX_UPLOAD) {
        UI.toast(t("ui.attach.tooLarge", { name: file.name, max: MAX_UPLOAD / (1024 * 1024) }), "error");
        continue;
      }
      await act("POST", `${url}/attachments`, { name: file.name, mimeType: file.type, data: await toBase64(file) });
    }
    if (fileInput.current) fileInput.current.value = "";
  };

  const addBlocker = async (ref: string) => {
    if (ref) await act("PATCH", url, { blockedBy: [...card.blockers.map((b) => b.id), ref] });
  };

  return frame(
    <>
      <header className="kb-sheet-head">
        <span className="kb-key">{card.key}</span>
        <span className="kb-muted">{card.project.name}</span>
        {card.external?.url && (
          <a className="kb-link" href={card.external.url} target="_blank" rel="noreferrer">
            <Icon name="link" size={12} /> {card.external.id}
          </a>
        )}
        <span className="kb-grow" />
        <button type="button" className="kb-icon" aria-label={t("ui.close")} onClick={onClose}>
          <Icon name="close" size={16} />
        </button>
      </header>

      <div className="kb-sheet-body">
        <Draft className="kb-title-input" value={card.title} ariaLabel={t("ui.card.title")} onSave={(title) => void act("PATCH", url, { title })} />

        {held && (
          <div className="kb-note kb-note-warn">
            <Icon name="shield" size={14} />
            <span className="kb-grow">{t("ui.outside.note")}</span>
            <Button size="sm" variant="secondary" onClick={() => void act("POST", `${url}/allow`)}>
              {t("ui.outside.allow")}
            </Button>
          </div>
        )}

        {open && lastRun && (
          <div className="kb-note">
            <Badge tone={runTone(lastRun.status)}>{t(`ui.run.${lastRun.status}`)}</Badge>
            <span className="kb-grow">{lastRun.question ?? nameOf(lastRun.agentId, agents)}</span>
            <Button size="sm" variant="ghost" onClick={() => UI.navigate(`/tasks/${enc(lastRun.taskId)}`)}>
              {t("ui.run.open")}
            </Button>
          </div>
        )}
        {!open && lastRun?.status === "failed" && (
          <div className="kb-note kb-note-danger">
            <span className="kb-grow">{lastRun.error || t("ui.run.failed")}</span>
          </div>
        )}

        {!open && card.columnType === "review" && !returning && (
          <div className="kb-row">
            <Button variant="primary" onClick={() => void act("POST", `${url}/accept`)}>
              {t("ui.review.accept")}
            </Button>
            <Button variant="secondary" onClick={() => setReturning(true)}>
              {t("ui.review.return")}
            </Button>
          </div>
        )}
        {returning && (
          <div className="kb-stack">
            <textarea className="kb-input" rows={3} autoFocus value={back} placeholder={t("ui.review.placeholder")} onChange={(e) => setBack(e.target.value)} />
            <div className="kb-row">
              <Button
                variant="primary"
                disabled={!back.trim()}
                onClick={() =>
                  void act("POST", `${url}/return`, { comment: back }).then((done) => {
                    if (done) {
                      setReturning(false);
                      setBack("");
                    }
                  })
                }
              >
                {t("ui.review.send")}
              </Button>
              <Button variant="ghost" onClick={() => setReturning(false)}>
                {t("ui.cancel")}
              </Button>
            </div>
          </div>
        )}
        {!open && card.columnType !== "review" && card.columnType !== "done" && card.columnType !== "cancelled" && (
          <div className="kb-row">
            <select className="kb-input kb-grow" value={chosen} aria-label={t("ui.run.agent")} onChange={(e) => setAgent(e.target.value)}>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            <Button variant="secondary" disabled={!chosen} onClick={() => void act("POST", `${url}/start`, { agent: chosen })}>
              {lastRun ? t("ui.run.again") : t("ui.run.start")}
            </Button>
          </div>
        )}

        <dl className="kb-fields">
          <dt>{t("ui.field.status")}</dt>
          <dd>
            <select className="kb-input" value={card.columnId} onChange={(e) => void act("POST", `${url}/move`, { column: e.target.value })}>
              {card.project.columns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </dd>
          <dt>{t("ui.field.priority")}</dt>
          <dd>
            <select className="kb-input" value={card.priority} onChange={(e) => void act("PATCH", url, { priority: e.target.value })}>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {t(`priority.${p}`)}
                </option>
              ))}
            </select>
          </dd>
          <dt>{t("ui.field.assignee")}</dt>
          <dd>
            <select className="kb-input" value={card.assignee ?? ""} onChange={(e) => void act("PATCH", url, { assignee: e.target.value || null })}>
              <option value="">{t("ui.field.nobody")}</option>
              <option value={ME}>{t("ui.me")}</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </dd>
          <dt>{t("ui.field.due")}</dt>
          <dd>
            <input className="kb-input" type="date" value={card.due ?? ""} onChange={(e) => void act("PATCH", url, { due: e.target.value || null })} />
          </dd>
          <dt>{t("ui.field.labels")}</dt>
          <dd>
            <Draft value={card.labels.join(", ")} placeholder={t("ui.field.labelsHint")} onSave={(v) => void act("PATCH", url, { labels: v.split(",").map((l) => l.trim()).filter(Boolean) })} />
          </dd>
          <dt>{t("ui.field.waits")}</dt>
          <dd className="kb-stack">
            {card.blockers.map((b) => (
              <div key={b.id} className="kb-row kb-blocker">
                <span className={b.closed ? "kb-closed" : undefined}>
                  <span className="kb-key">{b.key}</span> {b.title}
                </span>
                <span className="kb-grow" />
                <button type="button" className="kb-icon" aria-label={t("ui.remove")} onClick={() => void act("PATCH", url, { blockedBy: card.blockers.filter((x) => x.id !== b.id).map((x) => x.id) })}>
                  <Icon name="close" size={12} />
                </button>
              </div>
            ))}
            <Draft key={card.blockers.length} value="" placeholder={t("ui.field.waitsHint")} onSave={(v) => void addBlocker(v)} />
          </dd>
        </dl>

        <section>
          <h4 className="kb-section">
            {t("ui.field.description")}
            {!editing && (
              <button
                type="button"
                className="kb-text-button"
                onClick={() => {
                  setDescription(card.description);
                  setEditing(true);
                }}
              >
                {t("ui.edit")}
              </button>
            )}
          </h4>
          {editing ? (
            <div className="kb-stack">
              <textarea className="kb-input kb-mono" rows={8} autoFocus value={description} onChange={(e) => setDescription(e.target.value)} />
              <div className="kb-row">
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() =>
                    void act("PATCH", url, { description }).then((done) => {
                      if (done) setEditing(false);
                    })
                  }
                >
                  {t("ui.save")}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
                  {t("ui.cancel")}
                </Button>
              </div>
            </div>
          ) : card.description.trim() ? (
            <div className="kb-markdown">
              <Markdown text={card.description} />
            </div>
          ) : (
            <p className="kb-muted">{t("ui.field.descriptionEmpty")}</p>
          )}
        </section>

        <section>
          <h4 className="kb-section">
            {t("ui.attach.title")}
            <button type="button" className="kb-text-button" onClick={() => fileInput.current?.click()}>
              {t("ui.attach.add")}
            </button>
            <input ref={fileInput} type="file" multiple hidden onChange={(e) => void upload(e.target.files)} />
          </h4>
          {card.attachments.map((a) => (
            <div key={a.id} className="kb-row kb-file">
              <Icon name="clip" size={13} />
              <button type="button" className="kb-text-button kb-file-name" onClick={() => void download(card, a)}>
                {a.name}
              </button>
              <span className="kb-muted">{size(a.size)}</span>
              <span className="kb-grow" />
              <button type="button" className="kb-icon" aria-label={t("ui.remove")} onClick={() => void act("DELETE", `${url}/attachments/${enc(a.id)}`)}>
                <Icon name="close" size={12} />
              </button>
            </div>
          ))}
        </section>

        {card.runs.length > 0 && (
          <section>
            <h4 className="kb-section">{t("ui.run.title")}</h4>
            {[...card.runs].reverse().map((r) => (
              <details key={r.taskId} className="kb-runline" open={r === lastRun && !!r.result}>
                <summary>
                  <Badge tone={runTone(r.status)}>{t(`ui.run.${r.status}`)}</Badge>
                  <span>{nameOf(r.agentId, agents)}</span>
                  {r.auto && <span className="kb-muted">{t("ui.run.auto")}</span>}
                  <span className="kb-muted">{when(r.startedAt)}</span>
                  <span className="kb-grow" />
                  <button type="button" className="kb-text-button" onClick={() => UI.navigate(`/tasks/${enc(r.taskId)}`)}>
                    {t("ui.run.open")}
                  </button>
                </summary>
                {r.result && (
                  <div className="kb-markdown">
                    <Markdown text={r.result} />
                  </div>
                )}
                {r.error && <p className="kb-danger">{r.error}</p>}
              </details>
            ))}
          </section>
        )}

        <section>
          <h4 className="kb-section">{t("ui.comments")}</h4>
          {card.comments.map((c) => (
            <div key={c.id} className="kb-comment">
              <div className="kb-row">
                <strong>{nameOf(c.author, agents)}</strong>
                <span className="kb-muted">{when(c.createdAt)}</span>
              </div>
              <div className="kb-markdown">
                <Markdown text={c.text} />
              </div>
            </div>
          ))}
          <div className="kb-stack">
            <textarea className="kb-input" rows={2} value={comment} placeholder={t("ui.comment.placeholder")} onChange={(e) => setComment(e.target.value)} />
            {comment.trim() && (
              <div className="kb-row">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    void act("POST", `${url}/comments`, { text: comment }).then((done) => {
                      if (done) setComment("");
                    })
                  }
                >
                  {t("ui.comment.send")}
                </Button>
              </div>
            )}
          </div>
        </section>

        <details className="kb-history">
          <summary>{t("ui.history")}</summary>
          {[...card.activity].reverse().map((a, i) => (
            <div key={i} className="kb-row kb-muted">
              <span>{when(a.at)}</span>
              <span>
                {nameOf(a.by, agents)}: {a.kind === "assigned" && !a.params?.to ? t("ui.activity.unassigned") : t(`ui.activity.${a.kind}`, { ...a.params, ...(a.params?.agent ? { agent: nameOf(a.params.agent, agents) } : {}), ...(a.params?.to && a.kind === "assigned" ? { to: nameOf(a.params.to, agents) } : {}) })}
              </span>
            </div>
          ))}
        </details>

        <div className="kb-row">
          {sure ? (
            <>
              <Button
                variant="danger"
                size="sm"
                onClick={() =>
                  void http("DELETE", url).then(onClose, (e) => {
                    setSure(false);
                    fail(e);
                  })
                }
              >
                {t("ui.card.deleteSure")}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setSure(false)}>
                {t("ui.cancel")}
              </Button>
            </>
          ) : (
            <button type="button" className="kb-text-button kb-muted" onClick={() => setSure(true)}>
              {t("ui.card.delete")}
            </button>
          )}
        </div>
      </div>
    </>,
  );
}
