// First-run setup. A new hub gets a brain before anything else: until one works the web app shows only the setup card
// (sign in, install the CLI, or a key), and a message written meanwhile is answered with that card and kept until a
// brain takes it. Any brain the hub has counts, whichever agent asked. Then the default agent opens the intro (its
// name, look and proactivity, who else joins the team) and from then on leads the rest of the setup (Telegram, a backup
// brain, other computers, getting to know the user) from a short block in its system prompt and two hub tools. Nothing
// here needs a model.

import type { SetupBrain, SetupState, SetupStep, VaultState } from "@piomio/shared";
import { expandBrains, formatBrainRef, parseBrainRef } from "@piomio/shared";
import type { AgentRegistry } from "./agents.ts";
import type { AttachmentPart } from "./attachments.ts";
import type { BrainRegistry } from "./brains.ts";
import type { EventBus } from "./bus.ts";
import type { ChannelRegistry } from "./channels.ts";
import type { CliTools } from "./cli-tools.ts";
import type { Settings } from "./settings.ts";
import type { Store } from "./store.ts";

/** The order the agent offers the steps in. */
export const SETUP_STEPS: readonly SetupStep[] = ["identity", "team", "telegram", "backupBrain", "machines", "profile"];
/** The intro the agent leads on its own: only on hubs that went through it (Saved.intro). */
const INTRO_STEPS: readonly SetupStep[] = ["identity", "team"];

/** Messages written while no brain worked are answered only this long afterwards. */
const HOLD_MS = 24 * 3600_000;
const CHECK_DELAY_MS = 300;

export const INTRO_NOTE =
  "[System] The person has just set up the hub and opened your dialog: this is your first conversation. Greet them in one short sentence in the hub's language and say you are ready. " +
  "Then start getting acquainted (see Hub setup in your instructions) with its first question: what name they want to give you, their new assistant (your name, not theirs), " +
  "with 3–4 names that would suit you as quick replies (`show_choices`).";

interface Saved {
  /** The hub has started talking with the person (every hub used before the intro existed has it). */
  kickoffDone?: boolean;
  /** This hub went through the intro: the identity and team steps are its. */
  intro?: boolean;
  done?: SetupStep[];
  skipped?: SetupStep[];
}

interface ReplyOpts {
  replyChannel?: string;
  quote?: string;
  attachments?: AttachmentPart[];
  speech?: Record<string, string>;
}

interface Held {
  agentId: string;
  prompts: string[];
  opts: ReplyOpts;
  at: number;
}

export interface SetupDeps {
  /** Config.apiKeys: the card may offer keys. */
  apiKeys: boolean;
  brains: BrainRegistry;
  agents: AgentRegistry;
  settings: Settings;
  store: Store;
  vault: { state(): VaultState };
  channels: ChannelRegistry;
  machines: { list(): unknown[] };
  cliTools: CliTools;
  bus: EventBus;
  isRunning: (conversationId: string) => boolean;
  /** Runs a turn in a conversation with these words from the user. */
  resume: (conversationId: string, prompt: string, opts: ReplyOpts) => void;
  /** A system note for the agent of a conversation, and a turn. */
  tellAgent: (conversationId: string, note: string) => void;
}

export function isSetupStep(v: unknown): v is SetupStep {
  return typeof v === "string" && (SETUP_STEPS as readonly string[]).includes(v);
}

export class SetupGuide {
  private d: SetupDeps;
  private held = new Map<string, Held>();
  /** This replica leads and its plugins have started: what the brains say from now on is the hub's real state. */
  private started = false;
  private timer?: NodeJS.Timeout;
  private checking?: Promise<void>;
  private again = false;

  constructor(d: SetupDeps) {
    this.d = d;
    d.bus.on("brains.updated", () => this.schedule());
  }

  /** Called once the plugins have started. Pages that asked while the hub was starting look again now. */
  start(): void {
    this.started = true;
    this.d.bus.emit("brains.updated", {});
    this.schedule();
  }

  stop(): void {
    this.started = false;
    clearTimeout(this.timer);
  }

  /** Still starting, or another replica leads: the brains are not all here yet. */
  starting(): boolean {
    return !this.started;
  }

  private saved(): Saved {
    return this.d.settings.getKey<Saved>("setup", {});
  }

  private save(patch: Saved): void {
    this.d.settings.setKey("setup", { ...this.saved(), ...patch });
    this.d.bus.emit("settings.updated", { keys: ["setup"] });
  }

  private defaultAgent(): string {
    return this.d.settings.get().defaultAgent;
  }

  /** The hub has not started talking with the person yet. */
  firstRun(): boolean {
    return !this.saved().kickoffDone;
  }

  /** The intro's steps still open, in order (none on a hub that did not go through it); nothing is probed. */
  introLeft(): SetupStep[] {
    const saved = this.saved();
    if (!saved.intro) return [];
    return INTRO_STEPS.filter((s) => !saved.done?.includes(s) && !saved.skipped?.includes(s));
  }

  /** The steps this hub has: the intro's only if it went through it. */
  private steps(): SetupStep[] {
    return this.saved().intro ? [...SETUP_STEPS] : SETUP_STEPS.filter((s) => !INTRO_STEPS.includes(s));
  }

  /**
   * The agent's brains on this hub ("api:*" as each provider), then the hub's other CLIs that sign in from the chat
   * (the agent falls back to them, and a brain added after the agent was made shows up here), as the setup card shows them.
   */
  private async brains(agentId: string): Promise<SetupBrain[]> {
    const agent = this.d.agents.get(agentId);
    if (!agent) return [];
    const listed = new Map(this.d.brains.list().map((b) => [b.ref, b]));
    const others = [...listed.values()].filter((b) => b.login && parseBrainRef(b.ref).machineId === "local").map((b) => b.ref);
    const out: SetupBrain[] = [];
    for (const raw of new Set([...expandBrains(agent.brains, [...listed.keys()]), ...others])) {
      const parsed = parseBrainRef(raw);
      if (parsed.machineId !== "local") continue;
      const ref = formatBrainRef(parsed);
      const listing = listed.get(ref);
      const connected = this.d.brains.has(ref);
      const probe = connected ? await this.d.brains.probe(ref) : undefined;
      const kind = listing?.login ? "cli" : "api";
      out.push({
        ref,
        label: listing?.label ?? ref,
        kind,
        installed: kind === "api" ? true : !!probe?.available,
        signedIn: !!probe?.authenticated,
        canInstall: kind === "cli" && !!this.d.cliTools.forBrain(parsed.brainId),
        ...(probe?.detail ? { detail: probe.detail } : {}),
      });
    }
    return out;
  }

  /**
   * The hub has a brain that works now, for this agent: its own first ("api:*" is every provider with a key), else any
   * other the hub lists, which the agent then thinks with (runner.ts). Rate limits and busy brains do not count against it.
   */
  async usable(agentId: string = this.defaultAgent()): Promise<boolean> {
    const listed = this.d.brains.list().map((b) => b.ref);
    const own = expandBrains(this.d.agents.get(agentId)?.brains ?? [], listed);
    for (const ref of new Set([...own, ...listed])) {
      if (this.d.brains.has(ref) && (await this.d.brains.probe(ref)).authenticated) return true;
    }
    return false;
  }

  private async telegram(): Promise<boolean> {
    const c = this.d.channels.list().find((ch) => ch.id === "telegram" || ch.pluginId === "telegram");
    return c ? (await this.d.channels.status(c.id)).connected : false;
  }

  async state(agentId: string = this.defaultAgent()): Promise<SetupState> {
    const [brains, usable, telegram] = [await this.brains(agentId), await this.usable(agentId), await this.telegram()];
    const vaultState = this.d.vault.state();
    const machines = this.d.machines.list().length;
    const saved = this.saved();
    const cli = brains.filter((b) => b.kind === "cli");
    // A backup is only worth offering when a second CLI could still be signed in.
    const backupOffer = cli.filter((b) => b.signedIn).length < 2 && cli.some((b) => !b.signedIn && (b.installed || b.canInstall));
    const auto: Partial<Record<SetupStep, boolean>> = { telegram, backupBrain: !backupOffer, machines: machines > 0 };
    const steps = this.steps();
    const done = steps.filter((s) => auto[s] || saved.done?.includes(s));
    const skipped = steps.filter((s) => !done.includes(s) && saved.skipped?.includes(s));
    return {
      agentId,
      brains,
      usable,
      firstRun: !saved.kickoffDone,
      starting: !this.started,
      vault: vaultState === "uninitialized" ? "absent" : vaultState === "sealed" ? "locked" : "open",
      apiKeys: this.d.apiKeys,
      telegram,
      machines,
      done,
      skipped,
      remaining: steps.filter((s) => !done.includes(s) && !skipped.includes(s)),
    };
  }

  /** The agent finished a step with the user, the user put it off ("skipped"), or wants it back ("todo"). */
  setStep(step: SetupStep, status: "done" | "skipped" | "todo"): void {
    const saved = this.saved();
    const without = (list: SetupStep[] | undefined) => (list ?? []).filter((s) => s !== step);
    this.save({
      done: status === "done" ? [...without(saved.done), step] : without(saved.done),
      skipped: status === "skipped" ? [...without(saved.skipped), step] : without(saved.skipped),
    });
  }

  /**
   * The person opened the default agent's empty dialog in the hub's first run, and a brain works: the agent speaks
   * first and opens the intro. Once per hub, whoever asks first; false when it is not the moment.
   */
  async startIntro(): Promise<boolean> {
    if (!this.firstRun()) return false;
    const agentId = this.defaultAgent();
    if (!(await this.usable(agentId)) || !this.firstRun()) return false;
    this.save({ kickoffDone: true, intro: true });
    // Already talking (an answer to a message that waited for a brain): the intro follows from the setup section.
    const conv = this.d.store.agentConversation(agentId);
    if (this.d.isRunning(conv.id) || this.d.store.listMessages(conv.id, { limit: 1 }).length) return false;
    this.d.tellAgent(conv.id, INTRO_NOTE);
    return true;
  }

  /** The user wrote while no brain of the agent worked: answer it once one does. */
  hold(conversationId: string, agentId: string, prompt: string, opts: ReplyOpts): void {
    const prev = this.held.get(conversationId);
    const fresh = prev && Date.now() - prev.at < HOLD_MS ? prev : undefined;
    // The files of every waiting message go with the one turn that answers them.
    const attachments = [...(fresh?.opts.attachments ?? []), ...(opts.attachments ?? [])];
    const speech = { ...fresh?.opts.speech, ...opts.speech };
    const kept = { ...(fresh?.opts ?? opts), ...(attachments.length ? { attachments } : {}), ...(Object.keys(speech).length ? { speech } : {}) };
    this.held.set(conversationId, { agentId, prompts: [...(fresh?.prompts ?? []), prompt], opts: kept, at: Date.now() });
  }

  isHeld(conversationId: string): boolean {
    return this.held.has(conversationId);
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.check(), CHECK_DELAY_MS);
    this.timer.unref?.();
  }

  /** One check at a time; a change during a check runs another one after it. */
  private check(): Promise<void> {
    if (this.checking) {
      this.again = true;
      return this.checking;
    }
    this.checking = this.runCheck()
      .catch((e) => console.error("[setup] check failed", e))
      .finally(() => {
        this.checking = undefined;
        if (this.again) {
          this.again = false;
          this.schedule();
        }
      });
    return this.checking;
  }

  private async runCheck(): Promise<void> {
    for (const [conversationId, h] of [...this.held]) {
      if (Date.now() - h.at > HOLD_MS) {
        this.held.delete(conversationId);
        continue;
      }
      if (!(await this.usable(h.agentId))) continue;
      this.held.delete(conversationId);
      // The hub's first words to the person are this answer; the intro comes after it, from the setup section.
      if (h.agentId === this.defaultAgent() && this.firstRun()) this.save({ kickoffDone: true, intro: true });
      this.d.resume(conversationId, h.prompts.join("\n\n"), h.opts);
    }
  }

  /** The "Hub setup" section of the default agent's system prompt while steps remain; English, for the model. */
  async promptBlock(agentId: string): Promise<string | undefined> {
    if (agentId !== this.defaultAgent()) return undefined;
    const s = await this.state(agentId);
    if (!s.remaining.length) return undefined;
    const backup = s.brains.find((b) => b.kind === "cli" && !b.signedIn && (b.installed || b.canInstall));
    const steps: Record<SetupStep, string> = {
      identity:
        "identity: who you are for this person, one short question per message. " +
        "1) Ask what name they want to give you (your name is being chosen, not theirs), with 3–4 names that would suit you as quick replies (`show_choices`, your current name among them); save their pick with `profile_update` (name). " +
        "2) Your look: `profile_show` puts a card with your avatar and proactivity in the chat, above your text (saving your name during this step shows it by itself); say in one short sentence that they pick your look and how proactive you are there, or tell you (do not list the options). " +
        "3) Ask whether they want anything about how you talk with them (formal or informal address, short or detailed answers, a character) and put what they say into your instructions with `profile_update` (prompt, sent in full). " +
        'Then call `hub_setup_update` with step "identity" and status "done".',
      team:
        'team: ask who else should join their team right away, with quick replies (`show_choices`): 3–4 roles that would help them (a secretary, a researcher, a programmer, a finance helper…; leave out roles the team already has, see `hub_agents_list`) and "nobody for now". ' +
        "Put each one they pick together with `hub_agent_draft`, one at a time, and create it on their yes. " +
        'When nobody more is wanted, call `hub_setup_update` with step "team" and status "done" ("skipped" if they wanted nobody).',
      telegram:
        'telegram: Telegram for messages and approvals on the phone. The user creates a bot with @BotFather (https://t.me/BotFather, /newbot) and gets its token; then call `hub_plugin_setup` with id "telegram": its card takes the token (and creates the vault first if there is none). Afterwards ask them to message the bot.',
      backupBrain: `backupBrain: ${backup ? `${backup.label} (${backup.ref}) ${backup.installed ? "is installed but not signed in" : "can be installed and signed in"}` : "a second brain"}, a backup for when the current brain hits its limits: \`hub_brain_login\`${backup ? ` with ref "${backup.ref}"` : ""}.`,
      machines: "machines: other computers can join this hub, and their Claude Code and Codex become brains here: `hub_connect_device` shows a card with a one-time link the user opens on that computer.",
      profile:
        'profile: get to know the user: how to address them, their language, what they want help with. Keep each fact with `memory_remember`, change the hub language with `hub_settings_update` if needed and your own name or instructions with `profile_update` if they want; then call `hub_setup_update` with step "profile" and status "done".',
    };
    const intro = s.remaining.filter((step) => INTRO_STEPS.includes(step));
    const later = s.remaining.filter((step) => !INTRO_STEPS.includes(step));
    const lines = ["## Hub setup"];
    // The intro first, alone: the rest of the setup is not even mentioned until it is over.
    if (intro.length)
      lines.push(
        "This hub is new and you are getting acquainted with the person. Lead these steps yourself, in this order, without asking whether to start (after answering anything they asked first). " +
          'When they say "not now" to one, call `hub_setup_update` with status "skipped" and go on. ' +
          "The rest of the setup (Telegram, a backup brain, other computers, getting to know them) comes after these steps: do not bring it up yet.",
        ...intro.map((step) => `- ${steps[step]}`),
      );
    else if (later.length)
      lines.push(
        "This hub is new and some setup is left. " +
          "Offer it when it fits (after answering what the user asked, never instead of it), one step at a time, and start a step only after the user agrees. " +
          'When they say "not now", call `hub_setup_update` with status "skipped" and do not bring that step up again unless they ask to continue the setup.',
        "Steps left:",
        ...later.map((step) => `- ${steps[step]}`),
      );
    lines.push("Secrets (tokens, keys, passwords) go only into the cards the tools show, never into the chat. Call `hub_setup_status` for what is left before suggesting the next step.");
    if (s.skipped.length) lines.push(`Skipped by the user (offer only if they ask to continue the setup): ${s.skipped.join(", ")}.`);
    return lines.join("\n");
  }
}
