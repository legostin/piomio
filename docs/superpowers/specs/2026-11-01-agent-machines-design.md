# Agents bound to computers

2026-11-01. Asked by the person: "bind agents to particular machines and their brains; when the machine is off, show
an error; the history still replicates". Decided with them: the binding names **computers**, not exact brain pairs.

## What the person sees

- An agent may be bound to one or more computers ("the Coder works only on the VPS"). It then thinks only with the
  brains of those computers, in its own brain order (Claude Code and Codex there; the API brains count as the brains
  of the computer the hub runs on now). Unbound agents work as before: anywhere, with the pool and the fallbacks.
- A bound agent never moves elsewhere quietly: no pool to other machines, no fallback to the hub's other brains, no
  "the conversation stays on the brain it fell back to" outside the binding.
- **The computer is off** (switched off, asleep, not leading the cluster): the chat gets an error, for example
  "Coder works only on «vps», and it is not online now. Your message is kept: send it again once it is back." The
  person's message and the error stay in the conversation, which replicates like every other one, so the history is
  whole on every replica and device; once the computer is back the agent goes on with that history.
- Everything the agent does follows the binding: dialogs, group chats, tasks, triggers, channels. A task or trigger
  placed on a computer outside the binding is refused ("Coder works only on vps").
- **Chat first.** "Пусть Кодер работает только на VPS": the assistant calls `agent_save {id, machines: ["vps"]}`
  (names or ids; `[]` unbinds). `agents_list` shows each agent's computers, and the dialog's routing context says
  where each teammate works.
- **Second way.** The agent editor's "More settings" has a Computers row: the hub's computer and the paired machines
  as toggles (none chosen = anywhere). The agent's card shows the bound computer's name.

## Model

- `AgentDef.machines?: string[]` (frontmatter `machines:`): computer ids. A paired machine is its machine id
  (`mach_…`). The hub's own computer is its replica id in a cluster (so "the Mac" stays the Mac when the VPS leads) and
  `local` in a hub of one; `local` always also means "the computer the hub runs on now". Agent files already
  replicate (`agents/`), so every replica has the binding.
- `here`: the id the hub's computer goes by (its replica id, else `local`). Saving converts `local` and the hub's name
  to `here`.

## Behaviour (core)

- `onMachines(refs, machines, here)` (shared, next to `expandBrains`): keeps the refs whose computer is bound; a ref
  `@local` is on `here`. Applied after `expandBrains`, so a bound agent's `claude-code@local` still stands for Claude
  Code on each bound machine.
- `Runner`: one place computes the agent's brains for a kind of work (`ownBrains`), used by routing, `warm()` and
  `turn()`. For a bound agent:
  - none of its computers online (a machine offline, a replica id that is not `here`) → the error message above as a
    system `error` part, the turn returns that error (tasks fail with it, triggers notify as they do for an offline
    machine);
  - no widening to other brains; the remembered `stay` brain counts only when it is inside the binding; the first-run
    setup card only when the binding includes `here`;
  - online but no usable brain there → the usual "cannot start" error with the reasons, no fallback.
- `placeTask` refuses a computer outside the binding.
- `saveAgent` treats a changed binding like changed brains (`brainsChanged`), so open conversations drop a session on
  a brain the binding no longer allows.
- Names: a bound replica id that is not `here` gets its name from the replicated `replicas` table.

## Not in scope

- Exact machine+brain pairs (the person chose computers).
- Answering a kept message by itself once the computer is back (the person asked for an error).
- The iOS app's own editor: binding there goes through the chat, like everything else.

## Tests

- shared: `onMachines` (local vs here, explicit machines, empty binding).
- core integration: a bound agent with its computer online thinks there and not on the hub; offline → the error
  part, the person's message kept, no brain called; a replica id that is not `here` is offline; `placeTask` refuses
  outside the binding; `agent_save` resolves names and `local`; unbound agents unchanged.
