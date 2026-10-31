// End-to-end through the SDK runner: tools, HTTP API, webhooks, watch polling, once firing, feedback.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { startPlugin, type PluginHarness } from "@piomio/testkit";
import { defaultReport } from "../server/schedule.ts";

const dir = join(import.meta.dirname, "..");

const until = async <T>(fn: () => T | Promise<T>, timeoutMs = 8000): Promise<NonNullable<T>> => {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe("triggers plugin", () => {
  let h: PluginHarness;
  let site: Server;
  let siteUrl = "";
  let price = "1 200 ₽";
  let hits = 0;
  const tasks: Array<{ id: string; agentId: string; goal: string; title: string; background: boolean; triggerId: string }> = [];

  const createdFor = (triggerId: string) => tasks.filter((t) => t.triggerId === triggerId);
  const idOf = (text: string) => /trigger (t_[0-9a-f]+)/.exec(text)![1];
  const get = async (id: string) => (await h.http({ path: `/triggers/${id}` })).body as any;

  beforeAll(async () => {
    site = createServer((req, res) => {
      hits++;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<html><body><h1>Билеты</h1><span class="price">${price}</span><script>var n=${Math.random()}</script></body></html>`);
    });
    await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
    siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}/tickets`;

    h = await startPlugin({
      dir,
      settings: { allowPrivateUrls: true },
      core: (method, p) => {
        switch (method) {
          case "settings.get":
            return { timezone: "Asia/Tokyo", publicUrl: "https://bot.example.com", defaultAgent: "assistant" };
          case "agents.list":
            return [
              { id: "assistant", name: "Ассистент" },
              { id: "researcher", name: "Исследователь" },
            ];
          case "tasks.create": {
            const t = { id: `task_${tasks.length + 1}`, ...p };
            tasks.push(t);
            return t;
          }
          case "tasks.list":
            return tasks.map((t) => ({ id: t.id, status: "done" }));
          default:
            return {};
        }
      },
    });
  });

  afterAll(async () => {
    await h?.stop();
    site?.close();
  });

  it("registers tools with the trigger_ prefix contract and a default heartbeat", async () => {
    expect([...h.tools.keys()].sort()).toEqual(["create", "delete", "list", "run_now", "update"]);
    expect(h.tools.get("create")!.effect).toBe("local-write");
    expect(h.tools.get("list")!.effect).toBe("read");
    expect(h.subscriptions.has("notification.feedback")).toBe(true);
    const list = await h.invokeText("list");
    expect(list).toContain("Timezone: Asia/Tokyo");
    const r = (await h.http({ path: "/triggers" })).body as any;
    const hb = r.triggers.filter((t: any) => t.kind === "heartbeat");
    expect(hb).toHaveLength(1);
    expect(hb[0]).toMatchObject({ name: "Daily review", agentId: "assistant", enabled: true, times: ["10:00", "18:00"], weekdays: [1, 2, 3, 4, 5] });
    expect(r.timezone).toBe("Asia/Tokyo");
    expect(r.agents.map((a: any) => a.id)).toEqual(["assistant", "researcher"]);
  });

  it("creates schedule triggers in the user's timezone and lists them", async () => {
    const out = await h.invokeText("create", { kind: "schedule", name: "Утренняя почта", prompt: "Check my inbox and summarize.", cron: "30 8 * * *" }, { agentId: "researcher" });
    expect(out).toMatch(/^Created trigger t_[0-9a-f]+ "Утренняя почта" \(schedule: cron 30 8 \* \* \*; timezone Asia\/Tokyo; agent researcher; enabled\)\./);
    expect(out).toMatch(/Next run: \d{4}-\d\d-\d\d 08:30 \(/);
    const id = idOf(out);
    const t = await get(id);
    const next = new Date(t.nextRunAt);
    expect([next.getUTCHours(), next.getUTCMinutes()]).toEqual([23, 30]); // 08:30 JST
    expect(t.createdBy).toBe("agent:researcher");
    const list = await h.invokeText("list", { kind: "schedule" });
    expect(list).toContain(id);
    expect(list).toContain("08:30");
  });

  it("makes a daily schedule a report and an hourly one a check, and passes report on to the task", async () => {
    const daily = idOf(await h.invokeText("create", { kind: "schedule", name: "Утренняя сводка", prompt: "Brief me.", cron: "0 8 * * *" }));
    const hourly = idOf(await h.invokeText("create", { kind: "schedule", name: "Mac", prompt: "Check.", cron: "0 * * * *" }));
    expect((await get(daily)).report).toBe(true);
    expect((await get(hourly)).report).toBe(false);

    await h.invokeText("run_now", { id: daily });
    const report = await until(() => createdFor(daily)[0] as any);
    expect(report.report).toBe(true);
    expect(report.goal).toContain("your final reply is delivered to them");
    await h.invokeText("run_now", { id: hourly });
    const check = await until(() => createdFor(hourly)[0] as any);
    expect("report" in check).toBe(false);
    expect(check.goal).toContain("call `notify` exactly once");

    // Only schedules and one-time runs can be reports; the agent can turn a check into one.
    const r = await h.invoke("create", { kind: "heartbeat", name: "Review", prompt: "Look.", report: true });
    expect(r.isError).toBe(true);
    expect((r.content[0] as any).text).toContain("Only schedule and once triggers can be reports");
    await h.invokeText("update", { id: hourly, report: true });
    expect((await get(hourly)).report).toBe(true);
  });

  it("defaults report by kind and frequency, also for triggers saved before it existed", () => {
    const now = new Date("2026-10-31T00:00:00Z");
    expect(defaultReport({ kind: "schedule", cron: "0 8 * * *" }, "Asia/Almaty", now)).toBe(true);
    expect(defaultReport({ kind: "schedule", cron: "0 9,13,18 * * *" }, "Asia/Almaty", now)).toBe(true);
    expect(defaultReport({ kind: "schedule", cron: "0 * * * *" }, "Asia/Almaty", now)).toBe(false);
    expect(defaultReport({ kind: "once" }, "Asia/Almaty", now)).toBe(true);
    expect(defaultReport({ kind: "heartbeat" }, "Asia/Almaty", now)).toBe(false);
  });

  it("answers a frequent schedule at once, without counting every run", () => {
    const now = new Date("2026-10-31T00:00:00Z");
    const started = performance.now();
    const report = defaultReport({ kind: "schedule", cron: "* * * * *" }, "Asia/Almaty", now);
    const elapsed = performance.now() - started;
    expect(report).toBe(false);
    expect(elapsed).toBeLessThan(100);
  });

  it("rejects bad input with clear errors", async () => {
    const bad = async (input: any) => {
      const r = await h.invoke("create", input);
      expect(r.isError).toBe(true);
      return (r.content[0] as any).text as string;
    };
    expect(await bad({ kind: "schedule", name: "x", prompt: "p", cron: "0 9 * *" })).toContain("5 fields");
    expect(await bad({ kind: "once", name: "x", prompt: "p", at: "2020-01-01T09:00" })).toContain("already passed");
    expect(await bad({ kind: "watch", name: "x", prompt: "p", url: siteUrl, intervalMinutes: 2 })).toContain("at least 5 minutes");
    expect(await bad({ kind: "schedule", name: "x", prompt: "p", cron: "0 9 * * *", agent: "nobody" })).toContain('Unknown agent "nobody". Available: assistant, researcher');
    expect(await bad({ kind: "alarm", name: "x", prompt: "p" })).toContain("Unknown trigger kind");
    const http = await h.http({ method: "POST", path: "/triggers", body: { kind: "once", name: "x", prompt: "p", at: "yesterday" } });
    expect(http.status).toBe(400);
    expect(http.body).toEqual({
      error: 'Cannot understand the time "yesterday": use ISO format, e.g. 2026-10-27T09:00 (your local time) or 2026-10-27T06:00:00Z',
      code: "badTime",
      params: { value: "yesterday" },
    });
  });

  it("fires a once trigger at its time", async () => {
    const at = new Date(Date.now() + 1200).toISOString();
    const id = idOf(await h.invokeText("create", { kind: "once", name: "Позвонить маме", prompt: "Remind the user to call mom.", at }));
    expect(createdFor(id)).toHaveLength(0);
    const task = await until(() => createdFor(id)[0]);
    expect(task).toMatchObject({ agentId: "assistant", background: true, title: "Позвонить маме", triggerId: id });
    expect(task.goal).toContain("Remind the user to call mom.");
    expect(task.goal).toContain("one-time reminder");
    const t = await until(async () => {
      const x = await get(id);
      return x.state.done ? x : undefined;
    });
    expect(t.enabled).toBe(false);
    expect(t.nextRunAt).toBeNull();
    const runs = ((await h.http({ path: `/triggers/${id}/runs` })).body as any).runs;
    expect(runs[0]).toMatchObject({ reason: "once", status: "started", taskId: task.id, taskStatus: "done" });
  });

  it("watches a page: baseline on the first poll, a task only on change", async () => {
    const out = await h.invokeText("create", { kind: "watch", name: "Цена билета", prompt: "Tell the user if the ticket got cheaper.", url: siteUrl, selector: ".price", intervalMinutes: 5 });
    expect(out).toContain("baseline");
    const id = idOf(out);
    // The scheduler polls right away and stores the baseline.
    const first = await until(async () => {
      const x = await get(id);
      return x.state.lastHash ? x : undefined;
    });
    expect(first.state.lastValue).toBe("1 200 ₽");
    expect(hits).toBeGreaterThanOrEqual(1);
    expect(createdFor(id)).toHaveLength(0);
    expect(Date.parse(first.nextRunAt) - Date.parse(first.state.lastCheckedAt)).toBe(5 * 60_000);

    // Unchanged (the page's script nonce changes, the selected text does not): no task.
    const same = (await h.http({ method: "POST", path: `/triggers/${id}/check` })).body as any;
    expect(same).toMatchObject({ changed: false, baseline: false });
    expect(createdFor(id)).toHaveLength(0);

    price = "990 ₽";
    const changed = (await h.http({ method: "POST", path: `/triggers/${id}/check` })).body as any;
    expect(changed.changed).toBe(true);
    expect(changed.run.status).toBe("started");
    const task = createdFor(id)[0];
    expect(task.goal).toContain("Tell the user if the ticket got cheaper.");
    expect(task.goal).toMatch(/<<<PREVIOUS_VALUE\n1 200 ₽\nPREVIOUS_VALUE>>>/);
    expect(task.goal).toMatch(/<<<NEW_VALUE\n990 ₽\nNEW_VALUE>>>/);
    expect(task.goal).toContain("UNTRUSTED");
    expect((await get(id)).state.lastValue).toBe("990 ₽");
  });

  it("accepts webhooks only with the right secret", async () => {
    const out = await h.invokeText("create", { kind: "event", name: "Деплой", prompt: "Summarize the deploy and notify on failure." });
    const id = idOf(out);
    expect(out).toContain(`Webhook URL: https://bot.example.com/hooks/triggers/${id}`);
    const secret = /Secret: (\S+)/.exec(out)![1];

    const post = (extra: Record<string, unknown>) => h.http({ method: "POST", path: `/${id}`, public: true, body: { status: "failed", service: "api" }, ...extra });
    expect((await post({ headers: { "x-piomio-secret": "wrong" } })).status).toBe(401);
    expect((await post({})).status).toBe(401);
    expect((await h.http({ method: "POST", path: "/t_doesnotexist", public: true, headers: { "x-piomio-secret": secret } })).status).toBe(404);
    expect((await h.http({ method: "GET", path: `/${id}`, public: true, query: { secret } })).status).toBe(405);
    expect((await h.http({ path: "/triggers", public: true })).status).toBe(404); // the UI API is not public
    expect(createdFor(id)).toHaveLength(0);

    const ok = await post({ headers: { "X-Piomio-Secret": secret, "content-type": "application/json" } });
    expect(ok.status).toBe(202);
    expect((ok.body as any).taskId).toBe(createdFor(id)[0].id);
    const goal = createdFor(id)[0].goal;
    expect(goal).toContain("Summarize the deploy and notify on failure.");
    expect(goal).toMatch(/<<<WEBHOOK_PAYLOAD\n\{\n {2}"status": "failed",\n {2}"service": "api"\n\}\nWEBHOOK_PAYLOAD>>>/);
    expect(goal).toContain("UNTRUSTED");
    expect(goal).not.toContain(secret);

    const viaQuery = await h.http({ method: "POST", path: `/${id}`, public: true, query: { secret, source: "ci" }, body: "x".repeat(10_000) });
    expect(viaQuery.status).toBe(202);
    const goal2 = createdFor(id)[1].goal;
    expect(goal2).toContain('Query parameters: {"source":"ci"}');
    expect(goal2).toContain("truncated to 4096 bytes");
    expect(goal2).not.toContain(secret);

    // Disabled triggers refuse webhooks.
    await h.http({ method: "PATCH", path: `/triggers/${id}`, body: { enabled: false } });
    expect((await post({ headers: { "x-piomio-secret": secret } })).status).toBe(409);
  });

  it("runs now, updates and deletes through tools", async () => {
    const id = idOf(await h.invokeText("create", { kind: "schedule", name: "Отчёт", prompt: "Weekly report.", cron: "0 18 * * 5" }));
    const ran = await h.invokeText("run_now", { id });
    expect(ran).toMatch(/^Started background task task_\d+/);
    expect(createdFor(id)[0].goal).toContain("started manually");

    const upd = await h.invokeText("update", { id, cron: "0 17 * * 5", name: "Отчёт за неделю" });
    expect(upd).toContain('Updated trigger');
    expect(upd).toContain("cron 0 17 * * 5");
    expect(upd).toMatch(/Next run: \d{4}-\d\d-\d\d 17:00 \(Fri\)/);
    const off = await h.invokeText("update", { id, enabled: false });
    expect(off).toContain("disabled");
    expect((await get(id)).nextRunAt).toBeNull();
    expect((await h.invoke("update", { id, cron: "nope" })).isError).toBe(true);

    expect(await h.invokeText("delete", { id })).toContain(`Deleted trigger ${id}`);
    expect(await h.invokeText("list")).not.toContain(id);
    expect((await h.http({ path: `/triggers/${id}` })).status).toBe(404);
    const missing = await h.invoke("delete", { id });
    expect(missing.isError).toBe(true);
    expect((missing.content[0] as any).text).toBe(`Trigger ${id} not found`);
  });

  it("supports the UI API: create, patch, run, runs", async () => {
    const created = await h.http({ method: "POST", path: "/triggers", body: { kind: "heartbeat", name: "Вечерний обзор", prompt: "Review the day.", times: ["21:00"], weekdays: [0, 6] } });
    expect(created.status).toBe(201);
    const t = created.body as any;
    expect(t.createdBy).toBe("user");
    expect(t.scheduleText).toBe("Sun,Sat at 21:00");
    // People read when it runs in their language.
    expect(t.whenText).toBe("weekends at 21:00");
    expect(((await h.http({ path: `/triggers/${t.id}`, locale: "ru" })).body as any).whenText).toBe("по выходным в 21:00");
    const next = new Date(t.nextRunAt);
    expect([next.getUTCHours(), next.getUTCMinutes()]).toEqual([12, 0]); // 21:00 JST
    expect([0, 6]).toContain(new Date(next.getTime() + 9 * 3600_000).getUTCDay());

    const patched = (await h.http({ method: "PATCH", path: `/triggers/${t.id}`, body: { times: ["20:00", "08:00"] } })).body as any;
    expect(patched.times).toEqual(["08:00", "20:00"]);
    expect((await h.http({ method: "PATCH", path: `/triggers/${t.id}`, body: { kind: "watch" } })).status).toBe(400);

    const run = (await h.http({ method: "POST", path: `/triggers/${t.id}/run` })).body as any;
    expect(run.status).toBe("started");
    const runs = ((await h.http({ path: `/triggers/${t.id}/runs` })).body as any).runs;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ reason: "manual", status: "started" });
    expect(h.coreCalls.some((c) => c.method === "ui.emit" && c.params.channel === "changed" && c.params.payload.id === t.id)).toBe(true);
    expect((await h.http({ method: "DELETE", path: `/triggers/${t.id}` })).body).toEqual({ ok: true });
  });

  it("feedback 'off' disables the trigger, 'less' slows a watch", async () => {
    const id = idOf(await h.invokeText("create", { kind: "schedule", name: "Новости", prompt: "News digest.", cron: "0 9 * * *" }));
    h.emit("notification.feedback", { id: "n_1", level: "notify", title: "Новости", body: "", triggerId: id, feedback: "off", createdAt: new Date().toISOString() });
    const t = await until(async () => {
      const x = await get(id);
      return x.enabled === false ? x : undefined;
    });
    expect(t.nextRunAt).toBeNull();
    expect(t.state.lastFeedback.value).toBe("off");

    const w = idOf(await h.invokeText("create", { kind: "watch", name: "Курс", prompt: "Rate changed.", url: siteUrl, intervalMinutes: 10 }));
    h.emit("notification.feedback", { id: "n_2", triggerId: w, feedback: "less" });
    await until(async () => (await get(w)).intervalMinutes === 20);
  });
});

describe("triggers plugin in Russian", () => {
  let h: PluginHarness;

  beforeAll(async () => {
    h = await startPlugin({
      dir,
      locale: "ru",
      core: (method) => {
        if (method === "settings.get") return { timezone: "Europe/Moscow", defaultAgent: "assistant" };
        if (method === "agents.list") return [{ id: "assistant", name: "Ассистент" }];
        return {};
      },
    });
  });

  afterAll(async () => {
    await h?.stop();
  });

  it("names the default review and answers the UI in the hub language, the model in English", async () => {
    const r = (await h.http({ path: "/triggers" })).body as any;
    expect(r.triggers.find((t: any) => t.kind === "heartbeat").name).toBe("Обзор дня");

    const bad = await h.http({ method: "POST", path: "/triggers", body: { kind: "watch", name: "x", prompt: "p", url: "https://example.com", intervalMinutes: 2 } });
    expect(bad.status).toBe(400);
    expect((bad.body as any).error).toBe("Интервал проверки — не меньше 5 минут (указано 2)");
    expect((await h.http({ path: "/triggers/t_nope" })).body).toMatchObject({ error: "Триггер t_nope не найден", code: "notFound" });
    expect(await h.invokeText("delete", { id: "t_nope" })).toBe("Trigger t_nope not found");

    h.setLocale("en");
    expect(((await h.http({ path: "/triggers/t_nope" })).body as any).error).toBe("Trigger t_nope not found");
  });
});
