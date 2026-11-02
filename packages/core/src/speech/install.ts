// Downloads of the local speech engine. Each piece lands in a temp folder next to its place, is checked against its
// pinned size and hash before the system's tar unpacks it, and moves into place with one rename: a failed or wrong
// download leaves nothing installed and nothing behind. Errors are English (logs); InstallError.reason says which kind.

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { modelUrl, tarballUrl, type ModelSpec, type RuntimePackage } from "./catalog.ts";

export interface Progress {
  received: number;
  total: number;
}

export type InstallFailure = "download" | "integrity" | "extract";

export class InstallError extends Error {
  reason: InstallFailure;
  /** A dropped connection or a busy server: worth trying again from where it stopped. */
  transient: boolean;
  constructor(reason: InstallFailure, message: string, transient = false) {
    super(message);
    this.reason = reason;
    this.transient = transient;
  }
}

/** A download that sends nothing for this long is cut off, and tried again from where it stopped. */
export const DOWNLOAD = { idleMs: 60_000, pauseMs: 1000 };
/** Tries of one download: a stall or a dropped connection goes on from the last byte (HTTP Range). */
const ATTEMPTS = 6;

/** sha256 as hex, or an npm integrity string ("sha512-<base64>"). */
export type Digest = { sha256: string } | { integrity: string };

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });
}

/**
 * Downloads `url` into `file`, checking its size and digest; throws InstallError. A stall or a dropped connection goes
 * on from the last byte received (a server that ignores the range starts it over). `signal` stops it (the hub stops).
 */
export async function download(url: string, file: string, expect: { size: number } & Digest, onProgress?: (p: Progress) => void, signal?: AbortSignal): Promise<void> {
  const algo = "sha256" in expect ? "sha256" : "sha512";
  const got = { hash: createHash(algo), received: 0 };
  const fh = await open(file, "w", 0o644);
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        await fetchInto(url, fh, got, algo, expect.size, onProgress, signal);
        break;
      } catch (e) {
        const retry = e instanceof InstallError && e.transient && !signal?.aborted && attempt < ATTEMPTS;
        if (!retry) throw e;
        await pause(Math.min(30_000, DOWNLOAD.pauseMs * 2 ** attempt), signal);
      }
    }
  } finally {
    await fh.close();
  }
  if (got.received !== expect.size) throw new InstallError("integrity", `${url} has ${got.received} bytes, expected ${expect.size}`);
  const ok = "sha256" in expect ? got.hash.digest("hex") === expect.sha256.toLowerCase() : `sha512-${got.hash.digest("base64")}` === expect.integrity;
  if (!ok) throw new InstallError("integrity", `${url} does not match its pinned checksum`);
}

/** One request of a download: the rest of the file after `got.received` bytes. */
async function fetchInto(
  url: string,
  fh: Awaited<ReturnType<typeof open>>,
  got: { hash: ReturnType<typeof createHash>; received: number },
  algo: string,
  size: number,
  onProgress: ((p: Progress) => void) | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  const ctl = new AbortController();
  const stop = () => ctl.abort();
  signal?.addEventListener("abort", stop, { once: true });
  if (signal?.aborted) ctl.abort();
  let idle = setTimeout(stop, DOWNLOAD.idleMs);
  try {
    let res: Response;
    try {
      res = await fetch(url, { signal: ctl.signal, redirect: "follow", ...(got.received ? { headers: { range: `bytes=${got.received}-` } } : {}) });
    } catch (e: any) {
      // Unreachable from the start is an answer; after part of the file, the network dropped.
      throw new InstallError("download", `${host(url)} is unreachable (${e?.cause?.code ?? e?.name ?? "network error"})`, got.received > 0);
    }
    if (!res.ok || !res.body) throw new InstallError("download", `${host(url)} answered ${res.status}`, res.status >= 500 || res.status === 408 || res.status === 429);
    // The server sends the whole file again: start over.
    if (got.received && res.status !== 206) {
      got.hash = createHash(algo);
      got.received = 0;
      await fh.truncate(0);
    }
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        clearTimeout(idle);
        idle = setTimeout(stop, DOWNLOAD.idleMs);
        if (got.received + chunk.length > size) throw new InstallError("integrity", `${url} is larger than expected (${size} bytes)`);
        got.hash.update(chunk);
        await fh.write(chunk, 0, chunk.length, got.received);
        got.received += chunk.length;
        onProgress?.({ received: got.received, total: size });
      }
    } catch (e: any) {
      if (e instanceof InstallError) throw e;
      throw new InstallError("download", `the download from ${host(url)} broke off after ${got.received} bytes (${e?.cause?.code ?? e?.name ?? "error"})`, true);
    }
  } finally {
    clearTimeout(idle);
    signal?.removeEventListener("abort", stop);
  }
}

/** The system's tar (Windows 10+ ships bsdtar as tar.exe; GNU tar elsewhere would read "C:" as a host). */
function tarCommand(): string {
  if (process.platform !== "win32") return "tar";
  const own = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  return existsSync(own) ? own : "tar";
}

/** Unpacks a .tgz or .tar.bz2 into `dest`, dropping its top folder; throws InstallError. */
export function extract(archive: string, dest: string): Promise<void> {
  mkdirSync(dest, { recursive: true });
  const z = archive.endsWith(".bz2") ? "j" : "z";
  return new Promise((resolve, reject) => {
    const tar = spawn(tarCommand(), [`-x${z}f`, archive, "-C", dest, "--strip-components=1", "--no-same-owner"], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let err = "";
    tar.stderr.setEncoding("utf8");
    tar.stderr.on("data", (d: string) => (err = (err + d).slice(-2000)));
    tar.on("error", (e) => reject(new InstallError("extract", `tar cannot run (${e.message})`)));
    tar.on("exit", (code) => (code === 0 ? resolve() : reject(new InstallError("extract", `tar failed (${code}): ${err.trim().split("\n").pop() ?? ""}`))));
  });
}

/** A fresh temp folder next to `place`, on the same disk so the final rename is one step. */
function stage(place: string): string {
  const dir = `${place}.part-${randomBytes(4).toString("hex")}`;
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Puts `from` where `place` is, replacing what was there. */
function swapIn(from: string, place: string): void {
  const old = existsSync(place) ? `${place}.old-${randomBytes(4).toString("hex")}` : undefined;
  if (old) renameSync(place, old);
  try {
    renameSync(from, place);
  } catch (e) {
    if (old) renameSync(old, place);
    throw e;
  }
  if (old) rmSync(old, { recursive: true, force: true });
}

/** Leftovers of downloads a stopped hub never finished. */
export function sweepPartial(dir: string): void {
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) if (/\.(part|old)-[0-9a-f]{8}$/.test(name)) rmSync(join(dir, name), { recursive: true, force: true });
}

// ---------- the runtime: npm packages side by side in <runtime>/node_modules ----------

const MARKER = "installed.json";

/** Whether `root` holds exactly these packages (the marker is written last, after every package is in place). */
export function runtimeInstalled(root: string, pkgs: RuntimePackage[] | undefined): boolean {
  if (!pkgs) return false;
  try {
    const have = JSON.parse(readFileSync(join(root, MARKER), "utf8")) as { packages?: unknown };
    const want = pkgs.map((p) => `${p.name}@${p.version}`);
    return Array.isArray(have.packages) && want.every((w) => (have.packages as unknown[]).includes(w)) && pkgs.every((p) => existsSync(join(root, "node_modules", p.name, "package.json")));
  } catch {
    return false;
  }
}

/** Downloads, checks and unpacks every package, then swaps the whole runtime folder in; progress counts all of them. */
export async function installRuntime(root: string, pkgs: RuntimePackage[], registry: string, onProgress?: (p: Progress) => void, signal?: AbortSignal): Promise<void> {
  const total = pkgs.reduce((n, p) => n + p.size, 0);
  const tmp = stage(root);
  try {
    let done = 0;
    for (const p of pkgs) {
      const tgz = join(tmp, `${p.name}.tgz`);
      await download(tarballUrl(registry, p), tgz, { size: p.size, integrity: p.integrity }, (x) => onProgress?.({ received: done + x.received, total }), signal);
      done += p.size;
      // npm tarballs keep everything under package/.
      await extract(tgz, join(tmp, "node_modules", p.name));
      rmSync(tgz, { force: true });
      if (!existsSync(join(tmp, "node_modules", p.name, "package.json"))) throw new InstallError("extract", `${p.name} has no package.json`);
    }
    writeFileSync(join(tmp, MARKER), JSON.stringify({ packages: pkgs.map((p) => `${p.name}@${p.version}`), at: new Date().toISOString() }, null, 2));
    swapIn(tmp, root);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------- models: <models>/<id>/ with the files the engine needs ----------

export function modelInstalled(dir: string, m: ModelSpec): boolean {
  return m.files.every((f) => existsSync(join(dir, f)));
}

/** Downloads, checks and unpacks a model archive into `dir` (its own folder). */
export async function installModel(dir: string, m: ModelSpec, releases: string, onProgress?: (p: Progress) => void, signal?: AbortSignal): Promise<void> {
  const tmp = stage(dir);
  try {
    const archive = join(tmp, "model.tar.bz2");
    await download(modelUrl(releases, m), archive, { size: m.size, sha256: m.sha256 }, onProgress, signal);
    const out = join(tmp, "model");
    await extract(archive, out);
    const missing = m.files.find((f) => !existsSync(join(out, f)));
    if (missing) throw new InstallError("extract", `${m.asset} has no ${missing}`);
    swapIn(out, dir);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
