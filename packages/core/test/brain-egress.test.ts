import { describe, expect, it } from "vitest";
import { EgressProxy } from "../src/egress.ts";
import { DEFAULT_BRAIN_EGRESS } from "../src/settings.ts";
import type { PiomioManifest } from "@piomio/shared";
import { ownUrlFor, pluginEgress } from "../src/plugins/host.ts";

describe("brain egress grants", () => {
  it("includes GitHub Git/API/download hosts, refuses unrelated hosts, and loses access when revoked", () => {
    const proxy = new EgressProxy();
    const token = proxy.issueToken("brain:task", DEFAULT_BRAIN_EGRESS);
    for (const host of ["github.com", "api.github.com", "ssh.github.com", "codeload.github.com", "objects.githubusercontent.com", "raw.githubusercontent.com"])
      expect(proxy.allowed(token, host).ok, host).toBe(true);
    for (const host of ["github.com.evil.example", "evilgithub.com", "example.com", "127.0.0.1", "localhost"])
      expect(proxy.allowed(token, host).ok, host).toBe(false);
    expect(proxy.allowed(undefined, "github.com").ok).toBe(false);
    proxy.revokeOwner("brain:task");
    expect(proxy.allowed(token, "github.com").ok).toBe(false);
  });

  it("keeps extra hosts live at the hub and scopes them to brain tokens", () => {
    const proxy = new EgressProxy();
    const brain = proxy.issueToken("brain:task", DEFAULT_BRAIN_EGRESS);
    const plugin = proxy.issueToken("plugin:web", ["github.com"]);
    proxy.extraBrainAllow = () => ["extra.example"];
    expect(proxy.allowed(brain, "extra.example").ok).toBe(true);
    expect(proxy.allowed(plugin, "extra.example").ok).toBe(false);
    proxy.extraBrainAllow = () => [];
    expect(proxy.allowed(brain, "extra.example").ok).toBe(false);
  });
});

describe("brain plugins' own processes", () => {
  it("reach their CLIs' model APIs; other plugins only what they were granted", () => {
    expect(pluginEgress([], true)).toEqual(expect.arrayContaining(["chatgpt.com", "*.openai.com", "*.anthropic.com"]));
    expect(pluginEgress(["api.example.com"], true)).toContain("api.example.com");
    expect(pluginEgress(["api.example.com"], false)).toEqual(["api.example.com"]);
  });

  it("let a plugin that serves webhooks reach the hub's own public https address, to check that it reaches the hub", () => {
    expect(pluginEgress(["api.example.com"], false, "https://Hub.Example.com:8443/piomio")).toEqual(["api.example.com", "hub.example.com"]);
    // Nothing for an address that is not https (the hub on localhost), or one that does not parse.
    expect(pluginEgress(["api.example.com"], false, "http://localhost:8080")).toEqual(["api.example.com"]);
    expect(pluginEgress([], false, "not a url")).toEqual([]);
  });

  it("give the hub's address only to a built-in plugin whose webhooks feed a subscribe-mode signal source", () => {
    const url = "https://hub.example.com";
    const manifest = (http: boolean, modes: Array<"broadcast" | "subscribe">) => ({ contributes: { http, signals: modes.map((mode) => ({ type: "event", mode })) } }) as unknown as PiomioManifest;
    expect(ownUrlFor("builtin", manifest(true, ["subscribe"]), url)).toBe(url);
    expect(ownUrlFor("builtin", manifest(true, ["broadcast", "subscribe"]), url)).toBe(url);
    // An http plugin without a subscribe-mode source, one with a source but no http, and an installed one: never.
    expect(ownUrlFor("builtin", manifest(true, []), url)).toBeUndefined();
    expect(ownUrlFor("builtin", manifest(true, ["broadcast"]), url)).toBeUndefined();
    expect(ownUrlFor("builtin", manifest(false, ["subscribe"]), url)).toBeUndefined();
    expect(ownUrlFor("installed", manifest(true, ["subscribe"]), url)).toBeUndefined();
    expect(pluginEgress(["api.example.com"], false, ownUrlFor("builtin", manifest(true, []), url))).toEqual(["api.example.com"]);
    expect(pluginEgress(["api.example.com"], false, ownUrlFor("installed", manifest(true, ["subscribe"]), url))).toEqual(["api.example.com"]);
  });
});
