// What both the tools and the page call to send a request: take a saved one if named, fill variables and secrets, send,
// cut the secrets from what came back, write the history, tell the open pages.

import { randomUUID } from "node:crypto";
import { ClientError } from "./errors.ts";
import { MAX_STORED_BODY, type History } from "./history.ts";
import type { Guard } from "./net.ts";
import { cleanSpec, cleanVars, type Saved } from "./saved.ts";
import { send, SendError, type SendOptions } from "./send.ts";
import type { Entry, RequestSpec, ResponseData } from "./types.ts";
import { fillVars, prepare, redact, resolveSecrets, type VaultReader } from "./vars.ts";

export interface RunInput {
  /** The request, or what to change in the saved one. */
  request?: unknown;
  /** A saved request's name or id. */
  saved?: string;
  vars?: unknown;
  /** An environment's name or id; `null` for none; unset: the active one. */
  environment?: string | null;
  /** "me" or an agent's id. */
  by: string;
  timeoutMs?: number;
}

export interface ClientDeps {
  history: History;
  saved: Saved;
  vault: VaultReader;
  guard: () => Guard;
  changed: () => void;
  fetchImpl?: typeof fetch;
}

export class Client {
  private d: ClientDeps;

  constructor(d: ClientDeps) {
    this.d = d;
  }

  /** The request a call means, as written (nothing filled in yet), and what it would be filled from. */
  plan(input: RunInput): { spec: RequestSpec; savedName?: string; environment?: string; vars: Record<string, string> } {
    const saved = input.saved ? this.d.saved.request(input.saved) : undefined;
    const spec = cleanSpec(input.request, saved?.request);
    const env = input.environment === null ? undefined : input.environment ? this.d.saved.environment(input.environment) : this.d.saved.activeEnvironment();
    return {
      spec,
      ...(saved ? { savedName: saved.name } : {}),
      ...(env ? { environment: env.name } : {}),
      vars: { ...(env?.vars ?? {}), ...cleanVars(input.vars) },
    };
  }

  /**
   * Sends it. A request that could not be written out (no address, a variable without a value, a vault item that is not
   * there) throws ClientError and leaves no trace; one that went out, or was refused on its way, is an entry.
   */
  async run(input: RunInput): Promise<Entry> {
    const { spec, savedName, environment, vars } = this.plan(input);
    const filled = fillVars(spec, vars);
    const prepared = prepare(filled);
    const { prepared: ready, secrets, secretHeaders } = await resolveSecrets(prepared, this.d.vault);

    const started = performance.now();
    let response: ResponseData | undefined;
    let error: Entry["error"];
    const options: SendOptions = { guard: this.d.guard(), secretHeaders, ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}), ...(this.d.fetchImpl ? { fetchImpl: this.d.fetchImpl } : {}) };
    try {
      response = await send(ready, options);
    } catch (e: any) {
      if (!(e instanceof SendError)) throw e;
      error = { code: e.code, message: redact(e.message, secrets) };
    }
    const ms = Math.round(performance.now() - started);

    const entry: Entry = {
      id: `h_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      at: Date.now(),
      by: input.by,
      ...(savedName ? { saved: savedName } : {}),
      ...(environment ? { environment } : {}),
      request: spec,
      // The address as it was sent, before the secrets went in: a reference stays a reference.
      url: readable(prepared.url),
      method: spec.method,
      ...(response ? { response: stored(response, secrets) } : {}),
      ...(error ? { error } : {}),
      ms,
    };
    this.d.history.add(entry);
    this.d.changed();
    return entry;
  }
}

/** "vault%3A%2F%2Fid" in a query back to "vault://id", for reading. */
function readable(href: string): string {
  return href.replace(/vault%3A%2F%2F[\w.-]+(?:%23[\w.-]+)?/gi, (m) => decodeURIComponent(m));
}

/** A response as the history keeps it: secrets cut, the body cut at what is kept. */
function stored(r: ResponseData, secrets: string[]): ResponseData {
  const cut = (s: string) => (secrets.length ? redact(s, secrets) : s);
  let body = r.body !== undefined ? cut(r.body) : undefined;
  let truncated = r.truncated;
  if (body !== undefined && body.length > MAX_STORED_BODY) {
    body = body.slice(0, MAX_STORED_BODY);
    truncated = true;
  }
  return {
    ...r,
    headers: r.headers.map((h) => ({ name: h.name, value: cut(h.value) })),
    url: cut(r.url),
    ...(r.redirects ? { redirects: r.redirects.map(cut) } : {}),
    ...(body !== undefined ? { body } : {}),
    ...(truncated ? { truncated: true } : {}),
  };
}

export { ClientError };
