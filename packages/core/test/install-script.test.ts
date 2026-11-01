// The Linux server install (packaging/linux): the installer's messages in both languages, and the environment its
// launcher gives the hub.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-ignore: plain ESM helpers without type declarations
import { dataDirOf, serverEnv } from "../../../packaging/linux/start.mjs";

const dir = join(import.meta.dirname, "..", "..", "..", "packaging", "linux");
const script = readFileSync(join(dir, "install.sh"), "utf8");

describe("install.sh", () => {
  it("says everything in English and Russian", () => {
    const keys = (lang: string) => new Set([...script.matchAll(new RegExp(`^\\s+${lang}:(\\w+)\\)`, "gm"))].map((m) => m[1]));
    const en = keys("en");
    expect(en.size).toBeGreaterThan(20);
    expect([...keys("ru")].sort()).toEqual([...en].sort());
    const used = new Set([...script.matchAll(/\b(?:say|die) (\w+)/g)].map((m) => m[1]));
    for (const k of used) expect(en, k).toContain(k);
  });

  it("each message has as many %s in both languages", () => {
    for (const [, key, text] of script.matchAll(/^\s+en:(\w+)\) echo "(.*)" ;;$/gm)) {
      const ru = new RegExp(`^\\s+ru:${key}\\) echo "(.*)" ;;$`, "m").exec(script)?.[1] ?? "";
      expect(ru.split("%s").length, key).toBe(text.split("%s").length);
    }
  });
});

describe("the server launcher's environment", () => {
  it("gives the hub the user's home and PATH, the server ports and the install root", () => {
    const env = serverEnv({ PATH: "/usr/bin" }, "/home/p/.local/share/piomio", "/home/p");
    expect(env).toMatchObject({
      PIOMIO_PORT: "8080",
      PIOMIO_PUBLIC_URL: "http://localhost:8080",
      PIOMIO_INSTALL_CLIS: "1",
      PIOMIO_BRAIN_HOME: "/home/p",
      PIOMIO_INSTALL_ROOT: "/home/p/.local/lib/piomio",
      PIOMIO_DATA_DIR: "/home/p/.local/share/piomio",
    });
    expect(env.NODE_OPTIONS).toContain("resolve.mjs");
    expect(env.DISABLE_AUTOUPDATER).toBeUndefined();
  });

  it("lets the settings file win", () => {
    const env = serverEnv({ PIOMIO_PORT: "9090", PIOMIO_BRAIN_HOME: "/srv/brains" }, "/d", "/home/p");
    expect(env).toMatchObject({ PIOMIO_PORT: "9090", PIOMIO_PUBLIC_URL: "http://localhost:9090", PIOMIO_BRAIN_HOME: "/srv/brains" });
    expect(dataDirOf({ XDG_DATA_HOME: "/x" }, "/home/p")).toBe("/x/piomio");
    expect(dataDirOf({}, "/home/p")).toBe("/home/p/.local/share/piomio");
  });
});
