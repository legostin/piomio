// Cards in the chat. What was shown stays in the conversation, so a card reads the board as it is now and offers what can
// be done now: the person answers an agent's "SITE-12 is ready" right there, without leaving the chat.

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Spinner, type WidgetProps } from "@piomio/ui";
import type { CardView, Tile } from "../../server/types.ts";
import { enc, fail, http, Icon, isOpenRun, PriorityMark, runTone, t, TYPE_COLOR, UI } from "./shared.tsx";

const TOP = 3;

export function CardWidget({ data }: WidgetProps<{ id: string; key: string; title: string }>) {
  const [card, setCard] = useState<CardView | null>(null);
  const [gone, setGone] = useState(false);
  const url = `cards/${enc(data.id)}`;

  const load = useCallback(() => {
    http<CardView>("GET", url).then(
      (c) => {
        setCard(c);
        setGone(false);
      },
      () => setGone(true),
    );
  }, [url]);

  useEffect(() => {
    load();
    return UI.plugin.on("changed", load);
  }, [load]);

  const act = (path: string) => http<CardView>("POST", `${url}/${path}`).then(setCard, fail);
  const openPage = () => UI.navigate(`/kanban?project=${enc(card?.projectId ?? "")}&card=${enc(data.id)}`);

  if (gone) return <div className="kb-widget kb-muted">{t("ui.widget.gone", { card: data.key })}</div>;
  if (!card) {
    return (
      <div className="kb-widget">
        <Spinner size={14} />
      </div>
    );
  }
  const run = card.runs.at(-1);
  const open = isOpenRun(run?.status);
  const column = card.project.columns.find((c) => c.id === card.columnId);
  return (
    <div className="kb-widget">
      <button type="button" className="kb-widget-title" onClick={openPage}>
        <PriorityMark priority={card.priority} />
        <span className="kb-key">{card.key}</span>
        <span className="kb-widget-name">{card.title}</span>
      </button>
      <div className="kb-row">
        <i className="kb-dot" style={{ background: TYPE_COLOR[card.columnType] }} />
        <span>{column?.name}</span>
        {run && (open || run.status === "failed") && <Badge tone={runTone(run.status)}>{t(`ui.run.${run.status}`)}</Badge>}
        {card.attachments.length > 0 && (
          <span className="kb-muted">
            <Icon name="clip" size={12} /> {card.attachments.length}
          </span>
        )}
      </div>
      {card.outside && !card.allowed ? (
        <div className="kb-row">
          <span className="kb-muted kb-grow">{t("ui.outside.short")}</span>
          <Button size="sm" variant="secondary" onClick={() => void act("allow")}>
            {t("ui.outside.allow")}
          </Button>
        </div>
      ) : (
        !open &&
        card.columnType === "review" && (
          <div className="kb-row">
            <Button size="sm" variant="primary" onClick={() => void act("accept")}>
              {t("ui.review.accept")}
            </Button>
            <Button size="sm" variant="secondary" onClick={openPage}>
              {t("ui.review.return")}
            </Button>
          </div>
        )
      )}
    </div>
  );
}

export function BoardWidget({ data }: WidgetProps<{ projectId: string; name: string }>) {
  const [cards, setCards] = useState<Tile[] | null>(null);
  const [columns, setColumns] = useState<Array<{ id: string; name: string; type: keyof typeof TYPE_COLOR }> | null>(null);

  const load = useCallback(() => {
    Promise.all([http<{ cards: Tile[] }>("GET", `cards?project=${enc(data.projectId)}`), http<{ projects: Array<{ id: string; columns: any[] }> }>("GET", "state")]).then(([c, s]) => {
      setCards(c.cards);
      setColumns(s.projects.find((p) => p.id === data.projectId)?.columns ?? []);
    }, fail);
  }, [data.projectId]);

  useEffect(() => {
    load();
    return UI.plugin.on("changed", load);
  }, [load]);

  const openPage = () => UI.navigate(`/kanban?project=${enc(data.projectId)}`);
  if (!cards || !columns) {
    return (
      <div className="kb-widget">
        <Spinner size={14} />
      </div>
    );
  }
  return (
    <div className="kb-widget">
      <button type="button" className="kb-widget-title" onClick={openPage}>
        <span className="kb-widget-name">{data.name}</span>
      </button>
      <div className="kb-mini">
        {columns.map((c) => {
          const list = cards.filter((x) => x.columnId === c.id).sort((a, b) => a.position - b.position);
          return (
            <div key={c.id} className="kb-mini-column">
              <div className="kb-row">
                <i className="kb-dot" style={{ background: TYPE_COLOR[c.type] }} />
                <span className="kb-mini-name">{c.name}</span>
                <span className="kb-count">{list.length}</span>
              </div>
              {list.slice(0, TOP).map((x) => (
                <button key={x.id} type="button" className="kb-mini-card" title={x.title} onClick={() => UI.navigate(`/kanban?project=${enc(data.projectId)}&card=${enc(x.id)}`)}>
                  {x.title}
                </button>
              ))}
              {list.length > TOP && <span className="kb-muted">{t("ui.widget.more", { n: list.length - TOP })}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
