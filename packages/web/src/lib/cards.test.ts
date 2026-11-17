import { describe, expect, it } from "vitest";
import { cardMap, cardMedia, linkLabel } from "./cards";

describe("cards", () => {
  it("reads a link by its label, else by its host", () => {
    expect(linkLabel({ label: " Buy ", url: "https://shop.example/x" })).toBe("Buy");
    expect(linkLabel({ url: "https://www.shop.example/x?y=1" })).toBe("shop.example");
    expect(linkLabel({ label: " ", url: "not a url" })).toBe("not a url");
  });

  it("gives a position's pictures to the viewer, each with its own key", () => {
    const media = cardMedia({ title: "Air 13", images: [{ src: "https://img.example.com/a.jpg" }, { src: "file:assistant/c1/b.png", caption: "Battery" }, { src: "ftp://no" }] }, "m1", 2, 3);
    expect(media.map((m) => m.key)).toEqual(["m1/2/3/0", "m1/2/3/1"]);
    expect(media[0]).toMatchObject({ kind: "image", caption: "Air 13", original: "https://img.example.com/a.jpg" });
    expect(media[1]).toMatchObject({ caption: "Battery", src: "/api/files?path=assistant%2Fc1%2Fb.png" });
    expect(media[1].original).toBeUndefined();
    expect(cardMedia({ title: "Plain" }, "m1", 0, 0)).toEqual([]);
  });

  it("puts a position with coordinates on a map", () => {
    expect(cardMap({ title: "Cafe", address: "1 Main St", lat: 43.2, lon: 76.9 })).toEqual({
      type: "map",
      lat: 43.2,
      lon: 76.9,
      zoom: 15,
      title: "Cafe",
      markers: [{ lat: 43.2, lon: 76.9, label: "Cafe", note: "1 Main St" }],
    });
    expect(cardMap({ title: "Cafe", lat: 43.2 })).toBeUndefined();
  });
});
