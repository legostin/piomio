// The hub on a Linux server (install.sh): what the launcher (packaging/linux/piomio) runs, with this release's Node.
//   <root>/current/runtime/bin/node <root>/current/packaging/linux/start.mjs [start|version|reset-password …]
// Like the desktop app, the hub runs as the person's user with their home and the PATH of their login shell, so the
// Claude Code, Codex or Kimi Code they signed in to over SSH is what the agents think with; nothing is copied.
// Ports as in Docker (8080 the chat, 8081 the console, 8082 phones), on 127.0.0.1 unless ~/.config/piomio/env says.

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdirSync } from "node:fs";
import { RESOLVE_HOOK, setupCode } from "../desktop/launch.mjs";

export const APP_ROOT = resolve(import.meta.dirname, "..", "..");

/** The data folder: PIOMIO_DATA_DIR, else ~/.local/share/piomio. */
export function dataDirOf(env = process.env, home = homedir()) {
  return env.PIOMIO_DATA_DIR || join(env.XDG_DATA_HOME || join(home, ".local", "share"), "piomio");
}

/** The environment the hub runs with; what ~/.config/piomio/env (systemd's EnvironmentFile) set wins. */
export function serverEnv(env, dataDir, home = homedir()) {
  const port = env.PIOMIO_PORT || "8080";
  const nodeOptions = env.NODE_OPTIONS ?? "";
  return {
    PIOMIO_APP_ROOT: APP_ROOT,
    // Passkeys need a host name: the chat opens as localhost through `ssh -L`.
    PIOMIO_PUBLIC_URL: `http://localhost:${port}`,
    // The user's PATH and home for the brain CLIs; a missing one can still be installed from the chat.
    PIOMIO_INSTALL_CLIS: "1",
    PIOMIO_BRAIN_HOME: home,
    PIOMIO_INSTALL_ROOT: join(home, ".local", "lib", "piomio"),
    NODE_ENV: "production",
    ...env,
    PIOMIO_PORT: port,
    NODE_OPTIONS: nodeOptions.includes(RESOLVE_HOOK) ? nodeOptions : `${nodeOptions} --import=${RESOLVE_HOOK}`.trim(),
    PIOMIO_DATA_DIR: dataDir,
  };
}

if (import.meta.main) {
  const dataDir = dataDirOf();
  mkdirSync(dataDir, { recursive: true });
  await import("../desktop/resolve.mjs");
  const args = process.argv.slice(2);
  Object.assign(process.env, serverEnv(process.env, dataDir));
  // The setup code stays in <data>/setup-code until the first sign-in, so install.sh can print it.
  if ((args[0] ?? "start") === "start") process.env.PIOMIO_SETUP_TOKEN ||= setupCode(dataDir);
  const cli = join(APP_ROOT, "packages", "core", "src", "cli.ts");
  process.argv = [process.argv[0], cli, ...args];
  await import(pathToFileURL(cli).href);
}
