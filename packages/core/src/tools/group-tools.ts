// Group chats from the chat itself: any agent makes a group or changes one (its name, who takes part, who leads), puts
// it in the archive or brings it back, or deletes it, when the person asks in their own words. The same as the group
// form and the group's menu in the UI, which stay as the other way. A delete always waits for the person's yes on a card.
import type { Conversation, GroupChat, ToolCallContext, ToolDescriptor, ToolResult } from "@piomio/shared";
import { GROUP_MAX_MEMBERS, GROUP_MIN_MEMBERS } from "@piomio/shared";
import type { ToolRegistry } from "./registry.ts";
import type { Store } from "../store.ts";
import type { AgentRegistry } from "../agents.ts";
import type { ApprovalService } from "../approvals.ts";
import { agentName } from "../agents.ts";
import { hubLocale, t } from "../i18n.ts";

export interface GroupToolDeps {
  registry: ToolRegistry;
  store: Store;
  agents: AgentRegistry;
  /** Hub.archiveGroup / deleteGroup, as the agent; `fromTurn` when asked for in the group itself. */
  archive: (id: string, archived: boolean, opts: { fromTurn?: boolean }) => GroupChat;
  remove: (id: string, opts: { fromTurn?: boolean }) => void;
  approvals: ApprovalService;
  /** How long a tool waits for the person's answer on its card. */
  approvalWaitMs: () => number;
}

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });
const title = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, 120) : "");

export function registerGroupTools(d: GroupToolDeps): void {
  const reg = (spec: Omit<ToolDescriptor, "owner">, fn: (input: any, ctx: ToolCallContext) => ToolResult | Promise<ToolResult>) =>
    d.registry.register({ ...spec, owner: "core" }, async (input, ctx) => fn(input ?? {}, ctx));
  const name = (id: string) => {
    const a = d.agents.get(id);
    return a ? agentName(a, hubLocale()) : id;
  };
  /** An agent by its id or any of its names; a string says who is missing. */
  const agent = (key: unknown): string | { error: string } => {
    const k = typeof key === "string" ? key.trim() : "";
    if (!k) return { error: "An empty member." };
    if (d.agents.get(k)) return k;
    const low = k.toLowerCase();
    const found = d.agents.list().find((a) => [a.name, ...Object.values(a.i18n ?? {}).map((n) => n?.name)].some((n) => n?.toLowerCase() === low));
    return found ? found.id : { error: `No agent "${k}". See hub_agents_list.` };
  };
  const agents = (keys: unknown): string[] | { error: string } => {
    const out: string[] = [];
    for (const k of Array.isArray(keys) ? keys : []) {
      const id = agent(k);
      if (typeof id !== "string") return id;
      if (!out.includes(id)) out.push(id);
    }
    return out;
  };
  const sizeError = (n: number) => (n < GROUP_MIN_MEMBERS || n > GROUP_MAX_MEMBERS ? `A group has ${GROUP_MIN_MEMBERS} to ${GROUP_MAX_MEMBERS} agents.` : undefined);
  const describe = (c: Conversation) => `“${c.title}” (${c.id}): ${(c.members ?? []).map((m, i) => (i === 0 ? `${name(m)} (leads)` : name(m))).join(", ")}`;
  /** The group named in `group`, or the group this chat is. */
  const which = (key: unknown, ctx: { conversationId: string }): Conversation | string => {
    const groups = d.store.listConversations(500).filter((c) => c.kind === "group");
    if (typeof key === "string" && key.trim()) {
      const k = key.trim().toLowerCase();
      return groups.find((c) => c.id === key.trim()) ?? groups.find((c) => c.title.toLowerCase() === k) ?? `No group "${key}".`;
    }
    const here = d.store.getConversation(ctx.conversationId);
    return here?.kind === "group" ? here : "Say which group (group: its id or name); this chat is not one.";
  };

  reg(
    {
      name: "group_create",
      description:
        "Make a group chat of the team's agents when the user asks (\"make a group with Researcher and Atlas for the trip\"). The first member leads " +
        `(answers when nobody is mentioned). ${GROUP_MIN_MEMBERS}–${GROUP_MAX_MEMBERS} agents. It appears in the user's Groups tab.`,
      effect: "local-write",
      // Who talks in a group lasts beyond the session: after outside content the user says yes first.
      askWhenTainted: true,
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "The group's name (≤ 120 chars)" },
          members: { type: "array", items: { type: "string" }, description: "Agent ids or names, the lead first" },
        },
        required: ["members"],
      },
    },
    (i) => {
      const members = agents(i.members);
      if (!Array.isArray(members)) return text(members.error, true);
      const bad = sizeError(members.length);
      if (bad) return text(bad, true);
      const c = d.store.createConversation({ kind: "group", title: title(i.title) || members.map(name).join(", "), agentId: members[0], members });
      return text(`Made the group ${describe(c)}. The user sees it in the Groups tab.`);
    },
  );

  reg(
    {
      name: "group_update",
      description:
        "Change a group chat when the user asks: rename it, add or remove agents, or choose who leads. Without `group` it is the group this chat is. " +
        `It keeps ${GROUP_MIN_MEMBERS}–${GROUP_MAX_MEMBERS} agents.`,
      effect: "local-write",
      askWhenTainted: true,
      inputSchema: {
        type: "object",
        properties: {
          group: { type: "string", description: "The group's id or name (default: this chat)" },
          title: { type: "string", description: "A new name" },
          add: { type: "array", items: { type: "string" }, description: "Agents to add (ids or names)" },
          remove: { type: "array", items: { type: "string" }, description: "Agents to remove" },
          lead: { type: "string", description: "The agent who leads from now on (added if missing)" },
        },
      },
    },
    (i, ctx) => {
      const g = which(i.group, ctx);
      if (typeof g === "string") return text(g, true);
      const add = agents(i.add);
      const remove = agents(i.remove);
      if (!Array.isArray(add)) return text(add.error, true);
      if (!Array.isArray(remove)) return text(remove.error, true);
      let members = [...(g.members ?? []), ...add].filter((id, n, all) => all.indexOf(id) === n && !remove.includes(id));
      if (i.lead !== undefined) {
        const lead = agent(i.lead);
        if (typeof lead !== "string") return text(lead.error, true);
        members = [lead, ...members.filter((id) => id !== lead)];
      }
      const bad = sizeError(members.length);
      if (bad) return text(bad, true);
      const renamed = i.title !== undefined ? title(i.title) : "";
      const changed = members.join() !== (g.members ?? []).join() || (!!renamed && renamed !== g.title);
      if (!changed) return text(`Nothing to change: ${describe(g)}.`);
      const c = d.store.updateConversation(g.id, { ...(renamed ? { title: renamed } : {}), members }) ?? g;
      return text(`Updated the group ${describe(c)}.`);
    },
  );
  reg(
    {
      name: "group_archive",
      description:
        "Put a group chat in the archive when the user asks (archived: true), or bring it back (archived: false). In the archive it is out of their Groups list " +
        "(it waits under Archive at the end) and nobody writes there; its messages stay. Without `group` it is the group this chat is.",
      effect: "local-write",
      askWhenTainted: true,
      inputSchema: {
        type: "object",
        properties: {
          group: { type: "string", description: "The group's id or name (default: this chat)" },
          archived: { type: "boolean" },
        },
        required: ["archived"],
      },
    },
    (i, ctx) => {
      const g = which(i.group, ctx);
      if (typeof g === "string") return text(g, true);
      const archived = i.archived !== false;
      d.archive(g.id, archived, { fromTurn: g.id === ctx.conversationId });
      return text(archived ? `“${g.title}” (${g.id}) is in the archive; nobody writes there until it comes back.` : `“${g.title}” (${g.id}) is back in the Groups list.`);
    },
  );

  reg(
    {
      name: "group_delete",
      description:
        "Delete a group chat for good when the user asks: its messages and the tasks started there go with it (to keep them, group_archive instead). " +
        "The user always confirms on a card, whatever their rules say. Without `group` it is the group this chat is: then it goes once your reply ends.",
      effect: "local-write",
      inputSchema: {
        type: "object",
        properties: { group: { type: "string", description: "The group's id or name (default: this chat)" } },
      },
    },
    async (i, ctx) => {
      if (ctx.background) return text("Deleting a group chat needs the user's yes in a chat with them, not background work.", true);
      const g = which(i.group, ctx);
      if (typeof g === "string") return text(g, true);
      // Never on a rule or the person's words in passing: a deleted chat does not come back, so they confirm each time.
      if (!ctx.approved) {
        const approval = d.approvals.create({
          sessionId: ctx.sessionId,
          conversationId: ctx.conversationId,
          taskId: ctx.taskId,
          agentId: ctx.agentId,
          tool: "group_delete",
          input: i,
          summary: t("group.deleteCard", { title: g.title }),
          effect: "external",
          tainted: ctx.tainted,
        });
        const outcome = await d.approvals.wait(approval.id, d.approvalWaitMs());
        if (outcome === "timeout") {
          try {
            d.approvals.resolve(approval.id, "deny", { via: "timeout" });
          } catch {
            /* already answered */
          }
          return text("The user did not answer the card in time: nothing was deleted.", true);
        }
        if (outcome !== "approved") return text("The user declined: nothing was deleted.", true);
        d.approvals.markExecuted(approval.id, text(`Group chat ${g.id} deleted.`));
      }
      const here = g.id === ctx.conversationId;
      d.remove(g.id, { fromTurn: here });
      return text(here ? `“${g.title}” goes for good once this reply ends.` : `Group chat “${g.title}” (${g.id}) deleted.`);
    },
  );
}
