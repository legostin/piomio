// The steps of the lesson so far: what the agent will read, in the person's words. The person takes a slip out, fixes
// words that were written down wrong, puts a comment on a step and says what a framed place means. A side panel on a
// wide view, a full view on the phone. Changes go to the hub (POST teach/step) and change the recording only: nothing
// on the page is undone.

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { AppWindow, ArrowDownUp, Globe, Keyboard, Mic, MousePointerClick, Paperclip, Pencil, SquareDashedMousePointer, Type, X } from "lucide-react";
import { Button } from "@piomio/ui";
import { IconButton } from "./chrome.tsx";
import { host, t, type LessonStep, type Mark, type TeachState } from "./host.ts";
import { MarkChips, postStep } from "./note.tsx";
import { canNote, canRemove, stepLine } from "./step-text.ts";

const ICONS: Record<LessonStep["kind"], ReactNode> = {
  page: <Globe />,
  click: <MousePointerClick />,
  type: <Type />,
  key: <Keyboard />,
  tab: <AppWindow />,
  scroll: <ArrowDownUp />,
  highlight: <SquareDashedMousePointer />,
  file: <Paperclip />,
  say: <Mic />,
};

/** The change the editor of a step makes: its words (a `say`), or its note and, for a frame, what it means. */
function Editor({ step, onSave, onCancel }: { step: LessonStep; onSave(change: { text?: string; note?: string; mark?: Mark | null }): void; onCancel(): void }) {
  const words = step.kind === "say";
  const [text, setText] = useState(words ? (step.text ?? "") : (step.note ?? ""));
  const [mark, setMark] = useState<Mark | null>(step.mark ?? null);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const save = () => onSave(words ? { text } : { note: text, ...(step.kind === "highlight" ? { mark } : {}) });
  return (
    <div className="obb-step-edit">
      {step.kind === "highlight" && <MarkChips value={mark} onChange={setMark} />}
      <textarea
        ref={ref}
        className="obb-note-field"
        rows={words ? 3 : 2}
        value={text}
        maxLength={words ? 2000 : 500}
        placeholder={t(words ? "ui.steps.words" : "ui.note.placeholder")}
        aria-label={t(words ? "ui.steps.words" : "ui.note.label")}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            save();
          }
        }}
      />
      <div className="obb-step-edit-foot">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t("ui.steps.cancel")}
        </Button>
        <Button variant="primary" size="sm" onClick={save}>
          {t("ui.steps.save")}
        </Button>
      </div>
    </div>
  );
}

export function StepsPanel({ teach, sheet, onClose }: { teach: TeachState; sheet: boolean; onClose(): void }) {
  const [steps, setSteps] = useState<LessonStep[] | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  /** The list was at its end before the new steps came: it stays there. */
  const atEnd = useRef(true);

  const load = () =>
    host.plugin
      .http<{ steps: LessonStep[] }>("GET", "teach/steps")
      .then((r) => setSteps(Array.isArray(r?.steps) ? r.steps : []))
      .catch(() => setSteps((s) => s ?? []));

  useEffect(() => {
    const el = listRef.current;
    atEnd.current = !el || el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    void load();
  }, [teach.id, teach.rev]);

  useEffect(() => {
    const el = listRef.current;
    if (el && atEnd.current && editing === null) el.scrollTop = el.scrollHeight;
  }, [steps]);

  useEffect(() => {
    if (!failed) return;
    const timer = setTimeout(() => setFailed(false), 6000);
    return () => clearTimeout(timer);
  }, [failed]);

  /** Shown at once; the hub's list (on its next `rev`, or now if it refused) is the truth. */
  const change = (next: LessonStep[], body: Record<string, unknown>) => {
    setSteps(next);
    setEditing(null);
    void postStep(null, body).then((ok) => {
      if (ok) return;
      setFailed(true);
      void load();
    });
  };

  const remove = (s: LessonStep) => change((steps ?? []).filter((x) => x.id !== s.id), { id: s.id, remove: true });

  const save = (s: LessonStep, c: { text?: string; note?: string; mark?: Mark | null }) => {
    const text = c.text?.trim();
    // Words rewritten to nothing: the step goes.
    if (c.text !== undefined && !text) return remove(s);
    const next: LessonStep = { ...s };
    if (text !== undefined) next.text = text;
    if (c.note !== undefined) {
      if (c.note.trim()) next.note = c.note.trim();
      else delete next.note;
    }
    if (c.mark !== undefined) {
      if (c.mark) next.mark = c.mark;
      else delete next.mark;
    }
    change(
      (steps ?? []).map((x) => (x.id === s.id ? next : x)),
      { id: s.id, ...(text !== undefined ? { text } : {}), ...(c.note !== undefined ? { note: c.note.trim() } : {}), ...(c.mark !== undefined ? { mark: c.mark } : {}) },
    );
  };

  return (
    <div className={sheet ? "obb-sheet" : "obb-side"} role={sheet ? "dialog" : "complementary"} aria-label={t("ui.steps.title")}>
      <div className="obb-head">
        <span className="obb-head-title">{t("ui.steps.title")}</span>
        <IconButton label={t("ui.close")} onClick={onClose}>
          <X />
        </IconButton>
      </div>
      {failed && <div className="obb-error">{t("ui.steps.failed")}</div>}
      <div ref={listRef} className="obb-list obb-steps">
        {steps && !steps.length && <div className="obb-empty">{t("ui.steps.empty")}</div>}
        {(steps ?? []).map((s) => (
          <div key={s.id} className={`obb-step is-${s.kind}`}>
            <span className="obb-step-icon" aria-hidden>
              {ICONS[s.kind]}
            </span>
            <div className="obb-step-text">
              <div className="obb-step-line">{stepLine(s, t)}</div>
              {editing === s.id ? (
                <Editor step={s} onSave={(c) => save(s, c)} onCancel={() => setEditing(null)} />
              ) : (
                (s.mark || s.note) && (
                  <div className="obb-step-note">
                    {s.mark && <span className="obb-step-mark">{t(`ui.mark.${s.mark}`)}</span>}
                    {s.note}
                  </div>
                )
              )}
            </div>
            {editing !== s.id && (canNote(s) || s.kind === "say") && (
              <IconButton label={t(s.kind === "say" || s.note || s.mark ? "ui.steps.edit" : "ui.steps.addNote")} onClick={() => setEditing(s.id)}>
                <Pencil />
              </IconButton>
            )}
            {editing !== s.id && canRemove(s) && (
              <IconButton label={t("ui.steps.remove")} onClick={() => remove(s)}>
                <X />
              </IconButton>
            )}
          </div>
        ))}
      </div>
      <div className="obb-steps-foot">{t("ui.steps.foot")}</div>
    </div>
  );
}
