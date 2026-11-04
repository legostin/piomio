import { afterAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { createServer as createH2Server, type Http2Server } from "node:http2";
import { generateKeyPairSync, verify } from "node:crypto";
import type { AddressInfo } from "node:net";
import { ApnsClient, openHandle, relayHandler, sealHandle, type ApnsRequest, type ApnsResult } from "../src/index.ts";

const SECRET = "s".repeat(40);
const TOKEN = "ab".repeat(32);

describe("handles", () => {
  it("seal a token that only the same secret opens", () => {
    const h = sealHandle(SECRET, { token: TOKEN, environment: "sandbox" });
    expect(h).not.toContain(TOKEN);
    expect(openHandle(SECRET, h)).toEqual({ token: TOKEN, environment: "sandbox" });
    expect(openHandle("x".repeat(40), h)).toBeUndefined();
    const raw = Buffer.from(h, "base64url");
    raw[20] ^= 1;
    expect(openHandle(SECRET, raw.toString("base64url"))).toBeUndefined();
    expect(openHandle(SECRET, "nonsense")).toBeUndefined();
    expect(openHandle(SECRET, 42)).toBeUndefined();
  });
});

describe("relay", () => {
  const sent: ApnsRequest[] = [];
  let answer: ApnsResult = { status: 200 };
  const server: Server = createServer(
    relayHandler({
      secret: SECRET,
      send: async (r) => {
        sent.push(r);
        return answer;
      },
      now: () => 1_800_000_000_000,
    }),
  );
  let base = "";
  afterAll(() => server.close());

  const post = async (path: string, body: unknown) => {
    if (!base) {
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    }
    const res = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as any };
  };

  it("registers a token and pushes a content-free alert to it", async () => {
    const reg = await post("/v1/register", { token: TOKEN.toUpperCase(), environment: "sandbox" });
    expect(reg.status).toBe(200);
    const { handle } = reg.body;
    expect(openHandle(SECRET, handle)?.token).toBe(TOKEN);

    const r = await post("/v1/push", { handle, id: "ntf_1", badge: 3 });
    expect(r).toEqual({ status: 200, body: { ok: true } });
    expect(sent.at(-1)).toEqual({
      environment: "sandbox",
      token: TOKEN,
      payload: { aps: { alert: { "loc-key": "New message" }, "mutable-content": 1, sound: "default", badge: 3 }, n: "ntf_1" },
      headers: { "apns-push-type": "alert", "apns-priority": "10", "apns-expiration": String(1_800_000_000 + 86400), "apns-collapse-id": "ntf_1" },
    });

    await post("/v1/push", { handle, kind: "approval", silent: true, title: "secret words" });
    const quiet = sent.at(-1)!;
    expect(quiet.payload).toEqual({ aps: { alert: { "loc-key": "Waiting for your answer" }, "mutable-content": 1 } });
    expect(quiet.headers["apns-priority"]).toBe("5");
  });

  it("refuses what it did not make and says when a phone is gone", async () => {
    expect((await post("/v1/register", { token: "zz" })).status).toBe(400);
    expect((await post("/v1/push", { handle: "nope" })).status).toBe(400);
    const { handle } = (await post("/v1/register", { token: TOKEN })).body;
    expect((await post("/v1/push", { handle, id: "../x" })).status).toBe(400);
    answer = { status: 410, reason: "Unregistered" };
    expect(await post("/v1/push", { handle })).toEqual({ status: 410, body: { gone: true } });
    answer = { status: 500, reason: "InternalServerError" };
    expect((await post("/v1/push", { handle })).status).toBe(502);
    answer = { status: 200 };
  });
});

describe("APNs client", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const seen: Array<{ headers: Record<string, unknown>; body: string }> = [];
  let expire = 1;
  const h2: Http2Server = createH2Server((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ headers: { ...req.headers }, body });
      if (expire-- > 0) {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ reason: "ExpiredProviderToken" }));
        return;
      }
      res.writeHead(200);
      res.end();
    });
  });
  afterAll(() => h2.close());

  it("sends to /3/device/<token> with a fresh ES256 token after Apple refuses an old one", async () => {
    await new Promise<void>((r) => h2.listen(0, "127.0.0.1", r));
    const origin = `http://127.0.0.1:${(h2.address() as AddressInfo).port}`;
    let now = 1_800_000_000_000;
    const client = new ApnsClient(
      { key: privateKey.export({ format: "pem", type: "pkcs8" }).toString(), keyId: "KEY123", teamId: "TEAM45", topic: "app.piomio.ios", origins: { sandbox: origin } },
      () => (now += 1000),
    );
    const r = await client.send({ environment: "sandbox", token: TOKEN, payload: { aps: {} }, headers: { "apns-push-type": "alert" } });
    client.close();
    expect(r).toEqual({ status: 200 });
    expect(seen).toHaveLength(2);
    const last = seen[1];
    expect(last.headers[":path"]).toBe(`/3/device/${TOKEN}`);
    expect(last.headers["apns-topic"]).toBe("app.piomio.ios");
    expect(last.headers["apns-push-type"]).toBe("alert");
    expect(last.body).toBe('{"aps":{}}');
    const jwt = String(last.headers.authorization).replace(/^bearer /, "");
    expect(jwt).not.toBe(String(seen[0].headers.authorization).replace(/^bearer /, ""));
    const [head, claims, sig] = jwt.split(".");
    expect(JSON.parse(Buffer.from(head, "base64url").toString())).toEqual({ alg: "ES256", kid: "KEY123" });
    expect(JSON.parse(Buffer.from(claims, "base64url").toString()).iss).toBe("TEAM45");
    expect(verify("sha256", Buffer.from(`${head}.${claims}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url"))).toBe(true);
  });
});
