// Which addresses a request may go to. Public hosts are open. This computer and link-local addresses never are: the
// hub's own API lives there, and plugins reach loopback without the hub's proxy. A host in a network of the person's own
// (home, office, VPN) is the hub's to decide when its proxy stands in between: it knows which hosts they opened.

import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

export type Lookup = (host: string) => Promise<string[]>;

export const defaultLookup: Lookup = async (host) => (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address);

/** Networks of the person's own. */
const lan = new BlockList();
for (const [a, p] of [["10.0.0.0", 8], ["100.64.0.0", 10], ["172.16.0.0", 12], ["192.168.0.0", 16]] as const) lan.addSubnet(a, p, "ipv4");
lan.addSubnet("fc00::", 7, "ipv6");

/** Everything that is not the public internet: the person's networks, this computer, link-local, reserved ranges. */
const inside = new BlockList();
for (const [a, p] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local: cloud metadata lives here
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  inside.addSubnet(a, p, "ipv4");
for (const [a, p] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96], // NAT64: an IPv4 address inside
  ["2002::", 16], // 6to4: the same
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const)
  inside.addSubnet(a, p, "ipv6");

function check(list: BlockList, ip: string): boolean {
  const addr = ip.split("%")[0];
  const v = isIP(addr);
  // BlockList checks an IPv4-mapped IPv6 address (::ffff:10.0.0.1) against the IPv4 rules itself.
  return v === 4 ? list.check(addr, "ipv4") : v === 6 ? list.check(addr, "ipv6") : true;
}

export const isInsideAddress = (ip: string): boolean => check(inside, ip);
export const isLanAddress = (ip: string): boolean => isIP(ip.split("%")[0]) !== 0 && check(lan, ip);

/**
 * An address a request may not go to: this computer or an internal address (`local`), a host of the person's own network,
 * which they can open on a card (`lan`), or not an http(s) address at all (`scheme`).
 */
export class ClosedAddress extends Error {
  kind: "local" | "lan" | "scheme";
  constructor(message: string, kind: ClosedAddress["kind"] = "local") {
    super(message);
    this.kind = kind;
  }
}

export interface Guard {
  lookup?: Lookup;
  /** The hub's proxy stands between this process and the network: it decides about the person's own networks. */
  hubDecides?: boolean;
  /** Tests only (PIOMIO_HTTP_CLIENT_TEST_LOCAL=1): every address is open. */
  allowLocal?: boolean;
}

/** This process reaches the network through the hub's proxy: the hub starts every plugin so (core plugins/host.ts). */
export function behindHub(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.PIOMIO_PLUGIN_ID && env.NODE_USE_ENV_PROXY === "1" && !!(env.HTTPS_PROXY || env.https_proxy) && !!(env.HTTP_PROXY || env.http_proxy);
}

/**
 * Throws ClosedAddress for an address that may not be opened. Returns the private addresses of a host in the person's
 * own network that the hub decides about (so a failed connection can say why), nothing for a public host.
 */
export async function checkAddress(url: URL, g: Guard = {}): Promise<string[] | undefined> {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new ClosedAddress(`Only http and https addresses are supported (got ${url.protocol})`, "scheme");
  if (g.allowLocal) return undefined;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addrs: string[];
  if (isIP(host)) addrs = [host];
  else {
    try {
      addrs = await (g.lookup ?? defaultLookup)(host);
    } catch (e: any) {
      throw new Error(`Cannot resolve host ${host}: ${e?.code ?? e?.message ?? e}`);
    }
  }
  if (!addrs.length) throw new Error(`Cannot resolve host ${host}`);
  const closed = addrs.filter(isInsideAddress);
  if (!closed.length) return undefined;
  if (closed.every(isLanAddress)) {
    if (g.hubDecides) return closed;
    throw new ClosedAddress(`${host} resolves to a private address (${closed[0]}) inside the person's network, which is closed.`, "lan");
  }
  throw new ClosedAddress(`${host} resolves to this computer or an internal address (${closed.find((a) => !isLanAddress(a))}): the HTTP client never opens those.`);
}
