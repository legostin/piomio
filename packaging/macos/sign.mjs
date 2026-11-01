// Developer ID signing and notarization for the macOS app, when this machine holds the project's identity
// (APPLE_SIGNING_IDENTITY, "Developer ID Application: <name> (<team>)"; desktop.yml imports it from the
// APPLE_CERTIFICATE secret). Apple's notary checks every binary in the bundle, so the ones we build (the Tailscale
// node) are signed here, with the hardened runtime and a timestamp, before Tauri seals the app; Node's binaries keep
// Node's own Developer ID signature. Tauri signs the app and notarizes it with the sign-in below; notarize() does the
// disk image and the package. Without an identity nothing here runs and the app is signed ad hoc, as for forks.
//   Sign-in for the notary, from the environment (Tauri reads the same variables):
//   APPLE_ID + APPLE_PASSWORD (an app-specific password) + APPLE_TEAM_ID, or APPLE_API_KEY + APPLE_API_ISSUER +
//   APPLE_API_KEY_PATH (an App Store Connect key).

import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, openSync, readSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { run } from "../desktop/stage.mjs";

export function signingIdentity() {
  return process.env.APPLE_SIGNING_IDENTITY || "";
}

/** A package can be signed only with a "Developer ID Installer" identity; without one it stays unsigned. */
export function installerIdentity() {
  return process.env.APPLE_INSTALLER_IDENTITY || "";
}

function notaryAuth() {
  const e = process.env;
  if (e.APPLE_API_KEY && e.APPLE_API_ISSUER && e.APPLE_API_KEY_PATH) return ["--key", e.APPLE_API_KEY_PATH, "--key-id", e.APPLE_API_KEY, "--issuer", e.APPLE_API_ISSUER];
  if (e.APPLE_ID && e.APPLE_PASSWORD && e.APPLE_TEAM_ID) return ["--apple-id", e.APPLE_ID, "--password", e.APPLE_PASSWORD, "--team-id", e.APPLE_TEAM_ID];
  return null;
}

export function canNotarize() {
  return !!notaryAuth();
}

const THIN = new Set(["feedface", "feedfacf", "cefaedfe", "cffaedfe"]);

/** Mach-O by its first bytes. 0xcafebabe is also a Java class file; a universal binary has a small arch count there. */
function isMachO(file) {
  const fd = openSync(file, "r");
  try {
    const b = Buffer.alloc(8);
    const n = readSync(fd, b, 0, 8, 0);
    if (n < 4) return false;
    const magic = b.subarray(0, 4).toString("hex");
    return THIN.has(magic) || (magic === "cafebabe" && n === 8 && b.readUInt32BE(4) < 32);
  } finally {
    closeSync(fd);
  }
}

/** Every Mach-O file under `dir` (symbolic links are left alone: they point inside the bundle). */
export function machOFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...machOFiles(p));
    else if (e.isFile() && isMachO(p)) out.push(p);
  }
  return out;
}

/** What codesign says about a file (it writes to stderr): signed by a Developer ID, with the runtime and a timestamp. */
function notarizable(file) {
  const info = spawnSync("codesign", ["-dv", "--verbose=2", file], { encoding: "utf8" }).stderr ?? "";
  return /^Authority=Developer ID Application: /m.test(info) && /flags=0x[0-9a-f]+\([^)]*\bruntime\b/.test(info) && /^Timestamp=/m.test(info);
}

/** Signs the binaries under `dir` that the notary would refuse; ones already signed for it (Node's) are kept. */
export function signNested(dir, identity) {
  for (const file of machOFiles(dir)) {
    if (notarizable(file)) console.log(`signed already: ${file}`);
    else run("codesign", ["--force", "--options", "runtime", "--timestamp", "--sign", identity, file]);
  }
}

/** Sends a disk image or a package to Apple's notary service, waits for the verdict, and staples the ticket to it. */
export function notarize(file) {
  const auth = notaryAuth();
  if (!auth) return false;
  // Not run(): it prints the command, and the command holds the password.
  console.log(`$ xcrun notarytool submit ${file} --wait`);
  const out = execFileSync("xcrun", ["notarytool", "submit", file, "--wait", "--output-format", "json", ...auth], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  const { id, status } = JSON.parse(out);
  if (status !== "Accepted") {
    spawnSync("xcrun", ["notarytool", "log", id, ...auth], { stdio: "inherit" });
    throw new Error(`notarization of ${file}: ${status} (submission ${id})`);
  }
  run("xcrun", ["stapler", "staple", file]);
  return true;
}
