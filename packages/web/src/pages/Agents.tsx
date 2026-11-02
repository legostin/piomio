// Agents: list, edit, delete. New agents are made in the chat with the default agent ("Add agent"). Deleting asks
// as the agent's menu in the team list does (chat/AgentMenu.tsx): the default agent's successor first, then a confirmation.

import { useEffect, useState } from "react";
import { ArchiveRestore, ArrowDown, ArrowUp, ChevronDown, ChevronRight, Pencil, Plus, Sparkles, Trash2, X } from "lucide-react";
import type { AgentAvatar as AgentAvatarValue, AgentDef, Computer } from "@piomio/shared";
import { AVATAR_COLORS, AVATAR_PALETTE, AVATAR_SHAPES, defaultAvatar } from "@piomio/shared/avatar";
import { useStore } from "../lib/store";
import { api, errorText } from "../lib/api";
import { agents, hubEvents, refreshAgents } from "../state/app";
import { activeBrain, brainName, brainReady, brains, brainStatus, ensureBrains, findBrain, normalizeBrainRef } from "../state/brains";
import { addAgent, clearPanelIntent, panel } from "../state/panel";
import { toast } from "../state/toast";
import { t, type MessageKey } from "../i18n";
import { archiveAgent } from "../state/agentActions";
import { useAgentMenu } from "./chat/AgentMenu";
import { AgentAvatar } from "../components/AgentAvatar";
import { Badge, Button, cx, EmptyState, ErrorNote, Field, IconButton, Input, Loading, Modal, Page, TagInput, Textarea } from "../components/ui";

const INITIATIVE: Array<{ value: 0 | 1 | 2; title: MessageKey; text: MessageKey }> = [
  { value: 0, title: "agents.initiative0", text: "agents.initiative0Text" },
  { value: 1, title: "agents.initiative1", text: "agents.initiative1Text" },
  { value: 2, title: "agents.initiative2", text: "agents.initiative2Text" },
];

const SOURCE: Record<string, MessageKey> = { builtin: "agents.source.builtin", user: "agents.source.user" };

/** The computers an agent may be bound to (GET /api/computers): undefined while loading, [] when the hub has none to say. */
function useComputers(): Computer[] | undefined {
  const [list, setList] = useState<Computer[]>();
  useEffect(() => {
    let live = true;
    api
      .get<Computer[]>("/api/computers")
      .then((l) => live && setList(l))
      .catch(() => live && setList([]));
    return () => {
      live = false;
    };
  }, []);
  return list;
}

/** The names of the computers an agent is bound to, for people. */
const computerNames = (ids: string[], computers: Computer[] | undefined) => ids.map((id) => computers?.find((c) => c.id === id)?.name ?? id).join(", ");

export function AgentsPage() {
  const list = useStore(agents);
  const brainList = useStore(brains);
  useEffect(() => ensureBrains(), []);
  const computers = useComputers();
  const p = useStore(panel);
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState<AgentDef | null>(null);
  const menu = useAgentMenu();
  // Each agent's own skills: the ones given to it, not the whole team's.
  const [own, setOwn] = useState<Record<string, string[]>>({});

  const load = () => {
    setError(undefined);
    refreshAgents().catch((e) => setError(errorText(e)));
  };
  useEffect(load, []);

  useEffect(() => {
    const loadSkills = () =>
      api.get<Array<{ name: string; agents: string[] }>>("/api/skills").then(
        (list) => {
          const by: Record<string, string[]> = {};
          for (const s of list) for (const id of s.agents) (by[id] ??= []).push(s.name);
          setOwn(by);
        },
        () => {},
      );
    void loadSkills();
    return hubEvents.on((e) => {
      if (e.type === "skills.updated" || e.type === "plugins.updated") void loadSkills();
      if (e.type === "replica.synced" && e.data.tables.includes("skill_agents")) void loadSkills();
    });
  }, []);

  // A request from outside the panel: an agent's settings (dialog header).
  useEffect(() => {
    const intent = p.intent;
    if (!intent || !list) return;
    const a = list.find((x) => x.id === intent.agentId);
    if (a) setEditing(a);
    clearPanelIntent();
  }, [p.intent, list]);

  return (
    <Page
      title={t("nav.agents")}
      subtitle={t("agents.subtitle")}
      actions={
        <Button variant="primary" icon={<Plus className="size-4" />} onClick={addAgent}>
          {t("agents.new")}
        </Button>
      }
    >
      {error && <ErrorNote onRetry={load}>{error}</ErrorNote>}
      {!list && !error && <Loading />}
      {list && list.length === 0 && <EmptyState icon="bot" title={t("agents.empty")} />}
      <div className="grid gap-3 sm:grid-cols-2">
        {list?.map((a) => (
          <div key={a.id} className="flex flex-col rounded-2xl border border-border bg-surface p-4 shadow-card">
            <div className="flex items-start gap-3">
              <AgentAvatar avatar={a.avatar} id={a.id} name={a.name} size={40} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{a.name}</span>
                  <span className="font-mono text-xs text-muted">{a.id}</span>
                </div>
                <div className="mt-0.5 line-clamp-2 text-sm text-muted">{a.description || t("agents.noDescription")}</div>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              <Badge tone="info">{t("agents.initiativeBadge", { level: a.initiative })}</Badge>
              <Badge>{SOURCE[a.source] ? t(SOURCE[a.source]) : a.source}</Badge>
              {a.archived && <Badge tone="warning">{t("agents.archived")}</Badge>}
              {a.model && <Badge>{a.model}</Badge>}
              {(() => {
                const on = activeBrain(a.brains, brainList);
                return <Badge tone={on ? "success" : "warning"}>{on ? on.label : t("brainPicker.none")}</Badge>;
              })()}
              {!!a.machines?.length && (
                <Badge className="max-w-full min-w-0">
                  <span className="truncate" title={computerNames(a.machines, computers)}>
                    {t("agents.onlyOn", { names: computerNames(a.machines, computers) })}
                  </span>
                </Badge>
              )}
            </div>
            {own[a.id]?.length ? (
              <div className="mt-2 flex flex-wrap gap-1.5" aria-label={t("agents.ownSkills")}>
                {own[a.id].map((name) => (
                  <Badge key={name} tone="info">
                    <Sparkles className="size-3" />
                    {name}
                  </Badge>
                ))}
              </div>
            ) : null}
            <div className="mt-auto flex justify-end gap-1 pt-3">
              <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => menu.requestDelete(a)}>
                {t("common.delete")}
              </Button>
              {a.archived && (
                <Button
                  size="sm"
                  icon={<ArchiveRestore className="size-3.5" />}
                  onClick={() =>
                    archiveAgent(a.id, false).then(
                      () => toast(t("agentMenu.restored", { name: a.name }), "success"),
                      (e) => toast(errorText(e), "error"),
                    )
                  }
                >
                  {t("agentMenu.restore")}
                </Button>
              )}
              <Button size="sm" icon={<Pencil className="size-3.5" />} onClick={() => setEditing(a)}>
                {t("common.edit")}
              </Button>
            </div>
          </div>
        ))}
      </div>

      {editing && <AgentEditor agent={editing} onClose={() => setEditing(null)} />}
      {menu.element}
    </Page>
  );
}

function BrainsEditor({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const list = useStore(brains);
  useEffect(() => ensureBrains(), []);
  const suggestions = (list ?? []).map((b) => b.ref);
  const [draft, setDraft] = useState("");
  const move = (i: number, d: number) => {
    const next = value.slice();
    const [x] = next.splice(i, 1);
    next.splice(i + d, 0, x);
    onChange(next);
  };
  const add = (ref: string) => {
    const r = ref.trim();
    if (r && !value.some((v) => normalizeBrainRef(v) === normalizeBrainRef(r))) onChange([...value, r]);
    setDraft("");
  };
  const taken = new Set(value.map(normalizeBrainRef));
  const free = suggestions.filter((s) => !taken.has(normalizeBrainRef(s)));
  return (
    <div className="flex flex-col gap-2">
      {value.length === 0 && <div className="text-sm text-muted">{t("agents.brainsEmpty")}</div>}
      <ol className="flex flex-col gap-1.5">
        {value.map((b, i) => (
          <li key={b} className="flex items-center gap-2 rounded-xl border border-border bg-surface-2/60 py-1 pr-1 pl-3">
            <span className="w-5 text-xs text-muted">{i + 1}.</span>
            <span className="min-w-0 flex-1 truncate text-sm" title={b}>
              {brainName(b, list)}
            </span>
            {(() => {
              const row = findBrain(list, b);
              if (!row) return <Badge>{t("brains.status.notConnected")}</Badge>;
              if (brainReady(row)) return null;
              const st = brainStatus(row);
              return <Badge tone={st.tone}>{st.label}</Badge>;
            })()}
            <IconButton label={t("agents.moveUp")} disabled={i === 0} onClick={() => move(i, -1)} className="size-7">
              <ArrowUp className="size-3.5" />
            </IconButton>
            <IconButton label={t("agents.moveDown")} disabled={i === value.length - 1} onClick={() => move(i, 1)} className="size-7">
              <ArrowDown className="size-3.5" />
            </IconButton>
            <IconButton label={t("common.remove")} onClick={() => onChange(value.filter((x) => x !== b))} className="size-7">
              <X className="size-3.5" />
            </IconButton>
          </li>
        ))}
      </ol>
      <div className="flex gap-2">
        <Input
          value={draft}
          list="brain-refs"
          onChange={(e) => setDraft(e.target.value)}
          placeholder="claude-code@local, api:anthropic, codex@laptop…"
          className="font-mono"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add(draft);
            }
          }}
        />
        <Button onClick={() => add(draft)} disabled={!draft.trim()}>
          {t("common.add")}
        </Button>
        <datalist id="brain-refs">
          {free.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      </div>
      {free.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {free.slice(0, 8).map((s) => (
            <button key={s} type="button" onClick={() => add(s)} title={s} className="rounded-lg border border-dashed border-border px-2 py-0.5 text-xs text-muted hover:border-accent hover:text-accent-text">
              + {brainName(s, list)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The computers an agent thinks on, as toggles (none chosen: anywhere); another replica of the hub shows only when chosen. */
function ComputersPicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const computers = useComputers();
  if (!computers) return <Loading />;
  const shown: Computer[] = [
    ...computers.filter((c) => !c.standby || value.includes(c.id)),
    ...value.filter((id) => !computers.some((c) => c.id === id)).map((id) => ({ id, name: id, online: false })),
  ];
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("agents.computers")}>
      {shown.map((c) => {
        const on = value.includes(c.id);
        return (
          <button
            key={c.id}
            type="button"
            aria-pressed={on}
            onClick={() => toggle(c.id)}
            className={cx(
              "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-sm transition",
              on ? "border-accent bg-accent-soft text-accent-text" : "border-border text-muted hover:bg-surface-2 hover:text-fg",
            )}
          >
            {c.name}
            {!c.online && <span className="text-xs text-muted">{t("agents.computerOffline")}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** Colour swatches and shape tiles; the big preview (unless the caller shows the avatar itself) wears the agent's face. */
export function AvatarPicker({
  value,
  onChange,
  name,
  id,
  preview = true,
  disabled,
}: {
  value: AgentAvatarValue;
  onChange: (v: AgentAvatarValue) => void;
  name: string;
  /** The agent's id, for its face (a new agent's face comes from its name until it has one). */
  id?: string;
  preview?: boolean;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-start">
      {preview && (
        <div className="hero-halo flex size-32 shrink-0 items-center justify-center rounded-3xl bg-surface-2/70">
          <AgentAvatar avatar={value} id={id} name={name || "?"} size={96} />
        </div>
      )}
      <div className="flex w-full min-w-0 flex-col gap-4">
        <div>
          <div className="mb-2 text-sm font-medium">{t("agents.avatarColor")}</div>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t("agents.avatarColor")}>
            {AVATAR_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={value.color === c}
                aria-label={t(`avatar.color.${c}` as MessageKey)}
                title={t(`avatar.color.${c}` as MessageKey)}
                disabled={disabled}
                onClick={() => onChange({ ...value, color: c })}
                className={cx("press size-8 rounded-full shadow-[inset_0_1px_0_rgb(255_255_255/0.35)] transition", value.color === c ? "ring-2 ring-accent ring-offset-2 ring-offset-surface" : "hover:scale-110")}
                style={{ background: `linear-gradient(180deg, ${AVATAR_PALETTE[c].top}, ${AVATAR_PALETTE[c].bottom})` }}
              />
            ))}
          </div>
        </div>
        <div>
          <div className="mb-2 text-sm font-medium">{t("agents.avatarShape")}</div>
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={t("agents.avatarShape")}>
            {AVATAR_SHAPES.map((sh) => (
              <button
                key={sh}
                type="button"
                role="radio"
                aria-checked={value.shape === sh}
                aria-label={t(`avatar.shape.${sh}` as MessageKey)}
                title={t(`avatar.shape.${sh}` as MessageKey)}
                disabled={disabled}
                onClick={() => onChange({ ...value, shape: sh })}
                className={cx(
                  "flex size-11 items-center justify-center rounded-xl border transition",
                  value.shape === sh ? "border-accent bg-accent-soft/60 ring-4 ring-accent/15" : "border-hairline hover:bg-surface-2",
                )}
              >
                <AgentAvatar avatar={{ color: value.color, shape: sh }} id={id} name={name} size={28} />
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Edit an agent: who it is and what it does up front, the technical knobs under "More settings". */
export function AgentEditor({ agent, onClose }: { agent: AgentDef; onClose: () => void }) {
  const [name, setName] = useState(agent.name);
  const [avatar, setAvatar] = useState<AgentAvatarValue>(() => agent.avatar ?? defaultAvatar(agent.id));
  const [description, setDescription] = useState(agent.description);
  const [brains, setBrains] = useState<string[]>(agent.brains);
  const [machines, setMachines] = useState<string[]>(agent.machines ?? []);
  const [model, setModel] = useState(agent.model ?? "");
  const [initiative, setInitiative] = useState<0 | 1 | 2>(agent.initiative);
  const [tools, setTools] = useState<string[]>(agent.tools);
  const [skills, setSkills] = useState<string[]>(agent.skills);
  const [policyProfile, setPolicyProfile] = useState(agent.policyProfile);
  const [runs, setRuns] = useState(String(agent.budget.backgroundRunsPerDay));
  const [prompt, setPrompt] = useState(agent.prompt);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const save = async () => {
    setError(undefined);
    if (!name.trim()) return setError(t("agents.errorName"));
    const n = Number(runs);
    if (!Number.isInteger(n) || n < 0) {
      setMore(true);
      return setError(t("agents.errorRuns"));
    }
    setBusy(true);
    try {
      await api.put<AgentDef>(`/api/agents/${encodeURIComponent(agent.id)}`, {
        name: name.trim(),
        avatar,
        description: description.trim(),
        brains,
        machines,
        model: model.trim() || undefined,
        initiative,
        tools,
        skills,
        policyProfile: policyProfile.trim() || "default",
        budget: { ...agent.budget, backgroundRunsPerDay: n },
        prompt,
      });
      toast(t("agents.saved"), "success");
      await refreshAgents();
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={t("agents.editTitle", { name: agent.name })}
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" onClick={() => void save()} loading={busy}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <Field label={t("agents.name")}>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("agents.namePlaceholder")} maxLength={60} />
        </Field>
        <AvatarPicker value={avatar} onChange={setAvatar} name={name} id={agent.id} />
        <Field label={t("agents.description")} hint={t("agents.descriptionHint")}>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label={t("agents.prompt")} hint={t("agents.promptHint")}>
          <Textarea rows={6} value={prompt} onChange={(e) => setPrompt(e.target.value)} className="text-[14px]" placeholder={t("agents.promptPlaceholder")} />
        </Field>
        <Field group label={t("agents.initiative")}>
          <InitiativeChoice value={initiative} onChange={setInitiative} />
        </Field>
        <div className="rounded-2xl border border-border">
          <button type="button" onClick={() => setMore((v) => !v)} aria-expanded={more} className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm font-medium">
            {more ? <ChevronDown className="size-4 text-muted" /> : <ChevronRight className="size-4 text-muted" />}
            {t("agents.more")}
            <span className="min-w-0 flex-1 truncate text-right text-xs font-normal text-muted">{t("agents.moreHint")}</span>
          </button>
          {more && (
            <div className="flex flex-col gap-5 border-t border-border p-3">
              <Field label={t("agents.id")} hint={t("agents.idFixed")}>
                <Input value={agent.id} disabled className="font-mono" />
              </Field>
              <Field group label={t("agents.brains")} hint={t("agents.brainsHint")}>
                <BrainsEditor value={brains} onChange={setBrains} />
              </Field>
              <Field group label={t("agents.computers")} hint={t("agents.computersHint")}>
                <ComputersPicker value={machines} onChange={setMachines} />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t("agents.model")} hint={t("agents.modelHint")}>
                  <Input value={model} onChange={(e) => setModel(e.target.value)} className="font-mono" />
                </Field>
                <Field label={t("agents.policy")}>
                  <Input value={policyProfile} onChange={(e) => setPolicyProfile(e.target.value)} className="font-mono" />
                </Field>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field group label={t("agents.tools")} hint={t("agents.toolsHint")}>
                  <TagInput value={tools} onChange={setTools} placeholder="*" />
                </Field>
                <Field group label={t("agents.skills")} hint={t("agents.skillsHint")}>
                  <TagInput value={skills} onChange={setSkills} placeholder="*" />
                </Field>
              </div>
              <Field label={t("agents.runs")} hint={t("agents.runsHint")}>
                <Input type="number" min={0} value={runs} onChange={(e) => setRuns(e.target.value)} className="sm:w-40" />
              </Field>
            </div>
          )}
        </div>
        {error && <ErrorNote>{error}</ErrorNote>}
      </div>
    </Modal>
  );
}

/** Proactivity as three choices with a line each; also used by the new-agent card in the chat. */
export function InitiativeChoice({ value, onChange, disabled }: { value: 0 | 1 | 2 | undefined; onChange: (v: 0 | 1 | 2) => void; disabled?: boolean }) {
  return (
    <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label={t("agents.initiative")}>
      {INITIATIVE.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          disabled={disabled}
          onClick={() => onChange(o.value)}
          aria-checked={value === o.value}
          className={cx(
            "rounded-xl border p-3 text-left transition disabled:opacity-60",
            value === o.value ? "border-accent bg-accent-soft/60 ring-2 ring-accent/20" : "border-border hover:bg-surface-2",
          )}
        >
          <div className="text-sm font-semibold">{t(o.title)}</div>
          <div className="mt-1 text-xs leading-relaxed text-muted">{t(o.text)}</div>
        </button>
      ))}
    </div>
  );
}
