// Fake `claude` CLI for tests: emits stream-json like Claude Code 2.x. `auth login` behaves like Claude Code without a
// terminal: prints the sign-in page, then reads the code from stdin ("good-code#xyz" signs in, HOME/.claude/.credentials.json).
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const credentials = join(process.env.HOME || homedir(), ".claude", ".credentials.json");
const login = args[0] === "auth" && args[1] === "login";
if (args[0] === "--version") {
  console.log("9.9.9 (Claude Code)");
  process.exit(0);
}
if (args[0] === "--help") {
  console.log(
    [
      "Usage: claude [options] [command] [prompt]",
      "",
      "Options:",
      "  --effort <level>                      Effort level for the current session",
      "                                        (low, medium, high, xhigh, max)",
      "  --model <model>                       Model for the current session. Provide",
      "                                        an alias for the latest model (e.g.",
      "                                        'fable', 'opus', or 'sonnet') or a",
      "                                        model's full name.",
      "  --system-prompt-snapshot <on|off>     Record the system prompt once per",
      "                                        conversation and reuse it verbatim.",
    ].join("\n"),
  );
  process.exit(0);
}
// Every run's arguments, for tests that check what the brain passed.
if (process.env.FAKE_ARGS_FILE) appendFileSync(process.env.FAKE_ARGS_FILE, `${JSON.stringify(args)}\n`);
// The switches the brain set for each run.
if (process.env.FAKE_ENV_FILE) {
  const { DISABLE_AUTOUPDATER, DISABLE_TELEMETRY } = process.env;
  appendFileSync(process.env.FAKE_ENV_FILE, `${JSON.stringify({ DISABLE_AUTOUPDATER, DISABLE_TELEMETRY })}\n`);
}
if (login) {
  console.log("Opening browser to sign in…");
  console.log("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=fake&response_type=code&state=xyz");
  process.stdout.write("Paste code here if prompted > ");
  let line = "";
  process.stdin.on("data", (c) => {
    line += c;
    if (!line.includes("\n")) return;
    if (line.trim() === "good-code#xyz") {
      mkdirSync(join(credentials, ".."), { recursive: true });
      writeFileSync(credentials, "{}");
      console.log("Login successful.");
      process.exit(0);
    }
    console.log("Login failed: Request failed with status code 400");
    process.exit(1);
  });
} else if (args[0] === "auth") {
  console.log(JSON.stringify({ loggedIn: process.env.FAKE_LOGGED_IN === "1" || existsSync(credentials), authMethod: "claude.ai" }));
  process.exit(0);
}
// A turn: stream-json user messages on stdin (each echoed back with --replay-user-messages when taken). "SLOW" runs a
// tool for a moment; messages that arrive meanwhile are taken after it and answered in the same turn ("also:<text>").
// "LATE" answers without taking them: they get a turn of their own after it. The CLI exits when stdin closes.
if (!login) {
  const replay = args.includes("--replay-user-messages");
  const resume = args.includes("--resume") ? args[args.indexOf("--resume") + 1] : undefined;
  if (resume === "missing") {
    process.stderr.write("No conversation found with session ID: missing\n");
    process.exit(1);
  }
  // A conversation too full to go on (its own compaction did not save it).
  if (resume === "full") {
    out({ type: "system", subtype: "init", session_id: "full", mcp_servers: [{ name: "piomio", status: "connected" }] });
    out({ type: "result", subtype: "success", is_error: true, result: "Prompt is too long", session_id: "full", usage: {} });
    process.exit(1);
  }
  const sid = resume ?? "sess-1";
  let model = args.includes("--model") ? args[args.indexOf("--model") + 1] : "default";
  let effort = args.includes("--effort") ? args[args.indexOf("--effort") + 1] : undefined;
  const queue = [];
  let ended = false;
  let wake;
  const textOf = (m) => m?.message?.content?.find?.((b) => b.type === "text")?.text ?? "";
  const take = () => {
    const m = queue.shift();
    if (replay) out({ type: "user", message: m.message, session_id: sid, isReplay: true });
    return textOf(m);
  };
  let buf = "";
  process.stdin.on("data", (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      // Control requests change how it thinks at once, as Claude Code does (set_model, apply_flag_settings).
      if (msg.type === "control_request") {
        if (msg.request?.subtype === "set_model") model = msg.request.model;
        if (msg.request?.subtype === "apply_flag_settings" && msg.request.settings?.effortLevel) effort = msg.request.settings.effortLevel;
        out({ type: "control_response", response: { subtype: "success", request_id: msg.request_id } });
        continue;
      }
      queue.push(msg);
      wake?.();
    }
  });
  process.stdin.on("end", () => {
    ended = true;
    wake?.();
  });
  const next = () => new Promise((r) => (queue.length || ended ? r() : (wake = r)));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let turns = 0;
  while (true) {
    await next();
    wake = undefined;
    if (!queue.length) break;
    const input = take();
    turns++;
    if (input.includes("LIMIT")) {
      out({ type: "system", subtype: "init", session_id: sid, mcp_servers: [{ name: "piomio", status: "connected" }] });
      out({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1893456000, rateLimitType: "five_hour" } });
      out({ type: "result", subtype: "success", is_error: true, result: "Claude AI usage limit reached|1893456000", session_id: sid, usage: {} });
      process.exit(1);
    }
    out({ type: "system", subtype: "init", session_id: sid, mcp_servers: [{ name: "piomio", status: "connected" }] });
    // "LATE": answers after a moment without taking what arrived meanwhile, which then gets a turn of its own.
    if (input.endsWith("LATE")) {
      await sleep(Number(process.env.FAKE_SLOW_MS ?? 400));
      out({ type: "assistant", message: { id: `l${turns}`, content: [{ type: "text", text: "late done" }] }, parent_tool_use_id: null, session_id: sid });
      out({ session_id: sid, type: "result", subtype: "success", is_error: false, result: "done", usage: { input_tokens: 1, output_tokens: 1 } });
      continue;
    }
    if (input.endsWith("SLOW")) {
      out({ type: "assistant", message: { id: `s${turns}`, content: [{ type: "tool_use", id: "tu-slow", name: "Bash", input: { command: "sleep" } }] }, parent_tool_use_id: null, session_id: sid });
      await sleep(Number(process.env.FAKE_SLOW_MS ?? 400));
      out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu-slow", content: "slept" }] }, parent_tool_use_id: null, session_id: sid });
      const also = [];
      while (queue.length) also.push(take());
      out({ type: "assistant", message: { id: `a${turns}`, content: [{ type: "text", text: `slow done${also.map((a) => ` also:${a}`).join("")}` }] }, parent_tool_use_id: null, session_id: sid });
      out({ session_id: sid, type: "result", subtype: "success", is_error: false, result: "done", usage: { input_tokens: 1, output_tokens: 1 } });
      continue;
    }
    out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `echo:${input}` } }, parent_tool_use_id: null, api_message_id: `m1-${turns}`, session_id: sid });
    out({ type: "assistant", message: { id: `m1-${turns}`, content: [{ type: "text", text: `echo:${input}` }, { type: "tool_use", id: "tu1", name: "mcp__piomio__notify", input: { level: "silent", title: "x" } }] }, parent_tool_use_id: null, session_id: sid });
    out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: [{ type: "text", text: "ok" }] }] }, parent_tool_use_id: null, session_id: sid });
    out({ type: "assistant", message: { id: `m2-${turns}`, content: [{ type: "text", text: `resume=${resume ?? "none"} model=${model}${effort ? ` effort=${effort}` : ""}` }] }, parent_tool_use_id: null, session_id: sid });
    out({ type: "assistant", message: { id: `m3-${turns}`, content: [{ type: "text", text: "subagent text" }] }, parent_tool_use_id: "tu9", session_id: sid });
    out({ session_id: sid, type: "result", subtype: "success", is_error: false, result: "done", total_cost_usd: 0.01, usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 3 } });
  }
  process.exit(0);
}
