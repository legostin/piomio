// The `pio` a trigger's script reaches during one run: sandbox.ts calls this HostCall for every pio.* but log and now.
// Its agent's hub tools that only read (ToolGateway.callRead), fetches to the trigger's own hosts through the egress
// proxy, the quick model, the trigger's state and its notes. Outside content (a source tool's result, a fetch, an
// external note) marks the run external: its note shows no text and its wake task is tainted. When the run ends its pio
// is closed: what the script started and never awaited is waited for (fetches are cut off), then the run's egress token
// and connections go.

import type { ToolResult } from "@piomio/shared";
import { hostMatches } from "@piomio/shared";
import type { QuickModel } from "../bare-ask.ts";
import type { ToolGateway, TriggerCaller } from "../tools/gateway.ts";
import type { FetchLike } from "./host.ts";
import { truncateBytes } from "./prompt.ts";
import type { HostCall } from "./sandbox.ts";
import { formatLocal } from "./schedule.ts";
import type { TriggerStore } from "./store.ts";
import { firstJsonObject } from "./triage.ts";
import type { Trigger } from "./types.ts";
import { assertFetchable } from "./watch.ts";

export const TOOL_TEXT_MAX = 100 * 1024;
export const FETCH_MAX_BYTES = 5 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;
const NOTES_MAX = 20;
const NOTES_DEFAULT = 5;
const KEY_MAX = 200;
/** How long close() waits for calls still out by default: as long as a whole run may take. */
const CLOSE_WAIT_MS = 30_000;
/** Headers a script does not set: the connection's own, and the proxy's (its token is the run's). */
const CONNECTION_HEADERS = new Set(["host", "connection", "keep-alive", "proxy-authorization", "proxy-connection", "transfer-encoding", "content-length", "te", "trailer", "upgrade"]);
const ENDED = "the script's run has ended";

export interface PioDeps {
  trigger: Trigger;
  /** The person's timezone, for pio.now(). */
  tz: string;
  now: () => Date;
  /** A hub tool called for the trigger's agent (gatewayReads: ToolGateway.callRead); `source`: what came back is outside content. */
  callRead: (name: string, input: unknown) => Promise<{ result: ToolResult; source: boolean }>;
  /** proxiedGet with the run's own egress token, whose allowlist is the trigger's hosts. */
  fetch: FetchLike;
  /** The person allowed private network addresses (the Triggers card's allowPrivateUrls). */
  allowPrivate: boolean;
  quick: QuickModel;
  /** Takes one quick-model check from the day's triagePerDay; false when none is left. */
  triageBudget: () => boolean;
  store: TriggerStore;
  /** Lets the run's egress token and connections go; close() calls it once nothing is in flight. */
  release?: () => void;
  /** How long close() waits for calls still out (default 30 s). */
  closeWaitMs?: number;
}

/** pio.now() in the script: the instant, the person's wall-clock time and their timezone. */
export interface PioNow {
  iso: string;
  local: string;
  timezone: string;
}

export interface PioRun {
  host: HostCall;
  /** Outside content reached the run: a source tool's result, a fetch, an external note. */
  external: () => boolean;
  /** The quick model's tokens in this run: an estimate (characters / 4), its CLIs report none. */
  tokens: () => number;
  /** What the script's input carries as `now` (sandbox-worker.ts's prelude gives it to pio.now()). */
  now: () => PioNow;
  /** The run is over: later calls reject; calls still out are waited for (fetches cut off), then `release`. */
  close(): Promise<void>;
}

/** PioDeps.callRead through the gateway for one trigger: outside content is what the gateway marked (_meta.taint). */
export function gatewayReads(gateway: Pick<ToolGateway, "callRead">, as: TriggerCaller): PioDeps["callRead"] {
  return async (name, input) => {
    const result = await gateway.callRead(as, name, input);
    return { result, source: !!result._meta?.taint };
  };
}

export function pioFor(d: PioDeps): PioRun {
  const id = d.trigger.id;
  const hosts = d.trigger.script?.hosts ?? [];
  const ended = new AbortController();
  const inflight = new Set<Promise<unknown>>();
  let external = false;
  let tokens = 0;
  let toolsOut = 0;
  let closed = false;
  let closing: Promise<void> | undefined;

  async function toolsCall(name: unknown, input: unknown): Promise<{ text: string; isError: boolean; truncated?: true }> {
    if (typeof name !== "string" || !name) throw new Error("pio.tools.call(name, input): name is the tool's name");
    if (input !== undefined && input !== null && (typeof input !== "object" || Array.isArray(input))) {
      throw new Error("pio.tools.call(name, input): input is an object of the tool's parameters");
    }
    toolsOut++;
    try {
      const { result, source } = await d.callRead(name, input ?? {});
      if (source) external = true;
      const joined = result.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n");
      // Refused (not the agent's, not a read, not allowed): the script called what it may not.
      if (result._meta?.status === "denied") throw new Error(joined || `${name} was refused`);
      const { text, truncated } = truncateBytes(joined, TOOL_TEXT_MAX);
      return { text, isError: !!result.isError, ...(truncated ? { truncated: true as const } : {}) };
    } finally {
      toolsOut--;
    }
  }

  /** The address, if a script may fetch it: http(s), no credentials in it, its host on the trigger's list. */
  function listed(url: string): URL {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new Error(`pio.fetch: ${url} is not a web address`);
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("pio.fetch: only http and https addresses");
    if (u.username || u.password) throw new Error("pio.fetch: no user name or password in the address; send them in a header");
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (!hosts.some((p) => hostMatches(host, p))) throw new Error(`host ${host} is not on this trigger's list`);
    return u;
  }

  async function fetchVia(url: unknown, opts: unknown): Promise<Record<string, unknown>> {
    if (typeof url !== "string") throw new Error("pio.fetch(url, options): url is the address to fetch, as text");
    const o = options(opts, "pio.fetch");
    let method = (typeof o.method === "string" ? o.method : "GET").toUpperCase();
    if (method !== "GET" && method !== "POST") throw new Error("pio.fetch: the method is GET or POST");
    const headers = headersOf(o.headers);
    let body: string | undefined;
    if (o.body !== undefined && o.body !== null) {
      if (method !== "POST") throw new Error("pio.fetch: a GET has no body; send one with method POST");
      if (typeof o.body === "string") body = o.body;
      else {
        body = JSON.stringify(o.body);
        headers["content-type"] ??= "application/json";
      }
    }
    headers["user-agent"] ??= "piomio-triggers/0.1 (+script)";
    let current = listed(url);
    await assertFetchable(current.href, d.allowPrivate);

    // What comes back is outside content, whatever it is.
    external = true;
    const cut = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      cut.abort(new Error("timeout"));
    }, FETCH_TIMEOUT_MS);
    const stop = () => cut.abort(new Error(ENDED));
    ended.signal.addEventListener("abort", stop, { once: true });
    if (ended.signal.aborted) stop();
    const failed = (e: any, where: string) => {
      if (timedOut) return new Error(`pio.fetch: ${where} did not answer within ${FETCH_TIMEOUT_MS / 1000} s`);
      if (ended.signal.aborted) return new Error(ENDED);
      return new Error(`pio.fetch: could not load ${where}: ${e?.cause?.code ?? e?.message ?? e}`);
    };
    try {
      for (let hop = 0; ; hop++) {
        // The run may have ended while the address was checked.
        if (cut.signal.aborted) throw failed(cut.signal.reason, current.href);
        let res: Response;
        try {
          res = await d.fetch(current.href, { method, headers, ...(body !== undefined ? { body } : {}), redirect: "manual", signal: cut.signal });
        } catch (e) {
          throw failed(e, current.href);
        }
        const location = res.headers.get("location");
        if (res.status >= 300 && res.status < 400 && location) {
          await res.body?.cancel().catch(() => {});
          if (hop >= MAX_REDIRECTS) throw new Error(`pio.fetch: too many redirects from ${url}`);
          // Every hop is held to the list and the private-network rule, as the first one was.
          const next = listed(new URL(location, current).href);
          await assertFetchable(next.href, d.allowPrivate);
          if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
            method = "GET";
            body = undefined;
            delete headers["content-type"];
          }
          // As fetch does: credentials stay with the origin they were sent to.
          if (next.origin !== current.origin) {
            delete headers.authorization;
            delete headers.cookie;
          }
          current = next;
          continue;
        }
        let read: { text: string; truncated: boolean };
        try {
          read = await readCapped(res, FETCH_MAX_BYTES);
        } catch (e) {
          throw failed(e, current.href);
        }
        return { status: res.status, url: current.href, headers: Object.fromEntries(res.headers), text: read.text, ...(read.truncated ? { truncated: true } : {}) };
      }
    } finally {
      clearTimeout(timer);
      ended.signal.removeEventListener("abort", stop);
    }
  }

  async function ask(prompt: unknown, opts: unknown): Promise<unknown> {
    if (typeof prompt !== "string" || !prompt.trim()) throw new Error("pio.llm.ask(prompt, options): prompt is the question, as text");
    const o = options(opts, "pio.llm.ask");
    if (o.system !== undefined && typeof o.system !== "string") throw new Error("pio.llm.ask: system is text");
    if (!d.triageBudget()) throw new Error("this trigger's quick-model checks for today are used up (triagePerDay)");
    const schemaLine = o.schema === undefined ? undefined : `Answer with one JSON object and nothing else, matching this JSON schema:\n${JSON.stringify(o.schema)}`;
    const system = [o.system, schemaLine].filter((x): x is string => typeof x === "string" && !!x).join("\n\n") || undefined;
    const r = await d.quick.ask(prompt, system === undefined ? {} : { system });
    tokens += Math.ceil(((system ?? "").length + prompt.length + r.text.length) / 4);
    if (schemaLine === undefined) return r.text.trim();
    const parsed = firstJsonObject(r.text);
    if (!parsed) throw new Error("the quick model did not answer with a JSON object");
    return parsed;
  }

  function key(k: unknown): string {
    if (typeof k !== "string" || !k || k.length > KEY_MAX) throw new Error(`pio.state: a key is text of 1 to ${KEY_MAX} characters`);
    if (k.startsWith("__")) throw new Error("pio.state: keys starting with __ are the trigger engine's own");
    return k;
  }

  function recent(n: unknown): string[] {
    const count = typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.min(NOTES_MAX, Math.floor(n))) : NOTES_DEFAULT;
    if (!count) return [];
    const notes = d.store.notes({ triggerId: id, limit: count });
    // An external note is a summary of outside content.
    if (notes.some((x) => x.external)) external = true;
    return notes.map((x) => x.text);
  }

  async function dispatch(name: string, args: unknown[]): Promise<unknown> {
    switch (name) {
      case "tools.call":
        return toolsCall(args[0], args[1]);
      case "fetch":
        return fetchVia(args[0], args[1]);
      case "llm.ask":
        return ask(args[0], args[1]);
      case "state.get":
        return d.store.stateGet(id, key(args[0]));
      case "state.set":
        // Over 1 MB in all, the store's RangeError is what the script gets.
        d.store.stateSet(id, key(args[0]), args[1] ?? null);
        return undefined;
      case "state.delete":
        d.store.stateDelete(id, key(args[0]));
        return undefined;
      case "notes.recent":
        return recent(args[0]);
      default:
        throw new Error(`unknown pio call ${name}`);
    }
  }

  const host: HostCall = (name, args) => {
    if (closed) return Promise.reject(new Error(ENDED));
    const p = dispatch(name, Array.isArray(args) ? args : []);
    inflight.add(p);
    const done = () => void inflight.delete(p);
    p.then(done, done);
    return p;
  };

  return {
    host,
    external: () => external,
    tokens: () => tokens,
    now: () => {
      const at = d.now();
      return { iso: at.toISOString(), local: formatLocal(at, d.tz), timezone: d.tz };
    },
    close() {
      closing ??= (async () => {
        closed = true;
        ended.abort(new Error(ENDED));
        if (inflight.size) {
          let timer: NodeJS.Timeout | undefined;
          const late = new Promise<false>((r) => {
            timer = setTimeout(() => r(false), d.closeWaitMs ?? CLOSE_WAIT_MS);
            timer.unref?.();
          });
          const settled = await Promise.race([Promise.allSettled([...inflight]).then(() => true as const), late]);
          clearTimeout(timer);
          // A tool call still out may yet bring outside content: the run counts as having read it.
          if (!settled && toolsOut > 0) external = true;
        }
        d.release?.();
      })();
      return closing;
    },
  };
}

function options(v: unknown, what: string): Record<string, unknown> {
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v)) throw new Error(`${what}: the options are an object`);
  return v as Record<string, unknown>;
}

/** The script's headers, names in lower case, without the connection's and the proxy's own. */
function headersOf(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(options(v, "pio.fetch headers"))) {
    const name = k.toLowerCase();
    if (CONNECTION_HEADERS.has(name)) continue;
    if (typeof x !== "string" && typeof x !== "number" && typeof x !== "boolean") throw new Error(`pio.fetch: header ${k} is text`);
    out[name] = String(x);
  }
  return out;
}

/** The body as text, cut (on a character boundary) past `max` bytes. */
async function readCapped(res: Response, max: number): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: "", truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size > max) {
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
  }
  let buf = Buffer.concat(chunks);
  if (truncated) {
    let end = max;
    while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
    buf = buf.subarray(0, end);
  }
  return { text: new TextDecoder("utf-8", { fatal: false }).decode(buf), truncated };
}
