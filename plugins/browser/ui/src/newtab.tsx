// A new (blank) tab: a search field and the sites opened most often, instead of a white picture.

import { useEffect, useState } from "react";
import { Compass } from "lucide-react";
import { Favicon } from "./chrome.tsx";
import { host, send, t, type BrowserState, type Site } from "./host.ts";
import { Omnibox } from "./omnibox.tsx";

export function NewTabPage({ state, search }: { state: BrowserState | null; search: boolean }) {
  const [sites, setSites] = useState<Site[]>([]);
  useEffect(() => {
    host.plugin
      .http<{ sites: Site[] }>("GET", "top")
      .then((r) => setSites(r.sites ?? []))
      .catch(() => {});
  }, []);
  return (
    <div className="obb-ntp">
      <div className="obb-ntp-mark" aria-hidden>
        <Compass />
      </div>
      {state?.machine && <div className="obb-ntp-machine obb-muted">{t("ui.machine.where", { machine: state.machine })}</div>}
      {search && <Omnibox state={state} variant="hero" />}
      {sites.length > 0 && (
        <div className="obb-tiles">
          {sites.map((s) => (
            <button key={s.url} type="button" className="obb-tile" title={s.url} onClick={() => send({ type: "navigate", text: s.url })}>
              <span className="obb-tile-icon">
                <Favicon icon={s.icon} />
              </span>
              <span className="obb-tile-name obb-trunc">{s.title}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
