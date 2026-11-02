// A group chat's name and members: the form that creates one ("New group" in the sidebar) and its settings later.
// Members are picked as chips; the first one picked leads (answers when nobody is mentioned) until another is chosen.

import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { Check, Crown } from "lucide-react";
import type { AgentDef, Conversation } from "@piomio/shared";
import { GROUP_MAX_MEMBERS, GROUP_MIN_MEMBERS } from "@piomio/shared/group";
import { useStore } from "../../lib/store";
import { errorText } from "../../lib/api";
import { groupPath, suggestedTitle } from "../../lib/team";
import { agents, createGroup, ensureAgents, updateConversation } from "../../state/app";
import { toast } from "../../state/toast";
import { AgentAvatar } from "../../components/AgentAvatar";
import { Button, cx, Field, Input, Modal, Spinner } from "../../components/ui";
import { t } from "../../i18n";

/** Agents as chips: a tap adds one to the group (at the end) or takes it out. */
function MemberChips({ list, value, onChange }: { list: AgentDef[]; value: string[]; onChange: (v: string[]) => void }) {
  const full = value.length >= GROUP_MAX_MEMBERS;
  return (
    <div className="flex flex-wrap gap-2">
      {list.map((a) => {
        const on = value.includes(a.id);
        const lead = value[0] === a.id;
        return (
          <button
            key={a.id}
            type="button"
            aria-pressed={on}
            disabled={!on && full}
            onClick={() => onChange(on ? value.filter((id) => id !== a.id) : [...value, a.id])}
            className={cx(
              "inline-flex h-9 items-center gap-2 rounded-full border py-1 pr-3 pl-1 text-sm font-medium transition select-none disabled:opacity-40",
              on ? "border-accent bg-accent-soft text-fg" : "border-border bg-surface text-muted hover:border-fg/30 hover:text-fg",
            )}
          >
            <AgentAvatar avatar={a.avatar} id={a.id} name={a.name} size={26} />
            <span className="max-w-40 truncate">{a.name}</span>
            {lead ? <Crown className="size-3.5 text-fg" aria-label={t("group.lead")} /> : on ? <Check className="size-3.5" /> : null}
          </button>
        );
      })}
    </div>
  );
}

/** Who leads, among the picked members. */
function LeadPicker({ list, value, onChange }: { list: AgentDef[]; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={t("group.lead")}>
      {value.map((id) => {
        const a = list.find((x) => x.id === id);
        const name = a?.name ?? id;
        const on = value[0] === id;
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={on}
            title={on ? undefined : t("group.makeLead", { name })}
            onClick={() => onChange([id, ...value.filter((x) => x !== id)])}
            className={cx(
              "inline-flex h-8 items-center gap-1.5 rounded-xl px-2.5 text-[13px] font-medium transition",
              on ? "bg-accent text-accent-fg shadow-sm" : "bg-surface-2 text-muted hover:text-fg",
            )}
          >
            {on && <Crown className="size-3.5" />}
            <span className="max-w-32 truncate">{name}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Creates a group (no `group`) or edits one. */
export function GroupDialog({ open, onClose, group }: { open: boolean; onClose: () => void; group?: Conversation }) {
  const list = useStore(agents);
  const [, navigate] = useLocation();
  const [title, setTitle] = useState("");
  const [members, setMembers] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => ensureAgents(), []);
  // The form starts from the group as it is when opened (new messages meanwhile do not reset it).
  useEffect(() => {
    if (!open) return;
    setTitle(group?.title ?? "");
    setMembers(group?.members ?? []);
    setBusy(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, group?.id]);

  // Members who left the team are dropped from the picker (and from the group on save); archived agents are not
  // invited, the group's own stay.
  const team = (list ?? []).filter((a) => !a.archived || group?.members?.includes(a.id));
  const picked = useMemo(() => members.filter((id) => team.some((a) => a.id === id)), [members, team]);
  const names = picked.map((id) => team.find((a) => a.id === id)?.name ?? id);
  const placeholder = names.length ? suggestedTitle(names) : t("group.namePlaceholder");
  const valid = picked.length >= GROUP_MIN_MEMBERS && picked.length <= GROUP_MAX_MEMBERS;

  const save = async () => {
    if (!valid || busy) return;
    setBusy(true);
    const name = title.trim() || suggestedTitle(names);
    try {
      if (group) {
        await updateConversation(group.id, { title: name, members: picked });
        onClose();
      } else {
        const c = await createGroup(name, picked);
        onClose();
        navigate(groupPath(c.id));
      }
    } catch (e) {
      toast(errorText(e), "error");
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={group ? t("group.settings") : t("group.newTitle")}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={!valid} loading={busy}>
            {group ? t("common.save") : t("group.create")}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label={t("group.name")}>
          <Input autoFocus={!group} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={placeholder} maxLength={120} />
        </Field>
        <Field group label={t("group.members")} hint={t("group.membersHint", { min: GROUP_MIN_MEMBERS, max: GROUP_MAX_MEMBERS })}>
          {list ? <MemberChips list={team} value={picked} onChange={setMembers} /> : <Spinner />}
        </Field>
        {picked.length >= 2 && (
          <Field group label={t("group.lead")} hint={t("group.leadHint")} className="animate-in">
            <LeadPicker list={team} value={picked} onChange={setMembers} />
          </Field>
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
