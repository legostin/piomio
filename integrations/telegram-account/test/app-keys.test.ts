// The build step that puts the application's Telegram API keys beside the integration (scripts/telegram-app-keys.mjs):
// what it writes is what the integration reads, half a pair or a malformed one stops the build, and a build without
// the secrets carries no file.
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { APP_KEYS_PATH, writeTelegramAppKeys } from "../../../scripts/telegram-app-keys.mjs";
import { APP_KEYS_FILE, readAppKeys } from "../server/app-keys.ts";

const HASH = "0123456789abcdef0123456789abcdef";

describe("the application's Telegram keys in a build", () => {
  it("writes the pair where the integration reads it, for the build's user only", () => {
    const cwd = mkdtempSync(join(tmpdir(), "tg-app-keys-"));
    expect(APP_KEYS_PATH.endsWith(`telegram-account/${APP_KEYS_FILE}`)).toBe(true);
    expect(writeTelegramAppKeys({ TELEGRAM_API_ID: " 123456 ", TELEGRAM_API_HASH: HASH.toUpperCase() }, cwd)).toBe("written");
    expect(readAppKeys(dirname(join(cwd, APP_KEYS_PATH)))).toEqual({ apiId: 123456, apiHash: HASH });
    if (process.platform !== "win32") expect(statSync(join(cwd, APP_KEYS_PATH)).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(cwd, APP_KEYS_PATH), "utf8")).toBe(`{"apiId":123456,"apiHash":"${HASH}"}\n`);
  });

  it("writes nothing without the secrets, and takes away what an earlier run left", () => {
    const cwd = mkdtempSync(join(tmpdir(), "tg-app-keys-"));
    expect(writeTelegramAppKeys({}, cwd)).toBe("skipped");
    expect(existsSync(join(cwd, APP_KEYS_PATH))).toBe(false);
    writeTelegramAppKeys({ TELEGRAM_API_ID: "5", TELEGRAM_API_HASH: HASH }, cwd);
    expect(writeTelegramAppKeys({ TELEGRAM_API_ID: "", TELEGRAM_API_HASH: "" }, cwd)).toBe("skipped");
    expect(existsSync(join(cwd, APP_KEYS_PATH))).toBe(false);
    expect(readAppKeys(dirname(join(cwd, APP_KEYS_PATH)))).toBeUndefined();
  });

  it("stops on half a pair or one that is not what my.telegram.org gives", () => {
    const cwd = mkdtempSync(join(tmpdir(), "tg-app-keys-"));
    for (const env of [{ TELEGRAM_API_ID: "5" }, { TELEGRAM_API_HASH: HASH }, { TELEGRAM_API_ID: "abc", TELEGRAM_API_HASH: HASH }, { TELEGRAM_API_ID: "0", TELEGRAM_API_HASH: HASH }, { TELEGRAM_API_ID: "5", TELEGRAM_API_HASH: "nope" }]) {
      expect(() => writeTelegramAppKeys(env, cwd)).toThrow();
    }
    expect(existsSync(join(cwd, APP_KEYS_PATH))).toBe(false);
  });
});
