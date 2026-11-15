// What a CLI brain's own tools put to the person, as opposed to what they ask leave for: Claude Code's AskUserQuestion
// (questions with options) and ExitPlanMode (a plan to approve). Both reach the hub through the permission tool
// (tools/native-permission.ts). The person gets them in the chat, as the agent's words with quick replies under them,
// and their answer goes back as the call's result.

/** One question of an AskUserQuestion call. */
export interface NativeQuestion {
  question: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect: boolean;
}

/** The person's answer to a question in the chat: their words, and which quick reply it was when it was one. */
export interface PersonAnswer {
  text: string;
  choice?: number;
}

/** Why a question got no answer: the person did not answer in time, or nobody can be asked in this conversation now. */
export type Unanswered = "timeout" | "nobody";

/** A quick reply's text is short (as show_choices keeps it). */
const MAX_LABEL = 60;
const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 6;

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** The questions of an AskUserQuestion input that can be shown: each has its words and at least two options. */
export function parseQuestions(input: unknown): NativeQuestion[] {
  const list = (input as { questions?: unknown } | undefined)?.questions;
  if (!Array.isArray(list)) return [];
  return list.slice(0, MAX_QUESTIONS).flatMap((raw): NativeQuestion[] => {
    const q = (raw ?? {}) as { question?: unknown; options?: unknown; multiSelect?: unknown };
    const question = str(q.question);
    const options = (Array.isArray(q.options) ? q.options : []).slice(0, MAX_OPTIONS).flatMap((o: unknown) => {
      // A plugin may pass bare strings where the model passes {label, description}.
      const label = str(typeof o === "string" ? o : (o as { label?: unknown } | undefined)?.label);
      const description = typeof o === "string" ? undefined : str((o as { description?: unknown } | undefined)?.description);
      return label ? [{ label, ...(description ? { description } : {}) }] : [];
    });
    return question && options.length >= 2 ? [{ question, options, multiSelect: q.multiSelect === true }] : [];
  });
}

/** The quick replies under a question: its options' labels, short enough for a button. */
export function questionChoices(q: NativeQuestion): string[] {
  return q.options.map((o) => (o.label.length > MAX_LABEL ? `${o.label.slice(0, MAX_LABEL - 1)}…` : o.label));
}

/**
 * The question as the agent's words in the chat: the question, what each option means when it says, and `several`
 * (a line in the person's language) when more than one option may be picked.
 */
export function questionText(q: NativeQuestion, several: string): string {
  const explained = q.options.filter((o) => o.description);
  return [q.question, ...(explained.length ? [explained.map((o) => `- **${o.label}**: ${o.description}`).join("\n")] : []), ...(q.multiSelect ? [several] : [])].join("\n\n");
}

/** The answer as AskUserQuestion takes it: the option's own label when a quick reply was tapped, else the person's words. */
export function answerText(q: NativeQuestion, a: PersonAnswer): string {
  return a.choice !== undefined && q.options[a.choice] ? q.options[a.choice].label : a.text;
}

/** The permission tool's answer, as Claude Code takes it. */
export type NativeAnswer = { behavior: "allow"; updatedInput: unknown } | { behavior: "deny"; message: string };

/** Puts words and quick replies to the person in the chat and waits for their answer (SessionRunner.askPerson). */
export type AskPerson = (text: string, options: string[]) => Promise<PersonAnswer | Unanswered>;

/** Where the call was made: `ask` when the person is in this conversation to answer, `task` inside a task. */
export interface AskWhere {
  ask?: AskPerson;
  task?: boolean;
}

/** The hub's own words around a question, in the person's language. */
export interface AskWords {
  /** Under a question whose options may be picked together. */
  several: string;
  /** The quick replies under a plan. */
  approve: string;
  decline: string;
  /** What is asked under a plan the agent wrote out in its reply. */
  plan: string;
}

const deny = (message: string): NativeAnswer => ({ behavior: "deny", message });
const NOBODY = "Nobody is in this conversation to answer now. Decide by yourself where you safely can, or put the question in your reply.";

/**
 * AskUserQuestion: each question goes to the person in turn, and the call is allowed with their answers filled in
 * (`answers`: the question's words to the answer), which is how the tool takes them. Unanswered, it is refused with
 * what the agent should do instead: a refusal's message is the tool's result.
 */
export async function askQuestions(input: Record<string, unknown>, where: AskWhere, words: AskWords): Promise<NativeAnswer> {
  const questions = parseQuestions(input);
  if (!questions.length) return deny("Nothing to ask: AskUserQuestion needs questions, each with its words and at least two options.");
  if (where.task) return deny("Inside a task nobody reads this question. Ask with task_ask (the answer arrives as a message) and go on with what does not depend on it.");
  if (!where.ask) return deny(NOBODY);
  const answers: Record<string, string> = {};
  for (const q of questions) {
    const a = await where.ask(questionText(q, words.several), questionChoices(q));
    if (a === "nobody") return deny(NOBODY);
    if (a === "timeout") {
      const sofar = Object.entries(answers).map(([k, v]) => `${JSON.stringify(k)}=${JSON.stringify(v)}`);
      return deny(
        `${sofar.length ? `Answered so far: ${sofar.join(", ")}. ` : ""}The person has not answered ${JSON.stringify(q.question)} yet. It stays in the chat with its buttons, and their answer will arrive as their next message. End your reply now; do not ask again.`,
      );
    }
    answers[q.question] = answerText(q, a);
  }
  return { behavior: "allow", updatedInput: { ...input, answers } };
}

/**
 * The plan of an ExitPlanMode call: the one the CLI saved to its plan file and hands over, or, where it could save
 * none (a dialog's brain writes no files), the one the agent put in the call itself (`written`).
 */
export function planOf(input: Record<string, unknown>, written?: unknown): string | undefined {
  return str(input.plan) ?? str(written);
}

/**
 * ExitPlanMode: the plan goes to the person, who approves it, declines it or says what to change. Undefined when
 * nobody is here to show it to: the caller decides as for any other tool. A call with no plan the person could see
 * is refused once with what to do (write it out in the reply); `inReply` says the agent was told so, and then the
 * person is asked about the plan in its reply.
 */
export async function askPlan(input: Record<string, unknown>, where: AskWhere, words: AskWords, call: { written?: unknown; inReply?: boolean } = {}): Promise<NativeAnswer | undefined> {
  if (!where.ask || where.task) return undefined;
  const plan = planOf(input, call.written);
  if (!plan && !call.inReply) return deny("The person cannot see your plan: its file could not be saved here. Write the plan out in your reply, then call ExitPlanMode again.");
  const a = await where.ask(plan ?? words.plan, [words.approve, words.decline]);
  if (a === "nobody") return undefined;
  if (a === "timeout") {
    return deny("The person has not answered about the plan yet. It stays in the chat with its buttons, and their answer will arrive as their next message. End your reply now; when they agree, call ExitPlanMode again.");
  }
  if (a.choice === 0) return { behavior: "allow", updatedInput: input };
  if (a.choice === 1) return deny("The person declined the plan. Do not carry it out; ask what they want instead.");
  return deny(`The person answered about the plan: ${JSON.stringify(a.text)}. Rework the plan to fit and show it again with ExitPlanMode; do not start the work before they approve.`);
}
