// The silent macOS package around the desktop app: the same Piomio.app into /Applications, for installs over SSH
// or MDM (`sudo installer -pkg piomio-<version>.pkg -target /`). pkgbuild and productbuild ship with macOS.

import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { VERSION, run } from "../desktop/stage.mjs";
import { LOCALES, loadCatalogs } from "../desktop/locales.mjs";
import { PKG_ID, distributionXml, installerPage } from "./generate.mjs";

const HERE = import.meta.dirname;

/** Builds `out` from `appBundle`, using `build` as a scratch folder; `sign`, a Developer ID Installer identity, signs
 * it. Returns `out`. */
export function buildPkg({ appBundle, build, out, sign = "" }) {
  const root = join(build, "pkg-root");
  mkdirSync(join(root, "Applications"), { recursive: true });
  // A clone on APFS: no extra space.
  run("cp", ["-cRp", appBundle, join(root, "Applications")]);

  // The app stays where it is installed: a relocatable bundle would be "upgraded" wherever the user moved a copy.
  const comp = join(build, "component.plist");
  run("pkgbuild", ["--analyze", "--root", root, comp]);
  const bundles = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", comp], { encoding: "utf8" }));
  for (const b of bundles) Object.assign(b, { BundleIsRelocatable: false, BundleIsVersionChecked: false, BundleHasStrictIdentifier: false, BundleOverwriteAction: "upgrade" });
  writeFileSync(comp + ".json", JSON.stringify(bundles));
  run("plutil", ["-convert", "xml1", "-o", comp, comp + ".json"]);

  const scripts = join(build, "pkg-scripts");
  mkdirSync(scripts, { recursive: true });
  for (const f of readdirSync(join(HERE, "scripts"))) {
    copyFileSync(join(HERE, "scripts", f), join(scripts, f));
    chmodSync(join(scripts, f), 0o755);
  }
  const componentPkg = "piomio-app.pkg";
  run("pkgbuild", ["--root", root, "--install-location", "/", "--identifier", PKG_ID, "--version", VERSION, "--scripts", scripts, "--component-plist", comp, join(build, componentPkg)]);

  // Product archive with the English and Russian Installer pages.
  const resources = join(build, "pkg-resources");
  const catalogs = loadCatalogs();
  for (const locale of LOCALES) {
    const dir = join(resources, `${locale}.lproj`);
    mkdirSync(dir, { recursive: true });
    for (const page of ["welcome", "conclusion"]) writeFileSync(join(dir, `${page}.html`), installerPage(catalogs, locale, page));
  }
  const distribution = join(build, "distribution.xml");
  writeFileSync(distribution, distributionXml({ version: VERSION, componentPkg }));
  run("productbuild", ["--distribution", distribution, "--resources", resources, "--package-path", build, ...(sign ? ["--sign", sign, "--timestamp"] : []), out]);
  return out;
}
