// Builds the Piomio desktop app (packages/desktop, Tauri) and its installers on this OS:
//   npm run package:desktop [-- --skip-build] [-- --skip-stage] [-- --test]
// macOS:   dist/desktop/piomio-<version>.dmg (drag to Applications) and piomio-<version>.pkg (silent installs).
//          Universal: needs the aarch64-apple-darwin and x86_64-apple-darwin Rust targets.
// Windows: dist/desktop/piomio-setup-<version>-x64.exe (NSIS, per user; /S silent, /NOSTART).
// Updates (the app installs them from the latest GitHub release, src-tauri/src/update.rs): with the project's signing
// key (TAURI_SIGNING_PRIVATE_KEY, or ~/.tauri/piomio.key on a release machine) also piomio-<version>-mac.app.tar.gz
// and the Windows installer, each with a .sig; release.yml lists them in latest.json. Without the key, none.
// --test builds "Piomio Test" (ai.piomio.test, piomio-test://) instead: it installs next to the app with its own data,
// node pairing, start-at-login entry and ports (41790...), and says so in its windows and tray. Disk image or Windows
// installer only (piomio-test-<version>.dmg, piomio-test-setup-<version>-x64.exe), no .pkg.
// Developer ID (packaging/macos/sign.mjs): with APPLE_SIGNING_IDENTITY the Mac app, its binaries and the disk image
// are signed for Gatekeeper, and with the notary sign-in (APPLE_ID…) notarized and stapled; APPLE_INSTALLER_IDENTITY
// signs the .pkg too. Without them the app is signed ad hoc and macOS asks before opening it.
// The staged hub (stage.mjs) is the app's resource "app".

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ROOT, VERSION, npm, run, stage } from "./stage.mjs";
import { loadCatalogs } from "./locales.mjs";
import { buildPkg } from "../macos/pkg.mjs";
import { canNotarize, installerIdentity, notarize, signNested, signingIdentity, tauriEnv } from "../macos/sign.mjs";
import { nsisHooks } from "../windows/generate.mjs";

const mac = process.platform === "darwin";
if (!mac && process.platform !== "win32") throw new Error("package:desktop runs on macOS or Windows");
const OUT = join(ROOT, "dist", "desktop");
const TAURI = join(ROOT, "packages", "desktop", "src-tauri");
const target = mac ? "darwin" : "win-x64";

const { values } = parseArgs({ options: { "skip-build": { type: "boolean" }, "skip-stage": { type: "boolean" }, test: { type: "boolean" } } });
const test = !!values.test;
const product = test ? "Piomio Test" : "Piomio";
const file = test ? "piomio-test" : "piomio";
const app = values["skip-stage"] ? join(OUT, `stage-${target}`, "app") : await stage({ target, skipBuild: !!values["skip-build"] });
if (!existsSync(join(app, "packaging", "desktop", "launch.mjs"))) throw new Error(`no staged app in ${app}`);
npm(["run", "build:ui", "-w", "@piomio/desktop"], { cwd: ROOT });

const build = join(OUT, mac ? "build-mac" : "build-win");
rmSync(build, { recursive: true, force: true });
mkdirSync(build, { recursive: true });
// A mapped folder keeps its layout under the target (tauri-utils walks it).
const resources = { [app]: "app" };
const config = { bundle: { resources } };
if (test) {
  Object.assign(config, { productName: product, mainBinaryName: product, identifier: "ai.piomio.test", plugins: { "deep-link": { desktop: { schemes: ["piomio-test"] } } } });
}
const identity = mac ? signingIdentity() : "";
if (mac) {
  // For package installs; the test build has none.
  if (!test) resources[join(ROOT, "packaging", "macos", "uninstall.sh")] = "uninstall.sh";
  if (identity) {
    // Our binaries are signed before Tauri copies them in; Tauri signs the app with the hardened runtime and, given
    // the notary sign-in in the environment, notarizes and staples it before it makes the disk image and the update.
    signNested(app, identity);
    config.bundle.macOS = { signingIdentity: identity, hardenedRuntime: true };
    if (!canNotarize()) console.log("no notary sign-in (APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID): signed, not notarized");
  } else console.log("no Developer ID (APPLE_SIGNING_IDENTITY): the app is signed ad hoc");
} else {
  const hooks = join(build, "nsis-hooks.nsh");
  writeFileSync(hooks, nsisHooks(loadCatalogs(), product));
  config.bundle.windows = { nsis: { installerHooks: hooks } };
}
// The test build is not updated from the releases, only from a feed it is pointed at (PIOMIO_UPDATE_URL), which may
// be a local one over plain http.
if (test) config.plugins.updater = { dangerousInsecureTransportProtocol: true };
const keyFile = join(homedir(), ".tauri", "piomio.key");
const signingKey = process.env.TAURI_SIGNING_PRIVATE_KEY || (existsSync(keyFile) ? readFileSync(keyFile, "utf8").trim() : "");
config.bundle.createUpdaterArtifacts = !!signingKey;
const env = tauriEnv({ ...process.env, ...(signingKey ? { TAURI_SIGNING_PRIVATE_KEY: signingKey, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "" } : {}) }, identity);
if (!test && !signingKey) console.log("no update signing key: building without update files");
const configFile = join(build, "tauri.build.json");
writeFileSync(configFile, JSON.stringify(config, null, 2));

const triple = mac ? "universal-apple-darwin" : undefined;
npm(["run", "tauri", "-w", "@piomio/desktop", "--", "build", "--config", configFile, "--bundles", mac ? "app,dmg" : "nsis", ...(triple ? ["--target", triple] : [])], { cwd: ROOT, env });

const bundle = join(TAURI, "target", ...(triple ? [triple] : []), "release", "bundle");
if (mac) {
  const dmg = join(OUT, `${file}-${VERSION}.dmg`);
  copyFileSync(join(bundle, "dmg", `${product}_${VERSION}_universal.dmg`), dmg);
  if (identity) {
    run("codesign", ["--force", "--timestamp", "--sign", identity, dmg]);
    notarize(dmg);
  }
  console.log(`disk image: ${dmg}`);
  if (!test) {
    const pkg = buildPkg({ appBundle: join(bundle, "macos", "Piomio.app"), build, out: join(OUT, `piomio-${VERSION}.pkg`), sign: identity && installerIdentity() });
    if (identity && installerIdentity()) notarize(pkg);
    console.log(`package:    ${pkg}`);
  }
  if (signingKey) {
    const update = join(OUT, `${file}-${VERSION}-mac.app.tar.gz`);
    copyFileSync(join(bundle, "macos", `${product}.app.tar.gz`), update);
    copyFileSync(join(bundle, "macos", `${product}.app.tar.gz.sig`), `${update}.sig`);
    console.log(`update:     ${update}`);
  }
} else {
  const setup = join(OUT, `${file}-setup-${VERSION}-x64.exe`);
  copyFileSync(join(bundle, "nsis", `${product}_${VERSION}_x64-setup.exe`), setup);
  if (signingKey) copyFileSync(join(bundle, "nsis", `${product}_${VERSION}_x64-setup.exe.sig`), `${setup}.sig`);
  console.log(`installer: ${setup}`);
}
