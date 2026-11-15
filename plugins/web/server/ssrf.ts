// SSRF guard: refuse URLs whose host resolves to private, loopback, link-local or otherwise internal addresses.

import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

export type LookupFn = (host: string) => Promise<string[]>;

export const defaultLookup: LookupFn = async (host) => (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address);

// [network, prefix length]
const V4_BLOCKED: Array<[string, number]> = [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local (cloud metadata lives here)
  ["172.16.0.0", 12],
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.168.0.0", 16],
  ["198.18.0.0", 15], // benchmarking
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
];

const V6_BLOCKED: Array<[string, number]> = [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // deprecated site-local
  ["ff00::", 8], // multicast
];

function v4ToInt(ip: string): number {
  const p = ip.split(".").map(Number);
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

/** Expand an IPv6 address (optionally with an embedded IPv4 tail) into 16 bytes. */
function v6ToBytes(ip: string): number[] {
  let s = ip.toLowerCase().split("%")[0];
  const tail: number[] = [];
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const n = v4ToInt(v4[1]);
    tail.push((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
    s = s.slice(0, -v4[1].length) + "0:0";
  }
  const [head, rest] = s.split("::");
  const h = head ? head.split(":") : [];
  const r = rest !== undefined && rest !== "" ? rest.split(":") : [];
  const groups = rest === undefined ? h : [...h, ...new Array(8 - h.length - r.length).fill("0"), ...r];
  const bytes: number[] = [];
  for (const g of groups) {
    const n = parseInt(g || "0", 16);
    bytes.push((n >> 8) & 255, n & 255);
  }
  if (tail.length) bytes.splice(12, 4, ...tail);
  return bytes;
}

function inV6Prefix(bytes: number[], net: string, prefix: number): boolean {
  const nb = v6ToBytes(net);
  for (let i = 0; i < 16 && prefix > 0; i++, prefix -= 8) {
    const mask = prefix >= 8 ? 255 : (255 << (8 - prefix)) & 255;
    if ((bytes[i] & mask) !== (nb[i] & mask)) return false;
  }
  return true;
}

function v4Blocked(ip: string): boolean {
  const n = v4ToInt(ip);
  return V4_BLOCKED.some(([net, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return ((n & mask) >>> 0) === ((v4ToInt(net) & mask) >>> 0);
  });
}

/** True for addresses a fetch tool must not reach (private, loopback, link-local, ULA, multicast, reserved). */
export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return v4Blocked(ip);
  if (family !== 6) return true; // not an IP: refuse
  const b = v6ToBytes(ip);
  if (V6_BLOCKED.some(([net, bits]) => inV6Prefix(b, net, bits))) return true;
  const embedded = (offset: number) => `${b[offset]}.${b[offset + 1]}.${b[offset + 2]}.${b[offset + 3]}`;
  // IPv4-mapped (::ffff:0:0/96), IPv4-compatible (::/96), NAT64 (64:ff9b::/96): check the embedded IPv4.
  if (inV6Prefix(b, "::ffff:0:0", 96) || inV6Prefix(b, "::", 96) || inV6Prefix(b, "64:ff9b::", 96)) return v4Blocked(embedded(12));
  // 6to4 (2002::/16) embeds an IPv4 address in bytes 2..5.
  if (inV6Prefix(b, "2002::", 16)) return v4Blocked(embedded(2));
  return false;
}

export class BlockedUrlError extends Error {
  /** Every private address the host resolves to is in a network of the person's own, which the hub may have opened. */
  lan?: { host: string; addresses: string[] };
}

/** Networks of the person's own (home, office, VPN, tailnet): the hub's proxy knows which hosts there they opened. */
const lanNets = new BlockList();
for (const [a, p] of [["10.0.0.0", 8], ["100.64.0.0", 10], ["172.16.0.0", 12], ["192.168.0.0", 16]] as const) lanNets.addSubnet(a, p, "ipv4");
lanNets.addSubnet("fc00::", 7, "ipv6");

export function isLanAddress(ip: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  const addr = mapped ? mapped[1] : ip.split("%")[0];
  const v = isIP(addr);
  return v === 4 ? lanNets.check(addr, "ipv4") : v === 6 ? lanNets.check(addr, "ipv6") : false;
}

/** Only http/https URLs whose host resolves exclusively to public addresses. */
export async function assertPublicUrl(url: URL, lookup: LookupFn = defaultLookup): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new BlockedUrlError(`Only http and https URLs are supported (got ${url.protocol})`);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addrs: string[];
  if (isIP(host)) addrs = [host];
  else {
    try {
      addrs = await lookup(host);
    } catch (e: any) {
      throw new Error(`Cannot resolve host ${host}: ${e?.code ?? e?.message ?? e}`);
    }
  }
  if (!addrs.length) throw new Error(`Cannot resolve host ${host}`);
  const inside = addrs.filter(isPrivateAddress);
  if (!inside.length) return;
  const blocked = new BlockedUrlError(`Refusing to fetch ${url.origin}: ${host} resolves to a private or internal address (${inside[0]})`);
  if (inside.every(isLanAddress)) blocked.lan = { host, addresses: inside };
  throw blocked;
}
