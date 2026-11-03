import type { BrainSessionOptions } from "@piomio/shared";

/**
 * The CLI's sandbox proxy chains to the hub's authenticated egress proxy. Never turn on command networking from
 * inherited proxy variables alone, or without the hub's policy. Dialogs and bare reviewers keep no network.
 */
export function confinedNetwork(opts: BrainSessionOptions): { allowedDomains: string[]; proxy: string } | undefined {
  if (!opts.confine?.network || opts.frontDesk || opts.bare) return undefined;
  const proxy = opts.env.HTTPS_PROXY;
  let url: URL | undefined;
  try {
    url = new URL(proxy ?? "");
  } catch { /* fail closed below, without putting the proxy credential in an error */ }
  if (!proxy || !url || url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || !url.username || !url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Sandbox networking requires the hub's authenticated loopback egress proxy");
  }
  return { allowedDomains: [...new Set(opts.confine.network.allowedDomains)], proxy };
}

/** All upstream proxy aliases agree; an inherited ALL_PROXY or no_proxy must not bypass the hub's filter. */
export function confinedProxyEnv(opts: BrainSessionOptions): Record<string, string> {
  const network = confinedNetwork(opts);
  if (!network) return {};
  return {
    HTTP_PROXY: network.proxy, HTTPS_PROXY: network.proxy, ALL_PROXY: network.proxy,
    http_proxy: network.proxy, https_proxy: network.proxy, all_proxy: network.proxy,
    NO_PROXY: "127.0.0.1,localhost,::1", no_proxy: "127.0.0.1,localhost,::1",
  };
}
