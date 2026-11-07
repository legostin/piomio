// A per-OS-user identity shared by the hub and node, independent of installation/version.
// Prove possession over the fresh node authentication challenge; a hostname or a claimed id is never proof.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, lstatSync, linkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface HostIdentity {
  id: string;
  proof(nonce: string): string;
  verifies(nonce: string, proof: unknown): boolean;
}
export function hostIdentity(dir = process.env.PIOMIO_HOST_IDENTITY_DIR ?? join(homedir(), ".local", "share", "piomio", "host-identity")): HostIdentity {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, "key");
  // Publish the complete key atomically: concurrent hub/node starts must never read a half-written key.
  if (!lstatSync(file, { throwIfNoEntry: false })) {
    const temp = join(dir, `key-${randomBytes(12).toString("hex")}`);
    writeFileSync(temp, randomBytes(32), { flag: "wx", mode: 0o600 });
    try { linkSync(temp, file); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
    finally { unlinkSync(temp); }
  }
  const stat = lstatSync(file);
  if (!stat.isFile() || (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) throw new Error("Unsafe host identity key");
  const key = readFileSync(file);
  if (key.length !== 32) throw new Error("Invalid host identity key");
  const proof = (nonce: string) => createHmac("sha256", key).update(`piomio-same-host:${nonce}`).digest("base64url");
  return { id: proof("identity"), proof, verifies: (nonce, candidate) => {
    if (typeof candidate !== "string") return false;
    const a = Buffer.from(proof(nonce)); const b = Buffer.from(candidate);
    return a.length === b.length && timingSafeEqual(a, b);
  } };
}
