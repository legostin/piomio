# Cluster: a hub that lives on every machine, machines with their own keys and limits

Asked 2026-10-30. The person took an always-on VPS for agents and wants "a system that cannot be killed until every
node is off": when the main hub goes away another machine takes over at once, the apps switch on their own, the
conversations and the working folders exist on every machine, and the work uses the resources of all machines. Each
machine has its own subscriptions and keys; in the hub the person sets, per machine, which brains run there, which
models they may use and how much they may spend ("I don't want an agent to burn expensive API models there").

Decisions the person made:
- When two machines lose each other but both live, **both keep working and merge later** (availability first).
- Shared secrets (Telegram, Google, API keys) on a machine that takes over **wait for one tap** from the person; a
  machine keeps them unlocked in memory until it restarts, never on its disk.
- **The Mac leads**; the VPS takes over while the Mac sleeps and gives the lead back when it returns.
- **Everything Piomio keeps in files replicates**, except what a machine downloads again (node_modules, vendor, .venv,
  target, build output, caches, what .gitignore leaves out).
- Allowed models are **a list plus a spend limit** per machine.

## Three parts

1. **Machines as a pool** — per-machine brain setup (subscription or key), allowed models, a spend limit; keys stay in
   the hub's vault and reach a machine's memory only; a gateway on the machine enforces the list and the limit for
   every model call; routing spreads work over every machine.
2. **Replicas** — every hub replica holds the whole hub: the database (merged row by row), the vault (sealed), and the
   files. Machines that are only nodes share the working folders.
3. **Failover** — one replica leads at a time by an order of priority; main-only work (tasks, channels, digests,
   plugins) runs on the leader; clients and nodes know every replica and follow the leader.

## 1. Machines as a pool

### Settings (hub, replicated)

`machine_settings(machine_id, data, updated_at)`; `data` is `MachineSettings` (shared/types.ts):

```ts
interface MachineSettings {
  brains: Partial<Record<"claude-code" | "codex", MachineBrainSetup>>;
  limit?: { usd: number; period: "day" | "month" };
}
interface MachineBrainSetup {
  auth: "subscription" | "key";          // key: provider keys from the hub's vault, through the machine's gateway
  providers?: string[];                  // key mode: KEY_PROVIDERS ids (anthropic, deepseek, moonshot, zhipu | openai)
  models?: Array<{ id: string; provider?: string; price?: { input: number; output: number } }>; // $ per 1M tokens
}
```

`KEY_PROVIDERS` (shared): the providers a CLI can use through the gateway, with their wire format, base URL, auth
header and the vault id of their key (the same ids the API brain uses: `anthropic_api_key`, `openai_api_key`,
`deepseek_api_key`, `moonshot_api_key`, `zhipu_api_key`). Claude Code speaks the Anthropic wire (Anthropic itself and
the Anthropic-compatible endpoints of DeepSeek, Kimi and GLM); Codex speaks the OpenAI Responses wire (OpenAI).

Chat first: the tools `machine_setup_get` / `machine_setup_set` let an agent read and change a machine's setup; the
Machines page shows each machine's setup and spend in one line with a "Set up" entry that opens the assistant's chat
with the request. A price the hub does not know must be given (the agent looks it up or asks); the tool refuses a
model without one in key mode.

### Delivery (`node.setup`)

On every node connection and on every change, the leader sends the node a `NodeSetup`: per brain the auth mode, the
allowed models with prices, and for key mode the providers with their keys resolved from the vault (memory only; the
node never writes them). A sealed vault sends no keys (`sealed: true`): key-mode brains report "waiting for the hub to
unlock". The spend so far in the period comes along.

### Gateway (`packages/node/src/gateway.ts`)

A loopback HTTP server in the node daemon. Key-mode sessions get a per-session token:
- Claude Code: `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>`, `ANTHROPIC_AUTH_TOKEN=<token>`, alias models
  (`ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL`) pinned to
  allowed models, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`.
- Codex: a model provider `piomio` (`-c model_provider=piomio`, `base_url=http://127.0.0.1:<port>/v1`,
  `wire_api=responses`, `env_key=PIOMIO_GATEWAY_KEY`).

For each request the gateway checks the token, takes the body's `model`; a model off the list becomes **the cheapest
allowed model** of that wire (never more expensive); over the limit it answers 429 in the wire's error shape. It adds
the provider's key, streams the answer through and reads the usage (Anthropic `message_start`/`message_delta`, OpenAI
`response.completed`, or the JSON body). Cost = tokens × price (cache reads at 10 %, cache writes at 125 % of input).
Each call is reported to the hub (`node.usage`) and added to the local running total, so the limit holds even between
the hub's updates. An agent with commands on that machine sees only its session token: the key never reaches the
machine's disk or the CLI's environment.

Subscription-mode brains keep their own sign-in; their models are limited by routing (below), not by a gateway.

### Spend and limits (hub)

`machine_spend(day, machine_id, brain_id, provider, model, input_tokens, output_tokens, usd)` accumulates the reports.
When a period's spend reaches the limit, the machine's key-mode brains get a `brain_limits` row until the period ends
(the router skips them) and the node's setup is refreshed.

### Routing over all machines

- A machine brain's probe lists only its allowed models (with their prices as `catalog` profiles), so the router
  never picks another one; a person's exact model off the list falls back to routing.
- An agent's `<brain>@local` also stands for the same brain on every other machine, after the agent's own order
  (`expandBrains`): when the hub's own Claude Code is busy, over its limit or asleep, the VPS's Claude Code takes the
  work. The runner already takes the first brain usable now.

## 2. Replicas

### Who

`replicas(id, name, public_key, urls, priority, created_at, revoked)` (replicated): every hub replica, its Ed25519
key, the addresses it serves the device app on, and its place in the order of who leads (1 first). A replica has its
own key in `<data>/replica/key.json`. A new replica joins with an invite from any replica:
`piomio replica invite` → `piomio://replica?...` link carrying the code, the inviter's URLs and the device
certificate fingerprint; `piomio replica join <link> --name vps --url https://…` makes the key, sends the public key,
and receives a snapshot (both databases via `VACUUM INTO`, the device TLS identity).

Replicas talk to each other over the **device app** (TLS with the hub's self-signed certificate, which every replica
shares, so phones and replicas pin one fingerprint), with every request signed by the replica's key
(`authorization: PiomioReplica <id>.<ts>.<sig>` over method, path, ts and body hash; 60 s clock window).

### Database

- **Capture**: plain SQL triggers on each replicated table write `(tbl, pk)` into `repl_pending` (no functions, so
  hand edits with sqlite3 and the hub's CLI subcommands are captured too). A drain every 250 ms turns pending rows into
  `repl_log(origin, seq, hlc, tbl, pk, op, row)` with the full row as JSON and a hybrid logical clock, and keeps the row's
  version in `repl_rows(tbl, pk, hlc, origin)`. Only the newest entry per row and origin is kept.
- **Sync**: each replica keeps a version vector (`repl_vector(origin, seq)`). A replica pulls from each peer
  (`POST /api/replica/changes {vector, wait}`, long poll) every entry it has not seen, its own and relayed ones.
- **Apply**: last writer wins per row by `(hlc, origin)`; deletes are tombstones; only columns the local schema knows
  are written; triggers stand still while applying (`repl_ctl`). Applied entries are kept for relay. After applying,
  `replica.synced` tells the open apps to refetch.
- **What replicates**: conversations, messages, tasks, sessions, approvals, rules, approved_targets, notifications,
  plugins (settings, enabled, granted), plugin_kv, machines, machine_settings, machine_spend, replicas, auth, passkeys,
  devices, settings (except per-machine keys), usage, brain_limits, secret_requests, agent_drafts, invites, feeds,
  feed_posts, pages, meta; vault_items and vault_meta. Local only: audit (its hash chain is per replica),
  auth_sessions, pairing codes, schema_version and the replication tables.

### Files

A sync engine shared by replicas and nodes (`packages/replica/src/files.ts`): each side scans its roots, keeps a
journal of changed paths and, per peer, the last agreed hash of each path. A round takes the peer's changes since a
cursor; a path changed only there is downloaded (by hash), changed only here is left for the peer to pull, changed on
both sides keeps the newer one in place and the other as `name (conflict <machine> <date>).ext`. Deletions travel the
same way. SQLite files are sent as a consistent copy (`VACUUM INTO`); `-wal`/`-shm` are never sent.

Roots of a replica: `workspaces`, `pages`, `agents`, `skills`, `commands`, `plugins-data/memory` (its facts; each
hub builds the memory's index, MEMORY.md and git history itself, and its state is in `plugin_kv`: memory spec),
`devices`, `mcp.json`. A database a running process holds open must not be in a root: the sync replaces a file by
renaming a new one over it, and SQLite then refuses to write to the one it has open. A node syncs its workspaces root with the leader's `workspaces` (the same
`<agent>/<task>` layout), so a task finds its folder on whichever machine continues it. Never: node_modules, vendor,
.venv, venv, target, dist, build, .next, .cache, __pycache__, .DS_Store, what a folder's .gitignore leaves out.

### Vault

The vault's rows replicate sealed. A replica starts sealed unless it has a passphrase file. When the leader is unlocked
and sees a sealed replica, it raises one approval card: "Unlock the vault on <name>?"; on the person's tap the leader
hands that replica the data key over the signed channel, and the replica holds it in memory until it restarts. With no
unlocked replica left, the person unlocks with the passphrase as today.

## 3. Failover

- **Heartbeat**: every replica asks each peer `GET /api/replica/hello` every 2 s: role, priority, vector, sealed.
- **Leading**: a replica leads when no better-priority replica answers. A replica that comes back (the Mac after
  sleep) starts as standby, catches up until its vector covers the leader's, then says it wants to lead; the leader
  finishes its running turns (at most 2 minutes), steps down, and the better one leads. A leader that stops answering
  for 8 s is replaced by the next one at once. Two replicas that cannot see each other both lead; their changes merge
  when they meet again.
- **Main-only work** starts on taking the lead and stops on stepping down: the task scheduler and approval sweep,
  channels, the digest, plugin processes and external MCP servers. Tasks interrupted by a handover go back to the
  queue and continue on the new leader from the recap; a dialog turn cut by it says so.
- **Clients**:
  - the device app on every replica serves the same certificate; `/api/devices/addresses` lists every replica's
    addresses (the leader's first), so the phone finds whichever answers;
  - a standby forwards client API requests and WebSockets to the leader, so any address works;
  - nodes get every replica's address (`node.hubs`) and keep a connection to each; only the leader sends them work,
    and a session talks to the MCP of the replica that opened it.

## Tests

Unit: HLC, capture/drain/apply/merge (two in-memory hubs, concurrent edits, deletes, schema differences), file
rounds (both sides changed, deletions, ignores, SQLite copies), request signing, the gateway (model rewrite, limit,
streamed usage for both wires against a fake provider), node key-mode sessions (env and Codex config), routing
filters and the `@local` pool. Integration: two hubs in one process tree replicate a conversation and fail over.
