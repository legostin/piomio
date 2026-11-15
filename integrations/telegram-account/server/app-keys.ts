// The Piomio application's own Telegram API keys (my.telegram.org → API development tools): every Telegram client
// has a pair, and Telegram ties each sign-in to it. They are not in the repository. A build puts them in
// `app-keys.json` beside this integration's package.json (`npm run telegram:app-keys`, from TELEGRAM_API_ID and
// TELEGRAM_API_HASH: release builds take them from the repository's secrets); the file is git-ignored. Without it the
// integration says the build has no keys and nothing can sign in.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface AppKeys {
  apiId: number;
  apiHash: string;
}

export const APP_KEYS_FILE = "app-keys.json";

/** The keys as a build wrote them, or undefined: no file, or one that does not hold a pair. */
export function parseAppKeys(text: string): AppKeys | undefined {
  let v: any;
  try {
    v = JSON.parse(text);
  } catch {
    return undefined;
  }
  const apiId = Number(v?.apiId);
  const apiHash = typeof v?.apiHash === "string" ? v.apiHash.trim() : "";
  if (!Number.isSafeInteger(apiId) || apiId <= 0 || !/^[0-9a-f]{32}$/.test(apiHash)) return undefined;
  return { apiId, apiHash };
}

export function readAppKeys(pluginDir: string): AppKeys | undefined {
  try {
    return parseAppKeys(readFileSync(join(pluginDir, APP_KEYS_FILE), "utf8"));
  } catch {
    return undefined;
  }
}
