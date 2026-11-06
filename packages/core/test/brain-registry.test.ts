// The brain registry while connections come and go: a brain whose host's connection closed is not connected (not
// "unavailable"), a probe the host did not answer says so and is not remembered, and a host that registers again is
// probed afresh.
import { describe, expect, it } from "vitest";
import { createRpcPeer, memoryTransportPair, type ProbeResult, type RpcPeer } from "@piomio/shared";
import { BrainRegistry } from "../src/brains.ts";

const READY: ProbeResult = { available: true, authenticated: true };

/** A plugin process hosting the brain `fake`: answers probes with `answer()` and counts them. */
function host(answer: () => ProbeResult | Promise<ProbeResult>) {
  const [a, b] = memoryTransportPair();
  const peer = createRpcPeer(a);
  const plugin = createRpcPeer(b);
  const seen = { probes: 0 };
  plugin.handle("brain.probe", async () => {
    seen.probes++;
    return answer();
  });
  return { peer, plugin, seen };
}

describe("brain registry and connections", () => {
  it("counts a brain whose host's connection closed as not connected", () => {
    const brains = new BrainRegistry();
    const { peer } = host(() => READY);
    brains.registerPluginBrain("fake", "Fake", "fakebrain", peer);
    expect(brains.has("fake@local")).toBe(true);
    peer.close();
    expect(brains.has("fake@local")).toBe(false);
  });

  it("marks a probe the host did not answer as unreachable and does not remember it", async () => {
    const brains = new BrainRegistry();
    let peer: RpcPeer | undefined;
    const h = host(() => {
      // The plugin process dies while it is being asked.
      setTimeout(() => peer!.close(), 0);
      return new Promise<ProbeResult>(() => {});
    });
    peer = h.peer;
    brains.registerPluginBrain("fake", "Fake", "fakebrain", h.peer);
    const first = await brains.probe("fake@local");
    expect(first).toMatchObject({ available: false, authenticated: false, unreachable: true });
    // Not kept: once the plugin is back, the next look asks it again.
    const again = host(() => READY);
    brains.registerPluginBrain("fake", "Fake", "fakebrain", again.peer);
    expect(await brains.probe("fake@local")).toMatchObject({ available: true, authenticated: true });
    expect(again.seen.probes).toBe(1);
  });

  it("probes a brain afresh when its host registers again", async () => {
    const brains = new BrainRegistry();
    let signedIn = false;
    const h = host(() => ({ available: true, authenticated: signedIn }));
    brains.registerPluginBrain("fake", "Fake", "fakebrain", h.peer);
    expect((await brains.probe("fake@local")).authenticated).toBe(false);
    signedIn = true;
    // The plugin restarted (another process, a new peer): what the old one said no longer holds.
    const again = host(() => ({ available: true, authenticated: signedIn }));
    brains.registerPluginBrain("fake", "Fake", "fakebrain", again.peer);
    expect((await brains.probe("fake@local")).authenticated).toBe(true);
  });
});
