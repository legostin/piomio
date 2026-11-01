// Fake `kimi` (Kimi Code CLI) for tests: `--version`; `login`, which prints the device page and code the way Kimi Code
// 2.4 does, then "signs in" (writes HOME/.kimi-code/credentials/kimi-code.json) and exits 0; and `acp`, an Agent Client
// Protocol agent that answers "Authentication required" until signed in. The prompt's first word picks a script:
// HELLO, TOOL (Bash, asks permission), WRITE, MCP (a hub tool), ASK (AskUserQuestion), SLOW (waits for session/cancel),
// LIMIT (a rate-limit error). Every request it gets is appended as JSON to FAKE_KIMI_LOG.
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const home = process.env.HOME || homedir();
const creds = join(home, ".kimi-code", "credentials", "kimi-code.json");
const log = (o) => process.env.FAKE_KIMI_LOG && appendFileSync(process.env.FAKE_KIMI_LOG, JSON.stringify(o) + "\n");

if (args[0] === "--version") {
  console.log("2.4.1");
  process.exit(0);
}
if (args[0] === "login") {
  log({ login: true, path: process.env.PATH });
  process.stderr.write(
    "\nOpening browser for Kimi device login: https://www.kimi.ai/code/authorize_device?user_code=IN1G-ZJ3X\n" +
      "If the browser did not open, paste the URL above and enter code: IN1G-ZJ3X\nCode expires in 1800s.\nWaiting for authorization to complete…\n",
  );
  setTimeout(() => {
    mkdirSync(join(home, ".kimi-code", "credentials"), { recursive: true });
    writeFileSync(creds, "{}");
    process.stderr.write("Logged in to Kimi Code.\n");
    process.exit(0);
  }, 150);
} else if (args[0] === "acp") {
  const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
  const waiting = new Map();
  let nextId = 1000;
  const ask = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      waiting.set(id, resolve);
      send({ id, method, params });
    });
  const update = (sessionId, u) => send({ method: "session/update", params: { sessionId, update: u } });
  let cancelled;
  const config = (model = "k3", thinking = "high", mode = "default") => [
    { type: "select", id: "model", category: "model", currentValue: model, options: [{ value: "k3", name: "K3", description: "Kimi's flagship" }, { value: "kimi-for-coding", name: "Kimi for Coding" }] },
    { type: "select", id: "thinking", category: "thought_level", currentValue: thinking, options: ["off", "low", "high", "max"].map((v) => ({ value: v, name: v })) },
    { type: "select", id: "mode", category: "mode", currentValue: mode, options: ["default", "plan", "auto", "yolo"].map((v) => ({ value: v, name: v })) },
  ];
  const state = { model: "k3", thinking: "high", mode: "default" };
  const opened = (sessionId) => ({ sessionId, configOptions: config(state.model, state.thinking, state.mode), modes: { currentModeId: state.mode } });

  async function prompt(id, p) {
    const text = (p.prompt ?? []).find((b) => b.type === "text")?.text ?? "";
    const s = p.sessionId;
    const word = text.split(/\s/)[0];
    if (!existsSync(creds)) return send({ id, error: { code: -32000, message: "Authentication required" } });
    if (word === "LIMIT") return send({ id, error: { code: -32603, message: "Rate limit reached for your plan, try again in 2 hours" } });
    if (word === "HELLO") {
      update(s, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking…" } });
      update(s, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hi " } });
      update(s, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "there" } });
      return send({ id, result: { stopReason: "end_turn" } });
    }
    if (word === "TOOL" || word === "WRITE" || word === "MCP" || word === "ASK") {
      const name = { TOOL: "Bash", WRITE: "Write", MCP: "mcp__piomio__hub_note", ASK: "AskUserQuestion" }[word];
      const kind = { TOOL: "execute", WRITE: "edit", MCP: "other", ASK: "other" }[word];
      const input = { TOOL: { command: "ls -la" }, WRITE: { path: "/etc/hosts", content: "x" }, MCP: { text: "hi" }, ASK: { questions: [] } }[word];
      const tc = `t1:${name}`;
      update(s, { sessionUpdate: "tool_call", toolCallId: tc, title: name, kind, status: "pending", content: [] });
      update(s, { sessionUpdate: "tool_call_update", toolCallId: tc, title: word === "TOOL" ? "List the files" : name, kind, status: "in_progress", rawInput: input });
      const r = await ask("session/request_permission", {
        sessionId: s,
        toolCall: { toolCallId: tc, title: name, content: [{ type: "content", content: { type: "text", text: `Requesting approval to run ${name}` } }] },
        options: [
          { optionId: "approve_once", name: "Approve once", kind: "allow_once" },
          { optionId: "approve_always", name: "Approve for this session", kind: "allow_always" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      });
      log({ permission: name, outcome: r.outcome });
      const ok = r.outcome?.optionId === "approve_once";
      update(s, { sessionUpdate: "tool_call_update", toolCallId: tc, status: ok ? "completed" : "failed", content: [{ type: "content", content: { type: "text", text: ok ? "file.txt" : "rejected" } }], rawOutput: ok ? "file.txt" : "rejected" });
      update(s, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: ok ? "done" : "not allowed" } });
      return send({ id, result: { stopReason: "end_turn" } });
    }
    if (word === "SLOW") {
      update(s, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "working" } });
      await new Promise((r) => (cancelled = r));
      return send({ id, result: { stopReason: "cancelled" } });
    }
    update(s, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `echo:${text}` } });
    send({ id, result: { stopReason: "end_turn" } });
  }

  createInterface({ input: process.stdin }).on("line", (line) => {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.id !== undefined && !m.method) {
      waiting.get(m.id)?.(m.result ?? {});
      waiting.delete(m.id);
      return;
    }
    log({ method: m.method, params: m.params });
    const p = m.params ?? {};
    switch (m.method) {
      case "initialize":
        return send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [{ id: "login", type: "terminal", name: "Login with Kimi account" }], agentInfo: { name: "Kimi Code CLI", version: "2.4.1" } } });
      case "session/new":
        if (!existsSync(creds)) return send({ id: m.id, error: { code: -32000, message: "Authentication required" } });
        return send({ id: m.id, result: opened(process.env.FAKE_KIMI_SESSION || "s1") });
      case "session/resume":
        if (p.sessionId === "gone") return send({ id: m.id, error: { code: -32602, message: "Unknown session gone" } });
        return send({ id: m.id, result: opened(p.sessionId) });
      case "session/set_mode":
        state.mode = p.modeId;
        return send({ id: m.id, result: {} });
      case "session/set_config_option":
        if (p.configId === "model") state.model = p.value;
        if (p.configId === "thinking") state.thinking = p.value;
        return send({ id: m.id, result: { configOptions: config(state.model, state.thinking, state.mode) } });
      case "session/delete":
        return send({ id: m.id, result: {} });
      case "session/prompt":
        return void prompt(m.id, p);
      case "session/cancel":
        return cancelled?.();
      default:
        if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } });
    }
  });
} else {
  process.stderr.write(`fake kimi: unknown arguments ${args.join(" ")}\n`);
  process.exit(2);
}
