// The hub's two trigger settings, at the bottom of the Triggers list and collapsed until wanted: whether watches and
// triggers' scripts may reach the local network, and how long a watch waits for its page. The chat sets them too
// (hub_settings_update; turning private addresses on shows the person a card there). Here, as on the Settings page
// they came from, a change applies when the person presses Save.

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, SlidersHorizontal } from "lucide-react";
import { api, errorText } from "../../lib/api";
import { settingsPatch, WATCH_TIMEOUT, type TriggerSettings as Values } from "../../lib/triggers";
import { hubEvents } from "../../state/app";
import { toast } from "../../state/toast";
import { t } from "../../i18n";
import { Button, ErrorNote, Field, Input, Loading, Toggle } from "../../components/ui";

export function TriggerSettings() {
  const [opened, setOpened] = useState(false);
  const [orig, setOrig] = useState<Values | null>(null);
  const [allow, setAllow] = useState(false);
  const [timeout, setTimeoutText] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const show = (v: Values) => {
    setOrig({ triggersAllowPrivateUrls: v.triggersAllowPrivateUrls, triggersWatchTimeoutSec: v.triggersWatchTimeoutSec });
    setAllow(v.triggersAllowPrivateUrls);
    setTimeoutText(String(v.triggersWatchTimeoutSec));
  };
  const load = useCallback(() => {
    setError(undefined);
    api.get<Values>("/api/settings").then(show, (e) => setError(errorText(e)));
  }, []);

  const pending = orig ? settingsPatch(orig, allow, timeout) : undefined;
  const changed = !!pending && ("error" in pending || Object.keys(pending.patch).length > 0);
  // An agent can change them from the chat: pick that up unless the person is in the middle of a change.
  const editing = useRef(false);
  editing.current = changed;
  useEffect(() => {
    if (!opened) return;
    load();
    return hubEvents.on((e) => {
      if (e.type === "settings.updated" && !editing.current) load();
    });
  }, [opened, load]);

  const save = async () => {
    if (!pending || "error" in pending) return;
    setBusy(true);
    try {
      show(await api.patch<Values>("/api/settings", pending.patch));
      toast(t("common.settingsSaved"), "success");
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="group mt-4 rounded-2xl border border-border bg-surface" onToggle={(e) => e.currentTarget.open && setOpened(true)}>
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-medium select-none hover:text-fg [&::-webkit-details-marker]:hidden">
        <SlidersHorizontal className="size-4 text-muted" aria-hidden />
        <span className="flex-1">{t("triggers.settings.title")}</span>
        <ChevronRight className="size-4 text-muted transition-transform group-open:rotate-90" aria-hidden />
      </summary>
      <div className="flex flex-col gap-4 border-t border-border px-4 py-4">
        {error && <ErrorNote onRetry={load}>{error}</ErrorNote>}
        {!orig && !error && <Loading />}
        {orig && (
          <>
            <div>
              <Toggle checked={allow} onChange={setAllow} label={<span className="font-medium">{t("triggers.settings.private")}</span>} />
              <div className="mt-1 pl-12 text-xs text-muted">{t("triggers.settings.privateHint")}</div>
            </div>
            <Field label={t("triggers.settings.timeout")} hint={t("triggers.settings.timeoutHint")} error={pending && "error" in pending ? pending.error : undefined} className="sm:max-w-xs">
              <Input type="number" min={WATCH_TIMEOUT.min} max={WATCH_TIMEOUT.max} value={timeout} onChange={(e) => setTimeoutText(e.target.value)} />
            </Field>
            {changed && (
              <div className="flex flex-wrap justify-end gap-2">
                <Button size="sm" disabled={busy} onClick={() => show(orig)}>
                  {t("common.cancel")}
                </Button>
                <Button size="sm" variant="primary" loading={busy} disabled={"error" in pending!} onClick={() => void save()}>
                  {t("common.save")}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </details>
  );
}
