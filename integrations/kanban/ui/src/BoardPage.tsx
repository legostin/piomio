// The board: one project's columns (or all projects by what their columns mean), cards to drag between them, quick add.

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { Button, EmptyState, Spinner } from "@piomio/ui";
import { COLUMN_TYPES, PRIORITIES, type BoardState, type Column, type ColumnType, type Tile } from "../../server/types.ts";
import { CardPanel } from "./CardPanel.tsx";
import { PickupPanel, ProjectPanel } from "./Panels.tsx";
import { AgentChip, askInChat, dueState, enc, fail, formatDue, http, Icon, isOpenRun, nameOf, PriorityMark, runTone, t, TYPE_COLOR, UI } from "./shared.tsx";

const ALL = "all";
/** On the view of all projects: one column per meaning. */
const ALL_COLUMNS: Column[] = COLUMN_TYPES.filter((type) => type !== "cancelled").map((type) => ({ id: type, name: "", type }));

const LAST_PROJECT = "kanban.project";
function remembered(): string {
  try {
    return localStorage.getItem(LAST_PROJECT) ?? "";
  } catch {
    return "";
  }
}
function remember(id: string): void {
  try {
    localStorage.setItem(LAST_PROJECT, id);
  } catch {
    /* private window */
  }
}

function TileView({ tile, state, showProject, onOpen, onDragStart, onDragEnd }: { tile: Tile; state: BoardState; showProject: boolean; onOpen: () => void; onDragStart: () => void; onDragEnd: () => void }) {
  const run = tile.run;
  const open = isOpenRun(run?.status);
  const failed = run?.status === "failed";
  const due = dueState(tile.columnType === "done" || tile.columnType === "cancelled" ? undefined : tile.due);
  return (
    <div
      className="kb-tile"
      data-card={tile.id}
      role="button"
      tabIndex={0}
      draggable
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter") onOpen();
      }}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", tile.key);
        onDragStart();
      }}
      onDragEnd={onDragEnd}
    >
      <div className="kb-tile-top">
        <PriorityMark priority={tile.priority} />
        <span className="kb-key">{tile.key}</span>
        <span className="kb-grow" />
        <AgentChip id={tile.assignee} agents={state.agents} busy={run?.status === "running"} />
      </div>
      <div className="kb-tile-title">{tile.title}</div>
      {(open || failed || tile.waitsFor.length > 0 || tile.due || tile.attachmentCount > 0 || tile.commentCount > 0 || tile.labels.length > 0 || tile.external || (tile.outside && !tile.allowed)) && (
        <div className="kb-tile-meta">
          {(open || failed) && <span className={`kb-run kb-run-${runTone(run!.status)}`}>{t(`ui.run.${run!.status}`)}</span>}
          {tile.outside && !tile.allowed && (
            <span className="kb-meta-warn" title={t("ui.outside.short")}>
              <Icon name="shield" size={12} />
            </span>
          )}
          {tile.waitsFor.length > 0 && (
            <span title={t("ui.waitsFor", { cards: tile.waitsFor.join(", ") })}>
              <Icon name="wait" size={12} /> {tile.waitsFor.length}
            </span>
          )}
          {tile.due && (
            <span className={due ? `kb-due-${due}` : undefined}>
              <Icon name="clock" size={12} /> {formatDue(tile.due)}
            </span>
          )}
          {tile.attachmentCount > 0 && (
            <span>
              <Icon name="clip" size={12} /> {tile.attachmentCount}
            </span>
          )}
          {tile.commentCount > 0 && (
            <span>
              <Icon name="comment" size={12} /> {tile.commentCount}
            </span>
          )}
          {tile.external && (
            <span title={`${tile.external.source} ${tile.external.id}`}>
              <Icon name="link" size={12} /> {tile.external.id}
            </span>
          )}
          {tile.labels.slice(0, 3).map((l) => (
            <span key={l} className="kb-label">
              {l}
            </span>
          ))}
          {showProject && <span className="kb-muted">{state.projects.find((p) => p.id === tile.projectId)?.name}</span>}
        </div>
      )}
    </div>
  );
}

function QuickAdd({ project, column, onDone }: { project: string; column: Column; onDone: () => void }) {
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const add = async () => {
    const text = title.trim();
    if (!text) return setAdding(false);
    try {
      await http("POST", "cards", { project, status: column.id, title: text });
      setTitle("");
      onDone();
    } catch (e) {
      fail(e);
    }
  };
  if (!adding) {
    return (
      <button type="button" className="kb-add" onClick={() => setAdding(true)}>
        <Icon name="plus" size={13} /> {t("ui.card.add")}
      </button>
    );
  }
  return (
    <textarea
      className="kb-input kb-add-input"
      autoFocus
      rows={2}
      value={title}
      placeholder={t("ui.card.addPlaceholder")}
      onChange={(e) => setTitle(e.target.value)}
      onBlur={() => void add()}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          void add();
        }
        if (e.key === "Escape") {
          setTitle("");
          setAdding(false);
        }
      }}
    />
  );
}

export function BoardPage() {
  const params = useMemo(() => new URLSearchParams(location.search), []);
  const [state, setState] = useState<BoardState | null>(null);
  const [tiles, setTiles] = useState<Tile[]>([]);
  const [projectId, setProjectId] = useState<string>(params.get("project") ?? remembered());
  const [openCard, setOpenCard] = useState<string | null>(params.get("card"));
  const [query, setQuery] = useState("");
  const [panel, setPanel] = useState<"pickup" | "project" | null>(null);
  const [drag, setDrag] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ column: string; before: string | null } | null>(null);
  const reload = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const project = state?.projects.find((p) => p.id === projectId);
  const shown = project?.id ?? (projectId === ALL ? ALL : state?.projects[0]?.id);

  const load = useCallback(async () => {
    try {
      const [s, c] = await Promise.all([http<BoardState>("GET", "state"), http<{ cards: Tile[] }>("GET", `cards?project=${ALL}`)]);
      setState(s);
      setTiles(c.cards);
    } catch (e) {
      fail(e);
    }
  }, []);

  useEffect(() => {
    void load();
    const off = UI.plugin.on("changed", () => {
      clearTimeout(reload.current);
      reload.current = setTimeout(() => void load(), 150);
    });
    return () => {
      off();
      clearTimeout(reload.current);
    };
  }, [load]);

  // The address says what is open, so a reload or a link from the chat lands on the same card.
  useEffect(() => {
    if (!shown) return;
    const q = new URLSearchParams({ project: shown });
    if (openCard) q.set("card", openCard);
    history.replaceState(history.state, "", `${location.pathname}?${q}`);
  }, [shown, openCard]);

  const choose = (id: string) => {
    setProjectId(id);
    remember(id);
  };

  const columns: Column[] = shown === ALL ? ALL_COLUMNS : (state?.projects.find((p) => p.id === shown)?.columns ?? []);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return tiles.filter((c) => (shown === ALL || c.projectId === shown) && (!q || `${c.key} ${c.title} ${c.labels.join(" ")} ${nameOf(c.assignee, state?.agents ?? [])} ${c.external?.id ?? ""}`.toLowerCase().includes(q)));
  }, [tiles, shown, query, state]);

  const inColumn = (c: Column): Tile[] => {
    if (shown !== ALL) return visible.filter((x) => x.columnId === c.id).sort((a, b) => a.position - b.position);
    const types: ColumnType[] = c.type === "done" ? ["done", "cancelled"] : [c.type];
    return visible.filter((x) => types.includes(x.columnType)).sort((a, b) => PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority) || b.updatedAt.localeCompare(a.updatedAt));
  };

  const onDragOver = (e: DragEvent<HTMLElement>, column: Column) => {
    if (!drag) return;
    e.preventDefault();
    let before: string | null = null;
    if (shown !== ALL) {
      for (const el of e.currentTarget.querySelectorAll<HTMLElement>("[data-card]")) {
        if (el.dataset.card === drag) continue;
        const r = el.getBoundingClientRect();
        if (e.clientY < r.top + r.height / 2) {
          before = el.dataset.card ?? null;
          break;
        }
      }
    }
    setDrop((d) => (d?.column === column.id && d.before === before ? d : { column: column.id, before }));
  };

  const onDrop = async (e: DragEvent<HTMLElement>, column: Column) => {
    e.preventDefault();
    const id = drag;
    const before = drop?.before ?? null;
    setDrag(null);
    setDrop(null);
    if (!id) return;
    if (shown !== ALL) {
      // Where it lands shows at once; the reload that follows has the real order.
      setTiles((list) =>
        list.map((c) => {
          if (c.id !== id) return c;
          const next = before ? list.find((x) => x.id === before) : undefined;
          return { ...c, columnId: column.id, columnType: column.type, position: next ? next.position - 0.5 : Number.MAX_SAFE_INTEGER };
        }),
      );
    }
    try {
      await http("POST", `cards/${enc(id)}/move`, { column: shown === ALL ? column.type : column.id, ...(before ? { before } : {}) });
    } catch (err) {
      fail(err);
    }
    void load();
  };

  if (!state) {
    return (
      <div className="kb-page kb-center">
        <Spinner />
      </div>
    );
  }

  if (!state.projects.length) {
    return (
      <div className="kb-page kb-center">
        <EmptyState title={t("ui.empty.title")} hint={t("ui.empty.hint")} icon="square-kanban" />
        <div className="kb-row" style={{ justifyContent: "center", marginTop: 16 }}>
          <Button variant="primary" onClick={() => void askInChat(state, undefined, t("ui.ask.newProject"))}>
            {t("ui.project.new")}
          </Button>
          <Button
            variant="secondary"
            onClick={() =>
              void http("POST", "projects", { name: t("project.default") })
                .then(load)
                .catch(fail)
            }
          >
            {t("ui.empty.start")}
          </Button>
        </div>
      </div>
    );
  }

  const running = state.pickup.rules.reduce((n, r) => n + r.running, 0);

  return (
    <div className="kb-page">
      <header className="kb-bar">
        <select className="kb-input kb-project" value={shown} aria-label={t("ui.project.choose")} onChange={(e) => (e.target.value === "+" ? void askInChat(state, undefined, t("ui.ask.newProject")) : choose(e.target.value))}>
          {state.projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
          {state.projects.length > 1 && <option value={ALL}>{t("ui.project.all")}</option>}
          <option value="+">{t("ui.project.newOption")}</option>
        </select>
        {shown !== ALL && (
          <button type="button" className="kb-icon" title={t("ui.project.settings")} aria-label={t("ui.project.settings")} onClick={() => setPanel("project")}>
            <Icon name="settings" size={16} />
          </button>
        )}
        <span className="kb-grow" />
        <input className="kb-input kb-search" type="search" value={query} placeholder={t("ui.search")} aria-label={t("ui.search")} onChange={(e) => setQuery(e.target.value)} />
        <button type="button" className={`kb-pill${state.pickup.on ? " is-on" : ""}`} onClick={() => setPanel("pickup")}>
          <Icon name="spark" size={13} />
          {state.pickup.on ? (running ? t("ui.pickup.pillBusy", { n: running }) : t("ui.pickup.pillOn")) : t("ui.pickup.pillOff")}
        </button>
      </header>

      <div className="kb-columns">
        {columns.map((column) => {
          const cards = inColumn(column);
          const over = column.limit && cards.length > column.limit;
          const name = shown === ALL ? t(`type.${column.type}`) : column.name;
          return (
            <section
              key={column.id}
              className={`kb-column${drop?.column === column.id ? " is-over" : ""}`}
              aria-label={name}
              onDragOver={(e) => onDragOver(e, column)}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrop(null);
              }}
              onDrop={(e) => void onDrop(e, column)}
            >
              <h3 className="kb-column-head">
                <i className="kb-dot" style={{ background: TYPE_COLOR[column.type] }} title={t(`type.${column.type}`)} />
                <span className="kb-column-name">{name}</span>
                <span className={over ? "kb-count is-over" : "kb-count"}>{column.limit ? `${cards.length}/${column.limit}` : cards.length}</span>
              </h3>
              <div className="kb-cards">
                {cards.map((tile) => (
                  <div key={tile.id}>
                    {drop?.column === column.id && drop.before === tile.id && <div className="kb-drop" />}
                    <TileView tile={tile} state={state} showProject={shown === ALL} onOpen={() => setOpenCard(tile.id)} onDragStart={() => setDrag(tile.id)} onDragEnd={() => { setDrag(null); setDrop(null); }} />
                  </div>
                ))}
                {drop?.column === column.id && !drop.before && drag && <div className="kb-drop" />}
              </div>
              {shown !== ALL && <QuickAdd project={shown!} column={column} onDone={() => void load()} />}
            </section>
          );
        })}
      </div>

      {openCard && <CardPanel id={openCard} state={state} onClose={() => setOpenCard(null)} />}
      {panel === "pickup" && <PickupPanel state={state} onClose={() => setPanel(null)} onChanged={setState} />}
      {panel === "project" && project && <ProjectPanel project={project} state={state} onClose={() => setPanel(null)} onChanged={() => void load()} />}
    </div>
  );
}
