# Code mode: tools as functions

The person, 2026-11-24: "можно сделать свой аналог code mode, особенно для частых кейсов: скрипт сам сходит по mcp,
вызовет нужные команды, тулзы использует, и всё из сохранённого скрипта. То есть вызовы mcp становятся функциями,
которые из кода можно вызывать, и агент может писать такие скрипты. У самого агента появляются методы: search ищет
подходящий инструмент, execute выполняет скрипт. Это не замена, а дополнение, которое можно включить, с настройками".
It grows out of scripts for taught skills (`2026-11-23-skill-scripts-design.md`).

## What the code does today

- An agent's brain gets every tool it may call as a list (the `piomio` MCP server, `ToolGateway.listFor`): core
  tools, plugins, integrations and the MCP servers the person connected. Each call is a model step, and each answer
  goes through the model's context whole.
- A taught skill's script (`skill-scripts.ts`) already runs in the hub's sandbox (QuickJS on a worker thread) and
  calls the agent's browser tools through `ToolGateway.call` under the agent's session: every step is audited and
  decided as if the model had made it.
- A trigger's script may call the agent's read tools (`ToolGateway.callRead`), with no session and no cards.

## Decided (the person's answers, 2026-11-24)

- **Three levels, per agent**: off (the default), "beside" (the list stays, the two tools are added) and "code
  first" (the list keeps the basics, the rest is found by search and called from code).
- **Actions as with skills**: each call of a script is decided as the agent's own; a saved script's card may
  pre-approve particular actions within limits.
- **The agent runs scripts first; runs with no model come later**, as a step of their own.

## Design

### The two tools

`code_search` (read): words → the tools the agent could call that fit, each as a function a script calls:
`tools.gmail_search_threads({query: string, max?: number})`, a line of what it does, and whether it changes anything
outside. `full: true` gives the whole description and the JSON Schema of the few it names. Matching is by words
over the name, the owner and the description; no embeddings.

`code_execute` (read by itself: it does nothing but what its calls do): `code`, JavaScript or TypeScript whose
default export is `async function (input, tools)`; a bare function body is taken as that function's. `input` is any
JSON. It returns what the script returned (JSON, up to 20 000 characters to the model), the script's log lines
(`console.log`), or where it stopped and why, with the calls made before that.

### Tools as functions

- `tools.<name>(input)` is `ToolGateway.call(session, name, input)`: hooks, the policy, cards, auto mode, taint, the
  egress guard and the audit log are the ones the agent's own call goes through. A script reaches nothing the agent
  could not, and nothing is decided differently.
- The answer is the tool's text, parsed when it is a JSON object or array; an error is thrown as an `Error` the
  script may catch. An answer over 1 MB is an error (ask the tool for less).
- Tools declare their input, not their answer, and most of the hub's own answer with text. A run's result names
  what each tool it called answered with ("web_rss: text", "crm_find: JSON {clients}"), and `code_search` says it
  for a tool a script has called before (kept in memory, per hub process). In the live check a model that assumed
  JSON needed two more runs before this, and none after.
- A call that needs the person's yes waits for it as any call does; if the wait passes, or the person or the policy
  says no, the run stops there. The hub does that one step itself after the tap; the agent does the rest.
- Closed to scripts: `code_*` and `skill_run`/`skill_script_save` (no script starts a script), every `hub_*` tool
  (rights, plugins, skills, settings), `vault_*`, and the CLIs' own permission prompt.
- Limits: 64 MB, 5 s of CPU, 10 minutes of wall time, 300 calls; its own sandbox, so a long run holds neither a
  trigger's slot nor a skill's.
- The brains' own tools (a CLI's shell and files) are not the hub's and are not reachable from a script.

### Levels

`AgentDef.codeMode`: unset (off), `"beside"` or `"first"`; `AgentDef.codeKeep`: tool name globs that stay on the
list at "first" beside the basics (unset: `browser_*`, `memory_*`: tools used a step at a time).

- Off: `code_search` and `code_execute` do not exist for the agent.
- Beside: they are on the list with everything else.
- Code first: the list is the basics (answering the person: `show_*`, `send_files`; tasks and teammates; `notify`,
  `self_recall`, `skill_load`), what a script cannot call (it would be out of reach otherwise), the two tools, the
  kept globs and the session's job tools. Everything else stays the agent's (scripts call it) but is not listed; the
  prompt says so. Measured on a hub with the browser, memory, web and Telegram plugins and no connected services: a
  plain agent's list is 104 tools and 103 KB, of which the hub's own tools are four fifths (triggers alone 24 KB).
  Keeping all of the hub's tools would save almost nothing, so its bulky families (triggers, pages, channels,
  groups, machines) go behind search too.

Changed in the chat (`hub_agent_save` takes `codeMode` and `codeKeep`) or in the agent's form.

### Saved scripts (second PR)

A saved script is a skill with a script, as taught skills have: one library, one card, one way to fix a script.

- A skill's script is `async function (input, browser, tools)`: `tools.<name>(input)` is the same call as in code
  mode (`script-tools.ts`). The browser stays `browser.*`, which holds a script to its skill's sites:
  `tools.browser_*` is refused in a skill's script.
- `hub_skill_save` also keeps a chain of tool calls (`script`, no `sites`), and its `allow` takes `{tool, where}`:
  `where` is input field → a value, a pattern with `*`, `{max}` or `{domain}`, each a condition of the rules engine,
  all of which must hold (every item of a list, for several recipients). It becomes an "always allow" rule noted
  `skill:<name>`, gone with the skill; the card shows it as written (`Without asking: gmail_send_message when to =
  *@kolesa.kz`). Refused before anybody is asked: no `where`, `*` alone, a field the tool's input does not have, a
  tool the agent does not have, the browser's own two (they have their forms), what is closed to scripts and the
  tools whose card is always the person's.
- After outside content the rules engine still asks for a target it never saw: a recipient or a site approved by
  name is known, a pattern names nobody.
- `code_search` lists the agent's saved scripts that fit above the tools (`skill_run {name}`).
- The agent offers once to keep a script the person will want again (a prompt line); "do not offer" is a work rule
  the agent keeps (`work_rule_set`), not a switch of its own.
- A background run of an agent below "Acts" still only reads: a saved script that acts on a schedule needs "Acts".
  Opening pre-approved actions to such runs (as a taught skill's browser steps are) is left for the step without a
  model.

### Later

A trigger runs a saved script with no model: reads and pre-approved actions, the agent woken only when the script
fails or a card is needed.

## Contracts changed

- `AgentDef`: `codeMode`, `codeKeep`.
- The sandbox's `ScriptApi`: `"code"`.

## Testing

- The sandbox: `tools.<name>`, `tools.call`, `console.log`, a bare body, the call limit.
- The runner on a real gateway: answers parsed, errors caught, a card stops the run, closed tools refused, taint
  set by a source tool called from a script.
- `code_search`: ranking, signatures from JSON Schema, `full`.
- Levels: what `listFor` gives at each, direct calls of hidden tools, the kept globs.
- A live check on a throwaway hub with a real plugin's tools.

## Docs

`docs/guide/{en,ru}/agents.md`: a section on code mode.
