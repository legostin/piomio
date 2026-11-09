// Core settings (GET/PATCH /api/settings) plus settings sections contributed by UI plugins.

import { useEffect, useMemo, useRef, useState } from "react";
import { Download, ExternalLink, LogOut, Power, RotateCcw, Save } from "lucide-react";
import type { Locale, SpeechStatus, VoiceInfo } from "@piomio/shared";
import { LOCALE_NAMES } from "@piomio/shared/i18n";
import { api, errorText } from "../lib/api";
import { fileSize } from "../lib/format";
import { desktopAction, desktopApp } from "../lib/desktop";
import { useStore } from "../lib/store";
import { agents, ensureAgents, hubEvents, logout, refreshBootstrap, session } from "../state/app";
import { toast } from "../state/toast";
import { openPanelItem } from "../state/panel";
import { explicitLocale, locale, LOCALES, t, type MessageKey } from "../i18n";
import { usePluginRegistry } from "../plugins/slots";
import { PluginSetupCard } from "../components/SecretCards";
import { BrowserLanguageSelect } from "../components/LanguageSelect";
import { Button, Card, ErrorNote, Field, Input, Loading, Page, Select, TagInput, Toggle } from "../components/ui";

/** What the page reads of GET /api/settings (the demo hub answers it with a new hub's values, demo/hub/routes.ts). */
export interface CoreSettings {
  timezone: string;
  defaultAgent: string;
  quietHours: { enabled: boolean; start: string; end: string };
  digestTimes: string[];
  notifyRatePerHour: number;
  brainEgressAllow: string[];
  brainEgressBuiltIn?: string[];
  channelApprovalDetails: boolean;
  brainConcurrency: number;
  approvalInlineWaitSec: number;
  approvalExpireHours: number;
  /** Hub language: notifications, channels, approval cards, agent replies; the UI default. */
  language: Locale;
  /** Speech to text for voice messages. */
  transcription: Transcription;
  /** The local engine's voice for reading aloud, and its speed. */
  voice: { voice?: string; speed?: number };
}

interface Transcription {
  provider: "auto" | "openai" | "groq" | "custom" | "local" | "off";
  model?: string;
  baseUrl?: string;
  keyRef?: string;
}

const VOICE_PROVIDERS: Array<{ id: Transcription["provider"]; label: MessageKey }> = [
  { id: "auto", label: "settings.voice.auto" },
  { id: "local", label: "settings.voice.local" },
  { id: "groq", label: "settings.voice.groq" },
  { id: "openai", label: "settings.voice.openai" },
  { id: "custom", label: "settings.voice.custom" },
  { id: "off", label: "settings.voice.off" },
];

type NumKey = "notifyRatePerHour" | "brainConcurrency" | "approvalInlineWaitSec" | "approvalExpireHours";

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Keys whose JSON differs between two settings objects. */
export function changedKeys(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  return Object.keys(b).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}

export function SettingsPage() {
  const s = useStore(session);
  const agentList = useStore(agents);
  const { settings: sections } = usePluginRegistry();
  const [orig, setOrig] = useState<CoreSettings | null>(null);
  const [form, setForm] = useState<CoreSettings | null>(null);
  const [nums, setNums] = useState<Record<NumKey, string>>({ notifyRatePerHour: "", brainConcurrency: "", approvalInlineWaitSec: "", approvalExpireHours: "" });
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [voiceEngine, setVoiceEngine] = useState<{ label: string; model: string } | null>();
  const [speech, setSpeech] = useState<SpeechStatus | null>(null);

  const loadVoiceEngine = () =>
    void api.get<{ engine: { label: string; model: string } | null }>("/api/transcription").then(
      (x) => setVoiceEngine(x.engine),
      () => setVoiceEngine(undefined),
    );
  const loadSpeech = () =>
    void api.get<SpeechStatus>("/api/speech").then(
      (x) => setSpeech(x),
      () => setSpeech(null),
    );
  const load = async () => {
    setError(undefined);
    try {
      const r = await api.get<CoreSettings>("/api/settings");
      setOrig(r);
      setForm(r);
      loadVoiceEngine();
      loadSpeech();
      setNums({
        notifyRatePerHour: String(r.notifyRatePerHour),
        brainConcurrency: String(r.brainConcurrency),
        approvalInlineWaitSec: String(r.approvalInlineWaitSec),
        approvalExpireHours: String(r.approvalExpireHours),
      });
    } catch (e) {
      setError(errorText(e));
    }
  };
  // The assistant can change settings from chat: pick that up unless the user is in the middle of editing.
  const dirty = useRef(false);
  dirty.current = !!form && !!orig && changedKeys(orig as unknown as Record<string, unknown>, form as unknown as Record<string, unknown>).length > 0;
  useEffect(() => {
    void load();
    ensureAgents();
    return hubEvents.on((e) => {
      if (e.type === "settings.updated" && !dirty.current) void load();
      if (e.type === "speech.status") {
        // While a download runs only its progress changes; after it, the texts are read again in this page's language.
        if (e.status.downloading) setSpeech((s) => (s ? { ...s, runtime: e.status.runtime, downloading: e.status.downloading, error: undefined } : s));
        else {
          loadSpeech();
          loadVoiceEngine();
        }
      }
    });
  }, []);

  const zones = useMemo(() => {
    try {
      return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
    } catch {
      return [];
    }
  }, []);

  if (error && !form)
    return (
      <Page title={t("nav.settings")}>
        <ErrorNote onRetry={() => void load()}>{error}</ErrorNote>
      </Page>
    );
  if (!form || !orig)
    return (
      <Page title={t("nav.settings")}>
        <Loading />
      </Page>
    );

  const set = <K extends keyof CoreSettings>(k: K, v: CoreSettings[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));
  const app = desktopApp();

  const build = (): { next?: CoreSettings; error?: string } => {
    const next: CoreSettings = { ...form };
    const limits: Record<NumKey, [number, number, MessageKey]> = {
      notifyRatePerHour: [0, 100, "settings.notifyRate"],
      brainConcurrency: [1, 16, "settings.brainConcurrencyName"],
      approvalInlineWaitSec: [0, 600, "settings.approvalWaitName"],
      approvalExpireHours: [1, 24 * 30, "settings.approvalExpireName"],
    };
    for (const k of Object.keys(limits) as NumKey[]) {
      const n = Number(nums[k]);
      const [min, max, label] = limits[k];
      if (!Number.isInteger(n) || n < min || n > max) return { error: t("settings.error.integer", { field: t(label), min, max }) };
      next[k] = n;
    }
    if (!TIME_RE.test(next.quietHours.start) || !TIME_RE.test(next.quietHours.end)) return { error: t("settings.error.quietHours") };
    const badTime = next.digestTimes.find((x) => !TIME_RE.test(x));
    if (badTime) return { error: t("settings.error.digestTime", { value: badTime }) };
    if (zones.length && !zones.includes(next.timezone) && next.timezone !== "UTC") return { error: t("settings.error.timezone", { value: next.timezone }) };
    if (next.transcription.provider === "custom" && (!next.transcription.baseUrl?.trim() || !next.transcription.model?.trim())) return { error: t("settings.error.voiceServer") };
    return { next };
  };

  const pending = build();
  const changed = pending.next ? changedKeys(orig as unknown as Record<string, unknown>, pending.next as unknown as Record<string, unknown>) : [];

  const save = async () => {
    const r = build();
    if (!r.next) return toast(r.error ?? t("settings.error.checkFields"), "error");
    const patch = Object.fromEntries(changedKeys(orig as unknown as Record<string, unknown>, r.next as unknown as Record<string, unknown>).map((k) => [k, (r.next as unknown as Record<string, unknown>)[k]]));
    if (!Object.keys(patch).length) return;
    setBusy(true);
    try {
      const saved = await api.patch<CoreSettings>("/api/settings", patch);
      // This browser follows the hub language: show the interface in the new one.
      if ("language" in patch && !explicitLocale() && saved.language !== locale) return location.reload();
      setOrig(saved);
      setForm(saved);
      if ("transcription" in patch) loadVoiceEngine();
      toast(t("common.settingsSaved"), "success");
      void refreshBootstrap();
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const saveBar = (
    <Button variant="primary" icon={<Save className="size-4" />} onClick={() => void save()} disabled={!changed.length} loading={busy}>
      {t("common.save")}
    </Button>
  );

  const hubLocales = s?.locales?.length ? s.locales : LOCALES;

  return (
    <Page title={t("nav.settings")} actions={saveBar}>
      <div className="flex flex-col gap-4">
        <Card title={t("settings.general")}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("settings.timezone")} hint={t("settings.timezoneHint")}>
              <Input list="tz-list" value={form.timezone} onChange={(e) => set("timezone", e.target.value)} />
              <datalist id="tz-list">
                {zones.map((z) => (
                  <option key={z} value={z} />
                ))}
              </datalist>
            </Field>
            <Field label={t("settings.defaultAgent")} hint={t("settings.defaultAgentHint")}>
              <Select value={form.defaultAgent} onChange={(e) => set("defaultAgent", e.target.value)}>
                {!(agentList ?? []).some((a) => a.id === form.defaultAgent) && <option value={form.defaultAgent}>{form.defaultAgent}</option>}
                {/* An archived agent cannot be the default. */}
                {(agentList ?? []).filter((a) => !a.archived || a.id === form.defaultAgent).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </Card>

        <Card title={t("settings.language.title")}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("settings.language.browser")} hint={t("settings.language.browserHint")}>
              <BrowserLanguageSelect hubLanguage={orig.language} />
            </Field>
            <Field label={t("settings.language.hub")} hint={t("settings.language.hubHint")}>
              <Select value={form.language} onChange={(e) => set("language", e.target.value as Locale)}>
                {!hubLocales.includes(form.language) && <option value={form.language}>{form.language}</option>}
                {hubLocales.map((l) => (
                  <option key={l} value={l}>
                    {LOCALE_NAMES[l] ?? l}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </Card>

        <Card title={t("settings.notifications")}>
          <div className="flex flex-col gap-4">
            <div>
              <Toggle checked={form.quietHours.enabled} onChange={(v) => set("quietHours", { ...form.quietHours, enabled: v })} label={<span className="font-medium">{t("settings.quietHours")}</span>} />
              <div className="mt-1 pl-12 text-xs text-muted">{t("settings.quietHoursHint")}</div>
              {form.quietHours.enabled && (
                <div className="mt-3 flex flex-wrap items-center gap-2 pl-12 text-sm">
                  {t("settings.quietFrom")}
                  <Input type="time" value={form.quietHours.start} onChange={(e) => set("quietHours", { ...form.quietHours, start: e.target.value })} className="w-32" aria-label={t("settings.quietStart")} />
                  {t("settings.quietTo")}
                  <Input type="time" value={form.quietHours.end} onChange={(e) => set("quietHours", { ...form.quietHours, end: e.target.value })} className="w-32" aria-label={t("settings.quietEnd")} />
                </div>
              )}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field group label={t("settings.digestTimes")} hint={t("settings.digestTimesHint")}>
                <TagInput value={form.digestTimes} onChange={(v) => set("digestTimes", v)} placeholder="09:00" />
              </Field>
              <Field label={t("settings.notifyRate")} hint={t("settings.notifyRateHint")}>
                <Input type="number" min={0} value={nums.notifyRatePerHour} onChange={(e) => setNums((n) => ({ ...n, notifyRatePerHour: e.target.value }))} />
              </Field>
            </div>
          </div>
        </Card>

        <Card title={t("settings.approvals")}>
          <div className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("settings.approvalWait")} hint={t("settings.approvalWaitHint")}>
                <Input type="number" min={0} value={nums.approvalInlineWaitSec} onChange={(e) => setNums((n) => ({ ...n, approvalInlineWaitSec: e.target.value }))} />
              </Field>
              <Field label={t("settings.approvalExpire")} hint={t("settings.approvalExpireHint")}>
                <Input type="number" min={1} value={nums.approvalExpireHours} onChange={(e) => setNums((n) => ({ ...n, approvalExpireHours: e.target.value }))} />
              </Field>
            </div>
            <div>
              <Toggle checked={form.channelApprovalDetails} onChange={(v) => set("channelApprovalDetails", v)} label={<span className="font-medium">{t("settings.approvalDetails")}</span>} />
              <div className="mt-1 pl-12 text-xs text-muted">{t("settings.approvalDetailsHint")}</div>
            </div>
          </div>
        </Card>

        <Card title={t("settings.brains")}>
          <div className="flex flex-col gap-4">
            <Field label={t("settings.brainConcurrency")} hint={t("settings.brainConcurrencyHint")} className="sm:max-w-xs">
              <Input type="number" min={1} value={nums.brainConcurrency} onChange={(e) => setNums((n) => ({ ...n, brainConcurrency: e.target.value }))} />
            </Field>
            <Field group label={t("settings.egress")} hint={t("settings.egressHint")}>
              <details className="mb-3 text-xs text-muted">
                <summary className="cursor-pointer">{t("settings.egressBuiltIn")}</summary>
                <div className="mt-2 break-words font-mono">{form.brainEgressBuiltIn?.join(", ")}</div>
              </details>
              <TagInput value={form.brainEgressAllow} onChange={(v) => set("brainEgressAllow", v)} placeholder="api.example.com" />
            </Field>
          </div>
        </Card>

        <Card title={t("settings.voice.title")}>
          <p className="mb-3 text-sm text-muted">{t("settings.voice.hint")}</p>
          <div className="mb-3"><Button onClick={() => openPanelItem("plugins", "voice-providers")}>{t("settings.voice.providers")}</Button></div>
          {speech?.transcriptionManaged && <p className="mb-3 text-sm text-muted">{t("settings.voice.cloudManaged")}</p>}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("settings.voice.provider")} hint={voiceEngine ? t("settings.voice.now", { engine: `${voiceEngine.label} · ${voiceEngine.model}` }) : voiceEngine === null ? t("settings.voice.none") : undefined}>
              <Select disabled={!!speech?.transcriptionManaged} value={form.transcription.provider} onChange={(e) => set("transcription", { provider: e.target.value as Transcription["provider"] })}>
                {VOICE_PROVIDERS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {t(p.label)}
                  </option>
                ))}
              </Select>
            </Field>
            {form.transcription.provider !== "off" && form.transcription.provider !== "auto" && form.transcription.provider !== "local" && (
              <Field label={t("settings.voice.model")} hint={form.transcription.provider === "custom" ? undefined : t("settings.voice.modelHint")}>
                <Input value={form.transcription.model ?? ""} onChange={(e) => set("transcription", { ...form.transcription, model: e.target.value })} placeholder={form.transcription.provider === "groq" ? "whisper-large-v3-turbo" : form.transcription.provider === "openai" ? "gpt-4o-mini-transcribe" : "Systran/faster-whisper-small"} />
              </Field>
            )}
            {form.transcription.provider === "custom" && (
              <>
                <Field label={t("settings.voice.baseUrl")} hint={t("settings.voice.baseUrlHint")}>
                  <Input value={form.transcription.baseUrl ?? ""} onChange={(e) => set("transcription", { ...form.transcription, baseUrl: e.target.value })} placeholder="http://127.0.0.1:8000/v1" />
                </Field>
                <Field label={t("settings.voice.keyRef")} hint={t("settings.voice.keyRefHint")}>
                  <Input value={form.transcription.keyRef ?? ""} onChange={(e) => set("transcription", { ...form.transcription, keyRef: e.target.value })} placeholder="vault://my_stt_key" />
                </Field>
              </>
            )}
          </div>
          {speech && <LocalSpeech speech={speech} provider={form.transcription.provider} value={form.voice ?? {}} onChange={(v) => set("voice", v)} onStatus={setSpeech} />}
        </Card>

        {pending.error && <ErrorNote>{pending.error}</ErrorNote>}

        {/* One card per plugin: its secrets (typed in place, straight into the vault) and its own sections. */}
        {sections
          .filter((sec, i) => sections.findIndex((x) => x.pluginId === sec.pluginId) === i)
          .map((sec) => (
            <Card key={sec.key} title={sec.title}>
              <PluginSetupCard pluginId={sec.pluginId} bare />
            </Card>
          ))}

        <Card title={t("settings.security")}>
          <p className="mb-3 text-sm text-muted">{t("settings.securityText")}</p>
          <div className="flex flex-wrap gap-2">
            {s && (
              <a
                href={s.consoleUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-border bg-surface px-4 text-sm font-medium hover:bg-surface-2"
              >
                {t("common.openConsole")} <ExternalLink className="size-4" />
              </a>
            )}
            <Button icon={<LogOut className="size-4" />} onClick={() => void logout()}>
              {t("common.logout")}
            </Button>
          </div>
        </Card>

        {app && (
          <Card title={t("settings.app.title")}>
            <p className="mb-3 text-sm text-muted">{t("settings.app.text")}</p>
            <div className="flex flex-wrap gap-2">
              <Button icon={<Power className="size-4" />} onClick={() => desktopAction(app, "quit")}>
                {t("settings.app.quit")}
              </Button>
              <Button variant="danger" icon={<RotateCcw className="size-4" />} onClick={() => desktopAction(app, "reset")}>
                {t("settings.app.reset")}
              </Button>
            </div>
          </Card>
        )}

        <div className="flex justify-end pb-4">{saveBar}</div>
      </div>
    </Page>
  );
}

const SPEEDS = [0.75, 1, 1.25, 1.5];

/**
 * The hub's local speech engine: local speech-to-text when it is the provider, and the voice answers are read aloud
 * with. Downloads start at once (Install) and show their progress; the voice and speed are saved with the page.
 */
function LocalSpeech({
  speech,
  provider,
  value,
  onChange,
  onStatus,
}: {
  speech: SpeechStatus;
  provider: Transcription["provider"];
  value: CoreSettings["voice"];
  onChange: (v: CoreSettings["voice"]) => void;
  onStatus: (s: SpeechStatus) => void;
}) {
  const [asked, setAsked] = useState<{ voice?: string; stt?: boolean }>();
  const install = async (body: { voice?: string; stt?: boolean }) => {
    setAsked(body);
    try {
      onStatus(await api.post<SpeechStatus>("/api/speech/install", body));
    } catch (e) {
      toast(errorText(e), "error");
    }
  };
  const voiceId = value.voice ?? speech.voice;
  const voice = speech.voices.find((v) => v.id === voiceId);
  const speed = value.speed ?? speech.speed;
  const busy = !!speech.downloading;
  const stt = speech.stt.local;
  const itemName = (item: string) => (item === "runtime" ? t("settings.voice.item.runtime") : (speech.voices.find((v) => v.id === item)?.name ?? t("settings.voice.item.stt")));
  const d = speech.downloading;
  const percent = d && d.total ? Math.min(100, Math.round((d.received / d.total) * 100)) : 0;
  const optionText = (v: VoiceInfo) => [v.name, LOCALE_NAMES[v.lang as Locale] ?? v.lang, v.installed ? t("settings.voice.installed") : fileSize(v.size)].join(" · ");

  return (
    <div className="mt-4 flex flex-col gap-3 border-t border-hairline pt-4">
      {provider === "local" && !stt.installed && d?.item !== stt.model && (
        <InstallRow text={t("settings.voice.localMissing", { size: fileSize(stt.size) })} disabled={busy} onInstall={() => void install({ stt: true })} />
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("settings.voice.speaker")} hint={voice && voice.license !== "CC0" ? (voice.license === "unknown" ? t("settings.voice.licenseUnknown") : t("settings.voice.license", { license: voice.license })) : t("settings.voice.speakerHint")}>
          <Select value={voiceId} onChange={(e) => onChange({ ...value, voice: e.target.value })}>
            {speech.voices.map((v) => (
              <option key={v.id} value={v.id}>
                {optionText(v)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("settings.voice.speed")}>
          <Select value={String(speed)} onChange={(e) => onChange({ ...value, speed: Number(e.target.value) })}>
            {[...new Set([...SPEEDS, speed])]
              .sort((a, b) => a - b)
              .map((n) => (
                <option key={n} value={String(n)}>
                  {t("settings.voice.speedValue", { n })}
                </option>
              ))}
          </Select>
        </Field>
      </div>
      {voice && (!voice.installed || speech.runtime !== "ready") && d?.item !== voice.id && (
        <InstallRow
          text={speech.runtime === "ready" ? t("settings.voice.speakerMissing", { size: fileSize(voice.size) }) : t("settings.voice.engineMissing", { size: fileSize(voice.size) })}
          disabled={busy}
          onInstall={() => void install({ voice: voice.id })}
        />
      )}
      {d && (
        <div className="flex flex-col gap-1.5" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label={itemName(d.item)}>
          <span className="text-xs text-muted">{t("settings.voice.downloading", { item: itemName(d.item), done: fileSize(d.received), total: fileSize(d.total) })}</span>
          <span className="h-1 overflow-hidden rounded-full bg-border">
            <span className="block h-full rounded-full bg-accent transition-[width] duration-200 ease-out" style={{ width: `${Math.max(3, percent)}%` }} />
          </span>
        </div>
      )}
      {speech.error && !d && <ErrorNote onRetry={asked ? () => void install(asked) : undefined}>{speech.error}</ErrorNote>}
    </div>
  );
}

function InstallRow({ text, disabled, onInstall }: { text: string; disabled: boolean; onInstall: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <span className="min-w-0 flex-1 text-muted">{text}</span>
      <Button size="sm" icon={<Download className="size-4" />} onClick={onInstall} disabled={disabled}>
        {t("settings.voice.install")}
      </Button>
    </div>
  );
}
