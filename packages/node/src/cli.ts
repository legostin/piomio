#!/usr/bin/env node
// piomio-node CLI: pair | run | status | policy

import { existsSync, readFileSync } from "node:fs";
import { configFile, keyFile, loadConfig, nodeHome, normalizeHubUrl, NotPairedError, parseInviteLink, UserError } from "./home.ts";
import { PolicyStore, policySummary } from "./policy.ts";
import { BrainHost } from "./brains.ts";
import { pair, PairError, networkErrorText } from "./pair.ts";
import { createNodeDaemon } from "./daemon.ts";
import { consoleLogger, machineInfo, osName } from "./info.ts";
import { t } from "./messages.ts";
import { stopOnDesktopStdin } from "./desktop.ts";
import { PIOMIO_VERSION } from "./version.ts";
import { restart, RESTART_CODE } from "./self-update.ts";

const help = () => t("cli.help", { home: nodeHome() });

function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string | true> } {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      if (v !== undefined) flags[k] = v;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) flags[k] = argv[++i];
      else flags[k] = true;
    } else if (a === "-h") flags.help = true;
    else positional.push(a);
  }
  return { positional, flags };
}

const out = (s = "") => process.stdout.write(s + "\n");

async function cmdPair(args: string[], flags: Record<string, string | true>): Promise<void> {
  // `pair <invite link>`, or the older `pair <hub-url> <code>`.
  const link = args.length === 1 ? parseInviteLink(args[0]) : undefined;
  if (args.length === 1 && !link) throw new PairError(t("cli.badLink", { link: args[0] }));
  const [hubUrl, code] = link ? [link.hubUrl, link.code] : args;
  if (!hubUrl || !code) throw new PairError(t("cli.pairUsage"));
  normalizeHubUrl(hubUrl);
  const home = nodeHome();
  const policy = new PolicyStore(home, { log: (m) => out(m) });
  const brains = new BrainHost({ home, policy });
  out(t("cli.checkingClis"));
  const clis = await brains.probeAll();
  const name = typeof flags.name === "string" ? flags.name : undefined;
  const r = await pair({ home, hubUrl, code, name, info: machineInfo(policy.get(), clis) });
  out(t("cli.paired", { hub: r.hubUrl, name: r.name, id: r.machineId }));
  if (r.replaced) out(t("cli.replaced", { id: r.replaced }));
  out(t("cli.line.key", { file: keyFile(home) }));
  out(t("cli.line.policy", { file: policy.file }));
  for (const l of policySummary(policy.get())) out(`  ${l}`);
  const brainState = (c: (typeof clis)[number]) =>
    c.available
      ? t("cli.brain.present", { id: c.brainId, version: c.version ? ` ${c.version}` : "" }) + (c.authenticated ? "" : t("cli.brain.noLoginSuffix"))
      : t("cli.brain.absent", { id: c.brainId, detail: c.detail ?? t("cli.brain.none") });
  out(t("cli.line.brains", { list: clis.map(brainState).join("; ") }));
  out(t("cli.next"));
}

async function cmdRun(): Promise<void> {
  const home = nodeHome();
  const log = consoleLogger();
  let exiting = false;
  const daemon = createNodeDaemon({
    home,
    log,
    onFatal: () => {
      exiting = true;
      process.exitCode = 1;
      setTimeout(() => process.exit(1), 200).unref();
    },
  });
  out(t("cli.run.header", { name: daemon.config.name, id: daemon.config.machineId, hub: daemon.config.hubUrl }));
  out(t("cli.run.policy", { file: daemon.policy.file }));
  for (const l of policySummary(daemon.policy.get())) out(`  ${l}`);
  const shutdown = async (sig: string) => {
    if (exiting) return;
    exiting = true;
    log(t("cli.stopping", { signal: sig }));
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    await daemon.stop().catch(() => {});
    // After an update (self-update.ts): a code systemd's Restart= starts the daemon again on.
    process.exit(restart.requested ? RESTART_CODE : 0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGHUP", () => void shutdown("SIGHUP"));
  if (process.env.PIOMIO_DESKTOP === "1") stopOnDesktopStdin(process.stdin, () => void shutdown("stop"));
  process.on("unhandledRejection", (e: any) => log(t("cli.unhandledRejection", { error: String(e?.stack ?? e) })));
  process.on("uncaughtException", (e: any) => log(t("cli.uncaughtException", { error: String(e?.stack ?? e) })));
  daemon.client.start();
}

async function cmdStatus(): Promise<void> {
  const home = nodeHome();
  out(t("cli.status.home", { home }));
  let hubUrl: string | undefined;
  try {
    const c = loadConfig(home);
    hubUrl = c.hubUrl;
    out(t("cli.status.hub", { hub: c.hubUrl }));
    out(t("cli.status.machine", { name: c.name, id: c.machineId }) + (c.pairedAt ? t("cli.status.pairedAt", { at: c.pairedAt }) : ""));
  } catch (e: any) {
    out(e instanceof NotPairedError ? t("cli.status.notPaired") : t("cli.status.pairError", { error: e.message }));
  }
  out(t("cli.status.system", { os: osName(), arch: process.arch, node: process.version }));
  const policy = new PolicyStore(home, { log: (m) => out(m) });
  out(t("cli.line.policy", { file: policy.file }));
  for (const l of policySummary(policy.get())) out(`  ${l}`);
  const brains = new BrainHost({ home, policy });
  out(t("cli.status.brains"));
  for (const c of await brains.probeAll()) {
    const detail = c.detail ? ` — ${c.detail}` : "";
    out(
      c.available
        ? t("cli.status.brainInstalled", { id: c.brainId, version: c.version ? ` (${c.version})` : "", login: t(c.authenticated ? "cli.status.signedIn" : "cli.status.notSignedIn"), detail })
        : t("cli.status.brainMissing", { id: c.brainId, detail }),
    );
  }
  if (hubUrl) {
    try {
      const r = await fetch(`${hubUrl}/api/auth/state`, { signal: AbortSignal.timeout(5000) });
      const j: any = await r.json().catch(() => ({}));
      out(r.ok ? t("cli.status.hubOk", { version: j.version ?? "?" }) : t("cli.status.hubStatus", { status: r.status }));
    } catch (e: any) {
      out(networkErrorText(e, hubUrl));
    }
  }
}

function cmdPolicy(): void {
  const home = nodeHome();
  const policy = new PolicyStore(home, { log: (m) => out(m) });
  out(policy.file);
  out();
  out(readFileSync(policy.file, "utf8").trimEnd());
  if (!existsSync(configFile(home))) out(t("cli.policy.notPaired"));
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);
  if (cmd === "--version" || cmd === "version") {
    out(PIOMIO_VERSION);
    return;
  }
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h" || flags.help) {
    out(help());
    return;
  }
  switch (cmd) {
    case "pair":
      return cmdPair(positional, flags);
    case "run":
      return cmdRun();
    case "status":
      return cmdStatus();
    case "policy":
      return cmdPolicy();
    case "mcp-bridge":
      // Internal: the stdio MCP bridge brain CLIs spawn (keeps the single-file download self-contained).
      await import("@piomio/mcp-bridge");
      return;
    default:
      throw new PairError(t("cli.unknownCommand", { command: cmd, help: help() }));
  }
}

main().catch((e: any) => {
  const known = e instanceof UserError;
  process.stderr.write(`${known ? e.message : t("cli.error", { error: String(e?.message ?? e) })}\n`);
  process.exit(1);
});
