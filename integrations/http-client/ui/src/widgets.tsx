// The card in the chat: one response, as an agent showed it. What was shown stays in the conversation, so the card keeps
// the line it was drawn with and reads the body from the history only when the person opens it.

import { useState } from "react";
import { Spinner, type WidgetProps } from "@piomio/ui";
import type { Entry, ResponseCard } from "../../server/types.ts";
import { duration, enc, http, MethodMark, pretty, shortUrl, size, statusTone, t, UI } from "./shared.tsx";

const PREVIEW = 6000;

export function ResponseWidget({ data }: WidgetProps<ResponseCard>) {
  const [open, setOpen] = useState(false);
  const [entry, setEntry] = useState<Entry | null | undefined>(undefined);

  const toggle = () => {
    setOpen(!open);
    if (!open && entry === undefined) http<Entry>("GET", `history/${enc(data.id)}`).then(setEntry, () => setEntry(null));
  };

  const r = entry?.response;
  const body = r?.body ? pretty(r.body, r.contentType) : "";
  return (
    <div className="hc-widget">
      <div className="hc-widget-top">
        <MethodMark method={data.method} />
        <span className="hc-widget-url" title={data.url}>
          {shortUrl(data.url)}
        </span>
        <span className={`hc-status hc-tone-${statusTone(data.status)}`}>{data.status ?? t("ui.failed")}</span>
      </div>
      <div className="hc-row hc-wrap hc-muted">
        {data.error ? <span>{data.error}</span> : <span>{[data.statusText, duration(data.ms), size(data.bytes)].filter(Boolean).join(" · ")}</span>}
        <span className="hc-grow" />
        {!data.error && (
          <button type="button" className="hc-text-button" onClick={toggle}>
            {t(open ? "ui.widget.hide" : "ui.widget.show")}
          </button>
        )}
        <button type="button" className="hc-text-button" onClick={() => UI.navigate(`/http?entry=${enc(data.id)}`)}>
          {t("ui.widget.open")}
        </button>
      </div>
      {open &&
        (entry === undefined ? (
          <Spinner size={14} />
        ) : entry === null ? (
          <div className="hc-muted">{t("ui.widget.gone")}</div>
        ) : r?.binary ? (
          <div className="hc-muted">{t("ui.response.binary", { size: size(r.bytes) })}</div>
        ) : !body ? (
          <div className="hc-muted">{t("ui.response.empty")}</div>
        ) : (
          <pre className="hc-widget-pre">{body.length > PREVIEW ? `${body.slice(0, PREVIEW)}\n…` : body}</pre>
        ))}
    </div>
  );
}
