// code_search and code_execute: code mode (code-mode.ts). The agent finds its tools as functions and runs a script that
// calls them; the person turns it on per agent (AgentDef.codeMode), and without that neither tool exists for the agent
// (ToolGateway.listed).

import type { ToolDescriptor, ToolResult } from "@piomio/shared";
import type { AuditLog } from "../audit.ts";
import { CODE_EXECUTE, CODE_SEARCH, describeCodeRun, describeFound, describeSaved, runCode, searchSaved, searchTools, type CodeDeps, type SavedScript } from "../code-mode.ts";
import { MAX_SCRIPT_BYTES } from "../signals/sandbox.ts";
import type { Store } from "../store.ts";
import type { ToolRegistry } from "./registry.ts";

export interface CodeToolDeps {
  registry: ToolRegistry;
  store: Pick<Store, "getSession">;
  audit: Pick<AuditLog, "append">;
  /** ToolGateway.availableFor: every tool the session may call, listed to the model or not. */
  available: (sessionId: string) => ToolDescriptor[];
  /** The skills with a script the agent of that session has (a task following a skill has that one too). */
  saved?: (sessionId: string) => SavedScript[];
  /** ToolGateway.call: one of the agent's tools, called as the agent in that session. */
  call: (sessionId: string, tool: string, input: unknown) => Promise<ToolResult>;
  /** Tests run scripts in a sandbox of their own. */
  run?: Pick<CodeDeps, "sandbox" | "limits">;
}

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

const SEARCH_DEFAULT = 8;
const SEARCH_MAX = 30;
const FULL_MAX = 5;

export function registerCodeTools(d: CodeToolDeps): void {
  d.registry.register(
    {
      name: CODE_SEARCH,
      owner: "core",
      effect: "read",
      forTriggers: false,
      description:
        "Find tools to call from a script (code_execute), and the scripts you saved before (skills with a script: they come first, and one that " +
        "fits is run with skill_run instead of writing a new one): every tool you have, the ones on your list and the ones that are not (services the " +
        "person connected, plugins). `query` is words for what you need (\"calendar events\", \"send email\", \"linear issue\"); each answer is the " +
        "call a script makes, `tools.<name>({…})` with its input's fields, and a line on what it does. Leave query out to list them all; " +
        "full: true gives the whole description and schema of the few that match.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Words for what you need: the service, the thing, the action" },
          limit: { type: "number", description: `How many to show (${SEARCH_DEFAULT}; at most ${SEARCH_MAX})` },
          full: { type: "boolean", description: `The whole description and JSON Schema of each (at most ${FULL_MAX} tools)` },
        },
      },
    },
    async (input, ctx) => {
      const query = typeof input?.query === "string" ? input.query : "";
      const full = input?.full === true;
      const want = Number.isFinite(Number(input?.limit)) && Number(input.limit) > 0 ? Math.floor(Number(input.limit)) : SEARCH_DEFAULT;
      const all = d.available(ctx.sessionId);
      const callable = searchTools(all, "", Number.MAX_SAFE_INTEGER).length;
      const found = searchTools(all, query, Math.min(want, full ? FULL_MAX : SEARCH_MAX));
      const saved = searchSaved(d.saved?.(ctx.sessionId) ?? [], query);
      const tools = describeFound(found, callable, query, full);
      // A saved script that fits is an answer even when no tool is.
      return text(saved.length && !found.length ? `${describeSaved(saved).trimEnd()}\nNo tool fits "${query.trim().slice(0, 100)}" among the ${callable} a script can call.` : `${describeSaved(saved)}${tools}`);
    },
  );

  d.registry.register(
    {
      name: CODE_EXECUTE,
      owner: "core",
      // By itself it changes nothing: each call the script makes is decided as your own.
      effect: "read",
      forTriggers: false,
      description:
        "Run a script that calls your tools as functions, in one step of yours instead of one per call. Use it when the work is several calls " +
        "in a row, a loop over many items, or a big answer of which you need a little: the answers stay in the script and only what it returns " +
        "comes back to you. `code` is JavaScript or TypeScript, the body of `async function (input, tools)`: " +
        "`const mail = await tools.gmail_search_threads({query: \"is:unread\"}); return mail.threads.map((t) => t.subject);`. " +
        "`tools.<name>(input)` takes the tool's input object and gives its answer: an object when the tool answers with JSON, else its text " +
        "(most of the hub's own tools answer with text: code_search says what a tool answered with when it is known, and a run's result says " +
        "it for the tools it called; do not assume fields you have not seen); a failed call throws an Error you may catch. Promise.all runs calls side by side; " +
        "console.log lines come back with the result. No network, files or imports of its own: only the tools. Every call is checked like your " +
        "own: one that needs the person's yes shows its card, and the run stops there if the answer does not come soon. Find tools and their " +
        "inputs with code_search. `input`: any JSON the script gets as `input`.",
      inputSchema: {
        type: "object",
        properties: {
          code: { type: "string", description: "The script: a function body using `input` and `tools`, with await and return" },
          input: { description: "What the script gets as `input` (any JSON)" },
        },
        required: ["code"],
      },
    },
    async (input, ctx) => {
      const code = typeof input?.code === "string" ? input.code : "";
      if (!code.trim()) return text("code is required: the script, e.g. \"const r = await tools.web_search({query: input.q}); return r;\".", true);
      if (Buffer.byteLength(code) > MAX_SCRIPT_BYTES) return text(`The script is longer than ${MAX_SCRIPT_BYTES / 1024} KB: keep data in input, not in the code.`, true);
      const run = await runCode(code, input?.input ?? {}, { call: (tool, toolInput) => d.call(ctx.sessionId, tool, toolInput), ...d.run });
      d.audit.append(`agent:${ctx.agentId}`, "code.run", CODE_EXECUTE, {
        sessionId: ctx.sessionId,
        ok: run.ok,
        calls: run.trace.length,
        tools: [...new Set(run.trace.map((t) => t.call.slice("tools.".length)))].slice(0, 40),
        ms: run.ms,
        bytes: Buffer.byteLength(code),
        ...(run.halted ? { halted: run.halted } : {}),
        ...(run.error ? { error: run.error.slice(0, 300) } : {}),
      });
      // What the calls read from outside has marked the session already (ToolGateway.execute): the answer says so.
      const outside = ctx.tainted || d.store.getSession(ctx.sessionId)?.tainted === true;
      return text(describeCodeRun(run, code, outside), !run.ok);
    },
  );
}
