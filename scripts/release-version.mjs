// Stamp a disposable build checkout. Nothing here commits, creates a tag, or writes to a remote.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export function parseVersion(version) {
  if (typeof version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error("Expected a stable semantic version");
  const parts = version.split(".").map(Number);
  if (!parts.every(Number.isSafeInteger)) throw new Error("Invalid version number");
  return parts;
}

export function stampVersion(version, cwd = process.cwd()) {
  parseVersion(version);
  const files = new Map();
  for (const file of ["package.json", "package-lock.json", "packages/desktop/src-tauri/tauri.conf.json"]) {
    const json = JSON.parse(readFileSync(join(cwd, file), "utf8"));
    json.version = version;
    if (file === "package-lock.json") json.packages[""].version = version;
    files.set(file, JSON.stringify(json, null, 2) + "\n");
  }
  const manifest = "packages/desktop/src-tauri/Cargo.toml";
  const cargo = readFileSync(join(cwd, manifest), "utf8");
  const rootVersion = /(\[package\][\s\S]*?\nversion\s*=\s*)"[^"]+"/;
  if (!rootVersion.test(cargo)) throw new Error("Cargo package version missing");
  files.set(manifest, cargo.replace(rootVersion, `$1"${version}"`));
  const lockfile = "packages/desktop/src-tauri/Cargo.lock";
  const lock = readFileSync(join(cwd, lockfile), "utf8");
  const root = /(\[\[package\]\]\r?\nname = "piomio"\r?\nversion = )"[^"]+"/;
  if (!root.test(lock)) throw new Error("Cargo lock package missing");
  files.set(lockfile, lock.replace(root, `$1"${version}"`));
  // Validate every input before writing any of them.
  for (const [file, content] of files) writeFileSync(join(cwd, file), content);
  return [...files.keys()];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(stampVersion(process.argv[2] || process.env.RELEASE_VERSION).join("\n"));
}
