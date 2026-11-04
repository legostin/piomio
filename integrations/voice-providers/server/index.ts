import type { PluginModule } from "@piomio/plugin-sdk";
import { DEFAULTS, IDS, KEYS, LABELS, MAX_AUDIO, VoiceError, provider, type ProviderId, type Failure } from "./providers.ts";
import { realtimeSpeech } from "./realtime.ts";

export function settingsFor(s: Record<string, unknown>, operation: "tts" | "stt") {
  const id = s[`${operation}Provider`];
  if (!IDS.includes(id as ProviderId)) throw new VoiceError("request");
  const p = id as ProviderId;
  const value = (key: string, fallback: string) => {
    const v = s[key] ?? fallback;
    if (typeof v !== "string" || !/^[\w.-]{1,100}$/.test(v)) throw new VoiceError("request");
    return v;
  };
  return { id: p, voice: operation === "tts" ? value(`${p}Voice`, DEFAULTS[p].voice) : DEFAULTS[p].voice,
    model: p === "xai" && operation === "tts" ? "" : value(`${p}${operation === "tts" ? "Tts" : "Stt"}Model`, DEFAULTS[p][operation === "tts" ? "ttsModel" : "sttModel"]) };
}

const plugin: PluginModule = {
  activate(ctx) {
    const active = new Map<string, AbortController>();
    const fail = (code: Failure, locale = ctx.i18n.locale()) => ({ status: code === "request" ? 400 : code === "key" ? 409 : 502, body: { code, error: ctx.i18n.t(`error.${code}`, undefined, locale) } });
    const state = () => ctx.ui.emit("changed", {});
    ctx.onSettingsChange(state);
    ctx.events.on("vault.updated", state); ctx.events.on("vault.state", state);
    ctx.http.handle(async (req) => {
      if (req.public) return { status: 403, body: { error: "Authentication required" } };
      const b = (req.body ?? {}) as Record<string, unknown>;
      if (req.method === "POST" && req.path === "/cancel") {
        active.get(String(b.id))?.abort(); return { body: { ok: true } };
      }
      if (req.method !== "POST" || !["/say", "/transcribe"].includes(req.path)) return { status: 404 };
      const id = typeof b.id === "string" && /^[\w-]{1,80}$/.test(b.id) ? b.id : "";
      if (!id || active.has(id)) return fail("request", req.locale);
      if (active.size >= 4) return fail("busy", req.locale);
      const ctl = new AbortController(); active.set(id, ctl);
      // Covers vault access, handshake, headers AND body, and is below the plugin HTTP RPC deadline.
      const timer = setTimeout(() => ctl.abort(new VoiceError("timeout")), 45_000);
      try {
        const operation = req.path === "/say" ? "tts" : "stt";
        const config = settingsFor(ctx.settings, operation);
        let data: Buffer | undefined;
        if (operation === "tts") {
          if (typeof b.text !== "string" || !b.text.trim() || b.text.length > 1000) throw new VoiceError("request");
        } else {
          if (typeof b.data !== "string" || b.data.length > Math.ceil(MAX_AUDIO / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b.data)) throw new VoiceError("request");
          data = Buffer.from(b.data, "base64");
          if (!data.length || data.length > MAX_AUDIO) throw new VoiceError("request");
        }
        let key: string;
        try {
          key = (await Promise.race([
            ctx.vault.get(`vault://${KEYS[config.id]}`),
            new Promise<never>((_resolve, reject) => ctl.signal.addEventListener("abort", () => reject(ctl.signal.reason), { once: true })),
          ])).value;
        } catch { if (ctl.signal.aborted) throw ctl.signal.reason; throw new VoiceError("key"); }
        if (!key?.trim()) throw new VoiceError("key");
        ctl.signal.throwIfAborted();
        const p = provider(config.id, key, fetch, realtimeSpeech);
        const language = typeof b.language === "string" && /^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/.test(b.language) ? b.language : undefined;
        const options = { ...config, language, signal: ctl.signal };
        if (operation === "tts") {
          const a = await p.synthesize(b.text as string, options);
          ctl.signal.throwIfAborted();
          return { body: { data: Buffer.from(a.data).toString("base64"), mimeType: a.mimeType } };
        }
        const mime = typeof b.mimeType === "string" ? b.mimeType.slice(0, 100) : "application/octet-stream";
        const name = typeof b.name === "string" ? b.name.replace(/[^\w.-]/g, "_").slice(-120) : "audio.wav";
        return { body: { text: await p.transcribe(data!, mime, name, options) } };
      } catch (e) {
        if (ctl.signal.aborted && !(ctl.signal.reason instanceof VoiceError)) return { status: 499, body: { code: "cancelled" } };
        return fail(ctl.signal.reason instanceof VoiceError ? ctl.signal.reason.code : e instanceof VoiceError ? e.code : "unavailable", req.locale);
      } finally { clearTimeout(timer); active.delete(id); }
    });
    ctx.tools.register({
      name: "status", effect: "read", description: "Check the selected speech providers and which BYOK keys are connected. Does not call a paid provider or reveal keys.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        const connected = await Promise.all(IDS.map(async (id) => { try { return { provider: LABELS[id], connected: !!(await ctx.vault.get(`vault://${KEYS[id]}`)).value }; } catch { return { provider: LABELS[id], connected: false }; } }));
        return JSON.stringify({ tts: ctx.settings.ttsProvider ?? "local", stt: IDS.includes(ctx.settings.sttProvider as ProviderId) ? ctx.settings.sttProvider : "local", fallback: "local", connected });
      },
    });
    ctx.tools.register({
      name: "say", effect: "read", description: "Create an AI-generated spoken audio file from up to 1000 characters using the person's selected voice provider and local fallback. Uses their API credits when cloud speech is selected. Returns a workspace file; does not send it to anyone. Use transcribe_audio for recordings.",
      inputSchema: { type: "object", properties: { text: { type: "string", maxLength: 1000 }, language: { type: "string" } }, required: ["text"] },
      handler: async (input, call) => {
        if (call.machineId !== "local") return { isError: true, content: [{ type: "text", text: "Audio files are created on the hub; run this in a session on the hub." }] };
        if (typeof input.text !== "string" || !input.text.trim() || input.text.length > 1000) return { isError: true, content: [{ type: "text", text: "Give text, from 1 to 1000 characters." }] };
        const a = await ctx.core.call<{ data: string; mimeType: string; warning?: string }>("speech.say", { text: input.text, language: input.language });
        const r = await ctx.core.call<{ path: string }>("files.deliver", { sessionId: call.sessionId, name: a.mimeType === "audio/wav" ? "speech.wav" : "speech.mp3", data: a.data });
        return JSON.stringify({ path: r.path, aiGenerated: true, ...(a.warning ? { warning: a.warning } : {}) });
      },
    });
  },
};
export default plugin;
