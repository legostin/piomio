# Agents bound to computers — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An agent may be bound to computers; it then thinks only with their brains, and when none of them is online
the chat gets an error while the conversation (replicated as always) keeps the message.

**Architecture:** `AgentDef.machines` (frontmatter `machines:`) holds computer ids; the hub's own computer is its
replica id in a cluster (`here`), else `local`. A pure filter `onMachines` in shared narrows the expanded brain list;
the runner uses it in one place (`ownBrains`) and refuses, with an error part, a turn whose computers are all off.
Chat first through `agent_save {machines}`; the web agent editor gets a Computers row.

**Tech Stack:** Node 24 TypeScript (type stripping), vitest, React (packages/web).

## Global Constraints

- Import local files with `.ts`; `import type` for types; no enums / parameter properties / namespaces.
- Every user-facing string in a catalog: core `packages/core/src/locales/{en,ru}.ts`, web `packages/web/src/i18n/{en,ru}.ts`; English is the source; parity is tested.
- Text for the model (tool results, descriptions, prompt lines) is English and not translated.
- Unbound agents behave exactly as before.

---

### Task 1: `onMachines` and the agent file field

**Files:**
- Modify: `packages/shared/src/types.ts` (AgentDef, new `Computer`)
- Modify: `packages/shared/src/thinking.ts` (after `expandBrains`)
- Modify: `packages/core/src/agents.ts` (read/write `machines`)
- Test: `packages/shared/test/thinking.test.ts`

**Interfaces:**
- Produces: `onMachines(refs: readonly string[], machines: readonly string[] | undefined, here: string): string[]`,
  `bound(machines): boolean`, `AgentDef.machines?: string[]`, `Computer { id; name; online; standby? }`.

- [ ] Step 1: failing test in `packages/shared/test/thinking.test.ts`:

```ts
describe("agents bound to computers", () => {
  const refs = ["claude-code@local", "api:anthropic@local", "claude-code@mach_vps", "codex@mach_vps", "codex@mach_box"];
  it("keeps every brain when the agent is bound to nothing", () => {
    expect(onMachines(refs, undefined, "local")).toEqual(refs);
    expect(onMachines(refs, [], "rep_mac")).toEqual(refs);
  });
  it("keeps the brains of its computers only, the hub's own by its replica id or local", () => {
    expect(onMachines(refs, ["mach_vps"], "rep_mac")).toEqual(["claude-code@mach_vps", "codex@mach_vps"]);
    expect(onMachines(refs, ["rep_mac"], "rep_mac")).toEqual(["claude-code@local", "api:anthropic@local"]);
    expect(onMachines(refs, ["local", "mach_box"], "rep_vps")).toEqual(["claude-code@local", "api:anthropic@local", "codex@mach_box"]);
    // The Mac is bound, the VPS leads: nothing here is the Mac.
    expect(onMachines(refs, ["rep_mac"], "rep_vps")).toEqual([]);
    expect(onMachines(["codex"], ["local"], "local")).toEqual(["codex"]);
  });
});
```

- [ ] Step 2: `npx vitest run packages/shared/test/thinking.test.ts` → FAIL (`onMachines` not exported).
- [ ] Step 3: implement in `thinking.ts`:

```ts
/** Whether an agent is bound to computers (AgentDef.machines). */
export function bound(machines: readonly string[] | undefined): machines is readonly string[] {
  return !!machines?.length;
}

/**
 * The refs on an agent's computers (AgentDef.machines); all of them when it is bound to none. A ref on "local" runs on
 * the hub's own computer, which a binding names by `here` (its replica id in a cluster) or "local".
 */
export function onMachines(refs: readonly string[], machines: readonly string[] | undefined, here: string): string[] {
  if (!bound(machines)) return [...refs];
  return refs.filter((r) => {
    const at = r.lastIndexOf("@");
    const m = at > 0 ? r.slice(at + 1) : "local";
    return m === "local" ? machines.includes("local") || machines.includes(here) : machines.includes(m);
  });
}
```

  `types.ts` AgentDef, after `brains`:

```ts
  /**
   * The computers the agent thinks on (machine ids; the hub's own by its replica id in a cluster, else "local"): only
   * their brains, and an error when none is online. Unset or empty: anywhere.
   */
  machines?: string[];
```

  and next to `Machine`:

```ts
/** A computer an agent may be bound to: the hub's own (`id` its replica id or "local"), a paired machine, or another replica (`standby`). */
export interface Computer {
  id: string;
  name: string;
  online: boolean;
  standby?: boolean;
}
```

  `agents.ts`: `agentFromMarkdown` adds `...(list(data.machines, []).length ? { machines: list(data.machines, []) } : {})`;
  `agentToMarkdown` adds `...(a.machines?.length ? { machines: a.machines } : {})` after `brains`.
- [ ] Step 4: run the test → PASS; `npm run typecheck`.
- [ ] Step 5: commit.

### Task 2: the runner keeps a bound agent on its computers

**Files:**
- Modify: `packages/core/src/runner.ts` (deps `here`, `ownBrains`, `away`, `turn`, `warm`, `routeFor`, `placeTask`, `dispatchContext`)
- Modify: `packages/core/src/app.ts` (deps `here`, `machineName` falls back to replicas; `saveAgent` normalizes and marks brains changed)
- Modify: `packages/core/src/locales/{en,ru}.ts` (`chat.machinesOff`, `chat.noBrainOn`)
- Test: `packages/core/test/agent-machines.test.ts` (new)

**Interfaces:**
- Consumes: `onMachines`, `bound` (Task 1).
- Produces: `RunnerDeps.here?: () => string`; `Hub.here(): string`; `Hub.resolveComputer(idOrName: string): string | undefined`;
  `Hub.computers(): Computer[]`; `Runner.computerName(id: string): string`.

- [ ] Step 1: failing integration test `agent-machines.test.ts`: hub on fixtures (as dispatch.test.ts), a fake machine
  `mach_box` registered with `hub.brains.registerMachine("mach_box", "box", fakePeer, [{ id: "fake", label: "Fake" }])`
  where `fakePeer` is the fixture plugin's peer, and `hub.machines.list` patched to report `mach_box` online or not.
  Cases: bound to `mach_box` online → the session's brainRef is `fake@mach_box`; offline → a system `error` part
  naming "box", the person's message kept, no new session; bound to `rep_other` (not here) → offline error naming it;
  `task_delegate {machine:"local"}` for an agent bound to box → refused; unbound → `fake@local` as before.
- [ ] Step 2: run → FAIL.
- [ ] Step 3: implement (code in the commit): `ownBrains`, `away(agent)` → error text or undefined, the check at the
  top of `turn()` (system error part with `taskId`), no widening / setup hold / foreign `stay` for bound agents,
  `chat.noBrainOn` when the bound computers are online but none of the agent's brains is there, `placeTask` refusal,
  `dispatchContext.where` = bound computers' names; `Hub.saveAgent` resolves `machines` (names, `local`, the hub's
  name → `here`) and calls `brainsChanged` when they change.
- [ ] Step 4: run → PASS; `npx vitest run packages/core/test/dispatch.test.ts packages/core/test/i18n.test.ts`.
- [ ] Step 5: commit.

### Task 3: chat first — `agent_save` / `agents_list`, `/api/computers`

**Files:**
- Modify: `packages/core/src/tools/hub-tools.ts` (`agents_list` shows `machines` by name; `agent_save` takes `machines`)
- Modify: `packages/core/src/server/api.ts` (`GET /api/computers`)
- Test: `packages/core/test/agent-machines.test.ts`

- [ ] Step 1: failing test: `CALL agent_save {"id":"coder","machines":["box"]}` from the assistant's dialog stores
  `["mach_box"]`; `["atlantis"]` is refused naming the computers; `[]` unbinds; `GET /api/computers` lists the hub's
  computer first (`id` = here) and `box`.
- [ ] Step 2: run → FAIL. Step 3: implement. Step 4: run → PASS. Step 5: commit.

### Task 4: web — Computers row in the agent editor, badge on the card

**Files:**
- Modify: `packages/web/src/pages/Agents.tsx`, `packages/web/src/i18n/{en,ru}.ts`

- [ ] Step 1: `ComputersPicker` (toggle chips from `/api/computers`; a standby replica shows only when chosen; offline
  ones say so), state `machines` saved with the agent; card badge "only on {names}".
- [ ] Step 2: `npm run typecheck`, `npx vitest run packages/core/test/i18n.test.ts packages/web`, `npm run build`.
- [ ] Step 3: commit.

### Task 5: whole check

- [ ] `npm run typecheck` and `npm test`; fix what fails; commit.
