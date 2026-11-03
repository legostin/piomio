# Agent network allowlist and host approval

## Evidence and scope

The prior commit 6d5d391 chains both CLI sandbox proxies to the authenticated hub proxy. `egress.ts` currently returns 403 before any approval; `runner.ts` passes a snapshot of the host list to the CLI, preventing unknown hosts from reaching the hub. `ApprovalService` and the runner already persist cards, mirror task cards to the starter dialog, and audit decisions. Settings already exposes `brainEgressAllow`.

## Data and flow

- Keep the built-in model/package/GitHub hosts and `brainEgressAllow`. Show both in settings; user additions are editable. Validate exact DNS names, public IPs and leading `*.` domain patterns. Do not accept URLs, ports, or unrestricted `*` as user entries.
- A local brain proxy token carries trusted session, conversation, task and agent context. CLI sandbox domain filtering forwards destinations to the authenticated hub proxy; it does not decide host permissions. Command approvals remain enabled and separate.
- Before asking, resolve and check all IPs; loopback, private, link-local and metadata destinations are refused by default. DNS is pinned to checked addresses when connecting. Validate CONNECT host/port and HTTP URLs.
- Unknown public destinations create an `ApprovalAsk.kind = network` card through ApprovalService. The proxy awaits the decision for at most 90 seconds, without opening an upstream socket. Concurrent attempts to the same token/host/port share a request. A token has at most 16 pending requests.
- Approve once permits that host and port for the token's session (the task or current dialog session). Always atomically appends the exact host to `brainEgressAllow`; no action rule or trusted-content target is created. IP literals carry a visible warning. Denial, expiration, cancellation and revocation fail closed and are audited.
- Network approvals are never executed later as tools. Expire pending network requests after restart. Return readable HTTP/CONNECT errors (including status reason and body); an agent can also request a host explicitly via `hub_network_request` and receives the outcome as text.
- The existing chat card is extended with network context, scope, host/port and IP warning. It appears in the task chat and starter dialog using the existing event flow. Security console uses the same decisions.

## Safety and limits

This iteration supports brains on the hub machine. Remote brain sessions are not silently given unrestricted networking. Remote parity needs an authenticated node-to-hub proxy tunnel, per-session grants, lifecycle cancellation and node sandbox configuration, with tests on each OS. Raw TLS does not expose a shell command; omit it rather than guessing. External actions such as git push still require their existing command/action approval.

## Verification

Unit/integration tests: known hosts, unknown host waiting, once scope, always persistence without action rules, deny/timeout, private/IP/wildcard validation, revocation/cancellation, HTTP and CONNECT error details. CLI configuration tests for Claude Code and Codex. Chat card tests and English/Russian catalog parity. Typecheck and web/console builds. Real CLI and remote-machine checks are reported separately from automated tests.
