import { expect, it, vi } from "vitest";

it("a fresh demo world neither restores nor writes the origin's persistent cache", async () => {
  vi.resetModules();
  const open = vi.fn(() => { throw new Error("the demo must not access the site's cache"); });
  vi.stubGlobal("indexedDB", { open });
  try {
    const cache = await import("./cache");
    cache.disablePersistentCache();
    expect(await cache.cacheGet("messages:dlg_ada")).toBeUndefined();
    await cache.cachePut("messages:dlg_ada", [{ status: "streaming" }]);
    expect(await cache.mediaGet("/api/files?path=photo.jpg")).toBeUndefined();
    await cache.mediaPut({ url: "/api/files?path=photo.jpg", blob: new Blob(["photo"]), size: 5, at: 0 });
    await cache.pruneMedia();
    await cache.clearCache();
    expect(open).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});
