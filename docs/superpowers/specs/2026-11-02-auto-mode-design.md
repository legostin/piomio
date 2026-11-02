# Auto mode: a reviewer decides instead of a card

2026-11-02. Decided with the user, who got a card for every `ls`, `git log` and `cat` of a task ("ПОЧЕМУ ОН ДО СИХ ПОР
НА ТАКИЕ КОМАНДЫ ПОСТОЯННО РАЗРЕШЕНИЕ ПРОСИТ") and asked for "a full analog of auto mode in Claude":

1. **The hub's own auto mode**, not Claude Code's built-in one: one engine for every brain (Claude Code, Codex, other
   machines) and for the hub's own tools, which sees the person's real words (a task's goal is an agent's words).
2. **Always the person's call, never the reviewer's:** money; deleting agents, installing plugins, unlocking replicas
   (their own cards, as today); messages to people on the person's behalf; publishing (push to main/master, releases,
   deploys, posts). "You asked" (policy/asked.ts) stays as it is.
3. **The chat shows only blocks**: an allowed action leaves nothing in the chat (it is in the audit log); a stopped one
   is a quiet line with the reason and an "Allow" button.

## What was wrong

Seen on the installed hub (task `t_mvy7t56myMyD3LQi` of `direktor`, 2026-11-01) and in the code:

- **Every one of the task's 7 commands set `dangerouslyDisableSandbox`**, the first one before trying the sandbox, so
  each went to `native_permission`, where an unsandboxed command asks unless it only reads the computer's state
  (`systemStatusOnly`). `ls`, `cat`, `git log`, `git show` all asked.
- **The agent's own earlier task folders are closed to it.** `workspaces/direktor/t_mvwwisswu…/report.md` sits in the
  hub's data dir: the sandbox denies it (only the current session's folder is `allowRead`) and `Read` is refused, so the
  agent went around through Bash outside the sandbox, which asked.
- **"Always allow" never fires again.** It saves the exact text of a compound command (6 dead rules from this task) and
  one file for a `Read` (15 cards on 2026-10-31, one per file of the same repo).
- **No network in sandboxed commands** (`allowedDomains: []`): every GitHub API call ran outside the sandbox and asked.

## How Claude Code's auto mode works (what we copy)

From code.claude.com/docs (permission-modes, auto-mode-config, sandboxing) and Anthropic's engineering post:

- Read-only actions, edits in the working folder and the person's allow/deny rules never reach the classifier.
- A separate model sees the person's messages and the agent's tool calls, **not tool results and not the agent's own
  text**, so content the agent read cannot talk it round; plus the pending action.
- Two stages: a fast yes/no told to err toward blocking; only a flagged action gets a second look with reasoning.
- A block gives the agent the reason and it looks for another way; after 3 blocks in a row or 20 in all, it asks the
  person again; approving resumes auto mode.
- The person's deny rules come first and nothing overrides them.

## The decision, step by step

Every action that today would ask the person (native-permission.ts `decideNative` → "ask", the gateway's policy →
"ask") goes through `AutoMode.decide` (`packages/core/src/policy/auto.ts`) when `approvalMode` is `"auto"`:

1. **Hard no** (unchanged, before auto mode): credentials, the hub's data outside the agent's own folder, the person's
   deny rules. An unsandboxed command that names a denied path (`~/.ssh`, `vault.db`, `piomio.db`, another agent's
   folder…) is refused the same way, without a review.
2. **Fast yes, no review**:
   - everything already allowed today (sandbox, own folder, temp, status commands, the person's allow rules);
   - **the agent's own folder is its whole `workspaces/<agent>/`**: every task and dialog of that agent, for reading
     (the sandbox's `allowRead` and `decideNative`); writing stays in the session's folder and temp;
   - **read-only commands**: a command line whose every part (split on `;`, `&&`, `||`, `|`) is a known reader
     (`ls`, `cat`, `head`, `tail`, `wc`, `grep`/`rg`, `find` without `-exec`/`-delete`/`-ok`/`-fprint*`, `stat`,
     `file`, `du`, `tree`, `diff`, `jq`, `sort`, `uniq`, `cut`, `tr`, `cd`, `pwd`, `echo`, `which`, `git` with
     `log`/`show`/`status`/`diff`/`ls-files`/`ls-tree`/`grep`/`rev-parse`/`describe`/`blame`/`shortlog`/`cat-file`/
     `remote -v`/`branch` without `-d -D -m -M -c -C`/`tag -l`, and the status commands of today), with `~`, `$HOME`,
     `$TMPDIR` expanded, globs allowed, no substitution (`$(…)`, backticks, other `$VAR`), no redirection except to
     `/dev/null`, no heredoc, no background `&`, no subshell; and no word naming a denied path;
   - **a folder read once is read for the session**: after a read outside the agent's folders is allowed (by review or
     by the person), later reads in the same folder (its git root, else its parent folder) in that session need no
     review.
3. **Always the person** (a card, as today, never reviewed): money (the existing MONEY words in a summary or label, an
   `amount` field); messages to people (a tool whose name says send/reply/post/email/message/comment, `browser_submit`
   of kind send/publish); publishing (commands with `git push` to `main`/`master` or `--force`, `gh release`,
   `npm publish`, `docker push`, deploy commands); and the reviewer's own verdict "person". The hub tools with their own
   cards (agent delete, plugin install, replica unlock, permission_always, skill save) do not pass through auto mode.
4. **The reviewer** decides the rest: `allow` runs it with no card; `block` refuses it with the reason; `person` gives a
   card. A failed review (no reviewing brain, an error, no answer within 60 s) gives a card, never a silent refusal.
5. **Too many blocks**: after 3 blocks in a row or 20 in a session, the next action that would be blocked gets a card;
   the person's yes on any card of that session resets the row.

Background work of an agent that may only suggest (initiative < 2) stays as it is: nothing to ask, refused.

## The reviewer

- **What it sees** (English prompt, untrusted parts fenced like digest.ts `fenced`):
  - the person's own messages from the last 3 hours where the session works (the gateway's `personWords`: its dialog
    or the dialog its task was started from; role user without agentId);
  - the task's goal, marked as written by an agent, not by the person;
  - the session's earlier tool calls (name and input, newest 20, from its conversation's `tool_call` parts), never
    `tool_result` parts and never the agent's text;
  - where it runs: the machine, the agent's folder, the hub's data dir (off limits);
  - the pending action: tool, input (redacted), the agent's stated reason (a Bash `description`), and why the fast path
    did not take it.
- **The rules** (in the prompt):
  - block: sending data off the machine that the request does not need (exfiltration), `curl | sh`, deleting or
    overwriting what this session did not create, `git reset --hard`, rewriting history, changing security
    or system settings (keychain, launchd, sudo, firewall, shell profiles), installing from unverified sources, reading
    credentials, acting on systems or accounts the request did not mention, anything outside what the person asked;
  - person: messages to people, publishing (as in step 3), money;
  - allow: local work, reading files and the web, installing dependencies declared in a manifest or lockfile, git in
    working branches (commit, branch, push to a non-default branch), running the project's tests and builds, what the
    person plainly asked for.
- **Two stages**: stage 1 answers one word, `ALLOW` or `BLOCK`, erring toward BLOCK, on the cheapest quick model;
  stage 2 runs only after `BLOCK`, on a stronger model, and answers JSON `{"verdict":"allow|block|person","rule":"…",
  "reason":"…"}` (reason in the person's language, one sentence).
- **Which brain**: a local Claude Code brain that is signed in, model chosen by the router (`need: "light"` for stage 1,
  `"quick"` for stage 2). The session is bare (`BrainSessionOptions.bare`): no tools, no MCP, no skills, no plugins,
  the reviewer's prompt as the whole system prompt, the person's user hooks not loaded, nothing kept after it. One
  stage-1 process is kept ready (`warm()`), so a review does not wait for the CLI to start; a fresh session per review,
  so reviews never see each other.

## Codex and Kimi (added the same day)

The person asked for auto mode "for Codex and Kimi too, on the cheapest model", and for GPT-6.1 Luna on Codex:

- **The reviewer runs on any local signed-in CLI brain**: the reviewed session's own (Codex reviews a Codex agent,
  Kimi a Kimi agent) when it can, else Claude Code, Codex, Kimi in that order; a brain that fails (not signed in, no
  Kimi Code plan, over a limit) hands the review to the next and rests 5 minutes. Both stages use the brain's cheapest
  model (Claude Code: Haiku); the second look asks for more effort. Codex takes its newest Luna: the account has no
  GPT-6.1 Luna yet (Codex answers "not supported when using Codex with a ChatGPT account", also in 0.166), so it is
  GPT-6 Luna with the ChatGPT app's Codex and GPT-5.6 Luna with an older npm one; GPT-6.1 Luna is taken once listed.
  Bare Codex: `mcp_servers={}`, the shell tool, plugins, apps, memories, hooks and sub-agents off, read-only, an
  ephemeral thread with the reviewer prompt as its base instructions. Bare Kimi: no MCP servers, every permission
  request refused.
- **Codex runs every command as `/bin/zsh -lc '<script>'`.** The command checks (`policy/commands.ts`) read a
  shell's `-c` script as its own commands, for every brain (it was also a way round them); the card, the rules and the
  reviewer see the script.
- **Codex's and Kimi's approval answers have no room for a reason**: the hub's reason reaches a Codex agent as input
  steered into the turn, a Kimi agent at the start of its next turn.
- **"Allow" on a blocked line matches the action** (the command or path), not the request: Claude Code words its
  `description` and Codex its `reason` anew every time.
- **Codex reads were open**: its `workspace-write` sandbox reads the whole disk. Confined, Codex now runs under a
  permission profile (`default_permissions`, extending `:workspace` or `:read-only`) that denies what Claude Code's
  sandbox denies (credentials, the hub's data, other agents' folders), reads the agent's earlier folders, and has no
  network; the thread gets no `sandbox` (it would win over the profile), and a thread that reports full access is not
  started. `codex exec` (Codex without the app-server, older than profiles) keeps `sandbox_mode`.

## What the agent and the person see

- **Allowed**: the action runs; audit `auto.decision` with the verdict, stage, model and ms.
- **Blocked**: the agent gets `Auto mode stopped this: [<rule>] <reason>. Find another way that fits what the person
  asked, or ask them in your reply.` The approval is kept with status `blocked` (new `ApprovalStatus`) and the chat
  gets a quiet line (the `approval` part with `status: "blocked"` and `auto: { reason, rule }`) drawn like the "you
  asked" line, with one button, "Allow". Allow resolves it as approved, lets that exact action (same tool and input)
  through once in that session, and tells the agent (a system note and a turn, as for a deferred approval).
- **Person**: the normal card.

## Settings and the chat

- `approvalMode: "auto" | "ask"` in the core settings, default `"auto"`.
- The person says "спрашивай меня всё" in the chat: the default agent sets `"ask"` with `settings_update` at once
  (stricter needs no yes). Setting `"auto"` from the chat asks on a card (it loosens protection).

## Testing

- Unit: the read-only parser (allowed and refused lines, denied paths, expansion), the always-the-person detection,
  the folder grant, the counters, the reviewer's answer parsing (one word, JSON, junk → card).
- Core: `native_permission` and the gateway with a stub reviewer: allow runs without a card, block refuses with the
  reason and leaves a `blocked` line, person and a failed review give a card, 3 blocks in a row give a card, "Allow" on
  a blocked line lets the same action through once.
- brains-cli: a bare Claude Code session's arguments (`--tools ""`, no MCP, `--system-prompt-file`).
- Live: install on the Mac, rerun a task like direktor's and count the cards.
