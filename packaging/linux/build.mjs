// Builds the Linux server's release archive, which packaging/linux/install.sh installs and a hub installed with it
// updates to (packages/core/src/self-update.ts):
//   node packaging/linux/build.mjs --arch x64|arm64 [--skip-build]
// Output in dist/linux: piomio-<version>-linux-<arch>.tar.gz (one folder, piomio-<version>, with the staged hub, its
// Node and the tailnet binary), its .sha256 for install.sh and, with the update signing key
// (TAURI_SIGNING_PRIVATE_KEY, or ~/.tauri/piomio.key on a release machine), its minisign .sig for the hubs.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { ROOT, VERSION, run, stage } from "../desktop/stage.mjs";

const { values } = parseArgs({ options: { arch: { type: "string" }, "skip-build": { type: "boolean" } } });
const arch = values.arch ?? (process.arch === "arm64" ? "arm64" : "x64");
if (arch !== "x64" && arch !== "arm64") throw new Error(`--arch x64 or arm64, not ${arch}`);

const app = await stage({ target: `linux-${arch}`, skipBuild: !!values["skip-build"] });
for (const f of ["packaging/linux/piomio", "packaging/linux/install.sh", "runtime/bin/node"]) chmodSync(join(app, f), 0o755);
const top = `piomio-${VERSION}`;
const tree = join(dirname(app), top);
rmSync(tree, { recursive: true, force: true });
renameSync(app, tree);

const out = join(ROOT, "dist", "linux");
mkdirSync(out, { recursive: true });
const archive = join(out, `piomio-${VERSION}-linux-${arch}.tar.gz`);
rmSync(archive, { force: true });
// No macOS extended attributes in an archive made on a Mac (GNU tar on Linux would warn about each).
const mac = process.platform === "darwin" ? ["--no-mac-metadata", "--no-xattrs"] : [];
run("tar", [...mac, "-czf", archive, "-C", dirname(tree), top], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
rmSync(dirname(tree), { recursive: true, force: true });
writeFileSync(`${archive}.sha256`, `${createHash("sha256").update(readFileSync(archive)).digest("hex")}  ${basename(archive)}\n`);

const keyFile = join(homedir(), ".tauri", "piomio.key");
const key = process.env.TAURI_SIGNING_PRIVATE_KEY || (existsSync(keyFile) ? readFileSync(keyFile, "utf8").trim() : "");
if (key) {
  const tauri = join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "tauri.cmd" : "tauri");
  // The key goes in the environment, never on a command line or in the log.
  execFileSync(tauri, ["signer", "sign", archive], {
    stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, TAURI_SIGNING_PRIVATE_KEY: key, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "" },
  });
  if (!existsSync(`${archive}.sig`)) throw new Error("tauri signer wrote no signature");
} else console.log("no update signing key: the archive has no .sig, so hubs can install it but won't update to it");
console.log(`built ${archive}`);
