// A new built-in integration from the template: integrations/_template → integrations/<id>, with the id, the npm name
// and the test file renamed. Everything after that happens in that one folder (see integrations/README.md).
// Usage: npm run new:integration -- <id>

import { cpSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const root = resolve(import.meta.dirname, "..");
const id = process.argv[2] ?? "";
if (!/^[a-z][a-z0-9-]{1,40}$/.test(id)) {
  console.error("Usage: npm run new:integration -- <id>   (lowercase letters, digits and dashes, e.g. air-quality)");
  process.exit(1);
}
const template = join(root, "integrations", "_template");
const target = join(root, "integrations", id);
if (existsSync(target)) {
  console.error(`integrations/${id} already exists`);
  process.exit(1);
}

// The skill's own page, built output and installed packages stay behind.
cpSync(template, target, {
  recursive: true,
  filter: (src) => {
    const rel = relative(template, src).split(sep).join("/");
    return rel !== "SKILL.md" && rel !== "ui/dist" && !rel.split("/").includes("node_modules");
  },
});
renameSync(join(target, "test", "sun.test.ts"), join(target, "test", `${id}.test.ts`));

const edit = (file, fn) => writeFileSync(file, `${JSON.stringify(fn(JSON.parse(readFileSync(file, "utf8"))), null, 2)}\n`);
const name = id.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
edit(join(target, ".piomio-plugin", "plugin.json"), (m) => ({ ...m, id }));
edit(join(target, "package.json"), (p) => ({ ...p, name: `@piomio/plugin-${id}`, description: name }));
for (const locale of ["en", "ru"]) edit(join(target, ".piomio-plugin", "locales", `${locale}.json`), (l) => ({ ...l, name }));

console.log(`integrations/${id} is ready: it still does sunrise and sunset. Make it yours:
  1. .piomio-plugin/plugin.json: the catalog card, permissions, widgets
  2. .piomio-plugin/locales/{en,ru}.json: the texts people read
  3. server/index.ts: the tools;  ui/src/index.tsx: the card in the chat
  4. signals: when the service has no events to start triggers, delete contributes.signals from plugin.json, the
     ctx.signals.provide("sunrise", …) provider in server/index.ts, its "signal.sunrise.title" texts and its tests
  5. test/${id}.test.ts, then: npx vitest run integrations/${id}
The guide: integrations/_template/SKILL.md. Run npm install once so the workspace links the new folder.`);
