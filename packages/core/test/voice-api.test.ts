import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerApi } from "../src/server/api.ts";

const apps: FastifyInstance[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });
async function app() {
  const api = Fastify(); apps.push(api);
  const interruptVoice = vi.fn(() => ({ mode: "interrupted" }));
  const say = vi.fn(async () => ({ data: Buffer.from([1, 2]), mimeType: "audio/wav" }));
  await registerApi(api, { config: {}, runner: { interruptVoice }, voiceProviders: { say } } as any,
    { kind: "web", bootstrap: () => ({}), authenticate: async () => {}, wsAllowed: () => false });
  return { api, interruptVoice, say };
}

describe("voice HTTP boundaries without a listening port", () => {
  it("validates receipts before asking the runner to interrupt", async () => {
    const f = await app();
    const good = await f.api.inject({ method: "POST", url: "/api/conversations/c/voice/interrupt", payload: { heard: [{ messageId: "m", end: 5 }], thinking: true } });
    expect(good.statusCode).toBe(200);
    expect(f.interruptVoice).toHaveBeenCalledWith("c", [{ messageId: "m", end: 5 }], { thinking: true });
    const bad = await f.api.inject({ method: "POST", url: "/api/conversations/c/voice/interrupt", payload: { heard: [{ messageId: "m", end: -1 }] } });
    expect(bad.statusCode).toBe(400); expect(f.interruptVoice).toHaveBeenCalledOnce();
  });
  it("aborts synthesis when its HTTP client disconnects", async () => {
    const f = await app(); let raw: any; let signal: AbortSignal | undefined;
    let started!: () => void; const ready = new Promise<void>((r) => started = r);
    f.api.addHook("onRequest", async (_request, reply) => { raw = reply.raw; });
    f.say.mockImplementation(async (_words: any, options: any) => {
      signal = options.signal; started();
      return new Promise<{ data: Buffer; mimeType: string }>((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }));
    });
    const response = f.api.inject({ method: "POST", url: "/api/speech/say", payload: { text: "old reply" } });
    const disconnected = expect(response).rejects.toThrow("response destroyed before completion");
    await ready; raw.emit("close"); await disconnected;
    expect(signal?.aborted).toBe(true);
  });
});
