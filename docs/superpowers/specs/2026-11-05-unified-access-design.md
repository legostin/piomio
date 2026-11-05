# Unified access: one map, one decision path, nothing breaks silently

The person, 2026-11-05: «разберись уже наконец с доступами. ЕДИНАЯ КАЧЕСТВЕННАЯ СИСТЕМА, которая позволяет работать агентам безопасно, но автономно и устойчиво».

## Evidence (the Developer's task t_mw3nuk9nA0Gg3myt, 14:48–14:55 UTC, and the hub's audit)

| What the agent reported | What really happened |
|---|---|
| "git cannot fetch: the local proxy does not answer" | The hub's egress proxy (127.0.0.1:41789) was listening. The task's Codex ran as `codex exec` from its first turn: `CodexSession` falls back to exec for the whole session on any `AppServerUnsupported`, which `connect()` throws whenever `initialize` fails for any reason. Exec runs commands with `network_access=false`, so the seatbelt refused even the loopback proxy ("after 0 ms"). The trigger, found in the live check: the hub's `permissions.piomio.network={…}` inline table lacked its closing brace; Codex 0.166 (installed 2026-11-04) refuses it at start ("invalid type: string … expected struct NetworkToml"), so every networked Codex task started in exec. |
| "Notion asks to sign in again" | At the hub's start (11:36) the remote MCP connect failed once with `fetch failed`. `McpClients.connect` sets `error` and nothing ever retries; a dropped connection (`onclose`) ends the same way. The tokens are in the vault. The agent saw no Notion tools and guessed a sign-in. |
| "machine_exec cannot see the Mac" | The hub's own computer is not in `machine_list`; `machine_exec` with `local` or its name answers "Machine … not found". |
| Auto mode stopped `pwd; git rev-parse HEAD` on vps ("the system was not mentioned") | A read-only command on another computer goes to the reviewer like any `machine_exec`, while the same command locally passes the shell reader (`policy/commands.ts`). The reviewer's rule "acts on systems the person did not mention" does not know the agent's access. |
| background: 801 `egress.deny` in 36 h | Most are not denials: DNS failures while the Mac slept (`resolveTarget` throws → logged as a deny, answered "not allowed"), 407 proxy-auth challenges logged as `unknown`, and the brain plugins' own processes (`plugin:brain-codex`) having no network grant for their model API. |
| | Codex sessions load the person's own Codex MCP servers, plugins and ChatGPT apps (Computer Use, jev-browser, Unity, xcode, athena…): tools outside the hub's gateway. `-c mcp_servers={}` does not remove servers from `config.toml`; `mcp_servers.<name>.enabled=false` per name plus `features.plugins=false`, `features.apps=false` does (checked). |

The cause is shared: access is seven separate mechanisms (CLI sandbox, egress proxy + hosts, the CLI's permission prompt, the reviewer, rules, service sign-ins, machines). Each has its own list, failure and error text; none checks that it works; none recovers.

## Decided with the person

- Reading within the agent's access is free; **every change goes through auto mode's reviewer** (as now, but reliably and with the access map). Always the person's: money, messages to people, publishing (main/master, tags, releases, deploys), deleting.
- The person's own Codex MCP servers, plugins and apps are off in agent sessions.
- No new storage for grants: folders, machines, hosts, sign-ins and rules stay where they are. One layer reads them.

## 1. The access map

`packages/core/src/access/map.ts` builds, for an agent and (optionally) one session, what it can reach. Pure function over inputs the hub passes in:

- **computers**: this hub's computer (name, "you run here" when the session does) and the paired ones the agent may use (`AgentDef.machines`, else all), each `online`, `commands` on/off, its folders.
- **folders**: the agent's own folder and its project folders (`AgentDef.folders`), per computer.
- **internet**: through the hub's proxy; the built-in hosts (`DEFAULT_BRAIN_EGRESS`), the person's list (`brainEgressAllow`); any other host is reviewed once per session.
- **services**: every remote MCP server, Google connection and Composio app with a status: `connected`, `reconnecting` (with the next try), `signin` (the person must sign in), `off`, `error` (with the reason).
- **this session** (when given): its brain and mode, whether its commands have network and, if not, why (`exec` mode of an old Codex, a remote computer, a dialog that only looks).

Used three ways:
1. `access_view` text for the reviewer (`AutoContext.access`): the systems the person gave this agent. Rule text changes from "systems the person did not mention" to "systems neither the person mentioned nor the agent's access lists".
2. `hub_access` tool (every agent, `effect: read`): answers "what can I reach and does it work"; with `check: true` it probes (below). The person asks any agent "какие доступы у Разработчика?" and the agent answers from it.
3. The prompt's internet line is replaced by a short, true one: shell networking goes through the hub's proxy, a new host is reviewed, and `hub_access` explains what fails.

## 2. One decision path

The ladder is the same for hub tools (gateway), the CLIs' own actions (`native-permissions.ts`), network hosts (`network-approvals.ts`) and other computers (`machines.ts`):

1. **Never**: credentials, the hub's data, private networks → refused with the reason (existing lists).
2. **Reads** → allowed without review. New: `machine_exec` whose command passes the shell reader (`readOnlyCommand`) and names no credential path and no URL is a read (the registry gets a core-only `effectOf(input)`; the gateway uses it before `decide`).
3. **Changes** → the person's own words (`asked`) → **auto mode's reviewer with the access map** → a card when it hands over.
4. **Always the person's**: money, messages to people, publishing, deleting (`alwaysPerson`, `publishingCommand`, unchanged).

After outside content the existing guards stay: tainted egress, listed hosts reviewed once per session, `askWhenTainted`.

## 3. Nothing breaks silently

**Codex.**
- `codex exec` only when that Codex has no app-server: `AppServerUnsupported` is thrown only when the process exits with clap's "unrecognized subcommand" (or "unexpected argument 'app-server'"). Any other failed start: one retry with a fresh process, then the turn fails with Codex's own stderr (logged at error level, so it reaches `hub.log`).
- When exec is really the only way, the session's access says "commands have no network: this Codex is too old (version)" and the turn's first error explains it.
- Agent sessions see only the hub's tools: `features.plugins=false`, `features.apps=false`, and `mcp_servers.<name>.enabled=false` for every `[mcp_servers.<name>]` in the CLI home's `config.toml` (`CODEX_HOME` or `~/.codex`), except `piomio`. Bare reviewer sessions get the same.

**Services (remote and local MCP servers).**
- A failed connect or a dropped connection reconnects by itself with backoff: 5 s, 15 s, 1 min, 5 min, then every 10 min; the status is `reconnecting` with the next try.
- A dropped server's tools stay registered while it reconnects; a call waits up to 20 s for the connection, then answers "<server> is reconnecting (next try in …); try again later" instead of disappearing.
- `signin` only when the server answers 401 and the token refresh failed. Then the agent's chat gets the server's Sign in card once (existing `hub_integration_connect` card) instead of the agent guessing.
- `hub_access check` reconnects a service in `error`/`reconnecting` at once.

**Network.**
- The proxy tells denial from failure. Policy: 403 "not allowed: …" (as now). DNS or connect failure: 502 "cannot reach <host>: <error> — this computer may be offline" for HTTP and CONNECT, audited as `egress.unreachable` (rate-limited, once a minute per owner and host), never as `egress.deny`.
- A request with no proxy credentials (the 407 challenge every client sends first) is not audited.
- Brain plugins' own processes (builtin plugins that contribute brains) reach their model APIs: their token's list includes `BRAIN_MODEL_EGRESS`.

**Computers.**
- `machine_list` starts with this hub's computer ("this computer: the hub runs here; agents here use their own shell"); `machine_exec`, `machine_read_file` and the others accept `local`, `this`, its id or its name and answer "This is the hub's own computer: run the command in your own shell (its network goes through the hub's proxy)" instead of "not found".

**`hub_access check`.** For the calling session: the proxy answers for this session's token; a built-in host resolves and connects through it; each service's status (reconnecting the broken ones); each computer online; the brain's mode. It returns what works, what does not, what the hub just did, and what only the person can do.

## 4. What the person sees

Nothing new while it works. When only they can fix it, one message with one button in the agent's chat: sign in to a service (its card), turn on commands on a computer (existing card), update Codex (text). No new page.

## 5. Out of scope

- A grants table, per-agent service grants, a settings page for access.
- Git credentials beyond what exists (a push outside the sandbox asks through the CLI's escalation → reviewer).
- Rewriting "always allow" rules into kinds.
- Remote computers' brain networking through the hub's proxy (spec 2026-11-03 left it open).

## Verification

- Tests: Codex start failing once → retried, not exec; a Codex without app-server → exec and a session note; isolation config lists the person's servers from a fixture `config.toml`; MCP connect failing then succeeding by itself, a drop → reconnect, a call during reconnect waits, 401 → signin; proxy DNS failure → 502 + `egress.unreachable`, no `egress.deny`; 407 not audited; brain plugin tokens include model hosts; `machine_exec` read-only fast path (allowed without the reviewer), with a credential path or URL → reviewed; `machine_exec` on `local` → the explanation; access map content; reviewer prompt holds the access view; `hub_access` output; English/Russian catalog parity.
- `npm run typecheck`, `npm test`, `npm run build`.
- Live on the installed hub: a Codex task does `git fetch` through the proxy; Notion reconnects after the hub starts offline.
- Docs `docs/guide/{en,ru}/{security,approvals,troubleshooting,machines}.md` in the same commit.
