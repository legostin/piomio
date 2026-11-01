// `node.update` from the hub (packages/core/src/self-update.ts): this daemon's file (piomio-node.mjs) is replaced
// with the hub's own version and the daemon restarts. The new file is written next to it (as .next.mjs: Node reads a
// module as ESM by its extension) and checked (its sha256, then `node <new> --version` must say that version) before
// it takes the old one's place; the old one stays as <file>.prev. Under systemd the daemon exits with 75 and the unit's Restart= brings it back; started some other
// way it starts itself again first.

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { selfFile } from "./version.ts";

export interface NodeUpdate {
  version: string;
  sha256: string;
  /** The new piomio-node.mjs, base64. */
  bundle: string;
}

/** Set when the daemon stops to restart: `piomio-node run` then exits with RESTART_CODE. */
export const restart = { requested: false };
export const RESTART_CODE = 75;

export type Run = (file: string, args: string[], timeoutMs: number) => Promise<string>;

const runFile: Run = (file, args, timeoutMs) =>
  new Promise((resolve, reject) => execFile(file, args, { timeout: timeoutMs, killSignal: "SIGKILL" }, (err, stdout) => (err ? reject(err) : resolve(stdout))));

/** Stops the daemon the way a signal does (cli.ts closes everything) and has it come back. */
export function restartSelf(): void {
  restart.requested = true;
  // systemd gives every process of a unit INVOCATION_ID; without it nothing would start the daemon again.
  if (!process.env.INVOCATION_ID) spawn(process.execPath, process.argv.slice(1), { detached: true, stdio: "inherit" }).unref();
  process.kill(process.pid, "SIGTERM");
}

export async function applyUpdate(u: NodeUpdate, o: { file?: string; run?: Run; restart?: () => void } = {}): Promise<{ restarting: true }> {
  const file = o.file ?? selfFile();
  if (!file) throw new Error("this daemon runs inside the Piomio app or from source and does not replace itself");
  const bytes = Buffer.from(String(u?.bundle ?? ""), "base64");
  if (!bytes.length || createHash("sha256").update(bytes).digest("hex") !== u.sha256) throw new Error("the update does not match its checksum");
  const next = `${file.replace(/\.mjs$/, "")}.next.mjs`;
  writeFileSync(next, bytes);
  try {
    const said = (await (o.run ?? runFile)(process.execPath, [next, "--version"], 60_000)).trim();
    if (said !== u.version) throw new Error(`the new daemon says it is ${said || "nothing"}, not ${u.version}`);
    copyFileSync(file, `${file}.prev`);
    renameSync(next, file);
  } catch (e) {
    rmSync(next, { force: true });
    throw e;
  }
  // After the answer has gone back.
  setTimeout(o.restart ?? restartSelf, 300);
  return { restarting: true };
}
