// Waking the person's devices when something reached them (a notifier delivery): phones through the push relay
// (packages/push-relay), the desktop app that runs this hub with a line on stdout.
//
// A phone's push carries nothing personal: the relay hears an opaque handle and the notification's id, Apple hears
// that there is a new message. The app's notification extension fetches the words from this hub
// (GET /api/devices/notifications/:id) and shows them; when it cannot reach the hub the push says "New message".

import type { Notification } from "@piomio/shared";
import { truncate } from "@piomio/shared";
import type { Db } from "./db.ts";
import type { EventBus } from "./bus.ts";
import { LocalizedError } from "./i18n.ts";

const TIMEOUT_MS = 10_000;
/** What the phone's banner shows of a long body; the chat has the rest. */
const PUSH_BODY_MAX = 600;

/** The desktop app reads the hub's stdout: a line starting with this is a notification for it, not log. */
export const DESKTOP_NOTIFY_PREFIX = "\u001epiomio-notify ";

export interface PushNote {
  id: string;
  kind: Notification["kind"];
  title: string;
  body: string;
  agentId?: string;
  agentName?: string;
  taskId?: string;
  /** Where the hub's UI shows it: "/agent/<id>" or "/tasks/<id>". */
  path: string;
}

/** A delivered notification as the person's device shows it. */
export function pushNote(n: Notification, recipient: string, agentName: (id: string) => string): PushNote {
  const agentId = n.agentId ?? recipient;
  return {
    id: n.id,
    kind: n.kind,
    title: n.title,
    body: truncate(n.body.trim(), PUSH_BODY_MAX),
    agentId,
    agentName: agentName(agentId),
    ...(n.taskId ? { taskId: n.taskId } : {}),
    path: n.taskId && n.kind !== "report" ? `/tasks/${n.taskId}` : `/agent/${encodeURIComponent(agentId)}`,
  };
}

/** The relay's API: register a phone's APNs token, push to its handle. */
export class PushRelay {
  url: string;
  private fetch: typeof fetch;
  constructor(url: string, fetchImpl: typeof fetch = fetch) {
    this.url = url.replace(/\/$/, "");
    this.fetch = fetchImpl;
  }

  private async post(path: string, body: unknown): Promise<{ status: number; body: any }> {
    const r = await this.fetch(`${this.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "Piomio hub" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }

  async register(token: string, environment: "production" | "sandbox"): Promise<string> {
    const r = await this.post("/v1/register", { token, environment });
    if (r.status !== 200 || typeof r.body?.handle !== "string") throw new Error(`relay answered ${r.status}`);
    return r.body.handle;
  }

  /** "gone": Apple says the app is no longer on that phone. */
  async push(handle: string, p: { id: string; kind: "message" | "approval"; badge?: number; silent?: boolean }): Promise<"ok" | "gone" | "failed"> {
    try {
      const r = await this.post("/v1/push", { handle, ...p });
      return r.status === 200 ? "ok" : r.status === 410 ? "gone" : "failed";
    } catch {
      return "failed";
    }
  }
}

export class DevicePushes {
  db: Db;
  bus: EventBus;
  relay?: PushRelay;
  constructor(d: { db: Db; bus: EventBus; relay?: PushRelay }) {
    this.db = d.db;
    this.bus = d.bus;
    this.relay = d.relay;
  }

  /** The phone gave its APNs token: the relay seals it, the hub keeps only the handle. */
  async register(deviceId: string, token: unknown, environment: unknown): Promise<void> {
    if (!this.relay) throw new LocalizedError("push.off", undefined, 409);
    const hex = typeof token === "string" ? token.trim().toLowerCase() : "";
    if (!/^[0-9a-f]{64,400}$/.test(hex)) throw new LocalizedError("push.badToken", undefined, 400);
    let handle: string;
    try {
      handle = await this.relay.register(hex, environment === "sandbox" ? "sandbox" : "production");
    } catch (e) {
      console.log(`[push] relay: ${(e as Error).message}`);
      throw new LocalizedError("push.relayDown", undefined, 502);
    }
    this.db.prepare("update devices set push_handle = ? where id = ? and revoked = 0").run(handle, deviceId);
    this.bus.emit("device.updated", { id: deviceId });
  }

  forget(deviceId: string): void {
    this.db.prepare("update devices set push_handle = null where id = ?").run(deviceId);
    this.bus.emit("device.updated", { id: deviceId });
  }

  /** Wakes every phone that turned pushes on. Never throws: a push that does not go out is not the person's problem. */
  async send(n: Pick<Notification, "id" | "kind">, o: { silent: boolean; badge: number }): Promise<void> {
    const relay = this.relay;
    if (!relay) return;
    const rows = this.db.prepare("select id, push_handle from devices where revoked = 0 and push_handle is not null").all() as Array<{ id: string; push_handle: string }>;
    await Promise.all(
      rows.map(async (r) => {
        const out = await relay.push(r.push_handle, { id: n.id, kind: n.kind === "approval" ? "approval" : "message", badge: o.badge, ...(o.silent ? { silent: true } : {}) });
        if (out === "gone") this.forget(r.id);
        else if (out === "failed") console.log(`[push] ${r.id}: not sent`);
      }),
    );
  }
}

/** The line the desktop app turns into a notification on this computer (src-tauri/src/notify.rs). */
export function desktopNotifyLine(note: PushNote, silent: boolean): string {
  return `${DESKTOP_NOTIFY_PREFIX}${JSON.stringify({ id: note.id, title: note.title, body: note.body, agent: note.agentName, path: note.path, silent })}\n`;
}
