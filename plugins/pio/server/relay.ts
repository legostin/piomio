// Asking the Pio window to do something on its computer (look, click, type…): an "act" event to the web clients with a
// fresh id, answered by that window's "result" message.

import { randomUUID } from "node:crypto";

export interface ActResult {
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

export class Relay {
  private waiting = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private emit: (channel: string, payload: unknown) => void;
  private timeoutMs: number;

  constructor(emit: (channel: string, payload: unknown) => void, timeoutMs = 20_000) {
    this.emit = emit;
    this.timeoutMs = timeoutMs;
  }

  ask<T = unknown>(body: string, action: string, args: Record<string, unknown> = {}, timeoutMs = this.timeoutMs): Promise<T> {
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error("the Pio window did not answer (is the desktop app still open?)"));
      }, timeoutMs);
      this.waiting.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.emit("act", { id, body, action, args });
    });
  }

  answer(r: ActResult): void {
    const w = this.waiting.get(r.id);
    if (!w) return;
    this.waiting.delete(r.id);
    clearTimeout(w.timer);
    if (r.ok) w.resolve(r.data);
    else w.reject(new Error(String(r.error || "it failed")));
  }

  close(): void {
    for (const [id, w] of this.waiting) {
      clearTimeout(w.timer);
      w.reject(new Error("Pio stopped"));
      this.waiting.delete(id);
    }
  }
}
