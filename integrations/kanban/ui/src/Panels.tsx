// The two panels beside the board: who takes cards by themselves, and how a project is set up. Both are the second way to
// what an agent does in the chat.

import { useEffect, useState, type ReactNode } from "react";
import { Badge, Button } from "@piomio/ui";
import { COLUMN_TYPES, type BoardState, type ColumnType, type ProjectView, type RuleView } from "../../server/types.ts";
import { askInChat, enc, fail, http, Icon, nameOf, t } from "./shared.tsx";

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="kb-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="kb-sheet" role="dialog" aria-label={title}>
        <header className="kb-sheet-head">
          <strong>{title}</strong>
          <span className="kb-grow" />
          <button type="button" className="kb-icon" aria-label={t("ui.close")} onClick={onClose}>
            <Icon name="close" size={16} />
          </button>
        </header>
        <div className="kb-sheet-body">{children}</div>
      </aside>
    </div>
  );
}

const STATE_TONE: Record<RuleView["state"], "neutral" | "success" | "warning" | "danger"> = {
  ready: "success",
  off: "neutral",
  paused: "neutral",
  initiative: "warning",
  agentGone: "danger",
  asleep: "neutral",
  budget: "warning",
  cooldown: "warning",
};

export function PickupPanel({ state, onClose, onChanged }: { state: BoardState; onClose: () => void; onChanged: (s: BoardState) => void }) {
  const [agent, setAgent] = useState("");
  const free = state.agents.filter((a) => !state.pickup.rules.some((r) => r.agentId === a.id));
  const chosen = agent && free.some((a) => a.id === agent) ? agent : (free[0]?.id ?? "");

  const set = (method: "PUT" | "DELETE", path: string, body?: unknown) => http<BoardState>(method, path, body).then(onChanged, fail);

  const scope = (r: RuleView): string => {
    const parts = [
      r.projects.length ? r.projects.flatMap((id) => state.projects.find((p) => p.id === id)?.name ?? []).join(", ") : t("ui.rule.allProjects"),
      t("ui.rule.parallel", { n: r.parallel }),
    ];
    if (r.labels.length) parts.push(r.labels.map((l) => `#${l}`).join(" "));
    if (r.minPriority) parts.push(t("ui.rule.minPriority", { priority: t(`priority.${r.minPriority}`) }));
    return parts.join(" · ");
  };

  return (
    <Sheet title={t("ui.pickup.title")} onClose={onClose}>
      <label className="kb-switch">
        <input type="checkbox" checked={state.pickup.on} onChange={(e) => void set("PUT", "pickup", { on: e.target.checked })} />
        <span>{t("ui.pickup.switch")}</span>
      </label>
      <p className="kb-muted">{t("ui.pickup.hint")}</p>

      {state.pickup.rules.map((r) => (
        <div key={r.agentId} className="kb-rule">
          <div className="kb-row">
            <strong>{nameOf(r.agentId, state.agents)}</strong>
            <Badge tone={STATE_TONE[r.state]}>{t(`ui.rule.state.${r.state}`)}</Badge>
            <span className="kb-grow" />
            <button type="button" className="kb-text-button" onClick={() => void set("PUT", `pickup/rules/${enc(r.agentId)}`, { enabled: !r.enabled })}>
              {r.enabled ? t("ui.rule.pause") : t("ui.rule.resume")}
            </button>
            <button type="button" className="kb-icon" aria-label={t("ui.remove")} onClick={() => void set("DELETE", `pickup/rules/${enc(r.agentId)}`)}>
              <Icon name="close" size={12} />
            </button>
          </div>
          <div className="kb-muted">{scope(r)}</div>
          {r.state === "initiative" && (
            <button type="button" className="kb-text-button" onClick={() => void askInChat(state, r.agentId, t("ui.ask.initiative"))}>
              {t("ui.rule.raise")}
            </button>
          )}
        </div>
      ))}

      {free.length > 0 && (
        <div className="kb-stack">
          <div className="kb-row">
            <select className="kb-input kb-grow" value={chosen} aria-label={t("ui.run.agent")} onChange={(e) => setAgent(e.target.value)}>
              {free.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            <Button variant="secondary" disabled={!chosen} onClick={() => void askInChat(state, chosen, t("ui.ask.rule"))}>
              {t("ui.pickup.tell")}
            </Button>
          </div>
          <p className="kb-muted">{t("ui.pickup.tellHint")}</p>
        </div>
      )}
    </Sheet>
  );
}

interface ColumnDraft {
  id?: string;
  name: string;
  type: ColumnType;
  limit: string;
}

export function ProjectPanel({ project, state, onClose, onChanged }: { project: ProjectView; state: BoardState; onClose: () => void; onChanged: () => void }) {
  const [name, setName] = useState(project.name);
  const [notes, setNotes] = useState(project.description);
  const [columns, setColumns] = useState<ColumnDraft[]>(project.columns.map((c) => ({ id: c.id, name: c.name, type: c.type, limit: c.limit ? String(c.limit) : "" })));
  const [sure, setSure] = useState(false);
  const url = `projects/${enc(project.id)}`;

  const change = (i: number, patch: Partial<ColumnDraft>) => setColumns((list) => list.map((c, n) => (n === i ? { ...c, ...patch } : c)));
  const shift = (i: number, by: number) =>
    setColumns((list) => {
      const next = [...list];
      const [c] = next.splice(i, 1);
      next.splice(i + by, 0, c);
      return next;
    });

  const save = async () => {
    try {
      await http("PATCH", url, {
        name,
        description: notes,
        columns: columns.map((c) => ({ ...(c.id ? { id: c.id } : {}), name: c.name, type: c.type, limit: c.limit ? Number(c.limit) : null })),
      });
      onChanged();
      onClose();
    } catch (e) {
      fail(e);
    }
  };

  const leave = (archive: boolean) =>
    http(archive ? "PATCH" : "DELETE", url, archive ? { archived: true } : undefined).then(() => {
      onChanged();
      onClose();
    }, fail);

  return (
    <Sheet title={t("ui.project.settings")} onClose={onClose}>
      <label className="kb-field">
        <span>{t("ui.project.name")}</span>
        <input className="kb-input" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="kb-field">
        <span>{t("ui.project.notes")}</span>
        <textarea className="kb-input" rows={3} value={notes} placeholder={t("ui.project.notesHint")} onChange={(e) => setNotes(e.target.value)} />
      </label>

      <h4 className="kb-section">{t("ui.project.columns")}</h4>
      <p className="kb-muted">{t("ui.project.columnsHint")}</p>
      {columns.map((c, i) => (
        <div key={c.id ?? i} className="kb-row kb-column-row">
          <input className="kb-input kb-grow" value={c.name} aria-label={t("ui.project.columnName")} onChange={(e) => change(i, { name: e.target.value })} />
          <select className="kb-input" value={c.type} aria-label={t("ui.project.columnType")} onChange={(e) => change(i, { type: e.target.value as ColumnType })}>
            {COLUMN_TYPES.map((type) => (
              <option key={type} value={type}>
                {t(`type.${type}`)}
              </option>
            ))}
          </select>
          <input className="kb-input kb-limit" inputMode="numeric" value={c.limit} placeholder={t("ui.project.limit")} aria-label={t("ui.project.limit")} onChange={(e) => change(i, { limit: e.target.value.replace(/\D/g, "") })} />
          <button type="button" className="kb-icon" disabled={i === 0} aria-label={t("ui.project.up")} onClick={() => shift(i, -1)}>
            ↑
          </button>
          <button type="button" className="kb-icon" disabled={i === columns.length - 1} aria-label={t("ui.project.down")} onClick={() => shift(i, 1)}>
            ↓
          </button>
          <button type="button" className="kb-icon" disabled={columns.length === 1} aria-label={t("ui.remove")} onClick={() => setColumns((list) => list.filter((_, n) => n !== i))}>
            <Icon name="close" size={12} />
          </button>
        </div>
      ))}
      <div>
        <button type="button" className="kb-text-button" onClick={() => setColumns((list) => [...list, { name: "", type: "backlog", limit: "" }])}>
          {t("ui.project.addColumn")}
        </button>
      </div>

      <div className="kb-row">
        <Button variant="primary" onClick={() => void save()}>
          {t("ui.save")}
        </Button>
        <Button variant="ghost" onClick={() => void askInChat(state, undefined, t("ui.ask.setup", { project: project.name }))}>
          {t("ui.project.inChat")}
        </Button>
        <span className="kb-grow" />
      </div>

      <div className="kb-row kb-danger-zone">
        <button type="button" className="kb-text-button kb-muted" onClick={() => void leave(true)}>
          {t("ui.project.archive")}
        </button>
        {sure ? (
          <>
            <Button variant="danger" size="sm" onClick={() => void leave(false)}>
              {t("ui.project.deleteSure", { n: project.cardCount })}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setSure(false)}>
              {t("ui.cancel")}
            </Button>
          </>
        ) : (
          <button type="button" className="kb-text-button kb-muted" onClick={() => setSure(true)}>
            {t("ui.project.delete")}
          </button>
        )}
      </div>
      <p className="kb-muted">{t("ui.project.key", { key: project.key })}</p>
    </Sheet>
  );
}
