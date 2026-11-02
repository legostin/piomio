# Agents that don't give up, and rules for where work goes

Asked 2026-11-02: «агенты слишком легко сдаются. ещё я могу написать в основном агенте — запускать задачи на рендеринг
на машине с ГПУ, например legostin-pc — и он будет именно так действовать и задействовать для задачи мозг на той машине».

## What the hub's own data showed

- **Codex agents stop at the hub's tools.** Codex 0.153+ asks before an MCP tool call unless the server's
  `default_tools_approval_mode` says otherwise. It asks over `item/tool/requestUserInput` / `mcpServer/elicitation/request`,
  which `codex-app.ts` answers "not supported", and Codex reports `user rejected MCP tool call`. The agent then reads it
  as the person's no ("загрузка отклонена, прикрепи файл сам"): the Song Book and Ozon tasks of 2026-11-01 ended so.
- **Tasks fail in 3 seconds when no brain is connected.** At 03:00, 05:00 and 07:02 (the Mac waking) every trigger task
  failed with "Can't start the agent …: not connected", and "RPC peer closed" (a brain's process died) failed others.
  Nothing tried again.
- **No rule says to keep going.** A task that met one obstacle (the sandbox closed the Desktop, a site did not open)
  reported "could not" at once, and the dialog passed that on.
- **A lost correction.** `task_message` called with `message` instead of `text` delivered "writes: undefined".

## Decided with the person

- Rules for where work goes are **the team's**, not one agent's: said once to any agent, followed by every dialog.
- A task placed on a computer that is **offline waits for it** and starts when it comes online.

## Design

### 1. Codex runs the hub's tools without asking

`codex.ts` adds `mcp_servers.piomio.default_tools_approval_mode="approve"` (accepted by 0.153 and 0.165). The hub's
gateway already decides about each of its tools (policy, auto mode, cards), as it does for Claude Code.

### 2. Tasks wait for a brain instead of failing

- `turn()` tells a task apart that cannot start only because its brains are **not connected** (none signed out, none
  missing): `errorCode: "brain-offline"`, and no error message in the task's chat.
- A turn whose brain died (a fatal error, not a limit) returns `broken: true`.
- `afterTaskTurn`: `brain-offline` → the task goes back to `queued` with `resumeAt` one minute later and a reason
  (`task.waitingBrain`, or `task.waitingMachine` for a task placed on a computer); `broken` → the same, "continue where
  you stopped", up to 3 times. `scheduleTasks` leaves a queued task alone until its `resumeAt`.
- How long it waits (in memory, from the first miss): 30 minutes, 24 hours for a task placed on a computer. Then it fails
  as today (the error message, the notice).
- A background run counts against the agent's daily budget only when it really ran.

### 3. Prompts: keep going

- **In a task:** an obstacle is a reason to try another way to the same result (another tool or command, source or route,
  the task's own folder instead of a closed place, a teammate or computer that has what is missing); two or three really
  different ways before calling it impossible. A refused step is about that step, not the task. The person's no (a card
  they declined) is never worked around. "Could not" only at the end, with what was tried and what would unblock it.
- **In a dialog:** a task back without what was asked is started again at once another way (what it learned, another
  approach, teammate, brain or computer), once, with a line to the user; the user hears it failed only after that, and is
  asked only what only they can give.
- **A goal:** an obstacle that can be worked around is not `blocked`.

### 4. task_message takes `message` too

A guessed `message` (or `note`) is the text; an empty one is refused instead of sending "undefined".

### 5. Work rules (the team's)

- `WorkRule { id, when, machine?, agent?, brain?, createdAt }` in the setting key `workRules` (replicated like other
  settings). `when` is the person's words for the kind of work ("rendering, anything for the GPU").
- Tools for dialogs: `work_rule_set` (new or changed by `id`; the computer by id or name, the agent by id or name) and
  `work_rule_remove`. `task_agents` lists them.
- Every dialog's "How you work" lists the rules and says: follow a fitting rule in `task_delegate` (its `machine`,
  `agent`, `brain`); the request's own words win; when the user says how some work should always go, save it with
  `work_rule_set` and say so in a line. The rules are part of the session stamp, so a changed rule reaches live dialogs.
- `placeTask` on an offline computer: the agent's brain there (its own entry, or the same kind of brain the computer
  reported signed in), so the task waits for it (2); the tool says it starts when the computer comes online.

### 6. Graphics cards

- `@piomio/shared/hardware`: `graphicsCards()` — macOS `system_profiler SPDisplaysDataType -json`, Windows
  `Get-CimInstance Win32_VideoController` (PowerShell), Linux `nvidia-smi` then `lspci`; names only, once, cached.
- `MachineInfo.gpus` from nodes; the hub's own computer reads its own. The computers list in a dialog's prompt,
  `task_agents` and `machine_list` show "GPU: …", so "a computer with a GPU" works without naming it.
- Old nodes report none: shown without a GPU until they update.

## Testing

- Unit: Codex config has the approval mode; task_message alias; work rules store and tools; prompt lines; placeTask
  offline; hardware parsing of each OS's output.
- Runner (fake brains): a task with no connected brain waits and runs when one connects; one placed on an offline
  computer waits; a broken turn continues; after the window it fails as before.
- Docs: the tasks and computers pages in `docs/guide/{en,ru}`.

## Follow-up: the render really runs on the PC (2026-11-02, live check)

The live check showed the rule and the routing work, and why the render still did not happen on LEGOSTIN-PC: the
hub's Blender integration drives Blender on the hub's own Mac (it rendered there and replaced the person's unsaved
scene), and Claude Code on the PC may not run commands (its policy: `exec.enabled` false, don't-ask mode). A later task
found `blender.exe`, wrote the scene and stopped only at that permission. The person asked how to allow it "from this
computer" and chose: **from the chat, with their yes on a card**.

### 7. Commands on a computer, from the chat

- Node policy: `exec.enabled` is "commands on this computer". New `hubChanges` (default true): false keeps the
  permissions on the computer itself. RPC `node.policy {commands}` writes `exec.enabled` into policy.json (the
  person's other fields stay as they are) unless `hubChanges` is false; the node reports `commands` in its info.
- Hub tool `hub_machine_commands {machine, on}` (the default agent's): always the person's own card (OWN_CARD_TOOLS:
  auto mode never decides it, "you asked" never skips it). A node too old for it says to update that computer's app once.
- A node's Claude Code with commands on asks the hub (`BrainSessionOptions.askTool`, the hub's native_permission) for
  what is not in its allowed tools, so its commands go through auto mode and cards as on the hub; with commands off it
  stays in don't-ask mode.
- Prompts: a session on another computer hears whether commands are on there and how the person turns them on; the
  dialog's computers list says "commands off".

### 8. Apps on the hub's computer stay there

- Manifest `integration.localApp`: the plugin's tools drive an app on the hub's own computer (Blender). The gateway
  hides them from sessions whose brain runs on another computer, so a task there uses that computer's own app.

### 9. Pictures made on another computer

- `show_images` with a path on another computer looks in the hub's copy of the task's folder (the hub pulls a
  machine's workspaces every 5 s), waiting up to 30 s for it; an absolute path is taken relative to the task's folder.

### 10. The desktop app on a node updates from the hub

- The desktop app passes `PIOMIO_DESKTOP_APP` to its node too; the node reports `desktopApp: true` and takes
  `node.appUpdate` by starting `<app> --install-update`. The hub offers Update for such a node when it runs an older
  version than the hub, and `hub_machine_update` does it. The PC needs this once by hand (tray → Install update).
