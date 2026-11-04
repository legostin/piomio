import { describe, expect, it } from "vitest";
import { cacheGet, cachePut, clearCache, mediaGet } from "./cache";
import { cacheable, previewSrc } from "./media-cache";

describe("pictures kept on the device", () => {
  it("asks the hub for a workspace picture's preview, other addresses as they are", () => {
    expect(previewSrc("/api/files?path=a%2Fb.jpg")).toBe("/api/files?path=a%2Fb.jpg&preview=1");
    expect(previewSrc("/api/files?path=a.jpg&preview=1")).toBe("/api/files?path=a.jpg&preview=1");
    expect(previewSrc("/api/files?path=a.jpg&download=1")).toBe("/api/files?path=a.jpg&download=1");
    expect(previewSrc("/api/media?url=https%3A%2F%2Fe.com%2Fx.png")).toBe("/api/media?url=https%3A%2F%2Fe.com%2Fx.png");
  });

  it("keeps only the hub's picture routes", () => {
    expect(cacheable("/api/files?path=a.jpg&preview=1")).toBe(true);
    expect(cacheable("/api/media?url=x")).toBe(true);
    for (const u of ["blob:http://h/1", "data:image/png;base64,AA", "/api/map/tiles/1/0/0.png", "https://e.com/x.png"]) expect(cacheable(u), u).toBe(false);
  });

  it("works without IndexedDB: nothing kept, nothing thrown", async () => {
    await cachePut("team", [1]);
    expect(await cacheGet("team")).toBeUndefined();
    expect(await mediaGet("/api/files?path=a.jpg")).toBeUndefined();
    await expect(clearCache()).resolves.toBeUndefined();
  });
});
