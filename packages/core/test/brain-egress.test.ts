import { describe, expect, it } from "vitest";
import { EgressProxy } from "../src/egress.ts";
import { DEFAULT_BRAIN_EGRESS } from "../src/settings.ts";
import { pluginEgress } from "../src/plugins/host.ts";

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
});
