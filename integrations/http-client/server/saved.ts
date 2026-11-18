// The person's library: saved requests (called by name) and environments (sets of {{variables}}). It lives in the
// plugin's storage, which hub replicas share, so it is the same on whichever hub leads.
// Keys: "request:<id>" → SavedRequest, "environment:<id>" → Environment, "active" → the active environment's id.

import { randomUUID } from "node:crypto";
import type { PluginContext } from "@piomio/plugin-sdk";
import { ClientError } from "./errors.ts";
import { BODY_TYPES, METHODS, type BodyType, type Environment, type Method, type Pair, type RequestSpec, type SavedRequest } from "./types.ts";

type Storage = PluginContext["storage"];

const MAX_NAME = 120;
const MAX_PAIRS = 200;
const MAX_VARS = 200;
const MAX_VALUE = 16 * 1024;
/** A request body written by hand or by an agent. */
export const MAX_BODY = 2 * 1024 * 1024;
const VAR_NAME = /^[\w.-]{1,64}$/;

const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

function cleanName(raw: unknown): string {
  const name = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!name) throw new ClientError("noName");
  if (name.length > MAX_NAME) throw new ClientError("nameTooLong", { max: MAX_NAME });
  return name;
}

/** Headers or query parameters from the page's list (`[{name, value, off}]`) or a model's object (`{name: value}`). */
export function cleanPairs(raw: unknown): Pair[] {
  const out: Pair[] = [];
  if (Array.isArray(raw)) {
    for (const p of raw) {
      if (!p || typeof p !== "object") continue;
      const name = String((p as Pair).name ?? "");
      const value = String((p as Pair).value ?? "");
      if (!name.trim() && !value) continue;
      out.push({ name: name.slice(0, 1024), value: value.slice(0, MAX_VALUE), ...((p as Pair).off ? { off: true } : {}) });
    }
  } else if (raw && typeof raw === "object") {
    for (const [name, value] of Object.entries(raw)) {
      if (value === undefined || value === null) continue;
      const values = Array.isArray(value) ? value : [value];
      for (const v of values) out.push({ name: name.slice(0, 1024), value: (typeof v === "string" ? v : JSON.stringify(v)).slice(0, MAX_VALUE) });
    }
  }
  if (out.length > MAX_PAIRS) throw new ClientError("tooMany", { max: MAX_PAIRS });
  return out;
}

/** A request from whatever the page or a model wrote: checked, nothing sent. `body` may be an object (JSON, or form fields). */
export function cleanSpec(raw: unknown, base?: RequestSpec): RequestSpec {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const method = String(r.method ?? base?.method ?? "GET").toUpperCase() as Method;
  if (!METHODS.includes(method)) throw new ClientError("badMethod", { method: String(r.method).slice(0, 20), methods: METHODS.join(", ") });
  const url = String(r.url ?? base?.url ?? "").trim();
  if (url.length > 8192) throw new ClientError("badUrl", { url: `${url.slice(0, 100)}…` });
  let bodyType = (r.bodyType ?? base?.bodyType) as BodyType | undefined;
  if (bodyType !== undefined && !BODY_TYPES.includes(bodyType)) throw new ClientError("badBodyType", { types: BODY_TYPES.join(", ") });
  let body: string | undefined = base?.body;
  if (r.body !== undefined && r.body !== null) {
    if (typeof r.body === "string") body = r.body;
    else if (bodyType === "form" && typeof r.body === "object" && !Array.isArray(r.body)) {
      const form = new URLSearchParams();
      for (const [k, v] of Object.entries(r.body)) form.append(k, typeof v === "string" ? v : JSON.stringify(v));
      body = form.toString();
    } else {
      body = JSON.stringify(r.body, null, 2);
      bodyType ??= "json";
    }
  }
  if (body !== undefined && body.length > MAX_BODY) throw new ClientError("bodyTooLong", { max: `${MAX_BODY / 1024 / 1024} MB` });
  const merge = (mine: Pair[], theirs: Pair[] | undefined, caseless: boolean): Pair[] => {
    if (!theirs?.length) return mine;
    const key = (n: string) => (caseless ? n.toLowerCase() : n);
    const named = new Set(mine.map((p) => key(p.name)));
    return [...theirs.filter((p) => !named.has(key(p.name))), ...mine];
  };
  // Over a saved request, what the call names replaces the saved value of the same name; the rest stays.
  const query = merge(cleanPairs(r.query), base?.query, false);
  const headers = merge(cleanPairs(r.headers), base?.headers, true);
  return {
    method,
    url,
    ...(query.length ? { query } : {}),
    ...(headers.length ? { headers } : {}),
    // A body without a named type: JSON when it looks like JSON, text otherwise.
    ...(body ? { body, bodyType: bodyType ?? (/^\s*[[{"]/.test(body) ? "json" : "text") } : {}),
  };
}

export function cleanVars(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined || value === null) continue;
    if (!VAR_NAME.test(name)) throw new ClientError("badVarName", { name: name.slice(0, 80) });
    out[name] = (typeof value === "string" ? value : JSON.stringify(value)).slice(0, MAX_VALUE);
  }
  if (Object.keys(out).length > MAX_VARS) throw new ClientError("tooMany", { max: MAX_VARS });
  return out;
}

export class Saved {
  requests = new Map<string, SavedRequest>();
  environments = new Map<string, Environment>();
  active?: string;
  onChange: () => void = () => {};
  private storage: Storage;

  constructor(storage: Storage) {
    this.storage = storage;
  }

  async load(): Promise<void> {
    for (const { key, value } of await this.storage.list("request:")) {
      const r = value as SavedRequest;
      if (r?.id && key === `request:${r.id}`) this.requests.set(r.id, r);
    }
    for (const { key, value } of await this.storage.list("environment:")) {
      const e = value as Environment;
      if (e?.id && key === `environment:${e.id}`) this.environments.set(e.id, e);
    }
    const active = await this.storage.get<string>("active");
    this.active = active && this.environments.has(active) ? active : undefined;
  }

  requestList(): SavedRequest[] {
    return [...this.requests.values()].sort((a, b) => (a.folder ?? "").localeCompare(b.folder ?? "") || a.name.localeCompare(b.name));
  }

  environmentList(): Environment[] {
    return [...this.environments.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** By id or by name (case does not matter). */
  findRequest(ref: string): SavedRequest | undefined {
    return this.requests.get(ref) ?? [...this.requests.values()].find((r) => same(r.name, ref));
  }

  request(ref: string): SavedRequest {
    const r = this.findRequest(String(ref ?? ""));
    if (!r) throw new ClientError("requestNotFound", { name: String(ref).slice(0, 120) });
    return r;
  }

  findEnvironment(ref: string): Environment | undefined {
    return this.environments.get(ref) ?? [...this.environments.values()].find((e) => same(e.name, ref));
  }

  environment(ref: string): Environment {
    const e = this.findEnvironment(String(ref ?? ""));
    if (!e) throw new ClientError("environmentNotFound", { name: String(ref).slice(0, 120) });
    return e;
  }

  activeEnvironment(): Environment | undefined {
    return this.active ? this.environments.get(this.active) : undefined;
  }

  /** A new request, or with `id` (or the name of one that exists and `replace`) a changed one. */
  async saveRequest(input: { id?: string; name: unknown; folder?: unknown; request: RequestSpec; replace?: boolean }): Promise<SavedRequest> {
    const name = cleanName(input.name);
    const folder = String(input.folder ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
    const taken = [...this.requests.values()].find((r) => same(r.name, name));
    let current = input.id ? this.requests.get(input.id) : undefined;
    if (input.id && !current) throw new ClientError("requestNotFound", { name: input.id });
    if (!current && taken && input.replace) current = taken;
    if (taken && taken.id !== current?.id) throw new ClientError("nameTaken", { name });
    const saved: SavedRequest = {
      id: current?.id ?? `r_${randomUUID().replace(/-/g, "").slice(0, 10)}`,
      name,
      ...(folder ? { folder } : {}),
      request: input.request,
      updatedAt: Date.now(),
    };
    this.requests.set(saved.id, saved);
    await this.storage.set(`request:${saved.id}`, saved);
    this.onChange();
    return saved;
  }

  async removeRequest(r: SavedRequest): Promise<void> {
    this.requests.delete(r.id);
    await this.storage.delete(`request:${r.id}`);
    this.onChange();
  }

  /** `vars` replaces the whole set; `patch` changes the named ones (null removes one). */
  async saveEnvironment(input: { id?: string; name: unknown; vars?: unknown; patch?: Record<string, unknown>; replace?: boolean }): Promise<Environment> {
    const name = cleanName(input.name);
    const taken = [...this.environments.values()].find((e) => same(e.name, name));
    let current = input.id ? this.environments.get(input.id) : undefined;
    if (input.id && !current) throw new ClientError("environmentNotFound", { name: input.id });
    if (!current && taken && input.replace) current = taken;
    if (taken && taken.id !== current?.id) throw new ClientError("nameTaken", { name });
    let vars = input.vars !== undefined ? cleanVars(input.vars) : { ...(current?.vars ?? {}) };
    if (input.patch) {
      const removed = Object.entries(input.patch).filter(([, v]) => v === null).map(([k]) => k);
      vars = { ...vars, ...cleanVars(input.patch) };
      for (const k of removed) delete vars[k];
      if (Object.keys(vars).length > MAX_VARS) throw new ClientError("tooMany", { max: MAX_VARS });
    }
    const env: Environment = { id: current?.id ?? `e_${randomUUID().replace(/-/g, "").slice(0, 10)}`, name, vars, updatedAt: Date.now() };
    this.environments.set(env.id, env);
    await this.storage.set(`environment:${env.id}`, env);
    this.onChange();
    return env;
  }

  async removeEnvironment(e: Environment): Promise<void> {
    this.environments.delete(e.id);
    await this.storage.delete(`environment:${e.id}`);
    if (this.active === e.id) await this.setActive(undefined);
    else this.onChange();
  }

  async setActive(e: Environment | undefined): Promise<void> {
    this.active = e?.id;
    if (e) await this.storage.set("active", e.id);
    else await this.storage.delete("active");
    this.onChange();
  }
}
