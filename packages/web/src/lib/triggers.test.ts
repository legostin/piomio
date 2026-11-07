import { describe, expect, it } from "vitest";
import { sectionForPath, takenBySection } from "../components/nav";
import {
  builtinSource,
  changedTrigger,
  checkText,
  configLines,
  describeMatch,
  errorMessage,
  formatMs,
  parseTimes,
  reasonText,
  runBadge,
  runNowText,
  sourceLabel,
  stageLines,
  statusBadge,
  toLocalInput,
  triggerUrl,
  TRIGGERS_API,
  webhookCheck,
  weekdayName,
} from "./triggers";

describe("triggers in the web UI", () => {
  it("talks to the core API, one base for every call", () => {
    expect(TRIGGERS_API).toBe("/api/triggers");
    expect(triggerUrl()).toBe("/api/triggers");
    expect(triggerUrl("tr_1")).toBe("/api/triggers/tr_1");
    expect(triggerUrl("tr_1", "runs")).toBe("/api/triggers/tr_1/runs");
    expect(triggerUrl("a/b", "run")).toBe("/api/triggers/a%2Fb/run");
  });

  it("is its own section at the address the plugin's page had", () => {
    expect(sectionForPath("/triggers")).toBe("triggers");
    expect(sectionForPath("/triggers/")).toBe("triggers");
    expect(takenBySection("/triggers")).toBe(true);
    expect(takenBySection("/memory")).toBe(false);
  });

  it("hears the engine's change events and nothing else", () => {
    expect(changedTrigger({ type: "plugin.event", data: { pluginId: "triggers", channel: "changed", payload: { id: "tr_1" } } })).toBe("tr_1");
    expect(changedTrigger({ type: "plugin.event", data: { pluginId: "triggers", channel: "changed", payload: null } })).toBe("");
    expect(changedTrigger({ type: "plugin.event", data: { pluginId: "memory", channel: "changed", payload: { id: "tr_1" } } })).toBeUndefined();
    expect(changedTrigger({ type: "plugin.event", data: { pluginId: "triggers", channel: "other", payload: {} } })).toBeUndefined();
  });

  it("shows an error code in the catalog's words, else the check's own words, labelled", () => {
    expect(errorMessage("dailyLimit", { max: 5 }, "Daily limit")).toBe("Daily run limit (5) reached");
    expect(errorMessage("noSuchCode", undefined, "boom")).toBe("As the check wrote it: boom");
    expect(errorMessage(undefined, undefined, "script threw")).toBe("As the check wrote it: script threw");
    expect(errorMessage(undefined, undefined, undefined)).toBe("");
  });

  it("names a run's reason, or shows an unknown one as it is", () => {
    expect(reasonText("manual")).toBe("manually");
    expect(reasonText("catch-up")).toBe("missed run");
    expect(reasonText("from-the-future")).toBe("from-the-future");
  });

  it("badges a run by what came of it", () => {
    expect(runBadge({ status: "started" })).toEqual({ label: "started", tone: "success" });
    expect(runBadge({ status: "started", outcome: "note" })).toEqual({ label: "note", tone: "info" });
    expect(runBadge({ status: "started", outcome: "drop" })).toEqual({ label: "dropped", tone: "neutral" });
    expect(runBadge({ status: "skipped" })).toEqual({ label: "skipped", tone: "warning" });
    // An error stays an error even when the pipeline had decided something before it failed.
    expect(runBadge({ status: "error", outcome: "note" })).toEqual({ label: "error", tone: "danger" });
  });

  it("keeps a working trigger quiet in the list", () => {
    expect(statusBadge({ kind: "schedule", enabled: true, state: {} })).toBeUndefined();
    expect(statusBadge({ kind: "schedule", enabled: true, state: { lastStatus: "ok" } })).toBeUndefined();
    expect(statusBadge({ kind: "schedule", enabled: false, state: {} })?.label).toBe("off");
    expect(statusBadge({ kind: "watch", enabled: true, state: { lastStatus: "error" } })?.tone).toBe("danger");
    expect(statusBadge({ kind: "once", enabled: true, state: { done: true } })?.label).toBe("done");
  });

  it("says what run now and check came to", () => {
    expect(runNowText({ status: "started" })).toEqual({ text: "Task started", ok: true });
    expect(runNowText({ status: "started", outcome: "note" }).text).toBe("Checked: kept a note, no task started");
    expect(runNowText({ status: "started", outcome: "drop" }).text).toBe("Checked: nothing worth a task");
    expect(runNowText({ status: "skipped", text: "The previous run has not finished yet" })).toEqual({ text: "Not started: The previous run has not finished yet", ok: false });
    expect(runNowText({ status: "skipped", code: "previousRunning" }).text).toBe("Not started: The previous run has not finished yet");
    expect(checkText({ changed: true })).toEqual({ text: "Something changed: the agent is started", ok: true });
    expect(checkText({ baseline: true }).text).toBe("Remembered the current value");
    expect(checkText({}).text).toBe("No changes");
    expect(checkText({ error: "x", code: "httpStatus", params: { url: "https://a.example", status: 503 } })).toEqual({ text: "Error: https://a.example responded with 503", ok: false });
  });

  it("knows the source each kind listens to", () => {
    expect(builtinSource("schedule")).toBe("time.cron");
    expect(builtinSource("heartbeat")).toBe("time.cron");
    expect(builtinSource("once")).toBe("time.at");
    expect(builtinSource("watch")).toBe("web.page");
    expect(builtinSource("event")).toBe("web.webhook");
    expect(builtinSource("signal")).toBeUndefined();
    expect(sourceLabel("hub.task.finished")).toBe("When a task finishes");
    expect(sourceLabel("composio.gmail_new_message")).toBeUndefined();
  });

  it("says which signature a signed webhook needs, and shows the shared secret only when that is what the hub checks", () => {
    expect(webhookCheck({ secret: "s3cr3t" })).toEqual({ kind: "secret", secret: "s3cr3t" });
    expect(webhookCheck({ secret: "s3cr3t", verify: { kind: "secret" } })).toEqual({ kind: "secret", secret: "s3cr3t" });
    // Signed: the hub refuses a delivery without the signature, so the stored shared secret would not let one in.
    expect(webhookCheck({ secret: "s3cr3t", verify: { kind: "github", secretRef: "vault://gh" } })).toEqual({ kind: "signed", text: "Checks the GitHub signature (x-hub-signature-256 header)" });
    expect(webhookCheck({ verify: { kind: "stripe", secretRef: "vault://st" } })).toEqual({ kind: "signed", text: "Checks the Stripe signature (stripe-signature header)" });
    expect(webhookCheck({ verify: { kind: "hmac-sha256", secretRef: "vault://h" } })).toEqual({ kind: "signed", text: "Checks the HMAC-SHA256 signature (x-signature header)" });
    expect(webhookCheck({ verify: { kind: "hmac-sha256", secretRef: "vault://h", header: "X-Hook-Signature" } })).toEqual({ kind: "signed", text: "Checks the HMAC-SHA256 signature (X-Hook-Signature header)" });
    expect(webhookCheck({})).toBeUndefined();
  });

  it("writes a source's settings one per line", () => {
    expect(configLines(undefined)).toEqual([]);
    expect(configLines({ toolkit: "gmail", labels: ["INBOX"], n: 3, skip: undefined })).toEqual(["toolkit: gmail", 'labels: ["INBOX"]', "n: 3"]);
  });

  it("puts a filter into words", () => {
    expect(describeMatch(undefined)).toBe("");
    expect(describeMatch({ path: "subject", contains: "invoice" })).toBe('subject contains "invoice"');
    expect(describeMatch({ path: "from", eq: "bank@example.com" })).toBe('from is "bank@example.com"');
    expect(describeMatch({ path: "amount", gt: 100 })).toBe("amount is over 100");
    expect(describeMatch({ path: "subject", matches: "^Re:", flags: "i" })).toBe("subject matches /^Re:/i");
    expect(describeMatch({ path: "label", in: ["a", "b"] })).toBe('label is one of ["a","b"]');
    expect(describeMatch({ path: "draft", exists: false })).toBe("draft is missing");
    expect(describeMatch({ not: { path: "spam", eq: true } })).toBe("not (spam is true)");
    expect(describeMatch({ all: [{ path: "a", eq: 1 }, { any: [{ path: "b", eq: 2 }, { path: "c", eq: 3 }] }] })).toBe("a is 1 and (b is 2 or c is 3)");
    expect(describeMatch({ all: [] })).toBe("");
  });

  it("lays out a run's stages: name, verdict, why, cost, logs", () => {
    const lines = stageLines([
      { stage: "match", verdict: "drop", why: "s1: the filter (where) leaves it out" },
      { stage: "script", ms: 12, logs: ["looked at 1 signal"], tokens: 0 },
      { stage: "triage", verdict: "wake", why: "the bank wrote", ms: 1430, tokens: 40 },
      { stage: "triage", error: "model offline" },
      { stage: "outcome", verdict: "something-new" },
    ]);
    expect(lines[0]).toEqual({ label: "Filter", verdict: { label: "dropped", tone: "neutral" }, why: "s1: the filter (where) leaves it out", logs: [] });
    expect(lines[1]).toEqual({ label: "Script", cost: formatMs(12), logs: ["looked at 1 signal"] });
    expect(lines[2].verdict).toEqual({ label: "woke the agent", tone: "success" });
    expect(lines[2].cost).toBe(`${formatMs(1430)} · 40 tokens`);
    expect(lines[3]).toEqual({ label: "Quick check", verdict: { label: "error", tone: "danger" }, error: "model offline", logs: [] });
    expect(lines[4].verdict).toEqual({ label: "something-new", tone: "neutral" });
    expect(stageLines(undefined)).toEqual([]);
  });

  it("formats durations", () => {
    expect(formatMs(12)).toMatch(/^12\s?ms$/);
    expect(formatMs(1430)).toMatch(/^1\.4\s?(s|sec)$/);
    expect(formatMs(999.6)).toMatch(/^1\s?(s|sec)$/);
  });

  it("fills the form's fields from what the hub stores", () => {
    expect(toLocalInput("2026-10-27T18:00:00Z", "Asia/Tokyo")).toBe("2026-10-28T03:00");
    expect(toLocalInput("2026-10-27T06:00:00Z", "UTC")).toBe("2026-10-27T06:00");
    expect(toLocalInput(undefined, "UTC")).toBe("");
    expect(toLocalInput("not a date", "UTC")).toBe("");
    expect(parseTimes("10:00, 18:00")).toEqual(["10:00", "18:00"]);
    expect(parseTimes(" 09:30  21:00 ,")).toEqual(["09:30", "21:00"]);
    expect(weekdayName(1)).toBe("Mon");
    expect(weekdayName(0)).toBe("Sun");
  });
});
