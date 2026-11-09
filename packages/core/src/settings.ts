import { DEFAULT_LOCALE, localeFromEnv, type Locale } from "@piomio/shared";
import { json, type Db } from "./db.ts";
import { DEFAULT_TRANSCRIPTION, type TranscriptionSettings } from "./transcribe.ts";
import { DEFAULT_VOICE_SETTINGS, type VoiceSettings } from "./speech/settings.ts";

export interface CoreSettings {
  timezone: string;
  defaultAgent: string;
  quietHours: { enabled: boolean; start: string; end: string };
  digestTimes: string[];
  /** Max proactive "notify" deliveries per trigger per hour. */
  notifyRatePerHour: number;
  /** Extra egress hosts allowed for brains. */
  brainEgressAllow: string[];
  /** Hosts plugins and brains may reach even though they resolve to private/LAN addresses (e.g. "searxng", "nas.local"). */
  egressPrivateAllow: string[];
  /** Show approval details (full input) in channels like Telegram. */
  channelApprovalDetails: boolean;
  /** The default agent's replies to messages typed in the web UI also go to the channels (Telegram). */
  channelMirror: boolean;
  /** Concurrent sessions per brain@machine. */
  brainConcurrency: number;
  approvalInlineWaitSec: number;
  approvalExpireHours: number;
  /**
   * Who answers what used to be an approval card (policy/auto.ts): "auto", a reviewer model, the person only for money,
   * messages, publishing and what the reviewer hands them; "ask", the person every time.
   */
  approvalMode: "auto" | "ask";
  /** Hub language: notifications, channels, approval cards and the default for the UI. */
  language: Locale;
  /** Access from anywhere: the hub runs its Tailscale node and the Funnel link (remote.ts). */
  remoteAccess: boolean;
  /** Speech to text for voice messages (transcribe.ts). */
  transcription: TranscriptionSettings;
  /** The local engine's voice and speed (speech/): unset, the hub language's default voice at normal speed. */
  voice: VoiceSettings;
  /** Watch triggers and triggers' scripts may reach addresses on the local network (signals/watch.ts, signals/pio.ts). */
  triggersAllowPrivateUrls: boolean;
  /** How long a watch trigger waits for its page, in seconds (TRIGGERS_WATCH_TIMEOUT). */
  triggersWatchTimeoutSec: number;
}

/** The range of triggersWatchTimeoutSec, in seconds. */
export const TRIGGERS_WATCH_TIMEOUT = { min: 1, max: 120 } as const;

/** What is wrong with the trigger settings in a patch: the catalog key of the reason and its params; undefined when nothing is. */
export function triggerSettingsProblem(p: Record<string, unknown>): { key: string; params?: Record<string, number> } | undefined {
  if ("triggersAllowPrivateUrls" in p && typeof p.triggersAllowPrivateUrls !== "boolean") return { key: "settings.badTriggersAllowPrivate" };
  if ("triggersWatchTimeoutSec" in p) {
    const n = p.triggersWatchTimeoutSec;
    const { min, max } = TRIGGERS_WATCH_TIMEOUT;
    if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) return { key: "settings.badTriggersWatchTimeout", params: { min, max } };
  }
  return undefined;
}

/** The brains' CLIs themselves: their sign-in and model APIs. Never asked about, even after outside content (egress.ts). */
export const BRAIN_MODEL_EGRESS = [
  "*.anthropic.com",
  "claude.ai",
  "*.claude.ai",
  "*.claude.com",
  "claude.com",
  "*.openai.com",
  "openai.com",
  "chatgpt.com",
  "*.chatgpt.com",
  // Kimi Code: its sign-in (auth.kimi.com/.ai) and its plan's API (api.kimi.com/.ai).
  "kimi.com",
  "*.kimi.com",
  "kimi.ai",
  "*.kimi.ai",
];

export const DEFAULT_BRAIN_EGRESS = [
  ...BRAIN_MODEL_EGRESS,
  "*.googleapis.com",
  "openrouter.ai",
  "registry.npmjs.org",
  "*.npmjs.org",
  "pypi.org",
  "files.pythonhosted.org",
  "github.com",
  "*.github.com",
  "*.githubusercontent.com",
  "*.sentry.io",
  "statsig.com",
  "*.statsig.com",
];

export function defaultSettings(timezone: string, language: Locale = localeFromEnv(process.env) ?? DEFAULT_LOCALE): CoreSettings {
  return {
    timezone,
    defaultAgent: "assistant",
    quietHours: { enabled: true, start: "23:00", end: "08:00" },
    digestTimes: ["09:00", "19:00"],
    notifyRatePerHour: 4,
    brainEgressAllow: [],
    egressPrivateAllow: [],
    channelApprovalDetails: false,
    channelMirror: true,
    brainConcurrency: 2,
    approvalInlineWaitSec: 45,
    approvalExpireHours: 24,
    approvalMode: "auto",
    language,
    remoteAccess: false,
    transcription: DEFAULT_TRANSCRIPTION,
    voice: DEFAULT_VOICE_SETTINGS,
    triggersAllowPrivateUrls: false,
    triggersWatchTimeoutSec: 30,
  };
}

export class Settings {
  db: Db;
  defaults: CoreSettings;
  /** `defaults`: what this kind of install starts with (a server's hub: access from anywhere on). */
  constructor(db: Db, timezone: string, defaults: Partial<CoreSettings> = {}) {
    this.db = db;
    this.defaults = { ...defaultSettings(timezone), ...defaults };
  }

  get(): CoreSettings {
    const row = this.db.prepare("select value from settings where key = 'core'").get() as { value: string } | undefined;
    return { ...this.defaults, ...json<Partial<CoreSettings>>(row?.value, {}) };
  }

  update(patch: Partial<CoreSettings>): CoreSettings {
    const next = { ...this.get(), ...patch };
    this.db.prepare("insert into settings(key, value) values ('core', ?) on conflict(key) do update set value = excluded.value").run(JSON.stringify(next));
    return next;
  }

  getKey<T>(key: string, fallback: T): T {
    const row = this.db.prepare("select value from settings where key = ?").get(key) as { value: string } | undefined;
    return json<T>(row?.value, fallback);
  }

  setKey(key: string, value: unknown): void {
    this.db.prepare("insert into settings(key, value) values (?, ?) on conflict(key) do update set value = excluded.value").run(key, JSON.stringify(value));
  }
}
