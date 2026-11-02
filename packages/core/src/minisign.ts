// Minisign signatures, the format the desktop app's updates are signed in (`tauri signer sign`): the server install's
// release archives carry one too, checked against the same public key before an update is unpacked.
// A signature file is "untrusted comment" + base64(alg, key id, signature) + "trusted comment" + base64(global
// signature); Tauri wraps the whole text in base64 once more. "ED" signs the BLAKE2b-512 of the data, "Ed" the data.

import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";

/** DER prefix of an Ed25519 SubjectPublicKeyInfo; the raw 32-byte key follows. */
const ED25519_SPKI = Buffer.from("302a300506032b6570032100", "hex");

/** The text of a key or signature file, unwrapped from Tauri's extra base64 when it has it. */
function unwrap(text: string): string[] {
  let t = text.trim();
  if (!t.startsWith("untrusted comment:")) t = Buffer.from(t, "base64").toString("utf8").trim();
  return t.split(/\r?\n/).map((l) => l.trim());
}

interface PublicKey {
  keyId: Buffer;
  key: KeyObject;
}

export function parsePublicKey(text: string): PublicKey {
  const lines = unwrap(text);
  const raw = Buffer.from(lines.find((l) => l && !l.startsWith("untrusted comment:")) ?? "", "base64");
  if (raw.length !== 42 || raw.subarray(0, 2).toString("latin1") !== "Ed") throw new Error("not a minisign public key");
  return { keyId: raw.subarray(2, 10), key: createPublicKey({ key: Buffer.concat([ED25519_SPKI, raw.subarray(10)]), format: "der", type: "spki" }) };
}

interface Signature {
  prehashed: boolean;
  keyId: Buffer;
  signature: Buffer;
  trustedComment: string;
  globalSignature: Buffer;
}

export function parseSignature(text: string): Signature {
  const lines = unwrap(text);
  const [untrusted, sig, trusted, global] = lines;
  if (!untrusted?.startsWith("untrusted comment:") || !trusted?.startsWith("trusted comment: ") || !sig || !global) throw new Error("not a minisign signature");
  const raw = Buffer.from(sig, "base64");
  const alg = raw.subarray(0, 2).toString("latin1");
  if (raw.length !== 74 || (alg !== "ED" && alg !== "Ed")) throw new Error("not a minisign signature");
  return {
    prehashed: alg === "ED",
    keyId: raw.subarray(2, 10),
    signature: raw.subarray(10),
    trustedComment: trusted.slice("trusted comment: ".length),
    globalSignature: Buffer.from(global, "base64"),
  };
}

async function blake2b(file: string): Promise<Buffer> {
  const h = createHash("blake2b512");
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest();
}

/** True when `file` is signed by `publicKey` (both as their files' text); false for anything else, never throws. */
export async function verifyFile(file: string, signatureText: string, publicKeyText: string): Promise<boolean> {
  try {
    const pk = parsePublicKey(publicKeyText);
    const s = parseSignature(signatureText);
    if (!s.keyId.equals(pk.keyId)) return false;
    const signed = s.prehashed ? await blake2b(file) : readFileSync(file);
    if (!verify(null, signed, pk.key, s.signature)) return false;
    return verify(null, Buffer.concat([s.signature, Buffer.from(s.trustedComment, "utf8")]), pk.key, s.globalSignature);
  } catch {
    return false;
  }
}
