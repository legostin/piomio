// What the notes of a lesson and the lesson itself share (note.tsx, steps.tsx, teach.tsx): which note the person's
// voice belongs to, the open note's unsaved text, and the changes still on their way to the hub. Done waits for all
// of it, so nothing the person said or typed is lost when the demonstration ends. No React here: it is tested as is.

/** Where the lesson's voice goes while a note is open: words that began in [since, until) are the note's. */
export interface Dictation {
  since: number;
  /** When the card closed (null: still open). Words that began before it still belong to the note. */
  until: number | null;
  put(words: string): void;
}

export interface NoteLink {
  /**
   * The notes that take dictation: the open one and those closed not long ago. A recording is sent only after a
   * pause (or 20 s), so its words may arrive when the person is already in the next note.
   */
  targets: Dictation[];
  /** The open note saves what it holds (null: no note is open). */
  flush: (() => void) | null;
  /** Changes to steps still on their way to the hub. */
  saves: Set<Promise<unknown>>;
}

export const newNoteLink = (): NoteLink => ({ targets: [], flush: null, saves: new Set() });

/** A closed note stays a target this long: a recording is at most 20 s long and is routed right after it ends. */
export const KEEP_MS = 60_000;

/** A note opened: it takes the words from now on. Notes closed long ago are forgotten. */
export function openDictation(link: NoteLink, d: Dictation, now = Date.now()): void {
  link.targets = link.targets.filter((x) => x.until === null || now - x.until < KEEP_MS);
  link.targets.push(d);
}

/** The note the words that began at `wordsAt` belong to (the newest one when two fit); null: the lesson's own stream. */
export function dictationFor(link: NoteLink, wordsAt: number): Dictation | null {
  for (let i = link.targets.length - 1; i >= 0; i--) {
    const d = link.targets[i]!;
    if (wordsAt >= d.since && (d.until === null || wordsAt < d.until)) return d;
  }
  return null;
}
