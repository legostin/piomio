// Agent tools: create / list / update / delete / run_now (exposed as trigger_<name>).

import type { PluginContext } from "@piomio/plugin-sdk";
import type { JsonSchema, ToolResult } from "@piomio/shared";
import { NotFoundError, type TriggerEngine } from "./engine.ts";
import { describeSchedule, formatLocal } from "./schedule.ts";
import { TRIGGER_KINDS, type Trigger, type TriggerInput } from "./types.ts";
import { ValidationError } from "./validate.ts";

const text = (t: string): ToolResult => ({ content: [{ type: "text", text: t }] });
const error = (t: string): ToolResult => ({ content: [{ type: "text", text: t }], isError: true });

const FIELDS: Record<string, JsonSchema> = {
  name: { type: "string", description: "Short name shown to the user, in the user's language." },
  prompt: {
    type: "string",
    description:
      "Instructions for the agent when the trigger fires, written as a task: what to check or do and when the user should be notified. Placeholders {{time}}, {{date}}, {{name}} are filled in. Event context (changed value, webhook payload) is appended automatically.",
  },
  agent: { type: "string", description: "Id of the agent that runs (default: you)." },
  machine: {
    type: "string",
    description:
      "Computer id or name every run happens on, when the work needs that computer's files, apps or hardware (default: wherever the agent's brain runs). See task_agents for the computers. An empty string clears it.",
  },
  skill: {
    type: "string",
    description: "A skill every run follows, e.g. one the person taught by showing (\"order water every Friday\"); its runs may click and type as the skill says. An empty string clears it.",
  },
  report: {
    type: "boolean",
    description:
      "schedule/once only: true when each run's product is a message for the user at its time (a morning brief, a weekly summary): your final reply is delivered as is, never held back. false for checks that speak only when something needs attention (notify levels). Default: true for once and for a schedule running on average at most 3 times a day.",
  },
  cron: { type: "string", description: "schedule: 5-field cron 'minute hour day month weekday' in the user's local timezone, e.g. '0 9 * * 1-5' = weekdays at 09:00." },
  at: { type: "string", description: "once: ISO datetime. Without an offset it is the user's local time, e.g. '2026-10-27T09:00'. Must be in the future." },
  url: { type: "string", description: "watch: http(s) URL to poll." },
  selector: { type: "string", description: "watch: CSS selector; the text of matching elements is compared (HTML pages). Without selector/jsonPath the whole page text is compared." },
  jsonPath: { type: "string", description: "watch: path into a JSON response whose value is compared, e.g. 'data.items[0].price'." },
  intervalMinutes: { type: "number", minimum: 5, description: "watch: poll interval in minutes, at least 5 (default 60)." },
  times: { type: "array", items: { type: "string" }, description: "heartbeat: local times 'HH:MM' (default ['10:00', '18:00'])." },
  weekdays: { type: "array", items: { type: "integer", minimum: 0, maximum: 6 }, description: "heartbeat: weekdays 0-6, 0 = Sunday (default Monday-Friday)." },
  maxRunsPerDay: { type: "integer", minimum: 1, description: "Maximum agent runs per day for this trigger (default 24)." },
};

function summary(e: TriggerEngine, t: Trigger) {
  return {
    id: t.id,
    kind: t.kind,
    name: t.name,
    enabled: t.enabled,
    agent: t.agentId,
    machine: t.machineName ?? null,
    skill: t.skill ?? null,
    when: describeSchedule(t),
    report: t.report ?? false,
    nextRun: t.state.nextRunAt ? formatLocal(t.state.nextRunAt, e.tz) : null,
    lastRun: t.state.lastRunAt ? formatLocal(t.state.lastRunAt, e.tz) : null,
    lastStatus: t.state.lastStatus ?? null,
    lastError: t.state.lastError,
    webhookUrl: e.webhookUrl(t),
    maxRunsPerDay: t.maxRunsPerDay,
    prompt: t.prompt.length > 300 ? `${t.prompt.slice(0, 300)}…` : t.prompt,
  };
}

function describeCreated(e: TriggerEngine, t: Trigger, verb: string): string {
  const on = (t.machineName ? `; runs on the computer ${t.machineName}` : "") + (t.skill ? `; follows the skill ${t.skill}` : "");
  const lines = [`${verb} trigger ${t.id} "${t.name}" (${t.kind}: ${describeSchedule(t)}; timezone ${e.tz}; agent ${t.agentId}${on}; ${t.enabled ? "enabled" : "disabled"}).`];
  if (t.state.nextRunAt) lines.push(`Next run: ${formatLocal(t.state.nextRunAt, e.tz)}.`);
  if (t.report) lines.push("Each run's final reply is delivered to the user as a report.");
  if (t.kind === "watch") lines.push("The first check stores a baseline; the agent runs only when the extracted value changes.");
  if (t.kind === "event") {
    const url = e.webhookUrl(t);
    lines.push(
      `Webhook URL: ${url}`,
      `Secret: ${t.secret} — send it in the "x-piomio-secret" header (or as ?secret=...). Give both to the user; the request body becomes the event payload.`,
      `Example: curl -X POST -H "x-piomio-secret: ${t.secret}" -H "content-type: application/json" -d '{"text":"hello"}' ${url}`,
    );
  }
  return lines.join("\n");
}

const pick = (input: any): TriggerInput => {
  const out: Record<string, unknown> = {};
  for (const k of ["kind", "name", "prompt", "agent", "machine", "skill", "report", "enabled", "maxRunsPerDay", "cron", "at", "url", "selector", "jsonPath", "intervalMinutes", "times", "weekdays"]) {
    if (input?.[k] !== undefined) out[k] = input[k];
  }
  return out as TriggerInput;
};

async function guarded(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (e: any) {
    if (e instanceof ValidationError || e instanceof NotFoundError) return error(e.message);
    throw e;
  }
}

export function registerTools(ctx: PluginContext, e: TriggerEngine): void {
  ctx.tools.register({
    name: "create",
    description:
      "Create a trigger that starts a background task for an agent later or on an event. Kinds: " +
      "schedule (recurring, cron in the user's timezone), once (a one-time reminder at `at`), " +
      "watch (poll `url` every intervalMinutes and run only when the page/JSON value changes), " +
      "event (a webhook URL with a secret; the POST body is passed to the agent), " +
      "heartbeat (a proactive review at fixed local times on chosen weekdays). " +
      "When the runs need a particular computer (its files, apps, hardware), set `machine`: every run happens there. " +
      "When each run should do a skill the person taught (\"order water every Friday\"), set `skill` to its name. Returns the trigger id.",
    effect: "local-write",
    // A trigger outlives the session: after outside content (a page could ask for one) the person says yes on a card.
    askWhenTainted: true,
    inputSchema: {
      type: "object",
      properties: { kind: { type: "string", enum: [...TRIGGER_KINDS], description: "Trigger kind." }, ...FIELDS },
      required: ["kind", "name", "prompt"],
    },
    handler: (input, call) =>
      guarded(async () => {
        const t = await e.create(pick(input), { createdBy: `agent:${call.agentId}`, defaultAgent: call.agentId });
        return text(describeCreated(e, t, "Created"));
      }),
  });

  ctx.tools.register({
    name: "list",
    description: "List triggers with their kind, schedule, next and last run, status and webhook URLs.",
    effect: "read",
    inputSchema: { type: "object", properties: { kind: { type: "string", enum: [...TRIGGER_KINDS], description: "Only this kind." } } },
    handler: (input) =>
      guarded(async () => {
        const list = e.list().filter((t) => !input?.kind || t.kind === input.kind);
        if (!list.length) return text("No triggers.");
        return text(`Timezone: ${e.tz}\n${JSON.stringify(list.map((t) => summary(e, t)), null, 1)}`);
      }),
  });

  ctx.tools.register({
    name: "update",
    description: "Change a trigger: name, prompt, agent, machine, skill, report, enabled, maxRunsPerDay and the kind-specific fields (cron, at, url, selector, jsonPath, intervalMinutes, times, weekdays). The kind cannot change.",
    effect: "local-write",
    // As for create: after outside content the person says yes.
    askWhenTainted: true,
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Trigger id." }, enabled: { type: "boolean", description: "Turn the trigger on or off." }, ...FIELDS },
      required: ["id"],
    },
    handler: (input) =>
      guarded(async () => {
        const t = await e.update(String(input?.id ?? ""), pick({ ...input, kind: undefined }));
        return text(describeCreated(e, t, "Updated"));
      }),
  });

  ctx.tools.register({
    name: "delete",
    description: "Delete a trigger and its run history.",
    effect: "local-write",
    inputSchema: { type: "object", properties: { id: { type: "string", description: "Trigger id." } }, required: ["id"] },
    handler: (input) =>
      guarded(async () => {
        const t = await e.remove(String(input?.id ?? ""));
        return text(`Deleted trigger ${t.id} "${t.name}".`);
      }),
  });

  ctx.tools.register({
    name: "run_now",
    description: "Fire a trigger immediately (starts its background task now; counts toward the daily limit).",
    effect: "local-write",
    inputSchema: { type: "object", properties: { id: { type: "string", description: "Trigger id." } }, required: ["id"] },
    handler: (input) =>
      guarded(async () => {
        const run = await e.runNow(String(input?.id ?? ""));
        if (run.status === "started") return text(`Started background task ${run.taskId ?? "(unknown id)"} for trigger ${input.id}.`);
        return error(`Trigger ${input.id} was not run: ${run.detail}`);
      }),
  });
}
