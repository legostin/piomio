// Stages the app tree the desktop installers and the Linux server archives ship: the hub's runtime files, production
// node_modules and the official Node runtime (checked against the release's SHASUMS256.txt).
//   node packaging/desktop/stage.mjs --target win-x64|darwin|linux-x64|linux-arm64 [--skip-build]
// Output: dist/desktop/stage-<target>/app (Windows: runtime/node.exe; macOS: runtime/arm64 and runtime/x64; Linux:
// runtime/bin/node and packaging/linux, see packaging/linux/build.mjs).

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

export const ROOT = resolve(import.meta.dirname, "..", "..");
/** Node 24 LTS shipped inside the installers; NODE_VERSION overrides it. */
export const NODE_VERSION = process.env.NODE_VERSION || "24.16.0";
export const VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;

/** The hub's Tailscale node (packages/tailnet, Go) for every architecture the target runs on. */
export const TAILNET_TARGETS = { "win-x64": ["win32-x64"], darwin: ["darwin-arm64", "darwin-x64"], "linux-x64": ["linux-x64"], "linux-arm64": ["linux-arm64"] };

const NODE_DISTS = {
  "win-x64": [{ file: `node-v${NODE_VERSION}-win-x64.zip`, into: "runtime" }],
  darwin: [
    { file: `node-v${NODE_VERSION}-darwin-arm64.tar.gz`, into: "runtime/arm64" },
    { file: `node-v${NODE_VERSION}-darwin-x64.tar.gz`, into: "runtime/x64" },
  ],
  "linux-x64": [{ file: `node-v${NODE_VERSION}-linux-x64.tar.gz`, into: "runtime" }],
  "linux-arm64": [{ file: `node-v${NODE_VERSION}-linux-arm64.tar.gz`, into: "runtime" }],
};

/** What runs in an installed app; tests, sources of the built UIs and dev configs stay behind. */
export function wanted(src) {
  const rel = relative(ROOT, src).split(sep).join("/");
  if (rel === "") return true;
  const parts = rel.split("/");
  if (parts.includes("node_modules")) return false;
  const [top, pkg, sub] = parts;
  // The integration template is the agents' make-integration skill: it ships whole, sources and test included.
  if (top === "integrations" && pkg === "_template") return true;
  if (parts.includes("test") || parts.includes("e2e")) return false;
  if (/\.test\.[cm]?[jt]sx?$/.test(rel)) return false;
  if (top === "packages" && (pkg === "web" || pkg === "console" || pkg === "pages-kit") && sub && sub !== "dist" && sub !== "package.json") return false;
  if ((top === "plugins" || top === "integrations") && sub === "ui" && parts[3] === "src") return false;
  // The desktop app is built around the stage; its manifest stays so `npm ci` finds the workspace.
  if (top === "packages" && pkg === "desktop" && sub && sub !== "package.json") return false;
  // The Tailscale node's Go sources stay behind; stage() copies the target's binaries.
  if (top === "packages" && pkg === "tailnet" && sub) return false;
  return true;
}

export function run(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { stdio: "inherit", ...opts });
}

/** npm through the Node running this script (no shell, which npm.cmd would need on Windows). */
export function npm(args, opts = {}) {
  const dir = dirname(process.execPath);
  const cli = [join(dir, "node_modules", "npm", "bin", "npm-cli.js"), join(dir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")].find((f) => existsSync(f));
  if (!cli) throw new Error("npm-cli.js not found next to this Node");
  run(process.execPath, [cli, ...args], opts);
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

async function download(url, to) {
  console.log(`download ${url}`);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to + ".part", Buffer.from(await r.arrayBuffer()));
  renameSync(to + ".part", to);
}

/** The official Node build, from the cache when its checksum still matches the release's list. */
async function nodeArchive(cache, file) {
  const sums = join(cache, `SHASUMS256-v${NODE_VERSION}.txt`);
  const base = `https://nodejs.org/dist/v${NODE_VERSION}`;
  if (!existsSync(sums)) await download(`${base}/SHASUMS256.txt`, sums);
  const expected = readFileSync(sums, "utf8")
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .find(([, name]) => name === file)?.[0];
  if (!expected) throw new Error(`${file} is not in Node ${NODE_VERSION}'s SHASUMS256.txt`);
  const archive = join(cache, file);
  if (!existsSync(archive) || sha256(archive) !== expected) await download(`${base}/${file}`, archive);
  if (sha256(archive) !== expected) throw new Error(`${file}: checksum mismatch`);
  return archive;
}

function extract(archive, into) {
  const tmp = into + ".tmp";
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  // Windows' own bsdtar reads zip; Git's GNU tar on the PATH would not.
  const tar = process.platform === "win32" ? join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar";
  run(tar, ["-xf", archive, "-C", tmp]);
  const [top] = readdirSync(tmp);
  rmSync(into, { recursive: true, force: true });
  mkdirSync(dirname(into), { recursive: true });
  renameSync(join(tmp, top), into);
  rmSync(tmp, { recursive: true, force: true });
  // Not needed to run the hub or npm (the hub calls npm-cli.js directly: packages/core/src/cli-tools.ts). bin/npm and
  // bin/npx are links, which the Tauri bundler would copy as broken files.
  for (const extra of ["include", "share", "CHANGELOG.md", "README.md", "install_tools.bat", "corepack", "corepack.cmd", join("node_modules", "corepack"), join("lib", "node_modules", "corepack"), join("bin", "corepack"), join("bin", "npm"), join("bin", "npx")]) {
    rmSync(join(into, extra), { recursive: true, force: true });
  }
}

/**
 * npm links the workspaces into node_modules. The installed app finds them through resolve.mjs instead (installers
 * carry no links, and Windows junctions are not followed under its redirection guard), so the links go.
 */
export function removeLinks(app) {
  let removed = 0;
  const nm = join(app, "node_modules");
  if (!existsSync(nm)) return 0;
  for (const e of readdirSync(nm)) {
    const entries = e.startsWith("@") ? readdirSync(join(nm, e)).map((s) => join(e, s)) : [e];
    for (const name of entries) {
      const at = join(nm, name);
      if (!lstatSync(at).isSymbolicLink()) continue;
      rmSync(at, { recursive: true, force: true }); // the link itself, never its target
      removed++;
    }
  }
  return removed;
}

/**
 * Links whose target is gone: node_modules/.bin entries of the removed workspace links, and Node's bin/corepack
 * (rmSync leaves a dangling link alone). codesign refuses a bundle that has one.
 */
export function removeDanglingLinks(dir) {
  let removed = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const at = join(dir, e.name);
    if (e.isSymbolicLink()) {
      if (!existsSync(at)) {
        unlinkSync(at);
        removed++;
      }
    } else if (e.isDirectory()) {
      removed += removeDanglingLinks(at);
    }
  }
  return removed;
}

export async function stage({ target, skipBuild = false }) {
  if (!NODE_DISTS[target]) throw new Error(`unknown target ${target} (${Object.keys(NODE_DISTS).join(", ")})`);
  if (!skipBuild) {
    npm(["run", "build"], { cwd: ROOT });
    run(process.execPath, [join(ROOT, "scripts", "build-tailnet.mjs"), ...TAILNET_TARGETS[target].flatMap((t) => ["--target", t])], { cwd: ROOT });
  }
  const out = join(ROOT, "dist", "desktop");
  const app = join(out, `stage-${target}`, "app");
  rmSync(dirname(app), { recursive: true, force: true });
  mkdirSync(app, { recursive: true });

  for (const f of ["package.json", "package-lock.json"]) cpSync(join(ROOT, f), join(app, f));
  for (const d of ["agents", "packages", "plugins", "integrations"]) cpSync(join(ROOT, d), join(app, d), { recursive: true, filter: wanted });
  for (const f of ["launch.mjs", "resolve.mjs"]) cpSync(join(ROOT, "packaging", "desktop", f), join(app, "packaging", "desktop", f));
  if (target.startsWith("linux-")) for (const f of ["start.mjs", "piomio", "install.sh"]) cpSync(join(ROOT, "packaging", "linux", f), join(app, "packaging", "linux", f));
  for (const need of ["packages/web/dist/index.html", "packages/console/dist/index.html", "packages/pages-kit/dist/kit.js", "packages/node/dist/piomio-node.mjs"]) {
    if (!existsSync(join(app, need))) throw new Error(`${need} is missing: run npm run build`);
  }
  for (const t of TAILNET_TARGETS[target]) {
    const from = join(ROOT, "packages", "tailnet", "bin", t);
    if (!existsSync(from)) throw new Error(`packages/tailnet/bin/${t} is missing: run npm run build:tailnet -- --target ${t}`);
    cpSync(from, join(app, "packages", "tailnet", "bin", t), { recursive: true });
  }

  npm(["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: app });
  const links = removeLinks(app);
  rmSync(join(app, "package-lock.json"), { force: true });

  const cache = join(out, "cache");
  for (const { file, into } of NODE_DISTS[target]) extract(await nodeArchive(cache, file), join(app, into));
  removeDanglingLinks(app);
  writeFileSync(join(app, "desktop-version.json"), JSON.stringify({ version: VERSION, node: NODE_VERSION }, null, 2) + "\n");
  console.log(`staged ${target}: ${app} (${links} workspace links removed, Node ${NODE_VERSION})`);
  return app;
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { target: { type: "string" }, "skip-build": { type: "boolean" } } });
  await stage({ target: values.target ?? (process.platform === "darwin" ? "darwin" : "win-x64"), skipBuild: !!values["skip-build"] });
}
