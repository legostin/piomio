// The client side of the Agent Client Protocol (agentclientprotocol.com): JSON-RPC 2.0 over an agent's stdio, one
// message per line. The agent streams `session/update` notifications and asks the client things (permissions); the
// client sends requests (initialize, session/new, session/prompt…) and the `session/cancel` notification.

import { runLines, type RunningProcess } from "./proc.ts";

/** A JSON-RPC error the agent answered with. */
export class AcpError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

/** ACP's "authentication required". */
export const ACP_AUTH_REQUIRED = -32000;

export interface AcpHandlers {
  /** A notification from the agent (`session/update`). */
  notification?(method: string, params: any): void;
  /** A request from the agent (`session/request_permission`…): its result; a throw answers with an error. */
  request?(method: string, params: any): Promise<unknown>;
}

type Pending = { resolve: (v: any) => void; reject: (e: unknown) => void; timer?: NodeJS.Timeout };

export class AcpConnection {
  readonly proc: RunningProcess;
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private h: AcpHandlers;
  /** Resolves when the agent's stdout ends (it exited). */
  readonly closed: Promise<void>;

  constructor(command: string, args: string[], opts: { cwd?: string; env: Record<string, string> }, h: AcpHandlers = {}) {
    this.h = h;
    const proc = runLines(command, args, { cwd: opts.cwd, env: opts.env, keepInput: true });
    this.proc = proc;
    this.closed = (async () => {
      for await (const line of proc.lines) this.onLine(line);
      const gone = new AcpError(-32099, this.exitReason());
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(gone);
      }
      this.pending.clear();
    })();
  }

  get alive(): boolean {
    return this.proc.child.exitCode === null && this.proc.child.signalCode === null;
  }

  request<T = any>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const p: Pending = { resolve, reject };
      if (timeoutMs) {
        p.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new AcpError(-32098, `${method}: no answer in ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);
        p.timer.unref?.();
      }
      this.pending.set(id, p);
      if (!this.send({ jsonrpc: "2.0", id, method, params })) {
        clearTimeout(p.timer);
        this.pending.delete(id);
        reject(new AcpError(-32099, this.exitReason()));
      }
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  /** The agent's last words on stderr, for errors people read. */
  stderr(): string {
    return this.proc.stderr();
  }

  /** Ends stdin (the agent exits on its own), then stops it if it lingers. */
  async close(graceMs = 3000): Promise<void> {
    this.proc.endInput();
    const exited = await Promise.race([this.proc.exited, new Promise<null>((r) => setTimeout(() => r(null), graceMs).unref())]);
    if (!exited && this.alive) this.proc.child.kill("SIGKILL");
    await this.closed.catch(() => {});
  }

  kill(): void {
    if (this.alive) this.proc.child.kill("SIGKILL");
  }

  private send(m: unknown): boolean {
    return this.proc.write(`${JSON.stringify(m)}\n`);
  }

  private exitReason(): string {
    const tail = this.proc
      .stderr()
      .trim()
      .split("\n")
      .filter((l) => l.trim() && !l.startsWith("{"))
      .slice(-3)
      .join("\n");
    return tail || "the agent exited";
  }

  private onLine(line: string): void {
    if (!line.trim().startsWith("{")) return;
    let m: any;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.id !== undefined && m.id !== null && !m.method) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.reject(new AcpError(Number(m.error.code ?? -32603), String(m.error.message ?? "error"), m.error.data));
      else p.resolve(m.result);
      return;
    }
    if (typeof m.method !== "string") return;
    if (m.id === undefined || m.id === null) {
      try {
        this.h.notification?.(m.method, m.params);
      } catch {
        /* a bad frame must not stop the stream */
      }
      return;
    }
    const answer = this.h.request ? this.h.request(m.method, m.params) : Promise.reject(new AcpError(-32601, `${m.method} is not supported`));
    answer.then(
      (result) => this.send({ jsonrpc: "2.0", id: m.id, result: result ?? null }),
      (e) => this.send({ jsonrpc: "2.0", id: m.id, error: { code: e instanceof AcpError ? e.code : -32603, message: String((e as Error)?.message ?? e) } }),
    );
  }
}
