// The hub's own commands ("/task …", "/brain"): what the composer lists and the hub answers itself, without the model
// (docs/superpowers/specs/2026-11-01-hub-commands-design.md). Browser-safe: the hub parses with it, the web UI lists.

/** The hub's commands, in the order the composer lists them. */
export const HUB_COMMANDS = ["task", "goal", "schedule", "brain", "effort", "archive"] as const;
export type HubCommand = (typeof HUB_COMMANDS)[number];

/** The ones whose words come after the name: choosing one puts it in the field; the others are sent at once. */
export const COMMANDS_WITH_WORDS: readonly HubCommand[] = ["task", "goal", "schedule"];

/** A goal's rounds before it pauses and says so; `/goal resume` gives it as many again. */
export const GOAL_ROUNDS = 20;

/** The round a goal pauses at, `rounds` done: the next multiple of GOAL_ROUNDS. */
export function goalLimit(rounds: number): number {
  return (Math.floor(rounds / GOAL_ROUNDS) + 1) * GOAL_ROUNDS;
}

/** `/goal pause`, `/goal resume`, `/goal clear`, in English and Russian. */
export const GOAL_CONTROLS: Record<"pause" | "resume" | "clear", readonly string[]> = {
  pause: ["pause", "stop", "пауза", "стоп"],
  resume: ["resume", "continue", "продолжи", "продолжить", "дальше"],
  clear: ["clear", "cancel", "сброс", "сбросить", "отмена", "отменить"],
};

/** A command as `GET /api/commands` lists it: the hub's (source "hub", `args` the hint for its words), then the skills'. */
export interface CommandView {
  name: string;
  description: string;
  source: string;
  args?: string;
}

/** "/name words" at the start of a message (Telegram's "/name@bot" too): the name in lower case and the words, or undefined. */
export function parseCommand(text: string): { name: string; args: string } | undefined {
  const m = /^\/([a-z][a-z0-9_-]*)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text.trim());
  return m ? { name: m[1].toLowerCase(), args: (m[2] ?? "").trim() } : undefined;
}

export function isHubCommand(name: string): name is HubCommand {
  return (HUB_COMMANDS as readonly string[]).includes(name);
}

/** What `/goal <words>` asks for: a control word, or a goal (the words themselves); nothing when there are none. */
export function goalControl(args: string): "pause" | "resume" | "clear" | undefined {
  const w = args.trim().toLowerCase();
  for (const [k, words] of Object.entries(GOAL_CONTROLS)) if (words.includes(w)) return k as "pause" | "resume" | "clear";
  return undefined;
}
