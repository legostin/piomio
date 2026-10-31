// Scriptable brain for core integration tests.
// "CALL <tool> <json>" calls a hub tool over MCP; "LIMIT" makes brain `fake` hit its limit; "PROMPT?" echoes the instructions.
// Group chats: "HANDOFF <id>" on the last line replies "over to @<id>"; "ECHO?" anywhere echoes the turn's "[...]" lines;
// "SLOW" at the end of the last line keeps the turn going until it is interrupted (or 5 s pass), "BRIEF" for 0.8 s.
// Brain `fake` takes input into such a turn (steer): the turn then ends with "fake also heard: <its last line>";
// `fake2` cannot steer, so the hub sends it as the next turn.
// "TIME?" answers with the turn's "[Now: …]" line (or "none"); a turn with files answers with their paths and the note.
// "SELF?" answers with the last "[You now]" block the session got (or "none"); "INPUT?" with the rest of the turn's input.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PluginContext } from "@piomio/plugin-sdk";
import type { BrainEvent, BrainSessionOptions } from "@piomio/shared";

/** Sessions in a "SLOW" turn: interrupt() ends it, and so does input steered into it. */
const selves = new Map<string, string>();
const slow = new Map<string, () => void>();
const steered = new Map<string, string[]>();
/** The model and effort of each turn, by session. */
const used = new Map<string, string[]>();
/** Sessions the hub got ready ahead of a turn (warm). */
const warmed = new Set<string>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lastLine = (text: string) => text.trim().split("\n").at(-1) ?? "";

async function mcpCall(o: BrainSessionOptions, name: string, args: unknown): Promise<{ text: string; isError: boolean }> {
  const r = await fetch(o.mcp.url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${o.mcp.token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const j: any = await r.json();
  if (j.error) return { text: j.error.message, isError: true };
  return { text: (j.result.content ?? []).map((c: any) => c.text ?? "").join("\n"), isError: !!j.result.isError };
}

export default {
  async activate(ctx: PluginContext) {
    ctx.tools.register({
      name: "send",
      description: "Send a message somewhere (external effect)",
      effect: "external",
      approvalSummary: "Отправить {text}",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      handler: async (input: { text: string }) => `sent: ${input.text}`,
    });
    for (const id of ["fake", "fake2"]) {
      ctx.brains.register({
        id,
        label: id,
        variants: id === "fake2" ? ["a", "b"] : undefined,
        // `fake` thinks with two models and three efforts; `fake2` has no choice.
        probe: async () =>
          id === "fake"
            ? {
                available: true,
                authenticated: true,
                models: ["quick", "smart"],
                modelNames: { quick: "Quick", smart: "Smart" },
                efforts: ["low", "medium", "high"],
                presets: { fast: { model: "quick", effort: "low" }, balanced: { model: "smart", effort: "medium" }, deep: { model: "smart", effort: "high" } },
              }
            : { available: true, authenticated: true },
        createSession: async (o: BrainSessionOptions) => ({
          async *send(raw): AsyncGenerator<BrainEvent> {
            // The hub may choose the model and effort per turn: the session thinks so from here on.
            if (raw.model) o = { ...o, model: raw.model };
            if (raw.effort) o = { ...o, effort: raw.effort };
            used.set(o.sessionId, [...(used.get(o.sessionId) ?? []), `${o.model ?? "default"}/${o.effort ?? "default"}`]);
            // The hub's "[Now: …]" line comes first; the scripts below read the rest.
            const clock = /^\[Now: [^\]]*\]\n/.exec(raw.text)?.[0].trim();
            let rest = clock ? raw.text.slice(clock.length + 1) : raw.text;
            // Then the "[You now]" block, when it changed: kept for "SELF?".
            const self = /^\[You now\]\n[\s\S]*?\n\n/.exec(rest)?.[0];
            if (self) {
              selves.set(o.sessionId, self.trim());
              rest = rest.slice(self.length);
            }
            const turn = { ...raw, text: rest };
            if (lastLine(turn.text) === "SELF?") {
              yield { type: "text", delta: `${id} self: ${selves.get(o.sessionId) ?? "none"}` };
              yield { type: "done", resumeToken: `${id}-resume` };
              return;
            }
            // The model and effort this session was opened with.
            if (lastLine(turn.text.replace(/\n+When you are done[^\n]*\s*$/, "")) === "THINKING?") {
              yield { type: "text", delta: `${id} thinks: model=${o.model ?? "default"} effort=${o.effort ?? "default"}` };
              yield { type: "done", resumeToken: `${id}-resume` };
              return;
            }
            // What this session knows of the conversation before it: the recap it started with, or the one for a lost resume.
            if (lastLine(turn.text) === "RECAP?") {
              const fresh = /^\[System\] Your session in this conversation was renewed[\s\S]*?\n\n---\n/.exec(turn.text)?.[0];
              yield { type: "text", delta: fresh ? `${id} started from: ${fresh.replace(/\s+/g, " ").trim()}` : `${id} backup: ${turn.recap ? "yes" : "none"}` };
              yield { type: "done", resumeToken: `${id}-resume` };
              return;
            }
            // The turn's whole input after those two blocks: the notes the hub put before the user's words.
            if (lastLine(turn.text) === "INPUT?") {
              yield { type: "text", delta: `${id} input: ${turn.text}` };
              yield { type: "done", resumeToken: `${id}-resume` };
              return;
            }
            // Whether the hub got this session ready ahead of the turn, and whether it keeps it warm.
            // How each turn of this session thought, oldest first.
            if (lastLine(turn.text) === "MODELS?") {
              yield { type: "text", delta: `${id} used: ${(used.get(o.sessionId) ?? []).join(", ")}` };
              yield { type: "done", resumeToken: `${id}-resume` };
              return;
            }
            if (lastLine(turn.text.replace(/\n+When you are done[^\n]*\s*$/, "")) === "WARM?") {
              yield { type: "text", delta: `${id} warm: ${warmed.has(o.sessionId) ? "yes" : "no"} keep: ${!!o.keepWarm} desk: ${!!o.frontDesk}` };
              yield { type: "done", resumeToken: `${id}-resume` };
              return;
            }
            if (turn.text.trim() === "TIME?") {
              yield { type: "text", delta: `${id} time: ${clock ?? "none"}` };
              yield { type: "done", resumeToken: `${id}-resume` };
              return;
            }
            // Files with the message: where each one is in this session's workspace, and the hub's note.
            const noteAt = turn.text.search(/(?<=^|\n)\[The user attached/);
            if (noteAt >= 0) {
              const files = (turn.attachments ?? []).map((a) => `${a}:${existsSync(join(o.workspace, a)) ? "here" : "missing"}`);
              yield { type: "text", delta: `${id} files: ${files.join(", ") || "none"} | note: ${turn.text.slice(noteAt).split("\n").join(" / ")}` };
              yield { type: "done", resumeToken: `${id}-resume` };
              return;
            }
            if (id === "fake" && turn.text.includes("LIMIT")) {
              yield { type: "limit_hit", resetAt: new Date(Date.now() + 3600_000).toISOString(), detail: "fake limit" };
              yield { type: "done" };
              return;
            }
            // Only the turn's own last line: a fresh session's prompt carries the dialog so far.
            if (/^THINK\b/.test(turn.text.trim().split("\n").at(-1) ?? "")) {
              // Narration, a native tool, then the answer: how a real brain replies after using tools.
              yield { type: "text", delta: "Let me look." };
              yield { type: "tool_call", id: "t1", name: "Read", input: { path: "notes.md" } };
              yield { type: "tool_result", id: "t1", output: "the notes" };
              yield { type: "text", delta: `${id} found it` };
              yield { type: "done", resumeToken: `${id}-resume` };
              return;
            }
            // The instructions this session was opened with.
            if ((turn.text.trim().split("\n").at(-1) ?? "") === "PROMPT?") {
              yield { type: "text", delta: `${id} prompt: ${o.agent.prompt} | in system prompt: ${o.systemPrompt.includes(o.agent.prompt)}` };
              yield { type: "done", resumeToken: `${id}-resume` };
              return;
            }
            // A task's first turn ends with the hub's "When you are done…" line: its goal counts as the last line.
            const last = lastLine(turn.text.replace(/\n+When you are done[^\n]*\s*$/, ""));
            if (last.endsWith("SLOW") || last.endsWith("BRIEF")) {
              yield { type: "text", delta: `${id} is thinking` };
              await new Promise<void>((resolve) => {
                slow.set(o.sessionId, resolve);
                setTimeout(resolve, last.endsWith("SLOW") ? 5000 : 800);
              });
              slow.delete(o.sessionId);
              const more = steered.get(o.sessionId) ?? [];
              steered.delete(o.sessionId);
              if (more.length) {
                // After the hub has heard that the input was taken (it starts a new message for the rest).
                await sleep(150);
                yield { type: "text", delta: `${id} also heard: ${more.map(lastLine).join(" + ")}` };
              }
              yield { type: "done", resumeToken: `${id}-resume` };
              return;
            }
            const handoff = /HANDOFF (\S+)$/.exec(turn.text.trim().split("\n").at(-1) ?? "");
            if (handoff) {
              yield { type: "text", delta: `over to @${handoff[1]}` };
              yield { type: "done", resumeToken: `${id}-resume` };
              return;
            }
            if (turn.text.includes("ECHO?")) {
              const seen = turn.text.split("\n").filter((l) => l.startsWith("["));
              yield { type: "text", delta: `${id} saw: ${seen.join(" | ")}` };
              yield { type: "done", resumeToken: `${id}-resume` };
              return;
            }
            const m = /CALL (\S+) (\{.*\})/.exec(turn.text);
            if (m && !turn.text.includes("[System]")) {
              yield { type: "tool_call", id: "c1", name: m[1], input: JSON.parse(m[2]) };
              const r = await mcpCall(o, m[1], JSON.parse(m[2]));
              yield { type: "tool_result", id: "c1", output: r.text, isError: r.isError };
              yield { type: "text", delta: `tool said: ${r.text}` };
            } else {
              const last = turn.text.trim().split("\n").at(-1);
              yield { type: "text", delta: `${id} heard: ${last}` };
            }
            yield { type: "done", resumeToken: `${id}-resume` };
          },
          ...(id === "fake"
            ? {
                steer(turn: { text: string }) {
                  const wake = slow.get(o.sessionId);
                  if (!wake) return false;
                  steered.set(o.sessionId, [...(steered.get(o.sessionId) ?? []), turn.text]);
                  wake();
                  return true;
                },
              }
            : {}),
          warm() {
            warmed.add(o.sessionId);
          },
          interrupt() {
            slow.get(o.sessionId)?.();
          },
          close() {},
        }),
      });
    }
  },
};
