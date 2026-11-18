// vault_exec: a shell command that needs a secret (a token for `git push`, `gh pr create`, a deploy). The agent names
// vault items by reference and the hub puts their values into the command's environment, so they never reach the
// model, the transcript or the logs: the input keeps the references, the output comes back with the values removed.
// The command runs where the session works: on the hub's own computer (through the hub's egress proxy, as that
// session, so the hosts it may reach are the session's) or on its paired machine (exec.run with `env`). It is an
// external action: the person's card, auto mode, or an "always allow" rule that names the command and exactly these
// variables (policy/engine.ts suggestRule).
import { existsSync, statSync } from "node:fs";
import { delimiter, join, relative } from "node:path";
import type { Machine, ToolCallContext, ToolResult } from "@piomio/shared";
import { absolutePath } from "@piomio/shared/agent-workspaces";
import { runShell } from "@piomio/node";
import type { ToolRegistry } from "./registry.ts";
import type { AgentRegistry } from "../agents.ts";
import { foldersOn, localFolderPaths } from "../agent-folders.ts";
import { hubLocale, tFor } from "../i18n.ts";
import { confinement, decideNative, expandHome, realOr, within } from "../native-permissions.ts";
import { DEFAULT_BRAIN_EGRESS } from "../settings.ts";
import { Redactor } from "../vault/redact.ts";
import { VaultError, type VaultService } from "../vault/service.ts";

export const VAULT_EXEC_TOOL = "vault_exec";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const VAULT_REF = /^vault:\/\/([\w.-]+)(?:#(\w+))?$/;
/** The hub's own, and what points a command's network at the hub's proxy: never the agent's to set. */
const RESERVED = /^(?:PIOMIO_.*|(?:HTTPS?|ALL|NO)_PROXY)$/i;
const MAX_VARS = 32;

export interface VaultExecDeps {
  registry: ToolRegistry;
  vault: VaultService;
  agents: AgentRegistry;
  machines: {
    find(idOrName: string): Machine | undefined;
    call<T>(machine: string, method: string, params: unknown, timeoutMs?: number): Promise<T>;
  };
  dataDir: string;
  /** The hub's own id in a cluster ("local" otherwise): which of the agent's project folders are on this computer. */
  here: () => string;
  /** The hub's egress proxy: a command here reaches the network as its session does. */
  egress?: {
    issueToken(owner: string, allow: string[], context?: { sessionId: string; conversationId: string; agentId: string; taskId?: string }): string;
    revoke(token: string, o?: { keepSession?: boolean }): void;
  };
  egressPort?: number;
  /** Folders with the person's programs (git, gh) the hub's own PATH may lack (UserPath.dirs). */
  pathDirs?: () => string[];
  /** Runs the command on this computer (tests replace it). */
  run?: typeof runShell;
}

interface Variable {
  name: string;
  /** A plain value, or the vault item (and its field) the value comes from. */
  value?: string;
  ref?: { id: string; field?: string };
}

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

/** The variables of a call, or what is wrong with them (English: it is for the model). */
export function parseEnv(env: unknown): Variable[] | string {
  if (!env || typeof env !== "object" || Array.isArray(env)) return 'Pass env: the variables the command needs, e.g. {"GH_TOKEN": "vault://github_token"}.';
  const entries = Object.entries(env as Record<string, unknown>);
  if (entries.length > MAX_VARS) return `At most ${MAX_VARS} variables.`;
  const out: Variable[] = [];
  for (const [name, v] of entries) {
    if (!ENV_NAME.test(name)) return `"${name.slice(0, 80)}" is not a variable name (letters, digits and _).`;
    if (RESERVED.test(name)) return `${name} is set by the hub and cannot be given to a command.`;
    if (typeof v !== "string") return `The value of ${name} must be a string: vault://<id> or a plain value.`;
    const m = VAULT_REF.exec(v.trim());
    if (m) out.push({ name, ref: { id: m[1], ...(m[2] ? { field: m[2] } : {}) } });
    else if (/^vault:\/\//i.test(v.trim())) return `The value of ${name} is not a vault reference: vault://<id> or vault://<id>#<field> (see vault_list).`;
    else out.push({ name, value: v });
  }
  if (!out.some((x) => x.ref)) return "vault_exec is for a command that needs a secret from the vault: give at least one variable as vault://<id>. A command without one runs in your own shell.";
  return out;
}

/** "GH_TOKEN = vault://github_token, GH_HOST = ghe.example.com" for the approval card: names and references, never values of secrets. */
function shownEnv(env: unknown): string {
  if (!env || typeof env !== "object") return "";
  return Object.entries(env as Record<string, unknown>)
    .map(([k, v]) => `${k} = ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(", ");
}

/** One field of a vault item for a variable: the named one, else its value, password or token, else its only field. */
function pick(fields: Record<string, string>, ref: { id: string; field?: string }): string | { error: string } {
  if (ref.field) {
    const v = fields[ref.field];
    return v !== undefined ? v : { error: `vault://${ref.id} has no field "${ref.field}". Its fields: ${Object.keys(fields).join(", ") || "none"}.` };
  }
  const v = fields.value ?? fields.password ?? fields.token ?? (Object.keys(fields).length === 1 ? Object.values(fields)[0] : undefined);
  return v !== undefined ? v : { error: `vault://${ref.id} has several fields (${Object.keys(fields).join(", ")}): name one as vault://${ref.id}#<field>.` };
}

/** The session's folder on a paired machine, when that machine lets commands run there. */
function remoteWorkspace(m: Machine, ctx: ToolCallContext, dataDir: string): string | undefined {
  const root = m.info?.workspacesRoot;
  if (!root) return undefined;
  const key = relative(join(dataDir, "workspaces"), ctx.workspace).split(/[\\/]+/);
  if (!key[0] || key.includes("..")) return undefined;
  const sep = root.includes("\\") ? "\\" : "/";
  const path = [root.replace(/[\\/]+$/, ""), ...key].join(sep);
  const inside = (m.info?.allowedDirs ?? []).some((d) => {
    const dir = d.replace(/[\\/]+$/, "");
    return path === dir || path.startsWith(dir + sep);
  });
  return inside ? path : undefined;
}

export function registerVaultExec(d: VaultExecDeps): void {
  d.registry.register(
    {
      name: VAULT_EXEC_TOOL,
      owner: "core",
      effect: "external",
      approvalSummary: "%vaultExec.approval%",
      description:
        "Run a shell command that needs a secret from the vault (a token for git push, gh, a deploy): the secrets are put into the command's environment and their values never reach you. " +
        "env maps a variable name to vault://<id> (vault_list shows the ids; vault://<id>#<field> for one field of an item with several) or to a plain value. " +
        "The command runs on the computer you work on, in your folder (or cwd: one of your project folders), and you get its exit code and output with the secrets removed. " +
        "git over HTTPS: name the token GIT_PASSWORD (and GIT_USERNAME when the server wants a real one) and a plain `git push origin main` signs in with it (macOS and Linux). " +
        "GitHub CLI: GH_TOKEN; for a GitHub Enterprise server GH_ENTERPRISE_TOKEN with GH_HOST as a plain value. " +
        "Only for commands that need a secret: everything else runs in your own shell. A secret that is not in the vault yet: ask for it with hub_secret_request, never in a message. " +
        "Keep the command plain (one program with its arguments, no $VAR, pipes or &&) when you can: the person can then allow it for good on its card.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "The shell command" },
          env: {
            type: "object",
            description: 'Variables for the command: {"GH_TOKEN": "vault://github_token", "GH_HOST": "ghe.example.com"}. At least one vault:// reference.',
            additionalProperties: { type: "string" },
          },
          cwd: { type: "string", description: "Working folder: your session's folder by default, or one of your project folders" },
          timeoutSec: { type: "number", description: "Default 120, at most 1800" },
        },
        required: ["command", "env"],
      },
    },
    async (i, ctx) => {
      const command = typeof i?.command === "string" ? i.command.trim() : "";
      if (!command) return text("Pass command: the shell command to run.", true);
      const vars = parseEnv(i?.env);
      if (typeof vars === "string") return text(vars, true);

      // The secrets, checked against each item's own scope (its agents and tools).
      const env: Record<string, string> = {};
      const secrets: Array<{ id: string; value: string }> = [];
      for (const v of vars) {
        if (!v.ref) {
          env[v.name] = v.value ?? "";
          continue;
        }
        const meta = d.vault.getMeta(v.ref.id);
        // A website's login is typed on its site only, unless the person opened the item to this tool.
        if (meta?.type === "login" && !meta.scope.tools.includes(VAULT_EXEC_TOOL)) {
          return text(`vault://${v.ref.id} is a website's login: it is typed on its site only (browser_fill_secret) and is not given to commands.`, true);
        }
        let fields: Record<string, string>;
        try {
          fields = d.vault.access(v.ref.id, { actor: `agent:${ctx.agentId}`, agentId: ctx.agentId, tool: VAULT_EXEC_TOOL });
        } catch (e) {
          if (!(e instanceof VaultError)) throw e;
          if (e.code === "not_found") return text(`No vault item vault://${v.ref.id}. vault_list shows what is there; ask the person for a missing secret with hub_secret_request.`, true);
          if (e.code === "sealed" || e.code === "uninitialized") return text("The vault is locked, so nothing was run. Ask the person to unlock it (hub_secret_request shows the card that does), then call again.", true);
          return text(`${e.message}. The person decides who may use this item; nothing was run.`, true);
        }
        const value = pick(fields, v.ref);
        if (typeof value !== "string") return text(value.error, true);
        env[v.name] = value;
        secrets.push({ id: v.ref.id, value });
      }
      // Whatever the command prints: the given values never come back, also for items the model may otherwise read.
      const scrub = new Redactor();
      scrub.setSecrets(secrets);
      const timeoutMs = Math.min(Math.max(Number(i.timeoutSec) || 120, 1), 1800) * 1000;
      const shown = (r: { code: number; stdout: string; stderr: string }) => text(scrub.text(`exit ${r.code}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`), r.code !== 0);

      try {
        if (ctx.machineId !== "local") {
          const m = d.machines.find(ctx.machineId);
          if (!m) return text(`The computer this session works on (${ctx.machineId}) is not paired with the hub any more.`, true);
          if (!m.info?.secretEnv) {
            return text(`${m.name} runs an older Piomio that cannot give a command secrets: update it first (hub_machine_update, or the person does it on that computer). Nothing was run.`, true);
          }
          const cwd = typeof i.cwd === "string" && i.cwd.trim() ? i.cwd.trim() : remoteWorkspace(m, ctx, d.dataDir);
          return shown(await d.machines.call(m.id, "exec.run", { command, ...(cwd ? { cwd } : {}), timeoutMs, env }, timeoutMs + 100_000));
        }

        // On the hub's own computer: in the session's folder or one of the agent's project folders.
        const folders = localFolderPaths(foldersOn(d.agents.get(ctx.agentId)?.folders, "local", d.here()), { dataDir: d.dataDir });
        const cwd = realOr(typeof i.cwd === "string" && i.cwd.trim() ? absolutePath(expandHome(i.cwd.trim()), ctx.workspace) : ctx.workspace);
        if (![ctx.workspace, ...folders].some((dir) => within(cwd, realOr(dir)))) {
          return text(`cwd must be your session's folder (${ctx.workspace})${folders.length ? ` or one of your project folders (${folders.join(", ")})` : ""}. Nothing was run.`, true);
        }
        if (!existsSync(cwd) || !statSync(cwd).isDirectory()) return text(`The working folder does not exist: ${cwd}. Nothing was run.`, true);
        // The same refusals as for the brain's own shell: the person's credential stores and the hub's data are not a command's to name.
        const verdict = decideNative({ kind: "command", tool: VAULT_EXEC_TOOL, command, cwd }, { workspace: ctx.workspace, roots: folders, denied: confinement(d.dataDir, ctx.workspace).denyRead });
        if (verdict.decision === "deny") return text(`Not allowed: ${verdict.reason}. Nothing was run.`, true);

        const path = [...(d.pathDirs?.() ?? []), ...(process.env.PATH ?? "").split(delimiter)].filter((p, n, all) => p && all.indexOf(p) === n).join(delimiter);
        const token = d.egress && d.egressPort ? d.egress.issueToken(`brain:exec:${ctx.callId}`, DEFAULT_BRAIN_EGRESS, { sessionId: ctx.sessionId, conversationId: ctx.conversationId, agentId: ctx.agentId, taskId: ctx.taskId }) : undefined;
        const proxy = token ? `http://${token}:x@127.0.0.1:${d.egressPort}` : undefined;
        const net: Record<string, string> = proxy ? { HTTPS_PROXY: proxy, HTTP_PROXY: proxy, https_proxy: proxy, http_proxy: proxy, NO_PROXY: "127.0.0.1,localhost,::1", no_proxy: "127.0.0.1,localhost,::1" } : {};
        try {
          return shown(await (d.run ?? runShell)({ command, cwd, timeoutMs, env: { ...(path ? { PATH: path } : {}), ...env, ...net } }));
        } finally {
          if (token) d.egress!.revoke(token, { keepSession: true });
        }
      } catch (e: any) {
        return text(scrub.text(e?.message ?? String(e)), true);
      }
    },
    (i) => tFor(hubLocale())("vaultExec.approval", { command: String(i?.command ?? ""), env: shownEnv(i?.env) }),
  );
}
