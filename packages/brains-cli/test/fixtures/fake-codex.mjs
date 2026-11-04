// Fake `codex` CLI for tests: `--version`, `login status`, and `login --device-auth`, which prints the sign-in page and
// a one-time code the way Codex 0.164 does (colours included), then "signs in" (writes HOME/.codex/auth.json) and
// exits 0. The mode comes from FAKE_CODEX_LOGIN or the file HOME/.fake-codex-login: "ok" (default), "fail" or "hang".
// `app-server` speaks the v2 JSON-RPC the brain uses (turn/start, turn/steer, turn/interrupt); FAKE_CODEX_NO_APP=1
// makes it an old Codex without one. `exec --json` answers "exec:<input>".
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const home = process.env.HOME || homedir();
const auth = join(home, ".codex", "auth.json");

if (args[0] === "--version") {
  console.log("codex-cli 9.9.9");
  process.exit(0);
}
if (args[0] === "login" && args[1] === "status") {
  console.log(existsSync(auth) ? "Logged in using ChatGPT" : "Not logged in");
  process.exit(existsSync(auth) ? 0 : 1);
}
if (args[0] === "login" && args.includes("--device-auth")) {
  const modeFile = join(home, ".fake-codex-login");
  const mode = process.env.FAKE_CODEX_LOGIN || (existsSync(modeFile) ? readFileSync(modeFile, "utf8").trim() : "ok");
  const blue = (s) => `\x1b[94m${s}\x1b[0m`;
  const grey = (s) => `\x1b[90m${s}\x1b[0m`;
  process.stdout.write(
    `\nWelcome to Codex [v${grey("9.9.9")}]\n${grey("OpenAI's command-line coding agent")}\n\n` +
      "Follow these steps to sign in with ChatGPT using device code authorization:\n\n" +
      `1. Open this link in your browser and sign in to your account\n   ${blue("https://auth.openai.com/codex/device")}\n\n` +
      `2. Enter this one-time code ${grey("(expires in 15 minutes)")}\n   ${blue("ABCD-EFGHI")}\n\n` +
      `${grey("Continue only if you started this login in Codex. If a website or another person gave you this code, cancel.")}\n\n`,
  );
  if (mode === "hang") setInterval(() => {}, 1000);
  else
    setTimeout(() => {
      if (mode === "fail") {
        console.error("Error logging in: the device code was declined");
        process.exit(1);
      }
      mkdirSync(join(home, ".codex"), { recursive: true });
      writeFileSync(auth, "{}");
      console.log("Successfully logged in");
      process.exit(0);
    }, Number(process.env.FAKE_CODEX_DELAY_MS ?? 400));
} else if (args[0] === "app-server") {
  if (process.env.FAKE_CODEX_NO_APP === "1") {
    console.error("error: unrecognized subcommand 'app-server'");
    process.exit(2);
  }
  appServer();
} else if (args[0] === "exec") {
  if (process.env.FAKE_ARGS_FILE) appendFileSync(process.env.FAKE_ARGS_FILE, `${JSON.stringify({ args })}\n`);
  let input = "";
  process.stdin.on("data", (c) => (input += c));
  process.stdin.on("end", () => {
    const resume = args.includes("resume") ? args[args.indexOf("resume") + 1] : undefined;
    const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
    send({ type: "thread.started", thread_id: resume ?? "th-exec" });
    send({ type: "item.completed", item: { id: "i1", type: "agent_message", text: `exec:${input}` } });
    send({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } });
    process.exit(0);
  });
} else {
  console.error(`fake codex: unsupported arguments ${args.join(" ")}`);
  process.exit(2);
}

function appServer() {
  // One line per process that started, for tests that count them.
  if (process.env.FAKE_CODEX_SPAWNS) appendFileSync(process.env.FAKE_CODEX_SPAWNS, `${process.pid}\n`);
  const send = (o) => process.stdout.write(JSON.stringify(o) + "\n");
  const note = (method, params) => send({ method, params });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let threadId;
  let model = "default";
  let effort;
  /** The turn goes on in a thread resumed from before ("FULL" overflows only such a thread). */
  let resumed = false;
  let turn; // { id, steered: string[], wake?, interrupted }
  let turns = 0;
  const textOf = (input) => (input ?? []).filter((i) => i.type === "text").map((i) => i.text).join("");
  const agent = (id, text) => {
    note("item/started", { item: { type: "agentMessage", id, text: "" }, threadId, turnId: turn.id });
    note("item/agentMessage/delta", { threadId, turnId: turn.id, itemId: id, delta: text });
    note("item/completed", { item: { type: "agentMessage", id, text }, threadId, turnId: turn.id });
  };
  const complete = (status, error = null) => {
    note("thread/tokenUsage/updated", { threadId, turnId: turn.id, tokenUsage: { last: { inputTokens: 7, outputTokens: 2 }, total: {} } });
    note("turn/completed", { threadId, turn: { id: turn.id, items: [], status, error } });
    turn = undefined;
  };
  async function runTurn(text) {
    note("turn/started", { threadId, turn: { id: turn.id, status: "inProgress" } });
    note("item/started", { item: { type: "userMessage", id: "u", content: [{ type: "text", text }] }, threadId, turnId: turn.id });
    if (text.includes("LIMIT")) {
      const error = { message: "You've hit your usage limit. Try again in 2 hours.", codexErrorInfo: "usageLimitExceeded" };
      note("error", { error, willRetry: false, threadId, turnId: turn.id });
      return complete("failed", error);
    }
    if (text.endsWith("FULL") && resumed) {
      const error = { message: "Codex ran out of room in the model's context window.", codexErrorInfo: "contextWindowExceeded" };
      note("error", { error, willRetry: false, threadId, turnId: turn.id });
      return complete("failed", error);
    }
    if (text.endsWith("SLOW")) {
      note("item/started", { item: { type: "commandExecution", id: "c1", command: "sleep 1" }, threadId, turnId: turn.id });
      await new Promise((r) => {
        turn.wake = r;
        setTimeout(r, Number(process.env.FAKE_SLOW_MS ?? 400));
      });
      if (turn.interrupted) return complete("interrupted");
      note("item/completed", { item: { type: "commandExecution", id: "c1", command: "sleep 1", aggregatedOutput: "slept", exitCode: 0 }, threadId, turnId: turn.id });
      const also = turn.steered.splice(0);
      for (const a of also) note("item/started", { item: { type: "userMessage", id: "u2", content: [{ type: "text", text: a }] }, threadId, turnId: turn.id });
      agent("a1", `slow done${also.map((a) => ` also:${a}`).join("")}`);
      return complete("completed");
    }
    agent("a1", `echo:${text}`);
    note("item/started", { item: { type: "mcpToolCall", id: "m1", server: "piomio", tool: "notify", arguments: { title: "x" }, status: "inProgress" }, threadId, turnId: turn.id });
    note("item/completed", { item: { type: "mcpToolCall", id: "m1", server: "piomio", tool: "notify", status: "completed", result: { content: [{ type: "text", text: "ok" }] } }, threadId, turnId: turn.id });
    agent("a2", `thread=${threadId} model=${model}${effort ? ` effort=${effort}` : ""}`);
    complete("completed");
  }
  let buf = "";
  process.stdin.on("data", (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) handle(JSON.parse(line));
    }
  });
  process.stdin.on("end", () => process.exit(0));
  function handle(m) {
    const ok = (result) => send({ id: m.id, result });
    const fail = (message) => send({ id: m.id, error: { code: -32600, message } });
    const p = m.params ?? {};
    switch (m.method) {
      case "initialize":
        return ok({ userAgent: "fake/9.9.9" });
      case "initialized":
        return;
      case "thread/start":
        // What the brain asked for, for tests that check it: the -c overrides and the thread's sandbox and approvals.
        if (process.env.FAKE_ARGS_FILE) appendFileSync(process.env.FAKE_ARGS_FILE, `${JSON.stringify({ args, sandbox: p.sandbox, approvalPolicy: p.approvalPolicy, ephemeral: p.ephemeral, baseInstructions: p.baseInstructions, serviceTier: "serviceTier" in p ? p.serviceTier : "absent" })}\n`);
        threadId = `th-${process.pid}`;
        model = p.model ?? "default";
        note("thread/started", { thread: { id: threadId } });
        // FAKE_CODEX_SANDBOX: the sandbox the thread says it runs in ("dangerFullAccess": a Codex that ignored the profile).
        return ok({ thread: { id: threadId }, model, ...(process.env.FAKE_CODEX_SANDBOX ? { sandbox: { type: process.env.FAKE_CODEX_SANDBOX } } : {}) });
      case "thread/resume":
        if (process.env.FAKE_ARGS_FILE) appendFileSync(process.env.FAKE_ARGS_FILE, `${JSON.stringify({ args, resume: p.threadId, serviceTier: "serviceTier" in p ? p.serviceTier : "absent" })}\n`);
        if (p.threadId === "missing") return fail("thread not found");
        threadId = p.threadId;
        resumed = true;
        model = p.model ?? "default";
        return ok({ thread: { id: threadId }, model });
      case "model/list":
        return ok({
          data: [
            { id: "gpt-fast", model: "gpt-fast", displayName: "GPT Fast", description: "", hidden: false, isDefault: false, defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }] },
            { id: "gpt-main", model: "gpt-main", displayName: "GPT Main", description: "", hidden: false, isDefault: true, defaultReasoningEffort: "medium", supportedReasoningEfforts: ["low", "medium", "high", "xhigh"].map((reasoningEffort) => ({ reasoningEffort })) },
            { id: "gpt-old", model: "gpt-old", displayName: "Old", description: "", hidden: true, isDefault: false, defaultReasoningEffort: "medium", supportedReasoningEfforts: [] },
          ],
          nextCursor: null,
        });
      case "turn/start": {
        if (p.effort) effort = p.effort;
        // A thread already open takes another model with the turn.
        if (p.model) model = p.model;
        turn = { id: `turn-${++turns}`, steered: [], interrupted: false };
        ok({ turn: { id: turn.id, status: "inProgress", items: [] } });
        void sleep(20).then(() => runTurn(textOf(p.input)));
        return;
      }
      case "turn/steer":
        if (!turn || turn.id !== p.expectedTurnId) return fail("no active turn to steer");
        turn.steered.push(textOf(p.input));
        return ok({ turnId: turn.id });
      case "turn/interrupt":
        // A Codex that never ends the turn it was told to stop.
        if (process.env.FAKE_CODEX_STUCK === "1") return ok({});
        if (turn) {
          turn.interrupted = true;
          turn.wake?.();
        }
        return ok({});
      default:
        return fail(`unknown method ${m.method}`);
    }
  }
}
