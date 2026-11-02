// The hub's speech API for Pio's window (spec "Voice"; SpeechStatus as in @piomio/shared): raw WAV in, WAV out, which the JSON helpers of @piomio/ui do
// not carry, so these calls send the session's CSRF token themselves.

import type { PiomioUI } from "@piomio/ui";

export interface VoiceInfo {
  id: string;
  lang: string;
  gender: "male" | "female";
  name: string;
  size: number;
  license: string;
  installed: boolean;
}

export interface SpeechStatus {
  runtime: "missing" | "downloading" | "ready" | "failed";
  error?: string;
  voice: string;
  speed: number;
  voices: VoiceInfo[];
  stt: { provider: string; local: { model: string; installed: boolean; size: number }; models?: Array<{ id: string; langs: string[]; size: number; installed: boolean }> };
  downloading?: { item: string; received: number; total: number };
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class SpeechApi {
  private ui: PiomioUI;
  private csrf = "";

  constructor(ui: PiomioUI) {
    this.ui = ui;
  }

  private async token(fresh = false): Promise<string> {
    if (!this.csrf || fresh) this.csrf = (await this.ui.api.get<{ csrf: string }>("/api/bootstrap")).csrf ?? "";
    return this.csrf;
  }

  private async send(path: string, body: BodyInit, type: string, retry = true): Promise<Response> {
    const r = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "content-type": type, "x-csrf": await this.token() }, body });
    if (r.status === 403 && retry) {
      await this.token(true);
      return this.send(path, body, type, false);
    }
    if (!r.ok) {
      let msg = `HTTP ${r.status}`;
      try {
        const j = await r.json();
        msg = String(j?.error ?? j?.message ?? msg);
      } catch {
        /* not json */
      }
      throw new HttpError(r.status, msg);
    }
    return r;
  }

  status(): Promise<SpeechStatus> {
    return this.ui.api.get<SpeechStatus>("/api/speech");
  }

  install(o: { voice?: string; stt?: boolean | string }): Promise<SpeechStatus> {
    return this.ui.api.post<SpeechStatus>("/api/speech/install", o);
  }

  async transcribe(wav: Uint8Array): Promise<string> {
    const r = await this.send("/api/speech/transcribe", new Blob([wav as BlobPart], { type: "audio/wav" }), "audio/wav");
    return String((await r.json())?.text ?? "");
  }

  async say(text: string, voice?: string): Promise<ArrayBuffer> {
    const r = await this.send("/api/speech/say", JSON.stringify({ text, ...(voice ? { voice } : {}) }), "application/json");
    return r.arrayBuffer();
  }
}
