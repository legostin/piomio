# The CLIs' own connections — implementation plan

**Goal:** Agents can use what the person already connected in Claude Code or Codex (MCP servers, claude.ai connectors
such as Gmail, the CLI's plugin servers), each turned on or off per computer and brain. Everything is off until the
person turns it on, as before.

**Decided with the person (2026-11-16):** reading is free, anything else asks the hub (card, auto mode, "always"
rules), as the hub's own MCP tools do; one switch per computer + brain, for every agent thinking there.

**Architecture:**

- The brain's host knows its connections: `BrainProviderImpl.connections()` (RPC `brain.connections`, plugin runner
  and node alike). Claude Code: a headless run with no prompt answers the `mcp_status` control request (names, state,
  tools with `readOnly`, each server's command or address). Codex: `codex mcp list --json`. Asked on demand only,
  since Claude Code starts the servers to answer.
- The hub keeps only the names turned on, in `settings` key `brain-connections`, by `<brainId>@<computer>` with the
  computer's canonical id (`BrainConnections`, `packages/core/src/brain-connections.ts`). Commands and addresses stay
  on the host in the provider's state dir (`connections.json`, private): they may carry keys.
- A session gets `BrainSessionOptions.connections` (names). Claude Code: instead of `--strict-mcp-config`, session
  settings with `allowedMcpServers` (the hub's bridge by command, each connection by command or address) and
  `deniedMcpServers` (every other known name); read-only tools join `--allowedTools`. A name the host never listed is
  not let in. Codex: its `enabled=false` override is left out and `default_tools_approval_mode="writes"` set; Codex's
  approval request (`mcpServer/elicitation/request`) goes to the hub's permission tool.
- A paired computer's owner can forbid it: `policy.json` `brains.<id>.connections: false`.
- What such a tool returns is outside content: the runner taints the session on any `mcp__*` tool that is not the
  hub's and gives its output to the egress guard. Codex's parsers name them `mcp__<server>__<tool>`.
- Chat first: `hub_brain_connections` (list) and `hub_brain_connection_set` (switch); the Brains page shows the same
  list with switches (`GET/PUT /api/brains/connections`). The access map lists what is on.

**Not in this version:** ChatGPT apps in Codex (their own experimental API); writes where Claude Code has nobody to
ask (a paired computer with commands off) are refused.

## Tasks

1. Contracts: `BrainConnection`, `BrainSessionOptions.connections` (shared), `BrainProviderImpl.connections` (plugin-sdk),
   runner RPC.
2. brains-cli: `connections.ts` (tool prefix, cache, Claude's status reader and session settings), Claude Code session
   args, Codex list + isolation + elicitation answer; tests with the fake CLIs.
3. node: `brain.connections`, policy `connections`, options sanitised in `BrainHost.create`.
4. core: `BrainRegistry.connections`, `BrainConnections`, runner (options, taint), API, hub tools, access map, locales.
5. web: Brains page list with switches, i18n.
6. Docs (en + ru): brains, security, approvals, machines.
