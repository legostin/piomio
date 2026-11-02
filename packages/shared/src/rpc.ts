// Minimal JSON-RPC 2.0 peer over any message transport.
// Used for core <-> plugin processes (NDJSON over stdio) and hub <-> node daemon (WebSocket).

import type { Readable, Writable } from "node:stream";

export interface RpcTransport {
  send(message: string): void;
  onMessage(cb: (message: string) => void): void;
  onClose(cb: () => void): void;
  close(): void;
}

export type RpcHandler = (params: any) => unknown | Promise<unknown>;

export class RpcError extends Error {
  code: number;
  data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

export const RpcCodes = {
  ParseError: -32700,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  Internal: -32603,
  PermissionDenied: -32001,
  Closed: -32002,
  Timeout: -32003,
} as const;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer?: NodeJS.Timeout;
}

export interface RpcPeer {
  request<T = unknown>(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<T>;
  notify(method: string, params?: unknown): void;
  handle(method: string, handler: RpcHandler): void;
  /** Fallback for methods without an explicit handler (e.g. prefix routing). */
  handleAny(handler: (method: string, params: any) => unknown | Promise<unknown>): void;
  onNotification(method: string, cb: (params: any) => void): void;
  onClose(cb: () => void): void;
  close(): void;
  readonly closed: boolean;
}

export function createRpcPeer(transport: RpcTransport): RpcPeer {
  let nextId = 1;
  let closed = false;
  const pending = new Map<number | string, Pending>();
  const handlers = new Map<string, RpcHandler>();
  let anyHandler: ((method: string, params: any) => unknown | Promise<unknown>) | undefined;
  const notificationHandlers = new Map<string, Array<(p: any) => void>>();
  const closeHandlers: Array<() => void> = [];

  const sendObj = (obj: unknown) => {
    if (closed) return;
    try {
      transport.send(JSON.stringify(obj));
    } catch {
      /* transport gone */
    }
  };

  const failAll = () => {
    for (const [, p] of pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new RpcError(RpcCodes.Closed, "RPC peer closed"));
    }
    pending.clear();
  };

  transport.onClose(() => {
    if (closed) return;
    closed = true;
    failAll();
    for (const cb of closeHandlers) cb();
  });

  transport.onMessage(async (raw) => {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      sendObj({ jsonrpc: "2.0", id: null, error: { code: RpcCodes.ParseError, message: "Parse error" } });
      return;
    }
    if (msg && typeof msg === "object" && "method" in msg) {
      const method: string = msg.method;
      if (msg.id === undefined || msg.id === null) {
        for (const cb of notificationHandlers.get(method) ?? []) {
          try {
            cb(msg.params);
          } catch {
            /* ignore handler errors */
          }
        }
        return;
      }
      const handler = handlers.get(method);
      try {
        let result: unknown;
        if (handler) result = await handler(msg.params);
        else if (anyHandler) result = await anyHandler(method, msg.params);
        else throw new RpcError(RpcCodes.MethodNotFound, `Method not found: ${method}`);
        sendObj({ jsonrpc: "2.0", id: msg.id, result: result === undefined ? null : result });
      } catch (e: any) {
        const code = e instanceof RpcError ? e.code : RpcCodes.Internal;
        sendObj({
          jsonrpc: "2.0",
          id: msg.id,
          // Errors may describe themselves for the other side (rpcData), e.g. a localized hub error's key and text.
          error: { code, message: e?.message ?? String(e), data: e instanceof RpcError ? e.data : e?.rpcData },
        });
      }
      return;
    }
    if (msg && "id" in msg) {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (p.timer) clearTimeout(p.timer);
      if (msg.error) p.reject(new RpcError(msg.error.code, msg.error.message, msg.error.data));
      else p.resolve(msg.result);
    }
  });

  return {
    request<T>(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<T> {
      if (closed) return Promise.reject(new RpcError(RpcCodes.Closed, "RPC peer closed"));
      const id = nextId++;
      return new Promise<T>((resolve, reject) => {
        const p: Pending = { resolve: resolve as (v: unknown) => void, reject };
        if (opts?.timeoutMs) {
          p.timer = setTimeout(() => {
            pending.delete(id);
            reject(new RpcError(RpcCodes.Timeout, `RPC timeout: ${method}`));
          }, opts.timeoutMs);
        }
        pending.set(id, p);
        sendObj({ jsonrpc: "2.0", id, method, params });
      });
    },
    notify(method, params) {
      sendObj({ jsonrpc: "2.0", method, params });
    },
    handle(method, handler) {
      handlers.set(method, handler);
    },
    handleAny(handler) {
      anyHandler = handler;
    },
    onNotification(method, cb) {
      const list = notificationHandlers.get(method) ?? [];
      list.push(cb);
      notificationHandlers.set(method, list);
    },
    onClose(cb) {
      closeHandlers.push(cb);
    },
    close() {
      if (closed) return;
      closed = true;
      failAll();
      transport.close();
      for (const cb of closeHandlers) cb();
    },
    get closed() {
      return closed;
    },
  };
}

/** NDJSON framing over a pair of streams (child stdio, or process.stdin/stdout). */
export function ndjsonTransport(input: Readable, output: Writable): RpcTransport {
  let buffer = "";
  const messageCbs: Array<(m: string) => void> = [];
  const closeCbs: Array<() => void> = [];
  input.setEncoding("utf8");
  input.on("data", (chunk: string) => {
    buffer += chunk;
    // The buffer holds no line break before this chunk: a long line arriving in many chunks is not searched again
    // each time (that made it quadratic).
    if (!chunk.includes("\n")) return;
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) for (const cb of messageCbs) cb(line);
    }
  });
  const fireClose = () => {
    for (const cb of closeCbs.splice(0)) cb();
  };
  input.on("end", fireClose);
  input.on("close", fireClose);
  output.on("error", () => fireClose());
  return {
    send(message) {
      output.write(message + "\n");
    },
    onMessage(cb) {
      messageCbs.push(cb);
    },
    onClose(cb) {
      closeCbs.push(cb);
    },
    close() {
      try {
        output.end();
      } catch {
        /* ignore */
      }
    },
  };
}

/** In-memory linked pair, for tests. */
export function memoryTransportPair(): [RpcTransport, RpcTransport] {
  const make = () => ({ msg: [] as Array<(m: string) => void>, close: [] as Array<() => void> });
  const a = make();
  const b = make();
  let isClosed = false;
  const closeBoth = () => {
    if (isClosed) return;
    isClosed = true;
    for (const cb of [...a.close, ...b.close]) cb();
  };
  const ta: RpcTransport = {
    send: (m) => queueMicrotask(() => b.msg.forEach((cb) => cb(m))),
    onMessage: (cb) => a.msg.push(cb),
    onClose: (cb) => a.close.push(cb),
    close: closeBoth,
  };
  const tb: RpcTransport = {
    send: (m) => queueMicrotask(() => a.msg.forEach((cb) => cb(m))),
    onMessage: (cb) => b.msg.push(cb),
    onClose: (cb) => b.close.push(cb),
    close: closeBoth,
  };
  return [ta, tb];
}

/** Minimal WebSocket shape shared by the `ws` package and browsers' WebSocket (Node event-emitter style). */
export interface WsLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", cb: (data: unknown) => void): void;
  on(event: "close", cb: () => void): void;
  readyState: number;
}

/** Text frames over a `ws` WebSocket; each frame is one JSON-RPC message. */
export function wsTransport(ws: WsLike): RpcTransport {
  const closeCbs: Array<() => void> = [];
  let closed = false;
  ws.on("close", () => {
    if (closed) return;
    closed = true;
    for (const cb of closeCbs.splice(0)) cb();
  });
  return {
    send(message) {
      if (ws.readyState === 1) ws.send(message);
    },
    onMessage(cb) {
      ws.on("message", (data) => cb(typeof data === "string" ? data : String(data)));
    },
    onClose(cb) {
      closeCbs.push(cb);
    },
    close() {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    },
  };
}
