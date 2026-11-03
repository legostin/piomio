import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AppVersionView } from "./AppVersion";

vi.mock("../state/app", () => ({ session: {}, machineActivity: {} }));

const desktop = { scheme: "piomio", version: "0.2.24", test: false, overlayTitleBar: false, pio: false };
const render = (props: Parameters<typeof AppVersionView>[0]) => renderToStaticMarkup(createElement(AppVersionView, props));

describe("app version", () => {
  it("shows the serving hub version and computer, with no invented desktop version in browsers", () => {
    const html = render({ version: "0.2.25", hubName: "VPS" });
    expect(html).toContain("v0.2.25");
    expect(html).toContain("VPS");
    expect(html).not.toContain("bg-accent");
    expect(render({})).toBe("");
  });
  it("shows both versions and a dot only for a mismatch or an offered update", () => {
    const html = render({ version: "0.2.25", hubName: "Mac", desktop });
    expect(html).toContain("v0.2.24");
    expect(html).toContain("bg-accent");
    expect(render({ version: "0.2.24", desktop })).not.toContain("bg-accent");
    expect(render({ version: "0.2.24", desktop, update: "0.2.25" })).toContain("bg-accent");
    expect(render({ version: "0.2.24", desktop: { ...desktop, version: undefined } })).not.toContain("bg-accent");
  });
});
