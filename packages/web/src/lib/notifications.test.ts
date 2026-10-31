import { describe, expect, it } from "vitest";
import type { BehindEntry, InboxEntry, InboxView } from "@piomio/shared";
import { appendPage, behindMayHaveMore, behindWhy, dayLabel, groupByDay, idsToMarkRead, INBOX_PAGE, INBOX_PAGE_MAX, mergeBehind, partKind, pinWaiting, reloadLimit, sourceLabel, splitWaiting, toastWorthy } from "./notifications";

const entry = (id: string, over: Partial<InboxEntry> = {}): InboxEntry => ({ id, kind: "alert", title: id, body: "", createdAt: "2026-10-31T10:00:00Z", unread: false, feedbackable: false, ...over });
const view = (entries: InboxEntry[], over: Partial<InboxView> = {}): InboxView => ({ questions: [], entries, hasMore: true, behindCount: 0, unread: 0, ...over });
const behindRow = (id: string, over: Partial<BehindEntry> = {}): BehindEntry => ({ id, level: "silent", kind: "item", title: id, body: "", createdAt: "2026-10-31T10:00:00Z", waiting: false, ...over });

describe("notification views", () => {
  it("reads parts saved before kinds by their level", () => {
    expect(partKind({ level: "digest" })).toBe("digest");
    expect(partKind({ level: "ask" })).toBe("question");
    expect(partKind({ level: "notify" })).toBe("alert");
    expect(partKind({ level: "notify", kind: "report" })).toBe("report");
  });

  it("labels a source with its count when there is more than one", () => {
    expect(sourceLabel({ label: "\u041d\u043e\u0432\u043e\u0441\u0442\u0438 \u0410\u043b\u043c\u0430\u0442\u044b", count: 3 })).toBe("\u041d\u043e\u0432\u043e\u0441\u0442\u0438 \u0410\u043b\u043c\u0430\u0442\u044b · 3");
    expect(sourceLabel({ label: "Calendar" })).toBe("Calendar");
    expect(sourceLabel({ label: "Scout", count: 1 })).toBe("Scout");
  });

  it("groups entries by the person's day and names today and yesterday", () => {
    const list = [
      { id: "a", createdAt: "2026-10-31T19:30:00Z" },
      { id: "b", createdAt: "2026-10-31T03:00:00Z" },
      { id: "c", createdAt: "2026-10-30T20:00:00Z" },
    ];
    // Almaty is UTC+5: 19:30Z is already 1 November there, 20:00Z on the 30th is the 31st.
    expect(groupByDay(list, "Asia/Almaty").map((g) => [g.day, g.entries.map((e) => e.id)])).toEqual([
      ["2026-11-01", ["a"]],
      ["2026-10-31", ["b", "c"]],
    ]);
    const now = new Date("2026-11-01T06:00:00Z");
    const words = { today: "Today", yesterday: "Yesterday" };
    expect(dayLabel("2026-11-01", now, "Asia/Almaty", "en", words)).toBe("Today");
    expect(dayLabel("2026-10-31", now, "Asia/Almaty", "en", words)).toBe("Yesterday");
    expect(dayLabel("2026-10-29", now, "Asia/Almaty", "ru", words)).toBe("29 \u043e\u043a\u0442\u044f\u0431\u0440\u044f");
  });
});

describe("Inbox paging", () => {
  it("asks for the first page until the person has paged in, then for as many rows as they have, up to the hub's most", () => {
    expect(reloadLimit(0)).toBe(INBOX_PAGE);
    expect(reloadLimit(INBOX_PAGE)).toBe(INBOX_PAGE);
    expect(reloadLimit(INBOX_PAGE + 1)).toBe(INBOX_PAGE + 1);
    expect(reloadLimit(120)).toBe(120);
    expect(reloadLimit(500)).toBe(INBOX_PAGE_MAX);
  });

  it("joins the next page after the last row, each row once", () => {
    const v = view([entry("a"), entry("b")]);
    const next = { entries: [entry("b"), entry("c"), entry("d")], hasMore: false };
    const joined = appendPage(v, next, "b");
    expect(joined.entries.map((e) => e.id)).toEqual(["a", "b", "c", "d"]);
    expect(joined.hasMore).toBe(false);
    // the rest of the view stays
    expect(joined.behindCount).toBe(v.behindCount);
    expect(v.entries.map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("drops a page that follows a list a refresh has since replaced", () => {
    const refreshed = view([entry("x"), entry("a")]);
    const next = { entries: [entry("c")], hasMore: false };
    expect(appendPage(refreshed, next, "b")).toBe(refreshed);
    expect(appendPage(view([]), next, "b").entries).toEqual([]);
  });

  it("joins a page of Behind the scenes without repeating a row, and starts afresh when asked", () => {
    const first = [behindRow("a"), behindRow("b")];
    expect(mergeBehind(first, [behindRow("b"), behindRow("c")]).map((b) => b.id)).toEqual(["a", "b", "c"]);
    expect(mergeBehind([], [behindRow("c")]).map((b) => b.id)).toEqual(["c"]);
  });

  it("thinks Behind the scenes may have more when a page is as long as asked for", () => {
    expect(behindMayHaveMore(new Array(INBOX_PAGE).fill(0))).toBe(true);
    expect(behindMayHaveMore(new Array(INBOX_PAGE + 3).fill(0))).toBe(true);
    expect(behindMayHaveMore(new Array(INBOX_PAGE - 1).fill(0))).toBe(false);
    expect(behindMayHaveMore([1, 2], 2)).toBe(true);
    expect(behindMayHaveMore([], 2)).toBe(false);
  });

  it("marks read what is unread and not marked yet, questions first", () => {
    const v = view([entry("a", { unread: true }), entry("b"), entry("c", { unread: true })], { questions: [entry("q", { kind: "question", unread: true })] });
    expect(idsToMarkRead(v, new Set())).toEqual(["q", "a", "c"]);
    // sent already (its dot stays on the page, the hub counts it read)
    expect(idsToMarkRead(v, new Set(["a", "q"]))).toEqual(["c"]);
    // a refresh brings those rows back as read: nothing to send, no loop
    const after = view([entry("a"), entry("b"), entry("c")], { questions: [entry("q", { kind: "question" })] });
    expect(idsToMarkRead(after, new Set(["a", "q", "c"]))).toEqual([]);
  });
});

describe("Waiting for you during a visit", () => {
  const ids = (list: InboxEntry[]) => list.map((e) => e.id);
  const pins = (...list: InboxEntry[]) => new Map(list.map((e) => [e.id, e]));

  it("shows the view as the hub sent it when nothing was pinned", () => {
    const v = view([entry("a"), entry("b")], { questions: [entry("q", { kind: "question", unread: true })] });
    const split = splitWaiting(v, new Map());
    expect(ids(split.waiting)).toEqual(["q"]);
    expect(ids(split.byDay)).toEqual(["a", "b"]);
  });

  it("keeps a question under Waiting after reading it moved it into the list", () => {
    const pinned = new Map<string, InboxEntry>();
    // The first view: the question is unread, so the hub lists it under Waiting.
    const first = view([entry("a", { createdAt: "2026-10-31T09:00:00Z" })], { questions: [entry("q", { kind: "question", unread: true, createdAt: "2026-10-31T10:00:00Z" })] });
    pinWaiting(pinned, first);
    expect(ids(splitWaiting(first, pinned).waiting)).toEqual(["q"]);
    // The page marked it read and reloaded: the hub now lists it by its time, among the entries.
    const reloaded = view([entry("q", { kind: "question", createdAt: "2026-10-31T10:00:00Z" }), entry("a", { createdAt: "2026-10-31T09:00:00Z" })]);
    pinWaiting(pinned, reloaded);
    const split = splitWaiting(reloaded, pinned);
    expect(ids(split.waiting)).toEqual(["q"]);
    expect(ids(split.byDay)).toEqual(["a"]);
    // A question that was never under Waiting in this visit is listed by its time.
    expect(ids(splitWaiting(view([entry("old", { kind: "question" }), entry("a")]), pinned).byDay)).toEqual(["old", "a"]);
    // Going to answer it in the chat lets it go: it is listed by its time again.
    pinned.delete("q");
    expect(ids(splitWaiting(reloaded, pinned).waiting)).toEqual([]);
    expect(ids(splitWaiting(reloaded, pinned).byDay)).toEqual(["q", "a"]);
  });

  it("keeps a pinned question that newer rows pushed off the first page", () => {
    const pinned = new Map<string, InboxEntry>();
    const first = view([entry("a", { createdAt: "2026-10-30T09:00:00Z" })], { questions: [entry("q", { kind: "question", unread: true, title: "Old question", createdAt: "2026-10-30T08:00:00Z" })] });
    pinWaiting(pinned, first);
    // Read, and more than a page of newer rows came since: the hub lists it on no page we hold.
    const newer = Array.from({ length: INBOX_PAGE }, (_, i) => entry(`n${i}`, { createdAt: `2026-10-31T10:${String(59 - i).padStart(2, "0")}:00Z` }));
    const reloaded = view(newer);
    pinWaiting(pinned, reloaded);
    const split = splitWaiting(reloaded, pinned);
    expect(ids(split.waiting)).toEqual(["q"]);
    expect(split.waiting[0].title).toBe("Old question");
    expect(ids(split.byDay)).toEqual(newer.map((e) => e.id));
  });

  it("keeps Waiting newest first, held rows and new questions together, each once, a held row as the list has it", () => {
    const pinned = pins(entry("q1", { title: "stale 1", createdAt: "2026-10-31T08:00:00Z" }), entry("q2", { title: "stale 2", createdAt: "2026-10-31T11:00:00Z" }), entry("q4", { title: "stored 4", createdAt: "2026-10-31T07:00:00Z" }));
    const v = view(
      [entry("q2", { title: "fresh 2", createdAt: "2026-10-31T11:00:00Z" }), entry("x", { createdAt: "2026-10-31T10:30:00Z" }), entry("q1", { title: "fresh 1", createdAt: "2026-10-31T08:00:00Z" })],
      { questions: [entry("q3", { kind: "question", unread: true, createdAt: "2026-10-31T10:00:00Z" })] },
    );
    const split = splitWaiting(v, pinned);
    // q4 is on no loaded page: it comes from its stored copy
    expect(ids(split.waiting)).toEqual(["q2", "q3", "q1", "q4"]);
    expect(split.waiting.map((e) => e.title)).toEqual(["fresh 2", "q3", "fresh 1", "stored 4"]);
    expect(ids(split.byDay)).toEqual(["x"]);
    // a row the hub lists under both is shown once, under Waiting
    const both = view([entry("q3", { createdAt: "2026-10-31T10:00:00Z" })], { questions: v.questions });
    const dup = splitWaiting(both, pins(entry("q3")));
    expect(ids(dup.waiting)).toEqual(["q3"]);
    expect(dup.byDay).toEqual([]);
  });
});

describe("why a row stayed behind the scenes", () => {
  it("says a replaced row was replaced, whatever else it holds", () => {
    expect(behindWhy(behindRow("a", { supersededBy: "n_2", level: "digest", reason: "Replaced" }))).toEqual({ key: "superseded" });
  });

  it("keeps the hub's reason on a row that waits for the digest or went into one", () => {
    expect(behindWhy(behindRow("a", { level: "digest", waiting: true, reason: "Quiet hours" }))).toEqual({ key: "waiting", reason: "Quiet hours" });
    expect(behindWhy(behindRow("b", { level: "digest", waiting: true }))).toEqual({ key: "waiting" });
    const digest = { id: "n_9", title: "Evening digest", createdAt: "2026-10-31T19:00:00Z" };
    expect(behindWhy(behindRow("c", { level: "digest", digest, reason: "Rate limit" }))).toEqual({ key: "inDigest", reason: "Rate limit" });
    expect(behindWhy(behindRow("d", { level: "digest", digest }))).toEqual({ key: "inDigest" });
  });

  it("says a row waits for the next digest only while the hub says so, and that an old one went into an earlier digest", () => {
    // Went into a digest sent before digests were linked to their items: digested, nothing to point at.
    expect(behindWhy(behindRow("a", { level: "digest" }))).toEqual({ key: "inEarlierDigest" });
    expect(behindWhy(behindRow("b", { level: "digest", reason: "Rate limit" }))).toEqual({ key: "inEarlierDigest", reason: "Rate limit" });
    expect(behindWhy(behindRow("c", { level: "digest", waiting: true }))).toEqual({ key: "waiting" });
  });

  it("gives a silent row its own reason, and an approval push its line", () => {
    expect(behindWhy(behindRow("a", { reason: "Muted by you" }))).toEqual({ key: "silent", reason: "Muted by you" });
    expect(behindWhy(behindRow("b"))).toEqual({ key: "silent" });
    expect(behindWhy(behindRow("c", { kind: "approval", level: "notify" }))).toEqual({ key: "approval" });
  });
});

describe("which notifications pop up", () => {
  it("pops up what reached the person: an alert, a question, a report or a digest, nothing else", () => {
    for (const kind of ["alert", "question", "report", "digest"] as const) expect(toastWorthy({ kind })).toBe(true);
    // Approval pushes have their own card; items stay behind the scenes.
    for (const kind of ["approval", "item"] as const) expect(toastWorthy({ kind })).toBe(false);
    // A row the hub held back (a muted schedule, quiet hours) carries why: it does not pop up.
    expect(toastWorthy({ kind: "alert", reason: "the trigger is muted by the user" })).toBe(false);
    expect(toastWorthy({ kind: "report", reason: "the trigger is muted by the user" })).toBe(false);
  });
});
