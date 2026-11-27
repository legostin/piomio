# Lessons the person can annotate: frame notes, what a frame means, the steps so far

The person, 2026-11-27: "во время обучения можно не только квадратики рисовать, но и комментарии оставлять: выделил
область — появилось поле комментария, можно туда надиктовать или написать руками. Что ещё можно для обучения
придумать суперполезного?" Of the ideas offered they took the first three: the comment on a frame, the meaning of a
frame in one tap, and the list of steps with editing.

## What the code does today

- A demonstration records steps (`plugins/browser/server/recorder.ts`): pages, clicks, typing, keys, tabs, scrolls,
  files, the person's words (`say`, placed by time) and frames (`highlight`: the text, the controls and a picture of
  the framed place). The agent gets them as lines in English (`stepText`, `toMarkdown`).
- A frame means only "look here". What to do with the place (check it, wait for it, never touch it) the agent finds
  out with questions after the lesson, or from words said nearby if the microphone was on.
- The live view's teach bar shows a count ("5 steps"). The person cannot see what was recorded, cannot take a slip
  out and cannot fix words that speech-to-text got wrong (noise has been written down as Persian text).

## Decided

- The frame is saved the moment it is drawn, as today: the picture and the text are of the page as it was then. The
  note and the meaning are added to that step afterwards.
- While the note field is open the person's voice goes into the field as text they can edit, not into the lesson's
  general stream.
- Five meanings, one at most per frame, none by default: check, varies, avoid, wait, result.
- Taking a step out of the list changes what the agent learns, never the page.
- Out of scope: pausing the recording, "now you, I watch", a second demonstration, good/bad examples, the requests
  behind clicks.

## Design

### The recording

`Step` gains `note?: string` (any step but a page and the person's words; at most 500 characters) and `highlight`
gains `mark?: Mark`, `Mark = "check" | "varies" | "avoid" | "wait" | "result"`. Old recordings read as before.

Inside the `Recorder` every step has a number (`id`, counting up, never reused) so the live view can name a step
while others are still being inserted (words arrive late and are placed by time). The numbers stay inside: `finish()`
leaves them out, the journal's files do not change shape. The recorder also counts its changes (`rev`).

New `Recorder` methods:

- `list()`: the steps so far with their numbers (a copy).
- `remove(id)`: takes a step out; a page stays (it is the context of the steps after it).
- `annotate(id, {note?, mark?, text?})`: `note` on any step that may have one ("" clears it); `mark` on a frame
  (`null` clears it); `text` replaces the words of a `say` step ("" takes the step out).
- `highlight()` returns the new step's number.
- The click that becomes "typing into the field" hands its note to the typing step.

For the model:

| mark | line |
| --- | --- |
| none | `Pointed at this place (look here): «…».` |
| check | `Marked a place to check every time: «…».` |
| varies | `Marked what changes from time to time (an input of the task): «…».` |
| avoid | `Marked a place not to touch: «…».` |
| wait | `Marked what to wait for before going on: «…».` |
| result | `Marked the result to bring back: «…».` |

then the controls and the picture as today, then ` The person's note: "…"`. Other steps with a note end with
` — the person's note: "…"`.

### The hub (`learning.ts`, `index.ts`)

- The `highlight` event to the live view carries `step` (the number), so the view knows what to annotate.
- `TeachState` gains `rev`: the list reloads when it changes.
- `GET teach/steps` → `{rev, steps}`: the recorder's list as it is (structured; the live view words it in the
  person's language). No recording: an empty list.
- `POST teach/step` `{id, remove?, note?, mark?, text?}` → `{ok, rev}`; 404 for a step that is not there, 409 with no
  recording. Works for a takeover's recording too (a frame drawn outside a lesson may get a note).
- `POST teach/speech` gains `only: true`: the words come back and nothing is recorded (the note field holds them).

Passwords and codes were never in the steps, so the list cannot show them.

### The live view

**The note under a frame** (`highlight.tsx`, new `note.tsx`). When the hub has taken the frame, it stays on the
picture and a small card opens next to it (below; above when there is no room; across the bottom on a phone):

- a row of chips: Check, Changes, Don't touch, Wait, Result (tap again to unset);
- a text field: "Comment: say it or type it" (without a microphone: "Comment");
- a bin (take the frame out of the lesson) and a tick (done).

Enter, the tick, a press anywhere outside or a new frame close it and save; Escape closes and saves too (the frame was
already taken; the bin is how to drop it). An empty note with no chip leaves the frame as today. Keys and pointer
events inside the card never reach the page. Closing gives the keys back to the page.

**Voice into the field.** The lesson's microphone (`teach.tsx`) keeps listening. A recording whose words began while
the field was open is sent with `only: true` and its text is appended to the field (to that frame's note if the field
has closed meanwhile). Everything else goes to the general stream as today.

**The steps so far** (new `steps.tsx`, wording in `step-text.ts`). The count in the teach bar is a button. It opens
the list: a side panel on a wide view, a sheet on a phone (as the history does). Each step is a line in the person's
language ("Clicked «Add to cart»", "Typed «2» into «Quantity»", "You said: …", "Framed: … · Check"), with its note
under it. Per step: take it out (not pages), edit (the words of a `say`; the note and the chips of a frame; a note for
anything else). The list reloads on `rev`.

### The agent (`skills/teach-by-demo/SKILL.md`)

What the marks mean and where they go in the skill's instructions: `varies` → Inputs, `check` and `wait` → Checks,
`avoid` → When something differs, `result` → what a run returns. What a mark or a note already answers is not asked
again.

### Strings and docs

All new person-facing strings in `plugins/browser/.piomio-plugin/locales/{en,ru}.json`. `docs/guide/{en,ru}/browser.md`
(teach mode) describes the note, the meanings and the list.

## Testing

- `recorder.test.ts`: marks and notes in the lines, `list`/`remove`/`annotate`, a note surviving click → typing,
  `finish()` without numbers.
- `learning.test.ts`: the frame's step number in the event, `teach/steps`, `teach/step`, `teach/speech` with `only`.
- A unit test for the list's wording and for where the note card goes (pure functions).
- Live on a throwaway hub, wide and 375 px: frame → note typed → chip → Done; the list: edit words, take a step out;
  the recording the agent gets.
