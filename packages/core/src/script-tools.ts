// A tool called from a script (code-mode.ts, skill-scripts.ts): `tools.<name>(input)` is ToolGateway.call under the
// session that runs the script, so the call is decided as the agent's own. Shared by code mode's scripts and the
// scripts of skills. Texts are English: they go back to the model.

import type { ToolResult } from "@piomio/shared";
import { TOOLS_OWN_NAMES } from "./signals/sandbox-worker.ts";

/**
 * Tools a script never calls: a script does not start a script, and what changes the hub itself (rights, plugins,
 * skills, settings), the vault and the CLIs' own permission prompt stay the model's own calls.
 */
export const CODE_CLOSED = /^(?:code_|skill_run$|skill_script_save$|hub_|vault_|native_permission$)/;

/** A tool's answer as a script gets it, at most. */
const ANSWER_CHARS = 1024 * 1024;
const ERROR_CHARS = 600;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** A call waits for the person's tap ("approval") or was refused ("denied"): the run that made it goes no further. */
export class ScriptHalt extends Error {
  kind: "approval" | "denied";
  constructor(kind: "approval" | "denied", message: string) {
    super(message);
    this.kind = kind;
  }
}

/** A tool's answer as a value: its text, parsed when it is a JSON object or array; what is not text is named. */
export function answerValue(r: ToolResult): unknown {
  const text = r.content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
  if (/^\s*[[{]/.test(text)) {
    try {
      return JSON.parse(text);
    } catch {
      /* text */
    }
  }
  return text;
}

const SHAPE_KEYS = 8;

/** A tool's answer in a few words: text, or the JSON's top-level keys. */
export function shapeOf(v: unknown): string {
  const keys = (o: object) => {
    const k = Object.keys(o);
    return `{${k.slice(0, SHAPE_KEYS).join(", ")}${k.length > SHAPE_KEYS ? ", …" : ""}}`;
  };
  if (typeof v === "string") return "text";
  if (Array.isArray(v)) return isObject(v[0]) ? `a JSON array of ${keys(v[0])}` : "a JSON array";
  return isObject(v) ? `JSON ${keys(v)}` : "JSON";
}

/**
 * What each tool answered with the last time a script called it here: tools declare their input, not their answer,
 * and a script written for JSON that got text returns nothing. code_search says it once it is known.
 */
const seenAnswers = new Map<string, string>();
export const answerSeen = (tool: string): string | undefined => seenAnswers.get(tool);

/**
 * `tools.<name>(input)` of a script: the tool's answer as a value, an Error the script may catch, or a ScriptHalt.
 * `call` is ToolGateway.call for the session; `answers` collects what each tool answered with, for the run's result.
 */
export async function scriptToolCall(name: string, args: unknown[], call: (tool: string, input: Record<string, unknown>) => Promise<ToolResult>, answers?: Record<string, string>): Promise<unknown> {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new Error(`"${clip(name, 80)}" is not a tool's name`);
  if ((TOOLS_OWN_NAMES as readonly string[]).includes(name)) throw new Error(`tools.${name} is not a tool`);
  if (CODE_CLOSED.test(name)) throw new Error(`${name} is not called from a script: call it yourself, as a step of your own`);
  const toolInput = args[0] ?? {};
  if (!isObject(toolInput)) throw new Error(`tools.${name} takes one object, the tool's input, e.g. tools.${name}({…})`);
  const r = await call(name, toolInput);
  const text = r.content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
  const status = r._meta?.status;
  if (status === "awaiting_approval") throw new ScriptHalt("approval", clip(text, ERROR_CHARS));
  if (status === "denied") throw new ScriptHalt("denied", clip(text, ERROR_CHARS));
  if (r.isError) throw new Error(/is not available to this agent$/.test(text) ? `there is no tool ${name} for you in this session: code_search finds the ones there are (a background run of an agent that only suggests has the tools that read)` : clip(text, ERROR_CHARS));
  if (text.length > ANSWER_CHARS) throw new Error(`the answer of ${name} is over 1 MB: ask it for less (a narrower query, a limit, fewer fields)`);
  const value = answerValue(r);
  const shape = shapeOf(value);
  seenAnswers.set(name, shape);
  if (answers) answers[name] = shape;
  return value;
}
