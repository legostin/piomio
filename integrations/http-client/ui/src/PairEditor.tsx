// Lines of name and value (query parameters, headers, an environment's variables): each can be switched off without
// being removed, and an empty line at the end is always there to type the next one into.

import type { Pair } from "../../server/types.ts";
import { Icon, t } from "./shared.tsx";

export function PairEditor({ pairs, onChange, switches = true }: { pairs: Pair[]; onChange: (pairs: Pair[]) => void; switches?: boolean }) {
  const rows = [...pairs, { name: "", value: "" }];
  const set = (i: number, p: Partial<Pair>) => {
    const next = rows.map((row, n) => (n === i ? { ...row, ...p } : row));
    // The empty line at the end is not part of the request until something is typed into it.
    onChange(next.filter((row, n) => n < pairs.length || row.name || row.value));
  };
  return (
    <>
      {rows.map((p, i) => {
        const last = i === pairs.length;
        return (
          <div key={i} className={`hc-pair${p.off ? " is-off" : ""}${switches ? "" : " is-plain"}`}>
            {switches && (last ? <span /> : <input type="checkbox" checked={!p.off} onChange={(e) => set(i, { off: !e.target.checked })} title={t("ui.pair.on")} aria-label={t("ui.pair.on")} />)}
            <input className="hc-input hc-mono" value={p.name} onChange={(e) => set(i, { name: e.target.value })} placeholder={t("ui.pair.name")} aria-label={t("ui.pair.name")} spellCheck={false} autoCapitalize="off" />
            <input className="hc-input hc-mono" value={p.value} onChange={(e) => set(i, { value: e.target.value })} placeholder={t("ui.pair.value")} aria-label={t("ui.pair.value")} spellCheck={false} autoCapitalize="off" />
            {last ? (
              <span />
            ) : (
              <button type="button" className="hc-icon" onClick={() => onChange(pairs.filter((_, n) => n !== i))} title={t("ui.remove")} aria-label={t("ui.remove")}>
                <Icon name="close" size={12} />
              </button>
            )}
          </div>
        );
      })}
    </>
  );
}
