// Group chats: who answers a user's message, who gets the floor after an agent's reply, and what each member's brain
// receives for its turn. Every brain session resumes only its own history, so each turn starts with what the member
// has not seen yet: the user's and the other members' messages since its last reply, as "[Name]: text" lines.

import type { Message } from "@piomio/shared";
import { replyContext, parseMentions, truncate, type Mentionable } from "@piomio/shared";

/** At most this many hand-offs (an agent mentioning another member) per user message. */
export const MAX_HANDOFFS = 3;
/** Longer messages are trimmed in another member's prompt. */
const LINE_CHARS = 1500;
/** At most this many unseen messages go into one turn; older ones are left out. */
const MAX_LINES = 40;

/** How the user appears in the members' prompts. */
export const USER_LABEL = "User";

/** Explicit mentions take priority, then the quoted member (if still here), then the lead. */
export function firstSpeakers(text: string, members: readonly Mentionable[], replyAgentId?: string): string[] {
  const named = parseMentions(text, members);
  if (named.length) return named;
  if (replyAgentId && members.some((m) => m.id === replyAgentId)) return [replyAgentId];
  return members.slice(0, 1).map((m) => m.id);
}

/**
 * The queue after `speaker` replied: members its reply mentions answer next, in the order mentioned. A member already
 * waiting just moves up; anyone else is a hand-off, and at most `budget` of those are added. Never the speaker itself.
 */
export function handOff(queue: readonly string[], speaker: string, answer: string, members: readonly Mentionable[], budget: number): { queue: string[]; added: string[] } {
  const named = parseMentions(answer, members, { all: false }).filter((id) => id !== speaker);
  const rest = [...queue];
  const front: string[] = [];
  const added: string[] = [];
  for (const id of named) {
    const i = rest.indexOf(id);
    if (i >= 0) {
      rest.splice(i, 1);
      front.push(id);
    } else if (added.length < budget) {
      added.push(id);
      front.push(id);
    }
  }
  return { queue: [...front, ...rest], added };
}

/** What a member said, as another member reads it: the words after its last tool call, attachments by name, pictures and maps it showed. */
export function spokenText(m: Message): string {
  const lastTool = m.role === "assistant" ? m.parts.findLastIndex((p) => p.type === "tool_call" || p.type === "tool_result") : -1;
  const pick = (from: number) =>
    m.parts
      .slice(from)
      .flatMap((p) =>
        p.type === "text"
          ? [p.text]
          : p.type === "attachment"
            ? [` [attachment: ${p.name}]`]
            : p.type === "images"
              ? [` [showed ${p.items.length === 1 ? "an image" : `${p.items.length} images`}${p.items.some((it) => it.caption) ? `: ${p.items.flatMap((it) => (it.caption ? [it.caption] : [])).join("; ")}` : ""}]`]
              : p.type === "map"
                ? [` [showed a map${p.title ? ` of ${p.title}` : ""} at ${p.lat}, ${p.lon}]`]
                : [],
      )
      .join("")
      .trim();
  const quote = m.parts.find((p) => p.type === "reply_to");
  return [pick(lastTool + 1) || pick(0), quote ? replyContext(quote) : ""].filter(Boolean).join("\n");
}

export interface GroupTurnInput {
  /** The conversation's recent messages, oldest first. */
  messages: Message[];
  /** The member whose turn it is. */
  agentId: string;
  /** Display name of a member (prompts are English: names as the hub shows them). */
  name: (agentId: string | undefined) => string;
  /** The turn's own text: the user's message (expanded), or a system note. */
  prompt: string;
  /** The user message this round answers. */
  triggerId?: string;
  /** Why the member has the floor when the trigger is not the last thing it reads (e.g. a hand-off). */
  floorNote?: string;
  /**
   * User messages up to this moment were shown to the member already (the trigger of its previous turn). Later user
   * messages before its last reply were held back for their own round and are still unseen.
   */
  seenUserUpTo?: string;
}

export interface GroupTurn {
  /** "[Name]: text" lines of what the member has not seen, oldest first. */
  lines: string[];
  /** What follows them: the user's message itself, or a note on why it is the member's turn. */
  tail: string;
  /** The new `seenUserUpTo` once the turn is sent. */
  seenUserUpTo?: string;
}

/** The member's view of the group for its turn: the unseen messages and the turn's own text. */
export function groupTurn(o: GroupTurnInput): GroupTurn {
  const msgs = o.messages.filter((m) => m.status !== "streaming");
  const lastOwn = msgs.findLastIndex((m) => m.role === "assistant" && m.agentId === o.agentId && m.status === "complete");
  const ownAt = lastOwn >= 0 ? msgs[lastOwn].createdAt : "";
  const userFrom = o.seenUserUpTo !== undefined && o.seenUserUpTo < ownAt ? o.seenUserUpTo : ownAt;
  const ti = o.triggerId ? msgs.findIndex((m) => m.id === o.triggerId) : -1;
  const unseen = msgs.filter((m, i) => {
    if (m.role === "system") return false;
    if (m.role === "assistant") return m.agentId !== o.agentId && i > lastOwn;
    // The user's later messages get their own round.
    if (ti >= 0 && i > ti) return false;
    return m.createdAt > userFrom;
  });
  const trigger = ti >= 0 ? msgs[ti] : undefined;
  const at = trigger ? unseen.indexOf(trigger) : -1;
  let shown = unseen;
  let tail: string;
  if (at >= 0 && at === unseen.length - 1) {
    // Nobody spoke since the user's message: it is the turn's own text.
    shown = unseen.slice(0, -1);
    tail = o.prompt;
  } else if (at >= 0) tail = o.floorNote ?? "[System] It is your turn to reply to the user's message above.";
  else tail = o.floorNote ?? o.prompt;

  const lines = shown
    .map((m) => ({ m, text: spokenText(m) }))
    .filter((x) => x.text)
    .map(({ m, text }) => `[${m.role === "user" ? USER_LABEL : o.name(m.agentId)}]: ${truncate(text, LINE_CHARS)}`);
  const omitted = lines.length - MAX_LINES;
  const kept = omitted > 0 ? [`[System] ${omitted} earlier message${omitted === 1 ? "" : "s"} not shown.`, ...lines.slice(omitted)] : lines;
  // Without a trigger every user message was shown; the marker never moves back.
  const upTo = trigger ? trigger.createdAt : msgs.at(-1)?.createdAt;
  const seenUserUpTo = upTo === undefined || (o.seenUserUpTo !== undefined && o.seenUserUpTo > upTo) ? o.seenUserUpTo : upTo;
  return { lines: kept, tail, seenUserUpTo };
}

/** The turn's text for the brain: the unseen lines, then the tail. */
export function groupTurnText(turn: GroupTurn): string {
  return turn.lines.length ? `${turn.lines.join("\n")}\n\n${turn.tail}` : turn.tail;
}
