import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { verifyWebhook } from "../../src/signals/webhook-verify.ts";
import { startTriggerHarness, type TriggerHarness } from "./harness.ts";

const hmac = (secret: string, text: string) => createHmac("sha256", secret).update(text).digest("hex");
const body = '{"action":"opened","n":1}';
const req = (headers: Record<string, string>, rawBody = body, query: Record<string, string> = {}) => ({ headers, rawBody, query });

describe("verifyWebhook", () => {
  it("secret: header or query, timing-safe", () => {
    expect(verifyWebhook(undefined, req({ "x-piomio-secret": "s3" }), "s3")).toEqual({ ok: true });
    expect(verifyWebhook({ kind: "secret" }, req({}, body, { secret: "s3" }), "s3")).toEqual({ ok: true });
    expect(verifyWebhook({ kind: "secret" }, req({ "X-Piomio-Secret": "no" }), "s3").ok).toBe(false);
    expect(verifyWebhook(undefined, req({}), "s3").ok).toBe(false);
  });

  it("github: sha256= HMAC of the raw body", () => {
    const v = { kind: "github", secretRef: "vault://gh" } as const;
    const sig = "sha256=" + hmac("k", body);
    expect(verifyWebhook(v, req({ "X-Hub-Signature-256": sig }), "k")).toEqual({ ok: true });
    expect(verifyWebhook(v, req({ "x-hub-signature-256": sig }, body + " "), "k").ok).toBe(false);
    expect(verifyWebhook(v, req({ "x-hub-signature-256": "sha256=" + hmac("other", body) }), "k").ok).toBe(false);
    expect(verifyWebhook(v, req({ "x-hub-signature-256": hmac("k", body) }), "k").ok).toBe(false); // prefix required
    expect(verifyWebhook(v, req({}), "k").ok).toBe(false);
    expect(verifyWebhook(v, req({ "x-hub-signature-256": "sha256=zz" }), "k").ok).toBe(false);
  });

  it("stripe: t= and any v1 over `<t>.<body>`, within 5 minutes", () => {
    const v = { kind: "stripe", secretRef: "vault://st" } as const;
    const now = 1_800_000_000_000;
    const t = Math.floor(now / 1000);
    const good = hmac("k", `${t}.${body}`);
    expect(verifyWebhook(v, req({ "stripe-signature": `t=${t},v1=${good}` }), "k", now)).toEqual({ ok: true });
    expect(verifyWebhook(v, req({ "stripe-signature": `t=${t},v1=${"0".repeat(64)},v1=${good}` }), "k", now)).toEqual({ ok: true });
    expect(verifyWebhook(v, req({ "stripe-signature": `t=${t},v1=${"0".repeat(64)}` }), "k", now).ok).toBe(false);
    expect(verifyWebhook(v, req({ "stripe-signature": `t=${t},v1=${good}` }, body + "x"), "k", now).ok).toBe(false);
    const old = t - 301;
    expect(verifyWebhook(v, req({ "stripe-signature": `t=${old},v1=${hmac("k", `${old}.${body}`)}` }), "k", now).ok).toBe(false);
    const edge = t - 300;
    expect(verifyWebhook(v, req({ "stripe-signature": `t=${edge},v1=${hmac("k", `${edge}.${body}`)}` }), "k", now)).toEqual({ ok: true });
    expect(verifyWebhook(v, req({ "stripe-signature": `v1=${good}` }), "k", now).ok).toBe(false);
  });

  it("hmac-sha256: a header of choice, hex with or without sha256=", () => {
    const v = { kind: "hmac-sha256", secretRef: "vault://h" } as const;
    expect(verifyWebhook(v, req({ "x-signature": hmac("k", body) }), "k")).toEqual({ ok: true });
    expect(verifyWebhook(v, req({ "x-signature": "sha256=" + hmac("k", body) }), "k")).toEqual({ ok: true });
    expect(verifyWebhook(v, req({ "x-signature": hmac("k", body) }, "{}"), "k").ok).toBe(false);
    const custom = { ...v, header: "X-Sig" };
    expect(verifyWebhook(custom, req({ "x-sig": hmac("k", body) }), "k")).toEqual({ ok: true });
    expect(verifyWebhook(custom, req({ "x-signature": hmac("k", body) }), "k").ok).toBe(false);
  });
});

describe("webhook signatures in the engine", () => {
  let h: TriggerHarness;
  afterEach(() => h.stop());
  const start = async (items: Record<string, string>) => {
    h = await startTriggerHarness({
      core: (m) => (m === "tasks.create" ? { id: "task_1" } : m === "agents.list" ? [{ id: "assistant", name: "A" }] : m === "settings.get" ? { timezone: "UTC", defaultAgent: "assistant" } : []),
      vault: async (ref, actor) => {
        if (!items[ref]) throw new Error("not found");
        h.vaultCalls.push({ ref, actor });
        return { value: items[ref] };
      },
    });
  };
  const create = async (verify: unknown) => {
    const r = await h.http({ method: "POST", path: "/triggers", body: { kind: "event", name: "Hook", prompt: "Look.", verify } });
    return ((r.body as any).trigger?.id ?? (r.body as any).id) as string;
  };
  const post = (id: string, headers: Record<string, string>, rawBody: string) => h.http({ method: "POST", path: `/${id}`, public: true, headers, body: JSON.parse(rawBody), rawBody });

  it("answers 401 for a bad signature and 202 for a good one (GitHub)", async () => {
    await start({ "vault://gh": "ghsecret" });
    const id = await create({ kind: "github", secretRef: "vault://gh" });
    expect(id).toMatch(/^t_/);
    const raw = '{"zen":"ok"}';
    expect((await post(id, { "x-hub-signature-256": "sha256=" + hmac("wrong", raw) }, raw)).status).toBe(401);
    expect((await post(id, {}, raw)).status).toBe(401);
    const ok = await post(id, { "x-hub-signature-256": "sha256=" + hmac("ghsecret", raw) }, raw);
    expect(ok.status).toBe(202);
    expect(h.vaultCalls[0]).toEqual({ ref: "vault://gh", actor: `trigger:${id}` });
    // the old shared secret does not open a signed webhook
    expect((await h.http({ method: "POST", path: `/${id}`, public: true, query: { secret: "x" }, body: {}, rawBody: "{}" })).status).toBe(401);
  });

  it("answers 503 when the signing secret is missing from the vault", async () => {
    await start({});
    const id = await create({ kind: "hmac-sha256", secretRef: "vault://gone" });
    const r = await post(id, { "x-signature": "00" }, "{}");
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ error: "signing secret unavailable" });
  });
});
