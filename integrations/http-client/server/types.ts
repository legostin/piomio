// What the server, the page and the chat card share. The page imports these as types only.

export const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;
export type Method = (typeof METHODS)[number];
export const BODY_TYPES = ["json", "text", "form"] as const;
export type BodyType = (typeof BODY_TYPES)[number];

/** Who sent a request by hand on the page (agents are named by their id). */
export const ME = "me";

/** A header or a query parameter. `off`: kept in the request, not sent. */
export interface Pair {
  name: string;
  value: string;
  off?: boolean;
}

/** A request as it was written: `{{variables}}` and `vault://` references are still in it. */
export interface RequestSpec {
  method: Method;
  url: string;
  query?: Pair[];
  headers?: Pair[];
  body?: string;
  bodyType?: BodyType;
}

export interface ResponseData {
  status: number;
  statusText: string;
  headers: Pair[];
  contentType: string;
  /** The text of the body, cut at what the history keeps; absent for a binary body. */
  body?: string;
  binary?: boolean;
  /** Bytes read from the network. */
  bytes: number;
  /** The body was longer than what was read or kept. */
  truncated?: boolean;
  /** The address that answered, after redirects. */
  url: string;
  redirects?: string[];
}

/** Why a request got no response. `message` is English, for the model and the journal. */
export interface SendFailure {
  /** `local`: this computer or an internal address, never opened; `lan`: a host of the person's own network they have not allowed. */
  code: "local" | "lan" | "timeout" | "network" | "invalid";
  message: string;
}

/** One line of the history. */
export interface Entry {
  id: string;
  at: number;
  /** "me" or an agent's id. */
  by: string;
  /** The saved request it was a run of. */
  saved?: string;
  environment?: string;
  request: RequestSpec;
  /** The address as sent, variables filled in; secrets stay references. */
  url: string;
  method: Method;
  response?: ResponseData;
  error?: SendFailure;
  ms: number;
}

export interface EntrySummary {
  id: string;
  at: number;
  by: string;
  method: Method;
  url: string;
  host: string;
  status?: number;
  error?: string;
  ms: number;
  bytes: number;
  saved?: string;
}

export interface SavedRequest {
  id: string;
  name: string;
  folder?: string;
  request: RequestSpec;
  updatedAt: number;
}

export interface Environment {
  id: string;
  name: string;
  vars: Record<string, string>;
  updatedAt: number;
}

/** What the page reads at once. */
export interface ClientState {
  requests: SavedRequest[];
  environments: Environment[];
  activeEnvironment?: string;
  defaultAgent?: string;
  /** Entries in the history. */
  total: number;
}

export interface HistoryFilter {
  q?: string;
  host?: string;
  method?: string;
  /** "200", "4xx" or "error". */
  status?: string;
  by?: string;
  /** Epoch ms. */
  since?: number;
  /** The id of the last entry already shown: the page after it. */
  before?: string;
  limit?: number;
}

/** The card in the chat (widget "response"): enough to draw it when the entry is gone from the history. */
export interface ResponseCard {
  id: string;
  method: Method;
  url: string;
  status?: number;
  statusText?: string;
  error?: string;
  ms: number;
  bytes: number;
}
