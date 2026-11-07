import { describe, expect, it } from "vitest";
import { mkdtempSync, chmodSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { ed25519 } from "@noble/curves/ed25519.js";
import { hostIdentity } from "@piomio/shared/host-identity";
import { onMachine } from "@piomio/shared";
import { openDb } from "../src/db.ts";
import { EventBus } from "../src/bus.ts";
import { AuditLog } from "../src/audit.ts";
import { BrainRegistry } from "../src/brains.ts";
import { MachineHub, NODE_AUTH_PREFIX } from "../src/machines.ts";

class Socket extends EventEmitter {
  sent: any[] = [];
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.emit("close"); }
}
describe("shared host proof", () => {
  it("persists across installations and proves the challenge without sending the key", () => {
    const dir = mkdtempSync(join(tmpdir(), "identity-"));
    const first = hostIdentity(dir); const second = hostIdentity(dir);
    const foreign = hostIdentity(mkdtempSync(join(tmpdir(), "other-host-")));
    expect(first.id).toBe(second.id);
    expect(second.verifies("fresh", first.proof("fresh"))).toBe(true);
    expect(second.verifies("another", first.proof("fresh"))).toBe(false);
    expect(second.verifies("fresh", foreign.proof("fresh"))).toBe(false);
    expect(second.verifies("fresh", undefined)).toBe(false);
    expect(second.verifies("fresh", "short")).toBe(false);
  });
  it("refuses unsafe key files and symlinks", () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(join(tmpdir(), "unsafe-host-"));
    hostIdentity(dir); chmodSync(join(dir, "key"), 0o644);
    expect(() => hostIdentity(dir)).toThrow("Unsafe");
    const alias = mkdtempSync(join(tmpdir(), "alias-host-"));
    symlinkSync(join(dir, "key"), join(alias, "key"));
    expect(() => hostIdentity(alias)).toThrow("Unsafe");
  });
  it("unifies only authenticated same-host executors and retains executor ids after restart", () => {
    const db = openDb(":memory:"); const bus = new EventBus(); const audit = new AuditLog(db);
    const brains = new BrainRegistry();
    const machines = new MachineHub({ db, bus, audit, brains });
    machines.here = () => ({ id: "rep_hub", name: "hub" });
    const secret = new Uint8Array(32).fill(7);
    const key = Buffer.from(ed25519.getPublicKey(secret)).toString("base64url");
    const connect = (name: string, proof: (nonce: string) => string | undefined) => {
      const id = machines.pair({ code: machines.createPairingCode().code, publicKey: key, name, info: { hostname: "same-name", os: "Linux", arch: "x64", clis: [], allowedDirs: [], nodeVersion: "24" } }).id;
      const socket = new Socket(); machines.attach(socket, "127.0.0.1");
      const nonce = socket.sent[0].nonce;
      const signature = Buffer.from(ed25519.sign(new TextEncoder().encode(NODE_AUTH_PREFIX + nonce), secret)).toString("base64url");
      socket.emit("message", JSON.stringify({ machineId: id, signature, hostProof: proof(nonce) }));
      expect(socket.sent.some((s) => s.type === "ok")).toBe(true);
      socket.close(); return id;
    };
    const local = connect("node", (nonce) => hostIdentity().proof(nonce));
    const old = connect("old", () => undefined);
    const forged = connect("forged", () => "bad-proof");
    expect(machines.canonical(local)).toBe("rep_hub");
    expect(machines.canonical(old)).toBe(old);
    expect(machines.canonical(forged)).toBe(forged);
    expect(onMachine("local", [local], "rep_hub", (id) => machines.canonical(id))).toBe(true);
    expect(onMachine(forged, [local], "rep_hub", (id) => machines.canonical(id))).toBe(false);
    const restored = new MachineHub({ db, bus, audit, brains });
    restored.here = machines.here;
    expect(restored.canonical(local)).toBe("rep_hub");
    expect(restored.list().find((m) => m.id === local)?.sameHost).toBe(true);
    db.close();
  });
});
