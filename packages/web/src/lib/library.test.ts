import { describe, expect, it } from "vitest";
import type { LibraryItem } from "@piomio/shared";
import { itemHref, libraryMedia, libraryQuery, shelves, thumbSrc } from "./library";

const base = { from: "person", agentId: "a", at: "2026-11-04T10:00:00.000Z" } as const;
const photo: LibraryItem = { ...base, id: "a/c/attachments/p.jpg", kind: "media", name: "p.jpg", path: "a/c/attachments/p.jpg", mimeType: "image/jpeg" };
const video: LibraryItem = { ...base, id: "a/c/attachments/v.mp4", kind: "media", name: "v.mp4", path: "a/c/attachments/v.mp4", mimeType: "video/mp4" };
const web: LibraryItem = { ...base, from: "agent", id: "https://img.example.com/o.png", kind: "media", name: "Owl", src: "https://img.example.com/o.png", caption: "Owl" };
const doc: LibraryItem = { ...base, id: "a/c/attachments/c.pdf", kind: "file", name: "c.pdf", path: "a/c/attachments/c.pdf", mimeType: "application/pdf" };
const page: LibraryItem = { ...base, from: "agent", id: "page:pg1", kind: "page", name: "Plan", pageId: "pg1" };

describe("library", () => {
  it("asks the hub with only what is set", () => {
    expect(libraryQuery("a")).toBe("/api/library?agent=a");
    expect(libraryQuery("a", { kind: "all", q: "  " })).toBe("/api/library?agent=a");
    expect(libraryQuery("a", { kind: "file", q: "contract 2", before: "2026-11-01T00:00:00Z", limit: 60 })).toBe(
      "/api/library?agent=a&kind=file&q=contract+2&before=2026-11-01T00%3A00%3A00Z&limit=60",
    );
  });

  it("loads pictures small, files themselves, web pictures through the proxy", () => {
    expect(thumbSrc(photo)).toBe("/api/files?path=a%2Fc%2Fattachments%2Fp.jpg&preview=1");
    expect(thumbSrc(web)).toBe("/api/media?url=https%3A%2F%2Fimg.example.com%2Fo.png");
    expect(thumbSrc(page)).toBeUndefined();
    expect(itemHref(doc, true)).toBe("/api/files?path=a%2Fc%2Fattachments%2Fc.pdf&download=1");
  });

  it("gives the viewer pictures and videos only, in order", () => {
    const items = libraryMedia([photo, doc, video, web, page]);
    expect(items.map((m) => [m.key, m.kind])).toEqual([
      ["library:a/c/attachments/p.jpg", "image"],
      ["library:a/c/attachments/v.mp4", "video"],
      ["library:https://img.example.com/o.png", "image"],
    ]);
    expect(items[2]).toMatchObject({ original: "https://img.example.com/o.png", download: "/api/media?url=https%3A%2F%2Fimg.example.com%2Fo.png&download=1" });
    expect(items[2].caption).toBeUndefined();
  });

  it("puts pages first and leaves out empty shelves", () => {
    expect(shelves([photo, doc, page]).map((s) => [s.kind, s.items.length])).toEqual([
      ["page", 1],
      ["media", 1],
      ["file", 1],
    ]);
  });
});
