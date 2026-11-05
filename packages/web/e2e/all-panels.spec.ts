import { expect, test } from "@playwright/test";

const panels = ["library", "page", "settings", "plugin", "live", "map", "media", "edit", "modal", "palette"];
for (const platform of ["mac", "phone"]) {
  for (const panel of panels) {
    test(`${platform}: ${panel} header and controls`, async ({ page }) => {
      await page.setViewportSize(platform === "mac" ? { width: 1100, height: 720 } : { width: 390, height: 844 });
      await page.addInitScript(() => Object.assign(window, { piomioDesktop: { scheme: "piomio", overlayTitleBar: true } }));
      await page.route("**/api/**", route => route.fulfill({ json: { items: [], more: false, path: "fixture.png" } }));
      await page.goto(`/e2e/panels.html?panel=${panel}&platform=${platform}`);
      if (panel === "map") await page.getByRole("button", { name: "Full screen", exact: true }).click();
      const surface = ["settings", "plugin"].includes(panel) ? page.locator("aside") : panel === "map" ? page.locator("figure") : page.getByRole("dialog");
      await expect(surface).toBeVisible();
      await surface.evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished.catch(() => {}))));
      expect(await surface.evaluate(el => {
        const box = el.getBoundingClientRect();
        const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return !!top && el.contains(top);
      })).toBe(true);
      if (["media", "edit"].includes(panel)) await expect(page.locator("[data-viewer-ui]")).toHaveCSS("opacity", "1");
      const controls = panel === "palette" ? surface.locator("input")
        : ["library", "page"].includes(panel) ? surface.locator("header button")
        : ["media", "edit"].includes(panel) ? surface.locator("[data-viewer-ui] .top-0 button")
        : ["settings", "plugin"].includes(panel) ? surface.locator(":scope > .glass button")
        : panel === "live" ? surface.locator(":scope > div button")
        : panel === "map" ? surface.getByRole("button", { name: "Exit full screen", exact: true })
        : surface.locator("button");
      expect(await controls.count()).toBeGreaterThan(0);
      for (const control of await controls.all()) {
        if (!await control.isVisible()) continue;
        const box = (await control.boundingBox())!;
        const width = page.viewportSize()!.width;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
        if (platform === "mac") expect(box.x >= 100 || box.y >= 52).toBe(true);
        await expect(control).not.toHaveAttribute("data-tauri-drag-region");
      }
      if (platform === "phone") {
        for (const strip of await surface.locator(".window-titlebar").all()) await expect(strip).toHaveCSS("height", "0px");
      }
      await page.screenshot({ path: `output/playwright/${test.info().project.name}-${panel}-${platform}.png`, animations: "disabled" });
      if (["settings", "plugin"].includes(panel)) {
        await surface.getByRole("button", { name: "Close panel", exact: true }).click();
        await expect(surface).toHaveCount(0);
      } else if (panel === "map") {
        await surface.getByRole("button", { name: "Exit full screen", exact: true }).click();
        await expect(surface.locator(".window-titlebar")).toHaveCount(0);
      } else if (panel === "live") {
        await surface.getByRole("button", { name: "Back to the corner", exact: true }).click();
        await expect(page.getByRole("dialog")).toHaveCount(0);
      } else if (panel === "edit") {
        await surface.getByRole("button", { name: "Cancel", exact: true }).click();
        await expect(surface.getByRole("button", { name: "Done", exact: true })).toHaveCount(0);
      } else if (panel === "palette") {
        await page.keyboard.press("Escape");
        await expect(surface).toHaveCount(0);
      } else {
        await surface.getByRole("button", { name: "Close", exact: true }).first().click();
        await expect(surface).toHaveCount(0);
      }
    });
  }
}
