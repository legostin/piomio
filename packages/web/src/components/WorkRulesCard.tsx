// The team's work rules in the settings: what the person said once to an agent about where work of some kind goes and
// how it thinks ("the Piomio project: on the MacBook, Opus, high effort"). A rule is made and changed in a chat (the
// agents' work_rule_set); here the rules are seen and dropped, and the buttons open that chat.

import { useEffect, useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import type { WorkRuleView } from "@piomio/shared";
import { api, errorText } from "../lib/api";
import { hubEvents } from "../state/app";
import { useAsk } from "../state/ask";
import { effortName } from "../state/thinking";
import { toast } from "../state/toast";
import { t } from "../i18n";
import { Button, Card, IconButton } from "./ui";

/** "MacBook · Claude Code · Opus · high effort": where the rule sends the work and how it thinks, for people. */
export function ruleWhere(r: WorkRuleView): string {
  return [r.machineName, r.agentName, r.brainLabel, r.modelName, r.effort ? t("thinking.effortOnly", { effort: effortName(r.effort) }) : ""].filter(Boolean).join(" · ");
}

export function WorkRulesCard() {
  const ask = useAsk();
  // null: not read yet, or a hub that has none to show (the demo): no card.
  const [rules, setRules] = useState<WorkRuleView[] | null>(null);
  const [busy, setBusy] = useState<string>();

  const load = () =>
    void api.get<WorkRuleView[]>("/api/work-rules").then(
      (r) => setRules(Array.isArray(r) ? r : null),
      () => setRules(null),
    );
  useEffect(() => {
    load();
    // An agent saved or dropped one in the chat next to this panel.
    return hubEvents.on((e) => {
      if (e.type === "settings.updated") load();
    });
  }, []);

  const remove = async (r: WorkRuleView) => {
    setBusy(r.id);
    try {
      await api.del(`/api/work-rules/${encodeURIComponent(r.id)}`);
      setRules((list) => list?.filter((x) => x.id !== r.id) ?? null);
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(undefined);
    }
  };

  if (!rules) return null;
  return (
    <Card
      title={t("rules.title")}
      actions={
        <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => ask(t("rules.askNew"))}>
          {t("rules.add")}
        </Button>
      }
    >
      <p className="text-sm text-muted">{t("rules.hint")}</p>
      {rules.length > 0 && (
        <ul className="mt-2 divide-y divide-hairline">
          {rules.map((r) => (
            <li key={r.id} className="flex items-start gap-1 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="break-words text-sm font-medium">{r.when}</div>
                <div className="break-words text-xs text-muted">{ruleWhere(r)}</div>
              </div>
              <IconButton label={t("common.edit")} onClick={() => ask(t("rules.askChange", { rule: r.when }))}>
                <Pencil className="size-4" />
              </IconButton>
              <IconButton label={t("common.remove")} disabled={busy === r.id} onClick={() => void remove(r)}>
                <Trash2 className="size-4" />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
