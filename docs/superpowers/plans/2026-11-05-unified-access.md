# Unified Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One access layer for agents: nothing breaks silently (Codex, services, network, computers), reads within the agent's access are free, every change goes through auto mode with the agent's access map.

**Architecture:** No new storage. Fixes in place where each mechanism fails silently today (Codex start, MCP connections, egress errors, machines), plus `packages/core/src/access/map.ts`, which builds an agent's access map from existing data and feeds the reviewer, the agent's prompt and a new `hub_access` tool.

**Tech Stack:** Node 24 TypeScript (type stripping, `.ts` imports), vitest, MCP SDK, Codex app-server JSON-RPC.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-11-05-unified-access-design.md`.
- Only erasable TypeScript; `import type` for types; local imports end in `.ts`.
- Text for the model (tool results/descriptions, prompts) is English, untranslated. Every user-facing string goes through `packages/core/src/locales/{en,ru}.ts` or `packages/web/src/i18n/{en,ru}.ts`; `packages/core/test/i18n.test.ts` checks parity.
- Tests write temp files only under `tmpdir()`.
- Every change of behaviour updates `docs/guide/{en,ru}/` pages it touches in the same commit series.
- Changes always go through auto mode's reviewer; reads within access are free (decided with the person).

---

### Task 1: Codex never drops to a network-less mode silently, and sees only the hub's tools

**Files:**
- Modify: `packages/brains-cli/src/codex-app.ts` (connect(): which failure means "no app-server")
- Modify: `packages/brains-cli/src/codex.ts` (send()/warmUp(): retry once, error instead of exec; exec note; isolation config)
- Create: `packages/brains-cli/src/codex-isolation.ts`
- Modify: `packages/brains-cli/test/fixtures/fake-codex.mjs` (`FAKE_CODEX_APP_FAIL_FILE`)
- Test: `packages/brains-cli/test/codex-start.test.ts`

**Interfaces:**
- Produces: `class AppServerStartFailed extends Error` (codex-app.ts); `isolationConfig(home: string | undefined, env: Record<string,string>): string[]` (codex-isolation.ts) returning `features.plugins=false`, `features.apps=false`, `mcp_servers.<name>.enabled=false` for each `[mcp_servers.<name>]` in `<CODEX_HOME or HOME/.codex>/config.toml` except `piomio`.

- [ ] Step 1: fake-codex: when `FAKE_CODEX_APP_FAIL_FILE` is set, `app-server` reads the number in that file (default 0); if > 0 it writes n-1 back, prints `boom: state db locked` to stderr and exits 1 before answering.
- [ ] Step 2: failing tests in `codex-start.test.ts`:
  - fails once → second app-server answers, the turn's text is `echo:hi`, two spawns, no `exec` in args file;
  - always fails (file holds 9) → the turn yields `{type:"error", fatal:true}` whose message contains `boom`, and no `exec` ran;
  - `FAKE_CODEX_NO_APP=1` → exec runs, a `warning` event says commands have no network (confined session with network);
  - isolation: a `config.toml` under a temp HOME with `[mcp_servers.jev-browser]`, `[mcp_servers.node_repl.env]`, `[mcp_servers."computer-use"]`, `[mcp_servers.piomio]` → app-server args contain `features.plugins=false`, `features.apps=false`, `mcp_servers.jev-browser.enabled=false`, `mcp_servers.node_repl.enabled=false`, `mcp_servers.computer-use.enabled=false` and not `mcp_servers.piomio.enabled=false`; bare reviewer sessions get them too.
- [ ] Step 3: run `npx vitest run packages/brains-cli/test/codex-start.test.ts` → FAIL.
- [ ] Step 4: implement:
  - codex-app.ts connect(): on initialize failure, wait for exit (2 s); `const err = stderr tail`; `if (/unrecognized subcommand|unexpected argument 'app-server'|invalid subcommand/i.test(err)) throw new AppServerUnsupported(err)`; else `throw new AppServerStartFailed(err || "codex app-server did not answer")`.
  - codex.ts send(): wrap the first `app.run(turn)` so an `AppServerStartFailed` before any event is retried once with `this.newServer(env)`; a second failure yields `{ type: "error", fatal: true, message: "Codex did not start: <err>" }`, logs through `this.p.error?.(…)` (new optional `CodexOptions.error`, the plugin passes `ctx.log.error`) and returns `done`. Never set `execOnly` for it. warmUp(): `AppServerStartFailed` only logs.
  - exec turns of a session with `confinedNetwork(this.o)` yield once `{ type: "warning", message: "Commands in this session have no network: this Codex has no app-server (update Codex)." }` and prefix the first turn's text with `[System] Your shell has no network in this session: this Codex is too old for the hub's network proxy. Use the hub's tools (web_fetch, composio_github_*) for the internet, and tell the person to update Codex.\n\n`.
  - codex-isolation.ts as in Interfaces (regex `^\s*\[mcp_servers\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))`, names kept only when they match `^[A-Za-z0-9_-]+$`); config() and bareConfig() append it (bareConfig keeps its own features list; dedupe).
  - plugins/brain-codex/server/index.ts passes `error: (m) => ctx.log.error(m)`.
- [ ] Step 5: tests pass; `npx vitest run packages/brains-cli` passes (update `claude-code.test.ts` "falls back to codex exec" expectations if the warning changes them).
- [ ] Step 6: commit `fix(codex): a failed start is retried and reported, never a session without network; agent sessions see only the hub's tools`.

### Task 2: Services reconnect by themselves

**Files:**
- Modify: `packages/core/src/mcp/client.ts`
- Modify: `packages/core/src/integrations.ts` (reconnecting → broken with detail, never "sign in")
- Modify: `packages/core/src/locales/{en,ru}.ts` (`mcp.reconnecting`)
- Modify: `packages/web/src/pages/Mcp.tsx`, `packages/web/src/i18n/{en,ru}.ts` (`mcp.status.reconnecting`, `mcp.status.signin`)
- Test: `packages/core/test/mcp-reconnect.test.ts`

**Interfaces:**
- Produces: `McpServerStatus.status` gains `"reconnecting"`; `McpServerStatus.retryAt?: string` (ISO); `McpClientManager.retryDelays: number[]` (default `[5_000, 15_000, 60_000, 300_000, 600_000]`, tests shorten); `McpClientManager.kick(name): Promise<void>` (retry now if waiting).

- [ ] Step 1: failing tests (HTTP MCP server on a free port that the test starts after the hub, and stops/restarts):
  - the hub starts while the server is down → status `reconnecting` with `retryAt`; the server comes up → within the retry delay (tests: `[50, 100]`) status `connected`, tools registered;
  - a connected server goes away (close the HTTP server) and a tool call starts → the call waits and succeeds once the server is back within 20 s (tests: shortened `callWaitMs`);
  - a tool call while the server stays down past `callWaitMs` → result text contains `is reconnecting`;
  - the plugin's integration card shows `broken` with a reconnecting detail, not `needs-setup`.
- [ ] Step 2: run → FAIL.
- [ ] Step 3: implement in client.ts:
  - `Conn` gains `attempt: number`, `timer?: NodeJS.Timeout`, `retryAt?: number`, `connecting?: Promise<void>`.
  - `connect()` catch (and the `onclose` handler) call `this.retryLater(conn)` unless the error is a config error (`command is required`/`url is required`) or the server is stdio and `attempt >= 5`: status `reconnecting`, `error` kept, `retryAt = now + retryDelays[min(attempt, len-1)]`, timer unref'd, `attempt++`; when it fires, `this.connect(...)` again with the same `attempt` carried over (a success resets it to 0).
  - On a drop, tools stay registered; each tool invoker resolves the live connection: `const c = await this.live(name, this.callWaitMs)`; `live()` kicks a waiting retry and polls `this.conns.get(name)` until `connected` or the wait ends; on timeout returns `{ isError: true, text: "<name> is reconnecting (next try <in N s>); try again later or call hub_access to check" }`.
  - A successful connect unregisters the owner's old tools right before registering the new list.
  - `disconnect()` clears the timer; `closeAll()` too.
  - `list()` exposes `retryAt` as ISO.
- [ ] Step 4: integrations.ts: treat `reconnecting` like `error` for the card (`broken`, detail `t("mcp.reconnecting")`), before the signin rule.
- [ ] Step 5: Mcp.tsx STATUS map gains `reconnecting` (tone "warning") and `signin` (tone "info"); web i18n en/ru.
- [ ] Step 6: tests pass, `npx vitest run packages/core/test/mcp-*.test.ts packages/core/test/i18n.test.ts`.
- [ ] Step 7: commit `fix(mcp): services reconnect by themselves; a call waits for the connection instead of the tools vanishing`.

### Task 3: The proxy tells "no internet" from "not allowed"; brain plugins reach their model APIs

**Files:**
- Modify: `packages/core/src/egress.ts`
- Modify: `packages/core/src/plugins/host.ts`
- Test: `packages/core/test/egress.test.ts` (new describe block), `packages/core/test/brain-egress.test.ts` if it covers plugin tokens

**Interfaces:**
- Produces: `class EgressUnreachable extends Error` (egress.ts); audit actions `egress.unreachable` (data `{ reason }`) and `egress.deny` (data `{ reason }`); `EgressProxy.lookup` (injectable resolver, default `dns.lookup`, for tests); `EgressProxy.hasSession(sessionId: string): boolean` (a live token carries that session's context).

- [ ] Step 1: failing tests:
  - a token allowed `*`, a host whose lookup fails (inject `proxy.lookup = async () => { throw Object.assign(new Error("getaddrinfo ENOTFOUND x.test"), { code: "ENOTFOUND" }) }`) → HTTP GET answers 502 with body `cannot reach x.test` and `may be offline`; CONNECT answers `HTTP/1.1 502`; the audit got `egress.unreachable`, no `egress.deny`;
  - CONNECT to an allowed host whose port refuses → `HTTP/1.1 502 … ECONNREFUSED`;
  - a request without proxy credentials → 407 and nothing audited;
  - a denied host → 403 and `egress.deny` with `{ reason }`.
- [ ] Step 2: run → FAIL.
- [ ] Step 3: implement: `resolveTarget` wraps the lookup in try/catch → `throw new EgressUnreachable(`cannot resolve ${host}: ${code}`)`; handlers: `if (e instanceof EgressUnreachable)` → 502 + `logUnreachable`; CONNECT `upstream.on("error")` before establishment → `client.end("HTTP/1.1 502 …")` + `logUnreachable`; HTTP upstream error → 502 + `logUnreachable`; `logDeny` skipped when no token was sent; both log helpers rate-limit per owner|host|action once a minute and carry `{ reason }`.
- [ ] Step 4: host.ts: compute `isBrainHost` before `issueToken`; the token's list is `[...rec.granted.network, ...(isBrainHost ? BRAIN_MODEL_EGRESS : [])]`.
- [ ] Step 5: tests pass (`npx vitest run packages/core/test/egress*.test.ts packages/core/test/brain-egress.test.ts packages/core/test/network-*.test.ts`).
- [ ] Step 6: commit `fix(egress): no internet is not a denial; proxy challenges are not denials; brain plugins reach their model APIs`.

### Task 4: Reads on other computers are free; this computer is a known computer

**Files:**
- Modify: `packages/core/src/tools/registry.ts` (`effectOf`)
- Modify: `packages/core/src/tools/gateway.ts` (effective effect before `decide`)
- Modify: `packages/core/src/machines.ts` (machine_exec effectOf, this computer)
- Modify: `packages/core/src/app.ts` (wire `machines.here`)
- Test: `packages/core/test/machine-access.test.ts`

**Interfaces:**
- Produces: `ToolRegistry.register(descriptor, invoke, describe?, effectOf?: (input: any) => ToolEffect | undefined)`; `readOnlyRemoteCommand(command: string): boolean` (machines.ts, exported); `MachineHub.here?: () => { id: string; name: string }`.

- [ ] Step 1: failing tests:
  - `readOnlyRemoteCommand("pwd; ls -a; git rev-parse --show-toplevel; git rev-parse HEAD")` → true; `"cat ~/.ssh/id_ed25519"`, `"cat .env"`, `"git ls-remote https://x.test/r"`, `"rm -rf x"`, `"git push"` → false;
  - gateway with a fake `machine_exec` registered with that effectOf: a read-only command is allowed without the reviewer (fake reviewer counts calls: 0) and audited as `policy.decision` allow; a change goes to the reviewer;
  - `machine_list` begins with this computer; `machine_exec` with `local`, `this`, the hub's id or name answers the "hub's own computer" explanation (isError true), not "not found".
- [ ] Step 2: run → FAIL.
- [ ] Step 3: implement: registry Entry stores `effectOf`; gateway: `const effect = entry.effectOf?.(input); const tool = effect ? { ...entry.descriptor, effect } : entry.descriptor;` after hooks; machines.ts: `readOnlyRemoteCommand = (c) => readOnlyCommand(c, { home: "~", tmp: "/tmp" }) && !CREDENTIAL_RE.test(c) && !/[a-z][a-z0-9+.-]*:\/\//i.test(c)` with `CREDENTIAL_RE = /(?:^|[\s/'"=~])\.(?:ssh|aws|gnupg|kube|docker|azure|netrc|npmrc|pypirc|git-credentials|password-store|config\/gh)\b|\.env\b|\bid_(?:rsa|ed25519|ecdsa|dsa)\b|credential|secret|token|passw/i`; `machine_exec` registered with `(i) => (typeof i?.command === "string" && readOnlyRemoteCommand(i.command) ? "read" : undefined)`; `call()` checks `this.here` aliases after `find()` misses and throws the explanation; `machine_list` prepends the hub's computer line.
- [ ] Step 4: tests pass (`npx vitest run packages/core/test/machine-*.test.ts packages/core/test/remote-gateway.test.ts packages/core/test/agent-machines.test.ts`).
- [ ] Step 5: commit `feat(machines): read-only commands on other computers need no review; the hub's own computer is known`.

### Task 5: The access map, `hub_access`, the reviewer's scope, the prompt

**Files:**
- Create: `packages/core/src/access/map.ts`
- Modify: `packages/core/src/policy/auto.ts` (`AutoContext.access?: string`, rule text, prompt section)
- Modify: `packages/core/src/app.ts` (`accessMap(agentId, sessionId?)`, autoContext adds it)
- Modify: `packages/core/src/tools/hub-tools.ts` (`hub_access` for every agent)
- Modify: `packages/core/src/prompt.ts` (internet line)
- Test: `packages/core/test/access-map.test.ts`, `packages/core/test/auto-mode.test.ts` (prompt holds access)

**Interfaces:**
- Consumes: `McpServerStatus` with `reconnecting`/`retryAt` (Task 2); `Hub.computers()`; `MachineHub.list()`; `AgentDef.folders`, `AgentDef.machines`; `settings.brainEgressAllow`; `DEFAULT_BRAIN_EGRESS`; `listIntegrations`.
- Produces:
  ```ts
  export interface AccessComputer { id: string; name: string; here: boolean; online: boolean; commands?: boolean; standby?: boolean; folders: string[] }
  export interface AccessService { id: string; name: string; status: "connected" | "reconnecting" | "signin" | "off" | "error"; detail?: string }
  export interface AccessMap { agent: string; ownFolder?: string; computers: AccessComputer[]; internet: { builtIn: string[]; added: string[] }; services: AccessService[] }
  export function accessView(m: AccessMap): string;
  export function serviceStatus(v: IntegrationView, servers: McpServerStatus[]): AccessService["status"];
  ```
  `Hub.accessMap(agentId: string, sessionId?: string): Promise<AccessMap>`.

- [ ] Step 1: failing tests: `accessView` of a map with vps (online, commands on, folder), LEGOSTIN-PC offline, Notion reconnecting, GitHub via Composio connected, `brainEgressAllow: ["example.org"]` prints those facts in lines starting `Computers:`, `Internet:`, `Services:`; `reviewPrompt` with `ctx.access` contains `ACCESS` fence and the rule text "neither the person mentioned nor the agent's access lists"; `hub_access` through the gateway on a test hub returns text with `Computers:` and the hub's computer name; `check: true` adds `Proxy:` and service lines and kicks a reconnecting server.
- [ ] Step 2: run → FAIL.
- [ ] Step 3: implement map.ts (pure), app.ts `accessMap()` (computers from `computers()` filtered by `onMachines(agent)` when the agent is bound; commands from `machines.get(id)?.info?.commands`; folders from `agent.folders` grouped by machine; services from `listIntegrations(hub, "en")` with status via `serviceStatus` (MCP servers of that plugin: reconnecting/signin/error), skipping `off` built-ins that are not integrations), autoContext adds `access: accessView(await…)` — autoContext is sync today: make `AutoModeDeps.context` return `AutoContext | Promise<AutoContext>` and `await` it in `review()`.
- [ ] Step 4: auto.ts RULES line becomes `- acts on accounts, servers or systems that neither the person mentioned nor the agent's access lists;` plus an ALLOW line `- reading and ordinary work on the computers, folders and services the agent's access lists, when it serves the request;` and the prompt adds `"The access the person gave this agent:"` + `fenced("ACCESS", ctx.access)` when present.
- [ ] Step 5: hub-tools.ts `reg({ name: "access", effect: "read", … inputSchema: obj({ check: { type: "boolean" } }) })`, added to `HUB_TOOLS_FOR_EVERY_AGENT`; `check` runs: the session has a live proxy token (`hub.egress.hasSession(ctx.sessionId)`, Task 3), `kick` for every reconnecting/error MCP server then waits up to 10 s, machines online; output lines `Proxy:`, `Services:`, `Computers:`, `Your shell:` with the curl self-test instruction.
- [ ] Step 6: prompt.ts internet line: `- Internet: use web_search, web_fetch and the browser_* tools. Your shell's network goes through the hub's proxy: model APIs, package registries and GitHub are open, any other host is checked once per session (hub_network_request asks for one explicitly). If a command fails to reach 127.0.0.1:<port> or says "cannot reach … may be offline", call hub_access with check: true before working around it. For Git in a sandbox use HTTPS (git fetch https://github.com/owner/repo.git main): SSH does not use the proxy and your SSH keys stay closed.` (rest of the old line about worktrees kept).
- [ ] Step 7: tests pass (`npx vitest run packages/core/test/access-map.test.ts packages/core/test/auto-mode.test.ts packages/core/test/prompt*.test.ts`).
- [ ] Step 8: commit `feat(access): one access map for the reviewer, the agent and hub_access`.

### Task 6: Docs and the full check

**Files:**
- Modify: `docs/guide/{en,ru}/security.md`, `docs/guide/{en,ru}/approvals.md`, `docs/guide/{en,ru}/troubleshooting.md`, `docs/guide/{en,ru}/machines.md`

- [ ] Step 1: security/approvals: "Access" section — what an agent can reach, reads free, changes reviewed, always yours; Codex sessions see only the hub's tools. troubleshooting: "an agent says the proxy does not answer / a service asks to sign in again" → what the hub now does and `hub_access`. machines: this computer in the list; read-only commands on other computers need no review.
- [ ] Step 2: `npm run typecheck`, `npm test`, `npm run build` all green.
- [ ] Step 3: commit `docs: unified access`.
- [ ] Step 4: live check on the installed hub (after install): a Codex task runs `git fetch https://github.com/legostin/piomio.git main` in its shell; Notion shows connected after a hub restart.
