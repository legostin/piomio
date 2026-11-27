# Lessons the person can annotate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A frame drawn while teaching gets a note (typed or dictated) and a meaning in one tap, and the person can open the steps recorded so far, fix them and take slips out.

**Architecture:** The recorder numbers its steps and learns `note`/`mark`, with `list`/`remove`/`annotate` to change them; the learning module exposes them over two plugin HTTP routes and a transcribe-only speech mode. The live view adds a note card anchored to the frame and a steps panel; both talk to those routes. The recording's lines for the model carry the marks and notes, and the teach-by-demo skill says what to do with them.

**Tech Stack:** Node 24 type-stripped TypeScript, vitest, React (plugin UI built with esbuild), Playwright (the agents' browser).

Spec: `docs/superpowers/specs/2026-11-27-lesson-notes-design.md`.

## Global Constraints

- Local imports carry `.ts`/`.tsx`; erasable syntax only; `import type` for types.
- Text for the model (step lines, the skill) is English and not translated.
- Person-facing strings go through `plugins/browser/.piomio-plugin/locales/{en,ru}.json`, both languages, same keys.
- The journal's recording files keep their shape: only the optional `note` and `mark` are new; step numbers never leave the recorder.
- Marks are exactly `"check" | "varies" | "avoid" | "wait" | "result"`; a note is at most 500 characters.
- Docs `docs/guide/{en,ru}/browser.md` change in the same commit as the feature.
- Tests write temp files only under `tmpdir()`.

## Files

- `plugins/browser/server/recorder.ts` — `Mark`, `MARKS`, `note`, step numbers, `rev`, `list`, `remove`, `annotate`, the new lines.
- `plugins/browser/server/learning.ts` — `TeachState.rev`, the frame's step number in the `highlight` event, `steps()`, `step()`, `speech` with `only`.
- `plugins/browser/server/index.ts` — routes `GET /teach/steps`, `POST /teach/step`.
- `plugins/browser/ui/src/host.ts` — `TeachState.rev`, `Mark`, `LessonStep`.
- `plugins/browser/ui/src/step-text.ts` (new) — `stepLine`, `MARKS`: a step in the person's words. Pure.
- `plugins/browser/ui/src/note.tsx` (new) — `placeNote` (pure), `MarkChips`, `FrameNote`: the card next to a frame.
- `plugins/browser/ui/src/highlight.tsx` — the frame stays while its note is open; `Dictation`.
- `plugins/browser/ui/src/teach.tsx` — voice routed into the open note; the count becomes a button.
- `plugins/browser/ui/src/steps.tsx` (new) — `StepsPanel`.
- `plugins/browser/ui/src/view.tsx`, `styles.ts` — wiring and styles.
- `plugins/browser/skills/teach-by-demo/SKILL.md`, locales, `docs/guide/{en,ru}/browser.md`.
- Tests: `plugins/browser/test/{recorder,learning,unit}.test.ts`.

---

### Task 1: The recorder knows notes, marks and how to change a step

**Files:** `plugins/browser/server/recorder.ts`, `plugins/browser/test/recorder.test.ts`.

**Produces:**

```ts
export const MARKS = ["check", "varies", "avoid", "wait", "result"] as const;
export type Mark = (typeof MARKS)[number];
export type Step = (/* the union as today; highlight gains `mark?: Mark` */) & { note?: string };
export type LiveStep = Step & { id: number };
class Recorder {
  get rev(): number;                       // grows with every change
  list(): LiveStep[];                      // a copy, typing steps with no value yet left out
  remove(id: number): boolean;             // false: no such step, or a page
  annotate(id: number, c: { note?: string; mark?: Mark | null; text?: string }): boolean;
  highlight(h, at): number;                // the new step's id (0 when the recording is full)
}
```

- [ ] Tests first (`recorder.test.ts`): a frame with `mark: "check"` and a note reads `Marked a place to check every time: «Итого 2 400 ₸».` … ` The person's note: "не больше трёх тысяч"`; each of the five marks has its line; a click with a note ends with ` — the person's note: "…"`; `remove` takes a click out and refuses a page; `annotate` with `text` rewrites a `say` and with `""` removes it; `annotate` refuses a note on a page and a mark on a click; a note on a click survives when typing turns it into a `type` step; `finish().steps` has no `id`; `rev` grows on each change.
- [ ] Run `npx vitest run plugins/browser/test/recorder.test.ts`: the new tests fail.
- [ ] Implement: a private counter gives each pushed or spliced step an `id`; `finish()` maps the ids away; `stepText` gets the table from the spec; every mutating method bumps `rev`.
- [ ] Run the file again: all pass. Commit.

### Task 2: The hub's side of the lesson

**Files:** `plugins/browser/server/learning.ts`, `plugins/browser/server/index.ts`, `plugins/browser/test/learning.test.ts`.

**Consumes:** Task 1. **Produces:**

- `TeachState.rev: number`.
- `ui.emit("highlight", { ok: true, text, step })`.
- `Learning.steps(): PluginHttpResponse` → `{ status: 200, body: { rev, steps: LiveStep[] } }` (`rev: 0, steps: []` with no recording).
- `Learning.step(req): PluginHttpResponse` — body `{ id, remove?, note?, mark?, text? }` → `200 { ok: true, rev }`, `404 { error: "no such step" }`, `409 { error: "not recording" }`, `400` for a mark outside `MARKS`.
- `speech`: `only: true` in the body returns `{ text }` and records nothing.
- Routes in `index.ts`: `GET /teach/steps`, `POST /teach/step` (not public).

- [ ] Tests first (`learning.test.ts`, the fake host answers `"area"` with a text and `speech.transcribe` with words): after a frame the event carries `step`; `steps()` lists it; `step({id, note, mark})` shows in the recording told to the agent (`Marked a place to check every time`); `step({id, remove: true})` takes it out; an unknown id is 404; `speech` with `only` leaves the steps as they were and returns the words; without `only` a `say` step appears.
- [ ] Run, see them fail; implement; run, see them pass. Commit.

### Task 3: The note card under a frame

**Files:** `plugins/browser/ui/src/{host.ts,step-text.ts,note.tsx,highlight.tsx,teach.tsx,view.tsx,styles.ts}`, locales, `plugins/browser/test/unit.test.ts`.

**Consumes:** Task 2's event and routes. **Produces:**

```ts
// host.ts
export type Mark = "check" | "varies" | "avoid" | "wait" | "result";
export interface LessonStep { id: number; kind: string; note?: string; mark?: Mark; text?: string; /* …the step's own fields */ }
// note.tsx
export function placeNote(frame: Box, layer: { width: number; height: number }, card: { width: number; height: number }): { left: number; top: number };
export function MarkChips(p: { value: Mark | null; onChange(m: Mark | null): void }): JSX.Element;
// highlight.tsx
export interface Dictation { since: number; until: number | null; put(text: string): void }
export interface Highlight { /* as today, plus */ note: { step: number; frame: Frame } | null; closeNote(): void }
export function useHighlight(allowed: boolean, onError: (text: string) => void, dictation: MutableRefObject<Dictation | null>): Highlight;
// teach.tsx
export function useLesson(teach: TeachState | null, dictation: MutableRefObject<Dictation | null>): Lesson;
```

- [ ] Test first (`unit.test.ts`): `placeNote` puts the card under the frame, above it when there is no room below, and keeps it inside the layer.
- [ ] `highlight.tsx`: on `{ok, step}` the frame stays (`note` set) instead of flashing away; a new frame or `closeNote()` ends it. `FrameNote` holds the text and the chip, posts `teach/step` on a chip tap and on close, `remove: true` from the bin; closes on Enter, the tick, Escape and a pointer press outside (capture on `window`); stops keys and pointer events from reaching the page; gives focus back to `.obb-screen`.
- [ ] Voice: while the card is open `dictation.current = {since, until: null, put}`; closing sets `until`. `teach.tsx` posts a segment with `only: true` when `since <= wordsAt` and (`until === null` or `wordsAt < until`), then `put(text)`; `put` after the card closed re-posts the note for that step.
- [ ] Strings (`ui.note.*`, `ui.mark.*`) in both locales; styles `.obb-note*`, `.obb-chip*`.
- [ ] `npm run typecheck`, `npx vitest run plugins/browser`, build the plugin UI. Commit.

### Task 4: The steps so far

**Files:** `plugins/browser/ui/src/{step-text.ts,steps.tsx,teach.tsx,view.tsx,styles.ts}`, locales, `plugins/browser/test/unit.test.ts`.

**Produces:** `stepLine(step: LessonStep, t): string`; `StepsPanel({ teach, sheet, onClose })`.

- [ ] Test first: `stepLine` with a `t` that echoes key and params gives the right key for a click, a double click, a right click, typing, a secret, a key with a count, a file, a frame with and without text, the person's words, a page, a tab, a scroll.
- [ ] `StepsPanel`: `GET teach/steps` on open and on `teach.rev`; rows with the line, the note and the mark; the bin (not on pages) posts `remove`; the pencil opens an inline editor (words of a `say`; note and chips of a frame; a note otherwise). The teach bar's count is a button that opens it (`panel === "steps"` in `view.tsx`); the panel closes when the lesson ends.
- [ ] Strings (`ui.steps.*`, `ui.step.*`) in both locales; styles `.obb-step*`.
- [ ] `npm run typecheck`, `npx vitest run plugins/browser`, `packages/core/test/i18n.test.ts`. Commit.

### Task 5: The agent, the docs, the live check

**Files:** `plugins/browser/skills/teach-by-demo/SKILL.md`, `docs/guide/{en,ru}/browser.md`.

- [ ] The skill: a short part in section 1 about what the person can do while showing, and in section 2 where each mark goes (Inputs, Checks, When something differs, the result) and that a mark or a note is not asked about again.
- [ ] The guide's teach mode, both languages: the note, the five meanings, the list of steps.
- [ ] `npm run typecheck`, `npm test`, `npm run build`.
- [ ] Live on a throwaway hub (see the memory note on live checks), wide and 375 px: frame → note typed → chip → Done → the recording in the agent's chat; the list: edit words, take a step out. Stop the hub and delete its data dir.
- [ ] Commit, push, open the PR.
