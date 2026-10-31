import { describe, expect, it } from "vitest";
import { isPublicHttpUrl, renderTemplate } from "../src/util.ts";

describe("renderTemplate", () => {
  it("fills fields, nested fields and the host of URL fields", () => {
    const input = { to: "a@b.c", page: { url: "https://Shop.Example:8443/cart?x=1" }, label: "Pay", n: 3 };
    expect(renderTemplate("Send to {to} ({n})", input)).toBe("Send to a@b.c (3)");
    expect(renderTemplate("{label} on {page.url|host}", input)).toBe("Pay on shop.example");
    // Not a URL: the value itself; missing: empty; unknown filters stay literal.
    expect(renderTemplate("{label|host}", input)).toBe("Pay");
    expect(renderTemplate("[{missing|host}]", input)).toBe("[]");
    expect(renderTemplate("{label|upper}", input)).toBe("{label|upper}");
  });
});

describe("isPublicHttpUrl", () => {
  it("takes a named host on the internet, over HTTPS when asked", () => {
    expect(isPublicHttpUrl("https://bot.example.com/x", { httpsOnly: true })).toBe(true);
    expect(isPublicHttpUrl("http://bot.example.com/x")).toBe(true);
    expect(isPublicHttpUrl("http://bot.example.com/x", { httpsOnly: true })).toBe(false);
    // A Funnel link opens from anywhere.
    expect(isPublicHttpUrl("https://piomio.tail1234.ts.net/agent/a", { httpsOnly: true })).toBe(true);
    expect(isPublicHttpUrl("https://8.8.8.8/x")).toBe(true);
  });

  it("refuses what only opens on this computer, the home network or the tailnet's own addresses", () => {
    for (const url of [
      "https://localhost/x",
      "https://app.localhost",
      "https://mymac:8080",
      "https://mymac.local",
      "https://nas.lan",
      "https://router.home.arpa",
      "https://db.internal",
      "https://127.0.0.1:8080",
      "https://10.1.2.3",
      "https://172.20.0.1",
      "https://192.168.1.20:8080",
      "https://169.254.1.1",
      "https://100.101.102.103",
      "https://[::1]:8080",
      "https://[fd7a:115c:a1e0::1]",
      "https://[fe80::1]",
      "https://[::ffff:192.168.1.2]",
      "ftp://bot.example.com",
      "not a url",
    ])
      expect(isPublicHttpUrl(url), url).toBe(false);
    expect(isPublicHttpUrl("https://172.32.0.1")).toBe(true);
    expect(isPublicHttpUrl("https://100.128.0.1")).toBe(true);
  });
});
