// Environments: sets of variables a request is filled from. One of them is active.

import { useState } from "react";
import { Button } from "@piomio/ui";
import type { ClientState, Environment, Pair } from "../../server/types.ts";
import { PairEditor } from "./PairEditor.tsx";
import { enc, fail, http, Icon, t } from "./shared.tsx";

const toPairs = (vars: Record<string, string>): Pair[] => Object.entries(vars).map(([name, value]) => ({ name, value }));
const toVars = (pairs: Pair[]): Record<string, string> => Object.fromEntries(pairs.filter((p) => p.name.trim()).map((p) => [p.name.trim(), p.value]));

export function EnvironmentsPanel({ state, onClose }: { state: ClientState; onClose: () => void }) {
  const [list, setList] = useState<Environment[]>(state.environments);
  const first = list.find((e) => e.id === state.activeEnvironment) ?? list[0];
  const [id, setId] = useState<string | undefined>(first?.id);
  const [name, setName] = useState(first?.name ?? "");
  const [pairs, setPairs] = useState<Pair[]>(first ? toPairs(first.vars) : []);

  const choose = (e: Environment | undefined) => {
    setId(e?.id);
    setName(e?.name ?? "");
    setPairs(e ? toPairs(e.vars) : []);
  };

  const save = async () => {
    try {
      const body = { name, vars: toVars(pairs) };
      const e = id ? await http<Environment>("PUT", `environments/${enc(id)}`, body) : await http<Environment>("POST", "environments", body);
      setList((old) => [...old.filter((x) => x.id !== e.id), e].sort((a, b) => a.name.localeCompare(b.name)));
      choose(e);
    } catch (e) {
      fail(e);
    }
  };

  const remove = async () => {
    const e = list.find((x) => x.id === id);
    if (!e || !confirm(t("ui.env.removeConfirm", { name: e.name }))) return;
    try {
      await http("DELETE", `environments/${enc(e.id)}`);
      const rest = list.filter((x) => x.id !== e.id);
      setList(rest);
      choose(rest[0]);
    } catch (err) {
      fail(err);
    }
  };

  return (
    <div className="hc-overlay" onClick={onClose}>
      <div className="hc-sheet" role="dialog" aria-label={t("ui.env.title")} onClick={(e) => e.stopPropagation()}>
        <div className="hc-sheet-head">
          <Icon name="layers" size={16} />
          <span className="hc-grow">{t("ui.env.title")}</span>
          <button type="button" className="hc-icon" onClick={onClose} title={t("ui.close")} aria-label={t("ui.close")}>
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className="hc-sheet-body">
          <div className="hc-row hc-wrap">
            {list.map((e) => (
              <button key={e.id} type="button" className={`hc-chip${id === e.id ? " is-on" : ""}`} onClick={() => choose(e)}>
                {e.name}
              </button>
            ))}
            <button type="button" className={`hc-chip${id ? "" : " is-on"}`} onClick={() => choose(undefined)}>
              + {t("ui.env.new")}
            </button>
          </div>
          {list.length === 0 && <span className="hc-muted">{t("ui.env.empty")}</span>}
          <input className="hc-input" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("ui.env.name")} aria-label={t("ui.env.name")} />
          <PairEditor pairs={pairs} onChange={setPairs} switches={false} />
          <span className="hc-muted">{t("ui.env.hint")}</span>
          <div className="hc-row">
            <Button size="sm" disabled={!name.trim()} onClick={() => void save()}>
              {t("ui.save")}
            </Button>
            {id && (
              <Button size="sm" variant="ghost" onClick={() => void remove()}>
                {t("ui.remove")}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
