// Minisign checks for the server install's update archives. The fixture is signed with a throwaway key
// (`tauri signer generate` + `tauri signer sign`), in Tauri's base64-wrapped format.
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePublicKey, parseSignature, verifyFile } from "../src/minisign.ts";
import { UPDATE_PUBKEY } from "../src/self-update.ts";

const dir = join(import.meta.dirname, "fixtures", "minisign");
const data = join(dir, "data.txt");
const sig = readFileSync(join(dir, "data.txt.sig"), "utf8");
const pub = readFileSync(join(dir, "key.pub"), "utf8");

describe("minisign", () => {
  it("accepts a file signed with the key", async () => {
    expect(parseSignature(sig).prehashed).toBe(true);
    expect(await verifyFile(data, sig, pub)).toBe(true);
    // The unwrapped text works as well as Tauri's base64 of it.
    expect(await verifyFile(data, Buffer.from(sig, "base64").toString("utf8"), Buffer.from(pub, "base64").toString("utf8"))).toBe(true);
  });

  it("refuses a changed file, another key and a changed trusted comment", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "owl-minisign-"));
    const changed = join(tmp, "data.txt");
    writeFileSync(changed, readFileSync(data, "utf8").replace("fixture", "fixturE"));
    expect(await verifyFile(changed, sig, pub)).toBe(false);
    expect(await verifyFile(data, sig, UPDATE_PUBKEY)).toBe(false);
    const text = Buffer.from(sig, "base64").toString("utf8").replace("file:data.txt", "file:other.txt");
    expect(await verifyFile(data, text, pub)).toBe(false);
    expect(await verifyFile(data, "garbage", pub)).toBe(false);
  });

  it("the update key is the desktop app's", () => {
    const conf = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "desktop", "src-tauri", "tauri.conf.json"), "utf8"));
    expect(UPDATE_PUBKEY).toBe(conf.plugins.updater.pubkey);
    expect(parsePublicKey(UPDATE_PUBKEY).keyId.length).toBe(8);
  });
});
