// node.update: the daemon's single file is replaced by the hub's version only when it matches and runs.
import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyUpdate } from "../src/self-update.ts";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "owl-node-update-"));
  const file = join(dir, "piomio-node.mjs");
  writeFileSync(file, "console.log('0.2.3')\n");
  // ESM, as the real bundle: a file Node read as CommonJS would not run.
  const bundle = Buffer.from("import { argv } from 'node:process';\nif (argv[2] === '--version') console.log('0.2.4');\n");
  return { file, bundle, update: { version: "0.2.4", sha256: sha(bundle), bundle: bundle.toString("base64") } };
}

describe("node.update", () => {
  it("swaps in the new file, keeps the old one and restarts", async () => {
    const { file, update } = setup();
    const restart = vi.fn();
    vi.useFakeTimers();
    try {
      // The real check: the new file runs with this Node and says its version.
      expect(await applyUpdate(update, { file, restart })).toEqual({ restarting: true });
      vi.advanceTimersByTime(500);
    } finally {
      vi.useRealTimers();
    }
    expect(readFileSync(file, "utf8")).toContain("0.2.4");
    expect(readFileSync(`${file}.prev`, "utf8")).toContain("0.2.3");
    expect(existsSync(file.replace(/\.mjs$/, ".next.mjs"))).toBe(false);
    expect(restart).toHaveBeenCalledOnce();
  });

  it("keeps the daemon as it is for a wrong checksum, another version or a file that does not run", async () => {
    for (const change of [
      (u: any) => ({ ...u, sha256: "0".repeat(64) }),
      (u: any) => ({ ...u, version: "0.2.5" }),
      () => {
        const b = Buffer.from("throw new Error('broken')\n");
        return { version: "0.2.4", sha256: sha(b), bundle: b.toString("base64") };
      },
    ]) {
      const { file, update } = setup();
      const restart = vi.fn();
      await expect(applyUpdate(change(update), { file, restart })).rejects.toThrow();
      expect(readFileSync(file, "utf8")).toContain("0.2.3");
      expect(existsSync(file.replace(/\.mjs$/, ".next.mjs")) || existsSync(`${file}.prev`)).toBe(false);
      expect(restart).not.toHaveBeenCalled();
    }
  });

  it("refuses when the daemon is not the single-file download", async () => {
    await expect(applyUpdate(setup().update)).rejects.toThrow("does not replace itself");
  });
});
