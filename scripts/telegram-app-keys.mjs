// Put the Piomio application's Telegram API keys into a build: TELEGRAM_API_ID and TELEGRAM_API_HASH (from
// my.telegram.org → API development tools) become integrations/telegram-account/app-keys.json, which the Telegram
// account integration reads and the installers carry. The file is git-ignored: the keys are never committed. Release
// builds take them from the repository's secrets; without them (a fork, a pull request) nothing is written and that
// build's integration says it has no keys. Nothing here prints a key.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const APP_KEYS_PATH = "integrations/telegram-account/app-keys.json";

/** "written", or "skipped" when neither is given (any file from an earlier run is removed). Half a pair or a bad one throws. */
export function writeTelegramAppKeys(env = process.env, cwd = ROOT) {
  const id = String(env.TELEGRAM_API_ID ?? "").trim();
  const hash = String(env.TELEGRAM_API_HASH ?? "").trim().toLowerCase();
  const file = join(cwd, APP_KEYS_PATH);
  if (!id && !hash) {
    rmSync(file, { force: true });
    return "skipped";
  }
  if (!id || !hash) throw new Error("Set both TELEGRAM_API_ID and TELEGRAM_API_HASH");
  if (!/^[1-9]\d{0,14}$/.test(id)) throw new Error("TELEGRAM_API_ID must be the number my.telegram.org shows as api_id");
  if (!/^[0-9a-f]{32}$/.test(hash)) throw new Error("TELEGRAM_API_HASH must be the 32 hex characters my.telegram.org shows as api_hash");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ apiId: Number(id), apiHash: hash }) + "\n", { mode: 0o600 });
  return "written";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const done = writeTelegramAppKeys();
    console.log(done === "written" ? `Telegram application keys written to ${APP_KEYS_PATH}` : "No TELEGRAM_API_ID / TELEGRAM_API_HASH: this build has no Telegram application keys");
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
